import { describe, expect, it } from 'vitest';
import {
  imageSearchInput,
  imageSearchOutput,
  newsSearchInput,
  newsSearchOutput,
  toImageSearchParams,
  toNewsSearchParams,
} from '../src/schemas.js';

describe('imageSearchInput', () => {
  it('accepts shared search args and applies the max_results default', () => {
    const parsed = imageSearchInput.parse({ query: 'cats' });
    expect(parsed.max_results).toBe(10);
    expect(parsed.engines).toBeUndefined();
  });
  it('has no time_range field in its shape', () => {
    expect('time_range' in imageSearchInput.shape).toBe(false);
  });
  it('rejects a bad query and out-of-range max_results', () => {
    expect(imageSearchInput.safeParse({ query: '' }).success).toBe(false);
    expect(imageSearchInput.safeParse({ query: 'q', max_results: 51 }).success).toBe(false);
  });
  it('silently strips unknown keys (time_range is ignored, not rejected)', () => {
    const parsed = imageSearchInput.parse({ query: 'q', time_range: 'day' });
    expect(parsed).toEqual({ query: 'q', max_results: 10 });
  });
});

describe('newsSearchInput', () => {
  it('accepts time_range', () => {
    expect(newsSearchInput.safeParse({ query: 'q', time_range: 'week' }).success).toBe(true);
    expect('time_range' in newsSearchInput.shape).toBe(true);
  });
});

describe('toImageSearchParams', () => {
  it('fixes categories to images and maps shared fields', () => {
    const params = toImageSearchParams(
      imageSearchInput.parse({
        query: 'cats',
        language: 'de',
        pageno: 2,
        safesearch: 1,
        engines: ['bing images'],
        max_results: 5,
      }),
    );
    expect(params).toEqual({
      query: 'cats',
      categories: ['images'],
      language: 'de',
      pageno: 2,
      safesearch: 1,
      engines: ['bing images'],
      maxResults: 5,
    });
  });
});

describe('toNewsSearchParams', () => {
  it('fixes categories to news and maps time_range', () => {
    const params = toNewsSearchParams(
      newsSearchInput.parse({ query: 'fedora', time_range: 'week' }),
    );
    expect(params.categories).toEqual(['news']);
    expect(params.timeRange).toBe('week');
  });
});

describe('media output schemas accept their projections', () => {
  it('imageSearchOutput validates a well-formed response', () => {
    const response = {
      query: 'cats',
      results: [
        {
          title: 'Cat',
          url: 'https://page.test/c',
          imgSrc: 'https://img.test/c.png',
          thumbnailSrc: 'https://img.test/t.png',
          resolution: '800×600',
          imgFormat: 'PNG',
          source: 'photo.test',
          engines: ['bing images'],
        },
      ],
      suggestions: ['cats funny'],
      unresponsiveEngines: [['kagi', 'timeout']],
    };
    expect(imageSearchOutput.safeParse(response).success).toBe(true);
    expect(imageSearchOutput.safeParse({ ...response, results: [{ title: 'x' }] }).success).toBe(
      false,
    );
  });
  it('newsSearchOutput validates a well-formed response', () => {
    const response = {
      query: 'fedora',
      results: [
        {
          title: 'Fedora 45',
          url: 'https://theregister.test/x',
          content: 'Beta released',
          publishedDate: '2026-09-16',
          engines: ['bing news'],
        },
      ],
      suggestions: [],
      unresponsiveEngines: [],
    };
    expect(newsSearchOutput.safeParse(response).success).toBe(true);
  });
});
