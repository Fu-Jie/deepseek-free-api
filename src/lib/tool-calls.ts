import _ from 'lodash';

import util from '@/lib/util.ts';

export interface AgentToolCall {
    id: string;
    call_id: string;
    name: string;
    input: Record<string, any>;
    arguments: string;
    range?: [number, number];
}

export type ToolNameResolver = (name: string, args?: Record<string, any>) => { name: string, args: Record<string, any> };

export const TOOL_START_MARKERS = [
    '<tool_call',
    '<｜DSML｜tool_calls>',
    '｜DSML｜tool_calls>',
    '```json',
    '<bash>',
    '<bash ',
    '<bash_notool>',
    '<bash-command',
    '<bash-tool-usage>',
    '<bash_script',
    '<command-line',
    '<tool_calls>',
    '<function_calls>',
    '<function ',
    '<invoke ',
    'Assistant requested tool',
    '{"tool_call"',
    '{"function_call"',
    '{"custom_tool_call"',
    '{"custom_tool_calls"',
    '{"mcp_tool_call"',
    '{"mcp_tool_calls"',
];

const ASSISTANT_MARKER_PATTERN = /(?:^|\n)\s*<｜Assistant｜>\s*/g;
const PARAMETER_PATTERN = /<parameter\s+name=["']([^"']+)["'](?:\s+[^>]*)?>([\s\S]*?)<\/parameter>/gi;

function safeJsonStringify(value: any) {
    const result = _.attempt(() => JSON.stringify(value));
    return _.isError(result) ? '{}' : String(result || '{}');
}

function normalizeArgs(args: any): Record<string, any> {
    if (_.isPlainObject(args)) return args as Record<string, any>;
    if (_.isArray(args)) return { input: args };
    if (_.isNil(args)) return {};
    return { input: args };
}

function getAvailableToolNames(tools: any[]) {
    if (!_.isArray(tools)) return [];
    return tools
        .map((tool) => _.get(tool, 'name') || _.get(tool, 'function.name'))
        .filter(_.isString);
}

function normalizeToolName(name: string) {
    return String(name || '')
        .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase → snake_case
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // e.g. HTMLParser → HTML_Parser
        .replace(/[\s-]+/g, '_')
        .toLowerCase();
}

function getToolByName(tools: any[], name: string) {
    const normalized = normalizeToolName(name);
    return (_.isArray(tools) ? tools : []).find((tool) => {
        const toolName = _.get(tool, 'name') || _.get(tool, 'function.name');
        return _.isString(toolName) && normalizeToolName(toolName) === normalized;
    });
}

function getToolParameters(tool: any) {
    return _.get(tool, 'parameters')
        || _.get(tool, 'function.parameters')
        || _.get(tool, 'input_schema')
        || _.get(tool, 'inputSchema')
        || {};
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
    if (_.get(properties, `${parameterName}.type`) === 'array' && command != null)
        return { [parameterName]: shellCommandToArgs(command) };
    if (parameterName !== 'command' && command != null)
        return { [parameterName]: _.isArray(command) ? command.join(' ') : String(command) };

    const keys = Object.keys(args);
    if (keys.length === 1 && keys[0] === 'input' && parameterName !== 'input')
        return { [parameterName]: args.input };

    return args;
}

export function createToolNameResolver(tools: any[] = []): ToolNameResolver {
    const toolNames = getAvailableToolNames(tools);
    const hasTool = (name: string) => Boolean(getToolByName(tools, name));
    const resolveAvailableName = (name: string) => {
        const tool = getToolByName(tools, name);
        return (_.get(tool, 'name') || _.get(tool, 'function.name') || name) as string;
    };
    const shellTool = ['shell', 'bash', 'run_shell_command', 'powershell', 'run_shell'].find(hasTool) || toolNames[0] || 'shell';

    return (name: string, args: Record<string, any> = {}) => {
        if (hasTool(name)) {
            const resolvedName = resolveAvailableName(name);
            return { name: resolvedName, args: adaptToolArgs(getToolByName(tools, resolvedName), args) };
        }

        if (['run_shell_command', 'run_shell', 'shell', 'bash', 'powershell'].includes(normalizeToolName(name)))
            return { name: shellTool, args: adaptToolArgs(getToolByName(tools, shellTool), args) };

        if (name === 'read_file') {
            const filePath = args.path || args.file || args.filename;
            if (hasTool('read_file')) return { name: resolveAvailableName('read_file'), args };
            return {
                name: shellTool,
                args: adaptToolArgs(getToolByName(tools, shellTool), { command: `cat ${JSON.stringify(filePath || '')}` }),
            };
        }

        if (name === 'apply_patch' && hasTool('apply_patch')) return { name: resolveAvailableName('apply_patch'), args };
        return { name, args };
    };
}

function createToolCall(name: string, args: any, resolveToolName: ToolNameResolver, range?: [number, number]): AgentToolCall {
    const resolved = resolveToolName(name, normalizeArgs(args));
    const input = normalizeArgs(resolved.args);
    return {
        id: `fc_${util.uuid(false)}`,
        call_id: `call_${util.uuid(false)}`,
        name: resolved.name,
        input,
        arguments: safeJsonStringify(input),
        range,
    };
}

function parseParameterTags(value: string) {
    const args: Record<string, any> = {};
    const parameterPattern = new RegExp(PARAMETER_PATTERN);
    let parameterMatch: RegExpExecArray | null;

    while ((parameterMatch = parameterPattern.exec(value)) != null) {
        args[parameterMatch[1]] = util.decodeXmlText(parameterMatch[2].trim());
    }

    return args;
}

function parseDsmlParameterTags(value: string) {
    const args: Record<string, any> = {};
    const parameterPattern = /<?｜DSML｜parameter\s+name=["']([^"']+)["'](?:\s+[^>]*)?>([\s\S]*?)<\/｜DSML｜parameter>/gi;
    let parameterMatch: RegExpExecArray | null;

    while ((parameterMatch = parameterPattern.exec(value)) != null) {
        args[parameterMatch[1]] = util.decodeXmlText(parameterMatch[2].trim());
    }

    return args;
}

function parseToolInputFromBody(body: string) {
    const decoded = util.decodeXmlText(String(body || '').trim());
    const parameterArgs = parseParameterTags(decoded);
    if (!_.isEmpty(parameterArgs)) return parameterArgs;

    const dsmlArgs = parseDsmlParameterTags(decoded);
    if (!_.isEmpty(dsmlArgs)) return dsmlArgs;

    const jsonStart = decoded.indexOf('{');
    if (jsonStart !== -1) {
        const jsonEnd = util.findJsonEnd(decoded, jsonStart);
        if (jsonEnd !== -1) return util.parseToolInput(decoded.slice(jsonStart, jsonEnd));
    }

    return util.parseToolInput(decoded);
}

function parseStandardToolCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const openPattern = /<?tool_call\s+name=["']([^"']+)["']\s*>/gi;
    let match: RegExpExecArray | null;

    while ((match = openPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, match.index)) continue;
        const afterOpen = openPattern.lastIndex;
        const closePattern = /<\/tool_call>/gi;
        closePattern.lastIndex = afterOpen;
        const closeMatch = closePattern.exec(text);

        let body: string;
        let end: number;

        if (closeMatch) {
            // Normal case: closing tag found
            body = text.slice(afterOpen, closeMatch.index);
            end = closeMatch.index + closeMatch[0].length;
        } else {
            // No closing tag (e.g., stream ended early or DeepSeek omitted it).
            // Recover by locating the end of the JSON object/array body.
            const bodyRaw = text.slice(afterOpen);
            const jsonStart = bodyRaw.indexOf('{');
            if (jsonStart !== -1) {
                const jsonEnd = util.findJsonEnd(bodyRaw, jsonStart);
                if (jsonEnd !== -1) {
                    body = bodyRaw.slice(0, jsonEnd);
                    end = afterOpen + jsonEnd;
                } else {
                    // JSON not yet closed; take everything (best-effort)
                    body = bodyRaw;
                    end = text.length;
                }
            } else {
                body = bodyRaw;
                end = text.length;
            }
        }

        calls.push(createToolCall(match[1], parseToolInputFromBody(body), resolveToolName, [match.index, end]));
        openPattern.lastIndex = end;
    }

    return calls;
}

function parseDsmlToolCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    if (!text.includes('｜DSML｜tool_calls')) return [];
    const calls: AgentToolCall[] = [];
    const invokePattern = /<?｜DSML｜invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/｜DSML｜invoke>/gi;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokePattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, invokeMatch.index)) continue;
        calls.push(createToolCall(invokeMatch[1], parseToolInputFromBody(invokeMatch[2]), resolveToolName, [invokeMatch.index, invokePattern.lastIndex]));
    }

    return calls;
}

function parseBashArgs(value: string): string | string[] {
    const argPattern = /<arg>\s*([\s\S]*?)\s*<\/arg>/g;
    const args: string[] = [];
    let argMatch: RegExpExecArray | null;

    while ((argMatch = argPattern.exec(value)) != null) {
        const decoded = util.decodeXmlText(argMatch[1].trim());
        const parsed = _.attempt(() => JSON.parse(decoded));
        if (_.isArray(parsed)) args.push(...parsed.map(String));
        else if (decoded) args.push(decoded);
    }

    if (args.length) return args;
    const decoded = util.decodeXmlText(value.trim());
    const parsed = _.attempt(() => JSON.parse(decoded));
    if (_.isArray(parsed)) return parsed.map(String);
    return decoded;
}

function parseCommandTag(text: string, tagName: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const tagPattern = new RegExp(`^\\s*<${tagName}(?:\\s+[^>]*)?>\\s*\\r?\\n?([\\s\\S]*?)\\r?\\n?\\s*<\\/${tagName}>`, 'gmi');
    let match: RegExpExecArray | null;

    while ((match = tagPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, match.index)) continue;
        const command = parseBashArgs(match[1]);
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName, [match.index, tagPattern.lastIndex]));
    }

    return calls;
}

function parseBashScriptCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const scriptPattern = /^\s*<bash_script(?:\s+[^>]*)?>([\s\S]*?)<\/bash_script>/gmi;
    let match: RegExpExecArray | null;

    while ((match = scriptPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, match.index)) continue;
        const body = match[1];
        const value = body.match(/<value>\s*([\s\S]*?)\s*<\/value>/)?.[1];
        const invocation = body.match(/<invocation>\s*([\s\S]*?)\s*<\/invocation>/)?.[1];
        const command = util.decodeXmlText((value || invocation || body).trim());
        if (!command) continue;
        calls.push(createToolCall('shell', { command }, resolveToolName, [match.index, scriptPattern.lastIndex]));
    }

    return calls;
}

function parseInvokeCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const invokePattern = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokePattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, invokeMatch.index)) continue;
        calls.push(createToolCall(invokeMatch[1], parseToolInputFromBody(invokeMatch[2]), resolveToolName, [invokeMatch.index, invokePattern.lastIndex]));
    }

    return calls;
}

function parseBareFunctionTags(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const functionPattern = /<function\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/function>/gi;
    let functionMatch: RegExpExecArray | null;

    while ((functionMatch = functionPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, functionMatch.index)) continue;
        calls.push(createToolCall(functionMatch[1], parseToolInputFromBody(functionMatch[2]), resolveToolName, [functionMatch.index, functionPattern.lastIndex]));
    }

    return calls;
}

function parseOpenAIXmlFunctionCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const functionPattern = /<function\s+[^>]*>([\s\S]*?)<\/function>/gi;
    let functionMatch: RegExpExecArray | null;

    while ((functionMatch = functionPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, functionMatch.index)) continue;
        const body = functionMatch[1];
        const name = body.match(/<function_name>\s*([\s\S]*?)\s*<\/function_name>/)?.[1]?.trim();
        const argsText = body.match(/<function_args>\s*([\s\S]*?)\s*<\/function_args>/)?.[1];
        if (!name || argsText == null) continue;
        calls.push(createToolCall(name, parseToolInputFromBody(argsText), resolveToolName, [functionMatch.index, functionPattern.lastIndex]));
    }

    return calls;
}

function parseRequestedToolCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const requestedToolPattern = /Assistant requested tool\s+([A-Za-z0-9_\-.]+)\s*:/gi;
    let match: RegExpExecArray | null;

    while ((match = requestedToolPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, match.index)) continue;
        const jsonStart = text.indexOf('{', requestedToolPattern.lastIndex);
        if (jsonStart === -1) continue;
        const jsonEnd = util.findJsonEnd(text, jsonStart);
        if (jsonEnd === -1) continue;
        calls.push(createToolCall(match[1], util.parseToolInput(text.slice(jsonStart, jsonEnd)), resolveToolName, [match.index, jsonEnd]));
    }

    return calls;
}

function parseFunctionInvocationCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const functionCallPattern = /(?:^|\n)\s*([A-Za-z][A-Za-z0-9_\-.]*)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = functionCallPattern.exec(text)) != null) {
        if (util.isInsideMarkdownFence(text, match.index)) continue;
        const jsonStart = text.indexOf('{', functionCallPattern.lastIndex);
        if (jsonStart === -1) continue;
        const prefixBetweenNameAndJson = text.slice(functionCallPattern.lastIndex, jsonStart).trim();
        if (prefixBetweenNameAndJson) continue;
        const jsonEnd = util.findJsonEnd(text, jsonStart);
        if (jsonEnd === -1) continue;
        const suffix = text.slice(jsonEnd).match(/^\s*\)/);
        if (!suffix) continue;
        calls.push(createToolCall(match[1], util.parseToolInput(text.slice(jsonStart, jsonEnd)), resolveToolName, [match.index, jsonEnd + suffix[0].length]));
    }

    return calls;
}

function normalizeJsonArgs(value: any) {
    if (_.isPlainObject(value)) return value as Record<string, any>;
    if (_.isString(value)) return util.parseToolInput(value);
    if (_.isArray(value)) return { input: value };
    if (_.isNil(value)) return {};
    return { input: value };
}

function collectJsonToolSpecs(payload: any): Array<{ name: string, args: Record<string, any> }> {
    const specs: Array<{ name: string, args: Record<string, any> }> = [];
    const payloads = _.isArray(payload) ? payload : [payload];
    const append = (name: any, args: any) => {
        if (!_.isString(name) || !name.trim()) return;
        specs.push({ name: name.trim(), args: normalizeJsonArgs(args) });
    };

    for (const entry of payloads) {
        if (!_.isPlainObject(entry)) continue;

        const toolCall = _.get(entry, 'tool_call');
        if (_.isPlainObject(toolCall))
            append(_.get(toolCall, 'name') || _.get(toolCall, 'function.name'), _.get(toolCall, 'arguments') ?? _.get(toolCall, 'input') ?? _.get(toolCall, 'params') ?? _.get(toolCall, 'function.arguments'));

        const functionCall = _.get(entry, 'function_call');
        if (_.isPlainObject(functionCall))
            append(_.get(functionCall, 'name'), _.get(functionCall, 'arguments') ?? _.get(functionCall, 'input') ?? _.get(functionCall, 'params'));

        const customToolCall = _.get(entry, 'custom_tool_call');
        if (_.isPlainObject(customToolCall))
            append(_.get(customToolCall, 'name') || _.get(customToolCall, 'tool'), _.get(customToolCall, 'arguments') ?? _.get(customToolCall, 'input') ?? _.get(customToolCall, 'params'));

        const mcpToolCall = _.get(entry, 'mcp_tool_call');
        if (_.isPlainObject(mcpToolCall))
            append(_.get(mcpToolCall, 'tool') || _.get(mcpToolCall, 'name'), _.get(mcpToolCall, 'arguments') ?? _.get(mcpToolCall, 'input') ?? _.get(mcpToolCall, 'params'));

        const toolCalls = _.get(entry, 'tool_calls');
        if (_.isArray(toolCalls)) {
            for (const call of toolCalls) {
                const name = _.get(call, 'name') || _.get(call, 'function.name');
                const args = _.get(call, 'arguments') ?? _.get(call, 'input') ?? _.get(call, 'params') ?? _.get(call, 'function.arguments');
                append(name, args);
            }
        }

        const customToolCalls = _.get(entry, 'custom_tool_calls');
        if (_.isArray(customToolCalls)) {
            for (const call of customToolCalls) {
                const name = _.get(call, 'name') || _.get(call, 'tool');
                const args = _.get(call, 'arguments') ?? _.get(call, 'input') ?? _.get(call, 'params');
                append(name, args);
            }
        }

        const mcpToolCalls = _.get(entry, 'mcp_tool_calls');
        if (_.isArray(mcpToolCalls)) {
            for (const call of mcpToolCalls) {
                const name = _.get(call, 'tool') || _.get(call, 'name');
                const args = _.get(call, 'arguments') ?? _.get(call, 'input') ?? _.get(call, 'params');
                append(name, args);
            }
        }

        if (_.isString(_.get(entry, 'name'))) {
            if (_.has(entry, 'arguments') || _.has(entry, 'input') || _.has(entry, 'params')) {
                append(_.get(entry, 'name'), _.get(entry, 'arguments') ?? _.get(entry, 'input') ?? _.get(entry, 'params'));
            } else {
                const directArgs = _.omit(entry, ['name', 'type', 'id']);
                if (!_.isEmpty(directArgs)) append(_.get(entry, 'name'), directArgs);
            }
        }

        if (_.isString(_.get(entry, 'tool')) && (_.has(entry, 'arguments') || _.has(entry, 'input') || _.has(entry, 'params')))
            append(_.get(entry, 'tool'), _.get(entry, 'arguments') ?? _.get(entry, 'input') ?? _.get(entry, 'params'));
    }

    return specs;
}

function parseJsonPayloadToolCalls(payload: any, resolveToolName: ToolNameResolver, range: [number, number]) {
    const calls: AgentToolCall[] = [];
    for (const spec of collectJsonToolSpecs(payload)) {
        calls.push(createToolCall(spec.name, spec.args, resolveToolName, range));
    }
    return calls;
}

function parseJsonEnvelopeToolCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const source = text.trimStart();
    if (!source.startsWith('{') && !source.startsWith('[')) return calls;

    const firstBrace = text.search(/[\[{]/);
    if (firstBrace === -1 || util.isInsideMarkdownFence(text, firstBrace)) return calls;
    const jsonEnd = text[firstBrace] === '['
        ? text.lastIndexOf(']') + 1
        : util.findJsonEnd(text, firstBrace);
    if (jsonEnd === -1) return calls;
    const parsed = _.attempt(() => JSON.parse(text.slice(firstBrace, jsonEnd)));
    if (_.isError(parsed) || (!_.isPlainObject(parsed) && !_.isArray(parsed))) return calls;

    calls.push(...parseJsonPayloadToolCalls(parsed, resolveToolName, [firstBrace, jsonEnd]));

    return calls;
}

function parseJsonFenceToolCalls(text: string, resolveToolName: ToolNameResolver): AgentToolCall[] {
    const calls: AgentToolCall[] = [];
    const fencePattern = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;

    while ((match = fencePattern.exec(text)) != null) {
        const body = match[1].trim();
        if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
        if (util.isInsideMarkdownFence(text, match.index)) continue;
        const parsed = _.attempt(() => JSON.parse(body));
        if (_.isError(parsed) || (!_.isPlainObject(parsed) && !_.isArray(parsed))) continue;
        const range: [number, number] = [match.index, fencePattern.lastIndex];
        calls.push(...parseJsonPayloadToolCalls(parsed, resolveToolName, range));
    }

    return calls;
}

function dedupeToolCalls(calls: AgentToolCall[]) {
    const seen = new Set<string>();
    return calls.filter((call) => {
        const key = `${call.range?.join(':') || ''}:${call.name}:${call.arguments}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function cleanAssistantArtifacts(text: string) {
    return String(text || '').replace(ASSISTANT_MARKER_PATTERN, '\n');
}

export function parseAgentToolCalls(text: string, toolsOrResolver?: any[] | ToolNameResolver) {
    const resolveToolName = _.isFunction(toolsOrResolver)
        ? toolsOrResolver as ToolNameResolver
        : createToolNameResolver(toolsOrResolver || []);
    const source = cleanAssistantArtifacts(text);
    return dedupeToolCalls([
        ...parseStandardToolCalls(source, resolveToolName),
        ...parseDsmlToolCalls(source, resolveToolName),
        ...parseCommandTag(source, 'bash', resolveToolName),
        ...parseCommandTag(source, 'bash_notool', resolveToolName),
        ...parseCommandTag(source, 'bash-command', resolveToolName),
        ...parseCommandTag(source, 'bash-tool-usage', resolveToolName),
        ...parseBashScriptCalls(source, resolveToolName),
        ...parseCommandTag(source, 'command-line', resolveToolName),
        ...parseInvokeCalls(source, resolveToolName),
        ...parseBareFunctionTags(source, resolveToolName),
        ...parseOpenAIXmlFunctionCalls(source, resolveToolName),
        ...parseRequestedToolCalls(source, resolveToolName),
        ...parseFunctionInvocationCalls(source, resolveToolName),
        ...parseJsonFenceToolCalls(source, resolveToolName),
        ...parseJsonEnvelopeToolCalls(source, resolveToolName),
    ]);
}

export function splitTextAndToolCalls(text: string, toolsOrResolver?: any[] | ToolNameResolver) {
    let cleanText = cleanAssistantArtifacts(text);
    const toolCalls = parseAgentToolCalls(cleanText, toolsOrResolver);
    const ranges = toolCalls
        .map((call) => call.range)
        .filter(Boolean) as Array<[number, number]>;

    for (const [start, end] of ranges.sort((left, right) => right[0] - left[0])) {
        cleanText = cleanText.slice(0, start) + cleanText.slice(end);
    }

    return { text: cleanText.trim(), toolCalls };
}

function findLineStartTag(text: string, pattern: RegExp) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) != null) {
        if (!util.isInsideMarkdownFence(text, match.index)) return match.index;
    }
    return -1;
}

function findPatternStart(text: string, pattern: RegExp) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) != null) {
        if (!util.isInsideMarkdownFence(text, match.index)) return match.index;
    }
    return -1;
}

function findTrailingMarkerPrefixStart(text: string, marker: string, minimumLength = 8) {
    const maxLength = Math.min(marker.length, text.length);
    const minLength = Math.min(minimumLength, marker.length);

    for (let length = maxLength; length >= minLength; length--) {
        const start = text.length - length;
        if (util.isInsideMarkdownFence(text, start)) continue;
        const suffix = text.slice(start);
        if (marker.startsWith(suffix)) return start;
    }

    return -1;
}

function findJsonFenceToolStart(text: string) {
    const fencePattern = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;

    while ((match = fencePattern.exec(text)) != null) {
        const body = match[1].trim();
        if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
        const parsed = _.attempt(() => JSON.parse(body));
        if (_.isError(parsed) || (!_.isPlainObject(parsed) && !_.isArray(parsed))) continue;
        if (collectJsonToolSpecs(parsed).length > 0) return match.index;
    }

    return -1;
}

export function getToolStartIndex(text: string) {
    const source = cleanAssistantArtifacts(text);
    const trimmedSource = source.trimStart();
    const jsonEnvelopeStart = (trimmedSource.startsWith('{') || trimmedSource.startsWith('['))
        ? (() => {
            const start = source.search(/[\[{]/);
            if (start === -1 || util.isInsideMarkdownFence(source, start)) return -1;
            const end = source[start] === '['
                ? source.lastIndexOf(']') + 1
                : util.findJsonEnd(source, start);
            if (end === -1) return -1;
            const parsed = _.attempt(() => JSON.parse(source.slice(start, end)));
            if (_.isError(parsed) || (!_.isPlainObject(parsed) && !_.isArray(parsed))) return -1;
            return collectJsonToolSpecs(parsed).length > 0 ? start : -1;
        })()
        : -1;
    const jsonFenceStart = findJsonFenceToolStart(source);
    const indexes = [
        findLineStartTag(source, /^\s*<?tool_call\s+name=["'][^"']+["']\s*>/gmi),
        findLineStartTag(source, /^\s*<｜DSML｜tool_calls>/gm),
        findLineStartTag(source, /^\s*｜DSML｜tool_calls>/gm),
        jsonFenceStart,
        findLineStartTag(source, /^\s*<bash(?:\s+[^>]*)?>/gmi),
        findLineStartTag(source, /^\s*<bash_notool>/gmi),
        findLineStartTag(source, /^\s*<bash-command(?:\s+[^>]*)?>/gmi),
        findLineStartTag(source, /^\s*<bash-tool-usage>/gmi),
        findLineStartTag(source, /^\s*<bash_script(?:\s+[^>]*)?>/gmi),
        findLineStartTag(source, /^\s*<command-line(?:\s+[^>]*)?>/gmi),
        findLineStartTag(source, /^\s*<tool_calls>/gmi),
        findLineStartTag(source, /^\s*<function_calls>/gmi),
        findLineStartTag(source, /^\s*<function\s+[^>]*>/gmi),
        findLineStartTag(source, /^\s*<invoke\s+name=["'][^"']+["']\s*>/gmi),
        findPatternStart(source, /Assistant requested tool\s+[A-Za-z0-9_\-.]+\s*:/gi),
        findLineStartTag(source, /(?:^|\n)\s*[A-Za-z][A-Za-z0-9_\-.]*\s*\(\s*\{/g),
        findLineStartTag(source, /^\s*\{"tool_call"/gmi),
        findLineStartTag(source, /^\s*\{"function_call"/gmi),
        findLineStartTag(source, /^\s*\{"custom_tool_call"/gmi),
        findLineStartTag(source, /^\s*\{"custom_tool_calls"/gmi),
        findLineStartTag(source, /^\s*\{"mcp_tool_call"/gmi),
        findLineStartTag(source, /^\s*\{"mcp_tool_calls"/gmi),
        jsonEnvelopeStart,
    ].filter((index) => index !== -1);
    return indexes.length ? Math.min(...indexes) : -1;
}

export function getPotentialToolStartIndex(text: string) {
    const source = cleanAssistantArtifacts(text);
    const lineStart = source.lastIndexOf('\n') + 1;
    const line = source.slice(lineStart);
    const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
    const tagStart = lineStart + leadingWhitespace.length;
    const candidate = source.slice(tagStart);
    if (!candidate || util.isInsideMarkdownFence(source, tagStart)) return -1;
    if (TOOL_START_MARKERS.some((marker) => marker.startsWith(candidate) || candidate.startsWith(marker))) return tagStart;

    const inlineRequestedToolStart = findPatternStart(source, /Assistant requested tool\b/gi);
    if (inlineRequestedToolStart !== -1) return inlineRequestedToolStart;

    const trailingRequestedToolPrefixStart = findTrailingMarkerPrefixStart(source, 'Assistant requested tool');
    if (trailingRequestedToolPrefixStart !== -1) return trailingRequestedToolPrefixStart;

    const fenceStart = source.lastIndexOf('```');
    if (fenceStart !== -1 && !util.isInsideMarkdownFence(source, fenceStart)) {
        const fenceCandidate = source.slice(fenceStart);
        if (/^```(?:json)?[ \t]*\r?\n[\s\S]*"(?:name|tool_call|function_call|tool_calls)"\s*:/i.test(fenceCandidate))
            return fenceStart;
    }

    return -1;
}

export function getTextBeforeToolCall(text: string) {
    const source = cleanAssistantArtifacts(text);
    const toolStartIndex = getToolStartIndex(source);
    return toolStartIndex === -1 ? source : source.slice(0, toolStartIndex);
}

export function mayBecomeToolCallPrefix(text: string) {
    const trimmed = cleanAssistantArtifacts(text).trimStart();
    if (!trimmed) return true;
    return TOOL_START_MARKERS.some((marker) => marker.startsWith(trimmed) || trimmed.startsWith(marker));
}

export function hasExplicitToolCallStart(text: string) {
    return getToolStartIndex(text) !== -1;
}