import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import type { ToolDeps } from '../src/tools.js';
import { TOOL_NAMES } from '../src/tools.js';
import { asFetchLike, makeConfig } from './helpers.js';

interface RpcResult {
  tools?: { name: string; outputSchema?: unknown; icons?: unknown[] }[];
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: { query?: string };
}

const INIT: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};
const INITIALIZED: JSONRPCMessage = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
};

/** Sends the handshake plus `requests`; resolves once every request id has a
 * result, or rejects on a JSON-RPC error response / timeout. */
async function rpc(
  requests: { id: number; method: string; params?: unknown }[],
  captureInit = false,
  deps: ToolDeps = {},
): Promise<Map<number, RpcResult>> {
  const server = createServer(makeConfig(), deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const expected = new Set(requests.map((request) => request.id));
  if (captureInit) expected.add(1);
  const responses = new Map<number, RpcResult>();
  const inbox: JSONRPCMessage[] = [];

  const received = new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const poll = setInterval(() => {
      while (inbox.length > 0) {
        const message = inbox.shift();
        if (!message || !('id' in message) || message.id === undefined) continue;
        if ('error' in message) {
          done(
            new Error(
              `JSON-RPC error for id ${String(message.id)}: ${JSON.stringify(message.error)}`,
            ),
          );
          return;
        }
        if (
          !('result' in message) ||
          (!expected.has(message.id as number) && !(captureInit && message.id === 1))
        )
          continue;
        responses.set(message.id as number, message.result as RpcResult);
        if (expected.size === responses.size) done();
      }
    }, 5);
    const timeout = setTimeout(() => done(new Error('timed out waiting for responses')), 5000);
  });

  // onmessage/onclose are the SDK Transport callback contract, not DOM events.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  clientTransport.onmessage = (message) => {
    inbox.push(message);
  };
  await clientTransport.start();
  await clientTransport.send(INIT);
  await clientTransport.send(INITIALIZED);
  for (const request of requests) {
    await clientTransport.send({
      jsonrpc: '2.0',
      id: request.id,
      method: request.method,
      params: request.params ?? {},
    } as JSONRPCMessage);
  }
  try {
    await received;
  } finally {
    await clientTransport.close();
  }
  return responses;
}

describe('createServer wiring', () => {
  it('exposes every tool in TOOL_NAMES with output schemas over MCP', async () => {
    const responses = await rpc([{ id: 2, method: 'tools/list' }]);
    const listing = responses.get(2);
    expect(listing?.tools?.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of listing?.tools ?? []) {
      expect(tool.outputSchema).toBeDefined();
      expect(Array.isArray(tool.icons)).toBe(true);
    }
  });

  it('advertises server icons in initialize (serverInfo.icons)', async () => {
    const responses = await rpc([], true);
    const serverInfo = responses.get(1) as { serverInfo?: { icons?: { src: string }[] } };
    const icons = serverInfo?.serverInfo?.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    expect(icons[0]?.src).toMatch(/^data:image\/png;base64,/);
  });

  it('returns sanitized tool errors for invalid input', async () => {
    const responses = await rpc([
      {
        id: 3,
        method: 'tools/call',
        params: { name: 'fetch_content', arguments: { url: 'not-a-url' } },
      },
    ]);
    const call = responses.get(3);
    expect(call?.isError).toBe(true);
    expect(call?.content?.[0]?.text).toMatch(/Could not fetch/);
  });

  it('runs a successful tools/call with injected fetch over transport', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(
          JSON.stringify({
            query: 'rust async',
            results: [{ title: 't', url: 'https://r.test/x', content: 'c' }],
            answers: [],
            corrections: [],
            infoboxes: [],
            suggestions: [],
            unresponsiveEngines: [],
          }),
          { status: 200 },
        ),
    );
    const responses = await rpc(
      [
        {
          id: 2,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'rust async' } },
        },
      ],
      false,
      { fetchImpl },
    );
    const call = responses.get(2);
    expect(call?.isError).toBeFalsy();
    expect(call?.structuredContent?.query).toBe('rust async');
    expect(call?.content?.[0]?.text).toContain('UNTRUSTED_WEB_CONTENT');
  });
});
