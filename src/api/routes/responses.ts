import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';

const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;
const RESPONSES_SESSION_REUSE = !['0', 'false', 'no', 'off'].includes(String(process.env.RESPONSES_SESSION_REUSE || 'true').toLowerCase());
const RESPONSES_SESSION_TTL = Number(process.env.RESPONSES_SESSION_TTL || 2 * 60 * 60 * 1000);

interface ResponsesSession {
    conversationId: string;
    messageCount: number;
    updatedAt: number;
}

const responseSessionMap = new Map<string, ResponsesSession>();

setInterval(() => {
    const now = Date.now();
    for (const [key, session] of responseSessionMap) {
        if (now - session.updatedAt > RESPONSES_SESSION_TTL)
            responseSessionMap.delete(key);
    }
}, Math.min(RESPONSES_SESSION_TTL, 10 * 60 * 1000)).unref?.();

function updateResponseHistorySession(sessionKey: string, conversationId: string, messageCount: number) {
    if (!RESPONSES_SESSION_REUSE || !sessionKey || !conversationId || !/[0-9a-z\-]{36}@[0-9]+/.test(conversationId)) return;
    const existing = responseSessionMap.get(sessionKey);
    if (existing?.conversationId === conversationId && existing.messageCount === messageCount) {
        existing.updatedAt = Date.now();
        return;
    }
    responseSessionMap.set(sessionKey, {
        conversationId,
        messageCount,
        updatedAt: Date.now(),
    });
    logger.info(`[RESPONSES SESSION] set history ${sessionKey} -> ${conversationId} (${messageCount})`);
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

function extractText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isArray(content))
        return content
            .map((part) => {
                if (_.isString(part)) return part;
                if (_.isObject(part)) {
                    const type = _.get(part, 'type');
                    if (type === 'function_call_output') {
                        const callId = _.get(part, 'call_id') || 'unknown';
                        return `Tool result (${callId}):\n${_.get(part, 'output') || ''}`;
                    }
                    if (type === 'function_call') {
                        const name = _.get(part, 'name') || 'unknown';
                        return `Assistant requested tool ${name}: ${_.get(part, 'arguments') || '{}'}`;
                    }
                    return _.get(part, 'text') || _.get(part, 'input_text') || '';
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    return '';
}

function normalizeInputToMessages(input: any, instructions?: string): any[] {
    const messages: any[] = [];
    if (_.isString(instructions) && instructions.trim())
        messages.push({ role: 'system', content: instructions });

    if (_.isString(input)) {
        messages.push({ role: 'user', content: input });
        return messages;
    }

    if (_.isArray(input)) {
        for (const item of input) {
            if (_.isString(item)) {
                messages.push({ role: 'user', content: item });
                continue;
            }
            if (!_.isObject(item)) continue;
            const itemType = _.get(item, 'type');
            if (itemType === 'function_call_output') {
                const content = extractText(item);
                if (content) messages.push({ role: 'user', content });
                continue;
            }
            const role = _.get(item, 'role') || 'user';
            const content = extractText(_.get(item, 'content')) || extractText(item);
            if (content) messages.push({ role, content });
        }
    }

    return messages;
}

function getResponsesSessionKey(model: string, instructions: any, messages: any[]) {
    const firstUserMessage = messages.find((message) => _.get(message, 'role') === 'user');
    return hashString(stableStringify({
        model,
        instructions: extractText(instructions).slice(0, 2000),
        firstUser: extractText(_.get(firstUserMessage, 'content')).slice(0, 2000),
    }));
}

function getMessagesForDeepSeek(model: string, input: any, instructions: any, explicitConversationId?: string) {
    const messages = normalizeInputToMessages(input, instructions);
    if (!RESPONSES_SESSION_REUSE || explicitConversationId)
        return {
            sessionKey: null,
            refConvId: explicitConversationId,
            messages,
        };

    const sessionKey = getResponsesSessionKey(model, instructions, messages);
    const cached = responseSessionMap.get(sessionKey);
    const canReuse = cached
        && messages.length > cached.messageCount
        && Date.now() - cached.updatedAt <= RESPONSES_SESSION_TTL;

    if (!canReuse) {
        responseSessionMap.delete(sessionKey);
        return {
            sessionKey,
            refConvId: undefined,
            messages,
        };
    }

    logger.info(`[RESPONSES SESSION] hit history ${sessionKey} -> ${cached.conversationId}`);
    return {
        sessionKey,
        refConvId: cached.conversationId,
        messages: [messages[messages.length - 1]],
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

function decodeXmlText(value: string) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function parseDsmlToolCalls(text: string) {
    if (!text.includes('｜DSML｜tool_calls')) return [];
    const calls: Array<{ id: string, call_id: string, name: string, arguments: string }> = [];
    const invokePattern = /<?｜DSML｜invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜DSML｜invoke>/g;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokePattern.exec(text)) != null) {
        const args: Record<string, any> = {};
        const body = invokeMatch[2];
        const parameterPattern = /<?｜DSML｜parameter\s+name="([^"]+)"(?:\s+string="true")?\s*>([\s\S]*?)<\/｜DSML｜parameter>/g;
        let parameterMatch: RegExpExecArray | null;

        while ((parameterMatch = parameterPattern.exec(body)) != null) {
            args[parameterMatch[1]] = decodeXmlText(parameterMatch[2].trim());
        }

        calls.push({
            id: `fc_${util.uuid(false)}`,
            call_id: `call_${util.uuid(false)}`,
            name: invokeMatch[1],
            arguments: JSON.stringify(args),
        });
    }

    return calls;
}

function getDsmlStartIndex(text: string) {
    const withOpen = text.indexOf('<｜DSML｜tool_calls>');
    const withoutOpen = text.indexOf('｜DSML｜tool_calls>');
    if (withOpen === -1) return withoutOpen;
    if (withoutOpen === -1) return withOpen;
    return Math.min(withOpen, withoutOpen);
}

function getTextBeforeDsml(text: string) {
    const dsmlStartIndex = getDsmlStartIndex(text);
    return dsmlStartIndex === -1 ? text : text.slice(0, dsmlStartIndex);
}

function mayBecomeDsmlToolCallPrefix(text: string) {
    const trimmed = text.trimStart();
    if (!trimmed) return true;
    return '<｜DSML｜tool_calls>'.startsWith(trimmed) || '｜DSML｜tool_calls>'.startsWith(trimmed);
}

function toResponsesPayload(chatResponse: any) {
    const message = _.get(chatResponse, 'choices[0].message', {});
    const content = message.content || '';
    const reasoningContent = message.reasoning_content || '';
    const created = chatResponse.created || util.unixTimestamp();
    const toolCalls = parseDsmlToolCalls(content);
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
        output,
        output_text: toolCalls.length ? '' : content,
        usage: toResponsesUsage(chatResponse.usage),
    };
}

function createResponsesStream(chatStream: any, model: string, options: { onConversationId?: (responseId: string, conversationId: string) => void } = {}) {
    const { onConversationId } = options;
    const responseId = `resp_${util.uuid(false)}`;
    const itemId = `msg_${util.uuid(false)}`;
    const created = util.unixTimestamp();
    const transStream = new PassThrough();
    let buffer = '';
    let outputText = '';
    let streamedTextLength = 0;
    let messageStarted = false;

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
        if (_.isString(chunkId) && /[0-9a-z\-]{36}@[0-9]+/.test(chunkId)) {
            onConversationId?.(responseId, chunkId);
            onConversationId?.(itemId, chunkId);
        }
        const delta = _.get(chunk, 'choices[0].delta.content') || '';
        if (!delta) return;
        outputText += delta;
        if (streamedTextLength === 0 && mayBecomeDsmlToolCallPrefix(outputText)) return;
        const textEnd = getDsmlStartIndex(outputText);
        const streamableText = textEnd === -1 ? outputText : outputText.slice(0, textEnd);
        const textDelta = streamableText.slice(streamedTextLength);
        writeTextDelta(textDelta);
        streamedTextLength = streamableText.length;
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
        const toolCalls = parseDsmlToolCalls(outputText);
        const output: any[] = [];
        const visibleText = getTextBeforeDsml(outputText);

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
                output,
                output_text: toolCalls.length ? visibleText : outputText,
                usage: toResponsesUsage(),
            },
        });
        transStream.end();
    });

    return transStream;
}

export default {

    prefix: '/v1',

    post: {

        '/responses': async (request: Request) => {
            if (DEEP_SEEK_CHAT_AUTHORIZATION) {
                request.headers.authorization = 'Bearer ' + DEEP_SEEK_CHAT_AUTHORIZATION;
            }

            request
                .validate('body.model', _.isString)
                .validate('headers.authorization', _.isString)

            const tokens = chat.tokenSplit(request.headers.authorization);
            const token = _.sample(tokens);
            const { model, input, instructions, stream } = request.body;
            const prepared = getMessagesForDeepSeek(model, input, instructions);

            if (!prepared.messages.length)
                throw new Error('Params body.input invalid');

            if (stream) {
                const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, token, prepared.refConvId);
                return new Response(createResponsesStream(chatStream, model, {
                    onConversationId: (responseId, conversationId) => {
                        updateResponseHistorySession(prepared.sessionKey, conversationId, normalizeInputToMessages(input, instructions).length);
                    },
                }), {
                    type: 'text/event-stream',
                });
            }

            const chatResponse = await chat.createCompletion(model.toLowerCase(), prepared.messages, token, prepared.refConvId);
            const responsePayload = toResponsesPayload(chatResponse);
            updateResponseHistorySession(prepared.sessionKey, chatResponse.id, normalizeInputToMessages(input, instructions).length);
            return responsePayload;
        }

    }

}
