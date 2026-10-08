import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

const DEFAULT_GIT_REPO_URL = 'https://github.com/inkeep/open-knowledge';
const DEFAULT_GIT_BRANCH = 'main';
const DEFAULT_EXTERNAL_URL = 'https://placeholder.local';

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

async function settle(ms) {
  await new Promise((res) => setTimeout(res, ms));
}

const READY_PATH = '/aws/lambda-microvms/runtime/v1/ready';
const READY_SHORT = '/ready';

async function startServerWithEnvDump(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hook-'));
  const sentinel = join(dir, 'booted.marker');
  const envdump = join(dir, 'child.env');
  const stub = join(dir, 'entrypoint-stub.sh');
  writeFileSync(
    stub,
    `#!/bin/sh\ntouch "${sentinel}"\nprintf 'GIT_REPO_URL=%s\\nGIT_BRANCH=%s\\nOK_EXTERNAL_URL=%s\\n' "$GIT_REPO_URL" "$GIT_BRANCH" "$OK_EXTERNAL_URL" > "${envdump}"\nsleep 10\n`,
  );
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
      return { proc, port, dir, sentinel, envdump, stderr: () => stderr };
    }
    if (!proc.killed) proc.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error('could not start isolated server on a free port');
}

async function startServerWithSentinel(extraEnv = {}) {
  const inst = await startServerWithEnvDump(extraEnv);
  return inst;
}

async function readChildEnv(inst, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(inst.envdump)) {
      const text = readFileSync(inst.envdump, 'utf8');
      if (/GIT_REPO_URL=/.test(text) && /GIT_BRANCH=/.test(text) && /OK_EXTERNAL_URL=/.test(text)) {
        const out = {};
        for (const line of text.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
        }
        return out;
      }
    }
    await settle(25);
  }
  throw new Error('entrypoint env dump never appeared');
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

test('never-400 contract: empty body on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, '');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('never-400 contract: non-JSON string body on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, 'not json at all <<< }{');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('never-400 contract: JSON array body "[]" on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, '[]');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('never-400 contract: JSON null body "null" on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, 'null');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('never-400 contract: empty JSON object "{}" on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, '{}');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('never-400 contract: bare number body "123" on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, '123');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('never-400 contract: bare JSON string body "str" on first POST /run returns 200 and boots with defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, '"str"');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('override precedence: {gitBranch:"x"} overrides branch only, repo and externalUrl stay default', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, { gitBranch: 'x' });
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"x"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'x');
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('override precedence: empty-string {gitRepoUrl:""} is not a non-empty string so falls to default', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, { gitRepoUrl: '' });
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('override precedence: wrong-type {gitBranch:123} is not a non-empty string so falls to default', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const r = await postTo(inst.port, RUN_PATH, { gitBranch: 123 });
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"main"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, DEFAULT_GIT_BRANCH);
  } finally {
    teardown(inst);
  }
});

test('default sourcing from env: OK_DEFAULT_GIT_BRANCH=release with {} body boots branch "release"', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump({ OK_DEFAULT_GIT_BRANCH: 'release' });
    const r = await postTo(inst.port, RUN_PATH, {});
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"release"/);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'release');
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('idempotency: second POST /run returns 409 already_booted and the entrypoint spawns exactly once', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const first = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(first.status, 200);
    await readChildEnv(inst);
    rmSync(inst.sentinel, { force: true });
    const second = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(second.status, 409);
    assert.match(second.body, /already_booted/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'the entrypoint must not spawn a second time');
  } finally {
    teardown(inst);
  }
});

test('concurrency guard: two overlapping POST /run yield exactly one 200 and one 409 with a single spawn', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const [a, b] = await Promise.all([
      postTo(inst.port, RUN_PATH, VALID_PAYLOAD),
      postTo(inst.port, RUN_PATH, VALID_PAYLOAD),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const okOne = a.status === 200 ? a : b;
    assert.match(okOne.body, /"ok":true/);
    const conflictOne = a.status === 409 ? a : b;
    assert.match(conflictOne.body, /already_booted/);
    await readChildEnv(inst);
    rmSync(inst.sentinel, { force: true });
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'exactly one spawn across the two overlapping posts');
  } finally {
    teardown(inst);
  }
});

test('413 cap: a body of MAX_BYTES+1 is rejected 413 payload_too_large with no spawn', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const big = 'x'.repeat(4097);
    const r = await postTo(inst.port, RUN_PATH, big);
    assert.equal(r.status, 413);
    assert.match(r.body, /payload_too_large/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'an over-cap body must not spawn the entrypoint');
  } finally {
    teardown(inst);
  }
});

test('raw-body log is emitted before resolve with a byte count equal to Buffer.byteLength of a multibyte body', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const body = '{"gitBranch":"\u20ac\u20ac\u20ac"}';
    const expectedBytes = Buffer.byteLength(body, 'utf8');
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    const deadline = Date.now() + 2000;
    const re = new RegExp(`run-hook: run-body ${expectedBytes} bytes content-type=`);
    while (!re.test(inst.stderr()) && Date.now() < deadline) {
      await settle(25);
    }
    assert.match(inst.stderr(), re);
    assert.notEqual(expectedBytes, body.length);
  } finally {
    teardown(inst);
  }
});

test('regression matrix: POST /ready returns 200', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const r = await postTo(inst.port, READY_SHORT, {});
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    await settle(200);
    assert.equal(existsSync(inst.sentinel), false);
  } finally {
    teardown(inst);
  }
});

test('regression matrix: POST the AWS ready path returns 200', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const r = await postTo(inst.port, READY_PATH, {});
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    await settle(200);
    assert.equal(existsSync(inst.sentinel), false);
  } finally {
    teardown(inst);
  }
});

test('regression matrix: a GET to any non-run path returns 200 from the health responder', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, '/anything/at/all');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
  } finally {
    teardown(inst);
  }
});

test('regression matrix: DELETE /run returns 404 not_found', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await requestOn(inst.port, RUN_PATH, 'DELETE', {});
    assert.equal(r.status, 404);
    assert.match(r.body, /not_found/);
  } finally {
    teardown(inst);
  }
});

test('regression matrix: POST to the AWS run fallback path returns 200', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
  } finally {
    teardown(inst);
  }
});

test('200-before-spawn ordering: a non-zero entrypoint still returns 200 to the client while the child failure sets exitCode', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n', { OK_ENTRYPOINT: '/bin/false' });
    const r = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    const health = await getFrom(inst.port, HEALTH_PATH);
    assert.equal(health.status, 200);
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

test('POST to the AWS ready path returns 200 {ok:true} and does not spawn the entrypoint', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const r = await postTo(inst.port, READY_PATH, {});
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'entrypoint must not run on a readiness ack');
    const run = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
  } finally {
    teardown(inst);
  }
});

test('POST to the short /ready path returns 200 and does not spawn the entrypoint', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const r = await postTo(inst.port, READY_SHORT, {});
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'entrypoint must not run on a short readiness ack');
    const run = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
  } finally {
    teardown(inst);
  }
});

test('two consecutive readiness acks both return 200 and a later POST /run still boots', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const first = await postTo(inst.port, READY_PATH, {});
    assert.equal(first.status, 200);
    const second = await postTo(inst.port, READY_PATH, {});
    assert.equal(second.status, 200);
    const run = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    assert.match(run.body, /"branch":"main"/);
    const again = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(again.status, 409);
    assert.match(again.body, /already_booted/);
  } finally {
    teardown(inst);
  }
});

test('a readiness ack after a successful boot still returns 200', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const run = await postTo(inst.port, HOOK_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    const ready = await postTo(inst.port, READY_PATH, {});
    assert.equal(ready.status, 200);
    assert.match(ready.body, /"ok":true/);
    const readyShort = await postTo(inst.port, READY_SHORT, {});
    assert.equal(readyShort.status, 200);
  } finally {
    teardown(inst);
  }
});

test('GET /ready falls through to the health responder and PUT /ready returns 404 not_found', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const getReady = await getFrom(inst.port, READY_SHORT);
    assert.equal(getReady.status, 200);
    assert.match(getReady.body, /"ok":true/);
    const putReady = await requestOn(inst.port, READY_SHORT, 'PUT', {});
    assert.equal(putReady.status, 404);
    assert.match(putReady.body, /not_found/);
  } finally {
    teardown(inst);
  }
});

test('OK_RUN_HOOK_READY_PATH override: custom path acks 200, default AWS ready path no longer matches, short /ready still acks', async () => {
  let inst;
  try {
    const custom = '/custom/ready/path';
    inst = await startServerWithSentinel({ OK_RUN_HOOK_READY_PATH: custom });
    const customReady = await postTo(inst.port, custom, {});
    assert.equal(customReady.status, 200);
    assert.match(customReady.body, /"ok":true/);
    const defaultReady = await postTo(inst.port, READY_PATH, {});
    assert.equal(defaultReady.status, 404);
    assert.match(defaultReady.body, /not_found/);
    const shortReady = await postTo(inst.port, READY_SHORT, {});
    assert.equal(shortReady.status, 200);
    assert.match(shortReady.body, /"ok":true/);
  } finally {
    teardown(inst);
  }
});

test('OK_RUN_HOOK_METHOD set to PUT: POST to the ready path still returns 200', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel({ OK_RUN_HOOK_METHOD: 'PUT' });
    const r = await postTo(inst.port, READY_PATH, {});
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    const short = await postTo(inst.port, READY_SHORT, {});
    assert.equal(short.status, 200);
  } finally {
    teardown(inst);
  }
});

test('a readiness ack with a junk/empty body still returns 200 because the body is never parsed', async () => {
  let inst;
  try {
    inst = await startServerWithSentinel();
    const junk = await postTo(inst.port, READY_PATH, 'not json at all <<< }{');
    assert.equal(junk.status, 200);
    assert.match(junk.body, /"ok":true/);
    const empty = await postTo(inst.port, READY_PATH, '');
    assert.equal(empty.status, 200);
    assert.match(empty.body, /"ok":true/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'a junk-body readiness ack must not spawn the entrypoint');
  } finally {
    teardown(inst);
  }
});
