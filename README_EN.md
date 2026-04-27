# DeepSeek Free API Server (Continuous Maintenance)

> **Note**: The original project `llm-red-team/deepseek-free-api` is archived. This is a **maintained fork** that keeps up with DeepSeek official protocol changes.

> [!TIP]
> **New Project**: [MiMo Free API MCP](https://github.com/Fu-Jie/mimo-free-api-mcp), a next-generation gateway based on Xiaomi LLM with native HTTP MCP support!

<span>[ <a href="README.md">Chinese</a> | English ]</span>

[![](https://img.shields.io/github/stars/Fu-Jie/deepseek-free-api.svg)](https://github.com/Fu-Jie/deepseek-free-api/stargazers) [![](https://img.shields.io/github/forks/Fu-Jie/deepseek-free-api.svg)](https://github.com/Fu-Jie/deepseek-free-api/network/members) [![](https://img.shields.io/badge/Docker-ghcr.io/fu--jie/deepseek--free--api-blue)](https://github.com/Fu-Jie/deepseek-free-api/pkgs/container/deepseek-free-api)

---

## Feature Overview

- **Multi-Protocol Endpoints**: Supports OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages APIs simultaneously
- **MCP Service**: Built-in Streamable HTTP MCP Server with `search` tool, compatible with Cursor / Claude Desktop
- **DeepSeek V4**: Supports V4-Flash / V4-Pro with up to **1M token** context window
- **Web Search**: Automatically parses search results with citations
- **Deep Thinking (R1)**: Fragment-based protocol adaptation with strict separation of thinking and response
- **Smart Session Reuse**: Fingerprint-based automatic DeepSeek session continuation, reducing Agent history replay
- **Multi-Token Support**: Comma-separated tokens with automatic load balancing
- **Docker Deployment**: Supports x86_64 / ARM64, one-command startup

## Table of Contents

- [Recent Updates](#recent-updates)
- [Disclaimer](#disclaimer)
- [Features](#features)
  - [1. Model List](#1-model-list)
  - [2. Session Reuse](#2-session-reuse)
  - [3. MCP Service](#3-mcp-service)
- [Code Examples](#code-examples)
- [Access Preparation](#access-preparation)
- [Docker Deployment](#docker-deployment)
- [API List](#api-list)
- [Environment Variables](#environment-variables)
- [Notes](#notes)

## Recent Updates

- **2026-04-28 - MCP, Observability, and Session Persistence Hardening**: Added a Streamable HTTP MCP endpoint at `/mcp` with a built-in `search` tool for Cursor and Claude Desktop. Introduced SQLite-backed persistent session storage plus stable client/token-scoped session keys across Chat, Responses, Messages, and MCP flows. Added JSONL audit logging for requests, errors, and streamed output under `logs/audit/` with automatic sensitive-header masking. Expanded tool-call prompt/parser compatibility across XML, JSON, and DSML-style outputs, and added a multi-turn regression script covering streaming and non-streaming tool calls across all three protocols.
- **2026-04-26 - Agent Ecosystem**: Added `/v1/responses` and `/messages` endpoints for Codex CLI and Claude Code. Tool call parsing, streaming adaptation, and thinking delta mapping. Smart session reuse via message fingerprinting. Fixed streaming character loss bug. Automatic `.env` loading.
  - Tool calling is prompt-simulation based and **unstable**. Not for production Agent tasks. We strongly recommend the official DeepSeek API when possible.
- **2026-04-24 - DeepSeek-V4**: V4-Pro / V4-Flash support, context to 1M tokens.
- **2026-04-08 - Expert Mode**: Reverse-engineered official web protocol.
- **2026-02-12 - R1 Search**: Citations appended as `**1.** [Title](link)`.
- **2026-02-11 - Compatibility Fix**: `ERR_INVALID_CHAR` and `FINISHED` leakage resolved.

## Disclaimer

> [!CAUTION]
> **Tool Calling Warning**: Tool calling uses prompt simulation + regex. **Unstable**, no native protocol support. Experimental only.

> [!WARNING]
> **Reverse-engineered APIs are unstable**. Use the [official DeepSeek API](https://platform.deepseek.com/) to avoid bans. This project is purely for research. **For personal use only. No public services or commercial use.**

## Features

### 1. Model List

System auto-injects protocol parameters by parsing model name keywords:

| Model ID | Backend | Expert | Thinking | Search | Description |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `deepseek` | **V4-Flash** | | | | Basic chat |
| `deepseek-expert` | **V4-Pro** | Yes | | | **Recommended** |
| `deepseek-r1` | **V4-Flash** | | Yes | | R1 thinking |
| `deepseek-search` | **V4-Flash** | | | Yes | Web search |
| `deepseek-expert-r1` | **V4-Pro** | Yes | Yes | | Pro + Thinking |
| `deepseek-expert-search` | **V4-Pro** | Yes | | Yes | Pro + Search |
| `deepseek-r1-search` | **V4-Flash** | | Yes | Yes | Think + Search |
| `deepseek-expert-r1-search` | **V4-Pro** | Yes | Yes | Yes | **Ultimate** |

> **Mapping**: `expert` > V4-Pro, else V4-Flash; `think`/`r1` > thinking; `search` > search. 

### 2. Session Reuse

SQLite-based. Auto-resumes contexts without explicit `conversation_id`.

**Env vars**: `CHAT_SESSION_REUSE=true`, `ANTHROPIC_SESSION_REUSE=true` (default on), `RESPONSES_SESSION_REUSE=true` (default on).

System fingerprints historical messages (excluding last) and matches stored sessions. Only latest turn sent to official API.

### 3. MCP Service

**2025 Streamable HTTP** standard for Cursor / Claude Desktop.

```json
{
  "mcpServers": {
    "deepseek-search": {
      "url": "http://localhost:8000/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

**Tool**: `search(query)` - DeepSeek web search with structured citations.

## Code Examples

### OpenAI Chat

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions   -H "Content-Type: application/json"   -H "Authorization: Bearer YOUR_TOKEN"   -d '{"model":"deepseek-expert","messages":[{"role":"user","content":"Who are you?"}],"stream":false}'
```

### OpenAI Responses (Codex CLI)

```bash
curl -X POST http://127.0.0.1:8000/v1/responses   -H "Content-Type: application/json"   -H "Authorization: Bearer YOUR_TOKEN"   -d '{"model":"deepseek-expert","input":"Check Shanghai weather","stream":false}'
```

### Anthropic Messages (Claude Code)

```bash
curl -X POST http://127.0.0.1:8000/v1/messages   -H "Content-Type: application/json"   -H "Authorization: Bearer YOUR_TOKEN"   -H "anthropic-version: 2023-06-01"   -d '{"model":"deepseek-expert","max_tokens":512,"messages":[{"role":"user","content":"Who are you?"}],"stream":false}'
```

## Access Preparation

Get `userToken` from [DeepSeek](https://chat.deepseek.com/): F12 > Application > LocalStorage > `userToken` value.

Multi-account: `Authorization: Bearer TOKEN1,TOKEN2,TOKEN3`

## Docker Deployment

[View all images](https://github.com/Fu-Jie/deepseek-free-api/pkgs/container/deepseek-free-api)

### Docker Compose

```yaml
services:
  deepseek-free-api:
    container_name: deepseek-free-api
    image: ghcr.io/fu-jie/deepseek-free-api:latest
    restart: always
    ports: ["8000:8000"]
    environment: {TZ: Asia/Shanghai}
```

```shell
docker compose up -d
```

### Docker Run

```shell
docker run -it -d --init --name deepseek-free-api -p 8000:8000 -e TZ=Asia/Shanghai ghcr.io/fu-jie/deepseek-free-api:latest
```

## API List

### `POST /v1/chat/completions` - OpenAI Chat

OpenAI-compatible. `Authorization: Bearer [userToken]`. Params: `model`, `messages`, `stream` (bool), `conversation_id` (optional).

### `POST /v1/responses` - OpenAI Responses (Codex CLI)

Supports `previous_response_id` session continuation.

### `POST /v1/messages` - Anthropic Messages (Claude Code)

Requires `anthropic-version: 2023-06-01` header. Thinking mapped to Anthropic thinking deltas. A compatibility alias is also exposed at `POST /anthropic/v1/messages`.

### `GET /mcp` / `POST /mcp` - MCP Streamable HTTP

MCP endpoint with `search` tool. Streamable HTTP clients will use both GET and POST on the same endpoint.

### `POST /token/check` - Token Live Check

`{"token":"..."}` returns `{"live":true/false}`. Min 10min interval.

### `GET /v1/models` - Model List

Returns available model IDs.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DEEP_SEEK_CHAT_AUTHORIZATION` | (empty) | Comma-separated userTokens. If set, no Authorization header needed |
| `SERVER_PORT` | 8000 | Server port |
| `CHAT_SESSION_REUSE` | true | Enable Chat session reuse |
| `CHAT_SESSION_TTL` | 604800000 | Chat session TTL (ms), 7 days |
| `ANTHROPIC_SESSION_REUSE` | true | Enable Anthropic session reuse |
| `ANTHROPIC_SESSION_TTL` | 604800000 | Anthropic session TTL (ms) |
| `RESPONSES_SESSION_REUSE` | true | Enable Responses session reuse |
| `RESPONSES_SESSION_TTL` | 604800000 | Responses session TTL (ms) |

See `.env.example` for reference.

## Notes

### Nginx Reverse Proxy

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;
chunked_transfer_encoding on;
```

### Token Statistics

See [Token Statistics docs](./docs/token_statistics.md).
