import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';

const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;

function extractText(content: any): string {
    if (_.isString(content)) return content;
    if (_.isArray(content))
        return content
            .map((part) => {
                if (_.isString(part)) return part;
                if (_.isObject(part))
                    return _.get(part, 'text') || _.get(part, 'input_text') || '';
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
            const role = _.get(item, 'role') || 'user';
            const content = extractText(_.get(item, 'content')) || extractText(item);
            if (content) messages.push({ role, content });
        }
    }

    return messages;
}

function toResponsesPayload(chatResponse: any) {
    const message = _.get(chatResponse, 'choices[0].message', {});
    const content = message.content || '';
    const reasoningContent = message.reasoning_content || '';
    const created = chatResponse.created || util.unixTimestamp();
    const output: any[] = [];

    if (reasoningContent)
        output.push({
            id: `rs_${chatResponse.id}`,
            type: 'reasoning',
            status: 'completed',
            summary: [],
            content: reasoningContent,
        });

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

    return {
        id: chatResponse.id,
        object: 'response',
        created_at: created,
        status: 'completed',
        model: chatResponse.model,
        output,
        output_text: content,
        usage: chatResponse.usage,
    };
}

function createResponsesStream(chatStream: any, model: string) {
    const responseId = `resp_${util.uuid(false)}`;
    const itemId = `msg_${util.uuid(false)}`;
    const created = util.unixTimestamp();
    const transStream = new PassThrough();
    let buffer = '';
    let outputText = '';

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

    const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const chunk = _.attempt(() => JSON.parse(data));
        if (_.isError(chunk)) return;
        const delta = _.get(chunk, 'choices[0].delta.content') || '';
        if (!delta) return;
        outputText += delta;
        writeEvent('response.output_text.delta', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta,
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
        writeEvent('response.output_text.done', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            text: outputText,
        });
        writeEvent('response.content_part.done', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: outputText, annotations: [] },
        });
        writeEvent('response.output_item.done', {
            output_index: 0,
            item: {
                id: itemId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: outputText, annotations: [] }],
            },
        });
        writeEvent('response.completed', {
            response: {
                id: responseId,
                object: 'response',
                created_at: created,
                status: 'completed',
                model,
                output: [{
                    id: itemId,
                    type: 'message',
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: outputText, annotations: [] }],
                }],
                output_text: outputText,
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
            const { model, input, instructions, stream, previous_response_id } = request.body;
            const messages = normalizeInputToMessages(input, instructions);

            if (!messages.length)
                throw new Error('Params body.input invalid');

            if (stream) {
                const chatStream = await chat.createCompletionStream(model.toLowerCase(), messages, token, previous_response_id);
                return new Response(createResponsesStream(chatStream, model), {
                    type: 'text/event-stream',
                });
            }

            const chatResponse = await chat.createCompletion(model.toLowerCase(), messages, token, previous_response_id);
            return toResponsesPayload(chatResponse);
        }

    }

}
