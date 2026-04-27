import { encode, encodeChat } from "gpt-tokenizer";

/**
 * Calculate the number of tokens for a given string
 */
export function calculateTokens(text: string): number {
    try {
        if (!text || typeof text !== 'string') return 0;
        const tokens = encode(text);
        // 🌟 改进：中文环境下 Math.ceil(text.length / 1.3) 更准确
        return tokens.length || (text.length > 0 ? Math.ceil(text.length / 1.3) : 0);
    } catch (e) {
        console.error(`[TOKEN ERROR] Failed to encode text: ${e}`);
        return text ? Math.ceil(text.length / 1.3) : 0;
    }
}

/**
 * Calculate the number of tokens for a list of messages using the official encodeChat logic.
 * Supports tool_calls, function_call and multi-protocol role mapping.
 */
export function calculateMessagesTokens(messages: any[], system?: string, tools?: any[]): number {
    try {
        if (!Array.isArray(messages) || messages.length === 0) return 0;
        
        // 格式化消息以符合 gpt-tokenizer 的 ChatMessage 类型要求
        const formattedMessages = messages.map(m => {
            let role = m.role || 'user';
            if (role === 'human') role = 'user';
            if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
                role = 'user';
            }

            const msg: any = {
                role: role,
                content: ""
            };

            if (typeof m.content === 'string') {
                msg.content = m.content;
            } else if (Array.isArray(m.content)) {
                msg.content = m.content.map((c: any) => c.text || "").join("");
            } else if (m.text) {
                msg.content = m.text;
            }

            if (m.name) msg.name = m.name;
            if (m.tool_calls) msg.tool_calls = m.tool_calls;
            if (m.function_call) msg.function_call = m.function_call;
            if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;

            return msg;
        });

        // 尝试使用 gpt-5 编码器 (o200k_base)，这是目前最通用的 o200k 实现
        // gpt-tokenizer 对 gpt-5 的支持通常映射到此编码器
        const tokens = encodeChat(formattedMessages as any, "gpt-5");
        if (tokens && tokens.length > 0) return tokens.length;

        // 兜底方案：如果上述计算返回 0 且内容不为空
        let estimated = 0;
        for (const m of formattedMessages) {
            if (m.content) {
                estimated += calculateTokens(m.content) + 4;
            }
        }
        return estimated || messages.length * 5;
    } catch (e) {
        console.error(`[TOKEN ERROR] Failed to calculate chat tokens: ${e}`);
        // 最后的保底，确保不会返回 0
        return messages.length * 7;
    }
}
