#!/usr/bin/env node
// End-to-end verification: spawns the built MCP server (dist/index.js) and
// drives the JSON-RPC handshake + tool calls over stdio against a live
// SearXNG instance. Usage: node scripts/e2e.mjs
// Requires: docker compose stack running on http://localhost:8888.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:8888';
const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Any 2024+ protocol version works: the server negotiates down to what it
// supports, and the assertions below do not depend on the negotiated value.
const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 60_000;

let nextId = 1;
const pending = new Map();
let buffer = '';
let serverProcess = null;

function fail(message) {
  console.error(`E2E FAIL: ${message}`);
  if (serverProcess) {
    serverProcess.stdin?.end();
    serverProcess.kill('SIGTERM');
  }
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
  console.log(`ok: ${message}`);
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(child, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for response to ${method} (id=${id})`)),
      REQUEST_TIMEOUT_MS,
    );
    pending.set(id, { resolve, timer });
    send(child, { jsonrpc: '2.0', id, method, params });
  });
}

function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // ignore non-JSON stdout noise
  }
  if (message.id === undefined || !pending.has(message.id)) return;
  const { resolve, timer } = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(timer);
  resolve(message);
}

async function main() {
  serverProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SEARXNG_URL },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stderr.setEncoding('utf8');
  serverProcess.stderr.on('data', (data) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[server] ${data}`);
  });

  serverProcess.stdout.setEncoding('utf8');
  serverProcess.stdout.on('data', (data) => {
    buffer += data;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line);
  });

  serverProcess.on('exit', (code) => {
    if (pending.size > 0) fail(`server exited early with code ${code}`);
  });

  try {
    // 1. Handshake
    const init = await request(serverProcess, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'searxng-mcp-ts-e2e', version: '0.0.1' },
    });
    assert(init.result?.serverInfo?.name === 'searxng-mcp-ts', 'initialize returns serverInfo');
    send(serverProcess, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // 2. Tool registration
    const tools = await request(serverProcess, 'tools/list', {});
    const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
    assert(names.includes('search'), 'tools/list registers "search"');
    assert(names.includes('fetch_content'), 'tools/list registers "fetch_content"');
    assert(names.includes('image_search'), 'tools/list registers "image_search"');
    assert(names.includes('news_search'), 'tools/list registers "news_search"');
    assert(names.includes('video_search'), 'tools/list registers "video_search"');
    assert(names.includes('music_search'), 'tools/list registers "music_search"');

    // 3. search against the live SearXNG instance
    const searchCall = await request(serverProcess, 'tools/call', {
      name: 'search',
      arguments: { query: 'searxng' },
    });
    assert(!searchCall.error && !searchCall.result?.isError, 'search call succeeds');
    const structured = searchCall.result?.structuredContent;
    assert(
      Array.isArray(structured?.results) && structured.results.length > 0,
      `search returns results (got ${structured?.results?.length ?? 0})`,
    );
    console.log(`   first result: ${structured.results[0].url}`);

    // 4. fetch_content of a public page
    const exampleCall = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: 'https://example.com' },
    });
    assert(
      !exampleCall.error && !exampleCall.result?.isError,
      'fetch_content example.com succeeds',
    );
    const exampleText = exampleCall.result?.content?.[0]?.text ?? '';
    assert(
      /example/i.test(exampleText) && /domain/i.test(exampleText),
      'fetch_content example.com returns Markdown content',
    );

    // 4a. image_search against the live SearXNG instance
    const imageCall = await request(serverProcess, 'tools/call', {
      name: 'image_search',
      arguments: { query: 'red panda', max_results: 5 },
    });
    assert(!imageCall.error && !imageCall.result?.isError, 'image_search call succeeds');
    const imageStructured = imageCall.result?.structuredContent;
    assert(
      Array.isArray(imageStructured?.results) && imageStructured.results.length > 0,
      `image_search returns results (got ${imageStructured?.results?.length ?? 0})`,
    );
    assert(
      typeof imageStructured.results[0].imgSrc === 'string' &&
        imageStructured.results[0].imgSrc.length > 0,
      'image_search results carry imgSrc',
    );

    // 4b. news_search against the live SearXNG instance
    const newsCall = await request(serverProcess, 'tools/call', {
      name: 'news_search',
      arguments: { query: 'linux', time_range: 'week', max_results: 5 },
    });
    assert(!newsCall.error && !newsCall.result?.isError, 'news_search call succeeds');
    const newsStructured = newsCall.result?.structuredContent;
    assert(Array.isArray(newsStructured?.results), 'news_search returns a results array');

    // 4c. video_search against the live SearXNG instance
    const videoCall = await request(serverProcess, 'tools/call', {
      name: 'video_search',
      arguments: { query: 'fedora linux', time_range: 'month', max_results: 5 },
    });
    assert(!videoCall.error && !videoCall.result?.isError, 'video_search call succeeds');
    const videoStructured = videoCall.result?.structuredContent;
    assert(
      Array.isArray(videoStructured?.results) && videoStructured.results.length > 0,
      `video_search returns results (got ${videoStructured?.results?.length ?? 0})`,
    );
    assert(
      typeof videoStructured.results[0].url === 'string' &&
        videoStructured.results[0].url.length > 0,
      'video_search results carry url',
    );

    // 4d. music_search against the live SearXNG instance
    const musicCall = await request(serverProcess, 'tools/call', {
      name: 'music_search',
      arguments: { query: 'jazz', max_results: 5 },
    });
    assert(!musicCall.error && !musicCall.result?.isError, 'music_search call succeeds');
    assert(
      Array.isArray(musicCall.result?.structuredContent?.results),
      'music_search returns a results array',
    );

    // 5. SSRF guard: private address must be rejected
    const ssrfCall = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: 'http://localhost:8888' },
    });
    assert(
      ssrfCall.result?.isError === true,
      'fetch_content of private address returns isError:true',
    );
    const ssrfMessage = ssrfCall.result?.content?.[0]?.text ?? '';
    assert(
      /private|internal|loopback|not allowed|rejected/i.test(ssrfMessage),
      `SSRF rejection mentions private address: ${JSON.stringify(ssrfMessage)}`,
    );
  } finally {
    serverProcess.stdin.end();
    serverProcess.kill('SIGTERM');
    await Promise.race([
      once(serverProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }

  console.log('E2E PASS: all checks succeeded');
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
