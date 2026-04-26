# DeepSeek Free API 服务 (持续维护版)

> **⚠️ 说明**: 原项目 `llm-red-team/deepseek-free-api` 已归档停止维护。本项目为 **接替维护版本**，旨在修复因 DeepSeek 官网更新导致的协议不兼容问题（如 `ERR_INVALID_CHAR` 和 `FINISHED` 状态码泄露），确保服务持续可用。

> [!IMPORTANT]
> **新项目推荐**：基于小米大模型官网逆向、原生支持 HTTP MCP 协议的新一代网关 [MiMo Free API MCP](https://github.com/Fu-Jie/mimo-free-api-mcp) 现已发布，欢迎体验！


<span>[ 中文 | <a href="README_EN.md">English</a> ]</span>

[![](https://img.shields.io/github/license/Fu-Jie/deepseek-free-api.svg)](LICENSE)
![](https://img.shields.io/github/stars/Fu-Jie/deepseek-free-api.svg)
![](https://img.shields.io/github/forks/Fu-Jie/deepseek-free-api.svg)
![](https://img.shields.io/badge/Docker-ghcr.io/fu--jie/deepseek--free--api-blue)

# 支持我 ❤️

本项目是基于 DeepSeek 服务的 API 适配器，而更强大的 AI 体验离不开优秀的前端界面。

如果你正在寻找如何更好地使用 Open WebUI，或者发现更多实用的 AI 插件与工具，欢迎访问我的核心项目：

👉 **[Awesome Open WebUI](https://github.com/Fu-Jie/awesome-openwebui)**

汇集了 Open WebUI 的最佳实践、插件、教程与资源。如果你觉得本项目解决了你的燃眉之急，不妨去那里点个 Star ⭐️ 支持一下！
## 支持详情

### 1. 支持模型列表

本项目通过解析模型名称中的关键字，动态注入官方对应的协议参数。各功能可自由排列组合：

| 模型名称 (Model ID) | 对应后端版本 | 专家模式 | 深度思考 | 联网搜索 | 说明 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `deepseek` | **V4-Flash** | ❌ | ❌ | ❌ | 基础对话模式 |
| `deepseek-expert` | **V4-Pro** | ✅ | ❌ | ❌ | **推荐**：专家增强模式 (1M 上下文, Agent 优化) |
| `deepseek-r1` | **V4-Flash** | ❌ | ✅ | ❌ | 官方 R1 深度思考模式 |
| `deepseek-search` | **V4-Flash** | ❌ | ❌ | ✅ | 官方联网搜索模式 |
| `deepseek-expert-r1` | **V4-Pro** | ✅ | ✅ | ❌ | **顶级推理**：V4 Pro + 深度思考 |
| `deepseek-expert-search` | **V4-Pro** | ✅ | ❌ | ✅ | V4 Pro + 联网搜索 |
| `deepseek-r1-search` | **V4-Flash** | ❌ | ✅ | ✅ | 深度思考 + 联网搜索 |
| `deepseek-expert-r1-search` | **V4-Pro** | ✅ | ✅ | ✅ | **最强形态**：V4 Pro + 思考 + 搜索 |

> **映射逻辑**：无需更改模型名称。系统会自动识别：包含 `expert` 即调用 **V4-Pro**；不包含则默认调用 **V4-Flash**。包含 `think` 或 `r1` 开启思考，包含 `search` 开启搜索。后缀支持 `-silent` 和 `-fold` 模式。

### 2. 快捷触发 (Magic Triggers)

无需更换模型名，您可以通过以下方式在任何模型下触发深度思考：

- 提示词以 `?` 或 `？` 开头。
- 提示词包含 `深度思考` 四个字。

### 3. 连续对话 (Continuous Conversation)

本项目支持通过 `conversation_id` 实现原生的连续对话（即利用 DeepSeek 服务端的记忆，而非通过客户端上传历史 `messages`）。

- **使用方法**：在 OpenAI 兼容请求的 `body` 中加入 `"conversation_id": "YOUR_ID"`。
- **ID 来源**：每一轮 API 响应体的 `id` 字段即为下一轮所需的 `conversation_id`。
- **ID 格式说明**：内部格式为 `session_id@parent_message_id`。
  - `session_id`: 官方会话的 UUID。
  - `parent_message_id`: 上一轮消息的序号（2026 协议要求必须为数字类型，代理层已处理）。
- **优势**：
  - **节省流量**：无需向服务器重复发送历史聊天记录。
  - **原生体验**：模型能完全继承之前的搜索结果、思考过程和专家状态。

### 4. 代码示例 (Code Examples)

#### 第一轮对话 (开启会话并设定背景)

**请求 (Request):**

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "deepseek-expert",
    "messages": [{"role": "user", "content": "讲一个关于穿红色宇航服的小猫在火星探险的故事开端。"}]
  }'
```

**响应 (Response):**

```json
{
  "id": "ae123456-7890-abcd-efgh-ijklmnopqrst@2",
  "model": "deepseek-expert",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "在一片锈红色的沙丘之上，一只名叫“汤姆”的小猫正笨拙地挪动着它的四肢。它穿着一件量身定制的鲜红色宇航服..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

#### 第二轮对话 (利用 `conversation_id` 继续会话)

**请求 (Request):**

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "deepseek-expert",
    "conversation_id": "ae123456-7890-abcd-efgh-ijklmnopqrst@2",
    "messages": [{"role": "user", "content": "这只小猫的宇航服是什么颜色的？"}]
  }'
```

**响应 (Response):**

```json
{
  "id": "ae123456-7890-abcd-efgh-ijklmnopqrst@4",
  "model": "deepseek-expert",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "正如故事开头所提到的，汤姆穿着一件**鲜红色**的宇航服，这让它在火星暗淡的背景下显得格外显眼。"
      }
    }
  ]
}
```

## 最近更新

- **Agent 生态与多协议增强** (2026-04-26): 大幅提升对各类 Agent 客户端的兼容性，并修复流式输出异常。**⚠️ 注意：受逆向工程局限，工具调用不稳定，无法胜任严谨的 Agent 任务。如有条件，强烈建议充值使用 DeepSeek 官方 API 获取原生体验。**
  - **多协议端点扩展**：新增支持 OpenAI Responses API (`/v1/responses`) 和 Anthropic Messages API (`/messages`)，深度适配 **Codex CLI** 和 **Claude Code**。涵盖工具解析转换、流式响应适配，以及 `reasoning_content` 到 Anthropic thinking delta 的无缝映射。
  - **智能会话复用 (Session Reuse)**：针对未显式提供 `conversation_id` 的客户端，通过前序消息生成指纹，自动复用同一 DeepSeek 会话。大幅缓解 Agent 客户端全量历史重放带来的上下文膨胀和多会话分裂，并支持 TTL 自动清理机制。
  - **流式协议修复**：统一处理官网最新 SSE 协议中嵌套于 `v.response.fragments` 的初始片段，彻底解决部分回复开头字符丢失（如实际返回“你好”，客户端仅收到“好”）的体验 Bug。
  - **环境配置规范化**：新增项目根目录 `.env` 自动加载机制，并提供 `.env.example` 模板说明 token 及会话配置。
- **DeepSeek-V4 全面适配** (2026-04-24): 完美适配官方最新发布的 **DeepSeek-V4** 预览版。
  - 支持 `deepseek-v4-pro` 与 `deepseek-v4-flash` 模型。
  - 上下文长度上限提升至 **1M (百万级)**。
  - 优化了针对 Agent (如 Claude Code) 的响应稳定性。
  - 提示：官方已宣布 `deepseek-chat` 与 `deepseek-reasoner` 将于 2026-07-24 弃用。
- **兼容性修复** (2026-02-11): 修复了因 DeepSeek 官网更新导致的 `X-App-Version` 获取异常（`ERR_INVALID_CHAR`）的问题。
- **响应净化**: 彻底解决了响应中偶现 `FINISHED` 状态码泄露到正文的问题，现在通过严格的路径校验（Strict Path Validation）确保输出内容的纯净。
- **历史记录修复**: 自动清理历史对话中可能存在的 `FINISHED` 脏数据，防止上下文污染。
- **R1 搜索支持** (2026-02-12): 完美适配 DeepSeek R1 模型的联网搜索功能。
  - 自动解析并合并分段搜索结果。
  - 引用（Citations）将以 `**1.** [标题](链接)` 格式附加在回复末尾，确保在所有客户端可见。
  - 过滤掉 "SEARCH" 等元数据干扰，提供纯净的输出体验。
- **专家模式支持** (2026-04-08): 通过逆向官方 Web 端协议，完美适配了全新的 **“专家模式” (Expert Mode)**。
  - 自动注入 `model_type: "expert"` 参数，触发官方更强的推理能力。
  - 修正了会话创建接口的 ID 提取路径，解决了 `missing field chat_session_id` 的顽疾。
  - 详见：[DeepSeek 专家模式逆向分析报告](./REVERSE_ENGINEERING_EXPERT_MODE.md)
- **深度思考协议适配** (2025-02-24): 针对 DeepSeek 官网最新的 **Fragment-based 协议** 进行了深度适配 (v1.0.2)。
  - 完美解决 R1 模型思考过程（Thinking/Reasoning Content）与正式回答混淆的问题。
  - 实现了基于 Fragment 类型的实时状态追踪，确保思考过程被正确放入 `reasoning_content` 字段。
  - 优化了“粘性路径”解析，显著提升了流式输出的稳定性。


# 风险警告

## **近期，我们发现部分自媒体引导用户将本仓库源码或镜像部署至非个人使用渠道，并公开提供服务。此行为可能违反了DeepSeek的[《用户协议》](https://chat.deepseek.com/downloads/DeepSeek%20Terms%20of%20Use.html)。我们特此提醒，请相关自媒体和个人立即停止此类不当行为。若持续违规，DeepSeek官方将保留依法追究其法律责任的权利。**

支持高速流式输出、支持多轮对话、支持联网搜索、支持R1深度思考和静默深度思考，零配置部署，多路token支持。

与ChatGPT接口完全兼容。

## 目录

- [免责声明](#免责声明)
- [效果示例](#效果示例)
- [接入准备](#接入准备)
  - [多账号接入](#多账号接入)
- [Docker部署](#Docker部署)
  - [Docker-compose部署](#Docker-compose部署)
- [Render部署](#Render部署)
- [Vercel部署](#Vercel部署)
- [原生部署](#原生部署)
- [推荐使用客户端](#推荐使用客户端)
- [接口列表](#接口列表)
  - [对话补全](#对话补全)
  - [userToken存活检测](#userToken存活检测)
- [注意事项](#注意事项)
  - [Nginx反代优化](#Nginx反代优化)
  - [Token统计](#Token统计)
  
## 免责声明

> [!CAUTION]
> **工具调用 (Tool Calling) 警告**：本项目对工具调用的支持基于提示词模拟与正则解析，**不稳定**，且不支持原生 OpenAI Tools 协议，仅供实验性测试，请勿在生产环境使用。

**逆向API是不稳定的，建议前往DeepSeek官方 <https://platform.deepseek.com/> 付费使用API，避免封禁的风险。**

**本组织和个人不接受任何资金捐助和交易，此项目是纯粹研究交流学习性质！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

**仅限自用，禁止对外提供服务或商用，避免对官方造成服务压力，否则风险自担！**

## 效果示例

### 验明正身Demo

![验明正身](./doc/example-1.png)

### 多轮对话Demo

![多轮对话](./doc/example-2.png)

### 联网搜索Demo

![联网搜索](./doc/example-3.png)

## 接入准备

请确保您在中国境内或者拥有中国境内的个人计算设备，否则部署后可能因无法访问DeepSeek而无法使用。

从 [DeepSeek](https://chat.deepseek.com/) 获取userToken value

进入DeepSeek随便发起一个对话，然后F12打开开发者工具，从Application > LocalStorage中找到`userToken`中的value值，这将作为Authorization的Bearer Token值：`Authorization: Bearer TOKEN`

![获取userToken](./doc/example-0.png)

### 多账号接入

目前同个账号同时只能有*一路*输出，你可以通过提供多个账号的userToken value并使用`,`拼接提供：

`Authorization: Bearer TOKEN1,TOKEN2,TOKEN3`

每次请求服务会从中挑选一个。

### 环境变量（可选）

| 环境变量 | 是否必填 | 说明 |
|---|---|---|
| DEEP_SEEK_CHAT_AUTHORIZATION | 否 | 当配置了token 则使用token，未配置则需要在请求头中传递Authorization |

## Docker部署 (推荐)

我们提供自动构建的 Docker 镜像，支持 `x86_64` 和 `ARM64` 架构。

👉 **[查看所有可用镜像版本](https://github.com/Fu-Jie/deepseek-free-api/pkgs/container/deepseek-free-api)**

### Docker-compose (推荐)

创建一个 `docker-compose.yml` 文件：

```yaml
version: '3'

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

启动服务：

```shell
docker compose up -d
```

### Docker Run 命令行

```shell
docker run -it -d --init --name deepseek-free-api -p 8000:8000 -e TZ=Asia/Shanghai ghcr.io/fu-jie/deepseek-free-api:latest
```

## 其他部署方式

### Render部署

**注意：部分部署区域可能无法连接deepseek，如容器日志出现请求超时或无法连接，请切换其他区域部署！**
**注意：免费账户的容器实例将在一段时间不活动时自动停止运行，这会导致下次请求时遇到50秒或更长的延迟，建议查看[Render容器保活](https://github.com/LLM-Red-Team/free-api-hub/#Render%E5%AE%B9%E5%99%A8%E4%BF%9D%E6%B4%BB)**

1. fork本项目到你的github账号下。

2. 访问 [Render](https://dashboard.render.com/) 并登录你的github账号。

3. 构建你的 Web Service（New+ -> Build and deploy from a Git repository -> Connect你fork的项目 -> 选择部署区域 -> 选择实例类型为Free -> Create Web Service）。

4. 等待构建完成后，复制分配的域名并拼接URL访问即可。

## 推荐使用客户端

使用以下二次开发客户端接入free-api系列项目更快更简单，支持文档/图像上传！

由 [Clivia](https://github.com/Yanyutin753/lobe-chat) 二次开发的LobeChat [https://github.com/Yanyutin753/lobe-chat](https://github.com/Yanyutin753/lobe-chat)

由 [时光@](https://github.com/SuYxh) 二次开发的ChatGPT Web [https://github.com/SuYxh/chatgpt-web-sea](https://github.com/SuYxh/chatgpt-web-sea)

## 接口列表

目前支持与openai兼容的 `/v1/chat/completions` 接口，可自行使用与openai或其他兼容的客户端接入接口，或者使用 [dify](https://dify.ai/) 等线上服务接入使用。

### 对话补全

对话补全接口，与openai的 [chat-completions-api](https://platform.openai.com/docs/guides/text-generation/chat-completions-api) 兼容。

**POST /v1/chat/completions**

header 需要设置 Authorization 头部：

```
Authorization: Bearer [userToken value]
```

请求数据：

```json
{
    // model名称
    // 默认：deepseek (对应 deepseek-v4-flash)
    // 专家模式：deepseek-expert (对应 deepseek-v4-pro, 推荐)
    // 深度思考：deepseek-r1
    // 联网搜索：deepseek-search
    // --- 组合模型示例 ---
    // 专家模式 + 深度思考：deepseek-expert-r1 (V4-Pro + Reasoning)
    // 专家模式 + 联网搜索：deepseek-expert-search (V4-Pro + Search)
    // 专家模式 + 深度思考 + 联网搜索：deepseek-expert-r1-search (全功能 Pro)
    // --- 快捷触发 ---
    // 提示词以 "?" 或 "？" 开头，或包含 "深度思考" 字样时，逻辑上会自动开启深度思考模式。
    "model": "deepseek-expert",
    // 默认多轮对话基于消息合并实现，某些场景可能导致能力下降且受单轮最大token数限制
    // 如果您想获得原生的多轮对话体验，可以传入上一轮消息获得的id，来接续上下文
    // "conversation_id": "50207e56-747e-4800-9068-c6fd618374ee@2",
    "messages": [
        {
            "role": "user",
            "content": "你是谁？"
        }
    ],
    // 如果使用流式响应请设置为true，默认false
    "stream": false
}
```

响应数据：

```json
{
    "id": "50207e56-747e-4800-9068-c6fd618374ee@2",
    "model": "deepseek",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": " 我是DeepSeek Chat，一个由深度求索公司开发的智能助手，旨在通过自然语言处理和机器学习技术来提供信息查询、对话交流和解答问题等服务。"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 1,
        "completion_tokens": 1,
        "total_tokens": 2
    },
    "created": 1715061432
}
```

### userToken存活检测

检测userToken是否存活，如果存活live为true，否则为false，请不要频繁（小于10分钟）调用此接口。

**POST /token/check**

请求数据：

```json
{
    "token": "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9..."
}
```

响应数据：

```json
{
    "live": true
}
```

## 注意事项

### Nginx反代优化

如果您正在使用Nginx反向代理deepseek-free-api，请添加以下配置项优化流的输出效果，优化体验感。

```nginx
# 关闭代理缓冲。当设置为off时，Nginx会立即将客户端请求发送到后端服务器，并立即将从后端服务器接收到的响应发送回客户端。
proxy_buffering off;
# 启用分块传输编码。分块传输编码允许服务器为动态生成的内容分块发送数据，而不需要预先知道内容的大小。
chunked_transfer_encoding on;
# 开启TCP_NOPUSH，这告诉Nginx在数据包发送到客户端之前，尽可能地发送数据。这通常在sendfile使用时配合使用，可以提高网络效率。
tcp_nopush on;
# 开启TCP_NODELAY，这告诉Nginx不延迟发送数据，立即发送小数据包。在某些情况下，这可以减少网络的延迟。
tcp_nodelay on;
# 设置保持连接的超时时间，这里设置为120秒。如果在这段时间内，客户端和服务器之间没有进一步的通信，连接将被关闭。
keepalive_timeout 120;
```

### Token统计

为了在使用 OpenWebUI 等下游应用时获得更准确的统计，本项目内置了 `gpt-tokenizer` 在本地根据字符动态估算 Token 使用量。由于并非 DeepSeek 官方的分词器，可能存在轻微误差，但足以满足大多数统计需求。
