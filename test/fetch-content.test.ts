import { describe, expect, it } from 'vitest';
import { fetchContent } from '../src/fetch.js';
import type { FetchLike } from '../src/http.js';
import type { Config } from '../src/config.js';

const config: Config = {
  searxngUrl: 'http://localhost:8888',
  searxngTimeoutMs: 1000,
  fetchTimeoutMs: 1000,
  maxChars: 10_000,
  maxResponseBytes: 100_000,
  userAgent: 'test/1.0',
  allowPrivateHosts: true, // skip DNS in unit tests
};

const PAGE = `<!doctype html><html><head><title>Doc</title></head><body>
  <article><h1>Doc</h1><p>${'word '.repeat(300)}</p></article></body></html>`;

describe('fetchContent', () => {
  it('fetches and returns markdown with metadata', async () => {
    const fetchImpl = (async () => new Response(PAGE, { status: 200 })) as unknown as FetchLike;
    const result = await fetchContent(config, 'https://example.test/doc', { fetchImpl });
    expect(result.finalUrl).toBe('https://example.test/doc');
    expect(result.content.length).toBeGreaterThan(20);
    expect(result.truncated).toBe(false);
  });

  it('follows redirects but stops after the limit', async () => {
    let count = 0;
    const fetchImpl = (async () => {
      count += 1;
      return new Response(null, { status: 302, headers: { location: '/again' } });
    }) as unknown as FetchLike;
    await expect(fetchContent(config, 'https://example.test/start', { fetchImpl })).rejects.toThrow(
      /redirects/i,
    );
    expect(count).toBeGreaterThan(1);
  });

  it('rejects responses larger than the byte cap', async () => {
    const big = 'x'.repeat(200_000);
    const fetchImpl = (async () => new Response(big, { status: 200 })) as unknown as FetchLike;
    await expect(fetchContent(config, 'https://example.test/big', { fetchImpl })).rejects.toThrow(
      /byte limit/i,
    );
  });

  it('surfaces a non-2xx status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as FetchLike;
    await expect(fetchContent(config, 'https://example.test/404', { fetchImpl })).rejects.toThrow(
      /404/,
    );
  });

  it('aborts on timeout', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as FetchLike;
    await expect(
      fetchContent(config, 'https://example.test/slow', { fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow();
  });

  it('rejects an https→http redirect downgrade', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://example.test/x' },
      })) as unknown as FetchLike;
    await expect(
      fetchContent({ ...config, allowPrivateHosts: true }, 'https://example.test/a', { fetchImpl }),
    ).rejects.toThrow(/downgrade/i);
  });

  it('rejects a host that resolves to a private address', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as FetchLike;
    await expect(
      fetchContent({ ...config, allowPrivateHosts: false }, 'https://internal.test/', {
        fetchImpl,
        lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow(/private|reserved/i);
  });
});
