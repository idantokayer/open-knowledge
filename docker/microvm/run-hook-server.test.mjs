import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request, createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
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

function requestOn(port, path, method, body, extraHeaders) {
  return new Promise((resolve, nope) => {
    const hasBody = body !== undefined && method !== 'GET';
    const payload = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = hasBody
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {};
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const req = request({ host: HOST, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
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

const MALFORMED_HOST = 'a_b@c:d:e';

function getWithHost(port, path, host) {
  return requestOn(port, path, 'GET', undefined, { host });
}

async function triggerBootFallbackHost(inst) {
  return getWithHost(inst.port, '/', MALFORMED_HOST);
}

test('health responder answers 200 {ok:true} on a GET to the scoped health path', async () => {
  const r = await get(HEALTH_PATH);
  assert.equal(r.status, 200);
  assert.match(r.body, /"ok":true/);
});

test('a GET to a non-health, non-hook path falls through to the proxy and returns 503 before the app is ready', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, '/some/ui/route');
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
  } finally {
    teardown(inst);
  }
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
    assert.equal(r.status, 503);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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
    await triggerBootFallbackHost(inst);
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

test('regression matrix: a GET to any non-health path falls through to the proxy (503 before ready)', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, '/anything/at/all');
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
  } finally {
    teardown(inst);
  }
});

test('regression matrix: DELETE /run is not a hook and falls through to the proxy (503 before ready)', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await requestOn(inst.port, RUN_PATH, 'DELETE', {});
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
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

test('a GET to the run path is not treated as a run hook and falls through to the proxy', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, RUN_PATH);
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
  } finally {
    teardown(inst);
  }
});

test('a non-GET, non-run request falls through to the proxy (503 before ready)', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await requestOn(inst.port, '/nope', 'DELETE', {});
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
  } finally {
    teardown(inst);
  }
});

test('POST-method requirement: GET to the AWS hook path does not boot (falls through to the proxy)', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, HOOK_PATH);
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
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

test('GET /ready and PUT /ready are not readiness acks and fall through to the proxy', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const getReady = await getFrom(inst.port, READY_SHORT);
    assert.equal(getReady.status, 503);
    assert.equal(getReady.headers['retry-after'], '1');
    const putReady = await requestOn(inst.port, READY_SHORT, 'PUT', {});
    assert.equal(putReady.status, 503);
    assert.equal(putReady.headers['retry-after'], '1');
  } finally {
    teardown(inst);
  }
});

test('OK_RUN_HOOK_READY_PATH override: custom path acks 200, default AWS ready path no longer acks (proxied), short /ready still acks', async () => {
  let inst;
  try {
    const custom = '/custom/ready/path';
    inst = await startServerWithSentinel({ OK_RUN_HOOK_READY_PATH: custom });
    const customReady = await postTo(inst.port, custom, {});
    assert.equal(customReady.status, 200);
    assert.match(customReady.body, /"ok":true/);
    const defaultReady = await postTo(inst.port, READY_PATH, {});
    assert.equal(defaultReady.status, 503);
    assert.equal(defaultReady.headers['retry-after'], '1');
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

test('runHookPayload wrapper: the real AWS envelope resolves all three inner values, not defaults', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const inner = {
      gitRepoUrl: 'https://github.com/acme/kb',
      gitBranch: 'dev',
      externalUrl: 'https://kb.example.com',
    };
    const body = { microvmId: 'm', runHookPayload: JSON.stringify(inner) };
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"dev"/);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, 'https://github.com/acme/kb');
    assert.equal(env.GIT_BRANCH, 'dev');
    assert.equal(env.OK_EXTERNAL_URL, 'https://kb.example.com');
    assert.notEqual(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('runHookPayload wrapper: a field omitted from the inner payload falls back to its default', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const body = { microvmId: 'm', runHookPayload: JSON.stringify({ gitBranch: 'dev' }) };
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"dev"/);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'dev');
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('runHookPayload wrapper: a non-JSON string payload falls back to the outer body and does not throw', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const body = { microvmId: 'm', gitBranch: 'outerbranch', runHookPayload: 'not json at all <<< }{' };
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"outerbranch"/);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'outerbranch');
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('runHookPayload wrapper: a non-string (object) payload is ignored and top-level overrides apply (back-compat)', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const body = {
      gitRepoUrl: 'https://github.com/legacy/kb',
      gitBranch: 'legacy',
      externalUrl: 'https://legacy.example.com',
      runHookPayload: { gitBranch: 'ignored' },
    };
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"legacy"/);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_REPO_URL, 'https://github.com/legacy/kb');
    assert.equal(env.GIT_BRANCH, 'legacy');
    assert.equal(env.OK_EXTERNAL_URL, 'https://legacy.example.com');
  } finally {
    teardown(inst);
  }
});

test('runHookPayload wrapper: an absent payload with top-level overrides keeps the legacy unwrapped shape working', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const body = { gitBranch: 'toplevel' };
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"toplevel"/);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'toplevel');
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('runHookPayload wrapper: an inner payload that is valid JSON but an array falls back to the outer body, no throw', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const body = { microvmId: 'm', gitBranch: 'outerarr', runHookPayload: '[1,2,3]' };
    const r = await postTo(inst.port, RUN_PATH, body);
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"outerarr"/);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'outerarr');
    assert.equal(env.GIT_REPO_URL, DEFAULT_GIT_REPO_URL);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

function startUpstream(handler, onUpgrade) {
  return new Promise((resolve) => {
    const up = createHttpServer(handler);
    if (onUpgrade) up.on('upgrade', onUpgrade);
    up.listen(0, HOST, () => resolve({ server: up, port: up.address().port }));
  });
}

async function startServerProxying(upstreamPort, extraEnv = {}) {
  const inst = await startServer('#!/bin/sh\nsleep 30\n', {
    PORT: String(upstreamPort),
    OK_APP_READYZ_PATH: '/readyz',
    ...extraEnv,
  });
  const boot = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
  assert.equal(boot.status, 200);
  return inst;
}

async function waitProxyReady(port, deadlineMs) {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    const r = await getFrom(port, '/some/ui/route');
    if (r.status !== 503) return true;
    await settle(50);
  }
  return false;
}

test('readiness poll: once upstream /readyz answers 2xx, a GET proxies through with the upstream status and body', async () => {
  let inst;
  let upstream;
  try {
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      res.writeHead(201, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
      res.end(`hello ${req.url}`);
    });
    inst = await startServerProxying(upstream.port);
    const ready = await waitProxyReady(inst.port, 5000);
    assert.equal(ready, true, 'proxy should become ready once upstream /readyz is 2xx');
    const r = await getFrom(inst.port, '/documents/x');
    assert.equal(r.status, 201);
    assert.equal(r.headers['x-upstream'], 'yes');
    assert.match(r.body, /hello \/documents\/x/);
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('proxy forwards method and body verbatim and is not capped by MAX_BYTES', async () => {
  let inst;
  let upstream;
  try {
    let seenMethod = '';
    let seenBody = '';
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      seenMethod = req.method;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end('ok');
      });
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const big = 'y'.repeat(50000);
    const r = await requestOn(inst.port, '/api/documents', 'PUT', big);
    assert.equal(r.status, 200);
    assert.equal(seenMethod, 'PUT');
    assert.equal(seenBody.length, 50000);
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('proxy forwards Host verbatim and sets X-Forwarded-* so origin validation can admit the external host', async () => {
  let inst;
  let upstream;
  try {
    let seen = {};
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      seen = {
        host: req.headers.host,
        origin: req.headers.origin,
        xfHost: req.headers['x-forwarded-host'],
        xfProto: req.headers['x-forwarded-proto'],
        xfFor: req.headers['x-forwarded-for'],
      };
      res.writeHead(200);
      res.end('ok');
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const r = await requestOn(inst.port, '/api/documents', 'GET', undefined, {
      host: 'ok.snake-release-non-prod.toluna.me',
      origin: 'https://ok.snake-release-non-prod.toluna.me',
    });
    assert.equal(r.status, 200);
    assert.equal(seen.host, 'ok.snake-release-non-prod.toluna.me');
    assert.equal(seen.origin, 'https://ok.snake-release-non-prod.toluna.me');
    assert.equal(seen.xfHost, 'ok.snake-release-non-prod.toluna.me');
    assert.equal(seen.xfProto, 'http');
    assert.match(seen.xfFor, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/);
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('upstream connect error after ready yields 502', async () => {
  let inst;
  let upstream;
  try {
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    upstream.server.close();
    upstream = null;
    await settle(100);
    const r = await getFrom(inst.port, '/documents/x');
    assert.equal(r.status, 502);
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('health path stays scoped: GET /healthz is answered locally, never proxied', async () => {
  let inst;
  let upstream;
  try {
    let healthzProxied = false;
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      if (req.url === '/healthz') healthzProxied = true;
      res.writeHead(200);
      res.end('upstream');
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const r = await getFrom(inst.port, '/healthz');
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.equal(healthzProxied, false, '/healthz must be answered by the hook server, not proxied');
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('WebSocket upgrade is proxied to the upstream once ready', async () => {
  let inst;
  let upstream;
  try {
    upstream = await startUpstream(
      (req, res) => {
        if (req.url === '/readyz') {
          res.writeHead(200);
          res.end('ready');
          return;
        }
        res.writeHead(200);
        res.end('ok');
      },
      (req, socket) => {
        const key = req.headers['sec-websocket-key'] ?? '';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `X-Echo-Path: ${req.url}\r\n` +
            `X-Echo-Key: ${key}\r\n\r\n`,
        );
        socket.on('data', (d) => socket.write(d));
      },
    );
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const result = await new Promise((resolve, nope) => {
      const req = request({
        host: HOST,
        port: inst.port,
        path: '/collab/socket',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.once('data', (d) => {
          socket.destroy();
          resolve({ status: res.statusCode, echoPath: res.headers['x-echo-path'], echo: d.toString('utf8') });
        });
        socket.write('ping');
      });
      req.on('error', nope);
      req.end();
    });
    assert.equal(result.status, 101);
    assert.equal(result.echoPath, '/collab/socket');
    assert.equal(result.echo, 'ping');
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('WebSocket upgrade before the app is ready destroys the socket', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 30\n');
    const outcome = await new Promise((resolve) => {
      const req = request({
        host: HOST,
        port: inst.port,
        path: '/collab/socket',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      let upgraded = false;
      req.on('upgrade', () => {
        upgraded = true;
        resolve('upgraded');
      });
      req.on('error', () => resolve('socket-destroyed'));
      req.on('close', () => {
        if (!upgraded) resolve('socket-destroyed');
      });
      req.end();
    });
    assert.equal(outcome, 'socket-destroyed');
  } finally {
    teardown(inst);
  }
});

test('hop-by-hop strip: outbound request drops Connection-listed and standard hop-by-hop headers before upstream', async () => {
  let inst;
  let upstream;
  try {
    let seen = {};
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      seen = {
        connection: req.headers.connection,
        keepAlive: req.headers['keep-alive'],
        te: req.headers.te,
        upgrade: req.headers.upgrade,
        proxyAuth: req.headers['proxy-authorization'],
        xHop: req.headers['x-hop-token'],
        xKept: req.headers['x-kept'],
      };
      res.writeHead(200);
      res.end('ok');
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const r = await requestOn(inst.port, '/api/documents', 'GET', undefined, {
      connection: 'keep-alive, x-hop-token',
      'keep-alive': 'timeout=5',
      te: 'trailers',
      'proxy-authorization': 'Basic abc',
      'x-hop-token': 'should-be-dropped',
      'x-kept': 'yes',
    });
    assert.equal(r.status, 200);
    assert.equal(seen.keepAlive, undefined);
    assert.equal(seen.te, undefined);
    assert.equal(seen.proxyAuth, undefined);
    assert.equal(seen.xHop, undefined);
    assert.equal(seen.xKept, 'yes');
    assert.doesNotMatch(seen.connection ?? '', /x-hop-token/);
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('hop-by-hop strip: upstream response hop-by-hop headers are not forwarded to the client', async () => {
  let inst;
  let upstream;
  try {
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'keep-alive, x-resp-hop',
        'keep-alive': 'timeout=5',
        'x-resp-hop': 'should-be-dropped',
        'x-resp-kept': 'yes',
      });
      res.end('ok');
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const r = await getFrom(inst.port, '/documents/x');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-resp-hop'], undefined);
    assert.equal(r.headers['x-resp-kept'], 'yes');
    assert.doesNotMatch(r.headers.connection ?? '', /x-resp-hop/);
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

test('poll-exhausted contract: while still polling the proxy returns 503 + Retry-After:1 with a JSON starting body', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 10\n');
    const r = await getFrom(inst.port, '/some/ui/route');
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], '1');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.match(r.body, /"code":"starting"/);
  } finally {
    teardown(inst);
  }
});

test('poll-exhausted contract: after the readiness poll gives up the proxy returns 503 with NO Retry-After and a JSON unavailable body', async () => {
  let inst;
  try {
    inst = await startServer('#!/bin/sh\nsleep 30\n', {
      PORT: '1',
      OK_APP_READYZ_PATH: '/readyz',
      OK_APP_READYZ_MAX_TRIES: '1',
    });
    const boot = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(boot.status, 200);
    let r;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      r = await getFrom(inst.port, '/some/ui/route');
      if (r.headers['retry-after'] === undefined) break;
      await settle(100);
    }
    assert.equal(r.status, 503);
    assert.equal(r.headers['retry-after'], undefined, 'exhausted poll must stop advertising Retry-After');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.match(r.body, /"code":"unavailable"/);
  } finally {
    teardown(inst);
  }
});

test('lazy-boot gate: a bare GET / before any /run returns 503 starting, does not spawn, and does not latch booted', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const premature = await getFrom(inst.port, '/');
    assert.equal(premature.status, 503);
    assert.match(premature.body, /"code":"starting"/);
    assert.equal(premature.headers['retry-after'], '1');
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'a pre-/run probe must not spawn the entrypoint');
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await triggerBootFallbackHost(inst);
    const env = await readChildEnv(inst);
    assert.equal(env.GIT_BRANCH, 'main');
  } finally {
    teardown(inst);
  }
});

test('lazy-boot recovery: a premature GET / (503) does not wedge the VM, a later /run then GET / boots with the data-plane Host', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const premature = await getFrom(inst.port, '/');
    assert.equal(premature.status, 503);
    assert.match(premature.body, /"code":"starting"/);
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'abc.example');
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, VALID_PAYLOAD.externalUrl);
    rmSync(inst.sentinel, { force: true });
    await getWithHost(inst.port, '/again', 'abc.example');
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'the app must spawn exactly once, not on every data-plane request');
  } finally {
    teardown(inst);
  }
});

test('lazy-boot gate: with no /run ever, repeated GET / always returns 503 starting and the app is never spawned', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    for (let i = 0; i < 3; i += 1) {
      const r = await getFrom(inst.port, `/route/${i}`);
      assert.equal(r.status, 503);
      assert.match(r.body, /"code":"starting"/);
    }
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'no /run means no spawn, ever');
  } finally {
    teardown(inst);
  }
});

test('lazy-boot Host guard: a malformed data-plane Host falls back to the recorded externalUrl and spawns exactly once', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', MALFORMED_HOST);
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, VALID_PAYLOAD.externalUrl);
    assert.equal(env.GIT_REPO_URL, VALID_PAYLOAD.gitRepoUrl);
    assert.equal(env.GIT_BRANCH, VALID_PAYLOAD.gitBranch);
    rmSync(inst.sentinel, { force: true });
    await getWithHost(inst.port, '/second', MALFORMED_HOST);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'the malformed-Host fallback must still spawn exactly once');
  } finally {
    teardown(inst);
  }
});

test('lazy-boot Host guard: an empty recorded externalUrl plus a malformed Host falls back to DEFAULT_EXTERNAL_URL', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, { gitBranch: 'x' });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', MALFORMED_HOST);
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
    assert.equal(env.GIT_BRANCH, 'x');
  } finally {
    teardown(inst);
  }
});

test('lazy-boot concurrency: /run then two simultaneous GET / spawn the app exactly once', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await Promise.all([getWithHost(inst.port, '/', 'abc.example'), getWithHost(inst.port, '/', 'abc.example')]);
    await readChildEnv(inst);
    rmSync(inst.sentinel, { force: true });
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'two simultaneous first requests must yield exactly one spawn');
  } finally {
    teardown(inst);
  }
});

test('lazy-boot externalUrl provenance: a real payload externalUrl wins over the data-plane Host', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: 'https://github.com/acme/kb',
      gitBranch: 'main',
      externalUrl: 'https://payload.example',
    });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'dataplane.example');
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, 'https://payload.example');
    assert.notEqual(env.OK_EXTERNAL_URL, 'https://dataplane.example');
  } finally {
    teardown(inst);
  }
});

test('externalUrl precedence a: a real payload externalUrl wins over a different data-plane Host', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: 'https://github.com/acme/kb',
      gitBranch: 'main',
      externalUrl: 'https://kb.example.com',
    });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'different.host.example');
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, 'https://kb.example.com');
    assert.notEqual(env.OK_EXTERNAL_URL, 'https://different.host.example');
  } finally {
    teardown(inst);
  }
});

test('externalUrl precedence b: no payload externalUrl derives OK_EXTERNAL_URL from the data-plane Host (unchanged)', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, { gitRepoUrl: 'https://github.com/acme/kb', gitBranch: 'main' });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'derived.host.example');
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, 'https://derived.host.example');
    assert.notEqual(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('externalUrl precedence b2: the placeholder payload externalUrl is treated as default and derives from the Host', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: 'https://github.com/acme/kb',
      gitBranch: 'main',
      externalUrl: DEFAULT_EXTERNAL_URL,
    });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'derived.host.example');
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, 'https://derived.host.example');
    assert.notEqual(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('externalUrl precedence c: a malformed payload externalUrl falls through to the Host-derived origin, not DEFAULT', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: 'https://github.com/acme/kb',
      gitBranch: 'main',
      externalUrl: '::::',
    });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'fallback.host.example');
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, 'https://fallback.host.example');
    assert.notEqual(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('externalUrl precedence d: a malformed payload externalUrl AND a garbage Host fall back to DEFAULT_EXTERNAL_URL', async () => {
  let inst;
  try {
    inst = await startServerWithEnvDump();
    const run = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: 'https://github.com/acme/kb',
      gitBranch: 'main',
      externalUrl: '::::',
    });
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', MALFORMED_HOST);
    const env = await readChildEnv(inst);
    assert.equal(env.OK_EXTERNAL_URL, DEFAULT_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('forwardHeaders does not rewrite the outgoing Host: the proxied upstream request carries the original client Host (Option C locked out)', async () => {
  let inst;
  let upstream;
  try {
    let seenHost = '';
    upstream = await startUpstream((req, res) => {
      if (req.url === '/readyz') {
        res.writeHead(200);
        res.end('ready');
        return;
      }
      seenHost = req.headers.host;
      res.writeHead(200);
      res.end('ok');
    });
    inst = await startServerProxying(upstream.port);
    assert.equal(await waitProxyReady(inst.port, 5000), true);
    const clientHost = 'ok.snake-release-non-prod.toluna.me';
    const r = await requestOn(inst.port, '/api/documents', 'GET', undefined, { host: clientHost });
    assert.equal(r.status, 200);
    assert.equal(seenHost, clientHost, 'the upstream must receive the original client Host, not a hook-rewritten one');
  } finally {
    teardown(inst);
    if (upstream) upstream.server.close();
  }
});

const OK_RUN_DIR = '/tmp/ok-run';
const OK_RUN_KEY = '/tmp/ok-run/id_deploy';
const OK_RUN_HOSTS = '/tmp/ok-run/known_hosts';
const PEM_MARKER = 'MARKERv82f1c9d4e7a6b3550cafebabedeadbeef0123456789abcdefQAIDAN';
const PEM_FIXTURE = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${PEM_MARKER}\nAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACC\n-----END OPENSSH PRIVATE KEY-----\n`;
const KNOWN_HOSTS_FIXTURE = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabG23fixtureKnownHostsLine\n';
const SSH_REPO_URL = 'git@github.com:org/repo.git';
const HTTPS_REPO_URL = 'https://github.com/org/repo.git';

function cleanRunDir() {
  rmSync(OK_RUN_DIR, { recursive: true, force: true });
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

async function startServerWithKeyDump(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hook-'));
  const sentinel = join(dir, 'booted.marker');
  const envdump = join(dir, 'child.env');
  const stub = join(dir, 'entrypoint-stub.sh');
  writeFileSync(
    stub,
    `#!/bin/sh\ntouch "${sentinel}"\nprintf 'GIT_REPO_URL=%s\\nGIT_BRANCH=%s\\nOK_EXTERNAL_URL=%s\\nGIT_SSH_KEY_FILE=%s\\nGIT_KNOWN_HOSTS_FILE=%s\\nEND=1\\n' "$GIT_REPO_URL" "$GIT_BRANCH" "$OK_EXTERNAL_URL" "$GIT_SSH_KEY_FILE" "$GIT_KNOWN_HOSTS_FILE" > "${envdump}"\nsleep 10\n`,
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

async function readKeyEnv(inst, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(inst.envdump)) {
      const text = readFileSync(inst.envdump, 'utf8');
      if (/END=1/.test(text)) {
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

test('ssh-key matrix 1 happy path: key+known_hosts booted via data-plane writes 0600 files under a 0700 dir and forwards both env vars', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const r = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(r.status, 200);
    assert.match(r.body, /"branch":"main"/);
    await getWithHost(inst.port, '/', 'abc.example');
    const env = await readKeyEnv(inst);
    assert.equal(env.GIT_SSH_KEY_FILE, OK_RUN_KEY);
    assert.equal(env.GIT_KNOWN_HOSTS_FILE, OK_RUN_HOSTS);
    assert.equal(env.GIT_REPO_URL, SSH_REPO_URL);
    assert.equal(existsSync(OK_RUN_DIR), true);
    assert.equal(existsSync(OK_RUN_KEY), true);
    assert.equal(existsSync(OK_RUN_HOSTS), true);
    assert.equal(modeOf(OK_RUN_DIR), 0o700);
    assert.equal(modeOf(OK_RUN_KEY), 0o600);
    assert.equal(modeOf(OK_RUN_HOSTS), 0o600);
    assert.equal(readFileSync(OK_RUN_KEY, 'utf8'), PEM_FIXTURE);
    assert.equal(readFileSync(OK_RUN_HOSTS, 'utf8'), KNOWN_HOSTS_FIXTURE);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 2 absent-key regression: HTTPS repo with no key boots, forwards NEITHER env var, and never creates the run dir', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const r = await postTo(inst.port, RUN_PATH, { gitRepoUrl: HTTPS_REPO_URL, gitBranch: 'main' });
    assert.equal(r.status, 200);
    await getWithHost(inst.port, '/', 'abc.example');
    const env = await readKeyEnv(inst);
    assert.equal(env.GIT_SSH_KEY_FILE, '');
    assert.equal(env.GIT_KNOWN_HOSTS_FILE, '');
    assert.equal(existsSync(OK_RUN_DIR), false, 'the absent-key path must not create /tmp/ok-run');
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 3 key without known_hosts: 400 bad_schema, no spawn, ack NOT latched so an immediate valid /run still returns 200', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const bad = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitSshKey: PEM_FIXTURE,
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /bad_schema/);
    assert.match(bad.body, /supplied together/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'a rejected /run must not spawn the entrypoint');
    assert.equal(existsSync(OK_RUN_DIR), false);
    const good = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(good.status, 200, 'runAcked must not latch on a rejected /run so retry succeeds');
    assert.match(good.body, /"branch":"main"/);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 4 non-PEM key: 400 bad_schema not-a-PEM, no spawn, then a valid retry returns 200', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const bad = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitSshKey: 'this-is-not-a-pem-key',
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /bad_schema/);
    assert.match(bad.body, /not a PEM private key/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'a non-PEM key must not spawn the entrypoint');
    assert.equal(existsSync(OK_RUN_DIR), false);
    const good = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(good.status, 200);
    assert.match(good.body, /"branch":"main"/);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 5 SSH-form url with no key: 400 bad_schema SSH-requires-key, no spawn', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const bad = await postTo(inst.port, RUN_PATH, { gitRepoUrl: SSH_REPO_URL, gitBranch: 'main' });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /bad_schema/);
    assert.match(bad.body, /SSH repo URL requires/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'an SSH url without a key must not spawn');
    assert.equal(existsSync(OK_RUN_DIR), false);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 6 NO-LEAK: the PEM fixture and its MARKER never appear in server stderr, and the shape log shows gitSshKey:present len=N not the value', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const r = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(r.status, 200);
    await getWithHost(inst.port, '/', 'abc.example');
    await readKeyEnv(inst);
    await settle(200);
    const log = inst.stderr();
    assert.equal(log.includes(PEM_FIXTURE), false, 'the full PEM fixture must never be written to stderr');
    assert.equal(log.includes(PEM_MARKER), false, 'the secret MARKER must never be written to stderr');
    const expectedKeyLen = PEM_FIXTURE.length;
    const shapeRe = new RegExp(`gitSshKey:present len=${expectedKeyLen}`);
    assert.match(log, shapeRe, 'the shape log must report present len=N, not the key value');
    assert.match(log, /gitKnownHosts:present len=\d+/);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 7 ACK-LATCH: a valid /run returns 200 and an IMMEDIATE second /run returns 409 already_booted with no data-plane boot in between', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const first = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(first.status, 200);
    const second = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(second.status, 409);
    assert.match(second.body, /already_booted/);
    assert.equal(existsSync(inst.sentinel), false, 'the ack latches at ack time, before any data-plane boot');
    await getWithHost(inst.port, '/', 'abc.example');
    await readKeyEnv(inst);
    const third = await postTo(inst.port, RUN_PATH, {
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
    });
    assert.equal(third.status, 409);
    assert.match(third.body, /already_booted/);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 8 FAIL-CLOSED: a data-plane GET / with no prior /run returns 503 starting and never spawns', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const premature = await getFrom(inst.port, '/');
    assert.equal(premature.status, 503);
    assert.match(premature.body, /"code":"starting"/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'no /run means no spawn, ever');
    assert.equal(existsSync(OK_RUN_DIR), false);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

test('ssh-key matrix 9 OVERSIZE: a key payload padded past MAX_BYTES is rejected 413 payload_too_large with no spawn and no run dir', async () => {
  let inst;
  cleanRunDir();
  try {
    inst = await startServerWithKeyDump();
    const padded = JSON.stringify({
      gitRepoUrl: SSH_REPO_URL,
      gitBranch: 'main',
      gitSshKey: PEM_FIXTURE,
      gitKnownHosts: KNOWN_HOSTS_FIXTURE,
      pad: 'z'.repeat(4096),
    });
    assert.equal(Buffer.byteLength(padded, 'utf8') > 4096, true);
    const r = await postTo(inst.port, RUN_PATH, padded);
    assert.equal(r.status, 413);
    assert.match(r.body, /payload_too_large/);
    await settle(300);
    assert.equal(existsSync(inst.sentinel), false, 'an over-cap body must not spawn');
    assert.equal(existsSync(OK_RUN_DIR), false);
  } finally {
    teardown(inst);
    cleanRunDir();
  }
});

async function startServerWithBindDump(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hook-'));
  const sentinel = join(dir, 'booted.marker');
  const envdump = join(dir, 'child.env');
  const stub = join(dir, 'entrypoint-stub.sh');
  writeFileSync(
    stub,
    `#!/bin/sh\ntouch "${sentinel}"\nprintf 'GIT_REPO_URL=%s\\nGIT_BRANCH=%s\\nOK_EXTERNAL_URL=%s\\nOK_BIND=%s\\nEND=1\\n' "$GIT_REPO_URL" "$GIT_BRANCH" "$OK_EXTERNAL_URL" "$OK_BIND" > "${envdump}"\nsleep 10\n`,
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

async function readBindEnv(inst, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(inst.envdump)) {
      const text = readFileSync(inst.envdump, 'utf8');
      if (/END=1/.test(text)) {
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

function rawGetNoHost(port, path) {
  return new Promise((resolve, nope) => {
    const sock = connect(port, HOST, () => {
      sock.write(`GET ${path} HTTP/1.0\r\n\r\n`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
    });
    sock.on('error', nope);
    sock.on('close', () => resolve(buf));
    setTimeout(() => sock.destroy(), 1500).unref();
  });
}

test('OK_BIND a: a data-plane Host with no port yields OK_BIND "127.0.0.1 <host>" while OK_EXTERNAL_URL stays the resolved externalUrl (independent)', async () => {
  let inst;
  try {
    inst = await startServerWithBindDump();
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'abc123.lambda-microvm.us-east-1.on.aws');
    const env = await readBindEnv(inst);
    assert.equal(env.OK_BIND, '127.0.0.1 abc123.lambda-microvm.us-east-1.on.aws');
    assert.equal(env.OK_EXTERNAL_URL, VALID_PAYLOAD.externalUrl);
    assert.notEqual(env.OK_BIND, env.OK_EXTERNAL_URL);
  } finally {
    teardown(inst);
  }
});

test('OK_BIND b: a data-plane Host that carries a port has the port stripped in OK_BIND', async () => {
  let inst;
  try {
    inst = await startServerWithBindDump();
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await getWithHost(inst.port, '/', 'host.example:9000');
    const env = await readBindEnv(inst);
    assert.equal(env.OK_BIND, '127.0.0.1 host.example');
    assert.equal(env.OK_EXTERNAL_URL, VALID_PAYLOAD.externalUrl);
  } finally {
    teardown(inst);
  }
});

test('OK_BIND c: a booting data-plane request with NO Host header yields the loopback-only default "127.0.0.1" with no fabricated host', async () => {
  let inst;
  try {
    inst = await startServerWithBindDump();
    const run = await postTo(inst.port, RUN_PATH, VALID_PAYLOAD);
    assert.equal(run.status, 200);
    await rawGetNoHost(inst.port, '/');
    const env = await readBindEnv(inst);
    assert.equal(env.OK_BIND, '127.0.0.1');
    assert.equal(env.OK_EXTERNAL_URL, VALID_PAYLOAD.externalUrl);
  } finally {
    teardown(inst);
  }
});
