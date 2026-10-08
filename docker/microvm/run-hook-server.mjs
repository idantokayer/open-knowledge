import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const HOOK_PORT = Number.parseInt(process.env.OK_RUN_HOOK_PORT ?? '9000', 10);
const HOOK_HOST = process.env.OK_RUN_HOOK_HOST ?? '0.0.0.0';
const RUN_PATH_PRIMARY = '/run';
const HOOK_PATH = process.env.OK_RUN_HOOK_PATH ?? '/aws/lambda-microvms/runtime/v1/run';
const HOOK_METHOD = (process.env.OK_RUN_HOOK_METHOD ?? 'POST').toUpperCase();
const HEALTH_METHOD = (process.env.OK_RUN_HOOK_HEALTH_METHOD ?? 'GET').toUpperCase();
const MAX_BYTES = Number.parseInt(process.env.OK_RUN_HOOK_MAX_BYTES ?? '4096', 10);
const ENTRYPOINT = process.env.OK_ENTRYPOINT ?? '/usr/local/bin/entrypoint.sh';

if (!Number.isInteger(HOOK_PORT) || HOOK_PORT < 1 || HOOK_PORT > 65535) {
  console.error(`run-hook: invalid OK_RUN_HOOK_PORT: ${process.env.OK_RUN_HOOK_PORT}`);
  process.exit(2);
}
if (!Number.isInteger(MAX_BYTES) || MAX_BYTES < 1) {
  console.error(`run-hook: invalid OK_RUN_HOOK_MAX_BYTES: ${process.env.OK_RUN_HOOK_MAX_BYTES}`);
  process.exit(2);
}

let booted = false;

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

function validatePayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: ['malformed_json', 'request body is not valid JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: ['bad_schema', 'payload must be a JSON object'] };
  }
  const { gitRepoUrl, gitBranch, externalUrl } = parsed;
  if (!isNonEmptyString(gitRepoUrl)) {
    return { error: ['bad_schema', 'gitRepoUrl must be a non-empty string'] };
  }
  if (!isNonEmptyString(gitBranch)) {
    return { error: ['bad_schema', 'gitBranch must be a non-empty string'] };
  }
  if (!isNonEmptyString(externalUrl)) {
    return { error: ['bad_schema', 'externalUrl must be a non-empty string'] };
  }
  return { value: { gitRepoUrl, gitBranch, externalUrl } };
}

function boot(space, res) {
  booted = true;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, branch: space.gitBranch }));
  try {
    const child = spawn(ENTRYPOINT, [], {
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_REPO_URL: space.gitRepoUrl,
        GIT_BRANCH: space.gitBranch,
        OK_EXTERNAL_URL: space.externalUrl,
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
    process.stderr.write(`run-hook: failed to exec entrypoint: ${err.message}\n`);
    process.exitCode = 1;
  }
}

const server = createServer((req, res) => {
  process.stderr.write(`run-hook: inbound ${req.method} ${req.url} from ${req.socket?.remoteAddress ?? '?'}\n`);
  const path = req.url?.split('?')[0] ?? '';
  const isRunHook = req.method === HOOK_METHOD && (path === RUN_PATH_PRIMARY || path === HOOK_PATH);
  if (!isRunHook) {
    if (req.method === HEALTH_METHOD) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    console.error(`run-hook: unmatched ${req.method} ${req.url}`);
    return reject(res, 404, 'not_found', `expected ${HOOK_METHOD} ${RUN_PATH_PRIMARY}`);
  }
  if (booted) {
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
    if (booted) {
      return reject(res, 409, 'already_booted', 'this MicroVM has already selected a space');
    }
    const result = validatePayload(Buffer.concat(chunks).toString('utf8'));
    if (result.error) {
      return reject(res, 400, result.error[0], result.error[1]);
    }
    boot(result.value, res);
  });

  req.on('error', (err) => {
    if (aborted) return;
    aborted = true;
    reject(res, 400, 'request_error', err.message);
  });
});

server.listen(HOOK_PORT, HOOK_HOST, () => {
  console.error(`run-hook: listening ${HOOK_HOST}:${HOOK_PORT} ${HOOK_METHOD} ${RUN_PATH_PRIMARY} (fallback ${HOOK_PATH}) max=${MAX_BYTES}B`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
