import path from 'path';
import { PassThrough } from 'stream';

import _ from 'lodash';
import fs from 'fs-extra';

import config from '@/lib/config.ts';
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

const AUDIT_SUBDIR = 'audit';
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|api[-_]?key|token)/i;

export interface AuditContext {
    requestId: string;
    endpoint: string;
    route: string;
    model?: string;
    stream?: boolean;
    filePath: string;
}

function normalizeName(value: string) {
    return String(value || 'request')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase() || 'request';
}

function ensureAuditDir() {
    const dirPath = path.join(config.system.logDirPath, AUDIT_SUBDIR, util.getDateString());
    fs.ensureDirSync(dirPath);
    return dirPath;
}

function maskSecret(value: any) {
    const text = String(value || '');
    if (!text) return text;
    if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-1)}`;
    return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function extractPreviewText(value: any): string {
    if (_.isNil(value)) return '';
    if (_.isString(value)) return value.slice(0, 200);
    if (_.isArray(value)) return value.map((item) => extractPreviewText(item)).filter(Boolean).join('\n').slice(0, 200);
    if (_.isPlainObject(value)) {
        if (_.isString(_.get(value, 'text'))) return String(_.get(value, 'text')).slice(0, 200);
        if (_.has(value, 'content')) return extractPreviewText(_.get(value, 'content')).slice(0, 200);
        const serialized = _.attempt(() => JSON.stringify(value));
        return _.isError(serialized) ? '[object]' : String(serialized).slice(0, 200);
    }
    return String(value).slice(0, 200);
}

function safeSerialize(value: any, depth = 0, seen = new WeakSet<object>()): any {
    if (depth > 8) return '[MaxDepth]';
    if (_.isNil(value) || _.isBoolean(value) || _.isNumber(value)) return value;
    if (_.isString(value)) return value;
    if (typeof value === 'bigint') return value.toString();
    if (_.isDate(value)) return value.toISOString();
    if (_.isError(value)) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    if (Buffer.isBuffer(value)) {
        return {
            type: 'Buffer',
            byteLength: value.length,
            utf8: value.toString('utf8'),
        };
    }
    if (util.isReadStream(value) || util.isWriteStream(value)) {
        return {
            type: 'Stream',
            constructor: value?.constructor?.name || 'unknown',
        };
    }
    if (_.isArray(value)) return value.map((item) => safeSerialize(item, depth + 1, seen));
    if (_.isObject(value)) {
        const objectValue = value as Record<string, any>;
        if (seen.has(objectValue)) return '[Circular]';
        seen.add(objectValue);
        const result: Record<string, any> = {};
        for (const [key, item] of Object.entries(objectValue)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                result[key] = _.isString(item) ? maskSecret(item) : '[REDACTED]';
                continue;
            }
            result[key] = safeSerialize(item, depth + 1, seen);
        }
        seen.delete(objectValue);
        return result;
    }
    return String(value);
}

export function summarizeMessages(messages: any[]) {
    return (_.isArray(messages) ? messages : []).map((message, index) => ({
        index,
        role: _.get(message, 'role') || 'unknown',
        contentType: _.isArray(_.get(message, 'content')) ? 'array' : typeof _.get(message, 'content'),
        preview: extractPreviewText(_.get(message, 'content')),
    }));
}

export function sanitizeHeaders(headers: any) {
    return safeSerialize(headers || {});
}

export function serializeError(error: any) {
    return safeSerialize({
        name: _.get(error, 'name') || 'Error',
        message: _.get(error, 'message') || String(error || ''),
        stack: _.get(error, 'stack'),
        status: _.get(error, 'status') || _.get(error, 'response.status'),
        code: _.get(error, 'code') || _.get(error, 'response.data.code'),
        data: _.get(error, 'data') || _.get(error, 'response.data'),
    });
}

export function createAuditContext(options: { endpoint: string, route: string, model?: string, stream?: boolean }) {
    const dirPath = ensureAuditDir();
    const requestId = `${normalizeName(options.endpoint)}_${util.getDateString('yyyyMMdd_HHmmss_SSS')}_${util.uuid(false).slice(0, 8)}`;
    const filePath = path.join(dirPath, `${requestId}.jsonl`);
    const context: AuditContext = {
        requestId,
        endpoint: options.endpoint,
        route: options.route,
        model: options.model,
        stream: options.stream,
        filePath,
    };

    appendAuditEvent(context, 'audit.open', {
        endpoint: options.endpoint,
        route: options.route,
        model: options.model,
        stream: options.stream,
        filePath,
    });
    logger.info(`[AUDIT] ${requestId} -> ${path.relative(path.resolve(), filePath)}`);
    return context;
}

export function appendAuditEvent(context: AuditContext | null | undefined, stage: string, payload?: any) {
    if (!context) return;
    try {
        fs.appendFileSync(context.filePath, `${JSON.stringify({
            time: new Date().toISOString(),
            requestId: context.requestId,
            endpoint: context.endpoint,
            route: context.route,
            model: context.model,
            stream: context.stream === true,
            stage,
            payload: safeSerialize(payload),
        })}\n`);
    } catch (error: any) {
        logger.error(`[AUDIT] write failed: ${error.message}`);
    }
}

export function tapStreamForAudit(source: any, context: AuditContext | null | undefined, stage: string, buildPayload?: (streamText: string) => any) {
    if (!context) return source;

    const output = new PassThrough();
    const buffers: Buffer[] = [];
    let finalized = false;

    const finalize = (state: string) => {
        if (finalized) return;
        finalized = true;
        const streamText = Buffer.concat(buffers).toString('utf8');
        appendAuditEvent(context, stage, {
            state,
            byteLength: Buffer.byteLength(streamText),
            streamText,
            ...(buildPayload ? buildPayload(streamText) : {}),
        });
        if (!output.writableEnded) output.end();
    };

    source.on('data', (chunk: any) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        buffers.push(buffer);
        output.write(buffer);
    });
    source.once('error', (error: Error) => {
        appendAuditEvent(context, `${stage}.error`, { error: serializeError(error) });
        finalize('error');
    });
    source.once('end', () => finalize('end'));
    source.once('close', () => finalize('close'));

    return output;
}