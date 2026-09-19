import { describe, expect, it } from 'vitest';
import { buildSearchQuery, mapSearchResponse, search, SearxngError } from '../src/searxng.js';
import type { Config } from '../src/config.js';
import type { FetchLike } from '../src/http.js';

describe('buildSearchQuery', () => {
  it('always sets q and format=json', () => {
    const qs = buildSearchQuery({ query: 'hello world' });
    expect(qs.get('q')).toBe('hello world');
    expect(qs.get('format')).toBe('json');
  });

  it('joins array params with commas and omits unset params', () => {
    const qs = buildSearchQuery({
      query: 'q',
      categories: ['general', 'news'],
      engines: ['google', 'brave'],
      language: 'de',
      timeRange: 'week',
      pageno: 2,
      safesearch: 1,
    });
    expect(qs.get('categories')).toBe('general,news');
    expect(qs.get('engines')).toBe('google,brave');
    expect(qs.get('language')).toBe('de');
    expect(qs.get('time_range')).toBe('week');
    expect(qs.get('pageno')).toBe('2');
    expect(qs.get('safesearch')).toBe('1');
  });

  it('omits empty arrays', () => {
    const qs = buildSearchQuery({ query: 'q', categories: [], engines: [] });
    expect(qs.has('categories')).toBe(false);
    expect(qs.has('engines')).toBe(false);
  });
});

describe('mapSearchResponse', () => {
  const raw = {
    query: 'cats',
    results: [
      { title: 'A', url: 'https://a.test', content: 'a', engine: 'google', score: 3.2 },
      { title: 'B', url: 'https://b.test', content: 'b', engines: ['brave', 7], category: 'news' },
      { title: 'C', url: 'https://c.test', content: 'c', publishedDate: '2026-01-02' },
    ],
    answers: [{ answer: '42', url: 'https://a.test' }],
    corrections: ['kagi'],
    infoboxes: [{ id: 'x' }],
    suggestions: ['cats rule'],
    unresponsive_engines: [['kagi', 'timeout']],
  };

  it('projects and caps results', () => {
    const res = mapSearchResponse(raw, 2);
    expect(res.query).toBe('cats');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toEqual({
      title: 'A',
      url: 'https://a.test',
      content: 'a',
      engine: 'google',
      score: 3.2,
    });
  });

  it('filters non-string engine entries and reads publishedDate', () => {
    const res = mapSearchResponse(raw, 10);
    expect(res.results[1]?.engines).toEqual(['brave']);
    expect(res.results[1]?.category).toBe('news');
    expect(res.results[2]?.publishedDate).toBe('2026-01-02');
  });

  it('maps answers, suggestions and unresponsive engines', () => {
    const res = mapSearchResponse(raw, 10);
    expect(res.answers).toEqual([{ answer: '42', url: 'https://a.test' }]);
    expect(res.suggestions).toEqual(['cats rule']);
    expect(res.unresponsiveEngines).toEqual([['kagi', 'timeout']]);
    expect(res.corrections).toEqual(['kagi']);
    expect(res.infoboxes).toHaveLength(1);
  });

  it('projects string and object answers, dropping unusable ones', () => {
    const res = mapSearchResponse(
      {
        answers: [
          'plain',
          { content: 'from content', engine: 'google' },
          { answer: 'named', url: 'https://a.test' },
          { nope: true },
          null,
        ],
      },
      10,
    );
    expect(res.answers).toEqual([
      { answer: 'plain' },
      { answer: 'from content', engine: 'google' },
      { answer: 'named', url: 'https://a.test' },
    ]);
  });

  it('projects unresponsive engines as [engine, message] tuples', () => {
    const res = mapSearchResponse(
      { unresponsive_engines: [['kagi', 'timeout'], ['brave'], 'google', 7, []] },
      10,
    );
    expect(res.unresponsiveEngines).toEqual([
      ['kagi', 'timeout'],
      ['brave', ''],
    ]);
  });

  it('caps array fields and truncates result content', () => {
    const res = mapSearchResponse(
      {
        results: [{ title: 'big', url: 'https://big.test', content: 'x'.repeat(2000) }],
        answers: Array.from({ length: 25 }, (_, i) => `a${i}`),
        unresponsive_engines: Array.from({ length: 25 }, (_, i) => [`e${i}`, 'timeout']),
        corrections: Array.from({ length: 25 }, (_, i) => `c${i}`),
        suggestions: Array.from({ length: 25 }, (_, i) => `s${i}`),
        infoboxes: Array.from({ length: 25 }, (_, i) => ({ id: i })),
      },
      10,
    );
    expect(res.answers).toHaveLength(20);
    expect(res.unresponsiveEngines).toHaveLength(20);
    expect(res.corrections).toHaveLength(20);
    expect(res.suggestions).toHaveLength(20);
    expect(res.infoboxes).toHaveLength(20);
    expect(res.results[0]?.content.length).toBeLessThanOrEqual(1000);
    expect(res.results[0]?.content).toHaveLength(1000);
    expect(res.results[0]?.content.endsWith('…')).toBe(true);
  });

  it('is defensive about malformed input', () => {
    const res = mapSearchResponse(null, 10);
    expect(res).toEqual({
      query: '',
      results: [],
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsiveEngines: [],
    });
  });
});

const config: Config = {
  searxngUrl: 'http://searx.test:8888',
  searxngTimeoutMs: 1000,
  fetchTimeoutMs: 1000,
  maxChars: 1000,
  maxResponseBytes: 1000,
  userAgent: 'test/1.0',
  allowPrivateHosts: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('search', () => {
  it('requests the JSON endpoint and maps results', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({
        query: 'q',
        results: [{ title: 'T', url: 'https://t', content: 'c' }],
      });
    }) as unknown as FetchLike;
    const res = await search(config, { query: 'q' }, { fetchImpl });
    expect(calledUrl).toContain('http://searx.test:8888/search?');
    expect(calledUrl).toContain('format=json');
    expect(res.results[0]?.title).toBe('T');
  });

  it('adds a basic-auth header when credentials are configured', async () => {
    let auth: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('authorization');
      return jsonResponse({ results: [] });
    }) as unknown as FetchLike;
    await search(
      { ...config, searxngUsername: 'u', searxngPassword: 'p' },
      { query: 'q' },
      { fetchImpl },
    );
    expect(auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('explains a 403 as a disabled JSON API', async () => {
    const fetchImpl = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as FetchLike;
    await expect(search(config, { query: 'q' }, { fetchImpl })).rejects.toThrow(/search\.formats/);
  });

  it('explains a 400 as bad parameters', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as FetchLike;
    await expect(search(config, { query: 'q' }, { fetchImpl })).rejects.toThrow(/parameters/i);
  });

  it('wraps connection failures with the configured URL', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    await expect(search(config, { query: 'q' }, { fetchImpl })).rejects.toThrow(
      /http:\/\/searx\.test:8888/,
    );
  });

  it('is a SearxngError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as FetchLike;
    await expect(search(config, { query: 'q' }, { fetchImpl })).rejects.toBeInstanceOf(
      SearxngError,
    );
  });

  it('rejects an oversized response body', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(2000), { status: 200 })) as unknown as FetchLike;
    await expect(
      search({ ...config, maxResponseBytes: 100 }, { query: 'q' }, { fetchImpl }),
    ).rejects.toThrow(/byte limit/i);
  });
});
