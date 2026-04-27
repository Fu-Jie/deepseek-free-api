import _ from 'lodash';

/**
 * Build a tools description prompt from various tool definition formats (OpenAI or Anthropic style).
 * This is injected as a system message so DeepSeek knows how to format tool calls.
 */
export function buildToolsPrompt(tools?: any[]): string {
    if (!_.isArray(tools) || tools.length === 0) return '';
    const toolDescriptions = tools
        .map((tool) => {
            // Support both OpenAI tool {type: 'function', function: {...}} and direct {name, description, ...}
            const fn = tool.type === 'function' ? tool.function : tool;
            const name = _.get(fn, 'name') || _.get(tool, 'name');
            if (!name) return '';
            
            const description = _.get(fn, 'description') || _.get(tool, 'description') || '';
            
            // Support 'parameters' (OpenAI) and 'input_schema' (Anthropic)
            const schema = _.get(fn, 'parameters') || 
                           _.get(tool, 'parameters') || 
                           _.get(fn, 'input_schema') || 
                           _.get(tool, 'input_schema') || 
                           _.get(fn, 'inputSchema') || 
                           _.get(tool, 'inputSchema') || 
                           {};
                           
            return `- ${name}: ${description}\n  input_schema: ${JSON.stringify(schema)}`;
        })
        .filter(Boolean)
        .join('\n');

    if (!toolDescriptions) return '';
    return [
        'You have access to tools. When a tool is needed, do not describe the call in prose.',
        'If tools are provided for this request, prefer calling tools before giving a final answer.',
        'Do not answer from memory when a listed tool can verify or fetch the result.',
        'Output exactly one or more tool calls in this format and nothing else:',
        '<tool_call name="ToolName">{"arg":"value"}</tool_call>',
        'Do not wrap tool calls in markdown fences. Do not add text before or after tool calls.',
        'The JSON inside the tag must match the tool input schema.',
        'You may emit multiple tool calls across multiple turns until the task is complete.',
        'After receiving <tool_result ...>...</tool_result>, continue the task and call more tools if needed.',
        'Only end with a normal text answer when no further tool call is required.',
        'Available tools:',
        toolDescriptions,
    ].join('\n');
}

/**
 * Unified helper to inject tools prompt into messages array.
 */
export function injectToolsIntoMessages(messages: any[], tools?: any[]): any[] {
    const toolsPrompt = buildToolsPrompt(tools);
    if (!toolsPrompt) return messages;

    const augmentedMessages = [...messages];
    augmentedMessages.unshift({ role: 'system', content: toolsPrompt });

    return augmentedMessages;
}
