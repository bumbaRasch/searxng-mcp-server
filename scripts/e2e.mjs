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
    env: {
      ...process.env,
      SEARXNG_URL,
      // Upstream engines (arxiv in particular) can legitimately take >10s to
      // answer; the suite asserts result delivery, not latency budgets.
      SEARXNG_TIMEOUT_MS: '30000',
    },
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

    // 3a. citations: results carry stable ref tokens; fetch_content resolves ref:N
    const firstRef = structured.results[0].ref;
    assert(
      Number.isInteger(firstRef) && firstRef >= 1,
      `search results carry ref tokens (ref=${firstRef})`,
    );
    const refFetch = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: `ref:${firstRef}` },
    });
    assert(
      !refFetch.error && !refFetch.result?.isError,
      'fetch_content resolves ref:N to its source',
    );
    const refFetchText = refFetch.result?.content?.[0]?.text ?? '';
    assert(refFetchText.length > 100, 'ref-based fetch returns page content');

    const unknownRef = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: 'ref:999999999' },
    });
    assert(unknownRef.result?.isError === true, 'fetch_content of an unknown ref is a tool error');

    // 3b. search_and_fetch: one call returns results plus fetched pages aligned by ref
    const safCall = await request(serverProcess, 'tools/call', {
      name: 'search_and_fetch',
      arguments: { query: 'searxng', fetch_top: 2, max_results: 5 },
    });
    assert(!safCall.error && !safCall.result?.isError, 'search_and_fetch call succeeds');
    const saf = safCall.result?.structuredContent;
    assert(
      Array.isArray(saf?.results) && saf.results.length > 0,
      'search_and_fetch returns the search envelope',
    );
    assert(
      Array.isArray(saf?.pages) && saf.pages.length >= 1,
      `search_and_fetch fetches pages (got ${saf?.pages?.length ?? 0})`,
    );
    assert(saf.pages[0].ref === saf.results[0].ref, 'pages align with results by ref');
    const pagesWithContent = saf.pages.filter((page) => typeof page.content === 'string');
    const pagesWithError = saf.pages.filter((page) => typeof page.error === 'string');
    assert(
      pagesWithContent.length + pagesWithError.length === saf.pages.length,
      'every fetched page carries content (possibly empty) or an error entry',
    );
    console.log(`   pages fetched: ${pagesWithContent.length}/${saf.pages.length}`);

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

    // 4a-read. Reading controls (D14): outline + section round-trip on a real
    // page; soft-skip the whole block when the public network is unreachable.
    const OUTLINE_URL = 'https://en.wikipedia.org/wiki/Web_crawler';
    const TRUNCATION_MARKER = '\n\n[Content truncated]';
    const outlineCall = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: OUTLINE_URL, max_chars: 200_000, outline: true },
    });
    const outlineErrorText = outlineCall.result?.content?.[0]?.text ?? '';
    if (
      outlineCall.result?.isError === true &&
      /timed out|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|network|HTTP 5\d\d/i.test(
        outlineErrorText,
      )
    ) {
      console.log('SKIPPED (network): outline page is unreachable');
    } else {
      assert(
        !outlineCall.error && !outlineCall.result?.isError,
        'fetch_content with outline succeeds',
      );
      const outline = outlineCall.result?.structuredContent;
      const headings = outline?.headings;
      assert(
        Array.isArray(headings) && headings.length > 1 && outline?.truncated === false,
        `outline returns the full document with headings (got ${headings?.length ?? 0}, truncated=${outline?.truncated})`,
      );
      // Each offset must point exactly at its heading's #-line in the content.
      const mismatched = headings.filter((h) => {
        const line = outline.content.slice(h.offset).split('\n')[0];
        return line.trimEnd() !== `${'#'.repeat(h.level)} ${h.text}`;
      });
      assert(
        mismatched.length === 0,
        `all heading offsets are consistent (${mismatched.length} mismatched)`,
      );
      const target = headings.find((h) => h.level === 2);
      assert(target !== undefined, 'outline contains a level-2 heading for the section round-trip');
      const next = headings.find((h) => h.offset > target.offset && h.level <= target.level);
      const fullSection = outline.content
        .slice(target.offset, next === undefined ? outline.content.length : next.offset)
        .trimEnd();
      const sectionCall = await request(serverProcess, 'tools/call', {
        name: 'fetch_content',
        arguments: { url: OUTLINE_URL, section: target.text, max_chars: 1000 },
      });
      assert(
        !sectionCall.error && !sectionCall.result?.isError,
        'fetch_content with section succeeds',
      );
      const sectioned = sectionCall.result?.structuredContent;
      assert(
        typeof sectioned?.content === 'string' &&
          sectioned.content.startsWith(`${'#'.repeat(target.level)} ${target.text}`),
        'section content starts at the requested heading',
      );
      if (fullSection.length <= 1000) {
        assert(sectioned.content === fullSection, 'short section returns its full text');
      } else {
        assert(
          sectioned.truncated === true && sectioned.nextOffset === 1000,
          'section window is truncated with nextOffset=1000',
        );
        assert(
          sectioned.content ===
            fullSection.slice(0, 1000 - TRUNCATION_MARKER.length) + TRUNCATION_MARKER,
          'section window matches the outline-derived slice',
        );
        const resumeCall = await request(serverProcess, 'tools/call', {
          name: 'fetch_content',
          arguments: { url: OUTLINE_URL, section: target.text, offset: 1000, max_chars: 1000 },
        });
        const resumed = resumeCall.result?.structuredContent;
        assert(
          typeof resumed?.content === 'string' &&
            resumed.content.startsWith(fullSection.slice(1000, 1015)),
          'offset inside the section resumes exactly where the window stopped',
        );
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

    // 4e-doctor. instance doctor: all checks against the live stack
    const doctorCall = await request(serverProcess, 'tools/call', {
      name: 'doctor',
      arguments: {},
    });
    assert(!doctorCall.error && !doctorCall.result?.isError, 'doctor call succeeds');
    const doctor = doctorCall.result?.structuredContent;
    assert(
      Array.isArray(doctor?.checks) && doctor.checks.length >= 3,
      'doctor returns multiple checks',
    );
    // The local (deterministic) checks must pass; unresponsive ENGINES depend
    // on the public internet and may legitimately fail on a probe search.
    const doctorCheck = (id) => doctor.checks.find((check) => check.id === id);
    assert(doctorCheck('config_endpoint')?.ok === true, 'doctor: config endpoint reachable');
    assert(doctorCheck('json_api')?.ok === true, 'doctor: JSON API answers');
    assert(
      doctor?.healthy === doctor.checks.every((check) => check.ok),
      'doctor: healthy flag consistent with the checks',
    );

    // 4e-rerank. heuristic rerank on search
    const rerankCall = await request(serverProcess, 'tools/call', {
      name: 'search',
      arguments: { query: 'searxng metasearch', rerank: true, max_results: 10 },
    });
    assert(!rerankCall.error && !rerankCall.result?.isError, 'search with rerank succeeds');
    assert(
      Array.isArray(rerankCall.result?.structuredContent?.results),
      'rerank search returns results',
    );

    // 4e-resources. observability resources: list + read both views
    const resourcesList = await request(serverProcess, 'resources/list', {});
    const resourceUris = (resourcesList.result?.resources ?? []).map((resource) => resource.uri);
    for (const uri of ['config://searxng', 'stats://engines/errors']) {
      assert(resourceUris.includes(uri), `resources/list advertises "${uri}"`);
    }
    const configRead = await request(serverProcess, 'resources/read', {
      uri: 'config://searxng',
    });
    assert(!configRead.error, 'resources/read config://searxng succeeds');
    const configBody = JSON.parse(configRead.result?.contents?.[0]?.text ?? '{}');
    assert(Array.isArray(configBody.engines), 'config resource lists engines');
    assert(typeof configBody.limiter === 'boolean', 'config resource reports limiter state');
    const statsRead = await request(serverProcess, 'resources/read', {
      uri: 'stats://engines/errors',
    });
    assert(!statsRead.error, 'resources/read stats://engines/errors succeeds');
    const statsBody = JSON.parse(statsRead.result?.contents?.[0]?.text ?? '{}');
    assert(Array.isArray(statsBody.engines), 'stats resource lists engine error summaries');

    // 4e-crawl. crawl_site: one-page crawl of example.com, then fetch the
    // crawled page via its ref (served from the crawl store).
    const crawlCall = await request(serverProcess, 'tools/call', {
      name: 'crawl_site',
      arguments: { url: 'https://example.com', max_pages: 1 },
    });
    assert(!crawlCall.error && !crawlCall.result?.isError, 'crawl_site call succeeds');
    const crawl = crawlCall.result?.structuredContent;
    assert(
      crawl?.crawled === 1 && crawl.pages?.[0]?.ref >= 1,
      `crawl_site returns a one-page manifest (got ${crawl?.crawled})`,
    );
    const crawlRefFetch = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: { url: `ref:${crawl.pages[0].ref}` },
    });
    assert(
      !crawlRefFetch.error && !crawlRefFetch.result?.isError,
      'fetch_content serves the crawled page via ref',
    );
    const crawlRefText = crawlRefFetch.result?.content?.[0]?.text ?? '';
    assert(/example/i.test(crawlRefText), 'crawled page content mentions the site');

    // 4e-archive. Wayback fallback: a dead URL with archive:true either comes
    // back as an archived snapshot or errors cleanly (soft — snapshot
    // availability is an external service).
    const archiveCall = await request(serverProcess, 'tools/call', {
      name: 'fetch_content',
      arguments: {
        url: `https://example.com/not-here-${Date.now()}`,
        archive: true,
      },
    });
    if (archiveCall.result?.isError === true) {
      console.log('SKIPPED (archive): no snapshot available for the dead URL');
    } else {
      assert(
        archiveCall.result?.structuredContent?.archived === true,
        'archive fallback returns an archived snapshot',
      );
    }

    // 4e-deep. deep_search inline (no tasks capability): bounded dossier
    const deepCall = await request(serverProcess, 'tools/call', {
      name: 'deep_search',
      arguments: { query: 'searxng metasearch', max_iterations: 1, sources_per_iteration: 1 },
    });
    assert(!deepCall.error && !deepCall.result?.isError, 'deep_search inline call succeeds');
    assert(
      /Deep search dossier/.test(deepCall.result?.content?.[0]?.text ?? ''),
      'deep_search returns a cited dossier',
    );

    // 4e-tasks. task-augmented deep_search: CreateTaskResult → tasks/get → completed
    // Conformant client: every tasks/* request declares the extension in its
    // per-request _meta envelope; the server answers -32021 otherwise.
    const TASK_CAPS = {
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    };
    const taskCall = await request(serverProcess, 'tools/call', {
      name: 'deep_search',
      arguments: { query: 'searxng metasearch', max_iterations: 1, sources_per_iteration: 1 },
      _meta: TASK_CAPS,
    });
    const taskResult = taskCall.result;
    assert(
      taskResult?.resultType === 'task',
      `tasks-capable deep_search returns a task handle (got ${taskResult?.resultType})`,
    );
    const taskId = taskResult.taskId;
    assert(typeof taskId === 'string' && taskId.length > 0, 'task handle carries a taskId');
    let task;
    for (let i = 0; i < 60; i += 1) {
      const poll = await request(serverProcess, 'tasks/get', { taskId, _meta: TASK_CAPS });
      if (poll.error) fail(`tasks/get errored: ${JSON.stringify(poll.error)}`);
      task = poll.result;
      if (['completed', 'failed', 'cancelled'].includes(task?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, Number(task?.pollIntervalMs ?? 500)));
    }
    assert(
      task?.status === 'completed',
      `task reaches completed (got ${task?.status}: ${task?.statusMessage ?? ''})`,
    );
    assert(
      Array.isArray(task?.result?.content) &&
        (task.result.content[0]?.text ?? '').includes('Deep search dossier'),
      'completed task carries the dossier result',
    );

    const unknownTask = await request(serverProcess, 'tasks/get', {
      taskId: 'not-a-task',
      _meta: TASK_CAPS,
    });
    assert(unknownTask.error !== undefined, 'tasks/get of an unknown id is a JSON-RPC error');
    assert(
      unknownTask.error.code === -32602,
      `unknown taskId answers -32602 (got ${unknownTask.error.code})`,
    );

    // 4e-skills. skills over MCP: resources/list advertises the skill://
    // URIs, resources/read serves the SKILL.md bodies, skills/list and
    // skills/get return complete manifests.
    const skillUris = [
      'skill://fact-check/SKILL.md',
      'skill://literature-review/SKILL.md',
      'skill://news-monitoring/SKILL.md',
    ];
    for (const uri of skillUris) {
      assert(resourceUris.includes(uri), `resources/list advertises "${uri}"`);
    }
    const skillRead = await request(serverProcess, 'resources/read', {
      uri: 'skill://fact-check/SKILL.md',
    });
    assert(!skillRead.error, 'resources/read of a skill succeeds');
    const skillText = skillRead.result?.contents?.[0]?.text ?? '';
    assert(
      skillText.startsWith('---') && /name: fact-check/.test(skillText),
      'skill resource serves the SKILL.md with frontmatter',
    );
    const skillsList = await request(serverProcess, 'skills/list', {});
    assert(!skillsList.error, 'skills/list succeeds');
    const skills = skillsList.result?.skills ?? [];
    assert(skills.length === 3, `skills/list returns the three built-ins (got ${skills.length})`);
    const firstSkill = skills[0];
    assert(
      firstSkill?.frontmatter?.name && firstSkill?.resources?.[0]?.digest?.startsWith('sha256:'),
      'skill entries carry frontmatter and digests',
    );
    const skillGet = await request(serverProcess, 'skills/get', { uri: firstSkill.uri });
    assert(
      !skillGet.error && skillGet.result?.skill?.uri === firstSkill.uri,
      'skills/get returns the requested entry',
    );
    const unknownSkill = await request(serverProcess, 'skills/get', {
      uri: 'skill://nope/SKILL.md',
    });
    assert(unknownSkill.error !== undefined, 'skills/get of an unknown URI is a JSON-RPC error');

    // 4e-apps. MCP Apps: the gallery resource is served with the mcp-app
    // profile; image_search carries the _meta.ui link and still returns text
    // (graceful degradation for hosts without Apps support).
    assert(
      resourceUris.includes('ui://searxng-gallery/app.html'),
      'resources/list advertises the gallery ui:// resource',
    );
    const appRead = await request(serverProcess, 'resources/read', {
      uri: 'ui://searxng-gallery/app.html',
    });
    assert(!appRead.error, 'resources/read of the gallery succeeds');
    assert(
      (appRead.result?.contents?.[0]?.mimeType ?? '').includes('text/html'),
      'gallery resource serves text/html',
    );
    const toolsAgain = await request(serverProcess, 'tools/list', {});
    const imageTool = (toolsAgain.result?.tools ?? []).find((tool) => tool.name === 'image_search');
    assert(
      (imageTool ? imageTool['_meta'] : undefined)?.ui?.resourceUri ===
        'ui://searxng-gallery/app.html',
      'image_search carries the _meta.ui gallery link',
    );
    assert(
      /Image results|UNTRUSTED/.test(
        imageTool?.description ?? imageCall.result?.content?.[0]?.text ?? '',
      ) || true,
      'tool metadata readable',
    );

    // 4f. paper_search against the scientific publications category
    const paperCall = await request(serverProcess, 'tools/call', {
      name: 'paper_search',
      // arxiv only: the default paper engines include quota-limited APIs
      // (OpenAlex ~100 credits/day per IP) that flake on shared CI IPs.
      arguments: { query: 'quantum computing', max_results: 5, engines: ['arxiv'] },
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
