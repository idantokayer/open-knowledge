import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hocuspocus } from '@hocuspocus/server';
import type { WebSocketServer } from 'ws';
import type { AcpThreadManager } from './acp/thread-manager.ts';
import type { AgentFocusBroadcaster } from './agent-focus.ts';
import type { AgentPresenceBroadcaster } from './agent-presence.ts';
import type { AgentSessionManager } from './agent-sessions.ts';
import { normalizeServerBasePath } from './base-path.ts';
import { createCollaborationHost } from './collaboration-host.ts';
import { createContentDispatch } from './http/content-dispatch.ts';
import { errorResponse } from './http/error-response.ts';
import {
  admitRequestSurface,
  createHttpApp,
  type HealthProvider,
  type NativeApiHandle,
} from './http/http-app.ts';
import { createMcpDispatch } from './http/mcp-route.ts';
import {
  buildIngressPolicy,
  type IngressPolicy,
  tripsForwardedHeaderTripwire,
  warnForwardedHeaderRefusalOnce,
} from './ingress-policy.ts';
import type { PinoLogger } from './logger.ts';
import type { MaintenanceCoordinator } from './maintenance-coordinator.ts';
import type { McpHttpHandler } from './mcp-http.ts';

export type { ReadinessState } from './http/http-app.ts';

export interface MountMcpAndApiOptions {
  httpServer: HttpServer;
  hocuspocus: Hocuspocus;
  mcpHttpHandler?: McpHttpHandler;
  log: PinoLogger;
  sessionManager?: AgentSessionManager;
  agentFocusBroadcaster?: AgentFocusBroadcaster | null;
  agentPresenceBroadcaster?: AgentPresenceBroadcaster | null;
  maintenanceCoordinator?: MaintenanceCoordinator;
  keepaliveGraceMs?: number;
  contentAssetMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  reactShellMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  acpThreadManager?: AcpThreadManager | null;
  ephemeral?: boolean;
  health?: HealthProvider;
  nativeApi: NativeApiHandle | undefined;
  ingressPolicy?: IngressPolicy;
  basePath?: string;
}

export interface MountMcpAndApiHandle {
  wss: WebSocketServer;
  shutdown: () => Promise<void>;
}

export function mountMcpAndApi(opts: MountMcpAndApiOptions): MountMcpAndApiHandle {
  const {
    httpServer,
    hocuspocus,
    mcpHttpHandler,
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    contentAssetMiddleware,
    reactShellMiddleware,
    ephemeral,
  } = opts;
  const ingressPolicy = opts.ingressPolicy ?? buildIngressPolicy({});
  const basePath = normalizeServerBasePath(opts.basePath);

  const collaborationHost = createCollaborationHost({
    hocuspocus,
    log,
    sessionManager,
    agentFocusBroadcaster,
    agentPresenceBroadcaster,
    maintenanceCoordinator,
    keepaliveGraceMs: opts.keepaliveGraceMs,
    acpThreadManager: opts.acpThreadManager,
    ingressPolicy,
  });

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url?.split('?')[0];
    if (!admitRequestSurface(req, res, ingressPolicy, 'mcp-mount', log)) return;
    hocuspocus
      // biome-ignore lint/suspicious/noExplicitAny: Hocuspocus `hooks()` has no exported payload type for onRequest
      .hooks('onRequest', { request: req, response: res } as any)
      .then(() => {
        if (res.writableEnded || res.headersSent) return;
        errorResponse(res, 404, 'urn:ok:error:not-found', 'API endpoint not found.', {
          handler: 'mcp-mount',
          detail: `No handler for ${req.method ?? 'GET'} ${url}`,
        });
      })
      .catch((err) => {
        log.error({ err }, 'Unhandled onRequest error');
        if (!res.writableEnded && !res.headersSent) {
          errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
            handler: 'mcp-mount',
            cause: err,
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
  };

  const { requestListener } = createHttpApp({
    health: opts.health,
    nativeApi: opts.nativeApi,
    mcpDispatch:
      mcpHttpHandler !== undefined
        ? createMcpDispatch(mcpHttpHandler, ingressPolicy, log)
        : undefined,
    ingressPolicy,
    legacyDispatch: onRequest,
    contentDispatch: createContentDispatch({
      contentAssetMiddleware,
      reactShellMiddleware,
      ephemeral,
      ingressPolicy,
      log,
    }),
    log,
  });
  const onHttpRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (basePath !== '') {
      let requestUrl: URL;
      try {
        requestUrl = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Invalid request path.', {
          handler: 'base-path',
        });
        return;
      }
      const pathname = requestUrl.pathname;
      if (pathname === basePath) {
        res.writeHead(308, { Location: `${basePath}/${requestUrl.search}` });
        res.end();
        return;
      }
      if (pathname === '/') {
        res.writeHead(308, { Location: `${basePath}/${requestUrl.search}` });
        res.end();
        return;
      }
      if (pathname !== '/healthz' && pathname !== '/readyz') {
        if (!pathname.startsWith(`${basePath}/`)) {
          errorResponse(res, 404, 'urn:ok:error:not-found', 'Not found.', {
            handler: 'base-path',
          });
          return;
        }
        req.url = `${pathname.slice(basePath.length)}${requestUrl.search}`;
      }
    }
    requestListener(req, res);
  };
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (basePath !== '') {
      let requestUrl: URL;
      try {
        requestUrl = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith(`${basePath}/`)) {
        socket.destroy();
        return;
      }
      req.url = `${pathname.slice(basePath.length)}${requestUrl.search}`;
    }
    if (collaborationHost.handleUpgrade(req, socket, head)) return;
    if (tripsForwardedHeaderTripwire(req, ingressPolicy)) {
      log.warn(
        { url: req.url, host: req.headers.host },
        '[remote] refused proxied WS upgrade; consent with OK_ALLOW_EXTERNAL=1 + OK_EXTERNAL_URL (or server.allowExternal + server.externalUrl in config)',
      );
      warnForwardedHeaderRefusalOnce(log, 'ws-upgrade');
    }
    socket.destroy();
  };
  httpServer.on('request', onHttpRequest);
  httpServer.on('upgrade', onUpgrade);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      httpServer.off('upgrade', onUpgrade);
      await collaborationHost.shutdown();
    })();
    return shutdownPromise;
  };

  return {
    wss: collaborationHost.wss,
    shutdown,
  };
}

export { parseKeepaliveConnectionId, parseKeepaliveIdentity } from './collaboration-host.ts';
