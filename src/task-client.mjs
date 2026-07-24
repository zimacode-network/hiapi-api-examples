import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const API_ORIGIN = 'https://api.hiapi.ai';
const ACTIVE_STATUSES = new Set(['queued', 'handling', 'archiving']);
const TERMINAL_STATUSES = new Set(['success', 'fail']);
const KNOWN_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['application/json', '.json'],
  ['application/octet-stream', '.bin'],
]);

function requireApiKey(apiKey) {
  const value = apiKey ?? process.env.HIAPI_API_KEY;

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('HIAPI_API_KEY is required');
  }

  return value.trim();
}

function requireTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) {
    throw new Error('taskId must contain only letters, numbers, underscores, and hyphens');
  }

  return taskId;
}

async function readApiResponse(response) {
  const text = await response.text();
  let body = null;

  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new Error('HiAPI returned an invalid JSON response');
      }
    }
  }

  if (!response.ok) {
    const message = body?.error?.message
      ?? body?.message
      ?? (text || `HiAPI request failed with HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.body = body ?? text;
    throw error;
  }

  const data = body && typeof body === 'object' && Object.hasOwn(body, 'data')
    ? body.data
    : body;

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('HiAPI response is missing task data');
  }

  return data;
}

function extensionForOutput(output, response) {
  const declaredType = output.type?.split(';', 1)[0].trim().toLowerCase();
  if (MIME_EXTENSIONS.has(declaredType)) {
    return MIME_EXTENSIONS.get(declaredType);
  }

  try {
    const extension = extname(new URL(output.url).pathname);
    if (/^\.[A-Za-z0-9]{1,10}$/.test(extension)) {
      return extension.toLowerCase();
    }
  } catch {
    // The URL is validated by fetch below, which provides the more useful error.
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  return MIME_EXTENSIONS.get(contentType) ?? '.bin';
}

export async function submitTask(payload, {
  apiKey,
  idempotencyKey = randomUUID(),
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('task payload must be an object');
  }

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new Error('idempotencyKey must be a non-empty string');
  }

  const response = await fetchImpl(`${API_ORIGIN}/v1/tasks`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${requireApiKey(apiKey)}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal,
  });
  const task = await readApiResponse(response);

  if (typeof task.taskId !== 'string' || task.taskId === '') {
    throw new Error('HiAPI response is missing data.taskId');
  }

  return task;
}

export async function getTask(taskId, {
  apiKey,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const response = await fetchImpl(`${API_ORIGIN}/v1/tasks/${requireTaskId(taskId)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${requireApiKey(apiKey)}`,
    },
    signal,
  });

  return readApiResponse(response);
}

export async function waitForTask(taskId, {
  apiKey,
  fetchImpl = globalThis.fetch,
  intervalMs = 2_000,
  timeoutMs = 10 * 60_000,
  onStatus,
  signal,
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('intervalMs must be a non-negative finite number');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('timeoutMs must be a non-negative finite number');
  }

  const startedAt = Date.now();
  const timeoutError = new Error(`Timed out waiting for task ${taskId}`);
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => requestController.abort(signal.reason);
  const abortForTimeout = () => {
    if (!requestController.signal.aborted) {
      timedOut = true;
      requestController.abort(timeoutError);
    }
  };

  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  let timeoutHandle;
  if (timeoutMs === 0) {
    abortForTimeout();
  } else {
    timeoutHandle = globalThis.setTimeout(abortForTimeout, timeoutMs);
  }

  try {
    while (true) {
      const task = await getTask(taskId, {
        apiKey,
        fetchImpl,
        signal: requestController.signal,
      });

      if (timedOut) {
        throw timeoutError;
      }
      if (!KNOWN_STATUSES.has(task.status)) {
        throw new Error(`Unknown task status: ${String(task.status)}`);
      }

      if (onStatus) {
        await onStatus(task);
      }
      requestController.signal.throwIfAborted();

      if (TERMINAL_STATUSES.has(task.status)) {
        return task;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        abortForTimeout();
        throw timeoutError;
      }

      await delay(Math.min(intervalMs, remainingMs), undefined, {
        signal: requestController.signal,
      });
    }
  } catch (error) {
    if (timedOut) {
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) {
      globalThis.clearTimeout(timeoutHandle);
    }
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function saveTaskResult(task, {
  outputDir = 'outputs',
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error('task must be an object');
  }

  const taskId = requireTaskId(task.taskId);
  const directory = resolve(outputDir, taskId);
  const taskFile = join(directory, 'task.json');
  const outputFiles = [];

  await mkdir(directory, { recursive: true });
  await writeFile(taskFile, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

  if (task.status !== 'success') {
    return { directory, taskFile, outputFiles };
  }

  const outputs = task.output ?? [];
  if (!Array.isArray(outputs)) {
    throw new Error('task.output must be an array');
  }

  for (const [index, output] of outputs.entries()) {
    if (!output || typeof output.url !== 'string' || output.url === '') {
      throw new Error(`task.output[${index}].url is required`);
    }

    const response = await fetchImpl(output.url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to download output ${index + 1}: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error(`Failed to download output ${index + 1}: empty response body`);
    }

    const suffix = extensionForOutput(output, response);
    const outputFile = join(directory, `output-${String(index + 1).padStart(2, '0')}${suffix}`);
    const temporaryFile = `${outputFile}.${randomUUID()}.part`;

    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporaryFile, { flags: 'wx' }),
        { signal },
      );
      await rename(temporaryFile, outputFile);
    } catch (error) {
      await rm(temporaryFile, { force: true });
      throw error;
    }

    outputFiles.push(outputFile);
  }

  return { directory, taskFile, outputFiles };
}
