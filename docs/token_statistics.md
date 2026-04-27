# Token 统计功能说明文档

## 1. 功能背景
由于 DeepSeek 官网逆向协议不直接返回 Token 消耗数据，此前项目在 `usage` 字段中统一返回固定值 `1`。这会导致：
*   使用 **Claude Code** 或 **Codex CLI** 等 Agent 客户端时，无法准确获取上下文消耗。
*   统计类工具（如 NextChat、OpenWebUI）无法正确计算费用或额度。

为了解决此问题，项目引入了基于 `gpt-tokenizer` 的本地 Token 动态预估逻辑。

## 2. 实现原理
项目使用 `gpt-tokenizer`（采用 GPT-4o / o1 同款的 `o200k_base` 编码规则）对输入和输出内容进行实时分词计数。

*   **输入统计 (Prompt Tokens)**：对请求中的 `messages` 数组进行完整解析，统计所有 `content` 的 Token 总和。
*   **输出统计 (Completion Tokens)**：
    *   **非流式**：在获取到完整响应后，统计文本内容及“思维链（Reasoning）”内容的 Token 总和。
    *   **流式**：在流式输出结束时（`DONE` 事件前），统计已缓存的完整输出文本的 Token 数。

## 3. 多协议接口表现

### OpenAI Chat API (`/v1/chat/completions`)
标准的 OpenAI 格式，支持 `prompt_tokens`、`completion_tokens` 和 `total_tokens`。

### Anthropic Messages API (`/messages`)
适配 Claude Code 风格，将统计结果映射为：
*   `input_tokens` (对应 Prompt Tokens)
*   `output_tokens` (对应 Completion Tokens)
在流式传输中，Token 统计会分别注入 `message_start` 和 `message_delta` 事件。

### OpenAI Responses API (`/v1/responses`)
适配 Codex CLI 风格，输出包含：
*   `input_tokens`
*   `output_tokens`
*   `total_tokens`

## 4. 准确性说明
*   **估算性质**：由于 DeepSeek 官方使用的是其专有的分词器（与 OpenAI 略有不同），本地 `gpt-tokenizer` 的计算结果属于**高度接近的预估值**（通常误差在 5% 以内）。
*   **思维链消耗**：目前的统计逻辑**已包含**了 DeepSeek R1 等模型的 `reasoning_content`（思维链）部分，确保消耗统计的完整性。

## 5. 开发建议
由于 Token 计算是在服务器端内存中进行的，对于极长文本（如 100k+ Context）会有微小的计算开销。`gpt-tokenizer` 已经过性能优化，通常不会对响应延迟产生感知影响。
