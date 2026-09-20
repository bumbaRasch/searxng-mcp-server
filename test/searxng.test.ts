import { describe, expect, it, vi } from 'vitest';
import {
  buildSearchParams,
  imageSearch,
  mapImageResponse,
  mapMusicResponse,
  mapNewsResponse,
  mapSearchResponse,
  mapVideoResponse,
  musicSearch,
  newsSearch,
  search,
  SearxngError,
  videoSearch,
} from '../src/searxng.js';
import {
  imageSearchInput,
  imageSearchOutput,
  musicSearchInput,
  musicSearchOutput,
  newsSearchInput,
  newsSearchOutput,
  toImageSearchParams,
  toMusicSearchParams,
  toNewsSearchParams,
  toVideoSearchParams,
  videoSearchInput,
  videoSearchOutput,
  type ImageSearchResponse,
  type MusicSearchResponse,
  type NewsSearchResponse,
  type VideoSearchResponse,
} from '../src/schemas.js';
import { jsonResponse, makeConfig } from './helpers.js';
import type { FetchLike } from '../src/http.js';

describe('buildSearchParams', () => {
  it('always sets q and format=json', () => {
    const qs = buildSearchParams({ query: 'hello world', maxResults: 10 });
    expect(qs.get('q')).toBe('hello world');
    expect(qs.get('format')).toBe('json');
  });

  it('joins array params with commas and omits unset params', () => {
    const qs = buildSearchParams({
      query: 'q',
      maxResults: 10,
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
    const qs = buildSearchParams({ query: 'q', categories: [], engines: [], maxResults: 10 });
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

  it('projects infoboxes: truncates strings, caps urls, drops unusable ones', () => {
    const res = mapSearchResponse(
      {
        infoboxes: [
          {
            infobox: 'Berlin',
            content: 'y'.repeat(2000),
            engine: 'wikipedia',
            urls: Array.from({ length: 15 }, (_, i) => `https://u${i}.test`),
          },
          { id: 'x', urls: ['https://ok.test', 7, null] },
          'junk',
          null,
          {},
        ],
      },
      10,
    );
    expect(res.infoboxes).toHaveLength(2);
    expect(res.infoboxes[0]?.infobox).toBe('Berlin');
    expect(res.infoboxes[0]?.content).toBe(`${'y'.repeat(999)}…`);
    expect(res.infoboxes[0]?.engine).toBe('wikipedia');
    expect(res.infoboxes[0]?.urls).toHaveLength(10);
    expect(res.infoboxes[1]).toEqual({ id: 'x', urls: ['https://ok.test'] });
  });

  it('truncates oversized answers', () => {
    const res = mapSearchResponse(
      { answers: ['a'.repeat(2000), { answer: 'b'.repeat(2000) }] },
      10,
    );
    expect(res.answers[0]?.answer).toBe(`${'a'.repeat(999)}…`);
    expect(res.answers[1]?.answer).toBe(`${'b'.repeat(999)}…`);
  });

  it('caps array fields and truncates result content', () => {
    const res = mapSearchResponse(
      {
        results: [{ title: 'big', url: 'https://big.test', content: 'x'.repeat(2000) }],
        answers: Array.from({ length: 25 }, (_, i) => `a${i}`),
        unresponsive_engines: Array.from({ length: 25 }, (_, i) => [`e${i}`, 'timeout']),
        corrections: Array.from({ length: 25 }, (_, i) => `c${i}`),
        suggestions: Array.from({ length: 25 }, (_, i) => `s${i}`),
        infoboxes: Array.from({ length: 25 }, (_, i) => ({ id: String(i) })),
      },
      10,
    );
    expect(res.answers).toHaveLength(20);
    expect(res.unresponsiveEngines).toHaveLength(20);
    expect(res.corrections).toHaveLength(20);
    expect(res.suggestions).toHaveLength(20);
    expect(res.infoboxes).toHaveLength(20);
    expect(res.infoboxes[0]).toEqual({ id: '0' });
    expect(res.results[0]?.content.length).toBeLessThanOrEqual(1000);
    expect(res.results[0]?.content).toHaveLength(1000);
    expect(res.results[0]?.content.endsWith('…')).toBe(true);
  });

  it('drops web results without a usable URL', () => {
    const mapped = mapSearchResponse(
      {
        query: 'q',
        results: [
          null,
          { title: 'no url' },
          { title: 'ok', url: 'https://r.test/x', content: 'c' },
        ],
      },
      5,
    );
    expect(mapped.results).toHaveLength(1);
    expect(mapped.results[0]?.url).toBe('https://r.test/x');
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

const config = makeConfig({ maxChars: 1000, maxResponseBytes: 1000, allowPrivateHosts: false });

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
    const res = await search(config, { query: 'q', maxResults: 10 }, { fetchImpl });
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
      { query: 'q', maxResults: 10 },
      { fetchImpl },
    );
    expect(auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('sends a username-only basic-auth header', async () => {
    let auth: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('authorization');
      return jsonResponse({ results: [] });
    }) as unknown as FetchLike;
    await search(
      { ...config, searxngUsername: 'u' },
      { query: 'q', maxResults: 10 },
      { fetchImpl },
    );
    expect(auth).toBe(`Basic ${Buffer.from('u:').toString('base64')}`);
  });

  it('never leaks credentials from SEARXNG_URL in error messages', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    const secretConfig = { ...config, searxngUrl: 'http://user:sekret@searx.test:8888' };
    await expect(
      search(secretConfig, { query: 'q', maxResults: 10 }, { fetchImpl }),
    ).rejects.toThrow(/http:\/\/searx\.test:8888/);
    try {
      await search(secretConfig, { query: 'q', maxResults: 10 }, { fetchImpl });
    } catch (error) {
      expect((error as Error).message).not.toContain('sekret');
    }
  });

  it('explains a 403 as a disabled JSON API', async () => {
    const fetchImpl = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as FetchLike;
    await expect(search(config, { query: 'q', maxResults: 10 }, { fetchImpl })).rejects.toThrow(
      /search\.formats/,
    );
  });

  it('explains a 400 as bad parameters', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as FetchLike;
    await expect(search(config, { query: 'q', maxResults: 10 }, { fetchImpl })).rejects.toThrow(
      /parameters/i,
    );
  });

  it('wraps connection failures with the configured URL', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    await expect(search(config, { query: 'q', maxResults: 10 }, { fetchImpl })).rejects.toThrow(
      /http:\/\/searx\.test:8888/,
    );
  });

  it('is a SearxngError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as FetchLike;
    await expect(
      search(config, { query: 'q', maxResults: 10 }, { fetchImpl }),
    ).rejects.toBeInstanceOf(SearxngError);
  });

  it('rejects an oversized response body', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(2000), { status: 200 })) as unknown as FetchLike;
    await expect(
      search({ ...config, maxResponseBytes: 100 }, { query: 'q', maxResults: 10 }, { fetchImpl }),
    ).rejects.toThrow(/byte limit/i);
  });

  it('reports a non-JSON body', async () => {
    const fetchImpl = (async () =>
      new Response('<html>nope</html>', { status: 200 })) as unknown as FetchLike;
    await expect(search(config, { query: 'q', maxResults: 10 }, { fetchImpl })).rejects.toThrow(
      /non-JSON/i,
    );
  });

  it('aborts a stalled response body via the timeout', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('aborted'));
          });
        },
      });
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: stream,
        text: async () => '',
      });
    }) as unknown as FetchLike;
    await expect(
      search({ ...config, searxngTimeoutMs: 10 }, { query: 'q', maxResults: 10 }, { fetchImpl }),
    ).rejects.toBeInstanceOf(SearxngError);
  });
});

describe('mapImageResponse', () => {
  const raw = {
    query: 'cats',
    results: [
      {
        title: 'A cat',
        url: 'https://page.test/a',
        img_src: 'https://img.test/a.png',
        thumbnail_src: 'https://img.test/t.png',
        resolution: '800×600',
        img_format: 'PNG',
        source: 'photo.test',
        engines: ['bing images', 'duckduckgo images'],
      },
      { title: 'No image', url: 'https://page.test/b' }, // no img_src -> result dropped
      { title: 'Garbage', img_src: 123, url: 'https://page.test/c' }, // non-string img_src -> dropped
      {
        title: 'x'.repeat(600),
        url: 'https://page.test/d',
        img_src: 'https://img.test/d.png',
        thumbnail: 'https://img.test/dt.png', // fallback: thumbnail when thumbnail_src is absent
      },
    ],
    suggestions: ['funny cats'],
    unresponsive_engines: [['kagi', 'timeout']],
  };

  it('projects valid results, drops results without a usable img_src', () => {
    const res = mapImageResponse(raw, 10);
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toEqual({
      title: 'A cat',
      url: 'https://page.test/a',
      imgSrc: 'https://img.test/a.png',
      thumbnailSrc: 'https://img.test/t.png',
      resolution: '800×600',
      imgFormat: 'PNG',
      source: 'photo.test',
      engines: ['bing images', 'duckduckgo images'],
    });
    expect(res.results[1]?.thumbnailSrc).toBe('https://img.test/dt.png');
    expect(res.results[1]?.title).toHaveLength(500);
    expect(res.suggestions).toEqual(['funny cats']);
    expect(res.unresponsiveEngines).toEqual([['kagi', 'timeout']]);
  });

  it('slices results to maxResults and matches its output schema', () => {
    const full = mapImageResponse(raw, 10);
    expect(mapImageResponse(raw, 1).results).toHaveLength(1);
    expect(imageSearchOutput.safeParse(full).success).toBe(true);
  });
});

describe('engines array caps', () => {
  const manyEngines = Array.from({ length: 25 }, (_, i) => `engine-${i}`);
  const base = { query: 'q', suggestions: [], unresponsive_engines: [] };

  it('caps engines at 20 in every projection', () => {
    const web = mapSearchResponse(
      { ...base, results: [{ title: 't', url: 'u', content: 'c', engines: manyEngines }] },
      10,
    );
    expect(web.results[0]?.engines).toHaveLength(20);
    const image = mapImageResponse(
      { ...base, results: [{ title: 't', url: 'u', img_src: 'i', engines: manyEngines }] },
      10,
    );
    expect(image.results[0]?.engines).toHaveLength(20);
    const news = mapNewsResponse(
      { ...base, results: [{ title: 't', url: 'u', content: 'c', engines: manyEngines }] },
      10,
    );
    expect(news.results[0]?.engines).toHaveLength(20);
  });
});

describe('mapNewsResponse', () => {
  const raw = {
    query: 'fedora',
    results: [
      {
        title: 'Fedora 45 beta',
        url: 'https://t.test/1',
        content: 'c'.repeat(2000),
        publishedDate: '2026-09-16',
        engines: ['bing news'],
      },
      { title: 'No date', url: 'https://t.test/2', content: 'ok' },
      { title: 'Bad date', url: 'https://t.test/3', content: 'ok', publishedDate: 42 },
    ],
    suggestions: [],
    unresponsive_engines: [],
  };

  it('projects, truncates content to 1000, keeps publishedDate only for strings', () => {
    const res: NewsSearchResponse = mapNewsResponse(raw, 10);
    expect(res.results).toHaveLength(3);
    expect(res.results[0]?.content).toHaveLength(1000);
    expect(res.results[0]?.publishedDate).toBe('2026-09-16');
    expect(res.results[1]?.publishedDate).toBeUndefined();
    expect(res.results[2]?.publishedDate).toBeUndefined();
    expect(newsSearchOutput.safeParse(res).success).toBe(true);
  });
});

describe('imageSearch/newsSearch clients', () => {
  it('request the images/news categories and map the response', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return jsonResponse({
        query: 'cats',
        results: [{ title: 'Cat', url: 'https://p.test/c', img_src: 'https://i.test/c.png' }],
      });
    }) as unknown as FetchLike;
    const res: ImageSearchResponse = await imageSearch(
      config,
      toImageSearchParams(imageSearchInput.parse({ query: 'cats' })),
      { fetchImpl },
    );
    expect(seen[0]).toContain('categories=images');
    expect(res.results[0]?.imgSrc).toBe('https://i.test/c.png');

    const newsRes = await newsSearch(
      config,
      toNewsSearchParams(newsSearchInput.parse({ query: 'cats' })),
      {
        fetchImpl,
      },
    );
    expect(seen[1]).toContain('categories=news');
    expect(newsRes.results[0]?.title).toBe('Cat');
  });

  it('slices by max_results', async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        query: 'cats',
        results: [
          { title: '1', url: 'u1', img_src: 'i1' },
          { title: '2', url: 'u2', img_src: 'i2' },
        ],
      })) as unknown as FetchLike;
    const res = await imageSearch(
      config,
      toImageSearchParams(imageSearchInput.parse({ query: 'q', max_results: 1 })),
      {
        fetchImpl,
      },
    );
    expect(res.results).toHaveLength(1);
  });
});

describe("publishedDate 'None' quirk is filtered everywhere", () => {
  it('drops the string "None" and empty dates in all four projections', () => {
    const row = { title: 't', url: 'u', content: 'c', publishedDate: 'None' };
    expect(
      mapSearchResponse({ query: 'q', results: [row] }, 10).results[0]?.publishedDate,
    ).toBeUndefined();
    expect(
      mapNewsResponse({ query: 'q', results: [{ ...row, publishedDate: '  ' }] }, 10).results[0]
        ?.publishedDate,
    ).toBeUndefined();
    expect(
      mapVideoResponse(
        { query: 'q', results: [{ ...row, url: 'https://v', publishedDate: 'None' }] },
        10,
      ).results[0]?.publishedDate,
    ).toBeUndefined();
    expect(
      mapMusicResponse(
        { query: 'q', results: [{ ...row, url: 'https://m', publishedDate: 'None' }] },
        10,
      ).results[0]?.publishedDate,
    ).toBeUndefined();
    // real dates survive
    expect(
      mapVideoResponse(
        { query: 'q', results: [{ ...row, url: 'https://v', publishedDate: '2025-07-16' }] },
        10,
      ).results[0]?.publishedDate,
    ).toBe('2025-07-16');
  });
});

describe('normalizeDuration behavior via mapVideoResponse/mapMusicResponse', () => {
  const base = { query: 'q', suggestions: [], unresponsive_engines: [] };

  it('keeps display strings and converts numeric seconds', () => {
    const res = mapVideoResponse(
      {
        ...base,
        results: [
          { title: 'a', url: 'https://a', length: '14:54' },
          { title: 'b', url: 'https://b', length: 894 }, // 14:54
          { title: 'c', url: 'https://c', length: 3661 }, // 1:01:01
          { title: 'd', url: 'https://d', length: 0 },
          { title: 'e', url: 'https://e', length: 'not-a-number-but-string' },
          { title: 'f', url: 'https://f', length: 0.4 },
        ],
      },
      10,
    );
    expect(res.results.map((r) => r.length)).toEqual([
      '14:54',
      '14:54',
      '1:01:01',
      undefined,
      'not-a-number-but-string',
      undefined,
    ]);
  });

  it('drops non-positive/NaN/Infinite lengths and rounds floats to seconds', () => {
    const res = mapVideoResponse(
      {
        ...base,
        results: [
          { title: 'a', url: 'https://a', length: -5 },
          { title: 'b', url: 'https://b', length: Number.NaN },
          { title: 'c', url: 'https://c', length: Number.POSITIVE_INFINITY },
          { title: 'd', url: 'https://d', length: 894.6 }, // rounds to 895 -> 14:55
        ],
      },
      10,
    );
    expect(res.results.map((r) => r.length)).toEqual([undefined, undefined, undefined, '14:55']);
  });

  it('music keeps results without audioSrc (soft mode) and maps audioSrc when present', () => {
    const res = mapMusicResponse(
      {
        ...base,
        results: [
          { title: 'radio', url: 'https://r' }, // no audio_src -> kept
          { title: 'file', url: 'https://f', audio_src: 'https://f.ogg' },
          { title: 'bad', url: 'https://x', audio_src: 42 },
        ],
      },
      10,
    );
    expect(res.results).toHaveLength(3);
    expect(res.results[0]?.audioSrc).toBeUndefined();
    expect(res.results[1]?.audioSrc).toBe('https://f.ogg');
    expect(res.results[2]?.audioSrc).toBeUndefined();
    expect(musicSearchOutput.safeParse(res).success).toBe(true);
  });
});

describe('videoSearch/musicSearch clients', () => {
  it('request videos/music categories, map time_range, slice by max_results', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return jsonResponse({
        query: 'q',
        results: [
          { title: '1', url: 'https://1', length: '1:00' },
          { title: '2', url: 'https://2' },
        ],
      });
    }) as unknown as FetchLike;
    const video: VideoSearchResponse = await videoSearch(
      config,
      toVideoSearchParams(
        videoSearchInput.parse({ query: 'q', time_range: 'month', max_results: 1 }),
      ),
      { fetchImpl },
    );
    expect(seen[0]).toContain('categories=videos');
    expect(seen[0]).toContain('time_range=month');
    expect(video.results).toHaveLength(1);
    expect(videoSearchOutput.safeParse(video).success).toBe(true);

    const music: MusicSearchResponse = await musicSearch(
      config,
      toMusicSearchParams(musicSearchInput.parse({ query: 'q', maxResults: 10 })),
      {
        fetchImpl,
      },
    );
    expect(seen[1]).toContain('categories=music');
    expect(music.results[0]?.title).toBe('1');
  });
});

describe('mapCategoryResponse limit semantics', () => {
  const good = { title: 't', url: 'https://r.test/x', img_src: 'https://img.test/x.png' };
  const raw = { query: 'q', results: [null, good, good, good] }; // garbage first

  it('image: garbage consumes no maxResults budget', () => {
    expect(mapImageResponse(raw, 2).results).toHaveLength(2); // already filter-first
  });

  it('news: after unification, garbage consumes no budget either', () => {
    const results = mapNewsResponse(raw, 2).results;
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.url !== '')).toBe(true);
  });
});

describe('fetchSearchJson robustness', () => {
  const params = { query: 'test', maxResults: 5 };

  it('refuses redirect responses with an actionable message', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://elsewhere.test/' },
      })) as unknown as FetchLike;
    await expect(search(config, params, { fetchImpl })).rejects.toThrow(/redirect/i);
  });

  it('reports timeouts as timeouts, not unreachability', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as unknown as FetchLike;
    await expect(
      search({ ...config, searxngTimeoutMs: 10 }, params, { fetchImpl }),
    ).rejects.toThrow(/timed out after 10 ms/i);
  });

  it('cancels the body of non-2xx responses', async () => {
    const response = new Response('boom', { status: 500 });
    const cancel = response.body ? vi.spyOn(response.body, 'cancel') : undefined;
    const fetchImpl = (async () => response) as unknown as FetchLike;
    await expect(search(config, params, { fetchImpl })).rejects.toThrow(/500/);
    expect(cancel).toHaveBeenCalled();
  });

  it('hints at the limiter on 429', async () => {
    const fetchImpl = (async () =>
      new Response('slow down', { status: 429 })) as unknown as FetchLike;
    await expect(search(config, params, { fetchImpl })).rejects.toThrow(
      /429.*limiter|limiter.*429/is,
    );
  });
});
