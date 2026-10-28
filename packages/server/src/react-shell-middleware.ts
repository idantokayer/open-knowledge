import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import sirv from 'sirv';

export function createReactShellMiddleware(
  distDir: string,
  basePath: string,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const staticOptions = {
    gzip: true,
    etag: true,
    dev: true,
  };
  if (basePath === '') return sirv(distDir, { ...staticOptions, single: true });
  const staticMiddleware = sirv(distDir, staticOptions);
  const shellPath = resolve(distDir, 'index.html');
  const indexHtml = readFileSync(shellPath, 'utf8');
  const shellHtml = indexHtml.replace(/<head>/i, `<head>\n  <base href="${basePath}/" />`);
  if (shellHtml === indexHtml)
    throw new Error('React shell index.html is missing a <head> element');
  return (req, res, next) => {
    const pathname = req.url?.split('?')[0] ?? '/';
    const sendShell = (): void => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      res.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(shellHtml),
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(req.method === 'HEAD' ? undefined : shellHtml);
    };
    if (pathname === '/' || pathname === '/index.html') {
      sendShell();
      return;
    }
    if (extname(pathname) !== '') {
      staticMiddleware(req, res, sendShell);
      return;
    }
    sendShell();
  };
}
