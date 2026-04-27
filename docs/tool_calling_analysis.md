# 工具调用解析逻辑分析与优化文档

## 1. 概述

项目共有 3 个对外 API 接口支持工具调用（Tool Calling），分别是：

| 接口 | 路由文件 | 适配的 API 规范 | 行数（约） |
|------|---------|----------------|-----------|
| `/v1/chat/completions` | `src/api/routes/chat.ts` | OpenAI Chat Completions | ~460 |
| `/v1/messages` / `/anthropic/v1/messages` | `src/api/routes/messages.ts` | Anthropic Messages | ~690 |
| `/v1/responses` | `src/api/routes/responses.ts` | OpenAI Responses | ~920 |

## 2. 工具调用全流程

三个接口的完整工具调用链路均遵循相同的流程：

```
用户请求 → 提取 tools 参数 → 构建工具提示词 → 注入系统消息 →
→ 调用 DeepSeek 后端 API → 解析模型输出 → 转换为目标格式 → 返回
```

## 3. 共性：工具提示词注入

三个接口的 `buildToolsPrompt` 函数**完全一致**，都将工具定义转换为统一的系统提示词格式：

```
You have access to tools. When a tool is needed, do not describe the call in prose.
Output exactly one or more tool calls in this format and nothing else:
<tool_call name="ToolName">{"arg":"value"}</tool_call>
The JSON inside the tag must match the tool input schema.
Available tools:
- tool_name: description
  input_schema: {...}
```

唯一的差异在于如何从原始请求中**提取工具名称和参数**：

| 接口 | 提取工具名 | 提取输入参数 |
|------|-----------|-------------|
| Chat | `tool.type === 'function' ? tool.function.name : tool.name` | `tool.type === 'function' ? tool.function.parameters : tool.parameters` |
| Messages | `_.get(tool, 'name')` | `_.get(tool, 'input_schema') || _.get(tool, 'inputSchema')` |
| Responses | `_.get(tool, 'name') || _.get(tool, 'function.name')` | `_.get(tool, 'parameters') || _.get(tool, 'function.parameters') || _.get(tool, 'input_schema') || _.get(tool, 'inputSchema')` |

## 4. 差异：工具调用解析逻辑

### 4.1 Chat 接口（最简模式）

**解析函数**：`parseToolCallsFromContent`

**支持格式**（仅 1 种）：
- `<tool_call name="ToolName">{"arg":"value"}</tool_call>`

**特点**：
- 使用单一正则匹配 `<tool_call>` 标签
- 提取 tool call 前的文本作为 `content`，tool call 本身转为 `tool_calls`
- 输出 OpenAI 标准 `tool_calls` 格式
- 流式模式在 `[DONE]` 前额外注入一个包含 `tool_calls` 的 chunk
- `finish_reason` 设为 `'tool_calls'`

**代码位置**：`src/api/routes/chat.ts` 第 263-284 行

### 4.2 Messages 接口（中等模式）

**解析函数**：`parseToolCalls`

**支持格式**（3 种）：
1. `<tool_call name="ToolName">{"arg":"value"}</tool_call>` — 标准 XML 格式
2. `Assistant requested tool ToolName: {...}` — 自然语言格式
3. `functionName({...})` — 函数调用式

**特点**：
- 使用手动 JSON 解析器 `findJsonEnd` + `parseToolInput` 处理深层嵌套和多行 JSON
- `parseToolInput` 有 3 级回退策略：严格 JSON→控制字符转义→单字段对象
- 解析后从原文本中移除 tool call 部分得纯文本
- 输出 Anthropic `tool_use` content block
- 支持 `reasoning_content` 转为 `thinking` block
- 流式模式下有 `deferredToolMode` 机制：等 tool call 完全接收后才输出
- `stop_reason` 设为 `'tool_use'` 或 `'end_turn'`

**代码位置**：`src/api/routes/messages.ts` 第 295-350 行

### 4.3 Responses 接口（最健壮模式）

**解析函数**：`parseToolCalls`（聚合 12 个子解析器）

**支持格式**（12 种）：

| 解析器 | 匹配格式 | 用途 |
|--------|---------|------|
| `parseStandardToolCalls` | `<tool_call name="X">...</tool_call>` | 标准格式 |
| `parseDsmlToolCalls` | `<<｜DSML｜tool_calls><｜DSML｜invoke name="X">...</｜DSML｜invoke></｜DSML｜tool_calls>` | DSML 格式 |
| `parseBashToolCalls` | `<bash>...</bash>` | 终端命令 |
| `parseBashNoToolCalls` | `<bash_notool>...</bash_notool>` | 不带工具的终端命令 |
| `parseBashCommandToolCalls` | `<bash-command>...</bash-command>` | 命令行格式 |
| `parseBashToolUsageCalls` | `<bash-tool-usage>...</bash-tool-usage>` | 工具使用格式 |
| `parseBashScriptCalls` | `<bash_script>...</bash_script>` | 脚本格式 |
| `parseCommandLineToolCalls` | `<command-line>...</command-line>` | 命令行格式 |
| `parseGenericXmlToolCalls` | `<tool_calls><tool_call name="X">...</tool_call></tool_calls>` | 通用 XML |
| `parseFunctionCalls` | `<function_calls><invoke name="X">...</invoke></function_calls>` | 函数调用 XML |
| `parseBareFunctionCalls` | `<function name="X">...</function>` | 独立函数标签 |
| `parseOpenAIXmlFunctionCalls` | `<function><function_name>X</function_name><function_args>...</function_args></function>` | OpenAI XML |

**额外特性**：
- `ToolNameResolver`：工具名适配器，将 `bash`/`powershell`/`run_shell_command` 等统一映射
- `adaptToolArgs`：参数适配，当工具只接受一个参数时自动重命名
- `isInsideMarkdownFence`：忽略 Markdown 代码块内的标签
- `cleanAssistantArtifacts`：清理 `<｜Assistant｜>` 等干扰标记
- 流式 `mayBecomeToolCallPrefix`/`getPotentialToolStartIndex`：延迟输出机制
- 输出 OpenAI Responses `function_call` 格式

**代码位置**：`src/api/routes/responses.ts` 第 706-728 行

## 5. 复杂度对比

```
Chat (1 种格式)
  └── <tool_call>

Messages (3 种格式)
  ├── <tool_call>
  ├── Assistant requested tool
  └── functionName({...})

Responses (12 种格式)
  ├── <tool_call>
  ├── ｜DSML｜tool_calls / ｜DSML｜invoke
  ├── <bash> / <bash_notool> / <bash-command> / <bash-tool-usage> / <bash_script>
  ├── <command-line>
  ├── <tool_calls>
  ├── <function_calls> / <invoke>
  ├── <function> (bare + OpenAI XML)
  └── ToolNameResolver + adaptToolArgs
```

## 6. 已知问题与优化建议

### 6.1 `buildToolsPrompt` 重复定义

三个文件中存在几乎完全相同的 `buildToolsPrompt` 函数，仅工具提取逻辑有微小差异。

**影响**：维护成本高，修改提示词格式需要同步改 3 处。

**建议方案**：
1. **方案 A**：提取到 `src/lib/` 下的共享模块，统一 `buildToolsPrompt` + 可配置的工具提取器
2. **方案 B**：将 Responses 的工具提取逻辑（`getToolName`/`getToolDescription`/`getToolInputSchema`）作为标准实现，Chat 和 Messages 复用

**推荐方案 A**，建议的文件结构：

```
src/lib/
  tool-prompt.ts           # 统一的 buildToolsPrompt + 工具提取器
  tool-parser/
    chat-parser.ts         # Chat 的 parseToolCallsFromContent
    messages-parser.ts     # Messages 的 parseToolCalls
    responses-parser.ts    # Responses 的 parseToolCalls 聚合器
    common-parsers.ts      # 共享工具（findJsonEnd, decodeXmlText, parseToolInput 等）
    tool-name-resolver.ts  # ToolNameResolver + adaptToolArgs
```

### 6.2 `decodeXmlText` 重复定义

`chat.ts` 和 `responses.ts` 各自定义了相同的 `decodeXmlText` 函数。

**建议**：提取到 `src/lib/util.ts`。

### 6.3 `findJsonEnd` / `findJsonObjectEnd` 重复

`messages.ts` 的 `findJsonEnd` 和 `responses.ts` 的 `findJsonObjectEnd` 逻辑完全一致。

**建议**：统一为 `findJsonEnd`，提取到共享工具模块。

### 6.4 解析精度差异可能导致行为不一致

同一个 `<tool_call>` 标签在 3 个接口中的解析精度不同：

- Chat：仅用正则 `/([\s\S]*?)<\/tool_call>/`（惰性匹配），可能因 JSON 嵌套而截断
- Messages：`findJsonEnd` 精确匹配 `{...}` 深度，可靠性高
- Responses：`parseToolInput` + `decodeXmlText`，最稳健

**影响**：如果客户端对 3 个接口使用相同的 tools 定义，可能因解析器差异导致 Chat 接口的 tool call 参数解析异常。

**建议**：Chat 的 `parseToolCallsFromContent` 也应使用 `findJsonEnd` + `parseToolInput` 的精确解析逻辑。

### 6.5 Chat 接口缺少 Markdown 代码块过滤

Responses 通过 `isInsideMarkdownFence` 过滤了 Markdown 代码块内的 tool call 标签，Chat 和 Messages 没有此保护。

**建议**：统一添加该过滤逻辑。

## 7. 优化优先级

| 优先级 | 条目 | 理由 |
|--------|------|------|
| **P0** | 6.4 Chat 解析精度提升 | 可能导致 tool call 参数解析失败 |
| **P1** | 6.2/6.3 共享工具函数提取 | 消除重复代码，降低维护成本 |
| **P2** | 6.1 `buildToolsPrompt` 统一 | 减少提示词格式不一致风险 |
| **P3** | 6.5 Markdown 过滤统一 | 提升健壮性，非紧急 |

## 8. 每次优化时保持的测试清单

1. 普通文本对话（无 tools）
2. 单个标准 `<tool_call>` 解析
3. 多个 `<tool_call>` 并行调用
4. 嵌套 JSON 参数的 tool call
5. 流式输出中 tool call 的正确延迟和注入
6. 工具箱为空时的行为
7. reasoning_content 与 tool_calls 共存
8. Markdown 代码块内的 tool call 标签不被误解析
9. Token 绑定和故障转移
10. Session 复用场景
