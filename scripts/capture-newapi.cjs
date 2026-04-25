const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || process.argv[2] || 8787);
const logDir = path.resolve(process.cwd(), 'logs');
const logFile = path.join(logDir, 'newapi-capture.log');

fs.mkdirSync(logDir, { recursive: true });

function now() {
  return new Date().toISOString();
}

function redactHeaders(headers) {
  const redacted = { ...headers };
  for (const key of Object.keys(redacted)) {
    if (/authorization|api[-_]?key|token|cookie|secret/i.test(key)) {
      const value = String(redacted[key] || '');
      redacted[key] = value ? `${value.slice(0, 12)}...<redacted:${value.length}>` : value;
    }
  }
  return redacted;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeLog(entry) {
  const line = JSON.stringify(entry, null, 2);
  fs.appendFileSync(logFile, `${line}\n---\n`);
  console.log(line);
  console.log('---');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendSse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const event of events) {
    if (event.event) res.write(`event: ${event.event}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function chatCompletionResponse(body) {
  const model = body.model || 'capture-model';
  return {
    id: `chatcmpl_capture_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'capture ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function responsesResponse(body) {
  const model = body.model || 'capture-model';
  return {
    id: `resp_capture_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [{
      id: `msg_capture_${Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'capture ok', annotations: [] }],
    }],
    output_text: 'capture ok',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function anthropicResponse(body) {
  const model = body.model || 'capture-model';
  return {
    id: `msg_capture_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'capture ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const jsonBody = safeJsonParse(rawBody);
    const body = jsonBody || rawBody;
    const entry = {
      time: now(),
      remoteAddress: req.socket.remoteAddress,
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers),
      body,
      bodySummary: jsonBody ? {
        model: jsonBody.model,
        stream: jsonBody.stream,
        hasMessages: Array.isArray(jsonBody.messages),
        messagesLength: Array.isArray(jsonBody.messages) ? jsonBody.messages.length : undefined,
        hasInput: jsonBody.input != null,
        inputType: Array.isArray(jsonBody.input) ? 'array' : typeof jsonBody.input,
        toolsLength: Array.isArray(jsonBody.tools) ? jsonBody.tools.length : undefined,
        toolNames: Array.isArray(jsonBody.tools)
          ? jsonBody.tools.map((tool) => tool.name || tool.function?.name).filter(Boolean)
          : undefined,
      } : undefined,
    };

    writeLog(entry);

    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, logFile });
    }

    const stream = Boolean(jsonBody && jsonBody.stream);
    if (req.url && req.url.includes('/responses')) {
      if (stream) {
        const response = responsesResponse(jsonBody || {});
        return sendSse(res, [
          { event: 'response.created', data: { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } } },
          { event: 'response.completed', data: { type: 'response.completed', response } },
        ]);
      }
      return sendJson(res, 200, responsesResponse(jsonBody || {}));
    }

    if (req.url && req.url.includes('/messages')) {
      if (stream) {
        return sendSse(res, [
          { event: 'message_start', data: { type: 'message_start', message: anthropicResponse(jsonBody || {}) } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'capture ok' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }
      return sendJson(res, 200, anthropicResponse(jsonBody || {}));
    }

    if (stream) {
      return sendSse(res, [
        { data: { id: `chatcmpl_capture_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: jsonBody?.model || 'capture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'capture ok' }, finish_reason: null }] } },
        { data: { id: `chatcmpl_capture_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: jsonBody?.model || 'capture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      ]);
    }

    return sendJson(res, 200, chatCompletionResponse(jsonBody || {}));
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`new-api capture server listening on http://127.0.0.1:${port}`);
  console.log(`logs: ${logFile}`);
});
