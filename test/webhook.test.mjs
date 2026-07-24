import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createWebhookHandler } from "../examples/webhook.mjs";
import { createWebhookSignature } from "../src/webhook-signature.mjs";

const secret = "test-secret";
const timestamp = "1800000000";
const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function startWebhook(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hiapi-webhook-"));
  const callbackDirectory = path.join(root, "callbacks");
  const outputDirectory = path.join(root, "outputs");
  const handler = createWebhookHandler({
    secret,
    callbackDirectory,
    outputDirectory,
    now: () => Number(timestamp) * 1000,
    ...overrides,
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { server, callbackDirectory, outputDirectory };
}

async function post(server, rawBody, {
  signature,
  sentTimestamp = timestamp,
  signed = true,
} = {}) {
  const address = server.address();
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(rawBody),
  };
  if (signed) {
    headers["X-HiAPI-Timestamp"] = sentTimestamp;
    if (signature !== null) {
      headers["X-HiAPI-Signature"] =
        signature ?? createWebhookSignature(secret, sentTimestamp, rawBody);
    }
  }

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/api/hiapi/webhook",
        method: "POST",
        headers,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end(rawBody);
  });
}

test("accepts a correctly signed callback and stores its exact body", async () => {
  const { server, callbackDirectory } = await startWebhook();
  const body = '{\n  "taskId": "task-valid", "status": "success", "output": []\n}';

  assert.equal(await post(server, body), 204);
  assert.equal(await readFile(path.join(callbackDirectory, "task-valid.json"), "utf8"), body);
});

test("accepts an unsigned callback when no signing secret is configured", async () => {
  const { server, callbackDirectory } = await startWebhook({ secret: undefined });
  const body = '{"taskId":"task-unsigned","status":"success","output":[]}';

  assert.equal(await post(server, body, { signed: false }), 204);
  assert.equal(
    await readFile(path.join(callbackDirectory, "task-unsigned.json"), "utf8"),
    body,
  );
});

test("rejects signature headers when the local signing secret is missing", async () => {
  const { server } = await startWebhook({ secret: undefined });
  const body = '{"taskId":"task-config-mismatch","status":"success","output":[]}';

  assert.equal(await post(server, body), 401);
});

test("rejects a body changed after signing", async () => {
  const { server } = await startWebhook();
  const signed = '{"taskId":"task-tampered","status":"success","output":[]}';
  const signature = createWebhookSignature(secret, timestamp, signed);

  assert.equal(await post(server, signed.replace("success", "fail"), { signature }), 401);
});

test("rejects wrong and missing signatures", async () => {
  const { server } = await startWebhook();
  const body = '{"taskId":"task-signature","status":"success","output":[]}';

  assert.equal(await post(server, body, { signature: "00".repeat(32) }), 401);
  assert.equal(await post(server, body, { signature: null }), 401);
});

test("rejects malformed signatures", async () => {
  const { server } = await startWebhook();
  const body = '{"taskId":"task-malformed","status":"success","output":[]}';

  assert.equal(await post(server, body, { signature: "abc" }), 401);
  assert.equal(await post(server, body, { signature: "zz".repeat(32) }), 401);
  assert.equal(
    await post(server, body, { signature: `sha256=${"00".repeat(32)}` }),
    401,
  );
});

test("rejects timestamps outside the five minute window", async () => {
  const { server } = await startWebhook();
  const body = '{"taskId":"task-old","status":"success","output":[]}';
  const oldTimestamp = String(Number(timestamp) - 301);

  assert.equal(await post(server, body, { sentTimestamp: oldTimestamp }), 401);
});

test("verifies the original bytes rather than parsed JSON", async () => {
  const { server } = await startWebhook();
  const compact = '{"taskId":"task-raw","status":"success","output":[]}';
  const spaced = '{ "taskId": "task-raw", "status": "success", "output": [] }';
  const signature = createWebhookSignature(secret, timestamp, compact);

  assert.equal(await post(server, spaced, { signature }), 401);
});

test("rejects oversized request bodies", async () => {
  const { server } = await startWebhook();
  const body = "x".repeat(1024 * 1024 + 1);

  assert.equal(await post(server, body), 413);
});

test("rejects non-final and invalid task payloads", async () => {
  const { server } = await startWebhook();
  const invalidBodies = [
    '{"taskId":"task-active","status":"handling"}',
    '{"status":"success","output":[]}',
    '{"taskId":"../escape","status":"success","output":[]}',
    `{"taskId":"${"a".repeat(101)}","status":"success","output":[]}`,
    "not-json",
  ];

  for (const body of invalidBodies) {
    assert.equal(await post(server, body), 400);
  }
});

test("returns 500 when the callback cannot be persisted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hiapi-webhook-file-"));
  const callbackDirectory = path.join(root, "not-a-directory");
  await writeFile(callbackDirectory, "occupied");
  const { server } = await startWebhook({ callbackDirectory });
  const body = '{"taskId":"task-persist","status":"success","output":[]}';

  assert.equal(await post(server, body), 500);
});

test("treats repeated taskId callbacks as already handled", async () => {
  let downloads = 0;
  const { server, callbackDirectory } = await startWebhook({
    fetchImpl: async () => {
      downloads += 1;
      return new Response("video");
    },
  });
  const body = '{"taskId":"task-duplicate","status":"success","output":[{"url":"https://example.com/video.mp4","type":"video/mp4"}]}';

  assert.equal(await post(server, body), 204);
  assert.equal(await post(server, body), 204);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(downloads, 1);
  assert.deepEqual(await readdir(callbackDirectory), ["task-duplicate.json"]);
});

test("stores failed tasks without downloading output", async () => {
  let downloads = 0;
  const { server, callbackDirectory } = await startWebhook({
    fetchImpl: async () => {
      downloads += 1;
      return new Response("unexpected");
    },
  });
  const body = '{"taskId":"task-fail","status":"fail","output":[{"url":"https://example.com/should-not-download.mp4","type":"video/mp4"}],"error":{"message":"generation failed"}}';

  assert.equal(await post(server, body), 204);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(downloads, 0);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(callbackDirectory, "task-fail.json"), "utf8")).error,
    { message: "generation failed" },
  );
});
