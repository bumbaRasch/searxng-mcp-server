#!/usr/bin/env node
// Spawns the built MCP server (dist/index.js) and drives the JSON-RPC
// handshake + tool calls over stdio against a live SearXNG (localhost:8888).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../dist/tools.js';

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
      clientInfo: { name: 'searxng-mcp-server-e2e', version: '0.0.1' },
    });
    assert(init.result?.serverInfo?.name === 'searxng-mcp-server', 'initialize returns serverInfo');
    send(serverProcess, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // 2. Tool registration
    const tools = await request(serverProcess, 'tools/list', {});
    const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
    for (const name of TOOL_NAMES) {
      assert(names.includes(name), `tools/list registers "${name}"`);
    }

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

    // 4a-pdf. public PDF read (D4) + offset continuation round-trip (D5);
    // soft-skip the whole block when the public network is unreachable.
    const PDF_URL = 'https://www.irs.gov/pub/irs-pdf/fw4.pdf';
    const pdfCall = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: PDF_URL, max_chars: 200_000 },
    });
    const pdfErrorText = pdfCall.result?.content?.[0]?.text ?? '';
    if (
      pdfCall.result?.isError === true &&
      /timed out|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|network|HTTP 5\d\d/i.test(
        pdfErrorText,
      )
    ) {
      console.log('SKIPPED (network): public PDF fetch is unreachable');
    } else {
      assert(!pdfCall.error && !pdfCall.result?.isError, 'fetch_content of a public PDF succeeds');
      const pdf = pdfCall.result?.structuredContent;
      assert(
        typeof pdf?.pages === 'number' && pdf.pages >= 1,
        `PDF result reports pages (got ${pdf?.pages})`,
      );
      assert(
        typeof pdf?.content === 'string' && pdf.content.includes('[Page 1]'),
        'PDF content carries a [Page 1] section',
      );

      const OFFSET_WINDOW = 1000; // schema floor for max_chars
      const TRUNCATION_MARKER = '\n\n[Content truncated]';
      const fullContent = pdf.content;
      if (fullContent.length > OFFSET_WINDOW + TRUNCATION_MARKER.length) {
        const firstWindow = await request(serverProcess, 'tools/call', {
          name: 'fetch_content',
          arguments: { url: PDF_URL, max_chars: OFFSET_WINDOW },
        });
        const w1 = firstWindow.result?.structuredContent;
        assert(
          w1?.truncated === true && w1?.nextOffset === OFFSET_WINDOW,
          `windowed PDF is truncated with nextOffset=${OFFSET_WINDOW} (got truncated=${w1?.truncated}, nextOffset=${w1?.nextOffset})`,
        );
        assert(
          w1?.content ===
            fullContent.slice(0, OFFSET_WINDOW - TRUNCATION_MARKER.length) + TRUNCATION_MARKER,
          'first window is the capped prefix plus the truncation marker',
        );
        const secondWindow = await request(serverProcess, 'tools/call', {
          name: 'fetch_content',
          arguments: { url: PDF_URL, max_chars: OFFSET_WINDOW, offset: w1.nextOffset },
        });
        const w2 = secondWindow.result?.structuredContent;
        assert(
          typeof w2?.content === 'string' &&
            w2.content.startsWith(fullContent.slice(OFFSET_WINDOW, OFFSET_WINDOW + 15)),
          'offset fetch resumes exactly where the first window stopped',
        );
      } else {
        console.log('SKIPPED (PDF text too short for offset round-trip)');
      }
    }

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

    // 4e. list_engines against the live instance
    const enginesCall = await request(serverProcess, 'tools/call', {
      name: 'list_engines',
      arguments: {},
    });
    assert(!enginesCall.error && !enginesCall.result?.isError, 'list_engines call succeeds');
    assert(
      (enginesCall.result?.structuredContent?.counts?.engines ?? 0) > 0,
      `list_engines reports enabled engines (got ${enginesCall.result?.structuredContent?.counts?.engines ?? 0})`,
    );

    // 4f. paper_search against the scientific publications category
    const paperCall = await request(serverProcess, 'tools/call', {
      name: 'paper_search',
      arguments: { query: 'quantum computing', max_results: 5 },
    });
    assert(!paperCall.error && !paperCall.result?.isError, 'paper_search call succeeds');
    const paperStructured = paperCall.result?.structuredContent;
    assert(
      Array.isArray(paperStructured?.results) && paperStructured.results.length > 0,
      `paper_search returns results (got ${paperStructured?.results?.length ?? 0})`,
    );
    assert(
      typeof paperStructured.results[0].url === 'string' &&
        paperStructured.results[0].url.length > 0,
      'paper_search results carry url',
    );
    console.log(`   first paper: ${paperStructured.results[0].title}`);

    // 4g. autocomplete for a common prefix (empty suggestions are valid)
    const autocompleteCall = await request(serverProcess, 'tools/call', {
      name: 'autocomplete',
      arguments: { query: 'sear' },
    });
    assert(
      !autocompleteCall.error && !autocompleteCall.result?.isError,
      'autocomplete call succeeds',
    );
    const autocomplete = autocompleteCall.result?.structuredContent;
    assert(autocomplete?.query === 'sear', 'autocomplete echoes the prefix');
    assert(
      Array.isArray(autocomplete?.suggestions),
      `autocomplete returns a suggestions array (got ${autocomplete?.suggestions?.length ?? 'none'})`,
    );

    // 4h. search ergonomics: min_score filter + compact detail
    const compactCall = await request(serverProcess, 'tools/call', {
      name: 'search',
      arguments: { query: 'searxng', min_score: 0, detail: 'compact' },
    });
    assert(
      !compactCall.error && !compactCall.result?.isError,
      'search with min_score + compact detail succeeds',
    );
    const compactStructured = compactCall.result?.structuredContent;
    assert(
      Array.isArray(compactStructured?.results) && compactStructured.results.length > 0,
      `compact search returns results (got ${compactStructured?.results?.length ?? 0})`,
    );
    const compactText = compactCall.result?.content?.[0]?.text ?? '';
    assert(
      compactText.includes(new URL(compactStructured.results[0].url).hostname),
      'compact render keeps the result URL',
    );
    const fullSearchText = searchCall.result?.content?.[0]?.text ?? '';
    if (/_engine:/.test(fullSearchText)) {
      assert(!/_engine:/.test(compactText), 'compact render drops per-result engine meta lines');
    }

    // 4i. batch search: one envelope per query, input order preserved
    const batchCall = await request(serverProcess, 'tools/call', {
      name: 'search',
      arguments: { queries: ['searxng', 'metasearch engine'], max_results: 3 },
    });
    assert(!batchCall.error && !batchCall.result?.isError, 'batch search (queries[]) succeeds');
    const batch = batchCall.result?.structuredContent?.batch;
    assert(
      Array.isArray(batch) && batch.length === 2,
      `batch carries one entry per query (got ${Array.isArray(batch) ? batch.length : 'none'})`,
    );
    assert(
      batch[0]?.query === 'searxng' && batch[1]?.query === 'metasearch engine',
      'batch preserves input query order',
    );
    assert(Array.isArray(batch[0]?.results), 'batch entries carry a results array');

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
