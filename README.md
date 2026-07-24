# HiAPI Unified Task API Examples

[简体中文](README.zh-CN.md)

Runnable Node.js examples for image generation and asynchronous video delivery through HiAPI's unified `POST /v1/tasks` API.

## Generate an image in 15 minutes

Prerequisite: Node.js 20.6 or newer.

```bash
git clone https://github.com/zimacode-network/hiapi-api-examples.git
cd hiapi-api-examples
npm install
```

Copy the environment template:

```bash
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Open `.env` and fill in **only** `HIAPI_API_KEY` for this example. Leave the Webhook values empty.

```dotenv
HIAPI_API_KEY=your_api_key
HIAPI_WEBHOOK_URL=
HIAPI_WEBHOOK_SECRET=
PORT=3000
```

Run the image example:

```bash
npm run image
```

The example submits [`flux-schnell/text-to-image`](https://dev.hiapi.ai/docs/models/image/flux-schnell/), polls it to a terminal state, and downloads the result. Open `outputs/<taskId>/` to find:

- `task.json`: the final task detail
- `output-01.*`, `output-02.*`, ...: downloaded artifacts

Both examples use the current [Unified Async API](https://dev.hiapi.ai/docs/async-api/) and create work with `POST /v1/tasks`.

## Run the asynchronous video Webhook example

The receiver must be running and publicly reachable before the video task is submitted. Use this order:

1. In the HiAPI account settings, set a Webhook signing secret between 16 and 256 characters. Put the same value in `.env` as `HIAPI_WEBHOOK_SECRET`.
2. Start the local receiver:

   ```bash
   npm run webhook
   ```

   By default it listens at `http://localhost:3000/api/hiapi/webhook`.

3. In another terminal, expose port 3000 with either Cloudflare Tunnel or ngrok:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   # or
   ngrok http 3000
   ```

4. Append `/api/hiapi/webhook` to the public HTTPS origin and put the complete URL in `.env`:

   ```dotenv
   HIAPI_WEBHOOK_URL=https://your-public-host.example/api/hiapi/webhook
   ```

5. Keep the receiver and tunnel running, then submit the video task from a third terminal:

   ```bash
   npm run video
   ```

The submit command uses the official [`seedance-2-0`](https://dev.hiapi.ai/docs/models/video/seedance-2-0/) model with a low-cost 4-second, 480p, no-audio default and prints the returned `taskId`. The receiver acknowledges valid callbacks, stores the original callback JSON under `results/callbacks/`, and downloads successful outputs under `results/outputs/<taskId>/`.

See [Create a task](https://dev.hiapi.ai/docs/async-api/create/) for the request contract and [Callbacks](https://dev.hiapi.ai/docs/async-api/#callbacks) for the production delivery contract.

## Poll a task as a fallback

Webhooks should be the primary completion signal in production, with polling retained for recovery when a callback is delayed or exhausted its retries:

```bash
npm run task -- <taskId>
```

For example:

```bash
npm run task -- tk-hiapi-01HZTQ8BX2N3GM3YFK4Z9D7VQR
```

The command queries `GET /v1/tasks/:id` until `success` or `fail`, then saves the task metadata and any available artifacts. See [Get task detail](https://dev.hiapi.ai/docs/async-api/detail/) for polling guidance.

## Task and callback contract

The create response contains the identifier at `data.taskId`. The field name is always camelCase `taskId`, not `task_id`, `taskID`, or `id`.

| Status | Meaning | Terminal |
| --- | --- | --- |
| `queued` | Waiting to start | No |
| `handling` | Generation is running | No |
| `archiving` | Generation finished; artifacts are being prepared | No |
| `success` | Artifacts are available | Yes |
| `fail` | Generation failed; inspect `error` | Yes |

A Webhook callback is the public final task object itself. It does **not** have the `{ "code", "message", "data" }` wrapper returned by the query endpoint, and it may omit storage-specific fields that appear in `GET /v1/tasks/:id`:

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

HiAPI sends a callback when a task reaches `success` or `fail`. Delivery is **at least once**, so receivers must deduplicate by `taskId` and return HTTP 2xx for both newly processed and already processed events.

HiAPI waits up to 10 seconds for a 2xx response. Persist the callback before acknowledging it, then download artifacts after the response. For a non-2xx response, timeout, or network error, HiAPI makes an initial attempt and then retries at approximately these offsets, up to four attempts total:

```text
initial attempt -> about +1 minute -> about +5 minutes -> about +20 minutes
```

After four failed attempts, delivery stops without changing the task's own status. Use `npm run task -- <taskId>` to recover the result.

When a signing secret is configured, HiAPI sends `X-HiAPI-Timestamp` and `X-HiAPI-Signature`. Verification uses:

```text
hex(HMAC_SHA256(secret, timestamp + "." + rawRequestBody))
```

Verify the exact bytes before parsing JSON, use a constant-time comparison, and reject timestamps outside the five-minute tolerance. Re-serializing parsed JSON changes the signed bytes and causes verification to fail.

## Environment variables

| Variable | Required for | Description |
| --- | --- | --- |
| `HIAPI_API_KEY` | `image`, `video`, `task` | HiAPI bearer token. Never commit `.env`. |
| `HIAPI_WEBHOOK_URL` | `video` | Complete public callback URL, including `/api/hiapi/webhook`. |
| `HIAPI_WEBHOOK_SECRET` | `webhook` | Must match the account-level Webhook signing secret. |
| `HIAPI_IMAGE_PROMPT` | `image` | Optional prompt override; the example has a runnable default. |
| `HIAPI_VIDEO_PROMPT` | `video` | Optional prompt override; the example has a runnable default. |
| `PORT` | `webhook` | Local receiver port; defaults to `3000`. |

## Common errors

| Symptom | Meaning and action |
| --- | --- |
| HTTP `400` | Invalid body, callback URL, model, or input. Read `error_code`/`message`, fix the request, and do not retry it unchanged. |
| HTTP `401` | `HIAPI_API_KEY` is missing, invalid, or revoked. Check the Bearer key and account. |
| HTTP `402` | Insufficient balance. The task was not created and is not charged; top up before retrying. |
| HTTP `404` | The task does not exist or belongs to another account. Check `taskId` and the API key's account. |
| HTTP `409` | The first request with this `Idempotency-Key` is still processing. Retry after `Retry-After` (normally 5 seconds). |
| HTTP `415` | `Content-Type` is not `application/json`. Send JSON or omit the header. |
| HTTP `422` | The same `Idempotency-Key` was reused with a different body. Generate/fix the key; do not retry unchanged. |
| HTTP `429` | Rate limit exceeded. Reduce concurrency and retry after the server's delay. |
| HTTP `503` | HiAPI is temporarily unavailable. Retry with exponential backoff. |
| HTTP `200`, task `status=fail` | The query succeeded, but generation failed. Treat `fail` as terminal and inspect `data.error`; a callback carries `error` directly. |
| Webhook signature fails | Ensure both sides use the same secret, verify the raw body before JSON parsing, retain the timestamp exactly, and check clock drift. |
| Callback never arrives | The callback URL must be publicly reachable. Keep the tunnel and receiver running, include the full `/api/hiapi/webhook` path, and allow inbound POST requests. |
| Artifact download fails or returns expired | Temporary outputs are normally retained for about seven days. Check `output[].expireAt`, download promptly, or use persistent storage. |

For durable artifacts, see [Output storage](https://dev.hiapi.ai/docs/storage/). Authentication details are in [Authentication](https://dev.hiapi.ai/docs/authentication/).

## Tests and CI

```bash
npm test
```

Tests use local fixtures and local HTTP servers. They do not require an API key and do not submit live generation tasks. GitHub Actions runs the same command on Node.js 20.

## License

[MIT](LICENSE)
