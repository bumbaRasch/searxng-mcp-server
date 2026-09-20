import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Config } from '../src/config.js';
import { startHttpServer, staticTokenVerifier, type HttpServerHandle } from '../src/http-server.js';
import type { FetchLike } from '../src/http.js';
import { TOOL_NAMES } from '../src/tools.js';
import { makeConfig } from './helpers.js';

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  if (handle) {
    const closing = handle;
    handle = undefined;
    await closing.close();
  }
});

async function startServer(
  overrides: Partial<Config> = {},
  fetchImpl?: FetchLike,
): Promise<string> {
  handle = await startHttpServer(
    makeConfig({ transport: 'http', ...overrides }),
    fetchImpl ? { fetchImpl } : {},
  );
  return handle.url;
}

function modernClient(): Client {
  // Default negotiation is 'legacy' (2025); this endpoint needs the 2026-07-28 era.
  return new Client(
    { name: 'test-client', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
}

const jsonSearchFetch: FetchLike = async () =>
  new Response(
    JSON.stringify({
      query: 'q',
      results: [{ title: 'T', url: 'https://t', content: 'c' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('startHttpServer (modern Streamable HTTP)', () => {
  it('serves initialize and all tools to a real MCP client', async () => {
    const url = await startServer({}, jsonSearchFetch);

    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = modernClient();
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual([...TOOL_NAMES].toSorted());

      const result = await client.callTool({ name: 'search', arguments: { query: 'q' } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('rejects a 2025-era request with an unsupported-protocol-version error', async () => {
    const url = await startServer();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old-client', version: '0.0.0' },
        },
      }),
    });
    const body = (await response.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.message ?? JSON.stringify(body)).toMatch(/protocol/i);
  });

  it('rejects a disallowed Origin header with 403', async () => {
    const url = await startServer();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(response.status).toBe(403);
  });

  it('allows an Origin hostname added via SEARXNG_ALLOWED_ORIGINS', async () => {
    const url = await startServer({ allowedOrigins: ['good.example'] });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://good.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(response.status).not.toBe(403);
  });

  it('answers 404 outside /mcp', async () => {
    const url = await startServer();
    const response = await fetch(new URL('/other', url));
    expect(response.status).toBe(404);
  });

  it('requires a bearer token when one is configured', async () => {
    const url = await startServer({ authToken: 'secret-token' });

    const anonymous = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/Bearer/);

    const wrong = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(wrong.status).toBe(401);
  });

  it('serves an authenticated client when the token matches', async () => {
    const url = await startServer({ authToken: 'secret-token' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: { token: async () => 'secret-token' },
    });
    const client = modernClient();
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(TOOL_NAMES.length);
    } finally {
      await client.close();
    }
  });
});

describe('staticTokenVerifier', () => {
  it('accepts the configured token and returns opaque auth info', async () => {
    const verifier = staticTokenVerifier('secret-token');
    const info = await verifier.verifyAccessToken('secret-token');
    expect(info.clientId).toBe('static-token');
    expect(info.scopes).toEqual([]);
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a wrong token without leaking it', async () => {
    const verifier = staticTokenVerifier('secret-token');
    await expect(verifier.verifyAccessToken('attacker-guess')).rejects.toThrow(/unknown token/);
    await expect(verifier.verifyAccessToken('secret-token-extra')).rejects.toThrow(/unknown token/);
    await expect(verifier.verifyAccessToken('secret')).rejects.toThrow(/unknown token/);
  });
});
