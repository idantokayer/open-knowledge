import http from 'node:http';
import { request as hreq } from 'node:https';
import { execFileSync } from 'node:child_process';

const MV = 'microvm-52d670cd-c3c6-3d5c-aed5-8453318e520e';
const EP = '78d0a6eb-5bba-a0b9-139d-c11bfae26718.lambda-microvm.us-east-1.on.aws';

function token() {
  return execFileSync('aws', ['lambda-microvms','create-microvm-auth-token',
    '--microvm-identifier', MV, '--expiration-in-minutes','60',
    '--allowed-ports','[{"port":9000}]','--region','us-east-1',
    '--query','authToken."X-aws-proxy-auth"','--output','text'],
    { env: { ...process.env, AWS_PROFILE:'buffet-non-prod', AWS_REGION:'us-east-1' } }
  ).toString().trim();
}
let TOKEN = token();
setInterval(() => { TOKEN = token(); }, 30 * 60 * 1000).unref();

http.createServer((creq, cres) => {
  const headers = { ...creq.headers, host: EP,
    'x-aws-proxy-auth': TOKEN, 'x-aws-proxy-port': '9000' };
  const up = hreq({ host: EP, port: 443, method: creq.method, path: creq.url, headers },
    ures => { cres.writeHead(ures.statusCode, ures.headers); ures.pipe(cres); });
  up.on('error', e => { cres.writeHead(502, {'content-type':'text/plain'}); cres.end(String(e)); });
  creq.pipe(up);
}).listen(8080, () => console.log('Proxy up — open http://localhost:8080'));
