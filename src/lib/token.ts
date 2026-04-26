import { encode } from 'gpt-tokenizer';

/**
 * Calculate the number of tokens for a given string
 */
export function calculateTokens(text: string): number {
    try {
        if (!text) return 0;
        return encode(text).length;
    } catch (e) {
        return 0;
    }
}

/**
 * Calculate the number of tokens for a list of messages
 */
export function calculateMessagesTokens(messages: any[]): number {
    try {
        if (!Array.isArray(messages)) return 0;
        const text = messages.map(m => m.content).join('\n');
        return calculateTokens(text);
    } catch (e) {
        return 0;
    }
}
