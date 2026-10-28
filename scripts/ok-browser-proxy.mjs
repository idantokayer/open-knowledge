import http from 'node:http';
import { request as hreq } from 'node:https';
import { execFileSync } from 'node:child_process';

const AWS_ENV = {
  ...process.env,
  AWS_PROFILE: process.env.AWS_PROFILE || 'buffet-non-prod',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
};
const REGION = AWS_ENV.AWS_REGION;
const PORT = Number(process.env.PORT || 8080);

function aws(args) {
  return execFileSync('aws', [...args, '--region', REGION, '--output', 'text'], { env: AWS_ENV })
    .toString()
    .trim();
}

function resolveTarget() {
  let mv = process.env.MV;
  if (!mv) {
    mv = aws(['lambda-microvms', 'list-microvms', '--query', 'items[?state==`RUNNING`].microvmId | [0]']);
  }
  if (!mv || mv === 'None') {
    throw new Error('No RUNNING MicroVM found. Launch one, or set MV=<id>.');
  }
  const ep =
    process.env.EP ||
    aws(['lambda-microvms', 'get-microvm', '--microvm-identifier', mv, '--query', 'endpoint']);
  if (!ep || ep === 'None') throw new Error(`No endpoint for ${mv} (is it RUNNING?)`);
  return { mv, ep };
}

function mintToken(mv) {
  return aws([
    'lambda-microvms',
    'create-microvm-auth-token',
    '--microvm-identifier',
    mv,
    '--expiration-in-minutes',
    '60',
    '--allowed-ports',
    '[{"port":9000}]',
    '--query',
    'authToken."X-aws-proxy-auth"',
  ]);
}

const { mv, ep } = resolveTarget();
let token = mintToken(mv);
setInterval(() => {
  try {
    token = mintToken(mv);
  } catch (e) {
    console.error('token refresh failed:', String(e));
  }
}, 30 * 60 * 1000).unref();

function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function forwardOnce(method, path, reqHeaders, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      ...reqHeaders,
      host: ep,
      'x-aws-proxy-auth': token,
      'x-aws-proxy-port': '9000',
    };
    delete headers['accept-encoding'];
    if (body.length > 0) headers['content-length'] = String(body.length);
    const up = hreq({ host: ep, port: 443, method, path, headers }, (ures) => {
      const data = [];
      ures.on('data', (c) => data.push(c));
      ures.on('end', () => resolve({ status: ures.statusCode || 502, headers: ures.headers, body: Buffer.concat(data) }));
    });
    up.on('error', reject);
    if (body.length > 0) up.write(body);
    up.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (creq, cres) => {
    try {
      const body = await collect(creq);
      let resp;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        resp = await forwardOnce(creq.method, creq.url, creq.headers, body);
        if (resp.status !== 429) break;
        await sleep(200 * attempt);
      }
      const out = { ...resp.headers };
      delete out['transfer-encoding'];
      delete out.connection;
      cres.writeHead(resp.status, out);
      cres.end(resp.body);
    } catch (e) {
      cres.writeHead(502, { 'content-type': 'text/plain' });
      cres.end(String(e));
    }
  })
  .listen(PORT, () => {
    console.error(`MicroVM = ${mv}`);
    console.error(`endpoint = ${ep}`);
    console.error(`Proxy up -- open http://localhost:${PORT}`);
  });
