import { describe, expect, it } from 'vitest';
import {
  imageSearchInput,
  imageSearchOutput,
  musicSearchInput,
  musicSearchOutput,
  newsSearchInput,
  newsSearchOutput,
  searchInput,
  toImageSearchParams,
  toMusicSearchParams,
  toNewsSearchParams,
  toSearchParams,
  toVideoSearchParams,
  videoSearchInput,
  videoSearchOutput,
} from '../src/schemas.js';

describe('searchInput / toSearchParams', () => {
  it('maps categories and time_range through to search params', () => {
    const params = toSearchParams(
      searchInput.parse({ query: 'q', categories: ['news'], time_range: 'day' }),
    );
    expect(params.categories).toEqual(['news']);
    expect(params.timeRange).toBe('day');
  });

  it('rejects max_results: 0', () => {
    expect(searchInput.safeParse({ query: 'q', max_results: 0 }).success).toBe(false);
  });

  it('rejects a 501-character query', () => {
    expect(searchInput.safeParse({ query: 'q'.repeat(501) }).success).toBe(false);
  });

  it('rejects a 1-character language code', () => {
    expect(searchInput.safeParse({ query: 'q', language: 'x' }).success).toBe(false);
  });
});

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

describe('videoSearchInput', () => {
  it('accepts shared args + time_range and applies the default', () => {
    const parsed = videoSearchInput.parse({ query: 'fedora review', time_range: 'month' });
    expect(parsed.max_results).toBe(10);
    expect(parsed.time_range).toBe('month');
    expect('time_range' in videoSearchInput.shape).toBe(true);
  });
});

describe('musicSearchInput', () => {
  it('has no time_range field and strips it if sent', () => {
    expect('time_range' in musicSearchInput.shape).toBe(false);
    const parsed = musicSearchInput.parse({ query: 'nirvana', time_range: 'day' });
    expect(parsed).toEqual({ query: 'nirvana', max_results: 10 });
  });
});

describe('toVideoSearchParams / toMusicSearchParams', () => {
  it('fix categories and map fields (video carries time_range)', () => {
    const video = toVideoSearchParams(
      videoSearchInput.parse({ query: 'q', time_range: 'week', language: 'de', max_results: 5 }),
    );
    expect(video).toEqual({
      query: 'q',
      categories: ['videos'],
      timeRange: 'week',
      language: 'de',
      maxResults: 5,
    });
    const music = toMusicSearchParams(musicSearchInput.parse({ query: 'q', pageno: 2 }));
    expect(music).toEqual({
      query: 'q',
      categories: ['music'],
      pageno: 2,
      maxResults: 10,
    });
  });
});

describe('video/music output schemas validate their projections', () => {
  it('videoSearchOutput accepts a full result and rejects a missing required field', () => {
    const ok = {
      query: 'q',
      results: [
        {
          title: 'T',
          url: 'https://v.test/1',
          thumbnailSrc: 'https://t.test/1',
          length: '14:54',
          author: 'A',
          publishedDate: '2025-07-16',
          engines: ['youtube'],
        },
      ],
      suggestions: [],
      unresponsiveEngines: [],
    };
    expect(videoSearchOutput.safeParse(ok).success).toBe(true);
    expect(videoSearchOutput.safeParse({ ...ok, results: [{ title: 'x' }] }).success).toBe(false);
  });
  it('musicSearchOutput accepts a result without audioSrc (soft mode)', () => {
    const ok = {
      query: 'q',
      results: [{ title: 'Radio', url: 'https://r.test/stream' }],
      suggestions: [],
      unresponsiveEngines: [],
    };
    expect(musicSearchOutput.safeParse(ok).success).toBe(true);
    expect(
      musicSearchOutput.safeParse({
        ...ok,
        results: [{ ...ok.results[0], audioSrc: 'https://r.test/file.ogg', length: '3:21' }],
      }).success,
    ).toBe(true);
  });
});
