import * as z from 'zod/v4';

// Single source of truth for tool input/output shapes: zod validates the wire data; z.infer types the model.

const timeRange = z.enum(['day', 'week', 'month', 'year']);

export const DEFAULT_MAX_RESULTS = 10;
/** Projection bound for infobox urls; also caps how many are rendered. */
export const MAX_URLS_PER_INFOBOX = 10;

// Shared argument atoms: every search-like input reuses these, so they cannot drift.
const queryArg = z.string().min(1).max(500).describe('The search query.');
const enginesArg = z
  .array(z.string().min(1))
  .optional()
  .describe('Restrict to specific SearXNG engines (best-effort).');
const languageArg = z.string().min(2).optional().describe('Language code, e.g. "en", "de".');
const pagenoArg = z.number().int().min(1).optional().describe('Page number (default 1).');
const safesearchArg = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .optional()
  .describe('0 = off, 1 = moderate, 2 = strict.');
const maxResultsArg = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(DEFAULT_MAX_RESULTS)
  .describe(`Maximum results to return (default ${DEFAULT_MAX_RESULTS}).`);

const timeRangeArg = timeRange.optional().describe('Restrict results by time.');
const commonCategoryArgs = {
  query: queryArg,
  engines: enginesArg,
  language: languageArg,
  pageno: pagenoArg,
  safesearch: safesearchArg,
  max_results: maxResultsArg,
};

const responseTail = {
  suggestions: z.array(z.string()),
  unresponsiveEngines: z.array(z.tuple([z.string(), z.string()])),
};

export const searchInput = z.object({
  query: queryArg,
  categories: z
    .array(z.string().min(1))
    .optional()
    .describe('SearXNG categories, e.g. ["general"], ["news"]. Unknown values are ignored.'),
  engines: enginesArg,
  language: languageArg,
  time_range: timeRangeArg,
  pageno: pagenoArg,
  safesearch: safesearchArg,
  max_results: maxResultsArg,
});
export type SearchInput = z.infer<typeof searchInput>;

export const searchOutput = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      engine: z.string().optional(),
      engines: z.array(z.string()).optional(),
      category: z.string().optional(),
      score: z.number().optional(),
      publishedDate: z.string().optional(),
    }),
  ),
  answers: z.array(
    z.object({ answer: z.string(), url: z.string().optional(), engine: z.string().optional() }),
  ),
  corrections: z.array(z.string()),
  infoboxes: z.array(
    z.object({
      infobox: z.string().optional(),
      id: z.string().optional(),
      content: z.string().optional(),
      engine: z.string().optional(),
      urls: z.array(z.string()).optional(),
    }),
  ),
  ...responseTail,
});
export type SearchResponse = z.infer<typeof searchOutput>;
export type SearchResult = z.infer<(typeof searchOutput.shape)['results']['element']>;
export type SearchAnswer = z.infer<(typeof searchOutput.shape)['answers']['element']>;
export type SearchInfobox = z.infer<(typeof searchOutput.shape)['infoboxes']['element']>;

export const imageSearchInput = z.object({ ...commonCategoryArgs });
export type ImageSearchInput = z.infer<typeof imageSearchInput>;

export const newsSearchInput = z.object({ ...commonCategoryArgs, time_range: timeRangeArg });
export type NewsSearchInput = z.infer<typeof newsSearchInput>;

export const imageSearchOutput = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      imgSrc: z.string(),
      thumbnailSrc: z.string().optional(),
      resolution: z.string().optional(),
      imgFormat: z.string().optional(),
      source: z.string().optional(),
      engines: z.array(z.string()).optional(),
    }),
  ),
  ...responseTail,
});
export type ImageSearchResponse = z.infer<typeof imageSearchOutput>;
export type ImageSearchResult = z.infer<(typeof imageSearchOutput.shape)['results']['element']>;

export const newsSearchOutput = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      publishedDate: z.string().optional(),
      engines: z.array(z.string()).optional(),
    }),
  ),
  ...responseTail,
});
export type NewsSearchResponse = z.infer<typeof newsSearchOutput>;
export type NewsSearchResult = z.infer<(typeof newsSearchOutput.shape)['results']['element']>;

export const videoSearchInput = z.object({ ...commonCategoryArgs, time_range: timeRangeArg });
export type VideoSearchInput = z.infer<typeof videoSearchInput>;

export const musicSearchInput = z.object({ ...commonCategoryArgs });
export type MusicSearchInput = z.infer<typeof musicSearchInput>;

export const videoSearchOutput = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      thumbnailSrc: z.string().optional(),
      length: z.string().optional(),
      author: z.string().optional(),
      publishedDate: z.string().optional(),
      engines: z.array(z.string()).optional(),
    }),
  ),
  ...responseTail,
});
export type VideoSearchResponse = z.infer<typeof videoSearchOutput>;
export type VideoSearchResult = z.infer<(typeof videoSearchOutput.shape)['results']['element']>;

export const musicSearchOutput = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      audioSrc: z.string().optional(),
      thumbnailSrc: z.string().optional(),
      length: z.string().optional(),
      author: z.string().optional(),
      publishedDate: z.string().optional(),
      engines: z.array(z.string()).optional(),
    }),
  ),
  ...responseTail,
});
export type MusicSearchResponse = z.infer<typeof musicSearchOutput>;
export type MusicSearchResult = z.infer<(typeof musicSearchOutput.shape)['results']['element']>;

export const fetchInput = z.object({
  url: z.string().min(1).max(2048).describe('The absolute http/https URL to fetch.'),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .describe('Maximum characters to return (overrides MAX_CHARS).'),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(120_000)
    .optional()
    .describe('Request timeout in milliseconds (at most 120000).'),
});
export type FetchInput = z.infer<typeof fetchInput>;

export const fetchOutput = z.object({
  url: z.string(),
  finalUrl: z.string(),
  title: z.string().optional(),
  byline: z.string().optional(),
  content: z.string(),
  truncated: z.boolean(),
});
export type FetchResult = z.infer<typeof fetchOutput>;

/** Internal search parameters: tool args (snake_case) mapped to camelCase. */
type TimeRange = z.infer<typeof timeRange>;
type Safesearch = NonNullable<z.infer<(typeof searchInput.shape)['safesearch']>>;

export interface SearchParams {
  query: string;
  categories?: string[] | undefined;
  engines?: string[] | undefined;
  language?: string | undefined;
  timeRange?: TimeRange | undefined;
  pageno?: number | undefined;
  safesearch?: Safesearch | undefined;
  maxResults?: number | undefined;
}

interface CommonSearchArgs {
  query: string;
  engines?: string[] | undefined;
  language?: string | undefined;
  pageno?: number | undefined;
  safesearch?: Safesearch | undefined;
  max_results: number;
}

function mapCommonParams(input: CommonSearchArgs): SearchParams {
  return {
    query: input.query,
    engines: input.engines,
    language: input.language,
    pageno: input.pageno,
    safesearch: input.safesearch,
    maxResults: input.max_results,
  };
}

/** Single mapping site from MCP tool arguments to internal search params. */
export function toSearchParams(input: SearchInput): SearchParams {
  return {
    ...mapCommonParams(input),
    categories: input.categories,
    timeRange: input.time_range,
  };
}

export function toImageSearchParams(input: ImageSearchInput): SearchParams {
  return { ...mapCommonParams(input), categories: ['images'] };
}

export function toNewsSearchParams(input: NewsSearchInput): SearchParams {
  return { ...mapCommonParams(input), categories: ['news'], timeRange: input.time_range };
}

export function toVideoSearchParams(input: VideoSearchInput): SearchParams {
  return { ...mapCommonParams(input), categories: ['videos'], timeRange: input.time_range };
}

export function toMusicSearchParams(input: MusicSearchInput): SearchParams {
  return { ...mapCommonParams(input), categories: ['music'] };
}
