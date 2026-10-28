import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createReactShellMiddleware } from './react-shell-middleware.ts';

const servers: Array<ReturnType<typeof createServer>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('createReactShellMiddleware', () => {
  test('injects the prefix for root and deep-route shells while serving real assets', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'ok-shell-'));
    directories.push(distDir);
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'index.html'), '<html><head></head><body></body></html>');
    writeFileSync(join(distDir, 'assets', 'app.js'), 'asset');
    const middleware = createReactShellMiddleware(distDir, '/plm');
    const server = createServer((req, res) =>
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Server did not bind');
    const root = await fetch(`http://127.0.0.1:${address.port}/`);
    const deepRoute = await fetch(`http://127.0.0.1:${address.port}/pages/nested`);
    const asset = await fetch(`http://127.0.0.1:${address.port}/assets/app.js`);
    expect(await root.text()).toContain('<base href="/plm/" />');
    expect(await deepRoute.text()).toContain('<base href="/plm/" />');
    expect(await asset.text()).toBe('asset');
  });
});
