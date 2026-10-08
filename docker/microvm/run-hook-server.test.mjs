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
