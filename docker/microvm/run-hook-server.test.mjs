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
const READY_PATH = '/aws/lambda-microvms/runtime/v1/ready';
const OLD_PATH = '/run';
const PORT = 19473;
const HOST = '127.0.0.1';

let child;
let workdir;

function post(path, body) {
  return new Promise((resolve, nope) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const req = request(
      { host: HOST, port: PORT, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', nope);
    req.end(payload);
  });
}

async function waitReady(deadlineMs) {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    try {
      const r = await post(READY_PATH, {});
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
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
      OK_RUN_HOOK_READY_METHOD: 'POST',
      OK_RUN_HOOK_READY_PATHS: `${READY_PATH},/ready`,
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

test('ready probe answers 200 on the AWS ready path', async () => {
  const r = await post(READY_PATH, {});
  assert.equal(r.status, 200);
});

test('old /run path now returns 404 after the env override moved the route', async () => {
  const r = await post(OLD_PATH, { gitRepoUrl: 'https://example.com/x.git', gitBranch: 'main', externalUrl: 'http://localhost:8787' });
  assert.equal(r.status, 404);
  assert.match(r.body, /not_found/);
});

test('empty body on the AWS path returns 400 malformed_json', async () => {
  const r = await post(HOOK_PATH, '');
  assert.equal(r.status, 400);
  assert.match(r.body, /malformed_json/);
});

test('valid JSON with missing fields on the AWS path returns 400 bad_schema', async () => {
  const r = await post(HOOK_PATH, {});
  assert.equal(r.status, 400);
  assert.match(r.body, /bad_schema/);
});

test('valid payload on the AWS path returns 200 (regression fix)', async () => {
  const r = await post(HOOK_PATH, { gitRepoUrl: 'https://example.com/x.git', gitBranch: 'main', externalUrl: 'http://localhost:8787' });
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
  assert.match(r.body, /"branch":"main"/);
});

const VALID_PAYLOAD = { gitRepoUrl: 'https://example.com/x.git', gitBranch: 'main', externalUrl: 'http://localhost:8787' };

function postTo(port, path, body) {
  return new Promise((resolve, nope) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const req = request(
      { host: HOST, port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', nope);
    req.end(payload);
  });
}

async function waitReadyOn(port, deadlineMs) {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    try {
      const r = await postTo(port, READY_PATH, {});
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function startServer(stubScript) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hook-'));
  const stub = join(dir, 'entrypoint-stub.sh');
  writeFileSync(stub, stubScript);
  chmodSync(stub, 0o755);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        OK_RUN_HOOK_PATH: HOOK_PATH,
        OK_RUN_HOOK_READY_METHOD: 'POST',
        OK_RUN_HOOK_READY_PATHS: `${READY_PATH},/ready`,
        OK_RUN_HOOK_PORT: String(port),
        OK_RUN_HOOK_HOST: HOST,
        OK_ENTRYPOINT: stub,
      },
    });
    const ready = await waitReadyOn(port, 5000);
    if (ready) {
      return { proc, port, dir };
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
    const ready = await postTo(inst.port, READY_PATH, {});
    assert.equal(ready.status, 200);
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
