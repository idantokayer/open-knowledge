import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';

const HOOK_PORT = Number.parseInt(process.env.OK_RUN_HOOK_PORT ?? '9000', 10);
const HOOK_HOST = process.env.OK_RUN_HOOK_HOST ?? '0.0.0.0';
const RUN_PATH_PRIMARY = '/run';
const HOOK_PATH = process.env.OK_RUN_HOOK_PATH ?? '/aws/lambda-microvms/runtime/v1/run';
const READY_PATH_PRIMARY = process.env.OK_RUN_HOOK_READY_PATH ?? '/aws/lambda-microvms/runtime/v1/ready';
const READY_PATH_SHORT = '/ready';
const HOOK_METHOD = (process.env.OK_RUN_HOOK_METHOD ?? 'POST').toUpperCase();
const HEALTH_METHOD = (process.env.OK_RUN_HOOK_HEALTH_METHOD ?? 'GET').toUpperCase();
const HEALTH_PATH = process.env.OK_RUN_HOOK_HEALTH_PATH ?? '/healthz';
const MAX_BYTES = Number.parseInt(process.env.OK_RUN_HOOK_MAX_BYTES ?? '4096', 10);
const ENTRYPOINT = process.env.OK_ENTRYPOINT ?? '/usr/local/bin/entrypoint.sh';

const APP_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const APP_HOST = '127.0.0.1';
const READYZ_PATH = process.env.OK_APP_READYZ_PATH ?? '/readyz';
const READYZ_INTERVAL_MS = 300;
const READYZ_MAX_TRIES = Number.parseInt(process.env.OK_APP_READYZ_MAX_TRIES ?? '600', 10);

if (!Number.isInteger(HOOK_PORT) || HOOK_PORT < 1 || HOOK_PORT > 65535) {
  console.error(`run-hook: invalid OK_RUN_HOOK_PORT: ${process.env.OK_RUN_HOOK_PORT}`);
  process.exit(2);
}
if (!Number.isInteger(MAX_BYTES) || MAX_BYTES < 1) {
  console.error(`run-hook: invalid OK_RUN_HOOK_MAX_BYTES: ${process.env.OK_RUN_HOOK_MAX_BYTES}`);
  process.exit(2);
}
if (!Number.isInteger(APP_PORT) || APP_PORT < 1 || APP_PORT > 65535) {
  console.error(`run-hook: invalid PORT: ${process.env.PORT}`);
  process.exit(2);
}
if (!Number.isInteger(READYZ_MAX_TRIES) || READYZ_MAX_TRIES < 1) {
  console.error(`run-hook: invalid OK_APP_READYZ_MAX_TRIES: ${process.env.OK_APP_READYZ_MAX_TRIES}`);
  process.exit(2);
}

let booted = false;
let appReady = false;
let pollExhausted = false;
let pendingSpace = null;
let runAcked = false;

function reject(res, status, code, message) {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify({ ok: false, code, message }));
  console.error(`run-hook: rejected ${status} ${code}: ${message}`);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

const DEFAULT_GIT_REPO_URL = process.env.OK_DEFAULT_GIT_REPO_URL ?? 'https://github.com/inkeep/open-knowledge';
const DEFAULT_GIT_BRANCH = process.env.OK_DEFAULT_GIT_BRANCH ?? 'main';
const DEFAULT_EXTERNAL_URL = process.env.OK_DEFAULT_EXTERNAL_URL ?? 'https://placeholder.local';

function resolveSpace(raw) {
  let parsed = null;
  if (isNonEmptyString(raw)) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stderr.write('run-hook: run-body non-JSON, using defaults\n');
      parsed = null;
    }
  } else {
    process.stderr.write('run-hook: run-body empty, using defaults\n');
  }
  let overrides = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  if (isNonEmptyString(overrides.runHookPayload)) {
    try {
      const inner = JSON.parse(overrides.runHookPayload);
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        overrides = inner;
      } else {
        process.stderr.write('run-hook: runHookPayload not a JSON object, using outer body\n');
      }
    } catch {
      process.stderr.write('run-hook: runHookPayload non-JSON, using outer body\n');
    }
  }
  const gitRepoUrl = isNonEmptyString(overrides.gitRepoUrl) ? overrides.gitRepoUrl : DEFAULT_GIT_REPO_URL;
  const gitBranch = isNonEmptyString(overrides.gitBranch) ? overrides.gitBranch : DEFAULT_GIT_BRANCH;
  const externalUrl = isNonEmptyString(overrides.externalUrl) ? overrides.externalUrl : DEFAULT_EXTERNAL_URL;
  const gitSshKey = isNonEmptyString(overrides.gitSshKey) ? overrides.gitSshKey : undefined;
  const gitKnownHosts = isNonEmptyString(overrides.gitKnownHosts) ? overrides.gitKnownHosts : undefined;
  return { gitRepoUrl, gitBranch, externalUrl, gitSshKey, gitKnownHosts };
}

function validateSpace(space) {
  const hasKey = isNonEmptyString(space.gitSshKey);
  const hasHosts = isNonEmptyString(space.gitKnownHosts);
  if (hasKey !== hasHosts) {
    return 'gitSshKey and gitKnownHosts must be supplied together';
  }
  if (hasKey && !(space.gitSshKey.startsWith('-----BEGIN ') && space.gitSshKey.includes('PRIVATE KEY-----'))) {
    return 'gitSshKey is not a PEM private key';
  }
  if (/^(git@|ssh:\/\/)/.test(space.gitRepoUrl) && !hasKey) {
    return 'SSH repo URL requires gitSshKey and gitKnownHosts';
  }
  return null;
}

function pollAppReady(tries) {
  if (appReady) return;
  const probe = httpRequest(
    { host: APP_HOST, port: APP_PORT, path: READYZ_PATH, method: 'GET', timeout: READYZ_INTERVAL_MS },
    (res) => {
      res.resume();
      if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
        appReady = true;
        process.stderr.write(`run-hook: app ready on ${APP_HOST}:${APP_PORT} after probe ${READYZ_MAX_TRIES - tries + 1}\n`);
        return;
      }
      scheduleReadyPoll(tries - 1);
    },
  );
  probe.on('timeout', () => probe.destroy());
  probe.on('error', () => scheduleReadyPoll(tries - 1));
  probe.end();
}

function scheduleReadyPoll(tries) {
  if (appReady || tries <= 0) {
    if (!appReady) {
      pollExhausted = true;
      process.stderr.write(`run-hook: app did not report ready after ${READYZ_MAX_TRIES} probes to ${READYZ_PATH}\n`);
    }
    return;
  }
  setTimeout(() => pollAppReady(tries), READYZ_INTERVAL_MS).unref();
}

function recordSpace(space) {
  pendingSpace = space;
}

function spawnApp(space, externalUrl) {
  const extraEnv = {};
  try {
    if (isNonEmptyString(space.gitSshKey)) {
      mkdirSync('/tmp/ok-run', { recursive: true, mode: 0o700 });
      writeFileSync('/tmp/ok-run/id_deploy', space.gitSshKey, { mode: 0o600 });
      writeFileSync('/tmp/ok-run/known_hosts', space.gitKnownHosts, { mode: 0o600 });
      chmodSync('/tmp/ok-run', 0o700);
      chmodSync('/tmp/ok-run/id_deploy', 0o600);
      chmodSync('/tmp/ok-run/known_hosts', 0o600);
      extraEnv.GIT_SSH_KEY_FILE = '/tmp/ok-run/id_deploy';
      extraEnv.GIT_KNOWN_HOSTS_FILE = '/tmp/ok-run/known_hosts';
    }
    const child = spawn(ENTRYPOINT, [], {
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_REPO_URL: space.gitRepoUrl,
        GIT_BRANCH: space.gitBranch,
        OK_EXTERNAL_URL: externalUrl,
        ...extraEnv,
      },
    });
    child.on('error', (err) => {
      process.stderr.write(`run-hook: failed to exec entrypoint: ${err.message}\n`);
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      process.stderr.write(`run-hook: ok process exited code=${code} signal=${signal}\n`);
      process.exitCode = code == null ? 1 : code;
    });
  } catch (err) {
    process.stderr.write(`run-hook: failed to prepare or exec entrypoint: ${err.message}\n`);
    process.exitCode = 1;
  }
  scheduleReadyPoll(READYZ_MAX_TRIES);
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

function stripHopByHop(headers) {
  const copy = { ...headers };
  const connection = copy.connection ?? copy.Connection;
  if (isNonEmptyString(connection)) {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase();
      if (name.length > 0) delete copy[name];
    }
  }
  for (const key of Object.keys(copy)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) delete copy[key];
  }
  return copy;
}

function forwardHeaders(req, stripHop = true) {
  const headers = stripHop ? stripHopByHop(req.headers) : { ...req.headers };
  const proto = req.socket?.encrypted ? 'https' : 'http';
  const existingFor = headers['x-forwarded-for'];
  const clientIp = req.socket?.remoteAddress ?? '';
  headers['x-forwarded-for'] = isNonEmptyString(existingFor) ? `${existingFor}, ${clientIp}` : clientIp;
  if (!isNonEmptyString(headers['x-forwarded-proto'])) {
    headers['x-forwarded-proto'] = proto;
  }
  if (!isNonEmptyString(headers['x-forwarded-host']) && isNonEmptyString(req.headers.host)) {
    headers['x-forwarded-host'] = req.headers.host;
  }
  return headers;
}

function proxyRequest(req, res) {
  if (!booted) {
    if (pendingSpace === null) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ ok: false, code: 'starting' }));
      return;
    }
    const host = req.headers.host;
    let ext;
    if (isNonEmptyString(host)) {
      try {
        ext = new URL(`https://${host}`).origin;
      } catch {
        ext = isNonEmptyString(pendingSpace.externalUrl) ? pendingSpace.externalUrl : DEFAULT_EXTERNAL_URL;
      }
    } else {
      ext = isNonEmptyString(pendingSpace.externalUrl) ? pendingSpace.externalUrl : DEFAULT_EXTERNAL_URL;
    }
    booted = true;
    process.stderr.write(`run-hook: lazy-boot method=${req.method} path=${req.url} host=${host ?? ''} ext=${ext}\n`);
    spawnApp(pendingSpace, ext);
  }
  if (!appReady) {
    if (pollExhausted) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'unavailable' }));
    } else {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ ok: false, code: 'starting' }));
    }
    return;
  }
  const upstream = httpRequest(
    { host: APP_HOST, port: APP_PORT, method: req.method, path: req.url, headers: forwardHeaders(req) },
    (upstreamRes) => {
      upstreamRes.on('error', () => res.destroy());
      res.writeHead(upstreamRes.statusCode ?? 502, stripHopByHop(upstreamRes.headers));
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    process.stderr.write(`run-hook: proxy upstream error ${req.method} ${req.url}: ${err.message}\n`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('bad gateway');
  });
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  process.stderr.write(`run-hook: inbound ${req.method} ${req.url} from ${req.socket?.remoteAddress ?? '?'}\n`);
  const path = req.url?.split('?')[0] ?? '';

  if (req.method === HOOK_METHOD && (path === RUN_PATH_PRIMARY || path === HOOK_PATH)) {
    if (runAcked) {
      return reject(res, 409, 'already_booted', 'this MicroVM has already selected a space');
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BYTES) {
        aborted = true;
        reject(res, 413, 'payload_too_large', `body exceeds ${MAX_BYTES} bytes`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      if (runAcked) {
        return reject(res, 409, 'already_booted', 'this MicroVM has already selected a space');
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const space = resolveSpace(raw);
      const keyShape = isNonEmptyString(space.gitSshKey) ? `present len=${space.gitSshKey.length}` : 'absent';
      const hostsShape = isNonEmptyString(space.gitKnownHosts) ? `present len=${space.gitKnownHosts.length}` : 'absent';
      const extShape = isNonEmptyString(space.externalUrl) && space.externalUrl !== DEFAULT_EXTERNAL_URL ? 'present' : 'default';
      process.stderr.write(`run-hook: run-body ${Buffer.byteLength(raw, 'utf8')} bytes content-type=${req.headers['content-type'] ?? 'none'} shape={gitRepoUrl:${space.gitRepoUrl}, gitBranch:${space.gitBranch}, externalUrl:${extShape}, gitSshKey:${keyShape}, gitKnownHosts:${hostsShape}}\n`);
      const schemaError = validateSpace(space);
      if (schemaError !== null) {
        reject(res, 400, 'bad_schema', schemaError);
        return;
      }
      recordSpace(space);
      runAcked = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, branch: space.gitBranch }));
    });
    req.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      reject(res, 400, 'request_error', err.message);
    });
    return;
  }

  if (req.method === 'POST' && (path === READY_PATH_PRIMARY || path === READY_PATH_SHORT)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === HEALTH_METHOD && path === HEALTH_PATH) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  proxyRequest(req, res);
});

server.on('upgrade', (req, socket, head) => {
  process.stderr.write(`run-hook: upgrade ${req.method} ${req.url} from ${req.socket?.remoteAddress ?? '?'}\n`);
  if (!appReady) {
    socket.destroy();
    return;
  }
  const upstream = httpRequest({
    host: APP_HOST,
    port: APP_PORT,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req, false),
  });
  let handshakeDone = false;
  socket.on('error', () => {
    if (!handshakeDone) upstream.destroy();
  });
  socket.on('close', () => {
    if (!handshakeDone) upstream.destroy();
  });
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    handshakeDone = true;
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`${key}: ${v}`);
      } else if (value !== undefined) {
        lines.push(`${key}: ${value}`);
      }
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
  });
  upstream.on('error', (err) => {
    process.stderr.write(`run-hook: upgrade upstream error ${req.url}: ${err.message}\n`);
    socket.destroy();
  });
  if (head && head.length > 0) upstream.write(head);
  upstream.end();
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('run-hook: port busy, exiting duplicate');
    process.exit(0);
  } else {
    throw e;
  }
});

server.listen(HOOK_PORT, HOOK_HOST, () => {
  console.error(`run-hook: listening ${HOOK_HOST}:${HOOK_PORT} ${HOOK_METHOD} ${RUN_PATH_PRIMARY} (fallback ${HOOK_PATH}) max=${MAX_BYTES}B ready=${READY_PATH_PRIMARY} health=${HEALTH_METHOD} ${HEALTH_PATH} proxy->${APP_HOST}:${APP_PORT} defaults=on`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
