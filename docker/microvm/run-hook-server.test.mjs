import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'run-hook-server.mjs');
const HOOK_PATH = '/aws/lambda-microvms/runtime/v1/run';
const HEALTH_PATH = '/healthz';
const RUN_PATH = '/run';
const PORT = 19473;
const HOST = '127.0.0.1';

const VALID_PAYLOAD = { gitRepoUrl: 'https://example.com/x.git', gitBranch: 'main', externalUrl: 'http://localhost:8787' };

let child;
let workdir;

function requestOn(port, path, method, body) {
  return new Promise((resolve, nope) => {
    const hasBody = body !== undefined && method !== 'GET';
    const payload = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = hasBody
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {};
    const req = request({ host: HOST, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', nope);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function post(path, body) {
  return requestOn(PORT, path, 'POST', body ?? {});
}

function get(path) {
  return requestOn(PORT, path, 'GET');
}

function postTo(port, path, body) {
  return requestOn(port, path, 'POST', body ?? {});
}

function getFrom(port, path) {
  return requestOn(port, path, 'GET');
}

async function waitReadyOn(port, deadlineMs) {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    try {
      const r = await getFrom(port, HEALTH_PATH);
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function waitReady(deadlineMs) {
  if (!(await waitReadyOn(PORT, deadlineMs))) throw new Error('server did not become ready');
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'ok-hook-'));
  const stub = join(workdir, 'entrypoint-stub.sh');
  writeFileSync(stub, '#!/bin/sh\nsleep 30\n');
  chmodSync(stub, 0o755);
  child = spawn(process.execPath, [SERVER], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      OK_RUN_HOOK_PATH: HOOK_PATH,
      OK_RUN_HOOK_PORT: String(PORT),
      OK_RUN_HOOK_HOST: HOST,
      OK_ENTRYPOINT: stub,
    },
  });
  await waitReady(5000);
});

after(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

async function startServer(stubScript, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hook-'));
  const stub = join(dir, 'entrypoint-stub.sh');
  writeFileSync(stub, stubScript);
  chmodSync(stub, 0o755);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    let stderr = '';
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        OK_RUN_HOOK_PATH: HOOK_PATH,
        OK_RUN_HOOK_PORT: String(port),
        OK_RUN_HOOK_HOST: HOST,
        OK_ENTRYPOINT: stub,
        ...extraEnv,
      },
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => {
      stderr += c;
    });
    const ready = await waitReadyOn(port, 5000);
    if (ready) {
      return { proc, port, dir, stderr: () => stderr };
    }
    if (!proc.killed) proc.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error('could not start isolated server on a free port');
}

function teardown(inst) {
  if (!inst) return;
  if (inst.proc && !inst.proc.killed) inst.proc.kill('SIGKILL');
  if (inst.dir) rmSync(inst.dir, { recursive: true, force: true });
}

test('health responder answers 200 {ok:true} on a GET to a non-run path', async () => {
  const r = await get(HEALTH_PATH);
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
});

test('bare POST /run returns 200 and triggers boot', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const second = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(second.status, 409);
    assert.match(second.body, /already_booted/);
  } finally {
    teardown(inst);
  }
});

test('POST to the long AWS hook path still returns 200', async () => {
  const r = await post(HOOK_PATH, VALID_PAYLOAD);
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
  assert.match(r.body, /"branch":"main"/);
});

test('an unmatched request is logged to stderr as a run-hook inbound line', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await postTo(inst.port, '/nope', VALID_PAYLOAD);
    assert.equal(r.status, 404);
    const deadline = Date.now() + 2000;
    while (!/run-hook: inbound POST \/nope/.test(inst.stderr()) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.match(inst.stderr(), /run-hook: inbound POST \/nope from /);
  } finally {
    teardown(inst);
  }
});

test('empty body on the AWS path returns 400 malformed_json', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await postTo(inst.port, HOOK_PATH, '');
    assert.equal(r.status, 400);
    assert.match(r.body, /malformed_json/);
  } finally {
    teardown(inst);
  }
});

test('valid JSON with missing fields on the AWS path returns 400 bad_schema', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await postTo(inst.port, HOOK_PATH, {});
    assert.equal(r.status, 400);
    assert.match(r.body, /bad_schema/);
  } finally {
    teardown(inst);
  }
});

test('a GET to the run path is not treated as a run hook (health responder answers 200)', async () => {
  const r = await get(RUN_PATH);
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
});

test('a non-GET, non-run request returns 404 not_found', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await requestOn(inst.port, '/nope', 'DELETE', {});
    assert.equal(r.status, 404);
    assert.match(r.body, /not_found/);
  } finally {
    teardown(inst);
  }
});

test('payload larger than MAX_BYTES is rejected 413 payload_too_large', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const big = { gitRepoUrl: 'https://example.com/x.git', gitBranch: 'main', externalUrl: 'http://localhost:8787', pad: 'x'.repeat(5000) };
    const r = await postTo(inst.port, HOOK_PATH, big);
    assert.equal(r.status, 413);
    assert.match(r.body, /payload_too_large/);
  } finally {
    teardown(inst);
  }
});

test('ack is sent before the entrypoint completes (does not wait for the long-running child)', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const started = Date.now();
    const r = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    const elapsed = Date.now() - started;
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.ok(elapsed < 2000, `ack took ${elapsed}ms, expected < 2000ms while stub sleeps 10s`);
  } finally {
    teardown(inst);
  }
});

test('server stays alive and keeps answering after the entrypoint child fails fast', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nexit 7\n');
    const r = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(inst.proc.exitCode, null, 'hook server process should still be running after child exit');
    const health = await getFrom(inst.port, HEALTH_PATH);
    assert.equal(health.status, 200);
    const second = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(second.status, 409);
    assert.match(second.body, /already_booted/);
  } finally {
    teardown(inst);
  }
});

test('a second run after a successful boot returns 409 already_booted', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const first = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(first.status, 200);
    const second = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(second.status, 409);
    assert.match(second.body, /already_booted/);
  } finally {
    teardown(inst);
  }
});

test('POST-method requirement: GET to the AWS hook path does not boot (health responder answers 200)', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, HOOK_PATH);
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    const run = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
  } finally {
    teardown(inst);
  }
});
