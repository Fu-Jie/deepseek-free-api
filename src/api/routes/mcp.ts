import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import mcpController from '@/api/controllers/mcp.ts';
import chat from '@/api/controllers/chat.ts';
import { selectTokenForSession, getClientIdentity } from '@/lib/agent-session.ts';
import _ from 'lodash';
import process from 'process';

const DEEP_SEEK_CHAT_AUTHORIZATION = process.env.DEEP_SEEK_CHAT_AUTHORIZATION;

/**
 * MCP Route Handler (2025 Streamable HTTP Standard)
 *
 * GET 和 POST 统一交给 StreamableHTTPServerTransport.handleRequest 处理。
 * SDK 内部自动处理 GET (SSE) 和 POST (JSON-RPC)。
 */
export default {
    prefix: '/mcp',

    get: {
        '': async (request: Request) => {
            if (DEEP_SEEK_CHAT_AUTHORIZATION) {
                request.headers.authorization = "Bearer " + DEEP_SEEK_CHAT_AUTHORIZATION;
            }
            request.validate('headers.authorization', _.isString);

            const tokens = chat.tokenSplit(request.headers.authorization);
            const clientId = getClientIdentity(request);
            const selectedToken = selectTokenForSession(tokens, `mcp:${clientId}`);

            const sessionId = request.headers['mcp-session-id'] || request.headers['x-mcp-session-id'];

            const ctx = (request as any)._ctx;
            const nativeReq = ctx.req;
            const nativeRes = ctx.res;

            const result = await mcpController.handleRequest(
                sessionId as string | undefined,
                selectedToken,
                nativeReq,
                nativeRes,
                undefined
            );

            const headers: Record<string, string> = {};
            if (result.newSessionId) {
                headers['MCP-Session-Id'] = result.newSessionId;
            }
            return new Response(null, { headers });
        }
    },

    post: {
        '': async (request: Request) => {
            if (DEEP_SEEK_CHAT_AUTHORIZATION) {
                request.headers.authorization = "Bearer " + DEEP_SEEK_CHAT_AUTHORIZATION;
            }
            request.validate('headers.authorization', _.isString);

            const tokens = chat.tokenSplit(request.headers.authorization);
            const clientId = getClientIdentity(request);
            const selectedToken = selectTokenForSession(tokens, `mcp:${clientId}`);

            const sessionId = request.headers['mcp-session-id'] || request.headers['x-mcp-session-id'];

            const ctx = (request as any)._ctx;
            const nativeReq = ctx.req;
            const nativeRes = ctx.res;

            const result = await mcpController.handleRequest(
                sessionId as string | undefined,
                selectedToken,
                nativeReq,
                nativeRes,
                request.body
            );

            const headers: Record<string, string> = {};
            if (result.newSessionId) {
                headers['MCP-Session-Id'] = result.newSessionId;
            }
            return new Response(null, { headers });
        }
    }
};
