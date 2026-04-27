// @ts-ignore
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
// @ts-ignore
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
// @ts-ignore
} from "@modelcontextprotocol/sdk/types.js";
import chat from "./chat.ts";
import logger from "@/lib/logger.ts";
import _ from "lodash";

interface MCPSession {
    transport: StreamableHTTPServerTransport;
    server: Server;
    token: string;
}

/**
 * MCP Server Manager - 每个 session 有独立的 transport + server
 *
 * 基于 @modelcontextprotocol/sdk 的 StreamableHTTPServerTransport，
 * handleRequest 内部自动处理 GET (SSE) 和 POST (JSON-RPC)，
 * 路由层只需调用 transport.handleRequest(req, res, req.body)。
 */
export class MCPServerManager {

    private static sessions: Record<string, MCPSession> = {};

    private static createServer(token: string): Server {
        const server = new Server(
            { name: "deepseek-free-api-mcp", version: "1.2.0" },
            { capabilities: { tools: {} } }
        );

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "search",
                    description: "Perform a web search using DeepSeek. Returns latest information with citations.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Search query" },
                        },
                        required: ["query"]
                    }
                }
            ]
        }));

        server.setRequestHandler(CallToolRequestSchema, async (call) => {
            const { name, arguments: args } = call.params;
            logger.info(`[MCP] Call tool: ${name}`);

            try {
                if (name === "search") {
                    const { query } = args as { query: string };
                    const messages = [{ role: "user", content: query }];
                    const result = await chat.createCompletion("deepseek-chat-search", messages, token) as any;

                    const content = _.get(result, 'choices[0].message.content', 'No content.');
                    const citations = _.get(result, 'choices[0].message.citations', []);
                    
                    let text = content;
                    if (citations.length > 0) {
                        const citationText = citations
                            .map((c: any) => `[${c.index}] ${c.title} (${c.url})`)
                            .join('\n');
                        text += `\n\n### References:\n${citationText}`;
                    }

                    return { content: [{ type: "text", text }] };
                }
                throw new Error(`Unknown tool: ${name}`);
            } catch (err: any) {
                return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
            }
        });

        return server;
    }

    /**
     * 获取或创建 session。
     * 如果已有 sessionId 且存在则复用；否则创建新的。
     */
    static getOrCreateSession(sessionId: string | undefined, token: string): { session: MCPSession; sessionId: string; isNew: boolean } {
        if (sessionId && this.sessions[sessionId]) {
            return { session: this.sessions[sessionId], sessionId, isNew: false };
        }

        const newSessionId = sessionId || `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const server = this.createServer(token);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
        });

        // 将 server 连接到 transport
        (server as any).connect(transport);

        transport.onclose = () => {
            logger.info(`[MCP] Session ${newSessionId} closed.`);
            delete this.sessions[newSessionId];
        };

        const mcps: MCPSession = { transport, server, token };
        this.sessions[newSessionId] = mcps;

        logger.info(`[MCP] Session created: ${newSessionId}, Token: acct_${token.slice(0, 8)}`);
        return { session: mcps, sessionId: newSessionId, isNew: true };
    }

    /**
     * 处理 HTTP 请求（GET 和 POST）。
     * 路由层调用此方法，传入 Node.js 原生的 req/res + 预解析的 body。
     */
    static async handleRequest(
        sessionIdFromHeader: string | undefined,
        token: string,
        req: any,
        res: any,
        parsedBody?: unknown
    ): Promise<{ newSessionId?: string }> {
        const { session, sessionId, isNew } = this.getOrCreateSession(sessionIdFromHeader, token);

        // 如果请求头中有 session-id，确保 transport 知道
        // @ts-ignore
        await session.transport.handleRequest(req, res, parsedBody);

        if (isNew) {
            return { newSessionId: sessionId };
        }
        return {};
    }
}

export default MCPServerManager;
