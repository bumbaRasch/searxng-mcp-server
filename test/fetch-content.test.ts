import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fetchContent, FetchError, MAX_REDIRECTS } from '../src/fetch.js';
import type { FetchLike } from '../src/http.js';
import type { LookupAll } from '../src/ssrf.js';
import { asFetchLike, HTML_PAGE, makeConfig } from './helpers.js';

// Flag-gated unpdf mock: 'real' passes through; the other modes force the
// defensive paths in src/pdf.ts that a healthy PDF never exercises.
const unpdfMock = vi.hoisted(() => ({ mode: 'real' }));
vi.mock('unpdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return {
    ...actual,
    getMeta: ((pdf: Parameters<typeof actual.getMeta>[0]) => {
      if (unpdfMock.mode === 'meta-failure') return Promise.reject(new Error('xref gone'));
      if (unpdfMock.mode === 'meta-empty') return Promise.resolve({ info: {}, metadata: {} });
      if (unpdfMock.mode === 'meta-blank')
        return Promise.resolve({ info: { Title: '   ' }, metadata: {} });
      return actual.getMeta(pdf);
    }) as typeof actual.getMeta,
    extractText: ((pdf: Parameters<typeof actual.extractText>[0]) => {
      if (unpdfMock.mode === 'merged-text')
        return Promise.resolve({ totalPages: 2, text: 'merged text from unpdf' });
      return actual.extractText(pdf, { mergePages: false });
    }) as typeof actual.extractText,
  };
});

const config = makeConfig({ searxngUrl: 'http://localhost:8888' });

/** Two-page fixture with /Title "Sample PDF Fixture" (see test/fixtures). */
const PDF_BYTES = new Uint8Array(readFileSync(new URL('./fixtures/sample.pdf', import.meta.url)));

describe('fetchContent', () => {
  it('fetches and returns markdown with metadata', async () => {
    const fetchImpl = asFetchLike(async () => new Response(HTML_PAGE, { status: 200 }));
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
    expect(count).toBe(MAX_REDIRECTS + 1);
  });

  it('rejects responses larger than the byte cap', async () => {
    const big = 'x'.repeat(200_000);
    const fetchImpl = asFetchLike(async () => new Response(big, { status: 200 }));
    await expect(fetchContent(config, 'https://example.test/big', { fetchImpl })).rejects.toThrow(
      /byte limit/i,
    );
  });

  it('surfaces a non-2xx status', async () => {
    const fetchImpl = asFetchLike(async () => new Response('nope', { status: 404 }));
    await expect(fetchContent(config, 'https://example.test/404', { fetchImpl })).rejects.toThrow(
      /404/,
    );
  });

  it('rejects HTTP failures as FetchError instances', async () => {
    const fetchImpl = asFetchLike(async () => new Response('nope', { status: 404 }));
    const rejection = await fetchContent(config, 'https://example.test/404', {
      fetchImpl,
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(FetchError);
    expect((rejection as FetchError).name).toBe('FetchError');
  });

  it('aborts on timeout', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as FetchLike;
    await expect(
      fetchContent(config, 'https://example.test/slow', { fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out after 5 ms/i);
  });

  it('rejects an https→http redirect downgrade', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://example.test/x' },
        }),
    );
    await expect(
      fetchContent({ ...config, allowPrivateHosts: true }, 'https://example.test/a', { fetchImpl }),
    ).rejects.toThrow(/downgrade/i);
  });

  it('rejects a host that resolves to a private address', async () => {
    const fetchImpl = asFetchLike(async () => new Response('', { status: 200 }));
    await expect(
      fetchContent({ ...config, allowPrivateHosts: false }, 'https://internal.test/', {
        fetchImpl,
        lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('re-validates DNS on every redirect hop', async () => {
    const lookedUp: string[] = [];
    const lookup = async (hostname: string) => {
      lookedUp.push(hostname);
      return hostname === 'evil.test'
        ? [{ address: '10.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    };
    const fetchImpl = asFetchLike(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.test/x' },
        }),
    );
    await expect(
      fetchContent({ ...config, allowPrivateHosts: false }, 'https://public.test/start', {
        fetchImpl,
        lookup,
      }),
    ).rejects.toThrow(/private|reserved/i);
    expect(lookedUp).toContain('public.test');
    expect(lookedUp).toContain('evil.test');
  });

  it('rejects a redirect whose target embeds credentials', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://u:p@evil.test/x' },
        }),
    );
    await expect(fetchContent(config, 'https://example.test/a', { fetchImpl })).rejects.toThrow(
      /credentials/i,
    );
  });

  it('rejects a redirect without a Location header', async () => {
    const fetchImpl = asFetchLike(async () => new Response(null, { status: 302 }));
    await expect(fetchContent(config, 'https://example.test/a', { fetchImpl })).rejects.toThrow(
      /without a Location/i,
    );
  });
});

describe('Content-Type gate', () => {
  it('rejects binary content types', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response('\x00\x01', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );
    await expect(fetchContent(config, 'https://example.test/bin', { fetchImpl })).rejects.toThrow(
      /Content-Type/i,
    );
  });

  it('allows textual content types', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(HTML_PAGE, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await fetchContent(config, 'https://example.test/json', { fetchImpl });
    expect(result.truncated).toBe(false);
  });

  it('allows mixed-case content type headers', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(HTML_PAGE, {
          status: 200,
          headers: { 'content-type': 'Text/Html' },
        }),
    );
    const result = await fetchContent(config, 'https://example.test/case', { fetchImpl });
    expect(result.truncated).toBe(false);
  });

  it('allows feed content types', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(HTML_PAGE, {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        }),
    );
    const result = await fetchContent(config, 'https://example.test/feed', { fetchImpl });
    expect(result.truncated).toBe(false);
  });

  it('rejects prefix over-matches like application/xml-dtd', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response('x', { status: 200, headers: { 'content-type': 'application/xml-dtd' } }),
    );
    await expect(fetchContent(config, 'https://example.test/dtd', { fetchImpl })).rejects.toThrow(
      /Content-Type/i,
    );
  });

  it('rejects application/jsonp', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response('x', { status: 200, headers: { 'content-type': 'application/jsonp' } }),
    );
    await expect(fetchContent(config, 'https://example.test/jsonp', { fetchImpl })).rejects.toThrow(
      /Content-Type/i,
    );
  });

  it('allows feed types with parameters', async () => {
    const fetchImpl = asFetchLike(
      async () =>
        new Response(HTML_PAGE, {
          status: 200,
          headers: { 'content-type': 'application/atom+xml;type=feed' },
        }),
    );
    const result = await fetchContent(config, 'https://example.test/feed', { fetchImpl });
    expect(result.truncated).toBe(false);
  });
});

describe('fetch init contract', () => {
  it('sends every request with redirect: manual, a guarded dispatcher and a UA', async () => {
    const inits: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init?: Record<string, unknown>) => {
      inits.push(init ?? {});
      return new Response(HTML_PAGE, { status: 200 });
    }) as unknown as FetchLike;
    await fetchContent(config, 'https://example.test/doc', { fetchImpl });
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) {
      expect(init.redirect).toBe('manual');
      expect(init.dispatcher).toBeDefined();
      expect((init.headers as Record<string, string>)['User-Agent']).toBeTruthy();
    }
  });
});

describe('DNS rebinding (TOCTOU)', () => {
  it('blocks when the pre-check resolves public but connect-time resolves private', async () => {
    let calls = 0;
    const lookup: LookupAll = async () => {
      calls += 1;
      return [{ address: calls === 1 ? '93.184.216.34' : '10.0.0.1', family: 4 }];
    };
    const error = await fetchContent(
      { ...config, allowPrivateHosts: false },
      'http://rebind.test/',
      { lookup },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    expect(messages.join('\n')).toMatch(/blocked private address for rebind\.test: 10\.0\.0\.1/i);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('PDF content', () => {
  function pdfFetch(contentType = 'application/pdf'): FetchLike {
    return asFetchLike(
      async () =>
        new Response(PDF_BYTES, {
          status: 200,
          headers: { 'content-type': contentType },
        }),
    );
  }

  it('extracts per-page text, page count and metadata title', async () => {
    const result = await fetchContent(config, 'https://example.test/doc.pdf', {
      fetchImpl: pdfFetch(),
    });
    expect(result.pages).toBe(2);
    expect(result.content).toContain('[Page 1]');
    expect(result.content).toContain('[Page 2]');
    expect(result.content).toContain('Hello from page one.');
    expect(result.content).toContain('Second page text.');
    expect(result.title).toBe('Sample PDF Fixture');
    expect(result.truncated).toBe(false);
  });

  it('applies the truncation marker below max_chars', async () => {
    const result = await fetchContent(config, 'https://example.test/doc.pdf', {
      fetchImpl: pdfFetch(),
      maxChars: 40,
    });
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[Page 1]');
    expect(result.content).toContain('[Content truncated]');
  });

  it('rejects a PDF body larger than the byte cap', async () => {
    const oversize = new Uint8Array(150_000);
    const fetchImpl = asFetchLike(
      async () =>
        new Response(oversize, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
    );
    await expect(
      fetchContent(config, 'https://example.test/big.pdf', { fetchImpl }),
    ).rejects.toThrow(/byte limit/i);
  });

  it('reports corrupt PDF bytes as a sanitized FetchError, not a crash', async () => {
    const corrupt = new Uint8Array(Buffer.from('this is definitely not a pdf at all'));
    const fetchImpl = asFetchLike(
      async () =>
        new Response(corrupt, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
    );
    const error = await fetchContent(config, 'https://example.test/corrupt.pdf', {
      fetchImpl,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).name).toBe('FetchError');
    expect((error as FetchError).message).toMatch(/Failed to parse PDF/i);
    expect((error as FetchError).message).not.toMatch(/Exception/);
  });

  it('accepts application/pdf with parameters and rejects prefix over-matches', async () => {
    const ok = await fetchContent(config, 'https://example.test/doc.pdf', {
      fetchImpl: pdfFetch('application/pdf;x=1'),
    });
    expect(ok.pages).toBe(2);
    const fetchImpl = asFetchLike(
      async () =>
        new Response('x', { status: 200, headers: { 'content-type': 'application/pdfx' } }),
    );
    await expect(
      fetchContent(config, 'https://example.test/doc.pdfx', { fetchImpl }),
    ).rejects.toThrow(/Content-Type/i);
  });

  it('rejects PDF responses without a readable body stream', async () => {
    const bodyless = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      body: null,
      text: async () => '',
    };
    const fetchImpl = asFetchLike(async () => bodyless);
    await expect(
      fetchContent(config, 'https://example.test/empty.pdf', { fetchImpl }),
    ).rejects.toThrow(/no readable body/i);
  });

  it('tolerates metadata failures, blank titles and merged text defensively', async () => {
    unpdfMock.mode = 'meta-failure';
    const metaFailed = await fetchContent(config, 'https://example.test/doc.pdf', {
      fetchImpl: pdfFetch(),
    });
    expect(metaFailed.pages).toBe(2);
    expect(metaFailed.title).toBeUndefined();

    unpdfMock.mode = 'meta-empty';
    expect(
      (await fetchContent(config, 'https://example.test/doc.pdf', { fetchImpl: pdfFetch() })).title,
    ).toBeUndefined();
    unpdfMock.mode = 'meta-blank';
    expect(
      (await fetchContent(config, 'https://example.test/doc.pdf', { fetchImpl: pdfFetch() })).title,
    ).toBeUndefined();

    unpdfMock.mode = 'merged-text';
    const merged = await fetchContent(config, 'https://example.test/doc.pdf', {
      fetchImpl: pdfFetch(),
    });
    expect(merged.pages).toBe(2);
    expect(merged.content).toContain('[Page 1]');
    expect(merged.content).toContain('merged text from unpdf');
    unpdfMock.mode = 'real';
  });
});
