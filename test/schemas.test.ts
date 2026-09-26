import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  listEnginesInput,
  listEnginesOutput,
  searchInput,
  searchOutput,
  searchToolOutput,
  toSearchParams,
} from '../src/schemas.js';
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
} from '../src/categories/schemas.js';

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
  it('accepts time_range now that the images category supports it', () => {
    expect('time_range' in imageSearchInput.shape).toBe(true);
    const parsed = imageSearchInput.parse({ query: 'cats', time_range: 'week' });
    expect(parsed.time_range).toBe('week');
    expect(parsed.max_results).toBe(10);
  });
  it('rejects a bad query, an invalid time_range and out-of-range max_results', () => {
    expect(imageSearchInput.safeParse({ query: '' }).success).toBe(false);
    expect(imageSearchInput.safeParse({ query: 'q', max_results: 51 }).success).toBe(false);
    expect(imageSearchInput.safeParse({ query: 'q', time_range: 'fortnight' }).success).toBe(false);
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
  it('accepts time_range now that the music category supports it', () => {
    expect('time_range' in musicSearchInput.shape).toBe(true);
    const parsed = musicSearchInput.parse({ query: 'nirvana', time_range: 'day' });
    expect(parsed.time_range).toBe('day');
    expect(parsed.max_results).toBe(10);
  });
  it('rejects an invalid time_range value', () => {
    expect(musicSearchInput.safeParse({ query: 'q', time_range: 'decade' }).success).toBe(false);
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

describe('time_range parity for image and music params', () => {
  it('maps time_range through the category param mappers', () => {
    const image = toImageSearchParams(
      imageSearchInput.parse({ query: 'cats', time_range: 'month' }),
    );
    expect(image.timeRange).toBe('month');
    const music = toMusicSearchParams(
      musicSearchInput.parse({ query: 'nirvana', time_range: 'week' }),
    );
    expect(music.timeRange).toBe('week');
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

describe('listEngines schemas', () => {
  it('input accepts empty args', () => {
    expect(listEnginesInput.parse({})).toEqual({});
  });

  it('output validates a well-formed response and rejects malformed', () => {
    const response = {
      engines: [{ name: 'wikipedia', categories: ['general'] }],
      categories: ['general'],
      counts: { engines: 1, categories: 1 },
    };
    expect(listEnginesOutput.safeParse(response).success).toBe(true);
    expect(listEnginesOutput.safeParse({ ...response, engines: [{ name: 'x' }] }).success).toBe(
      false,
    );
  });
});

describe('searchInput queries / min_score / detail', () => {
  it('requires query unless queries is given, and forbids sending both', () => {
    expect(searchInput.safeParse({}).success).toBe(false);
    expect(searchInput.safeParse({ query: 'q', queries: ['a', 'b'] }).success).toBe(false);
    expect(searchInput.safeParse({ queries: ['a', 'b'] }).success).toBe(true);
    expect(searchInput.safeParse({ query: 'q' }).success).toBe(true);
  });

  it('bounds queries at 2-5 non-empty entries', () => {
    expect(searchInput.safeParse({ queries: ['solo'] }).success).toBe(false);
    expect(searchInput.safeParse({ queries: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(searchInput.safeParse({ queries: ['a', ''] }).success).toBe(false);
  });

  it('routes shared args through toSearchParams, including min_score', () => {
    const params = toSearchParams(
      searchInput.parse({ queries: ['a', 'b'], min_score: 2, safesearch: 1, max_results: 5 }),
    );
    expect(params.minScore).toBe(2);
    expect(params.safesearch).toBe(1);
    expect(params.maxResults).toBe(5);
  });

  it('accepts min_score >= 0 and rejects negatives', () => {
    expect(searchInput.safeParse({ query: 'q', min_score: 0 }).success).toBe(true);
    expect(searchInput.safeParse({ query: 'q', min_score: 1.5 }).success).toBe(true);
    expect(searchInput.safeParse({ query: 'q', min_score: -1 }).success).toBe(false);
  });

  it('accepts detail full/compact and rejects other values', () => {
    expect(searchInput.safeParse({ query: 'q', detail: 'compact' }).success).toBe(true);
    expect(searchInput.safeParse({ query: 'q', detail: 'full' }).success).toBe(true);
    expect(searchInput.safeParse({ query: 'q', detail: 'verbose' }).success).toBe(false);
  });
});

describe('searchOutput union (searchToolOutput)', () => {
  const single = {
    query: 'q',
    results: [{ title: 'T', url: 'https://r.test/x', content: 'c' }],
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsiveEngines: [],
  };

  it('validates both the single envelope and the batch wrapper', () => {
    expect(searchToolOutput.safeParse(single).success).toBe(true);
    expect(searchToolOutput.safeParse({ batch: [single, single] }).success).toBe(true);
    expect(searchToolOutput.safeParse({ batch: [single] }).success).toBe(false);
    expect(searchToolOutput.safeParse({ nope: true }).success).toBe(false);
  });

  it('compiles to a draft-07-safe anyOf (no items:false)', () => {
    const json = z.toJSONSchema(searchToolOutput) as JsonSchemaNode;
    expect(json.anyOf).toBeDefined();
    expect(JSON.stringify(json)).not.toContain('"items":false');
  });
});

interface JsonSchemaNode {
  type?: string;
  items?: JsonSchemaNode | boolean;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaNode>;
  anyOf?: unknown;
}

describe('output schemas are validatable by draft-07-only clients', () => {
  it('models unresponsiveEngines as a plain fixed-length string array, not a tuple', () => {
    // z.tuple -> prefixItems/items:false, which draft-07-only clients reject.
    const json = z.toJSONSchema(searchOutput) as JsonSchemaNode;
    const pair = json.properties?.unresponsiveEngines?.items;
    expect(pair).not.toBe(false);
    expect(pair).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    });
  });
});
