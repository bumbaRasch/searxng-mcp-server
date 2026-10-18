import { describe, expect, it, vi } from 'vitest';
import { deepSearch, DeepSearchCancelled } from '../src/deep-search.js';
import { RefRegistry } from '../src/refs.js';
import { asFetchLike, jsonResponse, makeConfig, HTML_PAGE } from './helpers.js';

const config = makeConfig();

const SEARCH_RESULTS = {
  query: 'rust async',
  results: [
    { title: 'Rust async deep dive', url: 'https://r.test/1', content: 'c', score: 5 },
    { title: 'unrelated', url: 'https://r.test/2', content: 'c', score: 1 },
  ],
};

function siteFetch(body: {
  synthesis?: unknown;
  synthesisStatus?: number;
}): ReturnType<typeof asFetchLike> {
  return asFetchLike(async (url: string) => {
    if (url.includes('/search?')) {
      const pageno = Number(new URL(url).searchParams.get('pageno') ?? '1');
      return jsonResponse(pageno === 1 ? SEARCH_RESULTS : { query: 'q', results: [] });
    }
    if (url.startsWith('https://synth.test/')) {
      return typeof body.synthesis === 'number'
        ? new Response('nope', { status: body.synthesis })
        : jsonResponse(body.synthesis ?? {});
    }
    return new Response(HTML_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  });
}

describe('deepSearch', () => {
  it('iterates, dedupes sources and builds a cited dossier', async () => {
    const dossier = await deepSearch(config, 'rust async', {
      maxIterations: 2,
      sourcesPerIteration: 2,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: siteFetch({}),
    });
    expect(dossier.iterations).toBe(2);
    expect(dossier.sources.map((source) => source.ref).toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(dossier.notes).toHaveLength(2);
    expect(dossier.notes.every((note) => note.excerpt.length > 0)).toBe(true);
    // Iteration 2 found nothing uncited: no synthesis configured → note only.
    expect(dossier.synthesis).toBeUndefined();
    expect(dossier.synthesisNote).toMatch(/No synthesis endpoint configured/);
  });

  it('synthesizes over the configured endpoint', async () => {
    const synthesisConfig = makeConfig({
      synthesisUrl: 'https://synth.test/v1/chat/completions',
      synthesisModel: 'test-model',
    });
    const dossier = await deepSearch(synthesisConfig, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: siteFetch({
        synthesis: { choices: [{ message: { content: 'Synthesis with [1] citation' } }] },
      }),
    });
    expect(dossier.synthesis).toContain('[1]');
    expect(dossier.synthesisNote).toBeUndefined();
  });

  it('reads Ollama-native chat responses too', async () => {
    const synthesisConfig = makeConfig({ synthesisUrl: 'https://synth.test/api/chat' });
    const dossier = await deepSearch(synthesisConfig, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: siteFetch({ synthesis: { message: { content: 'Ollama says hi' } } }),
    });
    expect(dossier.synthesis).toBe('Ollama says hi');
  });

  it('degrades to dossier-only when synthesis fails', async () => {
    const synthesisConfig = makeConfig({ synthesisUrl: 'https://synth.test/v1/chat/completions' });
    const dossier = await deepSearch(synthesisConfig, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: siteFetch({ synthesis: 500 }),
    });
    expect(dossier.synthesis).toBeUndefined();
    expect(dossier.synthesisNote).toMatch(/HTTP 500/);
  });

  it('degrades to dossier-only when synthesis returns no content', async () => {
    const synthesisConfig = makeConfig({ synthesisUrl: 'https://synth.test/v1/chat/completions' });
    const dossier = await deepSearch(synthesisConfig, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: siteFetch({ synthesis: { choices: [{ message: { content: '' } }] } }),
    });
    expect(dossier.synthesis).toBeUndefined();
    expect(dossier.synthesisNote).toMatch(/no message content/);
  });

  it('throws DeepSearchCancelled when the signal fires', async () => {
    const controller = new AbortController();
    controller.abort();
    const dossier = deepSearch(config, 'rust async', {
      maxIterations: 2,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: siteFetch({}),
      signal: controller.signal,
    });
    await expect(dossier).rejects.toThrow(/cancelled/i);
  });

  it('never pings the synthesis endpoint when the signal is already aborted', async () => {
    const synthesisConfig = makeConfig({
      synthesisUrl: 'https://synth.test/v1/chat/completions',
    });
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(
      siteFetch({ synthesis: { choices: [{ message: { content: 'no' } }] } }),
    );
    const dossier = deepSearch(synthesisConfig, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: asFetchLike(fetchImpl),
      signal: controller.signal,
    });
    await expect(dossier).rejects.toThrow(DeepSearchCancelled);
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it('propagates task cancellation into the in-flight synthesis request', async () => {
    const synthesisConfig = makeConfig({
      synthesisUrl: 'https://synth.test/v1/chat/completions',
    });
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = asFetchLike(async (url: string, init?: RequestInit) => {
      calls += 1;
      if (url.includes('/search?')) return jsonResponse(SEARCH_RESULTS);
      if (url.startsWith('https://r.test/')) {
        return new Response(HTML_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      // Synthesis endpoint: hold the POST open until its own signal aborts.
      return new Promise((resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    const dossier = deepSearch(synthesisConfig, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl,
      signal: controller.signal,
    });
    // Wait until the synthesis POST is in flight (search + page + synthesis).
    await vi.waitFor(() => expect(calls).toBe(3));
    controller.abort();
    const result = await dossier;
    expect(result.synthesis).toBeUndefined();
    expect(result.synthesisNote).toMatch(/Synthesis failed/);
  });
});

describe('deepSearch failure degradation', () => {
  it('stops early when a later iteration exhausts the instance (SearxngError)', async () => {
    const flakyFetch = asFetchLike(async (url: string) => {
      if (url.includes('/search?')) {
        const pageno = Number(new URL(url).searchParams.get('pageno') ?? '1');
        if (pageno > 1) return jsonResponse({}, 500);
        return jsonResponse(SEARCH_RESULTS);
      }
      return new Response(HTML_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const dossier = await deepSearch(config, 'rust async', {
      maxIterations: 2,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: flakyFetch,
    });
    expect(dossier.iterations).toBe(1);
  });

  it('records unreadable sources as notes instead of failing', async () => {
    const halfBrokenFetch = asFetchLike(async (url: string) => {
      if (url.includes('/search?')) return jsonResponse(SEARCH_RESULTS);
      throw new Error('connection reset');
    });
    const dossier = await deepSearch(config, 'rust async', {
      maxIterations: 1,
      sourcesPerIteration: 1,
      maxResults: 10,
      refs: new RefRegistry(),
      fetchImpl: halfBrokenFetch,
    });
    expect(dossier.notes).toHaveLength(1);
    expect(dossier.notes[0]?.excerpt).toMatch(/Unreadable \(connection reset\)/);
  });
});
