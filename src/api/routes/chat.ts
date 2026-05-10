import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import process from "process";
import { appendAuditEvent, createAuditContext, sanitizeHeaders, serializeError, summarizeMessages, tapStreamForAudit } from '@/lib/audit-log.ts';


const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;
const CHAT_SESSION_REUSE = ['1', 'true', 'yes', 'on'].includes(String(process.env.CHAT_SESSION_REUSE || 'true').toLowerCase());
const CHAT_SESSION_TTL = Number(process.env.CHAT_SESSION_TTL || 7 * 24 * 60 * 60 * 1000);

import { calculateTokens, calculateMessagesTokens } from "@/lib/token.ts";

import storage from '@/lib/storage.ts';
import { buildSessionPrefix, getExplicitSessionId, hashString, selectTokenForSession } from '@/lib/agent-session.ts';
import { cleanAssistantArtifacts, getPotentialToolStartIndex, getTextBeforeToolCall, getToolStartIndex, mayBecomeToolCallPrefix, splitTextAndToolCalls } from '@/lib/tool-calls.ts';

interface ChatSession {
    conversationId: string;
    messageCount: number;
    updatedAt: number;
    token?: string; // 🌟 新增：记录该会话绑定的 Token
}

setInterval(() => {
    storage.cleanup(CHAT_SESSION_TTL);
}, Math.min(CHAT_SESSION_TTL, 10 * 60 * 1000)).unref?.();

function extractMessageText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isArray(content))
        return content.map((part) => _.isString(part) ? part : _.get(part, 'text') || '').filter(Boolean).join('\n');
    return _.isNil(content) ? '' : String(content);
}

function fingerprintMessages(messages: any[], count: number, charLimit: number = 200) {
    const userContents = messages
        .filter((m: any) => _.get(m, 'role') === 'user')
        .slice(0, count)
        .map((m: any) => extractMessageText(_.get(m, 'content')))
        .filter(Boolean)
        .map((text: string) => text.length > charLimit ? text.slice(0, charLimit) : text);
    return hashString(userContents.join('\n'));
}

function getUserTurnCount(messages: any[]) {
    return Math.max(messages.filter((message: any) => _.get(message, 'role') === 'user').length, 1);
}

function buildTurnScopedKey(prefix: string, messages: any[], turnCount: number) {
    return `${prefix}:u${turnCount}:${fingerprintMessages(messages, turnCount)}`;
}

function getLegacyTurnScopedKeys(prefix: string, messages: any[], turnCount: number) {
    if (turnCount <= 1)
        return [
            `${prefix}:m1:${fingerprintMessages(messages, 1)}`,
            `${prefix}:m3:${fingerprintMessages(messages, 1)}`,
            `${prefix}:m5:${fingerprintMessages(messages, 1)}`,
        ];

    if (turnCount === 2)
        return [
            `${prefix}:m3:${fingerprintMessages(messages, 2)}`,
            `${prefix}:m5:${fingerprintMessages(messages, 2)}`,
        ];

    return [`${prefix}:m5:${fingerprintMessages(messages, turnCount)}`];
}

function appendUniqueSessionKey(keys: string[], key?: string) {
    if (!key || keys.includes(key)) return;
    keys.push(key);
}

function appendLegacySessionKeys(keys: string[], prefix: string, messages: any[], turnCount: number) {
    getLegacyTurnScopedKeys(prefix, messages, turnCount).forEach((key) => appendUniqueSessionKey(keys, key));
}

function getProgressiveKeys(request: Request, model: string, messages: any[], accountToken?: string) {
    const sessionId = getExplicitSessionId(request);
    const prefix = buildSessionPrefix(request, 'chat', model, accountToken);
    if (sessionId) return { currentKey: `${prefix}:session:${sessionId}`, previousKeys: [] as string[] };

    const turnCount = getUserTurnCount(messages);
    const currentKey = buildTurnScopedKey(prefix, messages, turnCount);
    const previousKeys: string[] = [];

    appendLegacySessionKeys(previousKeys, prefix, messages, turnCount);
    if (turnCount > 1) {
        appendUniqueSessionKey(previousKeys, buildTurnScopedKey(prefix, messages, turnCount - 1));
        appendLegacySessionKeys(previousKeys, prefix, messages, turnCount - 1);
    }
    if (turnCount > 2) {
        appendUniqueSessionKey(previousKeys, buildTurnScopedKey(prefix, messages, 1));
        appendLegacySessionKeys(previousKeys, prefix, messages, 1);
    }

    return { currentKey, previousKeys: previousKeys.filter((key) => key !== currentKey) };
}

function getChatSession(request: Request, model: string, messages: any[], explicitConversationId?: string, accountToken?: string) {
    if (!CHAT_SESSION_REUSE || explicitConversationId || !messages.length)
        return { sessionKey: null, refConvId: explicitConversationId };

    const { currentKey, previousKeys } = getProgressiveKeys(request, model, messages, accountToken);
    let session = storage.get(currentKey) as ChatSession;
    if (!session) {
        const previousKey = previousKeys.find((key) => storage.has(key));
        if (previousKey) {
            session = storage.get(previousKey) as ChatSession;
            if (session) {
                // 🌟 核心修复：更新当前指纹，但绝不删除旧指纹，以支持分支对话
                storage.set(currentKey, { ...session, updatedAt: Date.now() });
            }
        }
    }

    const canReuse = session
        && messages.length > session.messageCount
        && Date.now() - session.updatedAt <= CHAT_SESSION_TTL;

    if (!canReuse) return { sessionKey: currentKey, refConvId: undefined, refToken: undefined };
    return { sessionKey: currentKey, refConvId: session.conversationId, refToken: session.token };
}

function updateChatSession(sessionKey: string | null | undefined, conversationId: string, messageCount: number, token?: string) {
    if (!CHAT_SESSION_REUSE || !sessionKey || !conversationId || !/[0-9a-z\-]{36}@[0-9]+/.test(conversationId)) return;
    storage.set(sessionKey, {
        conversationId,
        messageCount,
        updatedAt: Date.now(),
        token: token, // 🌟 持久化 Token 绑定
    });
}

function isInvalidMessageIdError(error: any) {
    const bizCode = _.get(error, 'data.biz_code') ?? _.get(error, 'data.data.biz_code');
    const bizMsg = String(_.get(error, 'data.biz_msg') || _.get(error, 'data.data.biz_msg') || _.get(error, 'message') || '').toLowerCase();
    return bizCode === 26 || bizMsg.includes('invalid message id');
}

function trackChatStream(source: any, sessionKey: string | null | undefined, messageCount: number, promptTokens: number, model: string, token: string) {
    const stream = new PassThrough();
    let buffer = '';
    let accumulatedContent = '';
    let lastChunk: any = null;

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') {
            if (data === '[DONE]' && lastChunk) {
                // 在 [DONE] 之前注入 usage
                const completionTokens = calculateTokens(accumulatedContent);
                const usageChunk = {
                    ...lastChunk,
                    choices: [],
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens
                    }
                };
                stream.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
            }
            return;
        }
        const chunk = _.attempt(() => JSON.parse(data));
        if (_.isError(chunk)) return;
        
        lastChunk = chunk;
        const content = _.get(chunk, 'choices[0].delta.content') || _.get(chunk, 'choices[0].text') || '';
        const reasoningContent = _.get(chunk, 'choices[0].delta.reasoning_content') || '';
        accumulatedContent += (content + reasoningContent); // 🌟 累加内容与思考链


        const chunkId = _.get(chunk, 'id');
        if (_.isString(chunkId) && /[0-9a-z\-]{36}@[0-9]+/.test(chunkId))
            updateChatSession(sessionKey, chunkId, messageCount, token);
    };

    source.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stream.write(chunk);
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(processLine);
    });
    source.once('error', (err: Error) => {
        logger.error(`[chat stream] source error: ${err.message}`);
    });
    source.once('close', () => {
        try {
            if (buffer) processLine(buffer);
        } catch (e: any) {
            logger.error(`[chat stream] close finalization error: ${e.message}`);
        }
        if (!stream.closed) stream.end();
    });
    stream.on('error', (err: Error) => {
        logger.error(`[chat stream] output stream error: ${err.message}`);
    });

    return stream;
}

import { injectToolsIntoMessages } from '@/lib/tool-prompt.ts';



/**
 * Parse standard <tool_call name="...">...</tool_call> patterns from model output.
 * Returns an array of OpenAI-compatible tool_calls objects and the text content before tool calls.
 */
function parseToolCallsFromContent(content: string, tools?: any[]): { textContent: string, toolCalls: any[] } {
    const { text, toolCalls } = splitTextAndToolCalls(content, tools || []);
    return {
        textContent: text,
        toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.call_id,
            type: 'function',
            function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
            },
        })),
    };
}

/**
 * Transform a non-stream chat response to include tool_calls if detected.
 */
function transformResponseWithToolCalls(response: any, tools?: any[]): any {
    if (!tools || !_.isArray(tools) || tools.length === 0) return response;

    const message = _.get(response, 'choices[0].message');
    if (!message || !message.content) return response;

    const { textContent, toolCalls } = parseToolCallsFromContent(message.content, tools);

    if (toolCalls.length === 0) return response;

    // Rewrite the message to include tool_calls in OpenAI format
    logger.info(`[CHAT TOOL] Parsed ${toolCalls.length} tool call(s) from model output`);
    const newMessage: any = {
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls,
    };
    if (message.reasoning_content) {
        newMessage.reasoning_content = message.reasoning_content;
    }

    return {
        ...response,
        choices: [{
            ...response.choices[0],
            message: newMessage,
            finish_reason: 'tool_calls',
        }],
    };
}

/**
 * Create a stream transformer that detects tool calls in streamed output
 * and rewrites the final chunk to include tool_calls if found.
 */
function createToolCallStreamTransformer(source: any, tools: any[]) {
    const output = new PassThrough();
    let fullContent = '';
    let buffer = '';
    let lastChunkId = '';
    let lastModel = '';
    let lastCreated = 0;
    let streamedTextLength = 0;
    let deferredFinishChunk: any = null;

    const writeLine = (value: any) => output.write(`data: ${JSON.stringify(value)}\n\n`);

    const writeContentDelta = (baseChunk: any, delta: string) => {
        if (!delta) return;
        const chunk = _.cloneDeep(baseChunk || {});
        if (!chunk.id) chunk.id = lastChunkId;
        if (!chunk.model) chunk.model = lastModel;
        if (!chunk.created) chunk.created = lastCreated || Math.floor(Date.now() / 1000);
        chunk.object = chunk.object || 'chat.completion.chunk';
        chunk.choices = chunk.choices || [{ index: 0, delta: {}, finish_reason: null }];
        _.set(chunk, 'choices[0].delta.content', delta);
        _.set(chunk, 'choices[0].finish_reason', null);
        writeLine(chunk);
    };

    source.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        buffer += text;

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
                output.write(line + '\n');
                continue;
            }
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') {
                const { textContent, toolCalls } = parseToolCallsFromContent(fullContent, tools);
                if (toolCalls && toolCalls.length > 0) {
                    const visibleText = getTextBeforeToolCall(fullContent).trim();
                    if (streamedTextLength < visibleText.length) {
                        writeContentDelta(deferredFinishChunk, visibleText.slice(streamedTextLength));
                        streamedTextLength = visibleText.length;
                    }
                    logger.info(`[CHAT TOOL STREAM] Detected ${toolCalls.length} tool call(s), injecting into stream`);
                    const toolCallChunk = {
                        id: lastChunkId,
                        model: lastModel,
                        object: 'chat.completion.chunk',
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: toolCalls.map((tc, idx) => ({
                                    index: idx,
                                    ...tc,
                                })),
                            },
                            finish_reason: 'tool_calls',
                        }],
                        created: lastCreated,
                    };
                    output.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
                } else {
                    const remainingText = fullContent.slice(streamedTextLength);
                    if (remainingText) writeContentDelta(deferredFinishChunk, remainingText);
                    if (deferredFinishChunk) writeLine(deferredFinishChunk);
                }
                output.write('data: [DONE]\n\n');
                continue;
            }

            const parsed = _.attempt(() => JSON.parse(data));
            if (!_.isError(parsed)) {
                lastChunkId = parsed.id || lastChunkId;
                lastModel = parsed.model || lastModel;
                lastCreated = parsed.created || lastCreated;
                const delta = _.get(parsed, 'choices[0].delta');
                const content = _.get(delta, 'content') || '';
                const finishReason = _.get(parsed, 'choices[0].finish_reason');

                if (content) {
                    fullContent = cleanAssistantArtifacts(fullContent + content);
                    if (streamedTextLength === 0 && mayBecomeToolCallPrefix(fullContent)) continue;
                    let toolStart = getToolStartIndex(fullContent);
                    // Fallback detection: <tool_call may appear mid-line in DeepSeek output
                    if (toolStart === -1) {
                        const newText = fullContent.slice(streamedTextLength);
                        const newToolStartIndex = getToolStartIndex(newText);
                        if (newToolStartIndex !== -1) toolStart = streamedTextLength + newToolStartIndex;
                    }
                    const potentialToolStart = toolStart === -1 ? getPotentialToolStartIndex(fullContent) : -1;
                    const streamableText = toolStart !== -1
                        ? fullContent.slice(0, toolStart)
                        : potentialToolStart === -1
                            ? fullContent
                            : fullContent.slice(0, potentialToolStart);
                    const textDelta = streamableText.slice(streamedTextLength);
                    writeContentDelta(parsed, textDelta);
                    streamedTextLength = streamableText.length;
                    continue;
                }

                if (finishReason) {
                    deferredFinishChunk = parsed;
                    continue;
                }
            } else {
                fullContent += trimmed;
            }

            output.write(line + '\n');
        }
    });

    source.once('error', (err: Error) => {
        logger.error(`[chat tool stream] source error: ${err.message}`);
    });
    source.once('close', () => {
        try {
            if (buffer) output.write(buffer);
        } catch (e: any) {
            logger.error(`[chat tool stream] close finalization error: ${e.message}`);
        }
        if (!output.closed) output.end();
    });
    output.on('error', (err: Error) => {
        logger.error(`[chat tool stream] output stream error: ${err.message}`);
    });

    return output;
}

// ==================== Regenerate Fallback Helpers ====================

function isConversationId(value: any): boolean {
    if (!_.isString(value)) return false;
    return /[0-9a-z\-]{36}@[0-9]+/.test(value);
}

function shouldRegenerateChatResponse(response: any, tools?: any[]): boolean {
    if (!tools || !_.isArray(tools) || tools.length === 0) return false;
    const toolCalls = _.get(response, 'choices[0].message.tool_calls');
    if (_.isArray(toolCalls) && toolCalls.length > 0) return false;
    const content = String(_.get(response, 'choices[0].message.content') || '').trim();
    return !content;
}

async function buildChatPayloadWithFallback(options: {
    model: string;
    messages: any[];
    token: string;
    convId?: string;
    audit: any;
    tools?: any[];
    promptTokens?: number;
}): Promise<{ chatResponse: any; responsePayload: any }> {
    const { model, messages, token, convId, audit, tools = [], promptTokens = 1 } = options;
    let chatResponse = await chat.createCompletion(model, messages, token, convId, 0, audit);
    let responsePayload = transformResponseWithToolCalls(chatResponse, tools);

    if (shouldRegenerateChatResponse(responsePayload, tools) && isConversationId(chatResponse.id)) {
        logger.warn(`[CHAT REGEN] Empty tool response, attempting regenerate convId=${chatResponse.id}`);
        try {
            const normalizedModel = model.toLowerCase();
            const regenResponse = await chat.regenerateCompletion(
                normalizedModel,
                token,
                chatResponse.id,
                promptTokens,
                0,
                audit,
                {
                    thinkingEnabled: Boolean(_.get(chatResponse, 'choices[0].message.reasoning_content')) || normalizedModel.includes('think') || normalizedModel.includes('r1'),
                    searchEnabled: normalizedModel.includes('search'),
                },
            );
            const regenPayload = transformResponseWithToolCalls(regenResponse, tools);
            logger.info(`[CHAT REGEN] Regenerate succeeded hasToolCalls=${_.isArray(_.get(regenPayload, 'choices[0].message.tool_calls'))}`);
            chatResponse = regenResponse;
            responsePayload = regenPayload;
        } catch (regenErr: any) {
            logger.warn(`[CHAT REGEN] Regenerate failed: ${regenErr.message}`);
        }
    }

    return { chatResponse, responsePayload };
}

function createChatPayloadStream(response: any, promptTokens: number): PassThrough {
    const stream = new PassThrough();
    const id = String(_.get(response, 'id') || `chatcmpl-${util.uuid(false)}`);
    const mdl = String(_.get(response, 'model') || 'deepseek-chat');
    const created = Number(_.get(response, 'created') || Math.floor(Date.now() / 1000));
    const message = _.get(response, 'choices[0].message') || {};
    const content = String(_.get(message, 'content') || '');
    const toolCalls: any[] = _.isArray(_.get(message, 'tool_calls')) ? message.tool_calls : [];
    const finishReason = toolCalls.length > 0 ? 'tool_calls' : String(_.get(response, 'choices[0].finish_reason') || 'stop');

    const writeLine = (value: any) => stream.write(`data: ${JSON.stringify(value)}\n\n`);

    setImmediate(() => {
        writeLine({ id, model: mdl, created, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        if (content) {
            writeLine({ id, model: mdl, created, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
        }
        if (toolCalls.length > 0) {
            writeLine({ id, model: mdl, created, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: toolCalls.map((tc: any, idx: number) => ({ index: idx, ...tc })) }, finish_reason: null }] });
        }
        writeLine({
            id, model: mdl, created, object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: promptTokens, completion_tokens: calculateTokens(content), total_tokens: promptTokens + calculateTokens(content) },
        });
        stream.write('data: [DONE]\n\n');
        stream.end();
    });

    stream.on('error', (err: Error) => {
        logger.error(`[chat payload stream] error: ${err.message}`);
    });

    return stream;
}

// ==================== Route Export ====================

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            const audit = createAuditContext({
                endpoint: 'chat.completions',
                route: '/v1/chat/completions',
                model: _.get(request, 'body.model'),
                stream: Boolean(_.get(request, 'body.stream')),
            });
            appendAuditEvent(audit, 'request.received', {
                headers: sanitizeHeaders(request.headers),
                body: request.body,
            });
            // 如果环境变量没有token则读取请求中的
            if (DEEP_SEEK_CHAT_AUTHORIZATION) {
                request.headers.authorization = "Bearer " + DEEP_SEEK_CHAT_AUTHORIZATION;
            }

            request
                .validate('body.conversation_id', (value: any) => _.isUndefined(value) || _.isString(value))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)

            // token切分
            const tokens = chat.tokenSplit(request.headers.authorization);
            let { model, conversation_id: convId, messages, stream, tools } = request.body;
            model = model.toLowerCase();

            // Inject tools definitions into messages as system prompt
            const augmentedMessages = injectToolsIntoMessages(messages, tools);
            const sessionMessageCount = augmentedMessages.length;

            // 🌟 始终用首条消息指纹作为种子，确保同一对话每轮选到同一个 token
            const selectedToken = selectTokenForSession(tokens, `${model}:${convId || ''}:${fingerprintMessages(augmentedMessages, 1, 500)}`);
            const prepared = getChatSession(request, model, augmentedMessages, convId, selectedToken);
            convId = prepared.refConvId;
            
            const finalToken = prepared.refToken || selectedToken;
            appendAuditEvent(audit, 'request.prepared', {
                model,
                stream: Boolean(stream),
                rawMessages: messages,
                rawMessageSummary: summarizeMessages(messages),
                augmentedMessages,
                augmentedMessageSummary: summarizeMessages(augmentedMessages),
                tools,
                session: {
                    sessionKey: prepared.sessionKey,
                    refConvId: prepared.refConvId,
                    hasBoundToken: Boolean(prepared.refToken),
                    sessionMessageCount,
                },
            });

            const hasTools = tools && _.isArray(tools) && tools.length > 0;

            try {
                const promptTokens = calculateMessagesTokens(augmentedMessages);
                if (stream) {
                    if (hasTools) {
                        appendAuditEvent(audit, 'response.stream.start', {
                            sessionKey: prepared.sessionKey,
                            refConvId: prepared.refConvId,
                            promptTokens,
                            buffered: true,
                        });
                        const { chatResponse, responsePayload } = await buildChatPayloadWithFallback({
                            model, messages: augmentedMessages, token: finalToken, convId,
                            audit, tools, promptTokens,
                        });
                        updateChatSession(prepared.sessionKey, chatResponse.id, sessionMessageCount, finalToken);
                        const responseStream = createChatPayloadStream(responsePayload, promptTokens);
                        return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                            sessionKey: prepared.sessionKey,
                            refConvId: prepared.refConvId,
                        })), {
                            type: "text/event-stream"
                        });
                    }
                    const source = await chat.createCompletionStream(model, augmentedMessages, finalToken, convId, 0, audit);
                    const trackedStream = trackChatStream(source, prepared.sessionKey, sessionMessageCount, promptTokens, model, finalToken);
                    appendAuditEvent(audit, 'response.stream.start', {
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        promptTokens,
                    });
                    return new Response(tapStreamForAudit(trackedStream, audit, 'response.stream.completed', () => ({
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                    })), {
                        type: "text/event-stream"
                    });
                }
                else {
                    const { chatResponse, responsePayload } = await buildChatPayloadWithFallback({
                        model, messages: augmentedMessages, token: finalToken, convId,
                        audit, tools, promptTokens,
                    });
                    updateChatSession(prepared.sessionKey, chatResponse.id, sessionMessageCount, finalToken);
                    appendAuditEvent(audit, 'response.final', {
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        response: responsePayload,
                    });
                    return responsePayload;
                }
            } catch (err: any) {
                if (prepared.refConvId && prepared.sessionKey && isInvalidMessageIdError(err)) {
                    appendAuditEvent(audit, 'failover.invalid_message_id', {
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        error: serializeError(err),
                    });
                    logger.warn(`[CHAT FAILOVER] Cached conversation ${prepared.refConvId} returned invalid message id, clearing session and retrying with full context...`);
                    storage.delete(prepared.sessionKey);
                    const promptTokens = calculateMessagesTokens(augmentedMessages);
                    if (stream) {
                        if (hasTools) {
                            const { chatResponse, responsePayload } = await buildChatPayloadWithFallback({
                                model, messages: augmentedMessages, token: finalToken, convId: undefined,
                                audit, tools, promptTokens,
                            });
                            updateChatSession(prepared.sessionKey, chatResponse.id, sessionMessageCount, finalToken);
                            const responseStream = createChatPayloadStream(responsePayload, promptTokens);
                            return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                                sessionKey: prepared.sessionKey,
                                refConvId: undefined,
                                failover: 'invalid_message_id',
                            })), { type: "text/event-stream" });
                        }
                        const source = await chat.createCompletionStream(model, augmentedMessages, finalToken, undefined, 0, audit);
                        const trackedStream = trackChatStream(source, prepared.sessionKey, sessionMessageCount, promptTokens, model, finalToken);
                        return new Response(tapStreamForAudit(trackedStream, audit, 'response.stream.completed', () => ({
                            sessionKey: prepared.sessionKey,
                            refConvId: undefined,
                            failover: 'invalid_message_id',
                        })), { type: "text/event-stream" });
                    } else {
                        const { chatResponse, responsePayload } = await buildChatPayloadWithFallback({
                            model, messages: augmentedMessages, token: finalToken, convId: undefined,
                            audit, tools, promptTokens,
                        });
                        updateChatSession(prepared.sessionKey, chatResponse.id, sessionMessageCount, finalToken);
                        appendAuditEvent(audit, 'response.final', {
                            sessionKey: prepared.sessionKey,
                            refConvId: undefined,
                            failover: 'invalid_message_id',
                            response: responsePayload,
                        });
                        return responsePayload;
                    }
                }
                // 🌟 Token Failover: 如果绑定的 Token 失效，尝试用新的 Token 重试一次
                const status = _.get(err, 'response.status') || _.get(err, 'status');
                if ((status === 401 || status === 403) && prepared.refToken && prepared.sessionKey) {
                    appendAuditEvent(audit, 'failover.token_rebind', {
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        status,
                        error: serializeError(err),
                    });
                    logger.warn(`[CHAT FAILOVER] Bound token failed (${status}), clearing binding and retrying...`);
                    storage.delete(prepared.sessionKey); // 清除失效绑定
                    const retryToken = selectTokenForSession(tokens.filter((item) => item !== finalToken), `${model}:${Date.now()}`) || selectedToken;
                    const promptTokens = calculateMessagesTokens(augmentedMessages);
                    if (stream) {
                        if (hasTools) {
                            const { chatResponse, responsePayload } = await buildChatPayloadWithFallback({
                                model, messages: augmentedMessages, token: retryToken, convId,
                                audit, tools, promptTokens,
                            });
                            updateChatSession(prepared.sessionKey, chatResponse.id, sessionMessageCount, retryToken);
                            const responseStream = createChatPayloadStream(responsePayload, promptTokens);
                            return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                                sessionKey: prepared.sessionKey,
                                refConvId: convId,
                                failover: 'token_rebind',
                            })), { type: "text/event-stream" });
                        }
                        const source = await chat.createCompletionStream(model, augmentedMessages, retryToken, convId, 0, audit);
                        const trackedStream = trackChatStream(source, prepared.sessionKey, sessionMessageCount, promptTokens, model, retryToken);
                        return new Response(tapStreamForAudit(trackedStream, audit, 'response.stream.completed', () => ({
                            sessionKey: prepared.sessionKey,
                            refConvId: convId,
                            failover: 'token_rebind',
                        })), { type: "text/event-stream" });
                    } else {
                        const { chatResponse, responsePayload } = await buildChatPayloadWithFallback({
                            model, messages: augmentedMessages, token: retryToken, convId,
                            audit, tools, promptTokens,
                        });
                        updateChatSession(prepared.sessionKey, chatResponse.id, sessionMessageCount, retryToken);
                        appendAuditEvent(audit, 'response.final', {
                            sessionKey: prepared.sessionKey,
                            refConvId: convId,
                            failover: 'token_rebind',
                            response: responsePayload,
                        });
                        return responsePayload;
                    }
                }
                appendAuditEvent(audit, 'request.error', {
                    error: serializeError(err),
                });
                throw err;
            }
        }

    }

}

