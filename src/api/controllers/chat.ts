import { PassThrough } from "stream";
import _ from "lodash";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { type AuditContext, appendAuditEvent, serializeError, summarizeMessages, tapStreamForAudit } from "@/lib/audit-log.ts";
import { DeepSeekHash } from "@/lib/challenge.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { calculateTokens, calculateMessagesTokens } from "@/lib/token.ts";

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
  "X-Client-Locale": "zh_CN",
  "X-Client-Platform": "web",
  "X-Client-Version": "1.7.1",
};
let EVENT_COMMIT_ID = '6cf9c15d';
// 当前IP地址
let ipAddress = '';
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

function maskToken(token: string) {
  if (!token) return '';
  if (token.length <= 8) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function isConversationId(value: any) {
  return _.isString(value) && /[0-9a-z\-]{36}@[0-9]+/.test(value);
}

function splitConversationId(value: string) {
  if (!isConversationId(value)) return null;
  const parts = value.split('@');
  const sessionId = parts[0];
  const messageId = Number(parts[parts.length - 1]);
  if (!sessionId || !Number.isFinite(messageId)) return null;
  return { sessionId, messageId };
}

function parseDeepSeekErrorBody(bodyText: string) {
  const raw = String(bodyText || '').trim();
  const parsed = _.attempt(() => JSON.parse(raw));
  if (_.isError(parsed) || !_.isObject(parsed)) {
    return {
      raw,
      envelope: null,
      data: null,
      bizCode: undefined,
      bizMsg: '',
    };
  }

  const envelope = parsed as any;
  const data = _.get(envelope, 'data');
  return {
    raw,
    envelope,
    data,
    bizCode: _.get(data, 'biz_code') ?? _.get(envelope, 'biz_code'),
    bizMsg: String(_.get(data, 'biz_msg') || _.get(envelope, 'biz_msg') || _.get(envelope, 'msg') || '').trim(),
  };
}

function isInvalidMessageIdPayload(payload: any) {
  const bizCode = _.get(payload, 'bizCode') ?? _.get(payload, 'biz_code') ?? _.get(payload, 'data.biz_code');
  const bizMsg = String(_.get(payload, 'bizMsg') || _.get(payload, 'biz_msg') || _.get(payload, 'data.biz_msg') || '').toLowerCase();
  return bizCode === 26 || bizMsg.includes('invalid message id');
}

function createInvalidStreamResponseError(contentType: string, parsedError: any) {
  const suffix = parsedError?.bizMsg
    ? `: ${parsedError.bizMsg}`
    : parsedError?.raw
      ? `: ${parsedError.raw.slice(0, 200)}`
      : '';
  return new APIException(
    EX.API_REQUEST_FAILED,
    `Stream response Content-Type invalid: ${contentType}${suffix}`,
  ).setData(parsedError?.data || parsedError?.envelope || null);
}

async function readStreamBody(stream: any): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (handler: (value?: any) => void, value?: any) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    stream.on('data', (chunk: any) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.once('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    stream.once('close', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    stream.once('error', (error: Error) => finish(reject, error));
  });
}

function summarizeContentForLog(content: any) {
  if (_.isString(content)) {
    return {
      kind: 'text',
      length: content.length,
    };
  }

  if (_.isArray(content)) {
    return {
      kind: 'array',
      length: content.length,
      itemTypes: content.slice(0, 5).map((item) => {
        if (_.isString(item)) return 'text';
        if (_.isPlainObject(item)) return _.get(item, 'type') || 'object';
        return typeof item;
      }),
    };
  }

  if (_.isPlainObject(content)) {
    return {
      kind: _.get(content, 'type') || 'object',
      keys: Object.keys(content).slice(0, 5),
    };
  }

  return {
    kind: typeof content,
  };
}

function logMessageSummary(mode: 'stream' | 'non-stream', model: string, messages: any[]) {
  const list = _.isArray(messages) ? messages : [];
  const preview = list.slice(-8).map((message, index) => ({
    index: Math.max(list.length - 8, 0) + index,
    role: _.get(message, 'role') || 'unknown',
    content: summarizeContentForLog(_.get(message, 'content')),
  }));

  logger.info(`[CHAT ${mode.toUpperCase()}] ${JSON.stringify({
    model,
    messageCount: list.length,
    omittedMessages: Math.max(list.length - preview.length, 0),
    messages: preview,
  })}`);
}

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
  logger.info(`Refreshing token: ${maskToken(refreshToken)}`);
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
  if (!biz_data || !biz_data.chat_session)
    throw new APIException(EX.API_REQUEST_FAILED, "创建会话失败，可能是账号或IP地址被封禁");
  return biz_data.chat_session.id;
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
  retryCount = 0,
  auditContext?: AuditContext
): Promise<any> {
  return (async () => {
    logMessageSummary('non-stream', model, messages);

    // 如果引用对话ID不正确则重置引用
    if (!isConversationId(refConvId))
      refConvId = undefined;

    // 消息预处理
    const promptMessages = getPromptMessages(messages, refConvId);
    const prompt = messagesPrepare(promptMessages);
    appendAuditEvent(auditContext, 'deepseek.prompt_prepared', {
      mode: 'non-stream',
      model,
      refConvId,
      messages,
      messageSummary: summarizeMessages(messages),
      promptMessages,
      promptMessageSummary: summarizeMessages(promptMessages),
      prompt,
    });

    // 解析引用对话ID
    const parts = refConvId?.split('@') || [];
    const refSessionId = parts[0];
    const refParentMsgId = parts.length > 1 ? parts[parts.length - 1] : undefined;

    // 请求流
    const token = await acquireToken(refreshToken);

    const isSearchModel = model.includes('search');
    const isThinkingModel = model.includes('think') || model.includes('r1') || prompt.includes('深度思考') || prompt.startsWith('?') || prompt.startsWith('？');
    const isExpertModel = model.includes('expert');
    const isSilentModel = model.includes('silent');
    const isFoldModel = model.includes('fold');


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

    const payload = {
      chat_session_id: sessionId,
      parent_message_id: refParentMsgId ? parseInt(refParentMsgId) : null,
      model_type: isExpertModel ? "expert" : "default",
      prompt,
      ref_file_ids: [],
      thinking_enabled: isThinkingModel,
      search_enabled: isSearchModel,
      preempt: false
    };
    appendAuditEvent(auditContext, 'deepseek.request', {
      mode: 'non-stream',
      model,
      refConvId,
      sessionId,
      payload,
    });

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      payload,
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
      const bodyText = await readStreamBody(result.data);
      const parsedError = parseDeepSeekErrorBody(bodyText);
      appendAuditEvent(auditContext, 'deepseek.invalid_content_type', {
        mode: 'non-stream',
        contentType: result.headers['content-type'],
        bodyText,
        parsedError,
      });
      logger.error(`Invalid response Content-Type: ${result.headers["content-type"]}`);
      if (bodyText) logger.error(bodyText);
      throw createInvalidStreamResponseError(result.headers["content-type"], parsedError);
    }

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const promptTokens = calculateMessagesTokens(messages);
    const answer = await receiveStream(model, result.data, sessionId, promptTokens);
    appendAuditEvent(auditContext, 'deepseek.response', {
      mode: 'non-stream',
      sessionId,
      response: answer,
    });
    const answerContent = String(_.get(answer, 'choices[0].message.content') || '').trim();
    const answerReasoning = String(_.get(answer, 'choices[0].message.reasoning_content') || '').trim();
    if (!answerContent && !answerReasoning) {
      appendAuditEvent(auditContext, 'deepseek.empty_response', {
        mode: 'non-stream',
        sessionId,
        response: answer,
      });
      if (isConversationId(answer.id)) {
        appendAuditEvent(auditContext, 'deepseek.regenerate.from_empty_response', {
          mode: 'non-stream',
          sessionId,
          sourceConversationId: answer.id,
        });
        return regenerateCompletion(
          model,
          refreshToken,
          answer.id,
          promptTokens,
          0,
          auditContext,
          {
            thinkingEnabled: isThinkingModel,
            searchEnabled: isSearchModel,
          }
        );
      }
      throw new APIException(EX.API_REQUEST_FAILED, 'DeepSeek returned empty completion');
    }
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    return answer;
  })().catch((err: any) => {
    appendAuditEvent(auditContext, 'deepseek.error', {
      mode: 'non-stream',
      refConvId,
      retryCount,
      error: serializeError(err),
    });
    // 🌟 核心改进：处理 404 会话不存在或 Token 不匹配的情况
    if (refConvId && err.response?.status === 404) {
        logger.warn(`DeepSeek session ${refConvId} not found (404), retrying with a fresh session...`);
        return createCompletion(
            model,
            messages,
            refreshToken,
            undefined, // 丢弃失效的会话 ID
            retryCount, // 保持重试计数
            auditContext
        );
    }

    if (refConvId && isInvalidMessageIdPayload(err)) {
      throw err;
    }

    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async (): Promise<any> => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          refreshToken,
          refConvId,
          retryCount + 1,
          auditContext
        );
      })();
    }
    throw err;
  });
}

async function regenerateCompletion(
  model = MODEL_NAME,
  refreshToken: string,
  refConvId: string,
  promptTokens = 1,
  retryCount = 0,
  auditContext?: AuditContext,
  options: { thinkingEnabled?: boolean, searchEnabled?: boolean } = {}
): Promise<any> {
  return (async () => {
    const conversation = splitConversationId(refConvId);
    if (!conversation)
      throw new APIException(EX.API_REQUEST_FAILED, 'Invalid conversation id for regenerate');

    const isSearchModel = options.searchEnabled ?? model.includes('search');
    const isThinkingModel = options.thinkingEnabled ?? (model.includes('think') || model.includes('r1'));

    if (isThinkingModel) {
      const thinkingQuota = await getThinkingQuota(refreshToken);
      if (thinkingQuota <= 0) {
        throw new APIException(EX.API_REQUEST_FAILED, '深度思考配额不足');
      }
    }

    const challengeResponse = await getChallengeResponse(refreshToken, '/api/v0/chat/regenerate');
    const challenge = await answerChallenge(challengeResponse, '/api/v0/chat/regenerate');
    logger.info(`插冷鸡: ${challenge}`);

    const token = await acquireToken(refreshToken);
    const payload = {
      chat_session_id: conversation.sessionId,
      child_message_id: conversation.messageId,
      search_enabled: isSearchModel,
      thinking_enabled: isThinkingModel,
      user_options: null,
    };
    appendAuditEvent(auditContext, 'deepseek.regenerate.request', {
      model,
      refConvId,
      promptTokens,
      payload,
    });

    const result = await axios.post(
      'https://chat.deepseek.com/api/v0/chat/regenerate',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challenge,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    );

    await sendEvents(conversation.sessionId, refreshToken);

    const contentType = String(result.headers['content-type'] || '');
    if (!contentType.includes('text/event-stream')) {
      const bodyText = await readStreamBody(result.data);
      const parsedError = parseDeepSeekErrorBody(bodyText);
      appendAuditEvent(auditContext, 'deepseek.regenerate.invalid_content_type', {
        contentType,
        bodyText,
        parsedError,
        refConvId,
      });
      logger.error(`Invalid regenerate response Content-Type: ${contentType}`);
      if (bodyText) logger.error(bodyText);
      throw createInvalidStreamResponseError(contentType, parsedError);
    }

    const streamStartTime = util.timestamp();
    const answer = await receiveStream(model, result.data, conversation.sessionId, promptTokens);
    appendAuditEvent(auditContext, 'deepseek.regenerate.response', {
      model,
      refConvId,
      response: answer,
    });

    const answerContent = String(_.get(answer, 'choices[0].message.content') || '').trim();
    const answerReasoning = String(_.get(answer, 'choices[0].message.reasoning_content') || '').trim();
    if (!answerContent && !answerReasoning) {
      appendAuditEvent(auditContext, 'deepseek.regenerate.empty_response', {
        model,
        refConvId,
        response: answer,
      });
      throw new APIException(EX.API_REQUEST_FAILED, 'DeepSeek regenerate returned empty completion');
    }

    logger.success(
      `Regenerate stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    return answer;
  })().catch((err: any) => {
    appendAuditEvent(auditContext, 'deepseek.regenerate.error', {
      model,
      refConvId,
      retryCount,
      error: serializeError(err),
    });

    if (err.response?.status === 404 || isInvalidMessageIdPayload(err)) {
      throw err;
    }

    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Regenerate response error: ${err.stack}`);
      logger.warn(`Try regenerate again after ${RETRY_DELAY / 1000}s...`);
      return (async (): Promise<any> => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return regenerateCompletion(
          model,
          refreshToken,
          refConvId,
          promptTokens,
          retryCount + 1,
          auditContext,
          options,
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
  retryCount = 0,
  auditContext?: AuditContext
): Promise<any> {
  return (async () => {
    logMessageSummary('stream', model, messages);

    // 如果引用对话ID不正确则重置引用
    if (!isConversationId(refConvId))
      refConvId = undefined;

    // 消息预处理
    const promptMessages = getPromptMessages(messages, refConvId);
    const prompt = messagesPrepare(promptMessages);
    appendAuditEvent(auditContext, 'deepseek.prompt_prepared', {
      mode: 'stream',
      model,
      refConvId,
      messages,
      messageSummary: summarizeMessages(messages),
      promptMessages,
      promptMessageSummary: summarizeMessages(promptMessages),
      prompt,
    });

    // 解析引用对话ID
    const parts = refConvId?.split('@') || [];
    const refSessionId = parts[0];
    const refParentMsgId = parts.length > 1 ? parts[parts.length - 1] : undefined;

    const isSearchModel = model.includes('search');
    const isThinkingModel = model.includes('think') || model.includes('r1') || prompt.includes('深度思考') || prompt.startsWith('?') || prompt.startsWith('？');
    const isExpertModel = model.includes('expert');

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

    const payload = {
      chat_session_id: sessionId,
      parent_message_id: refParentMsgId ? parseInt(refParentMsgId) : null,
      model_type: isExpertModel ? "expert" : "default",
      prompt,
      ref_file_ids: [],
      thinking_enabled: isThinkingModel,
      search_enabled: isSearchModel,
      preempt: false
    };
    appendAuditEvent(auditContext, 'deepseek.request', {
      mode: 'stream',
      model,
      refConvId,
      sessionId,
      payload,
    });

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      payload,
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
      const bodyText = await readStreamBody(result.data);
      const parsedError = parseDeepSeekErrorBody(bodyText);
      appendAuditEvent(auditContext, 'deepseek.invalid_content_type', {
        mode: 'stream',
        contentType: result.headers['content-type'],
        bodyText,
        parsedError,
      });
      logger.error(
        `Invalid response Content-Type:`,
        result.headers["content-type"]
      );
      if (bodyText) logger.error(bodyText);
      if (refConvId && isInvalidMessageIdPayload(parsedError)) {
        throw createInvalidStreamResponseError(result.headers["content-type"], parsedError);
      }
      const transStream = new PassThrough();
      const promptTokens = calculateMessagesTokens(messages);
      const fallbackMessage = parsedError?.bizMsg || '服务暂时不可用，第三方响应错误';
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
                content: fallbackMessage,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
          created: util.unixTimestamp(),
        })}\n\n`
      );
      return tapStreamForAudit(transStream, auditContext, 'deepseek.stream.response', () => ({
        mode: 'stream',
        sessionId,
        fallback: true,
      }));
    }
    const promptTokens = calculateMessagesTokens(messages);
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    const stream = await createTransStream(model, result.data, sessionId, promptTokens, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    });
    return tapStreamForAudit(stream, auditContext, 'deepseek.stream.response', () => ({
      mode: 'stream',
      sessionId,
      refConvId,
    }));
  })().catch((err: any) => {
    appendAuditEvent(auditContext, 'deepseek.error', {
      mode: 'stream',
      refConvId,
      retryCount,
      error: serializeError(err),
    });
    // 🌟 核心改进：流式请求处理 404
    if (refConvId && err.response?.status === 404) {
        logger.warn(`DeepSeek session ${refConvId} not found (404), retrying stream with a fresh session...`);
        return createCompletionStream(
            model,
            messages,
            refreshToken,
            undefined, // 丢弃失效的会话 ID
            retryCount, // 保持重试计数
            auditContext
        );
    }

    if (refConvId && isInvalidMessageIdPayload(err)) {
      throw err;
    }

    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async (): Promise<any> => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          refreshToken,
          refConvId,
          retryCount + 1,
          auditContext
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
function stringifyMessageContent(content: any): string {
  if (_.isNil(content)) return '';
  if (_.isString(content)) return content;
  const stringifyStructuredPart = (item: any): string => {
    if (_.isString(item)) return item;
    if (!_.isObject(item)) return '';

    const type = _.get(item, 'type');
    if (type === 'text' || type === 'input_text' || type === 'output_text') return _.get(item, 'text') || '';
    if (type === 'message') return stringifyMessageContent(_.get(item, 'content'));
    if (type === 'agent_message') return _.get(item, 'text') || stringifyMessageContent(_.get(item, 'content'));
    if (type === 'reasoning') return _.get(item, 'text') || _.get(item, 'summary') || stringifyMessageContent(_.get(item, 'content'));
    if (type === 'tool_result') return `Tool result (${_.get(item, 'tool_use_id') || 'unknown'}):\n${stringifyMessageContent(_.get(item, 'content'))}`;
    if (type === 'tool_use') return `Assistant requested tool ${_.get(item, 'name') || 'unknown'}: ${JSON.stringify(_.get(item, 'input') || {})}`;
    if (type === 'function_call') return `Assistant requested tool ${_.get(item, 'name') || 'unknown'}: ${_.get(item, 'arguments') || '{}'}`;
    if (type === 'function_call_output') return `Tool result (${_.get(item, 'call_id') || 'unknown'}):\n${stringifyMessageContent(_.get(item, 'output'))}`;
    if (type === 'custom_tool_call') return `Assistant requested tool ${_.get(item, 'name') || 'unknown'}: ${_.isString(_.get(item, 'input') ?? _.get(item, 'arguments')) ? (_.get(item, 'input') ?? _.get(item, 'arguments')) : JSON.stringify((_.get(item, 'input') ?? _.get(item, 'arguments')) || {})}`;
    if (type === 'custom_tool_call_output') return `Tool result (${_.get(item, 'call_id') || _.get(item, 'id') || 'unknown'}):\n${stringifyMessageContent(_.get(item, 'output') ?? _.get(item, 'content'))}`;
    if (type === 'mcp_tool_call') {
      const server = _.get(item, 'server');
      const name = _.get(item, 'tool') || _.get(item, 'name') || 'unknown';
      const resultText = [
        stringifyMessageContent(_.get(item, 'result.content')),
        _.isNil(_.get(item, 'result.structured_content')) ? '' : JSON.stringify(_.get(item, 'result.structured_content')),
        _.get(item, 'error.message') || '',
      ].filter(Boolean).join('\n');
      if (resultText || ['completed', 'failed'].includes(String(_.get(item, 'status') || '')))
        return `Tool result (${server ? `${server}:` : ''}${name}):\n${resultText || String(_.get(item, 'status') || 'completed')}`;
      return `Assistant requested tool ${name}: ${JSON.stringify((_.get(item, 'arguments') ?? _.get(item, 'input')) || {})}`;
    }
    if (type === 'command_execution') {
      const command = String(_.get(item, 'command') || '').trim();
      const exitCode = _.has(item, 'exit_code') ? `\nExit code: ${_.get(item, 'exit_code')}` : '';
      const aggregatedOutput = String(_.get(item, 'aggregated_output') || '').trim();
      if (aggregatedOutput || _.has(item, 'exit_code') || ['completed', 'failed'].includes(String(_.get(item, 'status') || '')))
        return `Tool result (command_execution):\nCommand: ${command}${exitCode}${aggregatedOutput ? `\n${aggregatedOutput}` : ''}`.trim();
      return `Assistant requested tool shell: ${JSON.stringify({ command })}`;
    }
    if (type === 'file_change') {
      const changesList = _.get(item, 'changes');
      const changes = _.isArray(changesList)
        ? (changesList as any[]).map((change: any) => `${_.get(change, 'kind') || 'update'} ${_.get(change, 'path') || 'unknown'}`).join('\n')
        : '';
      const status = _.get(item, 'status');
      return [changes ? 'Tool result (file_change):' : '', changes, status ? `status: ${status}` : ''].filter(Boolean).join('\n');
    }
    if (type === 'web_search') {
      const query = _.get(item, 'query');
      return query ? `Assistant requested tool web_search: ${JSON.stringify({ query })}` : '';
    }
    if (type === 'todo_list') {
      const todoItems = _.get(item, 'items');
      const items = _.isArray(todoItems)
        ? (todoItems as any[]).map((todo: any) => `- [${_.get(todo, 'completed') ? 'x' : ' '}] ${_.get(todo, 'text') || _.get(todo, 'content') || ''}`).filter(Boolean).join('\n')
        : '';
      return items ? `Todo list:\n${items}` : '';
    }
    if (type === 'error') return _.get(item, 'message') || '';

    return _.get(item, 'text') || (_.has(item, 'content') ? stringifyMessageContent(_.get(item, 'content')) : '');
  };
  if (Array.isArray(content)) {
    return content
      .map(stringifyStructuredPart)
      .filter(Boolean)
      .join('\n');
  }
  if (_.isObject(content)) return stringifyStructuredPart(content) || JSON.stringify(content);
  return String(content);
}

function messageToPreparedText(message: any): string {
  const parts = [stringifyMessageContent(message.content)].filter(Boolean);

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const name = _.get(toolCall, 'function.name') || _.get(toolCall, 'name') || 'unknown';
      const args = _.get(toolCall, 'function.arguments') || _.get(toolCall, 'arguments') || '{}';
      parts.push(`Assistant requested tool ${name}: ${_.isString(args) ? args : JSON.stringify(args)}`);
    }
  }

  if (message.role === 'tool') {
    const toolUseId = message.tool_call_id || message.name || 'unknown';
    return `Tool result (${toolUseId}):\n${parts.join('\n')}`;
  }

  return parts.join('\n');
}

function messagesPrepare(messages: any[]): string {
  const processedMessages = messages.map(message => {
    let text = messageToPreparedText(message);
    // Safely remove "FINISHED" and similar artifacts from the end of history messages
    if (text.endsWith('FINISHED')) {
      text = text.substring(0, text.length - 8).trim();
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

function isToolResultLikeMessage(message: any) {
  if (!message) return false;
  if (message.role === 'tool') return true;
  const preparedText = messageToPreparedText(message).trim();
  return preparedText.startsWith('Tool result (');
}

function isAssistantToolRequestMessage(message: any) {
  if (!message || message.role !== 'assistant') return false;
  const preparedText = messageToPreparedText(message);
  return preparedText.includes('Assistant requested tool ');
}

function getPromptMessages(messages: any[], refConvId?: string) {
  if (!refConvId || messages.length <= 1) return messages;

  const systemMessages = messages.filter((message) => message?.role === 'system');
  const historyMessages = messages.filter((message) => message?.role !== 'system');
  if (!historyMessages.length) return systemMessages;

  let startIndex = historyMessages.length - 1;
  const latestMessage = historyMessages[startIndex];

  if (isToolResultLikeMessage(latestMessage)) {
    while (startIndex > 0 && isToolResultLikeMessage(historyMessages[startIndex - 1])) {
      startIndex--;
    }
    if (startIndex > 0 && isAssistantToolRequestMessage(historyMessages[startIndex - 1])) {
      startIndex--;
    }
    const previousUserIndex = _.findLastIndex(
      historyMessages.slice(0, startIndex),
      (message) => message?.role === 'user' && !isToolResultLikeMessage(message),
    );
    if (previousUserIndex !== -1) {
      startIndex = previousUserIndex;
    }
  } else {
    const latestUserIndex = _.findLastIndex(historyMessages, (message) => message?.role === 'user');
    if (latestUserIndex !== -1) {
      startIndex = latestUserIndex;
    }
  }

  const recentMessages = historyMessages.slice(startIndex);
  if (!systemMessages.length) return recentMessages;
  return [...systemMessages, ...recentMessages];
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

function getFragmentInitialContent(fragment: any) {
  if (!fragment || typeof fragment !== 'object') return '';
  return typeof fragment.content === 'string' ? fragment.content : '';
}

async function receiveStream(model: string, stream: any, refConvId?: string, promptTokens: number = 1): Promise<any> {
  const { createParser } = await import("eventsource-parser");
  logger.info(`[NON-STREAM] Receiving stream to accumulate full response for model: ${model}`);
  let accumulatedContent = "";
  let accumulatedThinkingContent = "";
  let messageId = '';
  let searchResults: any[] = [];
  const created = util.unixTimestamp();
  // Default to thinking mode for specific models if we are at the beginning of the stream
  let currentPath = (model.includes('think') || model.includes('r1')) ? 'thinking' : 'content';

  return new Promise((resolve, reject) => {
    const parser = createParser((event) => {
      try {
        if (event.type !== "event" || !event.data) return;

        const chunk = _.attempt(() => JSON.parse(event.data));
        if (_.isError(chunk)) return;

        if (chunk.response_message_id && !messageId) {
          messageId = chunk.response_message_id;
        }

        // Debug log for troubleshooting FINISHED source
        if (typeof chunk.v === 'string' && chunk.v.includes('FINISHED')) {
          logger.info(`[DEBUG] Received FINISHED chunk. Path: ${chunk.p}, Value: ${chunk.v}, CurrentPath: ${currentPath}`);
        }

        // === DEBUG: Log ALL chunks with path for protocol analysis ===
        if (chunk.p) {
          const vType = Array.isArray(chunk.v) ? `array[${chunk.v.length}]` : typeof chunk.v;
          const vPreview = Array.isArray(chunk.v) ? JSON.stringify(chunk.v.map((item: any) => ({ type: item.type, id: item.id }))) : (typeof chunk.v === 'string' ? chunk.v.substring(0, 50) : String(chunk.v));
          logger.info(`[NON-STREAM PATH] p="${chunk.p}" o="${chunk.o || ''}" vType=${vType} vPreview=${vPreview} currentPath=${currentPath}`);
        }

        const fragments = Array.isArray(chunk.v) ? chunk.v : (chunk.v?.response?.fragments || []);
        if (fragments.length) {
          for (const fragment of fragments) {
            const fragType = fragment.type;
            if (fragType === 'THINK') currentPath = 'thinking';
            else if (fragType === 'RESPONSE') currentPath = 'content';

            const initialContent = getFragmentInitialContent(fragment);
            if (initialContent) {
              if (currentPath === 'thinking') accumulatedThinkingContent += initialContent;
              else accumulatedContent += initialContent;
            }
          }
        }

        // Update current path if specified (DeepSeek uses fragments for thinking)
        if (chunk.p) {
          if (chunk.p.includes('fragments')) {
            if (chunk.p.endsWith('/content')) {
              // Path like response/fragments/-1/content
              // currentPath should already be set by the last APPEND fragment
            }
          } else if (chunk.p.includes('thinking_content') || chunk.p.includes('thought')) {
            currentPath = 'thinking';
          } else if (chunk.p.includes('response/content')) {
            currentPath = 'content';
          }
          logger.info(`[NON-STREAM PATH] => currentPath is now: ${currentPath}`);
        }

        // Use currentPath as fallback for chunks without 'p' or for transient fragment content paths
        if (typeof chunk.v === 'string' && chunk.v !== 'FINISHED') {
          if (currentPath === 'thinking') {
            accumulatedThinkingContent += chunk.v;
          } else if (chunk.v !== 'SEARCH') {
            // Default to content for anything else
            accumulatedContent += chunk.v;
          }
        }

        // Search results: support both legacy path and new fragments-based path
        const isSearchResults = (chunk.p === 'response/search_results' || (chunk.p && chunk.p.endsWith('/results') && chunk.p.includes('fragments'))) && Array.isArray(chunk.v);
        if (isSearchResults) {
          if (chunk.o !== 'BATCH') { // Initial search results
            if (searchResults.length === 0) {
              searchResults = chunk.v;
            } else {
              searchResults = [...searchResults, ...chunk.v];
            }
          } else { // BATCH update for search results (title, url, etc.)
            chunk.v.forEach((op: any) => {
              const match = op.p.match(/\/(\d+)\/(\w+)$/);
              if (match) {
                const index = parseInt(match[1], 10);
                const key = match[2];
                if (searchResults[index]) {
                  searchResults[index][key] = op.v;
                } else {
                  searchResults[index] = { [key]: op.v };
                }
              }
            });
          }
        }
      } catch (err) {
        logger.error(`[NON-STREAM] Error parsing chunk: ${err}`);
      }
    });

    stream.on("data", (buffer: Buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err: Error) => reject(err));
    stream.once("close", () => {
      logger.info(`[NON-STREAM] Stream closed. Content len: ${accumulatedContent.length}, Thinking len: ${accumulatedThinkingContent.length}`);
      // Debug: Log if FINISHED is ending up in content
      if (accumulatedContent.endsWith('FINISHED')) {
        logger.warn(`[NON-STREAM] WARNING: Content ends with FINISHED! Accumulated: ${accumulatedContent.slice(-20)}`);
      }
      const completionTokens = calculateTokens(accumulatedContent + accumulatedThinkingContent);
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
            citations: searchResults
              .filter(r => r.cite_index)
              .sort((a, b) => a.cite_index - b.cite_index)
              .map(r => ({
                index: r.cite_index,
                title: r.title,
                url: r.url
              }))
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
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
async function createTransStream(model: string, stream: any, refConvId: string, promptTokens: number = 1, endCallback?: Function) {
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
  // Default to thinking mode for specific models if we are at the beginning of the stream
  let currentPath = (model.includes('think') || model.includes('r1')) ? 'thinking' : 'content';
  let searchResults: any[] = [];
  let thinkingStarted = false;
  let accumulatedContent = "";
  let accumulatedThinkingContent = "";

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
            .map(r => `**${r.cite_index}.** [${r.title}](${r.url})`)
            .join('\n');
          if (citations) {
            const citationContent = `\n\n${citations}`;
            transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: citationContent }, finish_reason: null }], created })}\n\n`);
          }
        }
        const completionTokens = calculateTokens(accumulatedContent + accumulatedThinkingContent);
        transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }, created })}\n\n`);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
        return;
      }

      if (!event.data) return;

      const chunk = _.attempt(() => JSON.parse(event.data));
      if (_.isError(chunk)) return;

      if (chunk.response_message_id && !messageId) messageId = chunk.response_message_id;

      // === DEBUG: Log ALL chunks with path for protocol analysis ===
      if (chunk.p) {
        const vType = Array.isArray(chunk.v) ? `array[${chunk.v.length}]` : typeof chunk.v;
        const vPreview = Array.isArray(chunk.v) ? JSON.stringify(chunk.v.map((item: any) => ({ type: item.type, id: item.id }))) : (typeof chunk.v === 'string' ? chunk.v.substring(0, 50) : String(chunk.v));
        logger.info(`[STREAM PATH] p="${chunk.p}" o="${chunk.o || ''}" vType=${vType} vPreview=${vPreview} currentPath=${currentPath}`);
      }

      let fragmentInitialDeltas: Array<{ content: string, path: 'thinking' | 'content' }> = [];
      const fragments = Array.isArray(chunk.v) ? chunk.v : (chunk.v?.response?.fragments || []);
      if (fragments.length) {
        for (const fragment of fragments) {
          const fragType = fragment.type;
          if (fragType === 'THINK') currentPath = 'thinking';
          else if (fragType === 'RESPONSE') currentPath = 'content';

          const initialContent = getFragmentInitialContent(fragment);
          if (initialContent) {
            fragmentInitialDeltas.push({ content: initialContent, path: currentPath === 'thinking' ? 'thinking' : 'content' });
            if (currentPath === 'thinking') accumulatedThinkingContent += initialContent;
            else accumulatedContent += initialContent;
          }
        }
      }

      if (chunk.p) {
        if (chunk.p.includes('fragments')) {
            // Note: If it's fragments/.../content, currentPath is already sticky
        } else if (chunk.p.includes('thinking_content') || chunk.p.includes('thought')) {
          currentPath = 'thinking';
        } else if (chunk.p.includes('response/content')) {
          currentPath = 'content';
        }
        logger.info(`[STREAM PATH] => currentPath is now: ${currentPath}`);
      }

      for (const fragmentDelta of fragmentInitialDeltas) {
        const delta: { role?: string, content?: string, reasoning_content?: string } = {};
        if (isFirstChunk) {
          delta.role = "assistant";
          isFirstChunk = false;
        }
        const content = isSearchSilentModel
          ? fragmentDelta.content.replace(/\[citation:(\d+)\]/g, '')
          : fragmentDelta.content.replace(/\[citation:(\d+)\]/g, '[$1]');
        if (fragmentDelta.path === 'thinking') {
          if (isSilentModel) continue;
          if (isFoldModel) {
            if (!thinkingStarted) {
              thinkingStarted = true;
              delta.content = `<details><summary>思考过程</summary>${content}`;
            } else {
              delta.content = content;
            }
          } else {
            delta.reasoning_content = content;
          }
        } else {
          if (isFoldModel && thinkingStarted) {
            delta.content = `</details>${content}`;
            thinkingStarted = false;
          } else {
            delta.content = content;
          }
        }
        transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], created })}\n\n`);
      }

      // Debug log for troubleshooting stream content
      if (typeof chunk.v === 'string' && chunk.v.includes('FINISHED')) {
        logger.info(`[STREAM DEBUG] Received FINISHED chunk. Path: ${chunk.p}, Value: ${chunk.v}, CurrentPath: ${currentPath}`);
      }

      // Search results: support both legacy path and new fragments-based path
      const isSearchResults = (chunk.p === 'response/search_results' || (chunk.p && chunk.p.endsWith('/results') && chunk.p.includes('fragments'))) && Array.isArray(chunk.v);
      if (isSearchResults) {
        if (chunk.o !== 'BATCH') { // Initial search results
          if (searchResults.length === 0) {
            searchResults = chunk.v;
          } else {
            // Merge new results into existing array to avoid overwriting earlier fragments
            searchResults = [...searchResults, ...chunk.v];
          }
          logger.info(`[STREAM SEARCH] Captured ${chunk.v.length} search results from path: ${chunk.p}`);
        } else { // BATCH update for search results (title, url, etc.)
          chunk.v.forEach((op: any) => {
            // Match any update ending in index/key (e.g., .../0/title, .../0/url, .../1/cite_index)
            const match = op.p.match(/\/(\d+)\/(\w+)$/);
            if (match) {
              const index = parseInt(match[1], 10);
              const key = match[2];
              if (searchResults[index]) {
                searchResults[index][key] = op.v;
              } else {
                // Initialize if not exists (though typically initial array sets length)
                searchResults[index] = { [key]: op.v };
              }
            }
          });
        }
        return; // We've handled this event.
      }

      // Process content only from recognized content paths (or sticky chunks without explicit path)
      const isContentPath = !chunk.p || chunk.p.includes('content') || chunk.p.includes('thought');
      if (typeof chunk.v === 'string' && chunk.v !== 'FINISHED' && isContentPath && chunk.v !== 'SEARCH') {
        const delta: { role?: string, content?: string, reasoning_content?: string } = {};
        if (isFirstChunk) {
          delta.role = "assistant";
          isFirstChunk = false;
        }

        const content = isSearchSilentModel
          ? chunk.v.replace(/\[citation:(\d+)\]/g, '')
          : chunk.v.replace(/\[citation:(\d+)\]/g, '[$1]');

        // Use sticky path logic for stream
        if (chunk.p && (chunk.p.includes('thinking') || chunk.p.includes('thought'))) {
          currentPath = 'thinking';
        } else if (chunk.p && chunk.p.includes('fragments') && chunk.p.endsWith('/content') && !chunk.v.includes('FINISHED')) {
          // If p is response/fragments/-1/content, keep current sticky path
        }
        if (currentPath === 'thinking') {
          accumulatedThinkingContent += content;
          if (isSilentModel) return;
          if (isFoldModel) {
            if (!thinkingStarted) {
              thinkingStarted = true;
              delta.content = `<details><summary>思考过程</summary>${content}`;
            } else {
              delta.content = content;
            }
          } else {
            delta.reasoning_content = content;
          }
        } else {
          // Normal content mode
          accumulatedContent += content;
          if (isFoldModel && thinkingStarted) {
            delta.content = `</details>${content}`;
            thinkingStarted = false;
          } else {
            delta.content = content;
          }
        }
        transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }], created })}\n\n`);
      }
    } catch (err) {
      logger.error(`[STREAM] Error processing chunk: ${err}`);
      !transStream.closed && transStream.end("data: [DONE]\n\n");
    }
  });

  stream.on("data", (buffer: Buffer) => parser.feed(buffer.toString()));
  stream.once("error", (err: Error) => {
    logger.error(`[STREAM] Stream error: ${err}`);
    !transStream.closed && transStream.end("data: [DONE]\n\n");
  });
  stream.once("close", () => {
    if (!transStream.closed) {
      // Close fold tag if thinking was in progress
      if (isFoldModel && thinkingStarted) {
        transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "</details>" }, finish_reason: null }], created })}\n\n`);
      }
      // Append search citations
      if (searchResults.length > 0 && !isSearchSilentModel) {
        const citations = searchResults
          .filter(r => r.cite_index)
          .sort((a, b) => a.cite_index - b.cite_index)
          .map(r => `**${r.cite_index}.** [${r.title}](${r.url})`)
          .join('\n');
        if (citations) {
          const citationContent = `\n\n**Citations:**\n${citations}`;
          transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: citationContent }, finish_reason: null }], created })}\n\n`);
        }
      }
      transStream.write(`data: ${JSON.stringify({ id: `${refConvId}@${messageId}`, model, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], created })}\n\n`);
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
 * 自动从官网获取最新版本和 Commit ID
 */
async function fetchLatestVersion(): Promise<string> {
  try {
    logger.info('正在从官网自动获取最新版本信息...');
    const response = await axios.get('https://chat.deepseek.com/', {
      timeout: 10000,
      headers: { ...FAKE_HEADERS },
      validateStatus: () => true,
    });
    
    if (response.status !== 200 || !response.data) {
      logger.warn(`获取官网首页失败, 状态码: ${response.status}`);
      return EVENT_COMMIT_ID;
    }

    const html = response.data.toString();
    
    // 1. 提取 Commit ID
    const commitIdMatch = html.match(/<meta name="commit-id" content="(.*?)">/);
    if (commitIdMatch && commitIdMatch[1]) {
      EVENT_COMMIT_ID = commitIdMatch[1];
      logger.success(`获取 Commit ID 成功: ${EVENT_COMMIT_ID}`);
    }

    // 2. 尝试从 JS 资源文件中提取 X-App-Version 和 X-Client-Version
    const jsUrlMatch = html.match(/src="([^"]*?main\.[a-z0-9]+\.js)"/i);
    if (jsUrlMatch && jsUrlMatch[1]) {
      let jsUrl = jsUrlMatch[1];
      if (!jsUrl.startsWith('http')) {
        jsUrl = `https://chat.deepseek.com${jsUrl}`;
      }
      
      logger.info(`发现主 JS 文件: ${jsUrl}`);
      const jsResponse = await axios.get(jsUrl, { timeout: 15000 }).catch((e) => {
        logger.error(`抓取 JS 文件失败: ${e.message}`);
        return null;
      });
      if (jsResponse && jsResponse.data) {
        const jsContent = jsResponse.data.toString();
        logger.info(`成功读取 JS 文件, 长度: ${jsContent.length}`);
        
        const appVersionMatch = jsContent.match(/appVersion\s*:\s*["'](.*?)["']/i);
        if (appVersionMatch && appVersionMatch[1]) {
          FAKE_HEADERS["X-App-Version"] = appVersionMatch[1];
          logger.success(`获取 X-App-Version 成功: ${FAKE_HEADERS["X-App-Version"]}`);
        } else {
          logger.warn('未能从 JS 中找到 AppVersion');
        }

        const clientVersionMatch = jsContent.match(/clientVersion\s*:\s*["'](.*?)["']/i) || jsContent.match(/version\s*:\s*["'](\d+\.\d+\.\d+)["']/i);
        if (clientVersionMatch && clientVersionMatch[1]) {
           FAKE_HEADERS["X-Client-Version"] = clientVersionMatch[1];
           logger.success(`获取 X-Client-Version 成功: ${FAKE_HEADERS["X-Client-Version"]}`);
        } else {
          logger.warn('未能从 JS 中找到 ClientVersion');
        }
      }
    }
  } catch (err: any) {
    logger.error('自动补全版本信息失败:', err.message);
  }
  return EVENT_COMMIT_ID;
}

function autoUpdateVersion() {
  fetchLatestVersion();
}

util.createCronJob('0 */10 * * * *', autoUpdateVersion).start();

getIPAddress().then(() => {
  autoUpdateVersion();
}).catch((err) => {
  logger.error('获取 IP 地址失败:', err);
});

export default {
  createCompletion,
  createCompletionStream,
  regenerateCompletion,
  getTokenLiveStatus,
  tokenSplit,
  fetchAppVersion: fetchLatestVersion,
};
