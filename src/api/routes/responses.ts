import { PassThrough } from 'stream';
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import util from '@/lib/util.ts';
import logger from '@/lib/logger.ts';
import { calculateTokens, calculateMessagesTokens } from "@/lib/token.ts";

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

function stringifyToolOutput(output: any): string {
    if (_.isString(output)) return output;
    if (_.isNil(output)) return '';
    return _.attempt(() => JSON.stringify(output)) as string || String(output);
}

function extractObjectText(part: any): string {
    const type = _.get(part, 'type');
    if (type === 'function_call_output') {
        const callId = _.get(part, 'call_id') || 'unknown';
        return `Tool result (${callId}):\n${stringifyToolOutput(_.get(part, 'output'))}`;
    }
    if (type === 'function_call') {
        const name = _.get(part, 'name') || 'unknown';
        return `Assistant requested tool ${name}: ${_.get(part, 'arguments') || '{}'}`;
    }
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

function getToolName(tool: any) {
    return _.get(tool, 'name') || _.get(tool, 'function.name');
}

function getToolDescription(tool: any) {
    return _.get(tool, 'description') || _.get(tool, 'function.description') || '';
}

function getToolInputSchema(tool: any) {
    return _.get(tool, 'parameters') || _.get(tool, 'function.parameters') || _.get(tool, 'input_schema') || _.get(tool, 'inputSchema') || {};
}

function buildResponsesToolsPrompt(tools: any[]) {
    if (!_.isArray(tools) || tools.length === 0) return '';
    const toolDescriptions = tools
        .map((tool) => {
            const name = getToolName(tool);
            if (!name) return '';
            const description = getToolDescription(tool);
            const inputSchema = JSON.stringify(getToolInputSchema(tool));
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
    return hashString(stableStringify(messages
        .filter((message) => _.get(message, 'role') !== 'system')
        .slice(0, count)
        .map((message) => ({
            role: _.get(message, 'role') || 'user',
            content: extractText(_.get(message, 'content')).slice(0, 1000),
        }))));
}

function getProgressiveSessionKeys(request: Request, endpoint: string, model: string, messages: any[]) {
    const clientId = getClientIdentity(request);
    const sessionId = getExplicitSessionId(request);
    const prefix = `${endpoint}:${clientId}:${model}`;
    if (sessionId) return { currentKey: `${prefix}:session:${sessionId}`, previousKeys: [] as string[] };

    const historyMessages = messages.filter((message) => _.get(message, 'role') !== 'system');
    const tempKey = `${prefix}:m1:${fingerprintMessages(historyMessages, 1)}`;
    if (historyMessages.length >= 5)
        return {
            currentKey: `${prefix}:m5:${fingerprintMessages(historyMessages, 5)}`,
            previousKeys: [`${prefix}:m3:${fingerprintMessages(historyMessages, 3)}`, tempKey],
        };
    if (historyMessages.length >= 3)
        return {
            currentKey: `${prefix}:m3:${fingerprintMessages(historyMessages, 3)}`,
            previousKeys: [tempKey],
        };
    return { currentKey: tempKey, previousKeys: [] as string[] };
}

function getProgressiveCachedSession(
    sessionMap: Map<string, ResponsesSession>,
    currentKey: string,
    previousKeys: string[],
    ttl: number,
) {
    let session = sessionMap.get(currentKey);
    if (!session) {
        const previousKey = previousKeys.find((key) => sessionMap.has(key));
        if (previousKey) {
            session = sessionMap.get(previousKey);
            if (session) {
                sessionMap.set(currentKey, { ...session, updatedAt: Date.now() });
                sessionMap.delete(previousKey);
            }
        }
    }
    if (!session || Date.now() - session.updatedAt > ttl) return null;
    return session;
}

function getMessagesForDeepSeek(request: Request, model: string, input: any, instructions: any, tools: any[] = [], explicitConversationId?: string) {
    const messages = normalizeInputToMessages(input, instructions, tools);
    if (!RESPONSES_SESSION_REUSE || explicitConversationId)
        return {
            sessionKey: null,
            refConvId: explicitConversationId,
            messages: explicitConversationId ? getLatestActionMessages(messages) : messages,
        };

    const { currentKey: sessionKey, previousKeys } = getProgressiveSessionKeys(request, 'responses', model, messages);
    const cached = getProgressiveCachedSession(responseSessionMap, sessionKey, previousKeys, RESPONSES_SESSION_TTL);
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

    logger.info(`[RESPONSES SESSION] hit history ${sessionKey} -> ${cached.conversationId}`);
    return {
        sessionKey,
        refConvId: cached.conversationId,
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

function decodeXmlText(value: string) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

type ResponsesToolCall = { id: string, call_id: string, name: string, arguments: string };
type ToolNameResolver = (name: string, args?: Record<string, any>) => { name: string, args: Record<string, any> };
const TOOL_START_MARKERS = ['<tool_call', '<｜DSML｜tool_calls>', '｜DSML｜tool_calls>', '<bash>', '<bash ', '<bash_notool>', '<bash-command', '<bash-tool-usage>', '<bash_script', '<command-line', '<tool_calls>', '<function_calls>', '<function '];
const ASSISTANT_MARKER_PATTERN = /(?:^|\n)\s*<｜Assistant｜>\s*/g;

function isInsideMarkdownFence(text: string, index: number) {
    const before = text.slice(0, index);
    const fences = before.match(/^\s*```/gm);
    return Boolean(fences && fences.length % 2 === 1);
}

function findLineStartTag(text: string, pattern: RegExp) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) != null) {
        if (!isInsideMarkdownFence(text, match.index)) return match.index;
    }
    return -1;
}

function parseBashArgs(value: string): string | string[] {
    const argPattern = /<arg>\s*([\s\S]*?)\s*<\/arg>/g;
    const args: string[] = [];
    let argMatch: RegExpExecArray | null;

    while ((argMatch = argPattern.exec(value)) != null) {
        const decoded = decodeXmlText(argMatch[1].trim());
        const parsed = _.attempt(() => JSON.parse(decoded));
        if (_.isArray(parsed)) args.push(...parsed.map(String));
        else if (decoded) args.push(decoded);
    }

    if (args.length) return args;
    const decoded = decodeXmlText(value.trim());
    const parsed = _.attempt(() => JSON.parse(decoded));
    if (_.isArray(parsed)) return parsed.map(String);
    return decoded;
}

function createToolCall(name: string, args: Record<string, any>, resolveToolName: ToolNameResolver): ResponsesToolCall {
    const resolved = resolveToolName(name, args);
    return {
        id: `fc_${util.uuid(false)}`,
        call_id: `call_${util.uuid(false)}`,
        name: resolved.name,
        arguments: JSON.stringify(resolved.args),
    };
}

function parseToolInput(jsonText: string) {
    const parsed = _.attempt(() => JSON.parse(decodeXmlText(jsonText.trim())));
    return _.isError(parsed) || !_.isObject(parsed) ? null : parsed as Record<string, any>;
}

function parseStandardToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const toolCallPattern = /^\s*<?tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gmi;
    let match: RegExpExecArray | null;

    while ((match = toolCallPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const input = parseToolInput(match[2]);
        if (!input) continue;
        calls.push(createToolCall(match[1], input, resolveToolName));
    }

    return calls;
}

function parseDsmlToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
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

        calls.push(createToolCall(invokeMatch[1], args, resolveToolName));
    }

    return calls;
}

function parseBashToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const bashPattern = /^\s*<bash(?:\s+[^>]*)?>\s*\r?\n?([\s\S]*?)\r?\n?\s*<\/bash>/gm;
    let match: RegExpExecArray | null;

    while ((match = bashPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const command = parseBashArgs(match[1]);
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName));
    }

    return calls;
}

function parseBashNoToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const bashNoToolPattern = /^\s*<bash_notool>\s*\r?\n?([\s\S]*?)\r?\n?\s*<\/bash_notool>/gm;
    let match: RegExpExecArray | null;

    while ((match = bashNoToolPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const command = parseBashArgs(match[1]);
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName));
    }

    return calls;
}

function parseBashCommandToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const bashCommandPattern = /^\s*<bash-command(?:\s+[^>]*)?>\s*\r?\n?([\s\S]*?)\r?\n?\s*<\/bash-command>/gm;
    let match: RegExpExecArray | null;

    while ((match = bashCommandPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const command = parseBashArgs(match[1]);
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName));
    }

    return calls;
}

function parseCommandLineToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const commandLinePattern = /^\s*<command-line(?:\s+[^>]*)?>\s*\r?\n?([\s\S]*?)\r?\n?\s*<\/command-line>/gm;
    let match: RegExpExecArray | null;

    while ((match = commandLinePattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const command = parseBashArgs(match[1]);
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName));
    }

    return calls;
}

function parseBashToolUsageCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const bashToolUsagePattern = /^\s*<bash-tool-usage>\s*\r?\n?([\s\S]*?)\r?\n?\s*<\/bash-tool-usage>/gm;
    let match: RegExpExecArray | null;

    while ((match = bashToolUsagePattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const command = parseBashArgs(match[1]);
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName));
    }

    return calls;
}

function parseBashScriptCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const bashScriptPattern = /^\s*<bash_script(?:\s+[^>]*)?>([\s\S]*?)<\/bash_script>/gm;
    let match: RegExpExecArray | null;

    while ((match = bashScriptPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, match.index)) continue;
        const body = match[1];
        const value = body.match(/<value>\s*([\s\S]*?)\s*<\/value>/)?.[1];
        const invocation = body.match(/<invocation>\s*([\s\S]*?)\s*<\/invocation>/)?.[1];
        const command = decodeXmlText((value || invocation || '').trim());
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName));
    }

    return calls;
}

function getAvailableToolNames(tools: any[]) {
    if (!_.isArray(tools)) return [];
    return tools
        .map((tool) => _.get(tool, 'name') || _.get(tool, 'function.name'))
        .filter(_.isString);
}

function getToolByName(tools: any[], name: string) {
    return (_.isArray(tools) ? tools : []).find((tool) => (_.get(tool, 'name') || _.get(tool, 'function.name')) === name);
}

function getToolParameters(tool: any) {
    return _.get(tool, 'parameters') || _.get(tool, 'function.parameters') || {};
}

function firstParameterName(parameters: any) {
    return Object.keys(_.get(parameters, 'properties') || {})[0];
}

function shellCommandToArgs(command: any): string[] {
    if (_.isArray(command)) return command.map(String);
    const commandText = String(command || '').trim();
    if (!commandText) return [];
    return process.platform === 'win32' ? ['powershell.exe', '-Command', commandText] : ['/bin/sh', '-c', commandText];
}

function adaptToolArgs(tool: any, args: Record<string, any>) {
    const parameters = getToolParameters(tool);
    const properties = _.get(parameters, 'properties') || {};
    const parameterName = firstParameterName(parameters);
    if (!parameterName) return args;

    const command = args.command ?? args.cmd ?? args.path;
    if (_.get(properties, `${parameterName}.type`) === 'array')
        return { [parameterName]: shellCommandToArgs(command) };
    if (parameterName !== 'command' && command != null)
        return { [parameterName]: _.isArray(command) ? command.join(' ') : String(command) };
    return args;
}

function createToolNameResolver(tools: any[] = []): ToolNameResolver {
    const toolNames = getAvailableToolNames(tools);
    const hasTool = (name: string) => toolNames.includes(name);
    const shellTool = ['shell', 'bash', 'run_shell_command', 'powershell', 'run_shell'].find(hasTool) || 'shell';

    return (name: string, args: Record<string, any> = {}) => {
        if (hasTool(name)) return { name, args: adaptToolArgs(getToolByName(tools, name), args) };
        if (['run_shell_command', 'run_shell', 'shell', 'bash', 'powershell'].includes(name))
            return { name: shellTool, args: adaptToolArgs(getToolByName(tools, shellTool), args) };
        if (name === 'read_file') {
            const path = args.path || args.file || args.filename;
            if (hasTool('read_file')) return { name: 'read_file', args };
            return {
                name: shellTool,
                args: adaptToolArgs(getToolByName(tools, shellTool), { command: `Get-Content -LiteralPath ${JSON.stringify(path || '')}` }),
            };
        }
        if (name === 'apply_patch' && hasTool('apply_patch')) return { name: 'apply_patch', args };
        return { name, args };
    };
}

const PARAMETER_PATTERN = /<parameter\s+name="([^"]+)"(?:\s+[^>]*)?>([\s\S]*?)<\/parameter>/g;

function parseGenericXmlToolCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    if (!text.includes('<tool_calls>')) return [];
    const calls: ResponsesToolCall[] = [];
    const toolCallPattern = /^\s*<tool_calls>[\s\S]*?<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>[\s\S]*?<\/tool_calls>/gm;
    let toolCallMatch: RegExpExecArray | null;

    while ((toolCallMatch = toolCallPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, toolCallMatch.index)) continue;
        const args: Record<string, any> = {};
        const body = toolCallMatch[2];
        const parameterPattern = new RegExp(PARAMETER_PATTERN);
        let parameterMatch: RegExpExecArray | null;

        while ((parameterMatch = parameterPattern.exec(body)) != null) {
            args[parameterMatch[1]] = decodeXmlText(parameterMatch[2].trim());
        }

        calls.push(createToolCall(toolCallMatch[1], args, resolveToolName));
    }

    return calls;
}

function parseFunctionCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    if (!text.includes('<function_calls>')) return [];
    const calls: ResponsesToolCall[] = [];
    const invokePattern = /^\s*<function_calls>[\s\S]*?<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>[\s\S]*?<\/function_calls>/gm;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokePattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, invokeMatch.index)) continue;
        const args: Record<string, any> = {};
        const body = invokeMatch[2];
        const parameterPattern = new RegExp(PARAMETER_PATTERN);
        let parameterMatch: RegExpExecArray | null;

        while ((parameterMatch = parameterPattern.exec(body)) != null) {
            args[parameterMatch[1]] = decodeXmlText(parameterMatch[2].trim());
        }

        calls.push(createToolCall(invokeMatch[1], args, resolveToolName));
    }

    return calls;
}

function parseBareFunctionCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const functionPattern = /^\s*<function\s+name="([^"]+)"\s*>([\s\S]*?)<\/function>/gm;
    let functionMatch: RegExpExecArray | null;

    while ((functionMatch = functionPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, functionMatch.index)) continue;
        const args: Record<string, any> = {};
        const body = functionMatch[2];
        const parameterPattern = new RegExp(PARAMETER_PATTERN);
        let parameterMatch: RegExpExecArray | null;

        while ((parameterMatch = parameterPattern.exec(body)) != null) {
            args[parameterMatch[1]] = decodeXmlText(parameterMatch[2].trim());
        }

        calls.push(createToolCall(functionMatch[1], args, resolveToolName));
    }

    return calls;
}

function findJsonObjectEnd(text: string, start: number) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') depth++;
        if (char === '}') {
            depth--;
            if (depth === 0) return index + 1;
        }
    }
    return -1;
}

function parseFunctionArgs(value: string) {
    const decoded = decodeXmlText(value.trim());
    const direct = _.attempt(() => JSON.parse(decoded));
    if (!_.isError(direct)) return direct;
    const objectStart = decoded.indexOf('{');
    if (objectStart === -1) return {};
    const objectEnd = findJsonObjectEnd(decoded, objectStart);
    if (objectEnd === -1) return {};
    const repaired = _.attempt(() => JSON.parse(decoded.slice(objectStart, objectEnd)));
    return _.isError(repaired) ? {} : repaired;
}

function parseOpenAIXmlFunctionCalls(text: string, resolveToolName: ToolNameResolver): ResponsesToolCall[] {
    const calls: ResponsesToolCall[] = [];
    const functionPattern = /^\s*<function\s+[^>]*>([\s\S]*?)<\/function>/gm;
    let functionMatch: RegExpExecArray | null;

    while ((functionMatch = functionPattern.exec(text)) != null) {
        if (isInsideMarkdownFence(text, functionMatch.index)) continue;
        const body = functionMatch[1];
        const name = body.match(/<function_name>\s*([\s\S]*?)\s*<\/function_name>/)?.[1]?.trim();
        const argsText = body.match(/<function_args>\s*([\s\S]*?)\s*<\/function_args>/)?.[1];
        if (!name || argsText == null) continue;

        calls.push(createToolCall(name, parseFunctionArgs(argsText), resolveToolName));
    }

    return calls;
}

function parseToolCalls(text: string, resolveToolName: ToolNameResolver = createToolNameResolver()) {
    return [
        ...parseStandardToolCalls(text, resolveToolName),
        ...parseDsmlToolCalls(text, resolveToolName),
        ...parseBashToolCalls(text, resolveToolName),
        ...parseBashNoToolCalls(text, resolveToolName),
        ...parseBashCommandToolCalls(text, resolveToolName),
        ...parseBashToolUsageCalls(text, resolveToolName),
        ...parseBashScriptCalls(text, resolveToolName),
        ...parseCommandLineToolCalls(text, resolveToolName),
        ...parseGenericXmlToolCalls(text, resolveToolName),
        ...parseFunctionCalls(text, resolveToolName),
        ...parseBareFunctionCalls(text, resolveToolName),
        ...parseOpenAIXmlFunctionCalls(text, resolveToolName),
    ];
}

function getToolStartIndex(text: string) {
    const indexes = [
        findLineStartTag(text, /^\s*<?tool_call\s+name=["'][^"']+["']\s*>/gmi),
        findLineStartTag(text, /^\s*<｜DSML｜tool_calls>/gm),
        findLineStartTag(text, /^\s*｜DSML｜tool_calls>/gm),
        findLineStartTag(text, /^\s*<bash(?:\s+[^>]*)?>/gm),
        findLineStartTag(text, /^\s*<bash_notool>/gm),
        findLineStartTag(text, /^\s*<bash-command(?:\s+[^>]*)?>/gm),
        findLineStartTag(text, /^\s*<bash-tool-usage>/gm),
        findLineStartTag(text, /^\s*<bash_script(?:\s+[^>]*)?>/gm),
        findLineStartTag(text, /^\s*<command-line(?:\s+[^>]*)?>/gm),
        findLineStartTag(text, /^\s*<tool_calls>/gm),
        findLineStartTag(text, /^\s*<function_calls>/gm),
        findLineStartTag(text, /^\s*<function\s+[^>]*>/gm),
    ].filter((index) => index !== -1);
    return indexes.length ? Math.min(...indexes) : -1;
}

function getPotentialToolStartIndex(text: string) {
    const lineStart = text.lastIndexOf('\n') + 1;
    const line = text.slice(lineStart);
    const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
    const tagStart = lineStart + leadingWhitespace.length;
    const candidate = text.slice(tagStart);
    if (!candidate || isInsideMarkdownFence(text, tagStart)) return -1;
    return TOOL_START_MARKERS.some((marker) => marker.startsWith(candidate) || candidate.startsWith(marker)) ? tagStart : -1;
}

function getTextBeforeToolCall(text: string) {
    const toolStartIndex = getToolStartIndex(text);
    return toolStartIndex === -1 ? text : text.slice(0, toolStartIndex);
}

function mayBecomeToolCallPrefix(text: string) {
    const trimmed = text.trimStart();
    if (!trimmed) return true;
    return TOOL_START_MARKERS.some((marker) => marker.startsWith(trimmed) || trimmed.startsWith(marker));
}

function cleanAssistantArtifacts(text: string) {
    return text.replace(ASSISTANT_MARKER_PATTERN, '\n');
}

function toResponsesPayload(chatResponse: any, resolveToolName: ToolNameResolver = createToolNameResolver()) {
    const message = _.get(chatResponse, 'choices[0].message', {});
    const content = cleanAssistantArtifacts(message.content || '');
    const reasoningContent = message.reasoning_content || '';
    const created = chatResponse.created || util.unixTimestamp();
    const toolCalls = parseToolCalls(content, resolveToolName);
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

function createResponsesStream(chatStream: any, model: string, options: { onConversationId?: (responseId: string, conversationId: string) => void, resolveToolName?: ToolNameResolver, promptTokens?: number } = {}) {
    const { onConversationId, resolveToolName = createToolNameResolver(), promptTokens = 1 } = options;
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
        const toolCalls = parseToolCalls(outputText, resolveToolName);
        const output: any[] = [];
        const visibleText = getTextBeforeToolCall(outputText);

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
                usage: toResponsesUsage({ prompt_tokens: promptTokens, completion_tokens: calculateTokens(outputText) }),
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
            const { model, input, instructions, stream, tools } = request.body;
            const resolveToolName = createToolNameResolver(tools);
            const prepared = getMessagesForDeepSeek(request, model, input, instructions, tools);

            if (!prepared.messages.length)
                throw new Error('Params body.input invalid');

            if (stream) {
                const promptTokens = calculateMessagesTokens(prepared.messages);
                const chatStream = await chat.createCompletionStream(model.toLowerCase(), prepared.messages, token, prepared.refConvId);
                return new Response(createResponsesStream(chatStream, model, {
                    resolveToolName,
                    promptTokens,
                    onConversationId: (responseId, conversationId) => {
                        updateResponseHistorySession(prepared.sessionKey, conversationId, normalizeInputToMessages(input, instructions, tools).length);
                    },
                }), {
                    type: 'text/event-stream',
                });
            }

            const chatResponse = await chat.createCompletion(model.toLowerCase(), prepared.messages, token, prepared.refConvId);
            const responsePayload = toResponsesPayload(chatResponse, resolveToolName);
            updateResponseHistorySession(prepared.sessionKey, chatResponse.id, normalizeInputToMessages(input, instructions, tools).length);
            return responsePayload;
        }

    }

}
