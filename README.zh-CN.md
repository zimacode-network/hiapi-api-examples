# HiAPI 统一任务 API 示例

[English](README.md)

这是一个可直接运行的 Node.js 示例项目，通过 HiAPI 当前统一的 `POST /v1/tasks` 接口演示图片生成和异步视频 Webhook。

## 15 分钟运行图片示例

前置要求：Node.js 20.6 或更高版本。

```bash
git clone https://github.com/zimacode-network/hiapi-api-examples.git
cd hiapi-api-examples
npm install
```

复制环境变量模板：

```bash
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

打开 `.env`。运行图片示例时**只填写** `HIAPI_API_KEY`，Webhook 相关变量保持为空。

```dotenv
HIAPI_API_KEY=你的_api_key
HIAPI_WEBHOOK_URL=
HIAPI_WEBHOOK_SECRET=
PORT=3000
```

运行图片示例：

```bash
npm run image
```

示例会提交 [`flux-schnell/text-to-image`](https://dev.hiapi.ai/docs/zh/models/image/flux-schnell/) 图片任务、轮询到终态并下载结果。在 `outputs/<taskId>/` 中可以看到：

- `task.json`：最终任务详情
- `output-01.*`、`output-02.*` 等：已下载的产物

图片和视频示例都使用当前[统一异步接口](https://dev.hiapi.ai/docs/zh/async-api/)，并通过 `POST /v1/tasks` 创建任务。

## 运行异步视频 Webhook 示例

提交视频任务前，接收服务必须已经运行并且可从公网访问。请严格按以下顺序操作：

1. Webhook 签名是可选项。如需验签，在 HiAPI 控制台账号设置中配置一个 16 至 256 字符的签名密钥，并把同一个值填写到 `.env` 的 `HIAPI_WEBHOOK_SECRET`；如使用无签名回调，账号设置和 `.env` 都保持为空。
2. 启动本地回调服务：

   ```bash
   npm run webhook
   ```

   默认监听 `http://localhost:3000/api/hiapi/webhook`。

3. 在另一个终端中，用 Cloudflare Tunnel 或 ngrok 暴露本地 3000 端口：

   ```bash
   cloudflared tunnel --url http://localhost:3000
   # 或
   ngrok http 3000
   ```

4. 在得到的公网 HTTPS 域名后追加 `/api/hiapi/webhook`，把完整地址写入 `.env`：

   ```dotenv
   HIAPI_WEBHOOK_URL=https://你的公网域名.example/api/hiapi/webhook
   ```

5. 保持回调服务和 Tunnel 运行，在第三个终端提交视频任务：

   ```bash
   npm run video
   ```

提交命令使用官方 [`seedance-2-0`](https://dev.hiapi.ai/docs/zh/models/video/seedance-2-0/) 模型，默认按低成本的 4 秒、480p、无音频参数生成，并输出返回的 `taskId`。回调服务会确认有效请求，把原始回调 JSON 保存到 `results/callbacks/`，并把成功任务的产物下载到 `results/outputs/<taskId>/`。

请求字段见[创建任务](https://dev.hiapi.ai/docs/zh/async-api/create/)，生产环境的投递约定见[回调说明](https://dev.hiapi.ai/docs/zh/async-api/#回调说明)。

## 用轮询兜底

生产环境应优先使用 Webhook 接收终态通知；如果回调延迟或重试耗尽，可按 `taskId` 轮询补漏：

```bash
npm run task -- <taskId>
```

例如：

```bash
npm run task -- tk-hiapi-01HZTQ8BX2N3GM3YFK4Z9D7VQR
```

该命令会轮询 `GET /v1/tasks/:id`，直到任务进入 `success` 或 `fail`，然后保存任务信息和可用产物。轮询间隔和终态处理见[获取任务详情](https://dev.hiapi.ai/docs/zh/async-api/detail/)。

## 任务与回调约定

创建接口返回的标识位于 `data.taskId`。字段名固定使用驼峰 `taskId`，不要写成 `task_id`、`taskID` 或 `id`。

| 状态 | 含义 | 是否终态 |
| --- | --- | --- |
| `queued` | 已入队，等待开始 | 否 |
| `handling` | 正在生成 | 否 |
| `archiving` | 生成完成，正在准备产物 | 否 |
| `success` | 生成成功，产物可用 | 是 |
| `fail` | 生成失败，查看 `error` | 是 |

Webhook 的请求体就是公开终态任务对象本身，**没有**查询接口返回的 `{ "code", "message", "data" }` 外层；相比 `GET /v1/tasks/:id`，可能省略部分存储字段：

```json
{
  "taskId": "tk-hiapi-...",
  "model": "example-model",
  "status": "success",
  "created": 1777282033,
  "completed": 1777282099,
  "output": []
}
```

任务进入 `success` 或 `fail` 时，HiAPI 发出回调。投递语义是**至少一次**，因此接收方必须按 `taskId` 去重；无论是首次处理还是重复事件，都应返回 HTTP 2xx。

HiAPI 最多等待接收方 10 秒返回 2xx。接收方应先持久化回调再确认，产物下载放到响应之后执行。如果接收方返回非 2xx、请求超时或发生网络错误，HiAPI 首次立即投递，失败后按以下近似时间重试，共最多 4 次：

```text
首次投递 -> 约 +1 分钟 -> 约 +5 分钟 -> 约 +20 分钟
```

4 次均失败后停止投递，但不会改变任务自身状态。此时使用 `npm run task -- <taskId>` 查询补漏。

配置签名密钥后，HiAPI 会发送 `X-HiAPI-Timestamp` 和 `X-HiAPI-Signature`；未配置时不会发送这两个请求头，示例会接收无签名回调。签名计算方式为：

```text
hex(HMAC_SHA256(secret, timestamp + "." + rawRequestBody))
```

必须在解析 JSON 前使用请求体原始字节校验，并采用常量时间比较；时间戳超过 5 分钟容差应拒绝。解析后再序列化 JSON 会改变被签名字节，导致校验失败。

## 环境变量

| 变量 | 使用命令 | 说明 |
| --- | --- | --- |
| `HIAPI_API_KEY` | `image`、`video`、`task` | HiAPI Bearer Token。不要提交 `.env`。 |
| `HIAPI_WEBHOOK_URL` | `video` | 完整公网回调地址，必须包含 `/api/hiapi/webhook`。 |
| `HIAPI_WEBHOOK_SECRET` | `webhook` | 可选；填写时必须与账号级 Webhook 签名密钥一致。 |
| `HIAPI_IMAGE_PROMPT` | `image` | 可选的图片提示词覆盖值；示例自带可运行默认值。 |
| `HIAPI_VIDEO_PROMPT` | `video` | 可选的视频提示词覆盖值；示例自带可运行默认值。 |
| `PORT` | `webhook` | 本地回调服务端口，默认 `3000`。 |

## 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| HTTP `400` | 请求体、回调 URL、模型或输入参数不合法。查看 `error_code`/`message`，修正后再提交，不要原样重试。 |
| HTTP `401` | `HIAPI_API_KEY` 缺失、无效或已撤销。检查 Bearer Key 和所属账号。 |
| HTTP `402` | 余额不足。任务未创建且不会扣费，充值后再重试。 |
| HTTP `404` | 任务不存在或不属于当前账号。检查 `taskId` 和 API Key 所属账号。 |
| HTTP `409` | 同一 `Idempotency-Key` 的首次请求仍在处理中。按 `Retry-After` 重试，通常为 5 秒。 |
| HTTP `415` | `Content-Type` 不是 `application/json`。改为 JSON 或去掉该请求头。 |
| HTTP `422` | 同一个 `Idempotency-Key` 被用于不同请求体。修正键的生成逻辑，不要原样重试。 |
| HTTP `429` | 超出速率限制。降低并发，并按服务端建议的延迟重试。 |
| HTTP `503` | HiAPI 暂时不可用。使用指数退避稍后重试。 |
| HTTP `200`，但任务 `status=fail` | 查询本身成功，但生成失败。把 `fail` 当作终态并读取 `data.error`；Webhook 中直接读取 `error`。 |
| Webhook 签名失败 | 确认两端密钥一致；用 JSON 解析前的原始请求体校验；保留原始时间戳，并检查机器时钟偏差。 |
| 一直收不到回调 | 回调 URL 必须公网可达。保持 Tunnel 和本地服务运行，确保带完整 `/api/hiapi/webhook` 路径，并允许公网 POST。 |
| 产物下载失败或已过期 | 临时产物通常保留约 7 天。以 `output[].expireAt` 为准，及时下载，或改用持久存储。 |

长期保存产物请查看[产物存储](https://dev.hiapi.ai/docs/zh/storage/)，鉴权问题请查看[身份认证](https://dev.hiapi.ai/docs/zh/authentication/)。

## 测试与 CI

```bash
npm test
```

测试只使用本地 fixture 和本地 HTTP 服务，不需要 API Key，也不会提交线上生成任务。GitHub Actions 使用 Node.js 20 运行同一命令。

## 许可证

[MIT](LICENSE)
