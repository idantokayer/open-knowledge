import { describe, expect, test, vi } from 'vitest';
import { createHandler, routeKeyFromUri, validRoute } from './index.mjs';

const route = {
  domainName: 'abc123.lambda-microvm.us-east-1.on.aws',
  authToken: 'private-token',
};

function event(uri, headers = {}) {
  return {
    Records: [
      {
        cf: {
          request: {
            uri,
            headers: {
              host: [{ key: 'Host', value: 'ok.example.com' }],
              ...headers,
            },
          },
        },
      },
    ],
  };
}

describe('routeKeyFromUri', () => {
  test('extracts the first path segment', () => {
    expect(routeKeyFromUri('/plm/')).toBe('plm');
    expect(routeKeyFromUri('/plm/mcp')).toBe('plm');
    expect(routeKeyFromUri('/space2')).toBe('space2');
  });

  test('rejects root and non-canonical first path segments', () => {
    expect(routeKeyFromUri('/')).toBeNull();
    expect(routeKeyFromUri('//plm')).toBeNull();
    expect(routeKeyFromUri('/plm%2Fother')).toBeNull();
  });
});

describe('validRoute', () => {
  test('accepts endpoint/token route records', () => {
    expect(validRoute(route)).toBe(true);
  });

  test('rejects non-MicroVM hosts and unsafe token values', () => {
    expect(validRoute({ ...route, domainName: 'example.com' })).toBe(false);
    expect(validRoute({ ...route, authToken: 'bad\nheader' })).toBe(false);
    expect(validRoute({ ...route, authToken: '' })).toBe(false);
  });
});

describe('Lambda@Edge origin router', () => {
  test('selects the route, replaces origin, and injects the matching proxy credentials', async () => {
    const getRoutes = vi.fn().mockResolvedValue({ plm: route });
    const handler = createHandler(getRoutes);
    const request = event('/plm/api/config', {
      'x-aws-proxy-auth': [{ key: 'X-aws-proxy-auth', value: 'viewer-spoof' }],
      'x-aws-proxy-port': [{ key: 'X-aws-proxy-port', value: 'viewer-spoof' }],
    }).Records[0].cf.request;

    const result = await handler({ Records: [{ cf: { request } }] });

    expect(result).toBe(request);
    expect(request.uri).toBe('/plm/api/config');
    expect(request.origin.custom.domainName).toBe(route.domainName);
    expect(request.origin.custom.customHeaders).toEqual({
      'x-aws-proxy-auth': [{ key: 'X-aws-proxy-auth', value: route.authToken }],
      'x-aws-proxy-port': [{ key: 'X-aws-proxy-port', value: '9000' }],
    });
    expect(request.headers['x-aws-proxy-auth']).toBeUndefined();
    expect(request.headers['x-aws-proxy-port']).toBeUndefined();
    expect(request.headers.host[0].value).toBe(route.domainName);
    expect(getRoutes).toHaveBeenCalledOnce();
  });

  test('returns 404 for an unconfigured route without reading Secrets Manager', async () => {
    const getRoutes = vi.fn();
    const result = await createHandler(getRoutes)(event('/unknown/'));

    expect(result.status).toBe('404');
    expect(getRoutes).not.toHaveBeenCalled();
  });

  test('returns 503 when Secrets Manager is unavailable', async () => {
    const handler = createHandler(async () => {
      throw new Error('unavailable');
    });

    const result = await handler(event('/plm/'));

    expect(result.status).toBe('503');
    expect(result.headers['cache-control'][0].value).toBe('no-store');
  });
});
