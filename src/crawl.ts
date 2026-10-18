/**
 * crawl_site: BFS-crawl a site into a URL/title/snippet manifest (Stage 3).
 * Every page goes through the existing SSRF-guarded fetch pipeline; extracted
 * content is kept in a bounded PageStore so later `fetch_content` calls (via
 * ref:N or the plain URL) serve it without a network hop. Link discovery runs
 * on the absolutized Markdown output, so only same-origin http(s) targets are
 * followed; robots.txt is honored best-effort (prefix Disallow for the `*`
 * group; no Allow-precedence or wildcard rules).
 */

import { isRecord } from './categories/shared.js';
import type { Config } from './config.js';
import { FetchError, fetchContent } from './fetch.js';
import type { FetchLike } from './http.js';
import type { LookupAll } from './ssrf.js';
import type { RefRegistry } from './refs.js';
import type { CrawlResponse } from './schemas/crawl.js';
import { truncateText } from './categories/shared.js';

const SNIPPET_CHARS = 200;
const MAX_LINKS_PER_PAGE = 200;
/** Store bound: pages kept for later fetch_content reads. */
const MAX_STORED_PAGES = 256;
const ROBOTS_MAX_CHARS = 20_000;

/** Bounded store of crawled page content, keyed by the requested URL. */
export interface StoredPage {
  requestedUrl: string;
  finalUrl: string;
  content: string;
  branch: 'markdown' | 'pdf';
  title?: string | undefined;
}

export class PageStore {
  private readonly entries = new Map<string, StoredPage>();

  constructor(private readonly maxEntries: number = MAX_STORED_PAGES) {}

  put(page: StoredPage): void {
    this.entries.delete(page.requestedUrl);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(page.requestedUrl, page);
  }

  get(url: string): StoredPage | undefined {
    const entry = this.entries.get(url);
    if (entry === undefined) return undefined;
    // Refresh recency on hit.
    this.entries.delete(url);
    this.entries.set(url, entry);
    return entry;
  }
}

/** Production store; tests inject their own via ToolDeps.pages. */
export const sharedPages = new PageStore();

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Same-origin http(s) link targets from absolutized Markdown. */
export function extractMarkdownLinks(markdown: string, origin: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(MD_LINK)) {
    const target = match[1];
    if (target === undefined) continue;
    try {
      const url = new URL(target);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (url.origin !== origin) continue;
      url.hash = '';
      links.add(url.toString());
    } catch {
      // not a URL — turndown emits non-link parenthesized text too
    }
    if (links.size >= MAX_LINKS_PER_PAGE) break;
  }
  return [...links];
}

export interface RobotsPolicy {
  allows(url: string): boolean;
}

const ALLOW_ALL: RobotsPolicy = { allows: () => true };

/** Minimal robots.txt: prefix `Disallow` rules for the `User-Agent: *` group. */
export function parseRobots(text: string): RobotsPolicy {
  const disallows: string[] = [];
  let inStarGroup = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      inStarGroup = value === '*';
    } else if (inStarGroup && key === 'disallow' && value !== '') {
      disallows.push(value);
    }
  }
  return {
    allows(url: string): boolean {
      let path: string;
      try {
        path = new URL(url).pathname;
      } catch {
        return false;
      }
      return !disallows.some((prefix) => path.startsWith(prefix));
    },
  };
}

export interface CrawlOptions {
  maxPages: number;
  fetchImpl?: FetchLike | undefined;
  lookup?: LookupAll | undefined;
  refs: RefRegistry;
  store: PageStore;
}

async function loadRobotsPolicy(
  config: Config,
  seed: string,
  opts: CrawlOptions,
): Promise<RobotsPolicy> {
  try {
    const robotsUrl = new URL('/', seed).origin + '/robots.txt';
    const robots = await fetchContent(config, robotsUrl, {
      maxChars: ROBOTS_MAX_CHARS,
      fetchImpl: opts.fetchImpl,
      lookup: opts.lookup,
    });
    return parseRobots(robots.content);
  } catch {
    // Best-effort: an unreachable or unparsable robots.txt allows crawling.
    return ALLOW_ALL;
  }
}

function projectStoredPage(
  url: string,
  page: Awaited<ReturnType<typeof fetchContent>>,
): StoredPage {
  const stored: StoredPage = {
    requestedUrl: url,
    finalUrl: page.finalUrl,
    content: page.content,
    branch: page.pages !== undefined ? 'pdf' : 'markdown',
  };
  if (page.title !== undefined) stored.title = page.title;
  return stored;
}

export async function crawlSite(
  config: Config,
  rawSeed: string,
  opts: CrawlOptions,
): Promise<CrawlResponse> {
  let seedUrl: URL;
  try {
    seedUrl = new URL(rawSeed);
  } catch {
    throw new FetchError(`Invalid seed URL: ${rawSeed}`);
  }
  if (seedUrl.protocol !== 'http:' && seedUrl.protocol !== 'https:') {
    throw new FetchError('Only http/https seed URLs are supported.');
  }
  const robots = await loadRobotsPolicy(config, rawSeed, opts);
  if (!robots.allows(rawSeed)) {
    throw new FetchError(`The seed URL is disallowed by the site's robots.txt.`);
  }

  const seen = new Set<string>([rawSeed]);
  const queue: string[] = [rawSeed];
  const pages: CrawlResponse['pages'] = [];
  while (queue.length > 0 && pages.length < opts.maxPages) {
    const url = queue.shift();
    if (url === undefined) break;
    if (!robots.allows(url)) continue;
    let page;
    try {
      page = await fetchContent(config, url, { fetchImpl: opts.fetchImpl, lookup: opts.lookup });
    } catch {
      // A dead page contributes nothing to the manifest; the crawl continues.
      continue;
    }
    opts.store.put(projectStoredPage(url, page));
    pages.push({
      ref: opts.refs.assign(url),
      url,
      title: page.title ?? '',
      snippet: truncateText(page.content.replace(/\n+/g, ' ').trim(), SNIPPET_CHARS),
    });
    for (const link of extractMarkdownLinks(page.content, seedUrl.origin)) {
      if (!seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
  }
  return { seed: rawSeed, crawled: pages.length, pages };
}

/** Shape guard reused by tests: a crawl response is a record with pages. */
export function isCrawlResponse(value: unknown): value is CrawlResponse {
  return isRecord(value) && Array.isArray(value.pages);
}
