import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';

const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;
const ANTHROPIC_SESSION_REUSE = ['1', 'true', 'yes', 'on'].includes(String(process.env.ANTHROPIC_SESSION_REUSE || '').toLowerCase());
const ANTHROPIC_SESSION_TTL = Number(process.env.ANTHROPIC_SESSION_TTL || 2 * 60 * 60 * 1000);

interface AnthropicSession {
    conversationId: string;
    messageCount: number;
    updatedAt: number;
}

const sessionMap = new Map<string, AnthropicSession>();

setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessionMap) {
        if (now - session.updatedAt > ANTHROPIC_SESSION_TTL)
            sessionMap.delete(key);
    }
}, Math.min(ANTHROPIC_SESSION_TTL, 10 * 60 * 1000)).unref?.();

interface ParsedToolCall {
    id: string;
    name: string;
    input: any;
}

function extractText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isArray(content))
        return content
            .map((part) => {
                if (_.isString(part)) return part;
                if (_.isObject(part)) {
                    const type = _.get(part, 'type');
                    if (type === 'tool_result') {
                        const toolContent = extractText(_.get(part, 'content'));
                        const toolUseId = _.get(part, 'tool_use_id') || 'unknown';
                        return `Tool result (${toolUseId}):\n${toolContent}`;
                    }
                    if (type === 'tool_use') {
                        const name = _.get(part, 'name') || 'unknown';
                        const input = JSON.stringify(_.get(part, 'input') || {});
                        return `Assistant requested tool ${name}: ${input}`;
                    }
                    return _.get(part, 'text') || '';
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    return '';
}

function buildToolsPrompt(tools: any[]) {
    if (!_.isArray(tools) || tools.length === 0) return '';
    const toolDescriptions = tools
        .map((tool) => {
            const name = _.get(tool, 'name');
            if (!name) return '';
            const description = _.get(tool, 'description') || '';
            const inputSchema = JSON.stringify(_.get(tool, 'input_schema') || _.get(tool, 'inputSchema') || {});
            return `- ${name}: ${description}\n  input_schema: ${inputSchema}`;
        })
        .filter(Boolean)
        .join('\n');

    if (!toolDescriptions) return '';
    return [
        'You have access to tools. When a tool is needed, do not describe the call in prose.',
        'Output exactly one or more tool calls in this format and nothing else:',
        '<tool_call name="ToolName">{"arg":"value"}</tool_call>',
        'The JSON inside the tag must match the tool input schema.',
        'Available tools:',
        toolDescriptions,
    ].join('\n');
}

function normalizeAnthropicMessages(messages: any[], system?: any, tools?: any[]) {
    const normalizedMessages: any[] = [];
    const systemText = [extractText(system), buildToolsPrompt(tools)].filter(Boolean).join('\n\n');

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

function stableStringify(value: any): string {
    if (_.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (_.isObject(value)) {
        const objectValue = value as Record<string, any>;
        return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashString(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function getSessionKey(model: string, system: any, messages: any[], tools: any[]) {
    const firstUserMessage = messages.find((message) => _.get(message, 'role') === 'user');
    const toolNames = _.isArray(tools) ? tools.map((tool) => _.get(tool, 'name')).filter(Boolean).sort() : [];
    return hashString(stableStringify({
        model,
        system: extractText(system).slice(0, 2000),
        firstUser: extractText(_.get(firstUserMessage, 'content')).slice(0, 2000),
        toolNames,
    }));
}

function getMessagesForDeepSeek(model: string, messages: any[], system: any, tools: any[], explicitConversationId?: string) {
    if (!ANTHROPIC_SESSION_REUSE || explicitConversationId)
        return {
            sessionKey: null,
            refConvId: explicitConversationId,
            messages: normalizeAnthropicMessages(messages, system, tools),
        };

    const sessionKey = getSessionKey(model, system, messages, tools);
    const cached = sessionMap.get(sessionKey);
    const canReuse = cached
        && messages.length > cached.messageCount
        && Date.now() - cached.updatedAt <= ANTHROPIC_SESSION_TTL;

    if (!canReuse) {
        sessionMap.delete(sessionKey);
        return {
            sessionKey,
            refConvId: undefined,
            messages: normalizeAnthropicMessages(messages, system, tools),
        };
    }

    return {
        sessionKey,
        refConvId: cached.conversationId,
        messages: normalizeAnthropicMessages([messages[messages.length - 1]], undefined, tools),
    };
}

function updateSession(sessionKey: string, conversationId: string, messageCount: number) {
    if (!ANTHROPIC_SESSION_REUSE || !sessionKey || !/[0-9a-z\-]{36}@[0-9]+/.test(conversationId)) return;
    sessionMap.set(sessionKey, {
        conversationId,
        messageCount,
        updatedAt: Date.now(),
    });
}

function findJsonEnd(text: string, startIndex: number) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') depth++;
        if (char === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
    }

    return -1;
}

function escapeControlCharsInJsonStrings(jsonText: string) {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let index = 0; index < jsonText.length; index++) {
        const char = jsonText[index];
        if (inString) {
            if (escaped) {
                if ('"\\/nrtu'.includes(char)) {
                    result += char;
                } else {
                    result += `\\${char}`;
                }
                escaped = false;
                continue;
            }
            if (char === '\\') {
                result += char;
                escaped = true;
                continue;
            }
            if (char === '"') {
                result += char;
                inString = false;
                continue;
            }
            if (char === '\n') {
                result += '\\n';
                continue;
            }
            if (char === '\r') {
                result += '\\r';
                continue;
            }
            if (char === '\t') {
                result += '\\t';
                continue;
            }
            result += char;
            continue;
        }

        result += char;
        if (char === '"') inString = true;
    }

    return result;
}

function parseToolInput(jsonText: string) {
    const strictInput = _.attempt(() => JSON.parse(jsonText));
    if (!_.isError(strictInput)) return strictInput;

    const repairedInput = _.attempt(() => JSON.parse(escapeControlCharsInJsonStrings(jsonText)));
    if (!_.isError(repairedInput)) return repairedInput;

    const singleStringField = jsonText.match(/^\s*\{\s*"([^"\\]+)"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
    if (singleStringField) {
        return {
            [singleStringField[1]]: singleStringField[2],
        };
    }

    return null;
}

function parseToolCalls(text: string) {
    const toolCalls: ParsedToolCall[] = [];
    const ranges: Array<[number, number]> = [];
    const pattern = /<?tool_call\s+name=["']([^"']+)["']\s*>/gi;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) != null) {
        const jsonStart = text.indexOf('{', pattern.lastIndex);
        if (jsonStart === -1) continue;
        const jsonEnd = findJsonEnd(text, jsonStart);
        if (jsonEnd === -1) continue;
        const input = parseToolInput(text.slice(jsonStart, jsonEnd));
        if (!input) continue;

        let end = jsonEnd;
        const closeTag = text.slice(jsonEnd).match(/^\s*<\/tool_call>/i);
        if (closeTag) end = jsonEnd + closeTag[0].length;

        toolCalls.push({
            id: `toolu_${util.uuid(false)}`,
            name: match[1],
            input,
        });
        ranges.push([match.index, end]);
    }

    const requestedToolPattern = /Assistant requested tool\s+([A-Za-z0-9_\-.]+)\s*:/gi;
    while ((match = requestedToolPattern.exec(text)) != null) {
        const jsonStart = text.indexOf('{', requestedToolPattern.lastIndex);
        if (jsonStart === -1) continue;
        const jsonEnd = findJsonEnd(text, jsonStart);
        if (jsonEnd === -1) continue;
        const input = parseToolInput(text.slice(jsonStart, jsonEnd));
        if (!input) continue;

        toolCalls.push({
            id: `toolu_${util.uuid(false)}`,
            name: match[1],
            input,
        });
        ranges.push([match.index, jsonEnd]);
    }

    const functionCallPattern = /(?:^|\n)\s*([A-Za-z][A-Za-z0-9_\-.]*)\s*\(/g;
    while ((match = functionCallPattern.exec(text)) != null) {
        const jsonStart = text.indexOf('{', functionCallPattern.lastIndex);
        if (jsonStart === -1) continue;
        const prefixBetweenNameAndJson = text.slice(functionCallPattern.lastIndex, jsonStart).trim();
        if (prefixBetweenNameAndJson) continue;
        const jsonEnd = findJsonEnd(text, jsonStart);
        if (jsonEnd === -1) continue;
        const suffix = text.slice(jsonEnd).match(/^\s*\)/);
        if (!suffix) continue;
        const input = parseToolInput(text.slice(jsonStart, jsonEnd));
        if (!input) continue;

        toolCalls.push({
            id: `toolu_${util.uuid(false)}`,
            name: match[1],
            input,
        });
        ranges.push([match.index, jsonEnd + suffix[0].length]);
    }

    let cleanText = text;
    for (const [start, end] of ranges.slice().reverse())
        cleanText = cleanText.slice(0, start) + cleanText.slice(end);

    return { text: cleanText, toolCalls };
}

function toAnthropicContentBlocks(text: string) {
    const { text: cleanText, toolCalls } = parseToolCalls(text);
    const content: any[] = [];
    if (cleanText) content.push({ type: 'text', text: cleanText });
    for (const toolCall of toolCalls) {
        content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
        });
    }
    if (!content.length) content.push({ type: 'text', text });
    return { content, hasToolUse: toolCalls.length > 0 };
}

function toAnthropicPayload(chatResponse: any) {
    const text = _.get(chatResponse, 'choices[0].message.content') || '';
    const { content, hasToolUse } = toAnthropicContentBlocks(text);
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

function mayBecomeToolCallPrefix(text: string) {
    const trimmed = text.trimStart();
    if (!trimmed) return true;
    if ('<tool_call'.startsWith(trimmed)) return true;
    if ('Assistant requested tool'.startsWith(trimmed)) return true;
    if (/^<tool_call\b/i.test(trimmed)) return true;
    if (/^Assistant requested tool\b/.test(trimmed)) return true;

    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    if (/^[A-Za-z][A-Za-z0-9_\-.]*\s*\($/.test(firstLine)) return true;
    if (/^[A-Za-z][A-Za-z0-9_\-.]*$/.test(firstLine)) return true;

    return false;
}

function createAnthropicStream(chatStream: any, model: string, options: { deferOutput?: boolean, onConversationId?: (conversationId: string) => void } = {}) {
    const { deferOutput = false, onConversationId } = options;
    const messageId = `msg_${util.uuid(false)}`;
    const transStream = new PassThrough();
    let buffer = '';
    let outputText = '';
    let textBlockStarted = false;
    let textBlockIndex = 0;
    let deferredToolMode = false;
    let streamedTextLength = 0;

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
            usage: { input_tokens: 1, output_tokens: 0 },
        },
    });
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
        const delta = _.get(chunk, 'choices[0].delta.content') || '';
        if (!delta) return;
        outputText += delta;
        if (deferredToolMode || /<tool_call|Assistant requested tool|(?:^|\n)\s*[A-Za-z][A-Za-z0-9_\-.]*\s*\(/.test(outputText.slice(streamedTextLength))) {
            deferredToolMode = true;
            return;
        }
        if (deferOutput && streamedTextLength === 0 && mayBecomeToolCallPrefix(outputText)) return;
        if (!textBlockStarted) {
            writeEvent('content_block_start', {
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: { type: 'text', text: '' },
            });
            textBlockStarted = true;
        }
        const textDelta = outputText.slice(streamedTextLength);
        if (!textDelta) return;
        writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: textDelta },
        });
        streamedTextLength = outputText.length;
    };

    const writeContentBlock = (block: any, blockIndex: number) => {
        if (block.type === 'tool_use') {
            const index = textBlockStarted ? blockIndex + 1 : blockIndex;
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

        writeEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
        });
        writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: block.text || '' },
        });
        writeEvent('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex,
            content_block: { type: 'text', text: block.text || '' },
        });
    };

    chatStream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(processLine);
    });
    chatStream.once('error', (err: Error) => transStream.destroy(err));
    chatStream.once('close', () => {
        if (buffer) processLine(buffer);
        const { content, hasToolUse } = toAnthropicContentBlocks(outputText);
        if (textBlockStarted)
            writeEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
        content.forEach(writeContentBlock);
        writeEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
        });
        writeEvent('message_stop', {
            type: 'message_stop',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content,
                stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            },
        });
        transStream.end();
    });

    return transStream;
}

async function handleMessages(request: Request) {
    if (DEEP_SEEK_CHAT_AUTHORIZATION) {
        request.headers.authorization = 'Bearer ' + DEEP_SEEK_CHAT_AUTHORIZATION;
    }

    request
        .validate('body.model', _.isString)
        .validate('body.messages', _.isArray)
        .validate('headers.authorization', _.isString)

    const tokens = chat.tokenSplit(request.headers.authorization);
    const token = _.sample(tokens);
    const { model, messages, system, tools, stream, conversation_id } = request.body;
    const prepared = getMessagesForDeepSeek(model, messages, system, tools, conversation_id);

    if (!prepared.messages.length)
        throw new Error('Params body.messages invalid');

    if (stream) {
        const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, token, prepared.refConvId);
        return new Response(createAnthropicStream(chatStream, model, {
            deferOutput: true,
            onConversationId: (conversationId) => updateSession(prepared.sessionKey, conversationId, messages.length),
        }), {
            type: 'text/event-stream',
        });
    }

    const chatResponse = await chat.createCompletion(model.toLowerCase(), prepared.messages, token, prepared.refConvId);
    updateSession(prepared.sessionKey, chatResponse.id, messages.length);
    return toAnthropicPayload(chatResponse);
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
