import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import process from "process";


const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;
const CHAT_SESSION_REUSE = !['0', 'false', 'no', 'off'].includes(String(process.env.CHAT_SESSION_REUSE || 'true').toLowerCase());
const CHAT_SESSION_TTL = Number(process.env.CHAT_SESSION_TTL || 2 * 60 * 60 * 1000);

interface ChatSession {
    conversationId: string;
    messageCount: number;
    updatedAt: number;
}

const chatSessionMap = new Map<string, ChatSession>();

setInterval(() => {
    const now = Date.now();
    for (const [key, session] of chatSessionMap) {
        if (now - session.updatedAt > CHAT_SESSION_TTL)
            chatSessionMap.delete(key);
    }
}, Math.min(CHAT_SESSION_TTL, 10 * 60 * 1000)).unref?.();

function hashString(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function stableStringify(value: any): string {
    if (_.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (_.isObject(value)) {
        const objectValue = value as Record<string, any>;
        return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function extractMessageText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isArray(content))
        return content.map((part) => _.isString(part) ? part : _.get(part, 'text') || '').filter(Boolean).join('\n');
    return _.isNil(content) ? '' : String(content);
}

function getHeader(request: Request, name: string) {
    return _.get(request.headers, name.toLowerCase()) || _.get(request.headers, name);
}

function getClientIdentity(request: Request) {
    const explicitClientId = getHeader(request, 'x-client-id') || getHeader(request, 'x-newapi-user') || getHeader(request, 'x-newapi-token');
    const authorization = String(getHeader(request, 'authorization') || '');
    return String(explicitClientId || `auth_${hashString(authorization)}`);
}

function getExplicitSessionId(request: Request) {
    const sessionId = getHeader(request, 'x-session-id') || getHeader(request, 'x-newapi-session');
    return sessionId ? String(sessionId) : '';
}

function fingerprintMessages(messages: any[], count: number) {
    return hashString(stableStringify(messages.slice(0, count).map((message) => ({
        role: _.get(message, 'role') || 'user',
        content: extractMessageText(_.get(message, 'content')).slice(0, 1000),
    }))));
}

function getProgressiveKeys(request: Request, model: string, messages: any[]) {
    const clientId = getClientIdentity(request);
    const sessionId = getExplicitSessionId(request);
    const prefix = `chat:${clientId}:${model}`;
    if (sessionId) return { currentKey: `${prefix}:session:${sessionId}`, previousKeys: [] as string[] };

    const tempKey = `${prefix}:m1:${fingerprintMessages(messages, 1)}`;
    if (messages.length >= 5)
        return {
            currentKey: `${prefix}:m5:${fingerprintMessages(messages, 5)}`,
            previousKeys: [`${prefix}:m3:${fingerprintMessages(messages, 3)}`, tempKey],
        };
    if (messages.length >= 3)
        return {
            currentKey: `${prefix}:m3:${fingerprintMessages(messages, 3)}`,
            previousKeys: [tempKey],
        };
    return { currentKey: tempKey, previousKeys: [] as string[] };
}

function getChatSession(request: Request, model: string, messages: any[], explicitConversationId?: string) {
    if (!CHAT_SESSION_REUSE || explicitConversationId || !messages.length)
        return { sessionKey: null, refConvId: explicitConversationId };

    const { currentKey, previousKeys } = getProgressiveKeys(request, model, messages);
    let session = chatSessionMap.get(currentKey);
    if (!session) {
        const previousKey = previousKeys.find((key) => chatSessionMap.has(key));
        if (previousKey) {
            session = chatSessionMap.get(previousKey);
            if (session) {
                chatSessionMap.set(currentKey, { ...session, updatedAt: Date.now() });
                chatSessionMap.delete(previousKey);
            }
        }
    }

    const canReuse = session
        && messages.length > session.messageCount
        && Date.now() - session.updatedAt <= CHAT_SESSION_TTL;

    if (!canReuse) return { sessionKey: currentKey, refConvId: undefined };
    return { sessionKey: currentKey, refConvId: session.conversationId };
}

function updateChatSession(sessionKey: string, conversationId: string, messageCount: number) {
    if (!CHAT_SESSION_REUSE || !sessionKey || !conversationId || !/[0-9a-z\-]{36}@[0-9]+/.test(conversationId)) return;
    chatSessionMap.set(sessionKey, {
        conversationId,
        messageCount,
        updatedAt: Date.now(),
    });
}

function trackChatStream(source: any, sessionKey: string, messageCount: number) {
    const stream = new PassThrough();
    let buffer = '';

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const chunk = _.attempt(() => JSON.parse(data));
        if (_.isError(chunk)) return;
        const chunkId = _.get(chunk, 'id');
        if (_.isString(chunkId) && /[0-9a-z\-]{36}@[0-9]+/.test(chunkId))
            updateChatSession(sessionKey, chunkId, messageCount);
    };

    source.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stream.write(chunk);
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.forEach(processLine);
    });
    source.once('error', (err: Error) => stream.destroy(err));
    source.once('close', () => {
        if (buffer) processLine(buffer);
        stream.end();
    });

    return stream;
}

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            // 如果环境变量没有token则读取请求中的
            if (DEEP_SEEK_CHAT_AUTHORIZATION) {
                request.headers.authorization = "Bearer " + DEEP_SEEK_CHAT_AUTHORIZATION;
            }

            request
                .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)

            // token切分
            const tokens = chat.tokenSplit(request.headers.authorization);
            // 随机挑选一个token
            const token = _.sample(tokens);
            let { model, conversation_id: convId, messages, stream } = request.body;
            model = model.toLowerCase();
            const prepared = getChatSession(request, model, messages, convId);
            convId = prepared.refConvId;
            if (stream) {
                const source = await chat.createCompletionStream(model, messages, token, convId);
                return new Response(trackChatStream(source, prepared.sessionKey, messages.length), {
                    type: "text/event-stream"
                });
            }
            else {
                const chatResponse = await chat.createCompletion(model, messages, token, convId);
                updateChatSession(prepared.sessionKey, chatResponse.id, messages.length);
                return chatResponse;
            }
        }

    }

}
