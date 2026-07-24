import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { saveTaskResult } from "../src/task-client.mjs";
import { verifyWebhookSignature } from "../src/webhook-signature.mjs";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function safeTaskId(taskId) {
  if (
    typeof taskId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)
  ) {
    throw new Error("Invalid taskId");
  }
  return taskId;
}

async function readRawBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function downloadOutputs(task, outputDirectory, fetchImpl = fetch) {
  return saveTaskResult(task, { outputDir: outputDirectory, fetchImpl });
}

export function createWebhookHandler({
  secret,
  callbackDirectory = path.resolve("results", "callbacks"),
  outputDirectory = path.resolve("results", "outputs"),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = Date.now,
  fetchImpl = fetch,
  onBackgroundError = console.error,
} = {}) {
  if (!secret) throw new Error("HIAPI_WEBHOOK_SECRET is required");

  return async function webhookHandler(request, response) {
    if (request.method !== "POST" || request.url !== "/api/hiapi/webhook") {
      response.writeHead(404).end();
      return;
    }

    let rawBody;
    try {
      rawBody = await readRawBody(request, maxBodyBytes);
    } catch (error) {
      response.writeHead(error.statusCode ?? 400).end();
      return;
    }

    const valid = verifyWebhookSignature({
      secret,
      timestamp: request.headers["x-hiapi-timestamp"],
      signature: request.headers["x-hiapi-signature"],
      rawBody,
      now: now(),
    });
    if (!valid) {
      response.writeHead(401).end();
      return;
    }

    let task;
    try {
      task = JSON.parse(rawBody.toString("utf8"));
      safeTaskId(task.taskId);
      if (task.status !== "success" && task.status !== "fail") {
        throw new Error("Webhook task must be final");
      }
    } catch {
      response.writeHead(400).end();
      return;
    }

    try {
      await mkdir(callbackDirectory, { recursive: true });
    } catch {
      response.writeHead(500).end();
      return;
    }

    try {
      await writeFile(
        path.join(callbackDirectory, `${task.taskId}.json`),
        rawBody,
        { flag: "wx" },
      );
    } catch (error) {
      if (error.code === "EEXIST") {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(500).end();
      return;
    }

    response.writeHead(204).end(() => {
      if (task.status === "success") {
        void downloadOutputs(task, outputDirectory, fetchImpl).catch(
          onBackgroundError,
        );
      }
    });
  };
}

export function createWebhookServer(options) {
  const handler = createWebhookHandler(options);
  return http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}

const isEntryPoint =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  const secret = process.env.HIAPI_WEBHOOK_SECRET;
  const port = Number(process.env.PORT ?? 3000);
  createWebhookServer({ secret }).listen(port, () => {
    console.log(`Webhook listening on http://localhost:${port}/api/hiapi/webhook`);
  });
}
