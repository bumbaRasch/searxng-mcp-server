import { describe, expect, it } from 'vitest';
import {
  crawlSite,
  extractMarkdownLinks,
  isCrawlResponse,
  PageStore,
  parseRobots,
  type StoredPage,
} from '../src/crawl.js';
import { RefRegistry } from '../src/refs.js';
import { asFetchLike, makeConfig } from './helpers.js';

const config = makeConfig();

describe('extractMarkdownLinks', () => {
  it('extracts same-origin https targets, strips fragments, skips cross-origin', () => {
    const links = extractMarkdownLinks(
      [
        '[a](https://site.test/x#frag)',
        '[b](https://site.test/y)',
        '[off-scheme](http://site.test/plain-http-is-a-different-origin)',
        '[off-site](https://other.test/z)',
        '[scheme](javascript:alert(1))',
        '[not a url](parenthetical note)',
      ].join(' '),
      'https://site.test',
    );
    expect(links).toEqual(['https://site.test/x', 'https://site.test/y']);
  });
});

describe('parseRobots', () => {
  const policy = parseRobots(
    [
      'Sitemap: https://site.test/sitemap.xml',
      'User-agent: Googlebot',
      'Disallow: /for-google',
      '',
      'User-agent: *',
      'Disallow: /private # comment',
      'Disallow:',
      'Allow: /public',
    ].join('\n'),
  );
  it('honors prefix Disallow rules of the * group only', () => {
    expect(policy.allows('https://site.test/page')).toBe(true);
    expect(policy.allows('https://site.test/private/x')).toBe(false);
    expect(policy.allows('https://site.test/for-google')).toBe(true);
    expect(policy.allows('https://site.test/public/thing')).toBe(true);
  });
  it('allows everything on unparsable URLs', () => {
    expect(parseRobots('').allows('https://site.test/')).toBe(true);
  });
});

const storedPage = (url: string): StoredPage => ({
  requestedUrl: url,
  finalUrl: url,
  content: `content of ${url}`,
  branch: 'markdown',
});

describe('PageStore', () => {
  it('evicts the oldest entry beyond the bound', () => {
    const store = new PageStore(2);
    store.put(storedPage('https://site.test/a'));
    store.put(storedPage('https://site.test/b'));
    store.put(storedPage('https://site.test/c'));
    expect(store.get('https://site.test/a')).toBeUndefined();
    expect(store.get('https://site.test/b')).toBeDefined();
    expect(store.get('https://site.test/c')).toBeDefined();
  });

  it('re-putting a key refreshes its recency, so the untouched entry is evicted', () => {
    const store = new PageStore(2);
    store.put(storedPage('https://site.test/a'));
    store.put(storedPage('https://site.test/b'));
    store.put(storedPage('https://site.test/a'));
    store.put(storedPage('https://site.test/c'));
    expect(store.get('https://site.test/a')).toBeDefined();
    expect(store.get('https://site.test/b')).toBeUndefined();
  });

  it('get refreshes recency, so a recently read entry survives the next put', () => {
    const store = new PageStore(2);
    store.put(storedPage('https://site.test/a'));
    store.put(storedPage('https://site.test/b'));
    expect(store.get('https://site.test/a')).toBeDefined();
    store.put(storedPage('https://site.test/c'));
    expect(store.get('https://site.test/a')).toBeDefined();
    expect(store.get('https://site.test/b')).toBeUndefined();
  });
});

const HTML = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${body}</p>${body}</article></body></html>`;

const PAGE_LINKS = (links: string[]): string =>
  HTML('Doc', links.map((link) => `<a href="${link}">link</a>`).join(''));

/** HTML page stub: Readability-extractable, one anchor per entry. */
const htmlPage = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

/** A tiny same-origin site: / -> /a -> /b, plus an off-site link, a
 * robots-disallowed path and a cycle back to /. */
const siteFetch = asFetchLike(async (url: string) => {
  if (url === 'https://site.test/robots.txt') {
    return new Response('User-agent: *\nDisallow: /private', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
  if (url === 'https://site.test/' || url === 'https://site.test') {
    return htmlPage(
      PAGE_LINKS(['/a', '/private/secret', 'https://other.test/x', '/a#frag', '/missing']),
    );
  }
  if (url === 'https://site.test/a') return htmlPage(PAGE_LINKS(['/b', '/']));
  if (url === 'https://site.test/b') return htmlPage(PAGE_LINKS([]));
  return new Response('gone', { status: 404 });
});

describe('crawlSite', () => {
  it('crawls same-origin pages breadth-first, capped, cycle-safe', async () => {
    const store = new PageStore();
    const refs = new RefRegistry();
    const response = await crawlSite(config, 'https://site.test/', {
      maxPages: 3,
      fetchImpl: siteFetch,
      refs,
      store,
    });
    expect(response.crawled).toBe(3);
    expect(response.pages.map((page) => page.url)).toEqual([
      'https://site.test/',
      'https://site.test/a',
      'https://site.test/b',
    ]);
    expect(response.pages.every((page) => page.ref > 0)).toBe(true);
    expect(response.pages[0]?.title).toBe('Doc');
    // The /missing 404 and the robots-disallowed /private never appear.
    const urls = response.pages.map((page) => page.url).join();
    expect(urls).not.toContain('missing');
    expect(urls).not.toContain('private');
  });

  it('stores crawled content for later fetch without network', async () => {
    const store = new PageStore();
    const refs = new RefRegistry();
    let pageFetches = 0;
    const countingFetch = asFetchLike(async (url: string) => {
      if (!url.includes('robots.txt')) pageFetches += 1;
      return siteFetch(url);
    });
    const response = await crawlSite(config, 'https://site.test/', {
      maxPages: 2,
      fetchImpl: countingFetch,
      refs,
      store,
    });
    const pageA = response.pages[1];
    expect(pageA?.url).toBe('https://site.test/a');
    const fetchesAfterCrawl = pageFetches;
    const hit = store.get('https://site.test/a');
    expect(hit?.title).toBe('Doc');
    expect(hit?.branch).toBe('markdown');
    // A ref-based fetch of the crawled page serves from the store: no new fetch.
    const { handleFetch } = await import('../src/tools.js');
    const { fetchInput } = await import('../src/schemas.js');
    const result = await handleFetch(config, fetchInput.parse({ url: `ref:${pageA?.ref}` }), {
      fetchImpl: countingFetch,
      refs,
      pages: store,
    });
    expect(result.isError).toBeUndefined();
    expect(pageFetches).toBe(fetchesAfterCrawl);
  });

  it('refuses a robots-disallowed seed', async () => {
    const response = crawlSite(config, 'https://site.test/private/secret', {
      maxPages: 1,
      fetchImpl: siteFetch,
      refs: new RefRegistry(),
      store: new PageStore(),
    });
    await expect(response).rejects.toThrow(/robots/);
  });

  it('crawls on when robots.txt is unreachable (best-effort)', async () => {
    const noRobotsFetch = asFetchLike(async (url: string) => {
      if (url.endsWith('/robots.txt')) throw new Error('ECONNREFUSED');
      return siteFetch(url);
    });
    const response = await crawlSite(config, 'https://site.test/', {
      maxPages: 1,
      fetchImpl: noRobotsFetch,
      refs: new RefRegistry(),
      store: new PageStore(),
    });
    expect(response.crawled).toBe(1);
  });
});

describe('crawlSite input validation and helpers', () => {
  it('rejects an unparsable seed URL', async () => {
    await expect(
      crawlSite(config, 'not-a-url', {
        maxPages: 1,
        fetchImpl: siteFetch,
        refs: new RefRegistry(),
        store: new PageStore(),
      }),
    ).rejects.toThrow(/Invalid seed URL/);
  });

  it('rejects a non-http seed scheme', async () => {
    await expect(
      crawlSite(config, 'ftp://site.test/x', {
        maxPages: 1,
        fetchImpl: siteFetch,
        refs: new RefRegistry(),
        store: new PageStore(),
      }),
    ).rejects.toThrow(/Only http\/https/);
  });

  it('robots policy refuses unparsable URLs', () => {
    expect(parseRobots('').allows('not a url')).toBe(false);
  });

  it('isCrawlResponse shape guard', () => {
    expect(isCrawlResponse({ pages: [] })).toBe(true);
    expect(isCrawlResponse({ pages: 'no' })).toBe(false);
    expect(isCrawlResponse('x')).toBe(false);
  });
});
