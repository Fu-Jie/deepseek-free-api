import { PassThrough } from "stream";
import _ from "lodash";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { DeepSeekHash } from "@/lib/challenge.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "deepseek-chat";
// 插冷鸡WASM文件路径
const WASM_PATH = './sha3_wasm_bg.7b9ca65ddd.wasm';
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 3600;
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Origin: "https://chat.deepseek.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://chat.deepseek.com/",
  "Sec-Ch-Ua":
    '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "X-App-Version": "20241129.1",
  "X-Client-Locale": "zh-CN",
  "X-Client-Platform": "web",
  "X-Client-Version": "1.7.0",
};
let EVENT_COMMIT_ID = '5d2f8e71';
// 当前IP地址
let ipAddress = '';
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

async function getIPAddress() {
  if (ipAddress) return ipAddress;
  const result = await axios.get('https://chat.deepseek.com/', {
    headers: {
      ...FAKE_HEADERS,
      Cookie: generateCookie()
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  const ip = result.data.match(/<meta name="ip" content="([\d.]+)">/)?.[1];
  if (!ip) throw new APIException(EX.API_REQUEST_FAILED, '获取IP地址失败');
  logger.info(`当前IP地址: ${ip}`);
  ipAddress = ip;
  return ip;
}

/**
 * 请求access_token
 *
 * 使用refresh_token去刷新获得access_token
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function requestToken(refreshToken: string) {
  if (accessTokenRequestQueueMap[refreshToken])
    return new Promise((resolve) =>
      accessTokenRequestQueueMap[refreshToken].push(resolve)
    );
  accessTokenRequestQueueMap[refreshToken] = [];
  logger.info(`Refresh token: ${refreshToken}`);
  const result = await (async () => {
    const result = await axios.get(
      "https://chat.deepseek.com/api/v0/users/current",
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    const { biz_data } = checkResult(result, refreshToken);
    const { token } = biz_data;
    return {
      accessToken: token,
      refreshToken: token,
      refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES,
    };
  })()
    .then((result) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(result)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      logger.success(`Refresh successful`);
      return result;
    })
    .catch((err) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(err)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      return err;
    });
  if (_.isError(result)) throw result;
  return result;
}

/**
 * 获取缓存中的access_token
 *
 * 避免短时间大量刷新token，未加锁，如果有并发要求还需加锁
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function acquireToken(refreshToken: string): Promise<string> {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  if (util.unixTimestamp() > result.refreshTime) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  return result.accessToken;
}

/**
 * 生成cookie
 */
function generateCookie() {
  return `intercom-HWWAFSESTIME=${util.timestamp()}; HWWAFSESID=${util.generateRandomString({
    charset: 'hex',
    length: 18
  })}; Hm_lvt_${util.uuid(false)}=${util.unixTimestamp()},${util.unixTimestamp()},${util.unixTimestamp()}; Hm_lpvt_${util.uuid(false)}=${util.unixTimestamp()}; _frid=${util.uuid(false)}; _fr_ssid=${util.uuid(false)}; _fr_pvid=${util.uuid(false)}`
}

async function createSession(model: string, refreshToken: string): Promise<string> {
  const token = await acquireToken(refreshToken);
  const result = await axios.post(
    "https://chat.deepseek.com/api/v0/chat_session/create",
    {
      character_id: null
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const { biz_data } = checkResult(result, refreshToken);
  if (!biz_data)
    throw new APIException(EX.API_REQUEST_FAILED, "创建会话失败，可能是账号或IP地址被封禁");
  return biz_data.id;
}

/**
 * 碰撞challenge答案
 * 
 * 厂商这个反逆向的策略不错哦
 * 相当于把计算量放在浏览器侧的话，用户分摊了这个计算量
 * 但是如果逆向在服务器上算，那这个成本都在服务器集中，并发一高就GG
 */
async function answerChallenge(response: any, targetPath: string): Promise<any> {
  const { algorithm, challenge, salt, difficulty, expire_at, signature } = response;
  const deepSeekHash = new DeepSeekHash();
  await deepSeekHash.init(WASM_PATH);
  const answer = deepSeekHash.calculateHash(algorithm, challenge, salt, difficulty, expire_at);
  return Buffer.from(JSON.stringify({
    algorithm,
    challenge,
    salt,
    answer,
    signature,
    target_path: targetPath
  })).toString('base64');
}

/**
 * 获取challenge响应
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function getChallengeResponse(refreshToken: string, targetPath: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.post('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    target_path: targetPath
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...FAKE_HEADERS,
      // Cookie: generateCookie()
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  const { biz_data: { challenge } } = checkResult(result, refreshToken);
  return challenge;
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  refConvId?: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z\-]{36}@[0-9]+/.test(refConvId))
      refConvId = null;

    // 消息预处理
    const prompt = messagesPrepare(messages);

    // 解析引用对话ID
    const [refSessionId, refParentMsgId] = refConvId?.split('@') || [];

    // 请求流
    const token = await acquireToken(refreshToken);

    const isSearchModel = model.includes('search');
    const isThinkingModel = model.includes('think') || model.includes('r1') || prompt.includes('深度思考');

    // 已经支持同时使用，此处注释
    // if(isSearchModel && isThinkingModel)
    //   throw new APIException(EX.API_REQUEST_FAILED, '深度思考和联网搜索不能同时使用');

    if (isThinkingModel) {
      const thinkingQuota = await getThinkingQuota(refreshToken);
      if (thinkingQuota <= 0) {
        throw new APIException(EX.API_REQUEST_FAILED, '深度思考配额不足');
      }
    }

    const challengeResponse = await getChallengeResponse(refreshToken, '/api/v0/chat/completion');
    const challenge = await answerChallenge(challengeResponse, '/api/v0/chat/completion');
    logger.info(`插冷鸡: ${challenge}`);

    // 创建会话
    const sessionId = refSessionId || await createSession(model, refreshToken);

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        prompt,
        ref_file_ids: [],
        search_enabled: isSearchModel,
        thinking_enabled: isThinkingModel
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challenge
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    // 发送事件，缓解被封号风险
    await sendEvents(sessionId, refreshToken);

    if (result.headers["content-type"].indexOf("text/event-stream") == -1) {
      result.data.on("data", buffer => logger.error(buffer.toString()));
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `Stream response Content-Type invalid: ${result.headers["content-type"]}`
      );
    }

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, result.data, sessionId);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          refreshToken,
          refConvId,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  refConvId?: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z\-]{36}@[0-9]+/.test(refConvId))
      refConvId = null;

    // 消息预处理
    const prompt = messagesPrepare(messages);

    // 解析引用对话ID
    const [refSessionId, refParentMsgId] = refConvId?.split('@') || [];

    const isSearchModel = model.includes('search');
    const isThinkingModel = model.includes('think') || model.includes('r1') || prompt.includes('深度思考');

    // 已经支持同时使用，此处注释
    // if(isSearchModel && isThinkingModel)
    //   throw new APIException(EX.API_REQUEST_FAILED, '深度思考和联网搜索不能同时使用');

    if (isThinkingModel) {
      const thinkingQuota = await getThinkingQuota(refreshToken);
      if (thinkingQuota <= 0) {
        throw new APIException(EX.API_REQUEST_FAILED, '深度思考配额不足');
      }
    }

    const challengeResponse = await getChallengeResponse(refreshToken, '/api/v0/chat/completion');
    const challenge = await answerChallenge(challengeResponse, '/api/v0/chat/completion');
    logger.info(`插冷鸡: ${challenge}`);

    // 创建会话
    const sessionId = refSessionId || await createSession(model, refreshToken);
    // 请求流
    const token = await acquireToken(refreshToken);

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        prompt,
        ref_file_ids: [],
        search_enabled: isSearchModel,
        thinking_enabled: isThinkingModel
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challenge
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    // 发送事件，缓解被封号风险
    await sendEvents(sessionId, refreshToken);

    if (result.headers["content-type"].indexOf("text/event-stream") == -1) {
      logger.error(
        `Invalid response Content-Type:`,
        result.headers["content-type"]
      );
      result.data.on("data", buffer => logger.error(buffer.toString()));
      const transStream = new PassThrough();
      transStream.end(
        `data: ${JSON.stringify({
          id: "",
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "服务暂时不可用，第三方响应错误",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        })}\n\n`
      );
      return transStream;
    }
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return await createTransStream(model, result.data, sessionId, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          refreshToken,
          refConvId,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function messagesPrepare(messages: any[]): string {
  // 处理消息内容
  const processedMessages = messages.map(message => {
    let text: string;
    if (Array.isArray(message.content)) {
      // 过滤出 type 为 "text" 的项并连接文本
      const texts = message.content
        .filter((item: any) => item.type === "text")
        .map((item: any) => item.text);
      text = texts.join('\n');
    } else {
      text = String(message.content);
    }
    return { role: message.role, text };
  });

  if (processedMessages.length === 0) return '';

  // 合并连续相同角色的消息
  const mergedBlocks: { role: string; text: string }[] = [];
  let currentBlock = { ...processedMessages[0] };

  for (let i = 1; i < processedMessages.length; i++) {
    const msg = processedMessages[i];
    if (msg.role === currentBlock.role) {
      currentBlock.text += `\n\n${msg.text}`;
    } else {
      mergedBlocks.push(currentBlock);
      currentBlock = { ...msg };
    }
  }
  mergedBlocks.push(currentBlock);

  // 添加标签并连接结果
  return mergedBlocks
    .map((block, index) => {
      if (block.role === "assistant") {
        return `<｜Assistant｜>${block.text}<｜end of sentence｜>`;
      }

      if (block.role === "user" || block.role === "system") {
        return index > 0 ? `<｜User｜>${block.text}` : block.text;
      }

      return block.text;
    })
    .join('')
    .replace(/\!\[.+\]\(.+\)/g, "");
}

/**
 * 检查请求结果
 *
 * @param result 结果
 * @param refreshToken 用于刷新access_token的refresh_token
 */
function checkResult(result: AxiosResponse, refreshToken: string) {
  if (!result.data) return null;
  const { code, data, msg } = result.data;
  if (!_.isFinite(code)) return result.data;
  if (code === 0) return data;
  if (code == 40003) accessTokenMap.delete(refreshToken);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求deepseek失败]: ${msg}`);
}

async function receiveStream(model: string, stream: any, refConvId?: string): Promise<any> {
  const { createParser } = await import("eventsource-parser");
  logger.info(`[NON-STREAM] Receiving stream to accumulate full response for model: ${model}`);
  let accumulatedContent = "";
  let accumulatedThinkingContent = "";
  let messageId = '';
  const created = util.unixTimestamp();
  let currentPath = ''; // State to track the current content type

  return new Promise((resolve, reject) => {
    const parser = createParser((event) => {
      try {
        if (event.type !== "event" || !event.data) return;

        const chunk = _.attempt(() => JSON.parse(event.data));
        if (_.isError(chunk)) return;

        if (chunk.response_message_id && !messageId) {
          messageId = chunk.response_message_id;
        }

        // Update current path if specified
        if (chunk.p === 'response/thinking_content') {
          currentPath = 'thinking';
        } else if (chunk.p === 'response/content') {
          currentPath = 'content';
        } else if (chunk.p) {
          currentPath = ''; // Reset for other paths like search_status
        }

        // Only append if the chunk's path explicitly indicates content or thinking
        if (typeof chunk.v === 'string' && chunk.v !== 'FINISHED') {
          if (chunk.p === 'response/thinking_content') {
            accumulatedThinkingContent += chunk.v;
          } else if (chunk.p === 'response/content') {
            accumulatedContent += chunk.v;
          } else if (currentPath === 'thinking' && !chunk.p) {
            // Fallback for chunks without path if we are already in a state (less likely in this API)
            accumulatedThinkingContent += chunk.v;
          } else if (currentPath === 'content' && !chunk.p) {
            accumulatedContent += chunk.v;
          }
        }
      } catch (err) {
        logger.error(`[NON-STREAM] Error parsing chunk: ${err}`);
      }
    });

    stream.on("data", (buffer: Buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => {
      logger.info(`[NON-STREAM] Stream closed. Accumulated content length: ${accumulatedContent.length}`);
      const finalResponse = {
        id: `${refConvId}@${messageId}`,
        model,
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: accumulatedContent.trim(),
            reasoning_content: accumulatedThinkingContent.trim(),
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, // Mocked
        created,
      };
      logger.success(`[NON-STREAM] Resolving with final response: ${JSON.stringify(finalResponse, null, 2)}`);
      resolve(finalResponse);
    });
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
async function createTransStream(model: string, stream: any, refConvId: string, endCallback?: Function) {
  const { createParser } = await import("eventsource-parser");
  const isThinkingModel = model.includes('think') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = (model.includes('fold') || model.includes('search')) && !isThinkingModel;
  const isSearchSilentModel = model.includes('search-silent');
  logger.info(`[STREAM] Model: ${model}, isThinking: ${isThinkingModel}, isSilent: ${isSilentModel}, isFold: ${isFoldModel}, isSearchSilent: ${isSearchSilentModel}`);

  let isFirstChunk = true;
  let messageId = '';
  const created = util.unixTimestamp();
  const transStream = new PassThrough();
  let currentPath = '';
  let searchResults: any[] = [];
  let thinkingStarted = false;

  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;

      if (event.event === 'close' || event.data.trim() === '[DONE]') {
        if (isFoldModel && thinkingStarted) {
          transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "</pre></details>" }, finish_reason: null }], created })}\n\n`);
        }
        if (searchResults.length > 0 && !isSearchSilentModel) {
          const citations = searchResults
            .filter(r => r.cite_index)
            .sort((a, b) => a.cite_index - b.cite_index)
            .map(r => `[${r.cite_index}]: [${r.title}](${r.url})`)
            .join('\n');
          if (citations) {
            const citationContent = `\n\n${citations}`;
            transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: citationContent }, finish_reason: null }], created })}\n\n`);
          }
        }
        transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], created })}\n\n`);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
        return;
      }

      if (!event.data) return;

      const chunk = _.attempt(() => JSON.parse(event.data));
      if (_.isError(chunk)) return;

      if (chunk.response_message_id && !messageId) messageId = chunk.response_message_id;

      if (chunk.p === 'response/thinking_content') currentPath = 'thinking';
      else if (chunk.p === 'response/content') currentPath = 'content';
      else if (chunk.p) currentPath = ''; // Reset for search_status etc.

      if (chunk.p === 'response/search_results' && Array.isArray(chunk.v)) {
        if (chunk.o !== 'BATCH') { // Initial search results
          searchResults = chunk.v;
        } else { // BATCH update for cite_index
          chunk.v.forEach((op: any) => {
            const match = op.p.match(/^(\d+)\/cite_index$/);
            if (match) {
              const index = parseInt(match[1], 10);
              if (searchResults[index]) {
                searchResults[index].cite_index = op.v;
              }
            }
          });
        }
        return; // We've handled this event.
      }

      if (typeof chunk.v === 'string' && chunk.v !== 'FINISHED') {
        const delta: { role?: string, content?: string, reasoning_content?: string } = {};
        if (isFirstChunk) {
          delta.role = "assistant";
          isFirstChunk = false;
        }

        const content = isSearchSilentModel
          ? chunk.v.replace(/\[citation:(\d+)\]/g, '')
          : chunk.v.replace(/\[citation:(\d+)\]/g, '[$1]');

        // Use chunk.p for strict path validation to avoid status leaks
        const targetPath = chunk.p || currentPath;

        if (targetPath === 'response/thinking_content' || targetPath === 'thinking') {
          if (isSilentModel) return;
          if (isFoldModel) {
            if (!thinkingStarted) {
              thinkingStarted = true;
              delta.content = `<details><summary>思考过程</summary><pre>${content}`;
            } else {
              delta.content = content;
            }
          } else {
            delta.reasoning_content = content;
          }
        } else if (targetPath === 'response/content' || targetPath === 'content') {
          if (isFoldModel && thinkingStarted) {
            delta.content = `</pre></details>${content}`;
            thinkingStarted = false;
          } else {
            delta.content = content;
          }
        } else {
          // If the path is not a known content path, do not output it
          return;
        }

        transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], created })}\n\n`);
      }
    } catch (err) {
      logger.error(`[STREAM] Error processing chunk: ${err}`);
      !transStream.closed && transStream.end("data: [DONE]\n\n");
    }
  });

  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once("error", (err) => {
    logger.error(`[STREAM] Stream error: ${err}`);
    !transStream.closed && transStream.end("data: [DONE]\n\n");
  });
  stream.once("close", () => {
    if (!transStream.closed) {
      transStream.end("data: [DONE]\n\n");
      endCallback && endCallback();
    }
  });

  return transStream;
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.get(
    "https://chat.deepseek.com/api/v0/users/current",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
        Cookie: generateCookie()
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  try {
    const { token } = checkResult(result, refreshToken);
    return !!token;
  }
  catch (err) {
    return false;
  }
}

async function sendEvents(refConvId: string, refreshToken: string) {
  try {
    const token = await acquireToken(refreshToken);
    const sessionId = `session_v0_${Math.random().toString(36).slice(2)}`;
    const timestamp = util.timestamp();
    const fakeDuration1 = Math.floor(Math.random() * 1000);
    const fakeDuration2 = Math.floor(Math.random() * 1000);
    const fakeDuration3 = Math.floor(Math.random() * 1000);
    const ipAddress = await getIPAddress();
    const response = await axios.post('https://chat.deepseek.com/api/v0/events', {
      "events": [
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp,
          "event_name": "__reportEvent",
          "event_message": "调用上报事件接口",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "method": "post",
            "url": "/api/v0/events",
            "path": "/api/v0/events"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 100 + Math.floor(Math.random() * 1000),
          "event_name": "__reportEventOk",
          "event_message": "调用上报事件接口成功",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "method": "post",
            "url": "/api/v0/events",
            "path": "/api/v0/events",
            "logId": util.uuid(),
            "metricDuration": Math.floor(Math.random() * 1000),
            "status": "200"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 200 + Math.floor(Math.random() * 1000),
          "event_name": "createSessionAndStartCompletion",
          "event_message": "开始创建对话",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "__referrer": "",
            "agentId": "chat",
            "thinkingEnabled": false
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 300 + Math.floor(Math.random() * 1000),
          "event_name": "__httpRequest",
          "event_message": "httpRequest POST /api/v0/chat_session/create",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "__referrer": "",
            "url": "/api/v0/chat_session/create",
            "path": "/api/v0/chat_session/create",
            "method": "POST"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 400 + Math.floor(Math.random() * 1000),
          "event_name": "__httpResponse",
          "event_message": `httpResponse POST /api/v0/chat_session/create, ${Math.floor(Math.random() * 1000)}ms, reason: none`,
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "url": "/api/v0/chat_session/create",
            "path": "/api/v0/chat_session/create",
            "method": "POST",
            "metricDuration": Math.floor(Math.random() * 1000),
            "status": "200",
            "logId": util.uuid()
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 500 + Math.floor(Math.random() * 1000),
          "event_name": "__log",
          "event_message": "使用 buffer 模式",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": ""
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 600 + Math.floor(Math.random() * 1000),
          "event_name": "chatCompletionApi",
          "event_message": "chatCompletionApi 被调用",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "scene": "completion",
            "chatSessionId": refConvId,
            "withFile": "false",
            "thinkingEnabled": "false"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 700 + Math.floor(Math.random() * 1000),
          "event_name": "__httpRequest",
          "event_message": "httpRequest POST /api/v0/chat/completion",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "url": "/api/v0/chat/completion",
            "path": "/api/v0/chat/completion",
            "method": "POST"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 800 + Math.floor(Math.random() * 1000),
          "event_name": "completionFirstChunkReceived",
          "event_message": "收到第一个 completion chunk（可以是空 chunk）",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "metricDuration": Math.floor(Math.random() * 1000),
            "logId": util.uuid()
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 900 + Math.floor(Math.random() * 1000),
          "event_name": "createSessionAndStartCompletion",
          "event_message": "创建会话并开始补全",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "agentId": "chat",
            "newSessionId": refConvId,
            "isCreateNewChat": "false",
            "thinkingEnabled": "false"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1000 + Math.floor(Math.random() * 1000),
          "event_name": "routeChange",
          "event_message": `路由改变 => /a/chat/s/${refConvId}`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "to": `/a/chat/s/${refConvId}`,
            "redirect": "false",
            "redirected": "false",
            "redirectReason": "",
            "redirectTo": "/",
            "hasToken": "true",
            "hasUserInfo": "true"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1100 + Math.floor(Math.random() * 1000),
          "event_name": "__pageVisit",
          "event_message": `访问页面 [/a/chat/s/${refConvId}] [0]：${fakeDuration1}ms`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "pathname": `/a/chat/s/${refConvId}`,
            "metricVisitIndex": 0,
            "metricDuration": fakeDuration1,
            "referrer": "none",
            "appTheme": "light"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1200 + Math.floor(Math.random() * 1000),
          "event_name": "__tti",
          "event_message": `/a/chat/s/${refConvId} TTI 上报：${fakeDuration2}ms`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "type": "warmStart",
            "referer": "",
            "metricDuration": fakeDuration2,
            "metricVisitIndex": 0,
            "metricDurationSinceMounted": 0,
            "hasError": "false"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1300 + Math.floor(Math.random() * 1000),
          "event_name": "__httpResponse",
          "event_message": `httpResponse POST /api/v0/chat/completion, ${fakeDuration3}ms, reason: none`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "url": "/api/v0/chat/completion",
            "path": "/api/v0/chat/completion",
            "method": "POST",
            "metricDuration": fakeDuration3,
            "status": "200",
            "logId": util.uuid()
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1400 + Math.floor(Math.floor(Math.random() * 1000)),
          "event_name": "completionApiOk",
          "event_message": "完成响应，响应有正常的的 finish reason",
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": "",
            "condition": "hasDone",
            "streamClosed": false,
            "scene": "completion",
            "chatSessionId": refConvId
          },
          "level": "info"
        }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
        Referer: `https://chat.deepseek.com/a/chat/s/${refConvId}`,
        Cookie: generateCookie()
      },
      validateStatus: () => true,
    });
    checkResult(response, refreshToken);
    logger.info('发送事件成功');
  }
  catch (err) {
    logger.error(err);
  }
}

/**
 * 获取深度思考配额
 */
async function getThinkingQuota(refreshToken: string) {
  try {
    const response = await axios.get('https://chat.deepseek.com/api/v0/users/feature_quota', {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        ...FAKE_HEADERS,
        Cookie: generateCookie()
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    const { biz_data } = checkResult(response, refreshToken);
    if (!biz_data) return 0;
    const { quota, used } = biz_data.thinking;
    if (!_.isFinite(quota) || !_.isFinite(used)) return 0;
    logger.info(`获取深度思考配额: ${quota}/${used}`);
    return quota - used;
  }
  catch (err) {
    logger.error('获取深度思考配额失败:', err);
    return 0;
  }
}

/**
 * 获取事件上报用的 Commit ID
 */
async function fetchEventCommitId(): Promise<string> {
  try {
    logger.info('自动获取事件 Commit ID');
    const response = await axios.get('https://chat.deepseek.com/', {
      timeout: 5000,
      validateStatus: () => true,
      headers: {
        ...FAKE_HEADERS,
        Cookie: generateCookie()
      }
    });
    if (response.status === 200 && response.data) {
      const html = response.data.toString();
      const versionMatch = html.match(/<meta name="commit-id" content="(.*?)">/);
      if (versionMatch && versionMatch[1]) {
        const commitId = versionMatch[1];
        logger.info(`获取事件 Commit ID: ${commitId}`);
        EVENT_COMMIT_ID = commitId;
        return commitId;
      }
    }
  } catch (err) {
    logger.error('获取事件 Commit ID 失败:', err);
  }
  return "5d2f8e71";
}

function autoUpdateEventCommitId() {
  fetchEventCommitId();
}

util.createCronJob('0 */10 * * * *', autoUpdateEventCommitId).start();

getIPAddress().then(() => {
  autoUpdateEventCommitId();
}).catch((err) => {
  logger.error('获取 IP 地址失败:', err);
});

export default {
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
  fetchAppVersion: fetchEventCommitId,
};
