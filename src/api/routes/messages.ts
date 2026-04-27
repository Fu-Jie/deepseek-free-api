import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import { calculateTokens, calculateMessagesTokens } from "@/lib/token.ts";
import { buildSessionPrefix, getExplicitSessionId, hashString, selectTokenForSession } from '@/lib/agent-session.ts';
import { cleanAssistantArtifacts, getPotentialToolStartIndex, getToolStartIndex, mayBecomeToolCallPrefix, splitTextAndToolCalls } from '@/lib/tool-calls.ts';
import { appendAuditEvent, createAuditContext, sanitizeHeaders, serializeError, summarizeMessages, tapStreamForAudit } from '@/lib/audit-log.ts';

const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;
import storage from '@/lib/storage.ts';

const ANTHROPIC_SESSION_REUSE = ['1', 'true', 'yes', 'on'].includes(String(process.env.ANTHROPIC_SESSION_REUSE || 'true').toLowerCase());
const ANTHROPIC_SESSION_TTL = Number(process.env.ANTHROPIC_SESSION_TTL || 7 * 24 * 60 * 60 * 1000);

interface AnthropicSession {
    conversationId: string;
    messageCount: number;
    updatedAt: number;
    token?: string; // 🌟 记录绑定的 Token
}

setInterval(() => {
    storage.cleanup(ANTHROPIC_SESSION_TTL);
}, Math.min(ANTHROPIC_SESSION_TTL, 10 * 60 * 1000)).unref?.();

interface ParsedToolCall {
    id: string;
    name: string;
    input: any;
}

interface NativeToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
}

function stringifyStructuredValue(value: any) {
    if (_.isString(value)) return value;
    if (_.isNil(value)) return '';
    return _.attempt(() => JSON.stringify(value)) as string || String(value);
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

function extractStructuredPartText(part: any): string {
    if (_.isString(part)) return part;
    if (!_.isObject(part)) return '';

    const type = _.get(part, 'type');
    if (type === 'message') return extractText(_.get(part, 'content'));
    if (type === 'agent_message') return _.get(part, 'text') || extractText(_.get(part, 'content'));
    if (type === 'reasoning') return _.get(part, 'text') || _.get(part, 'summary') || extractText(_.get(part, 'content'));
    if (type === 'tool_result') {
        const toolContent = extractText(_.get(part, 'content'));
        const toolUseId = _.get(part, 'tool_use_id') || 'unknown';
        const isError = _.get(part, 'is_error') === true;
        const status = isError ? 'error' : 'ok';
        return `<tool_result tool_use_id="${toolUseId}" status="${status}">${toolContent}</tool_result>`;
    }
    if (type === 'tool_use') {
        const name = _.get(part, 'name') || 'unknown';
        const input = JSON.stringify(_.get(part, 'input') || {});
        return `<tool_call name="${name}">${input}</tool_call>`;
    }
    if (type === 'function_call') return `Assistant requested tool ${_.get(part, 'name') || 'unknown'}: ${_.get(part, 'arguments') || '{}'}`;
    if (type === 'function_call_output') return `Tool result (${_.get(part, 'call_id') || 'unknown'}):\n${extractText(_.get(part, 'output'))}`;
    if (type === 'custom_tool_call') return `Assistant requested tool ${_.get(part, 'name') || 'unknown'}: ${stringifyStructuredValue(_.get(part, 'input') ?? _.get(part, 'arguments'))}`;
    if (type === 'custom_tool_call_output') return `Tool result (${_.get(part, 'call_id') || _.get(part, 'id') || 'unknown'}):\n${extractText(_.get(part, 'output') ?? _.get(part, 'content'))}`;
    if (type === 'mcp_tool_call') {
        const server = _.get(part, 'server');
        const name = _.get(part, 'tool') || _.get(part, 'name') || 'unknown';
        const resultText = [
            extractText(_.get(part, 'result.content')),
            !_.isNil(_.get(part, 'result.structured_content')) ? stringifyStructuredValue(_.get(part, 'result.structured_content')) : '',
            _.get(part, 'error.message') || '',
        ].filter(Boolean).join('\n');
        if (resultText || ['completed', 'failed'].includes(String(_.get(part, 'status') || '')))
            return `Tool result (${server ? `${server}:` : ''}${name}):\n${resultText || String(_.get(part, 'status') || 'completed')}`;
        return `Assistant requested tool ${name}: ${stringifyStructuredValue(_.get(part, 'arguments') ?? _.get(part, 'input'))}`;
    }
    if (type === 'command_execution') {
        const command = String(_.get(part, 'command') || '').trim();
        const exitCode = _.has(part, 'exit_code') ? `\nExit code: ${_.get(part, 'exit_code')}` : '';
        const aggregatedOutput = String(_.get(part, 'aggregated_output') || '').trim();
        if (aggregatedOutput || _.has(part, 'exit_code') || ['completed', 'failed'].includes(String(_.get(part, 'status') || '')))
            return `Tool result (command_execution):\nCommand: ${command}${exitCode}${aggregatedOutput ? `\n${aggregatedOutput}` : ''}`.trim();
        return `Assistant requested tool shell: ${JSON.stringify({ command })}`;
    }
    if (type === 'file_change') {
        const changeText = formatFileChanges(_.get(part, 'changes'));
        const status = _.get(part, 'status');
        return [changeText ? 'Tool result (file_change):' : '', changeText, status ? `status: ${status}` : ''].filter(Boolean).join('\n');
    }
    if (type === 'web_search') {
        const query = _.get(part, 'query');
        return query ? `Assistant requested tool web_search: ${JSON.stringify({ query })}` : '';
    }
    if (type === 'todo_list') {
        const todoText = formatTodoList(_.get(part, 'items'));
        return todoText ? `Todo list:\n${todoText}` : '';
    }
    if (type === 'error') return _.get(part, 'message') || stringifyStructuredValue(_.omit(part, ['type', 'id']));

    return _.get(part, 'text') || '';
}

function extractText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isArray(content))
        return content
            .map(extractStructuredPartText)
            .filter(Boolean)
            .join('\n');
    if (_.isObject(content)) return extractStructuredPartText(content);
    return '';
}

import { buildToolsPrompt } from '@/lib/tool-prompt.ts';

function normalizeAnthropicMessages(messages: any[], system?: any, tools?: any[]) {
    const normalizedMessages: any[] = [];
    const systemText = [extractText(system), buildToolsPrompt(tools || [])].filter(Boolean).join('\n\n');

    if (systemText)
        normalizedMessages.push({ role: 'system', content: systemText });

    for (const message of messages) {
        if (!_.isObject(message)) continue;
        const role = _.get(message, 'role') || 'user';
        const content = extractText(_.get(message, 'content'));
        if (content) normalizedMessages.push({ role, content });
    }

    return normalizedMessages;
}

function fingerprintMessages(messages: any[], _system: string, count: number) {
    const userContents = messages
        .filter((m: any) => _.get(m, 'role') === 'user')
        .slice(0, count)
        .map((m: any) => extractText(_.get(m, 'content')))
        .filter(Boolean)
        .map((text: string) => text.length > 30 ? text.slice(0, 30) : text);
    return hashString(userContents.join('\n'));
}

function getUserTurnCount(messages: any[]) {
    return Math.max(messages.filter((message: any) => _.get(message, 'role') === 'user').length, 1);
}

function buildTurnScopedKey(prefix: string, messages: any[], system: string, turnCount: number) {
    return `${prefix}:u${turnCount}:${fingerprintMessages(messages, system, turnCount)}`;
}

function getLegacyTurnScopedKeys(prefix: string, messages: any[], system: string, turnCount: number) {
    if (turnCount <= 1)
        return [
            `${prefix}:m1:${fingerprintMessages(messages, system, 1)}`,
            `${prefix}:m3:${fingerprintMessages(messages, system, 1)}`,
            `${prefix}:m5:${fingerprintMessages(messages, system, 1)}`,
        ];

    if (turnCount === 2)
        return [
            `${prefix}:m3:${fingerprintMessages(messages, system, 2)}`,
            `${prefix}:m5:${fingerprintMessages(messages, system, 2)}`,
        ];

    return [`${prefix}:m5:${fingerprintMessages(messages, system, turnCount)}`];
}

function appendUniqueSessionKey(keys: string[], key?: string) {
    if (!key || keys.includes(key)) return;
    keys.push(key);
}

function appendLegacySessionKeys(keys: string[], prefix: string, messages: any[], system: string, turnCount: number) {
    getLegacyTurnScopedKeys(prefix, messages, system, turnCount).forEach((key) => appendUniqueSessionKey(keys, key));
}

function getProgressiveSessionKeys(request: Request, endpoint: string, model: string, messages: any[], system: string, accountToken?: string) {
    const sessionId = getExplicitSessionId(request);
    const prefix = buildSessionPrefix(request, endpoint, model, accountToken);
    if (sessionId) return { currentKey: `${prefix}:session:${sessionId}`, previousKeys: [] as string[] };

    const turnCount = getUserTurnCount(messages);
    const currentKey = buildTurnScopedKey(prefix, messages, system, turnCount);
    const previousKeys: string[] = [];

    appendLegacySessionKeys(previousKeys, prefix, messages, system, turnCount);
    if (turnCount > 1) {
        appendUniqueSessionKey(previousKeys, buildTurnScopedKey(prefix, messages, system, turnCount - 1));
        appendLegacySessionKeys(previousKeys, prefix, messages, system, turnCount - 1);
    }
    if (turnCount > 2) {
        appendUniqueSessionKey(previousKeys, buildTurnScopedKey(prefix, messages, system, 1));
        appendLegacySessionKeys(previousKeys, prefix, messages, system, 1);
    }

    return { currentKey, previousKeys: previousKeys.filter((key) => key !== currentKey) };
}

function getProgressiveCachedSession(currentKey: string, previousKeys: string[]) {
    let session = storage.get(currentKey) as AnthropicSession | undefined;
    if (!session) {
        const previousKey = previousKeys.find((key) => storage.has(key));
        if (previousKey) {
            session = storage.get(previousKey) as AnthropicSession | undefined;
            if (session) {
                // 🌟 核心修复：更新当前指纹，但绝不删除旧指纹，以支持分支对话
                storage.set(currentKey, { ...session, updatedAt: Date.now() });
            }
        }
    }
    return session;
}

function getMessagesForDeepSeek(request: Request, model: string, messages: any[], system?: string, tools?: any[], explicitConversationId?: string, accountToken?: string) {
    if (!ANTHROPIC_SESSION_REUSE || explicitConversationId || !messages.length)
        return {
            sessionKey: null,
            refConvId: explicitConversationId,
            messages: normalizeAnthropicMessages(messages, system, tools),
        };

    const { currentKey: sessionKey, previousKeys } = getProgressiveSessionKeys(request, 'messages', model, messages, system || "", accountToken);
    const cached = getProgressiveCachedSession(sessionKey, previousKeys);
    const canReuse = cached
        && messages.length > cached.messageCount
        && Date.now() - cached.updatedAt <= ANTHROPIC_SESSION_TTL;

    if (!canReuse) {
        logger.info(`[ANTHROPIC SESSION] miss sessionKey=${sessionKey} cached=${cached ? `mc=${cached.messageCount}` : 'none'}`);
        return {
            sessionKey,
            refConvId: undefined,
            refToken: undefined,
            messages: normalizeAnthropicMessages(messages, system, tools),
        };
    }

    logger.info(`[ANTHROPIC SESSION] hit sessionKey=${sessionKey} convId=${cached.conversationId} cachedMC=${cached.messageCount} newMC=${messages.length}`);
    return {
        sessionKey,
        refConvId: cached.conversationId,
        refToken: cached.token,
        messages: normalizeAnthropicMessages([messages[messages.length - 1]], undefined, tools),
    };
}

function updateSession(sessionKey: string | null | undefined, conversationId: string, messageCount: number, token?: string) {
    if (!ANTHROPIC_SESSION_REUSE || !sessionKey || !conversationId) return;
    storage.set(sessionKey, {
        conversationId,
        messageCount,
        updatedAt: Date.now(),
        token: token,
    });
}

function isInvalidMessageIdError(error: any) {
    const bizCode = _.get(error, 'data.biz_code') ?? _.get(error, 'data.data.biz_code');
    const bizMsg = String(_.get(error, 'data.biz_msg') || _.get(error, 'data.data.biz_msg') || _.get(error, 'message') || '').toLowerCase();
    return bizCode === 26 || bizMsg.includes('invalid message id');
}


function parseToolCalls(text: string, tools: any[] = []) {
    const { text: cleanText, toolCalls } = splitTextAndToolCalls(text, tools);
    return {
        text: cleanText,
        toolCalls: toolCalls.map((toolCall): ParsedToolCall => ({
            id: toolCall.call_id.replace(/^call_/, 'toolu_'),
            name: toolCall.name,
            input: toolCall.input,
        })),
    };
}

function parseToolArguments(rawArguments: any) {
    if (_.isPlainObject(rawArguments)) return rawArguments;
    const argumentText = String(rawArguments || '').trim();
    if (!argumentText) return {};
    const parsed = _.attempt(() => JSON.parse(argumentText));
    if (!_.isError(parsed) && _.isPlainObject(parsed)) return parsed;
    return { raw: argumentText };
}

function toParsedToolCall(name: string, input: any, id?: string): ParsedToolCall {
    const toolName = String(name || '').trim() || 'unknown_tool';
    return {
        id: String(id || `toolu_${util.uuid(false)}`),
        name: toolName,
        input: _.isPlainObject(input) ? input : {},
    };
}

function normalizeToolCallId(id?: string, fallback?: string) {
    const raw = String(id || fallback || '').trim();
    if (!raw) return `toolu_${util.uuid(false)}`;
    return raw.startsWith('toolu_') ? raw : `toolu_${raw}`;
}

function mergeParsedToolCalls(fromText: ParsedToolCall[], fromNative: ParsedToolCall[]) {
    const merged: ParsedToolCall[] = [];
    const seen = new Set<string>();
    const append = (call: ParsedToolCall) => {
        const key = `${call.name}:${JSON.stringify(call.input || {})}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(call);
    };
    fromText.forEach(append);
    fromNative.forEach(append);
    return merged;
}

function collectNativeToolCallsFromMessage(message: any): ParsedToolCall[] {
    const result: ParsedToolCall[] = [];
    const toolCalls = _.get(message, 'tool_calls');
    if (_.isArray(toolCalls)) {
        for (const call of toolCalls) {
            const name = _.get(call, 'function.name') || _.get(call, 'name');
            if (!name) continue;
            const id = normalizeToolCallId(_.get(call, 'id'));
            const input = parseToolArguments(_.get(call, 'function.arguments') || _.get(call, 'arguments'));
            result.push(toParsedToolCall(name, input, id));
        }
    }

    const functionCall = _.get(message, 'function_call');
    if (_.isObject(functionCall)) {
        const name = _.get(functionCall, 'name');
        if (name) {
            const input = parseToolArguments(_.get(functionCall, 'arguments'));
            result.push(toParsedToolCall(name, input));
        }
    }

    return result;
}

function toAnthropicContentBlocks(text: string, nativeToolCalls: ParsedToolCall[] = [], tools: any[] = []) {
    const { text: cleanText, toolCalls } = parseToolCalls(text, tools);
    const mergedToolCalls = mergeParsedToolCalls(toolCalls, nativeToolCalls);
    const content: any[] = [];
    if (cleanText) content.push({ type: 'text', text: cleanText });
    for (const toolCall of mergedToolCalls) {
        content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
        });
    }
    if (!content.length) content.push({ type: 'text', text });
    return { content, hasToolUse: mergedToolCalls.length > 0 };
}

function toAnthropicPayload(chatResponse: any, tools: any[] = []) {
    const message = _.get(chatResponse, 'choices[0].message') || {};
    const text = _.get(message, 'content') || '';
    const reasoning = _.get(chatResponse, 'choices[0].message.reasoning_content') || '';
    const nativeToolCalls = collectNativeToolCallsFromMessage(message);
    logger.info(`[messages payload] text(${text.length}): ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`);
    logger.info(`[messages payload] nativeCalls: ${JSON.stringify(nativeToolCalls)}`);
    const { content, hasToolUse } = toAnthropicContentBlocks(text, nativeToolCalls, tools);
    logger.info(`[messages payload] hasToolUse=${hasToolUse}`);

    // 🌟 如果存在思考内容，将其作为第一个 block 注入（对标 Claude 3.7 格式）
    if (reasoning) {
        content.unshift({
            type: 'thinking',
            thinking: reasoning,
            signature: 'ds-r1'
        });
    }

    return {
        id: `msg_${chatResponse.id}`,
        type: 'message',
        role: 'assistant',
        model: chatResponse.model,
        content,
        stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: _.get(chatResponse, 'usage.prompt_tokens', 1),
            output_tokens: _.get(chatResponse, 'usage.completion_tokens', 1),
        },
    };
}

function createAnthropicStream(chatStream: any, model: string, options: { deferOutput?: boolean, onConversationId?: (conversationId: string) => void, promptTokens?: number, tools?: any[] } = {}) {
    const { deferOutput = false, onConversationId, promptTokens = 1, tools = [] } = options;
    const messageId = `msg_${util.uuid(false)}`;
    const transStream = new PassThrough();
    let buffer = '';
    let outputText = '';
    let reasoningText = '';
    let textBlockStarted = false;
    let textBlockIndex: number | null = null;
    let thinkingBlockStarted = false;
    let thinkingBlockIndex: number | null = null;
    let thinkingBlockStopped = false;
    let thinkingWasStreamed = false;
    let deferredToolMode = false;
    let streamedTextLength = 0;
    let nextBlockIndex = 0;
    const nativeToolCallMap = new Map<string, NativeToolCallAccumulator>();

    const getNativeToolCallAccumulator = (index: number, id?: string) => {
        const key = `${index}:${String(id || '')}`;
        if (!nativeToolCallMap.has(key)) {
            nativeToolCallMap.set(key, {
                id: normalizeToolCallId(id, `tc_${index}_${util.uuid(false)}`),
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
                const entry = getNativeToolCallAccumulator(index, _.get(item, 'id'));
                if (functionName) entry.name = String(functionName);
                if (functionArguments) entry.arguments += String(functionArguments);
            }
        }

        const functionCall = _.get(delta, 'function_call');
        if (_.isObject(functionCall)) {
            const entry = getNativeToolCallAccumulator(0, _.get(functionCall, 'id'));
            const functionName = _.get(functionCall, 'name') || '';
            const functionArguments = _.get(functionCall, 'arguments') || '';
            if (functionName) entry.name = String(functionName);
            if (functionArguments) entry.arguments += String(functionArguments);
        }
    };

    const finalizeNativeToolCalls = (): ParsedToolCall[] => {
        return [...nativeToolCallMap.values()]
            .filter((item) => item.name)
            .map((item) => toParsedToolCall(item.name, parseToolArguments(item.arguments), item.id));
    };

    const writeEvent = (type: string, data: any) => {
        transStream.write(`event: ${type}\n`);
        transStream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent('message_start', {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: promptTokens, output_tokens: 0 },
        },
    });

    const writeThinkingDelta = (thinking: string) => {
        if (!thinking) return;
        reasoningText += thinking;
        if (textBlockStarted || deferredToolMode) return;
        if (thinkingBlockStopped) return;
        if (!thinkingBlockStarted) {
            thinkingBlockIndex = nextBlockIndex;
            writeEvent('content_block_start', {
                type: 'content_block_start',
                index: thinkingBlockIndex,
                content_block: { type: 'thinking', thinking: '', signature: 'ds-r1' },
            });
            thinkingBlockStarted = true;
            thinkingWasStreamed = true;
            nextBlockIndex += 1;
        }
        writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: thinkingBlockIndex,
            delta: { type: 'thinking_delta', thinking },
        });
    };

    const stopThinkingBlock = () => {
        if (!thinkingBlockStarted || thinkingBlockStopped) return;
        writeEvent('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex });
        thinkingBlockStopped = true;
    };

    const ensureTextBlockStarted = () => {
        if (textBlockStarted) return;
        textBlockIndex = nextBlockIndex;
        nextBlockIndex += 1;
        writeEvent('content_block_start', {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text', text: '' },
        });
        textBlockStarted = true;
    };

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const chunk = _.attempt(() => JSON.parse(data));
        if (_.isError(chunk)) return;
        const chunkId = _.get(chunk, 'id');
        if (_.isString(chunkId) && /[0-9a-z\-]{36}@[0-9]+/.test(chunkId))
            onConversationId?.(chunkId);
        ingestNativeToolCallDelta(_.get(chunk, 'choices[0].delta') || {});
        const reasoningDelta = _.get(chunk, 'choices[0].delta.reasoning_content') || '';
        if (reasoningDelta) writeThinkingDelta(reasoningDelta);
        const delta = _.get(chunk, 'choices[0].delta.content') || '';
        if (!delta) return;
        stopThinkingBlock();
        outputText = cleanAssistantArtifacts(outputText + delta);
        // Primary detection: tool call at line-start (getToolStartIndex)
        let toolStartIndex = getToolStartIndex(outputText);
        // Fallback detection: <tool_call anywhere in the new text (handles mid-line output from DeepSeek)
        if (toolStartIndex === -1 && !deferredToolMode) {
            const newText = outputText.slice(streamedTextLength);
            const newToolStartIndex = getToolStartIndex(newText);
            if (newToolStartIndex !== -1) {
                toolStartIndex = streamedTextLength + newToolStartIndex;
            }
        }
        const potentialToolStart = toolStartIndex === -1 ? getPotentialToolStartIndex(outputText) : -1;
        if (deferOutput && streamedTextLength === 0 && mayBecomeToolCallPrefix(outputText)) return;
        const streamableText = toolStartIndex !== -1
            ? outputText.slice(0, toolStartIndex)
            : potentialToolStart === -1
                ? outputText
                : outputText.slice(0, potentialToolStart);

        if (deferredToolMode || toolStartIndex !== -1) {
            const visibleDelta = streamableText.slice(streamedTextLength);
            if (visibleDelta) {
                ensureTextBlockStarted();
                writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: textBlockIndex,
                    delta: { type: 'text_delta', text: visibleDelta },
                });
                streamedTextLength = streamableText.length;
            }
            deferredToolMode = true;
            return;
        }
        ensureTextBlockStarted();
        const textDelta = streamableText.slice(streamedTextLength);
        if (!textDelta) return;
        writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: textDelta },
        });
        streamedTextLength = streamableText.length;
    };

    const writeContentBlock = (block: any) => {
        if (block.type === 'tool_use') {
            const index = nextBlockIndex;
            nextBlockIndex += 1;
            writeEvent('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
            });
            writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
            });
            writeEvent('content_block_stop', { type: 'content_block_stop', index });
            return;
        }

        if (textBlockStarted) return;

        const index = nextBlockIndex;
        nextBlockIndex += 1;

        writeEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' },
        });
        writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text || '' },
        });
        writeEvent('content_block_stop', {
            type: 'content_block_stop',
            index,
            content_block: { type: 'text', text: block.text || '' },
        });
    };

    let chatStreamClosed = false;
    let chatStreamError: Error | null = null;

    chatStream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(processLine);
    });
    chatStream.once('error', (err: Error) => {
        chatStreamError = err;
        logger.error(`[messages stream] chatStream error: ${err.message}`);
    });
    chatStream.once('close', () => {
        chatStreamClosed = true;
        if (buffer) processLine(buffer);
        try {
            const nativeCalls = finalizeNativeToolCalls();
            logger.info(`[messages stream close] outputText(${outputText.length}): ${outputText.slice(0, 500)}${outputText.length > 500 ? '...' : ''}`);
            logger.info(`[messages stream close] nativeCalls: ${JSON.stringify(nativeCalls)}`);
            const { content, hasToolUse } = toAnthropicContentBlocks(outputText, nativeCalls, tools);
            const finalContent = thinkingWasStreamed && reasoningText
                ? [{ type: 'thinking', thinking: reasoningText, signature: 'ds-r1' }, ...content]
                : content;
            logger.info(`[messages stream close] hasToolUse=${hasToolUse}, content=${JSON.stringify(finalContent).slice(0, 300)}`);
            stopThinkingBlock();
            if (textBlockStarted && textBlockIndex != null)
                writeEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
            content.forEach(writeContentBlock);
            const outputTokens = calculateTokens(outputText);
            writeEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
                usage: { output_tokens: outputTokens },
            });
            writeEvent('message_stop', {
                type: 'message_stop',
                message: {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: finalContent,
                    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: promptTokens, output_tokens: outputTokens },
                },
            });
        } catch (e: any) {
            logger.error(`[messages stream close] finalization error: ${e.message}`);
            writeEvent('error', {
                type: 'error',
                error: { type: 'internal_error', message: e.message || 'Stream finalization failed' },
            });
            writeEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: calculateTokens(outputText) },
            });
            writeEvent('message_stop', {
                type: 'message_stop',
            });
        }
        transStream.end();
    });

    // 抑制 transStream 自身 error 事件，防止未捕获异常导致进程崩溃
    transStream.on('error', (err: Error) => {
        logger.error(`[messages stream] transStream error: ${err.message}`);
    });

    return transStream;
}

function isConversationId(value: any): boolean {
    if (!_.isString(value)) return false;
    return /[0-9a-z\-]{36}@[0-9]+/.test(value);
}

function shouldRegenerateMessagesResponse(payload: any, tools?: any[]): boolean {
    if (!tools || !_.isArray(tools) || tools.length === 0) return false;
    const content: any[] = _.isArray(_.get(payload, 'content')) ? _.get(payload, 'content') : [];
    const hasToolUse = content.some((b: any) => b.type === 'tool_use');
    if (hasToolUse) return false;
    const text = content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => String(b.text || ''))
        .join('')
        .trim();
    return !text;
}

async function buildMessagesPayloadWithFallback(options: {
    model: string;
    messages: any[];
    token: string;
    refConvId?: string;
    audit: any;
    tools?: any[];
    promptTokens?: number;
}): Promise<{ chatResponse: any; responsePayload: any }> {
    const { model, messages, token, refConvId, audit, tools = [], promptTokens = 1 } = options;
    let chatResponse = await chat.createCompletion(model, messages, token, refConvId, 0, audit);
    let responsePayload = toAnthropicPayload(chatResponse, tools);

    if (shouldRegenerateMessagesResponse(responsePayload, tools) && isConversationId(chatResponse.id)) {
        logger.warn(`[MESSAGES REGEN] Empty tool response, attempting regenerate convId=${chatResponse.id}`);
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
            const regenPayload = toAnthropicPayload(regenResponse, tools);
            logger.info(`[MESSAGES REGEN] Regenerate succeeded hasToolUse=${regenPayload.content?.some((b: any) => b.type === 'tool_use')}`);
            chatResponse = regenResponse;
            responsePayload = regenPayload;
        } catch (regenErr: any) {
            logger.warn(`[MESSAGES REGEN] Regenerate failed: ${regenErr.message}`);
        }
    }

    return { chatResponse, responsePayload };
}

function createBufferedAnthropicToolStream(responsePayload: any, model: string, promptTokens: number): PassThrough {
    const stream = new PassThrough();
    const messageId = String(_.get(responsePayload, 'id') || `msg_${util.uuid(false)}`);
    const content: any[] = _.isArray(_.get(responsePayload, 'content')) ? _.get(responsePayload, 'content') : [];
    const stopReason = String(_.get(responsePayload, 'stop_reason') || 'end_turn');

    const writeEvent = (type: string, data: any) => {
        stream.write(`event: ${type}\n`);
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    setImmediate(() => {
        writeEvent('message_start', {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: promptTokens, output_tokens: 0 },
            },
        });

        let blockIndex = 0;
        for (const block of content) {
            const index = blockIndex++;
            if (block.type === 'thinking') {
                writeEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: 'ds-r1' } });
                writeEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(block.thinking || '') } });
                writeEvent('content_block_stop', { type: 'content_block_stop', index });
            } else if (block.type === 'text') {
                writeEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
                writeEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(block.text || '') } });
                writeEvent('content_block_stop', { type: 'content_block_stop', index });
            } else if (block.type === 'tool_use') {
                writeEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
                writeEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
                writeEvent('content_block_stop', { type: 'content_block_stop', index });
            }
        }

        const textContent = content.filter((b: any) => b.type === 'text').map((b: any) => String(b.text || '')).join('');
        const outputTokens = calculateTokens(textContent);
        writeEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
        });
        writeEvent('message_stop', {
            type: 'message_stop',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: { input_tokens: promptTokens, output_tokens: outputTokens },
            },
        });
        stream.end();
    });

    stream.on('error', (err: Error) => {
        logger.error(`[messages buffered tool stream] error: ${err.message}`);
    });

    return stream;
}

async function handleMessages(request: Request) {
    const audit = createAuditContext({
        endpoint: 'messages',
        route: '/v1/messages',
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
        .validate('body.messages', _.isArray)
        .validate('headers.authorization', _.isString)

    const tokens = chat.tokenSplit(request.headers.authorization);
    const { model, messages, system, tools, stream, conversation_id } = request.body;
    // 🌟 始终用首条消息指纹作为 token 选择种子，确保同一对话每轮选到同一个 token，
    //    避免 session key 前缀因 token 变化而查不到上一轮存储的 session
    const selectedToken = selectTokenForSession(tokens, `${model}:${conversation_id || ''}:${fingerprintMessages(messages, extractText(system), 1)}`);
    const fullMessages = normalizeAnthropicMessages(messages, system, tools);
    const prepared = getMessagesForDeepSeek(request, model, messages, system, tools, conversation_id, selectedToken);

    if (!fullMessages.length)
        throw new Error('Params body.messages invalid');

    const finalToken = prepared.refToken || selectedToken;
    appendAuditEvent(audit, 'request.prepared', {
        model,
        stream: Boolean(stream),
        rawMessages: messages,
        rawMessageSummary: summarizeMessages(messages),
        normalizedMessages: fullMessages,
        normalizedMessageSummary: summarizeMessages(fullMessages),
        preparedMessages: prepared.messages,
        preparedMessageSummary: summarizeMessages(prepared.messages),
        system,
        tools,
        session: {
            sessionKey: prepared.sessionKey,
            refConvId: prepared.refConvId,
            hasBoundToken: Boolean(prepared.refToken),
        },
    });

    const hasTools = tools && _.isArray(tools) && tools.length > 0;

    try {
        if (stream) {
            const promptTokens = calculateMessagesTokens(prepared.messages);
            if (hasTools) {
                appendAuditEvent(audit, 'response.stream.start', {
                    promptTokens,
                    sessionKey: prepared.sessionKey,
                    refConvId: prepared.refConvId,
                    buffered: true,
                });
                const { chatResponse, responsePayload } = await buildMessagesPayloadWithFallback({
                    model: model.toLowerCase(),
                    messages: prepared.messages,
                    token: finalToken,
                    refConvId: prepared.refConvId,
                    audit,
                    tools,
                    promptTokens,
                });
                updateSession(prepared.sessionKey, chatResponse.id, messages.length, finalToken);
                const responseStream = createBufferedAnthropicToolStream(responsePayload, model, promptTokens);
                return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                    sessionKey: prepared.sessionKey,
                    refConvId: prepared.refConvId,
                })), {
                    type: 'text/event-stream',
                });
            }
            const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, finalToken, prepared.refConvId, 0, audit);
            const responseStream = createAnthropicStream(chatStream, model, {
                deferOutput: false,
                onConversationId: (conversationId) => updateSession(prepared.sessionKey, conversationId, messages.length, finalToken),
                promptTokens,
                tools,
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

        const promptTokens = calculateMessagesTokens(prepared.messages);
        const { chatResponse, responsePayload } = await buildMessagesPayloadWithFallback({
            model: model.toLowerCase(),
            messages: prepared.messages,
            token: finalToken,
            refConvId: prepared.refConvId,
            audit,
            tools,
            promptTokens,
        });
        updateSession(prepared.sessionKey, chatResponse.id, messages.length, finalToken);
        appendAuditEvent(audit, 'response.final', {
            sessionKey: prepared.sessionKey,
            refConvId: prepared.refConvId,
            response: responsePayload,
        });
        return responsePayload;
    } catch (err: any) {
        if (prepared.refConvId && prepared.sessionKey && isInvalidMessageIdError(err)) {
            appendAuditEvent(audit, 'failover.invalid_message_id', {
                sessionKey: prepared.sessionKey,
                refConvId: prepared.refConvId,
                error: serializeError(err),
            });
            logger.warn(`[ANTHROPIC FAILOVER] Cached conversation ${prepared.refConvId} returned invalid message id, clearing session and retrying with full context...`);
            storage.delete(prepared.sessionKey);
            const promptTokens = calculateMessagesTokens(fullMessages);
            if (stream) {
                if (hasTools) {
                    const { chatResponse, responsePayload } = await buildMessagesPayloadWithFallback({
                        model: model.toLowerCase(),
                        messages: fullMessages,
                        token: finalToken,
                        refConvId: undefined,
                        audit,
                        tools,
                        promptTokens,
                    });
                    updateSession(prepared.sessionKey, chatResponse.id, messages.length, finalToken);
                    const responseStream = createBufferedAnthropicToolStream(responsePayload, model, promptTokens);
                    return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                        sessionKey: prepared.sessionKey,
                        refConvId: undefined,
                        failover: 'invalid_message_id',
                    })), { type: 'text/event-stream' });
                }
                const chatStream = await chat.createCompletionStream(model.toLowerCase(), fullMessages, finalToken, undefined, 0, audit);
                const responseStream = createAnthropicStream(chatStream, model, {
                    deferOutput: false,
                    onConversationId: (conversationId) => updateSession(prepared.sessionKey, conversationId, messages.length, finalToken),
                    promptTokens,
                    tools,
                });
                return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                    sessionKey: prepared.sessionKey,
                    refConvId: undefined,
                    failover: 'invalid_message_id',
                })), { type: 'text/event-stream' });
            }
            const { chatResponse, responsePayload } = await buildMessagesPayloadWithFallback({
                model: model.toLowerCase(),
                messages: fullMessages,
                token: finalToken,
                refConvId: undefined,
                audit,
                tools,
                promptTokens,
            });
            updateSession(prepared.sessionKey, chatResponse.id, messages.length, finalToken);
            appendAuditEvent(audit, 'response.final', {
                sessionKey: prepared.sessionKey,
                refConvId: undefined,
                failover: 'invalid_message_id',
                response: responsePayload,
            });
            return responsePayload;
        }
        const status = _.get(err, 'response.status') || _.get(err, 'status');
        if ((status === 401 || status === 403) && prepared.refToken && prepared.sessionKey) {
            appendAuditEvent(audit, 'failover.token_rebind', {
                sessionKey: prepared.sessionKey,
                refConvId: prepared.refConvId,
                status,
                error: serializeError(err),
            });
            logger.warn(`[ANTHROPIC FAILOVER] Bound token failed (${status}), clearing binding and retrying...`);
            storage.delete(prepared.sessionKey);
            const retryToken = selectTokenForSession(tokens.filter((item) => item !== finalToken), `${model}:${Date.now()}`) || selectedToken;
            const promptTokens = calculateMessagesTokens(prepared.messages);
            if (stream) {
                if (hasTools) {
                    const { chatResponse, responsePayload } = await buildMessagesPayloadWithFallback({
                        model: model.toLowerCase(),
                        messages: prepared.messages,
                        token: retryToken,
                        refConvId: prepared.refConvId,
                        audit,
                        tools,
                        promptTokens,
                    });
                    updateSession(prepared.sessionKey, chatResponse.id, messages.length, retryToken);
                    const responseStream = createBufferedAnthropicToolStream(responsePayload, model, promptTokens);
                    return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                        sessionKey: prepared.sessionKey,
                        refConvId: prepared.refConvId,
                        failover: 'token_rebind',
                    })), { type: 'text/event-stream' });
                }
                const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, retryToken, prepared.refConvId, 0, audit);
                const responseStream = createAnthropicStream(chatStream, model, {
                    deferOutput: false,
                    onConversationId: (conversationId) => updateSession(prepared.sessionKey, conversationId, messages.length, retryToken),
                    promptTokens,
                    tools,
                });
                return new Response(tapStreamForAudit(responseStream, audit, 'response.stream.completed', () => ({
                    sessionKey: prepared.sessionKey,
                    refConvId: prepared.refConvId,
                    failover: 'token_rebind',
                })), { type: 'text/event-stream' });
            }
            const { chatResponse, responsePayload } = await buildMessagesPayloadWithFallback({
                model: model.toLowerCase(),
                messages: prepared.messages,
                token: retryToken,
                refConvId: prepared.refConvId,
                audit,
                tools,
                promptTokens,
            });
            updateSession(prepared.sessionKey, chatResponse.id, messages.length, retryToken);
            appendAuditEvent(audit, 'response.final', {
                sessionKey: prepared.sessionKey,
                refConvId: prepared.refConvId,
                failover: 'token_rebind',
                response: responsePayload,
            });
            return responsePayload;
        }
        appendAuditEvent(audit, 'request.error', {
            error: serializeError(err),
        });
        throw err;
    }
}

export const anthropicMessages = {

    prefix: '/anthropic/v1',

    post: {

        '/messages': handleMessages

    }

}

export default {

    prefix: '/v1',

    post: {

        '/messages': handleMessages

    }

}
