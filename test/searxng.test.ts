import { describe, expect, it } from 'vitest';
import { buildSearchQuery, mapSearchResponse } from '../src/searxng.js';

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
    answers: ['42'],
    infoboxes: [{ id: 'x' }],
    suggestions: ['cats rule'],
    unresponsive_engines: ['kagi'],
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
    expect(res.answers).toEqual(['42']);
    expect(res.suggestions).toEqual(['cats rule']);
    expect(res.unresponsiveEngines).toEqual(['kagi']);
    expect(res.infoboxes).toHaveLength(1);
  });

  it('is defensive about malformed input', () => {
    const res = mapSearchResponse(null, 10);
    expect(res).toEqual({
      query: '',
      results: [],
      answers: [],
      infoboxes: [],
      suggestions: [],
      unresponsiveEngines: [],
    });
  });
});
