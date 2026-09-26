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

  // /healthz is passive: no session, no bearer, just Host/Origin validation.
  const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert(healthz.status === 200, `/healthz answers 200 (got ${healthz.status})`);
  assert(
    (healthz.headers.get('content-type') ?? '').includes('application/json'),
    '/healthz serves JSON',
  );
  const healthzBody = await healthz.json();
  assert(healthzBody?.status === 'ok', `/healthz reports ok (got ${JSON.stringify(healthzBody)})`);

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

    // v0.4.0 surface over Streamable HTTP: wire schemas validated by the SDK.
    const suggestions = await client.callTool({
      name: 'autocomplete',
      arguments: { query: 'sear' },
    });
    assert(
      !suggestions.isError && Array.isArray(suggestions.structuredContent?.suggestions),
      'autocomplete returns a suggestions array over HTTP',
    );

    const papers = await client.callTool({
      name: 'paper_search',
      arguments: { query: 'quantum computing', max_results: 5 },
    });
    assert(
      !papers.isError && (papers.structuredContent?.results?.length ?? 0) > 0,
      `paper_search returns results over HTTP (got ${papers.structuredContent?.results?.length ?? 0})`,
    );

    // v0.5.0 reading controls (D14) over Streamable HTTP: outline + section
    // round-trip on a real page.
    const OUTLINE_URL = 'https://en.wikipedia.org/wiki/Web_crawler';
    const outline = await client.callTool({
      name: 'fetch_content',
      arguments: { url: OUTLINE_URL, max_chars: 200_000, outline: true },
    });
    assert(!outline.isError, 'fetch_content with outline succeeds over HTTP');
    const headings = outline.structuredContent?.headings;
    assert(
      Array.isArray(headings) &&
        headings.length > 1 &&
        outline.structuredContent?.truncated === false,
      `outline returns the full document with headings over HTTP (got ${headings?.length ?? 0})`,
    );
    assert(
      headings.every(
        (h) =>
          outline.structuredContent.content.slice(h.offset).split('\n')[0].trimEnd() ===
          `${'#'.repeat(h.level)} ${h.text}`,
      ),
      'all heading offsets are consistent over HTTP',
    );
    const target = headings.find((h) => h.level === 2);
    assert(target !== undefined, 'outline contains a level-2 heading over HTTP');
    const next = headings.find((h) => h.offset > target.offset && h.level <= target.level);
    const fullSection = outline.structuredContent.content
      .slice(
        target.offset,
        next === undefined ? outline.structuredContent.content.length : next.offset,
      )
      .trimEnd();
    const sectioned = await client.callTool({
      name: 'fetch_content',
      arguments: { url: OUTLINE_URL, section: target.text, max_chars: 1000 },
    });
    assert(
      !sectioned.isError &&
        sectioned.structuredContent?.content?.startsWith(
          `${'#'.repeat(target.level)} ${target.text}`,
        ),
      'section content starts at the requested heading over HTTP',
    );
    if (fullSection.length > 1000) {
      assert(
        sectioned.structuredContent.truncated === true &&
          sectioned.structuredContent.nextOffset === 1000,
        'section window is truncated with nextOffset=1000 over HTTP',
      );
      const resumed = await client.callTool({
        name: 'fetch_content',
        arguments: { url: OUTLINE_URL, section: target.text, offset: 1000, max_chars: 1000 },
      });
      assert(
        resumed.structuredContent?.content?.startsWith(fullSection.slice(1000, 1015)),
        'offset inside the section resumes exactly over HTTP',
      );
    } else {
      assert(
        sectioned.structuredContent.content === fullSection,
        'short section returns its full text over HTTP',
      );
    }

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
