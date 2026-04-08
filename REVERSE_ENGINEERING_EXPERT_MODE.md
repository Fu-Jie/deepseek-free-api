# DeepSeek 专家模式 (Expert Mode) 逆向工程详细分析报告

## 1. 分析背景 (Background)

DeepSeek 官方 Web UI 最近推出了“专家模式”。为了让开源 API 能够同步支持该核心功能，我们启动了本次逆向分析任务，旨在识别开启专家模式后 API 请求参数的变化。

## 2. 逆向分析详细步骤 (Step-by-Step Analysis)

### 步骤 1：建立基准 (Establishing Baseline)

- **动作**：在 DeepSeek 常规会话中发送一条测试消息。
- **观察**：通过浏览器开发者工具（Network 标签）捕获 `POST /api/v0/chat/completion` 请求。
- **结果**：请求体中不包含 `model_type` 参数，或者其值为 `"default"`。

### 步骤 2：环境监测与动作捕捉 (UI Interaction)

- **动作**：使用浏览器子代理定位 UI 中的模式切换开关。
- **路径**：在侧边栏或模型选择器中找到了“专家模式” (Expert Mode) 切换器。
- **触发**：点击启用该模式。

### 步骤 3：流量拦截与参数对比 (Traffic Interception)

- **动作**：在启用专家模式的状态下，再次发送相同的测试消息。
- **分析对比**：
  - **Endpoint**: 依然是 `https://chat.deepseek.com/api/v0/chat/completion`。
  - **Header**: 发现 `Proof of Work (PoW)` 挑战机制依然存在且逻辑一致。
  - **Payload 差异**：
    - 发现 JSON 请求体中新增了 `"model_type": "expert"` 项。
    - 观察到 `thinking_enabled` 往往被强制设置为 `true`。

### 步骤 4：参数有效性验证 (Validation)

- **动作**：构建构造请求，手动将 `model_type` 改为其他非法值，观察服务器响应结果。
- **观察**：服务器返回错误或回退到默认模式。
- **确认**：关键差异点确认为 `model_type` 字段及其对应值 `"expert"`。

## 3. 核心技术发现 (Technical Findings)

| 维度 | 普通模式 (Default) | 专家模式 (Expert) |
| :--- | :--- | :--- |
| **API 参数** | `"model_type": "default"` | **`"model_type": "expert"`** |
| **深度思考** | 可选 | 默认锁定开启 |
| **响应特征** | 标准 SSE 流 | 首帧声明 expert 模型类型 |

## 4. 结论与实施方案 (Conclusion)

### 实施逻辑

在项目的 `chat.ts` 逻辑中：

1. 增加对模型字符串的正则匹配（检测 `-expert`）。
2. 在组装 `axios` 请求体时，根据匹配结果动态注入 `model_type`。

## 5. 详细抓包脚本与逻辑 (Detailed Capture Scripts)

为了实现精准抓包，浏览器子代理执行了以下核心逻辑：

### A. 元素探测与模式切换 (DOM Manipulation)

子代理在浏览器控制台中运行了 JavaScript 来定位并触发专家模式开关：

```javascript
// 搜索并定位“专家模式” UI 元素
const expertToggle = Array.from(document.querySelectorAll('div, button'))
  .find(el => el.innerText.includes('专家模式') || el.innerText.includes('Expert'));

if (expertToggle) {
  console.log('目标元素坐标:', expertToggle.getBoundingClientRect());
  // 模拟触发点击
  expertToggle.click();
}
```

### B. 流量拦截逻辑 (Network Interception)

底层利用 Playwright 监听所有的 `XHR/Fetch` 请求，特别是针对 `completion` 接口的拦截：

```javascript
// 拦截逻辑伪代码
page.on('request', request => {
  if (request.url().includes('/api/v0/chat/completion')) {
    const postData = JSON.parse(request.postData());
    // 重点提取 model_type 字段
    if (postData.model_type) {
      console.log('[Capture] Detected model_type:', postData.model_type);
    }
  }
});
```

### C. 抓包指令序列 (Action Timeline)

1. **基准采样**：在默认模式下发送消息，确认为 `model_type: "default"` 或缺失。
2. **状态注入**：通过视觉识别定位开关坐标，执行模拟点击。
3. **特征对比**：在专家模式状态下触发会话，通过 `browser_list_network_requests` 导出最新的请求载荷，最终确认 `expert` 关键字。

## 6. 发送消息的详细 API 逻辑 (DeepSeek Chat API Internals)

基于抓包分析，Web 端向后端发送消息的具体逻辑如下：

### A. 请求定义 (Request Definition)

- **URL**: `https://chat.deepseek.com/api/v0/chat/completion`
- **Method**: `POST`
- **Content-Type**: `application/json`

### B. 常规请求头 (Mandatory Headers)

除了标准的浏览器头外，必须包含以下关键字段：

- `Authorization`: `Bearer <Access_Token>`
- `X-Ds-Pow-Response`: 该字段包含 PoW (Proof of Work) 挑战的答案，用于防暴力破解。

### C. 数据载荷 (JSON Payload Detail)

```json
{
  "chat_session_id": "97e6...",   // 会话唯一标识符 (UUID)
  "parent_message_id": 2,         // 重要：必须为数字类型 (u32)，用于接续上下文
  "prompt": "你好",               // 用户输入的内容
  "ref_file_ids": [],             // 引用文件的 ID 列表
  "model_type": "expert",         // 专家模式开关
  "search_enabled": false,        // 是否开启联网搜索
  "thinking_enabled": true,       // 是否开启深度思考 (R1)
  "preempt": false                // 预抢占标志
}
```

### D. 响应处理 (Response Mechanism)

- **响应格式**: `text/event-stream` (Server-Sent Events)
- **数据处理**: 客户端通过解析 SSE 流中的 JSON 片段，逐步拼接出 `content`（普通回复）和 `reasoning_content`（思考过程）。

### E. 常见故障点 (Troubleshooting)

1. **Missing `chat_session_id`**:
    - **故障原因**：DeepSeek 悄然更新了 `chat_session/create` 接口的返回结构。
    - **修复方案**：将 ID 提取逻辑从 `biz_data.id` 改为 `biz_data.chat_session.id`。

2. **`parent_message_id` 类型错误**:
    - **故障表现**：多轮对话时服务器返回 `octet-stream` 或 `Failed to deserialize`。
    - **技术细节**：2026 协议要求该字段必须是 **数字 (Number)** 而非字符串。
    - **修复方案**：在 Payload 组装阶段使用 `parseInt()` 强制转换。

## 7. 连续对话与上下文关联 (Multi-turn Context)

通过 2026 年最新的协议抓包确认，实现连续对话的关键逻辑如下：

- **首轮对话**：`parent_message_id` 设为 `null`，系统返回 `chat_session_id`。
- **后续对话**：
  1. **会话维持**：必须携带相同的 `chat_session_id`。
  2. **溯源关联**：`parent_message_id` 需设为前一轮官方响应消息的序号（通常从 2 开始递增）。
- **ID 封装格式**：本项目采用 `session_id@parent_message_id` 的复合 ID 格式向 OpenAI 客户端兼容，内部逻辑会自动拆解并注入到上述 JSON 载荷中。

### 报告总结
本项目已全面适配 DeepSeek 2026 专家模式。
