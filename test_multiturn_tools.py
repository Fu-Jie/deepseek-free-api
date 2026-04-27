#!/usr/bin/env python3

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:8000')
MODEL = os.environ.get('MODEL', 'deepseek-chat')
TIMEOUT = int(os.environ.get('TIMEOUT', '240'))
AUTHORIZATION = os.environ.get('AUTHORIZATION', '').strip()

OPENAI_TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'get_weather',
            'description': '查询指定城市天气',
            'parameters': {
                'type': 'object',
                'properties': {
                    'city': {'type': 'string', 'description': '城市名称'},
                },
                'required': ['city'],
            },
        },
    }
]

ANTHROPIC_TOOLS = [
    {
        'name': 'get_weather',
        'description': '查询指定城市天气',
        'input_schema': {
            'type': 'object',
            'properties': {
                'city': {'type': 'string', 'description': '城市名称'},
            },
            'required': ['city'],
        },
    }
]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def normalize_tool_name(name):
    import re
    s = re.sub(r'([a-z])([A-Z])', r'\1_\2', str(name or ''))
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', s)
    return re.sub(r'[\s-]+', '_', s).lower()


def tool_result(city, temperature, weather):
    return json.dumps(
        {
            'city': city,
            'temperature': temperature,
            'weather': weather,
            'source': 'regression-fixture',
        },
        ensure_ascii=False,
    )


def make_headers(client_id, extra=None):
    headers = {
        'Content-Type': 'application/json',
        'X-Client-Id': client_id,
    }
    if AUTHORIZATION:
        headers['Authorization'] = AUTHORIZATION
    if extra:
        headers.update(extra)
    return headers


def post_json(path, payload, headers):
    url = urllib.parse.urljoin(BASE_URL.rstrip('/') + '/', path.lstrip('/'))
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(url, data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read().decode('utf-8')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        raw = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'{path} -> HTTP {error.code}: {raw}') from error


def post_stream(path, payload, headers):
    """POST a streaming request and collect all SSE events as (event_name, data) tuples."""
    url = urllib.parse.urljoin(BASE_URL.rstrip('/') + '/', path.lstrip('/'))
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    events = []
    current_event = None
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            for raw_line in resp:
                line = raw_line.decode('utf-8').rstrip('\n')
                if line.startswith('event: '):
                    current_event = line[7:]
                elif line.startswith('data: '):
                    data_str = line[6:]
                    if data_str == '[DONE]':
                        events.append((current_event, None))
                    else:
                        try:
                            events.append((current_event, json.loads(data_str)))
                        except json.JSONDecodeError:
                            events.append((current_event, data_str))
    except urllib.error.HTTPError as error:
        raw = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'{path} -> HTTP {error.code}: {raw}') from error
    return events


def parse_json_maybe(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}


def contains_temperature(text, expected):
    digits = ''.join(ch for ch in expected if ch.isdigit())
    normalized = text.replace('°', '').replace('℃', 'C')
    if expected in normalized:
        return True
    if expected.replace('C', '°C') in text:
        return True
    return bool(digits) and digits in normalized


def mentions_follow_up(text):
    keywords = (
        '另一个城市',
        '另一个',
        '第二个城市',
        '其他城市',
        '继续追问',
        '继续查询',
        '请告诉我',
        '请告知',
        '请提供',
        '还想查询',
        '下一个城市',
        '下一座城市',
    )
    return any(keyword in text for keyword in keywords)


def require_turn2_summary(endpoint, text, city, temperature):
    normalized = (text or '').strip()
    require(normalized, f'{endpoint} 第二轮输出为空')
    has_summary = city in normalized and contains_temperature(normalized, temperature)
    has_follow_up = mentions_follow_up(normalized) and city in normalized
    require(has_summary or has_follow_up, f'{endpoint} 第二轮未正确承接 {city} 结果: {text}')


def extract_chat_message(response):
    return response['choices'][0]['message']


def extract_chat_text(response):
    message = extract_chat_message(response)
    content = message.get('content')
    if isinstance(content, list):
        return '\n'.join(
            part.get('text', '') if isinstance(part, dict) else str(part)
            for part in content
        )
    return content or ''


def get_chat_tool_call(response):
    message = extract_chat_message(response)
    tool_calls = message.get('tool_calls') or []
    require(tool_calls, f'chat 响应未返回 tool_calls: {json.dumps(response, ensure_ascii=False)}')
    call = tool_calls[0]
    args = parse_json_maybe(call.get('function', {}).get('arguments'))
    return {
        'id': call.get('id'),
        'name': call.get('function', {}).get('name'),
        'arguments': args,
        'assistant_message': {
            'role': 'assistant',
            'content': message.get('content'),
            'tool_calls': tool_calls,
        },
    }


def extract_anthropic_text(response):
    texts = []
    for block in response.get('content', []):
        if block.get('type') == 'text':
            texts.append(block.get('text', ''))
        if block.get('type') == 'thinking':
            texts.append(block.get('thinking', ''))
    return '\n'.join(part for part in texts if part)


def get_anthropic_tool_call(response):
    for block in response.get('content', []):
        if block.get('type') == 'tool_use':
            return {
                'id': block.get('id'),
                'name': block.get('name'),
                'input': block.get('input') or {},
                'assistant_message': {
                    'role': 'assistant',
                    'content': response.get('content', []),
                },
            }
    raise AssertionError(f'messages 响应未返回 tool_use: {json.dumps(response, ensure_ascii=False)}')


def extract_responses_text(response):
    if response.get('output_text'):
        return response['output_text']
    texts = []
    for item in response.get('output', []):
        if item.get('type') != 'message':
            continue
        for content in item.get('content', []):
            if content.get('type') == 'output_text':
                texts.append(content.get('text', ''))
    return '\n'.join(part for part in texts if part)


def get_responses_tool_call(response):
    for item in response.get('output', []):
        if item.get('type') == 'function_call':
            return {
                'id': item.get('id'),
                'call_id': item.get('call_id'),
                'name': item.get('name'),
                'arguments': parse_json_maybe(item.get('arguments')),
                'function_call_item': {
                    'type': 'function_call',
                    'call_id': item.get('call_id'),
                    'name': item.get('name'),
                    'arguments': item.get('arguments'),
                },
            }
    raise AssertionError(f'responses 响应未返回 function_call: {json.dumps(response, ensure_ascii=False)}')


def test_chat_completions(stamp):
    client_id = f'audit-chat-{stamp}'
    headers = make_headers(client_id)
    turn1_user = {
        'role': 'user',
        'content': '先查上海天气，等会我会继续追问另一个城市。最后总结时必须保留具体城市名和温度数值。',
    }
    turn1 = post_json('/v1/chat/completions', {
        'model': MODEL,
        'messages': [turn1_user],
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    call1 = get_chat_tool_call(turn1)
    require(normalize_tool_name(call1['name']) == 'get_weather', f'chat 第一轮工具名异常: {call1}')
    require(call1['arguments'].get('city') == '上海', f'chat 第一轮未请求上海: {call1}')

    tool1 = {
        'role': 'tool',
        'tool_call_id': call1['id'],
        'content': tool_result('上海', '23C', '晴'),
    }
    turn2_messages = [turn1_user, call1['assistant_message'], tool1]
    turn2 = post_json('/v1/chat/completions', {
        'model': MODEL,
        'messages': turn2_messages,
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    turn2_text = extract_chat_text(turn2)
    require_turn2_summary('chat', turn2_text, '上海', '23C')

    turn2_assistant = {
        'role': 'assistant',
        'content': extract_chat_message(turn2).get('content'),
    }
    turn3_user = {
        'role': 'user',
        'content': '那广州的天气呢？拿到结果后请用一句话对比上海和广州，并保留两个城市的温度数值。',
    }
    turn3_messages = turn2_messages + [turn2_assistant, turn3_user]
    turn3 = post_json('/v1/chat/completions', {
        'model': MODEL,
        'messages': turn3_messages,
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    call3 = get_chat_tool_call(turn3)
    require(call3['arguments'].get('city') == '广州', f'chat 第三轮未请求广州: {call3}')

    tool3 = {
        'role': 'tool',
        'tool_call_id': call3['id'],
        'content': tool_result('广州', '28C', '多云'),
    }
    turn4_messages = turn3_messages + [call3['assistant_message'], tool3]
    turn4 = post_json('/v1/chat/completions', {
        'model': MODEL,
        'messages': turn4_messages,
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    turn4_text = extract_chat_text(turn4)
    require('上海' in turn4_text and '广州' in turn4_text, f'chat 第四轮未同时提及两个城市: {turn4_text}')
    require(contains_temperature(turn4_text, '23C') and contains_temperature(turn4_text, '28C'), f'chat 第四轮未保留温度数值: {turn4_text}')
    return {
        'client_id': client_id,
        'turn2_text': turn2_text,
        'turn4_text': turn4_text,
    }


def test_messages(stamp):
    client_id = f'audit-messages-{stamp}'
    headers = make_headers(client_id, {'anthropic-version': '2023-06-01'})
    turn1_user = {
        'role': 'user',
        'content': '先查上海天气，等会我会继续追问另一个城市。最后总结时必须保留具体城市名和温度数值。',
    }
    turn1 = post_json('/v1/messages', {
        'model': MODEL,
        'max_tokens': 512,
        'messages': [turn1_user],
        'tools': ANTHROPIC_TOOLS,
        'stream': False,
    }, headers)
    call1 = get_anthropic_tool_call(turn1)
    require(normalize_tool_name(call1['name']) == 'get_weather', f'messages 第一轮工具名异常: {call1}')
    require(call1['input'].get('city') == '上海', f'messages 第一轮未请求上海: {call1}')

    tool1 = {
        'role': 'user',
        'content': [{
            'type': 'tool_result',
            'tool_use_id': call1['id'],
            'content': tool_result('上海', '23C', '晴'),
        }],
    }
    turn2_messages = [turn1_user, call1['assistant_message'], tool1]
    turn2 = post_json('/v1/messages', {
        'model': MODEL,
        'max_tokens': 512,
        'messages': turn2_messages,
        'tools': ANTHROPIC_TOOLS,
        'stream': False,
    }, headers)
    turn2_text = extract_anthropic_text(turn2)
    require_turn2_summary('messages', turn2_text, '上海', '23C')

    turn3_user = {
        'role': 'user',
        'content': '那广州的天气呢？拿到结果后请用一句话对比上海和广州，并保留两个城市的温度数值。',
    }
    turn3_messages = turn2_messages + [{
        'role': 'assistant',
        'content': turn2.get('content', []),
    }, turn3_user]
    turn3 = post_json('/v1/messages', {
        'model': MODEL,
        'max_tokens': 512,
        'messages': turn3_messages,
        'tools': ANTHROPIC_TOOLS,
        'stream': False,
    }, headers)
    call3 = get_anthropic_tool_call(turn3)
    require(call3['input'].get('city') == '广州', f'messages 第三轮未请求广州: {call3}')

    tool3 = {
        'role': 'user',
        'content': [{
            'type': 'tool_result',
            'tool_use_id': call3['id'],
            'content': tool_result('广州', '28C', '多云'),
        }],
    }
    turn4_messages = turn3_messages + [call3['assistant_message'], tool3]
    turn4 = post_json('/v1/messages', {
        'model': MODEL,
        'max_tokens': 512,
        'messages': turn4_messages,
        'tools': ANTHROPIC_TOOLS,
        'stream': False,
    }, headers)
    turn4_text = extract_anthropic_text(turn4)
    require('上海' in turn4_text and '广州' in turn4_text, f'messages 第四轮未同时提及两个城市: {turn4_text}')
    require(contains_temperature(turn4_text, '23C') and contains_temperature(turn4_text, '28C'), f'messages 第四轮未保留温度数值: {turn4_text}')
    return {
        'client_id': client_id,
        'turn2_text': turn2_text,
        'turn4_text': turn4_text,
    }


def test_responses(stamp):
    client_id = f'audit-responses-{stamp}'
    headers = make_headers(client_id)

    turn1 = post_json('/v1/responses', {
        'model': MODEL,
        'input': '先查上海天气，等会我会继续追问另一个城市。最后总结时必须保留具体城市名和温度数值。',
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    require(turn1.get('id'), f'responses 第一轮缺少 response id: {json.dumps(turn1, ensure_ascii=False)}')
    call1 = get_responses_tool_call(turn1)
    require(normalize_tool_name(call1['name']) == 'get_weather', f'responses 第一轮工具名异常: {call1}')
    require(call1['arguments'].get('city') == '上海', f'responses 第一轮未请求上海: {call1}')

    turn2 = post_json('/v1/responses', {
        'model': MODEL,
        'previous_response_id': turn1['id'],
        'input': [
            {
                'type': 'function_call_output',
                'call_id': call1['call_id'],
                'output': tool_result('上海', '23C', '晴'),
            },
        ],
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    require(turn2.get('id'), f'responses 第二轮缺少 response id: {json.dumps(turn2, ensure_ascii=False)}')
    turn2_text = extract_responses_text(turn2)
    require_turn2_summary('responses', turn2_text, '上海', '23C')

    turn3 = post_json('/v1/responses', {
        'model': MODEL,
        'previous_response_id': turn2['id'],
        'input': '那广州的天气呢？拿到结果后请用一句话对比上海和广州，并保留两个城市的温度数值。',
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    require(turn3.get('id'), f'responses 第三轮缺少 response id: {json.dumps(turn3, ensure_ascii=False)}')
    call3 = get_responses_tool_call(turn3)
    require(call3['arguments'].get('city') == '广州', f'responses 第三轮未请求广州: {call3}')

    turn4 = post_json('/v1/responses', {
        'model': MODEL,
        'previous_response_id': turn3['id'],
        'input': [
            {
                'type': 'function_call_output',
                'call_id': call3['call_id'],
                'output': tool_result('广州', '28C', '多云'),
            },
        ],
        'tools': OPENAI_TOOLS,
        'stream': False,
    }, headers)
    turn4_text = extract_responses_text(turn4)
    require('上海' in turn4_text and '广州' in turn4_text, f'responses 第四轮未同时提及两个城市: {turn4_text}')
    require(contains_temperature(turn4_text, '23C') and contains_temperature(turn4_text, '28C'), f'responses 第四轮未保留温度数值: {turn4_text}')
    return {
        'client_id': client_id,
        'turn2_text': turn2_text,
        'turn4_text': turn4_text,
    }


def test_chat_completions_stream(stamp):
    client_id = f'audit-chat-stream-{stamp}'
    headers = make_headers(client_id)
    events = post_stream('/v1/chat/completions', {
        'model': MODEL,
        'messages': [{'role': 'user', 'content': '查询上海天气，只能通过工具完成。'}],
        'tools': OPENAI_TOOLS,
        'stream': True,
    }, headers)
    found_tool_calls = []
    for _evt, data in events:
        if not data:
            continue
        for choice in data.get('choices') or []:
            tcs = (choice.get('delta') or {}).get('tool_calls') or []
            found_tool_calls.extend(tcs)
    require(found_tool_calls, f'chat stream 未返回 tool_calls; events={[e for e, _ in events]}')
    first = found_tool_calls[0]
    func = first.get('function') or {}
    args = parse_json_maybe(func.get('arguments') or '{}')
    require(
        normalize_tool_name(func.get('name', '')) == 'get_weather',
        f'chat stream 工具名异常: {first}',
    )
    require(args.get('city') == '上海', f'chat stream 工具参数城市异常: {args}')
    return {'tool_calls': found_tool_calls}


def test_messages_stream(stamp):
    client_id = f'audit-messages-stream-{stamp}'
    headers = make_headers(client_id, {'anthropic-version': '2023-06-01'})
    events = post_stream('/v1/messages', {
        'model': MODEL,
        'max_tokens': 512,
        'messages': [{'role': 'user', 'content': '查询上海天气，只能通过工具完成。'}],
        'tools': ANTHROPIC_TOOLS,
        'stream': True,
    }, headers)
    tool_use_blocks = []
    for evt_name, data in events:
        if evt_name == 'content_block_start' and data:
            cb = data.get('content_block') or {}
            if cb.get('type') == 'tool_use':
                tool_use_blocks.append(cb)
    require(
        tool_use_blocks,
        f'messages stream 未返回 tool_use content_block_start; events={[e for e, _ in events]}',
    )
    block = tool_use_blocks[0]
    require(
        normalize_tool_name(block.get('name', '')) == 'get_weather',
        f'messages stream 工具名异常: {block}',
    )
    return {'tool_use_blocks': tool_use_blocks}


def test_responses_stream(stamp):
    client_id = f'audit-responses-stream-{stamp}'
    headers = make_headers(client_id)
    events = post_stream('/v1/responses', {
        'model': MODEL,
        'input': '查询上海天气，只能通过工具完成。',
        'tools': OPENAI_TOOLS,
        'stream': True,
    }, headers)
    function_calls = []
    for evt_name, data in events:
        if evt_name == 'response.completed' and data:
            response = data.get('response') or {}
            for item in response.get('output') or []:
                if item.get('type') == 'function_call':
                    function_calls.append(item)
            break
    require(
        function_calls,
        f'responses stream 未返回 function_call in response.completed; events={[e for e, _ in events]}',
    )
    call = function_calls[0]
    require(
        normalize_tool_name(call.get('name', '')) == 'get_weather',
        f'responses stream 工具名异常: {call}',
    )
    args = parse_json_maybe(call.get('arguments') or '{}')
    require(args.get('city') == '上海', f'responses stream 工具参数城市异常: {args}')
    return {'function_calls': function_calls}


def run_with_retries(name, func, stamp, attempts=3):
    last_error = None
    for index in range(1, attempts + 1):
        attempt_stamp = f'{stamp}-{index}'
        try:
            return func(attempt_stamp)
        except Exception as error:
            last_error = error
            print(f'[{name}] attempt {index} failed: {error}', file=sys.stderr)
    raise last_error


def main():
    stamp = str(int(time.time() * 1000))
    summary = {
        'base_url': BASE_URL,
        'model': MODEL,
        'chat': run_with_retries('chat', test_chat_completions, stamp),
        'messages': run_with_retries('messages', test_messages, stamp),
        'responses': run_with_retries('responses', test_responses, stamp),
        'chat_stream': run_with_retries('chat_stream', test_chat_completions_stream, stamp),
        'messages_stream': run_with_retries('messages_stream', test_messages_stream, stamp),
        'responses_stream': run_with_retries('responses_stream', test_responses_stream, stamp),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)