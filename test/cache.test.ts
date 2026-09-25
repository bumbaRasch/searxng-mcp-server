import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { cacheKey, cached, TtlCache } from '../src/cache.js';
import type { Config } from '../src/config.js';
import type { FetchLike } from '../src/http.js';
import { createServer } from '../src/server.js';
import { search } from '../src/searxng.js';
import { fetchInput, searchInput } from '../src/schemas.js';
import { handleFetch, handleSearch } from '../src/tools.js';
import { asFetchLike, HTML_PAGE, jsonResponse, makeConfig } from './helpers.js';

describe('TtlCache', () => {
  it('is disabled with a zero ttl or zero capacity', () => {
    expect(new TtlCache<string>(128, 0).enabled).toBe(false);
    expect(new TtlCache<string>(0, 1000).enabled).toBe(false);
    const cache = new TtlCache<string>(128, 0);
    cache.set('k', 'v');
    expect(cache.get('k')).toBeUndefined();
  });

  it('expires entries once the ttl elapses', () => {
    let now = 1000;
    const cache = new TtlCache<string>(128, 500, () => now);
    cache.set('k', 'v');
    now = 1499;
    expect(cache.get('k')).toBe('v');
    now = 1500;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new TtlCache<string>(2, 1000, () => 0);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.get('a')).toBe('1'); // refresh a's recency
    cache.set('c', '3');
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('b')).toBeUndefined();
  });

  it('treats an update as a recency refresh', () => {
    const cache = new TtlCache<string>(2, 1000, () => 0);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '1b');
    cache.set('c', '3'); // evicts b, not the just-updated a
    expect(cache.get('a')).toBe('1b');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });
});

describe('cacheKey', () => {
  it('is invariant under query-param order, host case and default ports', () => {
    expect(cacheKey('GET', 'http://SeArx.Test:80/search?format=json&q=a')).toBe(
      cacheKey('get', 'http://searx.test/search?q=a&format=json'),
    );
  });

  it('differs across methods, paths and params', () => {
    expect(cacheKey('GET', 'http://h.test/search?q=1')).not.toBe(
      cacheKey('POST', 'http://h.test/search?q=1'),
    );
    expect(cacheKey('GET', 'http://h.test/search?q=1')).not.toBe(
      cacheKey('GET', 'http://h.test/config'),
    );
    expect(cacheKey('GET', 'http://h.test/search?q=1')).not.toBe(
      cacheKey('GET', 'http://h.test/search?q=2'),
    );
  });

  it('strips credentials and fragments', () => {
    expect(cacheKey('GET', 'http://u:p@h.test/x#frag')).toBe(cacheKey('GET', 'http://h.test/x'));
  });

  it('degrades to a raw string key for non-URLs', () => {
    expect(cacheKey('GET', 'not a url')).toBe('GET not a url');
  });
});

describe('cached call-site wrapper', () => {
  it('short-circuits on a hit, stores misses and passes through when disabled', async () => {
    let calls = 0;
    const load = async (): Promise<unknown> => ({ n: (calls += 1) });
    const cache = new TtlCache<unknown>(128, 60_000);
    expect(await cached(cache, 'GET', 'http://h.test/x', load)).toEqual({ n: 1 });
    expect(await cached(cache, 'GET', 'http://h.test/x', load)).toEqual({ n: 1 });
    expect(calls).toBe(1);
    expect(await cached(undefined, 'GET', 'http://h.test/x', load)).toEqual({ n: 2 });
  });
});

describe('search response cache (D9)', () => {
  const config = makeConfig();

  it('serves repeat searches from the cache without hitting the instance', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return jsonResponse({
        query: 'q',
        results: [{ title: 'T', url: 'https://t.test', content: 'c' }],
      });
    });
    const cache = new TtlCache<unknown>(128, 60_000);
    const first = await search(config, { query: 'q', maxResults: 10 }, { fetchImpl, cache });
    const second = await search(config, { query: 'q', maxResults: 10 }, { fetchImpl, cache });
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('keeps distinct entries per query and shares one entry across max_results', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return jsonResponse({
        query: 'q',
        results: [
          { title: '1', url: 'https://1.test', content: 'c' },
          { title: '2', url: 'https://2.test', content: 'c' },
        ],
      });
    });
    const cache = new TtlCache<unknown>(128, 60_000);
    await search(config, { query: 'a', maxResults: 10 }, { fetchImpl, cache });
    await search(config, { query: 'b', maxResults: 10 }, { fetchImpl, cache });
    expect(calls).toBe(2);
    // max_results is applied at mapping time, so it is not part of the upstream key
    const one = await search(config, { query: 'a', maxResults: 1 }, { fetchImpl, cache });
    const both = await search(config, { query: 'a', maxResults: 2 }, { fetchImpl, cache });
    expect(calls).toBe(2);
    expect(one.results).toHaveLength(1);
    expect(both.results).toHaveLength(2);
  });

  it('does not interact with the cache when the ttl is 0', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return jsonResponse({ query: 'q', results: [] });
    });
    const cache = new TtlCache<unknown>(128, 0);
    await search(config, { query: 'q', maxResults: 5 }, { fetchImpl, cache });
    await search(config, { query: 'q', maxResults: 5 }, { fetchImpl, cache });
    expect(calls).toBe(2);
    expect(cache.enabled).toBe(false);
  });

  it('caches the failover result for subsequent calls', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async (url: string) => {
      calls += 1;
      if (url.startsWith('http://searx.test:8888')) return new Response('no', { status: 503 });
      return jsonResponse({
        query: 'q',
        results: [{ title: 'B', url: 'https://b.test', content: 'c' }],
      });
    });
    const failoverConfig = makeConfig({
      searxngUrls: ['http://searx.test:8888', 'http://backup.test:8888'],
    });
    const cache = new TtlCache<unknown>(128, 60_000);
    await search(failoverConfig, { query: 'q', maxResults: 5 }, { fetchImpl, cache });
    expect(calls).toBe(2);
    const res = await search(failoverConfig, { query: 'q', maxResults: 5 }, { fetchImpl, cache });
    expect(calls).toBe(2);
    expect(res.results[0]?.title).toBe('B');
  });

  it('does not cache failed attempts', async () => {
    let calls = 0;
    let healthy = false;
    const fetchImpl = asFetchLike(async (url: string) => {
      calls += 1;
      if (!healthy || url.startsWith('http://searx.test:8888')) {
        return new Response('no', { status: 503 });
      }
      return jsonResponse({ query: 'q', results: [] });
    });
    const failoverConfig = makeConfig({
      searxngUrls: ['http://searx.test:8888', 'http://backup.test:8888'],
    });
    const cache = new TtlCache<unknown>(128, 60_000);
    await expect(
      search(failoverConfig, { query: 'q', maxResults: 5 }, { fetchImpl, cache }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(2);
    healthy = true;
    const res = await search(failoverConfig, { query: 'q', maxResults: 5 }, { fetchImpl, cache });
    expect(calls).toBe(4); // retried from scratch: failures are never negatively cached
    expect(res.query).toBe('q');
  });

  it('never caches fetch_content (arbitrary web URLs, not instance-bound)', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return new Response(HTML_PAGE, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const cache = new TtlCache<unknown>(128, 60_000);
    const args = fetchInput.parse({ url: 'https://example.test/doc' });
    const first = await handleFetch(config, args, { fetchImpl, cache });
    const second = await handleFetch(config, args, { fetchImpl, cache });
    expect(calls).toBe(2);
    expect(second.structuredContent).toEqual(first.structuredContent);
  });
});

describe('ToolDeps cache seam', () => {
  it('handleSearch caches instance-bound GETs supplied via deps.cache', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return jsonResponse({
        query: 'q',
        results: [{ title: 'T', url: 'https://t.test', content: 'c' }],
      });
    });
    const cache = new TtlCache<unknown>(128, 60_000);
    const args = searchInput.parse({ query: 'q' });
    await handleSearch(makeConfig(), args, { fetchImpl, cache });
    await handleSearch(makeConfig(), args, { fetchImpl, cache });
    expect(calls).toBe(1);
  });
});

describe('createServer cache wiring', () => {
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

  /** Two search tools/calls over the transport against one server instance. */
  async function searchTwice(config: Config, fetchImpl: FetchLike): Promise<void> {
    const server = createServer(config, { fetchImpl });
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const inbox: JSONRPCMessage[] = [];
    // onmessage is the SDK Transport callback contract, not a DOM event.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onmessage = (message) => inbox.push(message);
    await client.start();
    await client.send(INIT);
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Sequential sends: the second call must observe the first one's cache fill.
    await client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'q' } },
    });
    await vi.waitFor(() => expect(inbox).toHaveLength(2));
    await client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'q' } },
    });
    await vi.waitFor(() => expect(inbox).toHaveLength(3));
    await client.close();
  }

  it('builds the D9 cache from config when a ttl is set', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return jsonResponse({
        query: 'q',
        results: [],
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsiveEngines: [],
      });
    });
    await searchTwice(makeConfig({ cacheTtlMs: 60_000 }), fetchImpl);
    expect(calls).toBe(1);
  });

  it('stays uncached with the default config (byte-identical off path)', async () => {
    let calls = 0;
    const fetchImpl = asFetchLike(async () => {
      calls += 1;
      return jsonResponse({
        query: 'q',
        results: [],
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsiveEngines: [],
      });
    });
    await searchTwice(makeConfig(), fetchImpl);
    expect(calls).toBe(2);
  });
});
