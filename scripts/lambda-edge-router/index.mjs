import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:603106382807:secret:ok-routing-spaces-wY1WYu';
const SECRET_REGION = 'us-east-1';
const SECRET_CACHE_TTL_MS = 30_000;
const MICROVM_DOMAIN_SUFFIX = '.lambda-microvm.us-east-1.on.aws';

let cachedRoutes;
let cachedUntil = 0;
let secretsManager;

function routeKeyFromUri(uri) {
  const match = /^\/([A-Za-z0-9._~-]+)(?:\/|$)/.exec(uri);
  return match?.[1] ?? null;
}

function validRoute(route) {
  return (
    route !== null &&
    typeof route === 'object' &&
    typeof route.domainName === 'string' &&
    route.domainName.endsWith(MICROVM_DOMAIN_SUFFIX) &&
    typeof route.authToken === 'string' &&
    route.authToken.length > 0 &&
    !/[\r\n]/.test(route.authToken)
  );
}

async function loadRoutes() {
  if (cachedRoutes && Date.now() < cachedUntil) return cachedRoutes;

  secretsManager ??= new SecretsManagerClient({ region: SECRET_REGION });
  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: SECRET_ARN, VersionStage: 'AWSCURRENT' }),
  );
  if (typeof result.SecretString !== 'string') {
    throw new Error('The route secret must contain a JSON SecretString');
  }

  const routes = JSON.parse(result.SecretString);
  if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) {
    throw new Error('The route secret must be a JSON object keyed by path prefix');
  }

  cachedRoutes = routes;
  cachedUntil = Date.now() + SECRET_CACHE_TTL_MS;
  return routes;
}

function errorResponse(status, message) {
  return {
    status: String(status),
    statusDescription: status === 404 ? 'Not Found' : 'Service Unavailable',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
    body: message,
  };
}

function attachRoute(request, route) {
  delete request.headers['x-aws-proxy-auth'];
  delete request.headers['x-aws-proxy-port'];

  request.origin = {
    custom: {
      domainName: route.domainName,
      port: 443,
      protocol: 'https',
      path: '',
      sslProtocols: ['TLSv1.2'],
      readTimeout: 120,
      keepaliveTimeout: 5,
      customHeaders: {
        'x-aws-proxy-auth': [{ key: 'X-aws-proxy-auth', value: route.authToken }],
        'x-aws-proxy-port': [{ key: 'X-aws-proxy-port', value: '9000' }],
      },
    },
  };
  request.headers.host = [{ key: 'Host', value: route.domainName }];

  return request;
}

export function createHandler(getRoutes) {
  return async (event) => {
    const request = event.Records?.[0]?.cf?.request;
    if (!request || typeof request.uri !== 'string') {
      return errorResponse(503, 'Invalid CloudFront origin-request event');
    }

    const key = routeKeyFromUri(request.uri);
    if (!key) return errorResponse(404, 'Unknown space');

    let routes;
    try {
      routes = await getRoutes();
    } catch (error) {
      console.error('Unable to load space routes from Secrets Manager', error);
      return errorResponse(503, 'Space routing is temporarily unavailable');
    }

    const route = routes[key];
    if (!validRoute(route)) return errorResponse(404, 'Unknown space');

    return attachRoute(request, route);
  };
}

export const handler = createHandler(loadRoutes);

export { routeKeyFromUri, validRoute };
