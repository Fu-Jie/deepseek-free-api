import { PassThrough } from 'stream';
import _ from 'lodash';
import storage from '@/lib/storage.ts';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import { calculateTokens, calculateMessagesTokens } from "@/lib/token.ts";
import { buildSessionPrefix, getExplicitSessionId, hashString, selectTokenForSession } from '@/lib/agent-session.ts';
import { appendAuditEvent, createAuditContext, sanitizeHeaders, serializeError, summarizeMessages, tapStreamForAudit } from '@/lib/audit-log.ts';
import {
    type AgentToolCall,
    cleanAssistantArtifacts as sharedCleanAssistantArtifacts,
    createToolNameResolver as createSharedToolNameResolver,
    getPotentialToolStartIndex as getSharedPotentialToolStartIndex,
    getTextBeforeToolCall as getSharedTextBeforeToolCall,
    getToolStartIndex as getSharedToolStartIndex,
    mayBecomeToolCallPrefix as mayBecomeSharedToolCallPrefix,
    parseAgentToolCalls,
} from '@/lib/tool-calls.ts';

const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;
const RESPONSES_SESSION_REUSE = ['1', 'true', 'yes', 'on'].includes(String(process.env.RESPONSES_SESSION_REUSE || 'true').toLowerCase());
const RESPONSES_SESSION_TTL = Number(process.env.RESPONSES_SESSION_TTL || 7 * 24 * 60 * 60 * 1000);
const RESPONSES_REFERENCE_PREFIX = 'responses:response-ref:';

interface ResponsesSession {
    conversationId: string;
    messageCount: number;
    updatedAt: number;
    token?: string; // 🌟 记录绑定的 Token
}

interface ResponsesReference {
    conversationId: string;
    updatedAt: number;
    token?: string;
}

interface NativeToolCallAccumulator {
    id: string;
    call_id: string;
    name: string;
    arguments: string;
}

setInterval(() => {
    storage.cleanup(RESPONSES_SESSION_TTL);
}, Math.min(RESPONSES_SESSION_TTL, 10 * 60 * 1000)).unref?.();

function isConversationId(value: any) {
    return _.isString(value) && /[0-9a-z\-]{36}@[0-9]+/.test(value);
}

function getResponseReferenceKey(responseId: string) {
    return `${RESPONSES_REFERENCE_PREFIX}${responseId}`;
}

function updateResponseReference(responseId: string | null | undefined, conversationId: string, token?: string) {
    if (!responseId || !isConversationId(conversationId)) return;
    storage.set(getResponseReferenceKey(responseId), {
        conversationId,
        updatedAt: Date.now(),
        token,
    });
}

function getResponseReference(responseId: string | null | undefined): ResponsesReference | null {
    if (!responseId) return null;
    const reference = storage.get(getResponseReferenceKey(responseId)) as ResponsesReference | undefined;
    if (!reference || !isConversationId(reference.conversationId)) return null;
    if (Date.now() - reference.updatedAt > RESPONSES_SESSION_TTL) return null;
    return reference;
}

function updateResponseHistorySession(sessionKey: string | null | undefined, conversationId: string, messageCount: number, token?: string) {
    if (!RESPONSES_SESSION_REUSE || !sessionKey || !isConversationId(conversationId)) return;
    const existing = storage.get(sessionKey) as ResponsesSession;
    if (existing?.conversationId === conversationId && existing.messageCount === messageCount) {
        storage.set(sessionKey, { ...existing, updatedAt: Date.now() });
        return;
    }
    storage.set(sessionKey, {
        conversationId,
        messageCount,
        updatedAt: Date.now(),
        token: token,
    });
    logger.info(`[RESPONSES SESSION] set history ${sessionKey} -> ${conversationId} (${messageCount})`);
}

function isInvalidMessageIdError(error: any) {
    const bizCode = _.get(error, 'data.biz_code') ?? _.get(error, 'data.data.biz_code');
    const bizMsg = String(_.get(error, 'data.biz_msg') || _.get(error, 'data.data.biz_msg') || _.get(error, 'message') || '').toLowerCase();
    return bizCode === 26 || bizMsg.includes('invalid message id');
}

function stringifyToolOutput(output: any): string {
    if (_.isString(output)) return output;
    if (_.isNil(output)) return '';
    return _.attempt(() => JSON.stringify(output)) as string || String(output);
}

function safeJsonStringify(value: any) {
    const result = _.attempt(() => JSON.stringify(value));
    return _.isError(result) ? '{}' : String(result || '{}');
}

function stringifyToolArgs(value: any) {
    if (_.isString(value)) return value;
    if (_.isNil(value)) return '{}';
    return safeJsonStringify(value);
}

function normalizeToolArguments(value: any): Record<string, any> {
    if (_.isPlainObject(value)) return value as Record<string, any>;
    if (_.isString(value)) return util.parseToolInput(value);
    if (_.isArray(value)) return { input: value };
    if (_.isNil(value)) return {};
    return { input: value };
}

function formatTodoList(items: any) {
    if (!_.isArray(items)) return '';
    return items
        .map((item) => {
            const text = _.get(item, 'text') || _.get(item, 'content');
            if (!text) return '';
            return `- [${_.get(item, 'completed') ? 'x' : ' '}] ${text}`;
        })
        .filter(Boolean)
        .join('\n');
}

function formatFileChanges(changes: any) {
    if (!_.isArray(changes)) return '';
    return changes
        .map((change) => {
            const kind = _.get(change, 'kind') || 'update';
            const path = _.get(change, 'path') || 'unknown';
            return `${kind} ${path}`;
        })
        .filter(Boolean)
        .join('\n');
}

function getToolDisplayName(part: any) {
    return String(_.get(part, 'name') || _.get(part, 'tool') || 'unknown').trim() || 'unknown';
}

function extractObjectText(part: any): string {
    const type = _.get(part, 'type');
    if (type === 'message') return extractText(_.get(part, 'content'));
    if (type === 'agent_message') return _.get(part, 'text') || extractText(_.get(part, 'content'));
    if (type === 'reasoning') return _.get(part, 'text') || _.get(part, 'summary') || extractText(_.get(part, 'content'));
    if (type === 'function_call_output') {
        const callId = _.get(part, 'call_id') || 'unknown';
        return `Tool result (${callId}):\n${stringifyToolOutput(_.get(part, 'output'))}`;
    }
    if (type === 'function_call') {
        const name = _.get(part, 'name') || 'unknown';
        return `Assistant requested tool ${name}: ${_.get(part, 'arguments') || '{}'}`;
    }
    if (type === 'custom_tool_call_output') {
        const callId = _.get(part, 'call_id') || _.get(part, 'id') || 'unknown';
        return `Tool result (${callId}):\n${stringifyToolOutput(_.get(part, 'output') ?? _.get(part, 'content'))}`;
    }
    if (type === 'custom_tool_call') {
        const name = getToolDisplayName(part);
        return `Assistant requested tool ${name}: ${stringifyToolArgs(_.get(part, 'input') ?? _.get(part, 'arguments'))}`;
    }
    if (type === 'mcp_tool_call') {
        const server = _.get(part, 'server');
        const toolName = getToolDisplayName(part);
        const resultText = [
            extractText(_.get(part, 'result.content')),
            !_.isNil(_.get(part, 'result.structured_content')) ? stringifyToolOutput(_.get(part, 'result.structured_content')) : '',
            _.get(part, 'error.message') || '',
        ].filter(Boolean).join('\n');
        if (resultText || ['completed', 'failed'].includes(String(_.get(part, 'status') || '')))
            return `Tool result (${server ? `${server}:` : ''}${toolName}):\n${resultText || String(_.get(part, 'status') || 'completed')}`;
        return `Assistant requested tool ${toolName}: ${stringifyToolArgs(_.get(part, 'arguments') ?? _.get(part, 'input'))}`;
    }
    if (type === 'command_execution') {
        const command = String(_.get(part, 'command') || '').trim();
        const exitCode = _.has(part, 'exit_code') ? `\nExit code: ${_.get(part, 'exit_code')}` : '';
        const aggregatedOutput = String(_.get(part, 'aggregated_output') || '').trim();
        if (aggregatedOutput || _.has(part, 'exit_code') || ['completed', 'failed'].includes(String(_.get(part, 'status') || '')))
            return `Tool result (command_execution):\nCommand: ${command}${exitCode}${aggregatedOutput ? `\n${aggregatedOutput}` : ''}`.trim();
        return `Assistant requested tool shell: ${safeJsonStringify({ command })}`;
    }
    if (type === 'file_change') {
        const changeText = formatFileChanges(_.get(part, 'changes'));
        const status = _.get(part, 'status');
        return [changeText ? 'Tool result (file_change):' : '', changeText, status ? `status: ${status}` : ''].filter(Boolean).join('\n');
    }
    if (type === 'web_search') {
        const query = _.get(part, 'query');
        return query ? `Assistant requested tool web_search: ${safeJsonStringify({ query })}` : '';
    }
    if (type === 'todo_list') {
        const todoText = formatTodoList(_.get(part, 'items'));
        return todoText ? `Todo list:\n${todoText}` : '';
    }
    if (type === 'error') return _.get(part, 'message') || stringifyToolOutput(_.omit(part, ['type', 'id']));
    return _.get(part, 'text') || _.get(part, 'input_text') || stringifyToolOutput(_.get(part, 'output')) || '';
}

function extractText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isObject(content) && !_.isArray(content)) return extractObjectText(content);
    if (_.isArray(content))
        return content
            .map((part) => {
                if (_.isString(part)) return part;
                if (_.isObject(part)) return extractObjectText(part);
                return '';
            })
            .filter(Boolean)
            .join('\n');
    return '';
}

function inferInputItemRole(item: any) {
    const explicitRole = _.get(item, 'role');
    if (_.isString(explicitRole) && explicitRole) return explicitRole;

    const type = _.get(item, 'type');
    if (['function_call_output', 'custom_tool_call_output', 'command_execution', 'file_change', 'error'].includes(type))
        return 'user';
    if (type === 'mcp_tool_call') {
        const status = String(_.get(item, 'status') || '');
        if (_.has(item, 'result') || _.has(item, 'error') || status === 'completed' || status === 'failed')
            return 'user';
    }

    return 'assistant';
}

function normalizeInputItemToMessages(item: any) {
    if (_.isString(item)) return [{ role: 'user', content: item }];
    if (!_.isObject(item)) return [];

    const itemType = _.get(item, 'type');
    if (!itemType && (_.has(item, 'role') || _.has(item, 'content'))) {
        const role = _.get(item, 'role') || 'user';
        const content = extractText(_.get(item, 'content')) || extractText(item);
        return content ? [{ role, content }] : [];
    }

    const role = inferInputItemRole(item);
    const content = extractText(_.get(item, 'content')) || extractText(item);
    return content ? [{ role, content }] : [];
}

import { buildToolsPrompt as buildResponsesToolsPrompt } from '@/lib/tool-prompt.ts';

function getSafeInstructions(instructions: any, tools: any[] = []) {
    const instructionText = extractText(instructions);
    return [instructionText, buildResponsesToolsPrompt(tools)].filter(Boolean).join('\n\n');
}

function normalizeInputToMessages(input: any, instructions?: string, tools: any[] = []): any[] {
    const messages: any[] = [];
    const safeInstructions = getSafeInstructions(instructions, tools);
    if (safeInstructions)
        messages.push({ role: 'system', content: safeInstructions });

    if (_.isString(input)) {
        messages.push({ role: 'user', content: input });
        return messages;
    }

    if (_.isObject(input) && !_.isArray(input)) {
        messages.push(...normalizeInputItemToMessages(input));
        return messages;
    }

    if (_.isArray(input)) {
        for (const item of input) {
            messages.push(...normalizeInputItemToMessages(item));
        }
    }

    return messages;
}

function isToolResultMessage(message: any) {
    return _.get(message, 'role') === 'user' && String(_.get(message, 'content') || '').startsWith('Tool result (');
}

function getLatestActionMessages(messages: any[], since = 0) {
    const candidates = messages.slice(Math.max(0, since));
    const source = candidates.length ? candidates : messages;
    const latestUserIndex = _.findLastIndex(source, (message) => _.get(message, 'role') === 'user');
    if (latestUserIndex === -1) return source.slice(-1);

    const latestUser = source[latestUserIndex];
    if (!isToolResultMessage(latestUser)) return [latestUser];

    const toolResults: any[] = [];
    for (let index = latestUserIndex; index >= 0; index--) {
        const message = source[index];
        if (!isToolResultMessage(message)) break;
        toolResults.unshift(message);
    }
    return toolResults.length ? toolResults : [latestUser];
}

function fingerprintMessages(messages: any[], count: number, charLimit: number = 200) {
    const userContents = messages
        .filter((m: any) => _.get(m, 'role') === 'user')
        .slice(0, count)
        .map((m: any) => extractText(_.get(m, 'content')))
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

function getProgressiveSessionKeys(request: Request, endpoint: string, model: string, messages: any[], accountToken?: string) {
    const sessionId = getExplicitSessionId(request);
    const prefix = buildSessionPrefix(request, endpoint, model, accountToken);
    if (sessionId) return { currentKey: `${prefix}:session:${sessionId}`, previousKeys: [] as string[] };

    const historyMessages = messages.filter((message) => _.get(message, 'role') !== 'system');
    const turnCount = getUserTurnCount(historyMessages);
    const currentKey = buildTurnScopedKey(prefix, historyMessages, turnCount);
    const previousKeys: string[] = [];

    appendLegacySessionKeys(previousKeys, prefix, historyMessages, turnCount);
    if (turnCount > 1) {
        appendUniqueSessionKey(previousKeys, buildTurnScopedKey(prefix, historyMessages, turnCount - 1));
        appendLegacySessionKeys(previousKeys, prefix, historyMessages, turnCount - 1);
    }
    if (turnCount > 2) {
        appendUniqueSessionKey(previousKeys, buildTurnScopedKey(prefix, historyMessages, 1));
        appendLegacySessionKeys(previousKeys, prefix, historyMessages, 1);
    }

    return { currentKey, previousKeys: previousKeys.filter((key) => key !== currentKey) };
}

function getProgressiveCachedSession(
    currentKey: string,
    previousKeys: string[],
    ttl: number,
) {
    let session = storage.get(currentKey) as ResponsesSession;
    if (!session) {
        const previousKey = previousKeys.find((key) => storage.has(key));
        if (previousKey) {
            session = storage.get(previousKey) as ResponsesSession;
            if (session) {
                storage.set(currentKey, { ...session, updatedAt: Date.now() });
                // 🌟 核心修复：不再删除旧指纹，支持分支对话
            }
        }
    }
    if (!session || Date.now() - session.updatedAt > ttl) return null;
    return session;
}

function getMessagesForDeepSeek(request: Request, model: string, input: any, instructions: any, tools: any[] = [], explicitConversationId?: string, accountToken?: string) {
    const messages = normalizeInputToMessages(input, instructions, tools);
    if (!RESPONSES_SESSION_REUSE || explicitConversationId)
        return {
            sessionKey: null,
            refConvId: explicitConversationId,
            refToken: undefined,
            messages: explicitConversationId ? getLatestActionMessages(messages) : messages,
        };

    const { currentKey: sessionKey, previousKeys } = getProgressiveSessionKeys(request, 'responses', model, messages, accountToken);
    const cached = getProgressiveCachedSession(sessionKey, previousKeys, RESPONSES_SESSION_TTL);
    const canReuse = cached
        && messages.length > cached.messageCount
        && Date.now() - cached.updatedAt <= RESPONSES_SESSION_TTL;

    if (!canReuse) {
        return {
            sessionKey,
            refConvId: undefined,
            messages,
        };
    }

    return {
        sessionKey,
        refConvId: cached.conversationId,
        refToken: cached.token,
        messages: getLatestActionMessages(messages, cached.messageCount),
    };
}

function toResponsesUsage(usage?: any) {
    const inputTokens = _.get(usage, 'input_tokens', _.get(usage, 'prompt_tokens', 1));
    const outputTokens = _.get(usage, 'output_tokens', _.get(usage, 'completion_tokens', 1));
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: _.get(usage, 'total_tokens', inputTokens + outputTokens),
    };
}

type ToolNameResolver = (name: string, args?: Record<string, any>) => { name: string, args: Record<string, any> };

function createToolNameResolver(tools: any[] = []): ToolNameResolver {
    return createSharedToolNameResolver(tools);
}

function parseToolCalls(text: string, resolveToolName: ToolNameResolver = createToolNameResolver()) {
    return parseAgentToolCalls(text, resolveToolName);
}

function createResolvedToolCall(name: string, rawArguments: any, resolveToolName: ToolNameResolver, ids: { id?: string, callId?: string } = {}): AgentToolCall {
    const parsedArgs = normalizeToolArguments(rawArguments);
    const resolved = resolveToolName(name, _.isPlainObject(parsedArgs) ? parsedArgs : {});
    const input = _.isPlainObject(resolved.args) ? resolved.args : {};
    return {
        id: String(ids.id || `fc_${util.uuid(false)}`),
        call_id: String(ids.callId || ids.id || `call_${util.uuid(false)}`),
        name: resolved.name,
        input,
        arguments: safeJsonStringify(input),
    };
}

function mergeToolCalls(textCalls: AgentToolCall[], nativeCalls: AgentToolCall[]) {
    const merged: AgentToolCall[] = [];
    const seen = new Set<string>();

    for (const toolCall of [...textCalls, ...nativeCalls]) {
        const key = `${toolCall.name}:${toolCall.arguments}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(toolCall);
    }

    return merged;
}

function collectNativeToolCallsFromMessage(message: any, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const result: AgentToolCall[] = [];
    const toolCalls = _.get(message, 'tool_calls');
    if (_.isArray(toolCalls)) {
        for (const call of toolCalls) {
            const name = _.get(call, 'function.name') || _.get(call, 'name');
            if (!name) continue;
            result.push(createResolvedToolCall(name, _.get(call, 'function.arguments') ?? _.get(call, 'arguments') ?? _.get(call, 'input'), resolveToolName, {
                id: _.get(call, 'id'),
                callId: _.get(call, 'call_id') || _.get(call, 'id'),
            }));
        }
    }

    const functionCall = _.get(message, 'function_call');
    if (_.isObject(functionCall)) {
        const name = _.get(functionCall, 'name');
        if (name)
            result.push(createResolvedToolCall(name, _.get(functionCall, 'arguments') ?? _.get(functionCall, 'input'), resolveToolName, {
                id: _.get(functionCall, 'id'),
                callId: _.get(functionCall, 'call_id') || _.get(functionCall, 'id'),
            }));
    }

    return result;
}

function getToolStartIndex(text: string) {
    return getSharedToolStartIndex(text);
}

function getPotentialToolStartIndex(text: string) {
    return getSharedPotentialToolStartIndex(text);
}

function getTextBeforeToolCall(text: string) {
    return getSharedTextBeforeToolCall(text);
}

function mayBecomeToolCallPrefix(text: string) {
    return mayBecomeSharedToolCallPrefix(text);
}

function cleanAssistantArtifacts(text: string) {
    return sharedCleanAssistantArtifacts(text);
}

function toResponsesPayload(chatResponse: any, resolveToolName: ToolNameResolver = createToolNameResolver()) {
    const message = _.get(chatResponse, 'choices[0].message', {});
    const content = cleanAssistantArtifacts(message.content || '');
    const reasoningContent = message.reasoning_content || '';
    const created = chatResponse.created || util.unixTimestamp();
    const toolCalls = mergeToolCalls(
        parseToolCalls(content, resolveToolName),
        collectNativeToolCallsFromMessage(message, resolveToolName),
    );
    const output: any[] = [];

    if (reasoningContent)
        output.push({
            id: `rs_${chatResponse.id}`,
            type: 'reasoning',
            status: 'completed',
            summary: [],
            content: reasoningContent,
        });

    if (toolCalls.length) {
        for (const toolCall of toolCalls) {
            output.push({
                id: toolCall.id,
                type: 'function_call',
                status: 'completed',
                call_id: toolCall.call_id,
                name: toolCall.name,
                arguments: toolCall.arguments,
            });
        }
    } else {
        output.push({
            id: `msg_${chatResponse.id}`,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{
                type: 'output_text',
                text: content,
                annotations: [],
            }],
        });
    }

    return {
        id: `resp_${util.uuid(false)}`,
        object: 'response',
        created_at: created,
        status: 'completed',
        model: chatResponse.model,
        conversation_id: chatResponse.id,
        output,
        output_text: toolCalls.length ? '' : content,
        usage: toResponsesUsage(chatResponse.usage),
    };
}

    function getResponsesMessageText(item: any) {
        return extractText(_.get(item, 'content'));
    }

    function getResponsesOutputText(responsePayload: any) {
        const directText = _.get(responsePayload, 'output_text');
        if (_.isString(directText) && directText.trim()) return directText;
        return (_.get(responsePayload, 'output') as any[] || [])
            .filter((item) => _.get(item, 'type') === 'message')
            .map((item) => getResponsesMessageText(item))
            .filter(Boolean)
            .join('\n');
    }

    function hasResponsesFunctionCall(responsePayload: any) {
        return (_.get(responsePayload, 'output') as any[] || [])
            .some((item) => _.get(item, 'type') === 'function_call');
    }

    function shouldRegenerateToolResponse(responsePayload: any, tools: any[]) {
        return _.isArray(tools)
            && tools.length > 0
            && !hasResponsesFunctionCall(responsePayload)
            && !getResponsesOutputText(responsePayload).trim();
    }

    async function buildResponsesPayloadWithFallback(options: {
        model: string,
        messages: any[],
        token: string,
        refConvId?: string,
        resolveToolName: ToolNameResolver,
        tools: any[],
        audit?: any,
    }) {
        const promptTokens = calculateMessagesTokens(options.messages);
        let chatResponse = await chat.createCompletion(options.model.toLowerCase(), options.messages, options.token, options.refConvId, 0, options.audit);
        let responsePayload = toResponsesPayload(chatResponse, options.resolveToolName);
        let regenerateAttempted = false;

        if (shouldRegenerateToolResponse(responsePayload, options.tools) && isConversationId(chatResponse.id)) {
            regenerateAttempted = true;
            appendAuditEvent(options.audit, 'responses.regenerate.start', {
                model: options.model,
                refConvId: options.refConvId,
                sourceConversationId: chatResponse.id,
                promptTokens,
                reason: 'tool_response_without_text_or_function_call',
                response: responsePayload,
            });

            try {
                const normalizedModel = options.model.toLowerCase();
                const regeneratedChatResponse = await chat.regenerateCompletion(
                    normalizedModel,
                    options.token,
                    chatResponse.id,
                    promptTokens,
                    0,
                    options.audit,
                    {
                        thinkingEnabled: Boolean(_.get(chatResponse, 'choices[0].message.reasoning_content')) || normalizedModel.includes('think') || normalizedModel.includes('r1'),
                        searchEnabled: normalizedModel.includes('search'),
                    },
                );
                const regeneratedPayload = toResponsesPayload(regeneratedChatResponse, options.resolveToolName);
                appendAuditEvent(options.audit, 'responses.regenerate.result', {
                    model: options.model,
                    sourceConversationId: chatResponse.id,
                    regeneratedConversationId: regeneratedChatResponse.id,
                    stillUnsatisfactory: shouldRegenerateToolResponse(regeneratedPayload, options.tools),
                    response: regeneratedPayload,
                });
                chatResponse = regeneratedChatResponse;
                responsePayload = regeneratedPayload;
            } catch (error: any) {
                appendAuditEvent(options.audit, 'responses.regenerate.error', {
                    model: options.model,
                    sourceConversationId: chatResponse.id,
                    error: serializeError(error),
                });
            }
        }

        return {
            chatResponse,
            responsePayload,
            promptTokens,
            regenerateAttempted,
        };
    }

    function createResponsesPayloadStream(responsePayload: any) {
        const transStream = new PassThrough();

        const writeEvent = (type: string, data: any) => {
            transStream.write(`event: ${type}\n`);
            transStream.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        };

        setImmediate(() => {
            try {
                writeEvent('response.created', {
                    response: {
                        id: responsePayload.id,
                        object: 'response',
                        created_at: responsePayload.created_at,
                        status: 'in_progress',
                        model: responsePayload.model,
                        conversation_id: responsePayload.conversation_id,
                        output: [],
                    },
                });

                const outputItems: any[] = _.isArray(responsePayload.output) ? responsePayload.output : [];
                outputItems.forEach((item: any, outputIndex: number) => {
                    if (!_.isObject(item)) return;

                    if (_.get(item, 'type') === 'message') {
                        const itemId = _.get(item, 'id') || `msg_${util.uuid(false)}`;
                        const messageText = getResponsesMessageText(item);
                        const firstContent = _.get(item, 'content[0]') || { type: 'output_text', annotations: [] };
                        const finalPart = {
                            type: _.get(firstContent, 'type') || 'output_text',
                            text: messageText,
                            annotations: _.get(firstContent, 'annotations') || [],
                        };
                        writeEvent('response.output_item.added', {
                            output_index: outputIndex,
                            item: {
                                ...item,
                                id: itemId,
                                status: 'in_progress',
                                content: [],
                            },
                        });
                        writeEvent('response.content_part.added', {
                            item_id: itemId,
                            output_index: outputIndex,
                            content_index: 0,
                            part: { ...finalPart, text: '' },
                        });
                        if (messageText) {
                            writeEvent('response.output_text.delta', {
                                item_id: itemId,
                                output_index: outputIndex,
                                content_index: 0,
                                delta: messageText,
                            });
                        }
                        writeEvent('response.output_text.done', {
                            item_id: itemId,
                            output_index: outputIndex,
                            content_index: 0,
                            text: messageText,
                        });
                        writeEvent('response.content_part.done', {
                            item_id: itemId,
                            output_index: outputIndex,
                            content_index: 0,
                            part: finalPart,
                        });
                        writeEvent('response.output_item.done', {
                            output_index: outputIndex,
                            item: {
                                ...item,
                                id: itemId,
                                status: 'completed',
                                content: [finalPart],
                            },
                        });
                        return;
                    }

                    if (_.get(item, 'type') === 'function_call') {
                        writeEvent('response.output_item.added', {
                            output_index: outputIndex,
                            item: {
                                ...item,
                                status: 'in_progress',
                                arguments: '',
                            },
                        });
                        writeEvent('response.function_call_arguments.delta', {
                            item_id: _.get(item, 'id'),
                            output_index: outputIndex,
                            delta: _.get(item, 'arguments') || '',
                        });
                        writeEvent('response.function_call_arguments.done', {
                            item_id: _.get(item, 'id'),
                            output_index: outputIndex,
                            arguments: _.get(item, 'arguments') || '',
                        });
                        writeEvent('response.output_item.done', {
                            output_index: outputIndex,
                            item,
                        });
                        return;
                    }

                    writeEvent('response.output_item.added', {
                        output_index: outputIndex,
                        item: {
                            ...item,
                            status: _.get(item, 'status') === 'completed' ? 'in_progress' : _.get(item, 'status'),
                        },
                    });
                    writeEvent('response.output_item.done', {
                        output_index: outputIndex,
                        item,
                    });
                });

                writeEvent('response.completed', {
                    response: responsePayload,
                });
            } catch (error: any) {
                logger.error(`[responses payload stream] emit error: ${error.message}`);
                writeEvent('error', {
                    type: 'error',
                    error: {
                        type: 'internal_error',
                        message: error.message || 'Buffered response stream failed',
                    },
                });
            }

            if (!transStream.closed) transStream.end();
        });

        transStream.on('error', (err: Error) => {
            logger.error(`[responses payload stream] transStream error: ${err.message}`);
        });

        return transStream;
    }

function createResponsesStream(
    chatStream: any,
    model: string,
    options: {
        onConversationId?: (responseId: string, conversationId: string) => void,
        resolveToolName?: ToolNameResolver,
        promptTokens?: number,
        deferTextUntilClose?: boolean,
    } = {},
) {
    const {
        onConversationId,
        resolveToolName = createToolNameResolver(),
        promptTokens = 1,
        deferTextUntilClose = false,
    } = options;
    const responseId = `resp_${util.uuid(false)}`;
    const itemId = `msg_${util.uuid(false)}`;
    const created = util.unixTimestamp();
    const transStream = new PassThrough();
    let buffer = '';
    let outputText = '';
    let latestConversationId = '';
    let streamedTextLength = 0;
    let messageStarted = false;
    const nativeToolCallMap = new Map<string, NativeToolCallAccumulator>();

    const getNativeToolCallAccumulator = (index: number, id?: string, callId?: string) => {
        const key = `${index}:${String(id || callId || '')}`;
        if (!nativeToolCallMap.has(key)) {
            nativeToolCallMap.set(key, {
                id: String(id || `fc_${util.uuid(false)}`),
                call_id: String(callId || id || `call_${util.uuid(false)}`),
                name: '',
                arguments: '',
            });
        }
        return nativeToolCallMap.get(key)!;
    };

    const ingestNativeToolCallDelta = (delta: any) => {
        const deltaToolCalls = _.get(delta, 'tool_calls');
        if (_.isArray(deltaToolCalls)) {
            for (const item of deltaToolCalls) {
                const index = Number(_.get(item, 'index', 0));
                const functionName = _.get(item, 'function.name') || _.get(item, 'name') || '';
                const functionArguments = _.get(item, 'function.arguments') || _.get(item, 'arguments') || '';
                const entry = getNativeToolCallAccumulator(index, _.get(item, 'id'), _.get(item, 'call_id'));
                if (functionName) entry.name = String(functionName);
                if (functionArguments) entry.arguments += String(functionArguments);
            }
        }

        const functionCall = _.get(delta, 'function_call');
        if (_.isObject(functionCall)) {
            const entry = getNativeToolCallAccumulator(0, _.get(functionCall, 'id'), _.get(functionCall, 'call_id'));
            const functionName = _.get(functionCall, 'name') || '';
            const functionArguments = _.get(functionCall, 'arguments') || '';
            if (functionName) entry.name = String(functionName);
            if (functionArguments) entry.arguments += String(functionArguments);
        }
    };

    const finalizeNativeToolCalls = () => {
        return [...nativeToolCallMap.values()]
            .filter((item) => item.name)
            .map((item) => createResolvedToolCall(item.name, item.arguments, resolveToolName, {
                id: item.id,
                callId: item.call_id,
            }));
    };

    const writeEvent = (type: string, data: any) => {
        transStream.write(`event: ${type}\n`);
        transStream.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    writeEvent('response.created', {
        response: {
            id: responseId,
            object: 'response',
            created_at: created,
            status: 'in_progress',
            model,
            output: [],
        },
    });

    const writeMessageStart = () => {
        if (messageStarted) return;
        writeEvent('response.output_item.added', {
            output_index: 0,
            item: {
                id: itemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
            },
        });
        writeEvent('response.content_part.added', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
        });
        messageStarted = true;
    };

    const writeTextDelta = (delta: string) => {
        if (!delta) return;
        writeMessageStart();
        writeEvent('response.output_text.delta', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta,
        });
    };

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const chunk = _.attempt(() => JSON.parse(data));
        if (_.isError(chunk)) return;
        const chunkId = _.get(chunk, 'id');
        if (isConversationId(chunkId)) {
            latestConversationId = chunkId;
            onConversationId?.(responseId, chunkId);
            onConversationId?.(itemId, chunkId);
        }
        ingestNativeToolCallDelta(_.get(chunk, 'choices[0].delta') || {});
        const delta = _.get(chunk, 'choices[0].delta.content') || '';
        if (!delta) return;
        outputText = cleanAssistantArtifacts(outputText + delta);
        if (streamedTextLength === 0 && mayBecomeToolCallPrefix(outputText)) return;
        const textEnd = getToolStartIndex(outputText);
        const potentialToolStart = textEnd === -1 ? getPotentialToolStartIndex(outputText) : -1;
        const streamableText = textEnd !== -1
            ? outputText.slice(0, textEnd)
            : potentialToolStart === -1
                ? outputText
                : outputText.slice(0, potentialToolStart);
        const textDelta = streamableText.slice(streamedTextLength);
        if (deferTextUntilClose) return;
        writeTextDelta(textDelta);
        streamedTextLength = streamableText.length;
    };

    chatStream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(processLine);
    });
    chatStream.once('error', (err: Error) => {
        logger.error(`[responses stream] chatStream error: ${err.message}`);
    });
    chatStream.once('close', () => {
        try {
            if (buffer) processLine(buffer);
        } catch (e: any) {
            logger.error(`[responses stream] processLine error: ${e.message}`);
        }
        try {
            const toolCalls = mergeToolCalls(parseToolCalls(outputText, resolveToolName), finalizeNativeToolCalls());
            const output: any[] = [];
            const visibleText = toolCalls.length ? '' : outputText;

            if (messageStarted || visibleText) {
                const messageItem = {
                    id: itemId,
                    type: 'message',
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: visibleText, annotations: [] }],
                };

                if (streamedTextLength < visibleText.length) {
                    writeTextDelta(visibleText.slice(streamedTextLength));
                    streamedTextLength = visibleText.length;
                } else {
                    writeMessageStart();
                }
                writeEvent('response.output_text.done', {
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    text: visibleText,
                });
                writeEvent('response.content_part.done', {
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'output_text', text: visibleText, annotations: [] },
                });
                writeEvent('response.output_item.done', {
                    output_index: 0,
                    item: messageItem,
                });
                output.push(messageItem);
            }

            if (toolCalls.length) {
                const startIndex = output.length;
                toolCalls.forEach((toolCall, toolCallIndex) => {
                    const outputIndex = startIndex + toolCallIndex;
                    const addedItem = {
                        id: toolCall.id,
                        type: 'function_call',
                        status: 'in_progress',
                        call_id: toolCall.call_id,
                        name: toolCall.name,
                        arguments: '',
                    };
                    const doneItem = { ...addedItem, status: 'completed', arguments: toolCall.arguments };

                    writeEvent('response.output_item.added', {
                        output_index: outputIndex,
                        item: addedItem,
                    });
                    writeEvent('response.function_call_arguments.delta', {
                        item_id: toolCall.id,
                        output_index: outputIndex,
                        delta: toolCall.arguments,
                    });
                    writeEvent('response.function_call_arguments.done', {
                        item_id: toolCall.id,
                        output_index: outputIndex,
                        arguments: toolCall.arguments,
                    });
                    writeEvent('response.output_item.done', {
                        output_index: outputIndex,
                        item: doneItem,
                    });
                    output.push(doneItem);
                });
            } else if (!output.length) {
                const messageItem = {
                    id: itemId,
                    type: 'message',
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: visibleText, annotations: [] }],
                };

                if (streamedTextLength < visibleText.length) {
                    writeTextDelta(visibleText.slice(streamedTextLength));
                    streamedTextLength = visibleText.length;
                } else {
                    writeMessageStart();
                }
                writeEvent('response.output_text.done', {
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    text: visibleText,
                });
                writeEvent('response.content_part.done', {
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'output_text', text: visibleText, annotations: [] },
                });
                writeEvent('response.output_item.done', {
                    output_index: 0,
                    item: messageItem,
                });
                output.push(messageItem);
            }

            writeEvent('response.completed', {
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: created,
                    status: 'completed',
                    model,
                    conversation_id: latestConversationId || undefined,
                    output,
                    output_text: toolCalls.length ? visibleText : outputText,
                    usage: toResponsesUsage({ prompt_tokens: promptTokens, completion_tokens: calculateTokens(outputText) }),
                },
            });
        } catch (e: any) {
            logger.error(`[responses stream] close finalization error: ${e.message}`);
            writeEvent('error', {
                type: 'error',
                error: { type: 'internal_error', message: e.message || 'Stream finalization failed' },
            });
        }
        if (!transStream.closed) transStream.end();
    });
    transStream.on('error', (err: Error) => {
        logger.error(`[responses stream] transStream error: ${err.message}`);
    });

    return transStream;
}

export default {

    prefix: '/v1',

    post: {

        '/responses': async (request: Request) => {
            const audit = createAuditContext({
                endpoint: 'responses',
                route: '/v1/responses',
                model: _.get(request, 'body.model'),
                stream: Boolean(_.get(request, 'body.stream')),
            });
            appendAuditEvent(audit, 'request.received', {
                headers: sanitizeHeaders(request.headers),
                body: request.body,
            });
            if (DEEP_SEEK_CHAT_AUTHORIZATION) {
                request.headers.authorization = 'Bearer ' + DEEP_SEEK_CHAT_AUTHORIZATION;
            }

            request
                .validate('body.model', _.isString)
                .validate('headers.authorization', _.isString)

            const tokens = chat.tokenSplit(request.headers.authorization);
            const { model, input, instructions, stream } = request.body;
            const tools = _.isArray(_.get(request, 'body.tools')) ? request.body.tools : [];
            const resolveToolName = createToolNameResolver(tools);
            const normalizedMessages = normalizeInputToMessages(input, instructions, tools);
            const previousResponseId = _.isString(_.get(request, 'body.previous_response_id')) ? String(_.get(request, 'body.previous_response_id')).trim() : undefined;
            const explicitConversationId = _.isString(_.get(request, 'body.conversation_id'))
                ? String(_.get(request, 'body.conversation_id')).trim()
                : getResponseReference(previousResponseId)?.conversationId || (isConversationId(previousResponseId) ? previousResponseId : undefined);
            const explicitReference = getResponseReference(previousResponseId);
            // 🌟 始终用首条消息指纹作为种子，确保同一对话每轮选到同一个 token
            const selectedToken = selectTokenForSession(tokens, `${model}:${fingerprintMessages(normalizedMessages, 1, 500)}`);
            const prepared = getMessagesForDeepSeek(request, model, input, instructions, tools, explicitConversationId, selectedToken);

            if (!prepared.messages.length)
                throw new Error('Params body.input invalid');

            const finalToken = explicitReference?.token || prepared.refToken || selectedToken;
            appendAuditEvent(audit, 'request.prepared', {
                model,
                stream: Boolean(stream),
                input,
                instructions,
                tools,
                normalizedMessages,
                normalizedMessageSummary: summarizeMessages(normalizedMessages),
                preparedMessages: prepared.messages,
                preparedMessageSummary: summarizeMessages(prepared.messages),
                session: {
                    sessionKey: prepared.sessionKey,
                    previousResponseId,
                    refConvId: prepared.refConvId,
                    explicitConversationId,
                    explicitReferenceFound: Boolean(explicitReference),
                    hasBoundToken: Boolean(prepared.refToken),
                },
            });

            const finalizeStructuredResponse = async (messagesToSend: any[], tokenToUse: string, refConvIdToUse?: string, meta: Record<string, any> = {}) => {
                const { chatResponse, responsePayload, regenerateAttempted } = await buildResponsesPayloadWithFallback({
                    model,
                    messages: messagesToSend,
                    token: tokenToUse,
                    refConvId: refConvIdToUse,
                    resolveToolName,
                    tools,
                    audit,
                });
                updateResponseHistorySession(prepared.sessionKey, chatResponse.id, normalizedMessages.length, tokenToUse);
                updateResponseReference(responsePayload.id, chatResponse.id, tokenToUse);
                appendAuditEvent(audit, 'response.final', {
                    sessionKey: prepared.sessionKey,
                    refConvId: refConvIdToUse,
                    regenerateAttempted,
                    ...meta,
                    response: responsePayload,
                });
                return responsePayload;
            };

            const createBufferedToolResponseStream = async (messagesToSend: any[], tokenToUse: string, refConvIdToUse?: string, meta: Record<string, any> = {}) => {
                const { chatResponse, responsePayload, promptTokens, regenerateAttempted } = await buildResponsesPayloadWithFallback({
                    model,
                    messages: messagesToSend,
                    token: tokenToUse,
                    refConvId: refConvIdToUse,
                    resolveToolName,
                    tools,
                    audit,
                });
                updateResponseHistorySession(prepared.sessionKey, chatResponse.id, normalizedMessages.length, tokenToUse);
                updateResponseReference(responsePayload.id, chatResponse.id, tokenToUse);
                appendAuditEvent(audit, 'response.stream.start', {
                    promptTokens,
                    sessionKey: prepared.sessionKey,
                    refConvId: refConvIdToUse,
                    buffered: true,
                    regenerateAttempted,
                    ...meta,
                });
                const responseStream = createResponsesPayloadStream(responsePayload);
                return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                    sessionKey: prepared.sessionKey,
                    refConvId: refConvIdToUse,
                    buffered: true,
                    regenerateAttempted,
                    ...meta,
                })), {
                    type: 'text/event-stream',
                });
            };

            try {
                if (stream) {
                    if (tools.length > 0) {
                        return createBufferedToolResponseStream(prepared.messages, finalToken, prepared.refConvId);
                    }
                    const promptTokens = calculateMessagesTokens(prepared.messages);
                    const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, finalToken, prepared.refConvId, 0, audit);
                    const responseStream = createResponsesStream(chatStream, model, {
                        resolveToolName,
                        promptTokens,
                        onConversationId: (responseId, conversationId) => {
                            updateResponseHistorySession(prepared.sessionKey, conversationId, normalizedMessages.length, finalToken);
                            updateResponseReference(responseId, conversationId, finalToken);
                        },
                    });
                    appendAuditEvent(audit, 'response.stream.start', {
                        promptTokens,
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                    });
                    return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                    })), {
                        type: 'text/event-stream',
                    });
                }

                return finalizeStructuredResponse(prepared.messages, finalToken, prepared.refConvId);
            } catch (err: any) {
                if (prepared.refConvId && prepared.sessionKey && isInvalidMessageIdError(err)) {
                    appendAuditEvent(audit, 'failover.invalid_message_id', {
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        error: serializeError(err),
                    });
                    logger.warn(`[RESPONSES FAILOVER] Cached conversation ${prepared.refConvId} returned invalid message id, clearing session and retrying with full context...`);
                    storage.delete(prepared.sessionKey);
                    if (stream) {
                        if (tools.length > 0) {
                            return createBufferedToolResponseStream(normalizedMessages, finalToken, undefined, {
                                failover: 'invalid_message_id',
                            });
                        }
                        const promptTokens = calculateMessagesTokens(normalizedMessages);
                        const chatStream = await chat.createCompletionStream(model.toLowerCase(), normalizedMessages, finalToken, undefined, 0, audit);
                        const responseStream = createResponsesStream(chatStream, model, {
                            resolveToolName,
                            promptTokens,
                            deferTextUntilClose: tools.length > 0,
                            onConversationId: (responseId, conversationId) => {
                                updateResponseHistorySession(prepared.sessionKey, conversationId, normalizedMessages.length, finalToken);
                                updateResponseReference(responseId, conversationId, finalToken);
                            },
                        });
                        return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                            sessionKey: prepared.sessionKey,
                            refConvId: undefined,
                            failover: 'invalid_message_id',
                        })), {
                            type: 'text/event-stream',
                        });
                    }

                    return finalizeStructuredResponse(normalizedMessages, finalToken, undefined, {
                        failover: 'invalid_message_id',
                    });
                }
                const status = _.get(err, 'response.status') || _.get(err, 'status');
                if ((status === 401 || status === 403) && prepared.refToken && prepared.sessionKey) {
                    appendAuditEvent(audit, 'failover.token_rebind', {
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        status,
                        error: serializeError(err),
                    });
                    logger.warn(`[RESPONSES FAILOVER] Bound token failed (${status}), clearing binding and retrying...`);
                    storage.delete(prepared.sessionKey);
                    const retryToken = selectTokenForSession(tokens.filter((item) => item !== finalToken), `${model}:${Date.now()}`) || selectedToken;
                    if (stream) {
                        if (tools.length > 0) {
                            return createBufferedToolResponseStream(prepared.messages, retryToken, prepared.refConvId, {
                                failover: 'token_rebind',
                            });
                        }
                        const promptTokens = calculateMessagesTokens(prepared.messages);
                        const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, retryToken, prepared.refConvId, 0, audit);
                        const responseStream = createResponsesStream(chatStream, model, {
                            resolveToolName,
                            promptTokens,
                            deferTextUntilClose: tools.length > 0,
                            onConversationId: (responseId, conversationId) => {
                                updateResponseHistorySession(prepared.sessionKey, conversationId, normalizedMessages.length, retryToken);
                                updateResponseReference(responseId, conversationId, retryToken);
                            },
                        });
                        return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                            sessionKey: prepared.sessionKey,
                            refConvId: prepared.refConvId,
                            failover: 'token_rebind',
                        })), { type: 'text/event-stream' });
                    }
                    return finalizeStructuredResponse(prepared.messages, retryToken, prepared.refConvId, {
                        failover: 'token_rebind',
                    });
                }
                appendAuditEvent(audit, 'request.error', {
                    error: serializeError(err),
                });
                throw err;
            }
        }

    }

}
