# DeepSeek V3 Free 服务

<span>[ 中文 | <a href="README_EN.md">English</a> ]</span>

[![](https://img.shields.io/github/license/llm-red-team/deepseek-free-api.svg)](LICENSE)
![](https://img.shields.io/github/stars/llm-red-team/deepseek-free-api.svg)
![](https://img.shields.io/github/forks/llm-red-team/deepseek-free-api.svg)
![](https://img.shields.io/docker/pulls/vinlic/deepseek-free-api.svg)

# 支持我 ❤️

如果你觉得本项目有用，请务必给我的核心项目 **[Awesome Open WebUI](https://github.com/Fu-Jie/awesome-openwebui)** 点个 Star ⭐️！

（本项目点不点无所谓，主推上面那个 👆）

# 风险警告

## **近期，我们发现部分自媒体引导用户将本仓库源码或镜像部署至非个人使用渠道，并公开提供服务。此行为可能违反了DeepSeek的[《用户协议》](https://chat.deepseek.com/downloads/DeepSeek%20Terms%20of%20Use.html)。我们特此提醒，请相关自媒体和个人立即停止此类不当行为。若持续违规，DeepSeek官方将保留依法追究其法律责任的权利。**

支持高速流式输出、支持多轮对话、支持联网搜索、支持R1深度思考和静默深度思考，零配置部署，多路token支持。

与ChatGPT接口完全兼容。

## 目录

* [免责声明](#免责声明)
* [效果示例](#效果示例)
* [接入准备](#接入准备)
  * [多账号接入](#多账号接入)
* [Docker部署](#Docker部署)
  * [Docker-compose部署](#Docker-compose部署)
* [Render部署](#Render部署)
* [Vercel部署](#Vercel部署)
* [原生部署](#原生部署)
* [推荐使用客户端](#推荐使用客户端)
* [接口列表](#接口列表)
  * [对话补全](#对话补全)
  * [userToken存活检测](#userToken存活检测)
* [注意事项](#注意事项)
  * [Nginx反代优化](#Nginx反代优化)
  * [Token统计](#Token统计)
* [Star History](#star-history)
  
## 免责声明

**逆向API是不稳定的，建议前往DeepSeek官方 https://platform.deepseek.com/ 付费使用API，避免封禁的风险。**

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

| 环境变量 | 是否必填 | 说明                               |
|------|------|----------------------------------|
|  DEEP_SEEK_CHAT_AUTHORIZATION   | 否    | 当配置了token 则使用token，未配置则需要在请求头中传递Authorization |

## Docker-compose运行
clone 本仓库，运行下面的代码
```shell
docker compose up -d --build
```

### Render部署

**注意：部分部署区域可能无法连接deepseek，如容器日志出现请求超时或无法连接，请切换其他区域部署！**
**注意：免费账户的容器实例将在一段时间不活动时自动停止运行，这会导致下次请求时遇到50秒或更长的延迟，建议查看[Render容器保活](https://github.com/LLM-Red-Team/free-api-hub/#Render%E5%AE%B9%E5%99%A8%E4%BF%9D%E6%B4%BB)**

1. fork本项目到你的github账号下。

2. 访问 [Render](https://dashboard.render.com/) 并登录你的github账号。

3. 构建你的 Web Service（New+ -> Build and deploy from a Git repository -> Connect你fork的项目 -> 选择部署区域 -> 选择实例类型为Free -> Create Web Service）。

4. 等待构建完成后，复制分配的域名并拼接URL访问即可。

### Vercel部署

**注意：Vercel免费账户的请求响应超时时间为10秒，但接口响应通常较久，可能会遇到Vercel返回的504超时错误！**

请先确保安装了Node.js环境。

```shell
npm i -g vercel --registry http://registry.npmmirror.com
vercel login
git clone https://github.com/LLM-Red-Team/deepseek-free-api
cd deepseek-free-api
vercel --prod
```

## 原生部署

请先安装好Node.js环境并且配置好环境变量，确认node命令可用。

安装依赖

```shell
npm i
```

安装PM2进行进程守护

```shell
npm i -g pm2
```

编译构建，看到dist目录就是构建完成

```shell
npm run build
```

启动服务

```shell
pm2 start dist/index.js --name "deepseek-free-api"
```

查看服务实时日志

```shell
pm2 logs deepseek-free-api
```

重启服务

```shell
pm2 reload deepseek-free-api
```

停止服务

```shell
pm2 stop deepseek-free-api
```

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
    // 默认：deepseek
    // 深度思考：deepseek-think 或 deepseek-r1
    // 联网搜索：deepseek-search
    // 深度思考+联网搜索：deepseek-r1-search 或 deepseek-think-search
    // 静默模式（不输出思考过程或联网搜索结果）：deepseek-think-silent 或 deepseek-r1-silent 或 deepseek-search-silent
    // 深度思考但思考过程使用<details>可折叠标签包裹（需要页面支持显示）：deepseek-think-fold 或 deepseek-r1-fold
    "model": "deepseek",
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

由于推理侧不在deepseek-free-api，因此token不可统计，将以固定数字返回。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=LLM-Red-Team/deepseek-free-api&type=Date)](https://star-history.com/#LLM-Red-Team/deepseek-free-api&Date)
