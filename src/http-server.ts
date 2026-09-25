import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createNodeServer, type Server as NodeHttpServer } from 'node:http';
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { SERVER_NAME, createServer } from './server.js';
import type { ToolDeps } from './tools.js';

const MCP_PATH = '/mcp';
const HEALTHZ_PATH = '/healthz';
// requireBearerAuth rejects tokens without an expiry; the static token has none.
const STATIC_TOKEN_EXPIRES_AT_S = 4_102_444_800; // 2100-01-01T00:00:00Z

/** Node-adapter hook: fires when request conversion or handler.fetch throws (answered as 500). */
function onAdapterError(error: Error): void {
  console.error(`${SERVER_NAME} http adapter error:`, error);
}

export interface HttpServerHandle {
  /** Best-effort URL for logs: wildcard binds shown as 127.0.0.1. */
  url: string;
  close(): Promise<void>;
}

/** Timing-safe verifier for the one configured token (SHA-256 digests, no length leak; token never reaches logs). */
export function staticTokenVerifier(token: string): OAuthTokenVerifier {
  const expected = createHash('sha256').update(token, 'utf8').digest();
  return {
    async verifyAccessToken(received: string): Promise<AuthInfo> {
      const digest = createHash('sha256').update(received, 'utf8').digest();
      if (!timingSafeEqual(digest, expected)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
      }
      return {
        token: received,
        clientId: 'static-token',
        scopes: [],
        expiresAt: STATIC_TOKEN_EXPIRES_AT_S,
      };
    },
  };
}

function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Wildcard and IPv6 bind addresses rendered as a URL-usable host. */
function displayHost(host: string): string {
  if (host === '' || host === '0.0.0.0' || host === '::') return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/**
 * Opt-in Streamable HTTP transport: one modern-only (2026-07-28) `/mcp`
 * endpoint, a fresh server per request, no session state. Every request
 * passes the bearer gate (when configured), then Host and Origin validation —
 * except the passive `GET /healthz` probe, which skips only the gate.
 */
export async function startHttpServer(
  config: Config,
  deps: ToolDeps = {},
): Promise<HttpServerHandle> {
  const mcpHandler: McpHttpHandler = createMcpHandler(
    () => {
      const server = createServer(config, deps);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK's canonical error hook is the onerror property
      server.server.onerror = (error) => console.error(`${SERVER_NAME} protocol error:`, error);
      return server;
    },
    {
      legacy: 'reject',
      onerror: (error) => console.error(`${SERVER_NAME} http error:`, error),
    },
  );

  const gate = config.authToken
    ? requireBearerAuth({ verifier: staticTokenVerifier(config.authToken) })
    : undefined;
  const allowedHosts = [...localhostAllowedHostnames(), ...config.allowedHosts];
  const allowedOrigins = [...localhostAllowedOrigins(), ...config.allowedOrigins];

  const handleHealthzRequest = toNodeHandler(
    {
      fetch: async (request: Request): Promise<Response> =>
        hostHeaderValidationResponse(request, allowedHosts) ??
        originValidationResponse(request, allowedOrigins) ??
        Response.json({ status: 'ok' }),
    },
    { onerror: onAdapterError },
  );

  const handleMcpRequest = toNodeHandler(
    {
      fetch: async (request: Request): Promise<Response> => {
        if (gate) {
          const auth = await gate(request);
          if (auth instanceof Response) return auth;
        }
        return (
          hostHeaderValidationResponse(request, allowedHosts) ??
          originValidationResponse(request, allowedOrigins) ??
          mcpHandler.fetch(request)
        );
      },
    },
    { onerror: onAdapterError },
  );

  const server = createNodeServer((req, res) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- exactOptionalPropertyTypes: IncomingMessage's `method: string | undefined` vs the duck type's `method?: string`
    const message = req as NodeIncomingMessageLike;
    const path = (message.url ?? '').split('?')[0];
    if (path === HEALTHZ_PATH && message.method === 'GET') {
      void handleHealthzRequest(message, res);
      return;
    }
    if (path !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `only ${MCP_PATH} is served` }));
      return;
    }
    void handleMcpRequest(message, res);
  });

  await listen(server, config.host, config.port);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  return {
    url: `http://${displayHost(config.host)}:${port}${MCP_PATH}`,
    close: async () => {
      await Promise.all([closeServer(server), mcpHandler.close()]);
    },
  };
}
