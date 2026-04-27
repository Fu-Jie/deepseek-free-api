# DeepSeek Free API 服务 (持续维护版)

> **⚠️ 说明**: 原项目 `llm-red-team/deepseek-free-api` 已归档停止维护。本项目为 **接替维护版本**，持续跟进 DeepSeek 官网协议更新。

> [!IMPORTANT]
> **新项目推荐**：基于小米大模型官网逆向、原生支持 HTTP MCP 协议的新一代网关 [MiMo Free API MCP](https://github.com/Fu-Jie/mimo-free-api-mcp) 现已发布！

<span>[ 中文 | <a href="README_EN.md">English</a> ]</span>

[![](https://img.shields.io/github/stars/Fu-Jie/deepseek-free-api.svg)](https://github.com/Fu-Jie/deepseek-free-api/stargazers)
[![](https://img.shields.io/github/forks/Fu-Jie/deepseek-free-api.svg)](https://github.com/Fu-Jie/deepseek-free-api/network/members)
[![](https://img.shields.io/badge/Docker-ghcr.io/fu--jie/deepseek--free--api-blue)](https://github.com/Fu-Jie/deepseek-free-api/pkgs/container/deepseek-free-api)

# 支持我 ❤️

如果你正在寻找 AI 插件与工具的最佳实践，欢迎访问我的核心项目：

👉 **[Awesome Open WebUI](https://github.com/Fu-Jie/awesome-openwebui)** — 汇集 Open WebUI 的最佳实践、插件、教程与资源。

---

## 特性概览

- 🚀 **多协议端点**：同时支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种 API 协议
- 🔧 **MCP 服务**：内置 Streamable HTTP MCP Server，提供 `search` 工具，适配 Cursor / Claude Desktop
- 🧠 **DeepSeek V4**：支持 V4-Flash / V4-Pro，上下文上限 **1M tokens**
- 🔍 **联网搜索**：自动解析搜索结果并附加引用
- 💭 **深度思考 (R1)**：完美适配 Fragment-based 协议，思考过程与回答严格分离
- 🔄 **智能会话复用**：基于消息指纹自动接续 DeepSeek 会话，减少 Agent 全量历史重放
- 🎯 **多 Token 支持**：逗号分隔多 Token，自动负载均衡
- 🐳 **Docker 部署**：支持 x86_64 / ARM64，一行命令启动

## 目录

- [最近更新](#最近更新)
- [免责声明](#免责声明)
- [支持详情](#支持详情)
  - [1. 模型列表](#1-模型列表)
  - [2. 快捷触发](#2-快捷触发)
  - [3. 会话复用](#3-会话复用)
  - [4. MCP 服务](#4-mcp-服务)
- [代码示例](#代码示例)
- [接入准备](#接入准备)
- [Docker 部署](#docker-部署)
- [接口列表](#接口列表)
- [环境变量](#环境变量)
- [注意事项](#注意事项)

## 最近更新

- **2026-04-28 — MCP、可观测性与会话持久化补强**：新增 `/mcp` Streamable HTTP MCP 服务，内置 `search` 工具，适配 Cursor / Claude Desktop。引入基于 SQLite 的持久化会话存储与按客户端、Token 稳定绑定的会话键策略，覆盖 Chat、Responses、Messages 与 MCP 场景。新增审计日志链路，将请求、错误与流式输出按 JSONL 写入 `logs/audit/`，并自动脱敏敏感头。补强工具调用提示词与解析器兼容性，覆盖多种 XML / JSON / DSML 样式；新增多轮工具调用回归脚本，验证三套协议在流式与非流式下的调用链路。
- **2026-04-26 — Agent 生态与多协议增强**：新增 `/v1/responses` 和 `/messages` 端点，深度适配 Codex CLI 与 Claude Code。支持工具调用解析、流式适配、`reasoning_content` 到 Anthropic thinking delta 映射。引入智能会话复用机制，通过前序消息指纹自动接续 DeepSeek 会话。修复流式输出开头字符丢失 Bug。新增 `.env` 自动加载机制。
  - ⚠️ 工具调用基于提示词模拟 + 正则解析，**不稳定**，不适合生产级 Agent 任务。如有条件，强烈建议充值使用 DeepSeek 官方 API。
- **2026-04-24 — DeepSeek-V4 全面适配**：支持 V4-Pro / V4-Flash，上下文提升至 1M tokens。
- **2026-04-08 — 专家模式支持**：逆向官方 Web 端协议，自动注入 `model_type: "expert"` 参数。
- **2026-02-12 — R1 搜索支持**：解析分段搜索结果，引用以 `**1.** [标题](链接)` 格式附加在回复末尾。
- **2026-02-11 — 兼容性修复**：修复 `ERR_INVALID_CHAR` 和 `FINISHED` 状态码泄露问题。

## 免责声明

> [!CAUTION]
> **工具调用警告**：本项目工具调用基于提示词模拟与正则解析，**不稳定**，不支持原生 OpenAI/Anthropic Tools 协议，仅供实验性测试。

> [!WARNING]
> **逆向 API 不稳定**，建议前往 [DeepSeek 官方平台](https://platform.deepseek.com/) 付费使用 API，避免封禁风险。
>
> 本组织和个人不接受任何资金捐助和交易，此项目是纯粹研究交流学习性质！
>
> **仅限自用，禁止对外提供服务或商用**，避免对官方造成服务压力，否则风险自担！

## 支持详情

### 1. 模型列表

系统通过解析模型名称中的关键字自动注入官方对应的协议参数，各功能可自由排列组合：

| 模型名称 (Model ID) | 后端版本 | 专家模式 | 深度思考 | 联网搜索 | 说明 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `deepseek` | **V4-Flash** | ❌ | ❌ | ❌ | 基础对话模式 |
| `deepseek-expert` | **V4-Pro** | ✅ | ❌ | ❌ | **推荐**：专家增强模式 |
| `deepseek-r1` | **V4-Flash** | ❌ | ✅ | ❌ | R1 深度思考模式 |
| `deepseek-search` | **V4-Flash** | ❌ | ❌ | ✅ | 联网搜索模式 |
| `deepseek-expert-r1` | **V4-Pro** | ✅ | ✅ | ❌ | V4-Pro + 深度思考 |
| `deepseek-expert-search` | **V4-Pro** | ✅ | ❌ | ✅ | V4-Pro + 联网搜索 |
| `deepseek-r1-search` | **V4-Flash** | ❌ | ✅ | ✅ | 深度思考 + 搜索 |
| `deepseek-expert-r1-search` | **V4-Pro** | ✅ | ✅ | ✅ | **最强形态**：全功能 |

> **映射逻辑**：包含 `expert` → V4-Pro，否则 V4-Flash；包含 `think`/`r1` → 开启思考；包含 `search` → 开启搜索。支持 `-silent` 和 `-fold` 后缀。

### 2. 快捷触发

无需更换模型名，以下方式可在任何模型下触发深度思考：
- 提示词以 `?` 或 `？` 开头
- 提示词包含 `深度思考` 四字

### 3. 会话复用

基于 SQLite 存储的智能会话复用机制，开启后即使客户端不传 `conversation_id`，系统也能自动接续上下文。

**环境变量**：
- `CHAT_SESSION_REUSE=true` — OpenAI Chat 接口自动复用
- `ANTHROPIC_SESSION_REUSE=true` — Anthropic 接口自动复用（默认开启）
- `RESPONSES_SESSION_REUSE=true` — OpenAI Responses 接口自动复用（默认开启）

**复用逻辑**：
- **隐式复用**：系统提取除最后一条消息外的所有历史消息生成「指纹」，匹配数据库中的旧会话自动接续
- **显式复用**：请求体传入 `conversation_id: "session_id@parent_id"`，优先级最高

**优势**：模型继承之前的搜索/思考/专家状态；仅发送最新一轮消息到官网，避免会话分裂。

### 4. MCP 服务

升级至 **2025 Streamable HTTP** 标准，适配 Cursor / Claude Desktop。

**配置示例** (`claude_desktop_config.json`)：
```json
{
  "mcpServers": {
    "deepseek-search": {
      "url": "http://localhost:8000/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

**提供的工具**：
- `search(query)` — 调用 DeepSeek 联网搜索，返回带引用的结构化资讯

## 代码示例

### OpenAI Chat Completions

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "deepseek-expert",
    "messages": [{"role": "user", "content": "你是谁？"}],
    "stream": false
  }'
```

### 多轮对话 (利用 `conversation_id`)

```bash
# 第二轮
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "deepseek-expert",
    "conversation_id": "第一轮返回的id",
    "messages": [{"role": "user", "content": "刚才说了什么？"}]
  }'
```

### OpenAI Responses (Codex CLI)

```bash
curl -X POST http://127.0.0.1:8000/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "deepseek-expert",
    "input": "查上海天气",
    "stream": false
  }'
```

### Anthropic Messages (Claude Code)

```bash
curl -X POST http://127.0.0.1:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-expert",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "你是谁？"}],
    "stream": false
  }'
```

## 接入准备

请确保您在中国境内或拥有中国境内的个人计算设备，否则部署后可能因无法访问 DeepSeek 而无法使用。

从 [DeepSeek](https://chat.deepseek.com/) 获取 `userToken`：

1. 进入 DeepSeek 发起任意对话
2. F12 打开开发者工具 → Application → LocalStorage
3. 找到 `userToken` 的 value 值
4. 作为 `Authorization: Bearer TOKEN` 使用

### 多账号接入

同个账号同时只能有一路输出，可通过逗号拼接多个 Token：

`Authorization: Bearer TOKEN1,TOKEN2,TOKEN3`

每次请求服务会从中挑选一个。

## Docker 部署

提供自动构建的 Docker 镜像，支持 `x86_64` 和 `ARM64` 架构。

👉 **[查看所有可用镜像版本](https://github.com/Fu-Jie/deepseek-free-api/pkgs/container/deepseek-free-api)**

### Docker Compose (推荐)

```yaml
services:
  deepseek-free-api:
    container_name: deepseek-free-api
    image: ghcr.io/fu-jie/deepseek-free-api:latest
    restart: always
    ports:
      - "8000:8000"
    environment:
      - TZ=Asia/Shanghai
```

```shell
docker compose up -d
```

### Docker Run

```shell
docker run -it -d --init --name deepseek-free-api \
  -p 8000:8000 \
  -e TZ=Asia/Shanghai \
  ghcr.io/fu-jie/deepseek-free-api:latest
```

## 接口列表

### `POST /v1/chat/completions` — OpenAI Chat

与 OpenAI [chat-completions-api](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) 兼容。支持流式与非流式。

```
Authorization: Bearer [userToken]
```

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `model` | string | 模型名称，见[模型列表](#1-模型列表) |
| `messages` | array | 对话消息 |
| `stream` | boolean | 是否流式输出，默认 false |
| `conversation_id` | string | 可选，接续指定会话 |

### `POST /v1/responses` — OpenAI Responses (Codex CLI)

适配 OpenAI Responses API，支持 `previous_response_id` 接续会话。

### `POST /v1/messages` — Anthropic Messages (Claude Code)

适配 Anthropic Messages API。需携带 `anthropic-version: 2023-06-01` 头。支持深度思考映射为 Anthropic thinking delta。另保留兼容别名 `POST /anthropic/v1/messages`。

### `GET /mcp` / `POST /mcp` — MCP Streamable HTTP

MCP 服务端点，提供 `search` 工具。适配 Cursor / Claude Desktop；客户端会根据 Streamable HTTP 协议同时使用 GET 和 POST。

### `POST /token/check` — Token 存活检测

```json
{"token": "eyJhbGci..."}
```
返回 `{"live": true/false}`。请勿频繁调用（间隔 ≥ 10 分钟）。

### `GET /v1/models` — 模型列表

返回可用模型 ID 列表。

## 环境变量

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DEEP_SEEK_CHAT_AUTHORIZATION` | (空) | DeepSeek userToken，多个用逗号分隔。配置后无需在请求头传 Authorization |
| `SERVER_PORT` | 8000 | 服务端口 |
| `CHAT_SESSION_REUSE` | true | 是否启用 Chat 接口会话复用 |
| `CHAT_SESSION_TTL` | 604800000 | Chat 会话缓存 TTL（毫秒），默认 7 天 |
| `ANTHROPIC_SESSION_REUSE` | true | 是否启用 Anthropic 接口会话复用 |
| `ANTHROPIC_SESSION_TTL` | 604800000 | Anthropic 会话缓存 TTL（毫秒） |
| `RESPONSES_SESSION_REUSE` | true | 是否启用 Responses 接口会话复用 |
| `RESPONSES_SESSION_TTL` | 604800000 | Responses 会话缓存 TTL（毫秒） |

参考 `.env.example` 文件进行配置。

## 注意事项

### Nginx 反代优化

如果使用 Nginx 反代，建议添加以下配置优化流式输出：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;
chunked_transfer_encoding on;
```

### Token 统计

详见 [Token 统计文档](./docs/token_statistics.md)。
