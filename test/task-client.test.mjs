import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  getTask,
  saveTaskResult,
  submitTask,
  waitForTask,
} from '../src/task-client.mjs';

const HIAPI_ORIGIN = 'https://api.hiapi.ai';

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, body, statusCode = 200) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function startServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      sendJson(response, { message: error.message }, 500);
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  assert(address && typeof address === 'object');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

function localFetch(origin) {
  return (input, init) => {
    const url = new URL(input);

    if (url.origin === HIAPI_ORIGIN) {
      return fetch(new URL(`${url.pathname}${url.search}`, origin), init);
    }
    if (url.origin === origin) {
      return fetch(url, init);
    }

    throw new Error(`Unexpected network request: ${url}`);
  };
}

test('submitTask sends the unified task request and unwraps data', async (t) => {
  let capturedRequest;
  const server = await startServer(async (request, response) => {
    capturedRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await readRequestBody(request),
    };
    sendJson(response, { data: { taskId: 'task-submit', status: 'queued' } });
  });
  t.after(server.close);

  const payload = { model: 'example/model', input: { prompt: 'hello' } };
  const task = await submitTask(payload, {
    apiKey: 'test-api-key',
    idempotencyKey: 'request-123',
    fetchImpl: localFetch(server.origin),
  });

  assert.deepEqual(task, { taskId: 'task-submit', status: 'queued' });
  assert.equal(capturedRequest.method, 'POST');
  assert.equal(capturedRequest.url, '/v1/tasks');
  assert.equal(capturedRequest.headers.authorization, 'Bearer test-api-key');
  assert.equal(capturedRequest.headers['content-type'], 'application/json');
  assert.equal(capturedRequest.headers['idempotency-key'], 'request-123');
  assert.deepEqual(JSON.parse(capturedRequest.body), payload);
});

test('getTask uses the task endpoint and unwraps data', async (t) => {
  let capturedRequest;
  const server = await startServer((request, response) => {
    capturedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    };
    sendJson(response, { data: { taskId: 'task-query', status: 'handling' } });
  });
  t.after(server.close);

  const task = await getTask('task-query', {
    apiKey: 'test-api-key',
    fetchImpl: localFetch(server.origin),
  });

  assert.deepEqual(task, { taskId: 'task-query', status: 'handling' });
  assert.deepEqual(capturedRequest, {
    method: 'GET',
    url: '/v1/tasks/task-query',
    authorization: 'Bearer test-api-key',
  });
});

test('waitForTask follows queued, handling, archiving, and success', async (t) => {
  const statuses = ['queued', 'handling', 'archiving', 'success'];
  const seenStatuses = [];
  let requestCount = 0;
  const server = await startServer((request, response) => {
    assert.equal(request.url, '/v1/tasks/task-wait');
    const status = statuses[requestCount];
    requestCount += 1;
    sendJson(response, { data: { taskId: 'task-wait', status } });
  });
  t.after(server.close);

  const task = await waitForTask('task-wait', {
    apiKey: 'test-api-key',
    fetchImpl: localFetch(server.origin),
    intervalMs: 0,
    onStatus: ({ status }) => seenStatuses.push(status),
  });

  assert.equal(task.status, 'success');
  assert.equal(requestCount, 4);
  assert.deepEqual(seenStatuses, statuses);
});

test('waitForTask returns an HTTP 200 fail task as a terminal result', async (t) => {
  const server = await startServer((request, response) => {
    sendJson(response, {
      data: {
        taskId: 'task-fail',
        status: 'fail',
        error: { code: 'INVALID_INPUT', message: 'bad prompt' },
      },
    });
  });
  t.after(server.close);

  const task = await waitForTask('task-fail', {
    apiKey: 'test-api-key',
    fetchImpl: localFetch(server.origin),
    intervalMs: 0,
  });

  assert.equal(task.status, 'fail');
  assert.equal(task.error.code, 'INVALID_INPUT');
});

test('waitForTask aborts an in-flight request when timeoutMs expires', async (t) => {
  const server = await startServer((request, response) => {
    const timer = setTimeout(() => {
      sendJson(response, { data: { taskId: 'task-timeout', status: 'success' } });
    }, 100);
    response.once('close', () => clearTimeout(timer));
  });
  t.after(server.close);

  await assert.rejects(
    waitForTask('task-timeout', {
      apiKey: 'test-api-key',
      fetchImpl: localFetch(server.origin),
      intervalMs: 0,
      timeoutMs: 20,
    }),
    /Timed out waiting for task task-timeout/,
  );
});

test('saveTaskResult writes task.json and streams local outputs', async (t) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'hiapi-task-client-'));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));

  const server = await startServer((request, response) => {
    assert.equal(request.url, '/result');
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.write('chunk-one-');
    setImmediate(() => response.end('chunk-two'));
  });
  t.after(server.close);

  const task = {
    taskId: 'task-save',
    status: 'success',
    output: [{
      url: `${server.origin}/result`,
      type: 'video',
      expireAt: 1_785_225_600,
    }],
  };
  const outputDir = join(tempDirectory, 'outputs');
  const saved = await saveTaskResult(task, {
    outputDir,
    fetchImpl: localFetch(server.origin),
  });

  assert.equal(saved.directory, resolve(outputDir, 'task-save'));
  assert.equal(saved.outputFiles.length, 1);
  assert.equal(await readFile(saved.outputFiles[0], 'utf8'), 'chunk-one-chunk-two');
  assert.deepEqual(JSON.parse(await readFile(saved.taskFile, 'utf8')), task);
});

test('saveTaskResult removes partial downloads and preserves existing files', async (t) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'hiapi-task-client-'));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));

  const server = await startServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.write('partial-data');
    setImmediate(() => response.destroy(new Error('stream interrupted')));
  });
  t.after(server.close);

  const outputDir = join(tempDirectory, 'outputs');
  const taskDirectory = resolve(outputDir, 'task-partial');
  const existingOutput = join(taskDirectory, 'output-01.mp4');
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(existingOutput, 'existing-complete-file', 'utf8');

  await assert.rejects(saveTaskResult({
    taskId: 'task-partial',
    status: 'success',
    output: [{ url: `${server.origin}/partial`, type: 'video', expireAt: 1_785_225_600 }],
  }, {
    outputDir,
    fetchImpl: localFetch(server.origin),
  }));

  assert.equal(await readFile(existingOutput, 'utf8'), 'existing-complete-file');
  assert.equal((await readdir(taskDirectory)).some((name) => name.endsWith('.part')), false);
});

test('saveTaskResult saves failed task metadata without downloading outputs', async (t) => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'hiapi-task-client-'));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));
  let requestedOutput = false;

  const task = {
    taskId: 'task-save-fail',
    status: 'fail',
    output: [{ url: 'https://example.invalid/should-not-download', type: 'video/mp4' }],
  };
  const saved = await saveTaskResult(task, {
    outputDir: join(tempDirectory, 'outputs'),
    fetchImpl: () => {
      requestedOutput = true;
      throw new Error('output should not be requested');
    },
  });

  assert.equal(requestedOutput, false);
  assert.deepEqual(saved.outputFiles, []);
  assert.deepEqual(JSON.parse(await readFile(saved.taskFile, 'utf8')), task);
});
