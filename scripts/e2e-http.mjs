#!/usr/bin/env node
// Starts the built MCP server in HTTP mode (--transport http) and drives the
// full modern handshake + tool calls over Streamable HTTP against a live
// SearXNG (localhost:8888), using the real SDK client. Mirror of e2e.mjs.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { TOOL_NAMES } from '../dist/tools.js';

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:8888';
const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const REQUEST_TIMEOUT_MS = 60_000;

let serverProcess = null;

function fail(message) {
  console.error(`E2E-HTTP FAIL: ${message}`);
  if (serverProcess) serverProcess.kill('SIGTERM');
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
  console.log(`ok: ${message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.once('error', reject);
  });
}

async function main() {
  const port = await freePort();
  serverProcess = spawn(process.execPath, [SERVER, '--transport', 'http'], {
    env: { ...process.env, SEARXNG_URL, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let log = '';
  serverProcess.stderr.setEncoding('utf8');
  serverProcess.stderr.on('data', (data) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[server] ${data}`);
    log += data;
  });
  await once(serverProcess.stderr, 'data'); // startup line
  const url = `http://127.0.0.1:${port}/mcp`;
  assert(log.includes(`running on ${url}`), `server startup log names ${url}`);

  const client = new Client(
    { name: 'searxng-mcp-server-e2e', version: '0.0.1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
      timeout: REQUEST_TIMEOUT_MS,
    });
    const { tools } = await client.listTools();
    for (const name of TOOL_NAMES) {
      assert(
        tools.some((tool) => tool.name === name),
        `tools/list registers "${name}"`,
      );
    }

    const search = await client.callTool({ name: 'search', arguments: { query: 'searxng' } });
    assert(!search.isError, 'search call succeeds');
    const results = search.structuredContent?.results;
    assert(
      Array.isArray(results) && results.length > 0,
      `search returns results (got ${results?.length ?? 0})`,
    );
    console.log(`   first result: ${results[0].url}`);

    const page = await client.callTool({
      name: 'fetch_content',
      arguments: { url: 'https://example.com' },
    });
    const text = page.content?.[0]?.text ?? '';
    assert(!page.isError && /example/i.test(text), 'fetch_content example.com returns Markdown');

    const ssrf = await client.callTool({
      name: 'fetch_content',
      arguments: { url: 'http://localhost:8888' },
    });
    assert(ssrf.isError === true, 'SSRF guard rejects a private address over HTTP too');

    // Modern-only endpoint: a 2025-era initialize must get a typed rejection.
    const legacy = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old', version: '0' },
        },
      }),
    });
    const legacyBody = await legacy.json();
    assert(
      legacyBody.error?.code === -32022,
      `2025-era initialize rejected with -32022 (got ${legacyBody.error?.code})`,
    );

    const evilOrigin = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    assert(
      evilOrigin.status === 403,
      `disallowed Origin rejected with 403 (got ${evilOrigin.status})`,
    );
  } finally {
    await client.close().catch(() => {});
    serverProcess.kill('SIGTERM');
    await Promise.race([once(serverProcess, 'exit'), new Promise((r) => setTimeout(r, 2000))]);
  }

  console.log('E2E-HTTP PASS: all checks succeeded');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
