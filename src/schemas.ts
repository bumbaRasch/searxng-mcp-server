import * as z from 'zod/v4';
import {
  categoryEnvelopeSchema,
  categoryInputSchema,
  detailArg,
  enginesArg,
  languageArg,
  maxResultsArg,
  minScoreArg,
  pagenoArg,
  queriesArg,
  queryArg,
  safesearchArg,
  timeRangeArg,
  type DetailLevel,
} from './categories/shared.js';
import { generalCategory } from './categories/general.js';
import { imageCategory } from './categories/images.js';
import { musicCategory } from './categories/music.js';
import { newsCategory } from './categories/news.js';
import { videoCategory } from './categories/videos.js';

export {
  commonCategoryArgs,
  DEFAULT_MAX_RESULTS,
  detailArg,
  enginesArg,
  languageArg,
  maxResultsArg,
  minScoreArg,
  pagenoArg,
  queriesArg,
  queryArg,
  responseTail,
  safesearchArg,
  timeRangeArg,
} from './categories/shared.js';

/** Projection bound for infobox urls; also caps how many are rendered. */
export const MAX_URLS_PER_INFOBOX = 10;

export const searchInput = z
  .object({
    query: queryArg
      .optional()
      .describe('The search query. Required unless "queries" (batch) is given.'),
    queries: queriesArg,
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
    min_score: minScoreArg,
    detail: detailArg,
  })
  .superRefine((input, ctx) => {
    if (input.queries === undefined && input.query === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'Required unless queries (batch) is provided.',
      });
    }
    if (input.queries !== undefined && input.query !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['queries'],
        message: 'Provide either query or queries, not both.',
      });
    }
  });
export type SearchInput = z.infer<typeof searchInput>;

// Web search = category envelope plus its bespoke answers/corrections/infoboxes extras (D1).
export const searchOutput = z.object({
  ...categoryEnvelopeSchema(generalCategory.resultSchema).shape,
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
});
export type SearchResponse = z.infer<typeof searchOutput>;
export type SearchResult = z.infer<(typeof searchOutput.shape)['results']['element']>;
export type SearchAnswer = z.infer<(typeof searchOutput.shape)['answers']['element']>;
export type SearchInfobox = z.infer<(typeof searchOutput.shape)['infoboxes']['element']>;

/** Batch branch of the web-search output: one full response per input query (D6). */
export const searchBatchOutput = z.object({
  batch: z.array(searchOutput).min(2).max(5),
});
export type SearchBatchResponse = z.infer<typeof searchBatchOutput>;

// The tool's wire schema is the union of both shapes: anyOf, draft-07-safe (V6).
export const searchToolOutput = z.union([searchOutput, searchBatchOutput]);

// Media-category schemas are generated from the registry: input from the shared
// atoms, output from the envelope builder over the category's result schema (D1).
export const imageSearchInput = categoryInputSchema({
  supportsTimeRange: imageCategory.upstream.supportsTimeRange,
});
export type ImageSearchInput = z.infer<typeof imageSearchInput>;
export const imageSearchOutput = categoryEnvelopeSchema(imageCategory.resultSchema);
export type ImageSearchResponse = z.infer<typeof imageSearchOutput>;
export type ImageSearchResult = z.infer<(typeof imageSearchOutput.shape)['results']['element']>;

export const newsSearchInput = categoryInputSchema({
  supportsTimeRange: newsCategory.upstream.supportsTimeRange,
});
export type NewsSearchInput = z.infer<typeof newsSearchInput>;
export const newsSearchOutput = categoryEnvelopeSchema(newsCategory.resultSchema);
export type NewsSearchResponse = z.infer<typeof newsSearchOutput>;
export type NewsSearchResult = z.infer<(typeof newsSearchOutput.shape)['results']['element']>;

export const videoSearchInput = categoryInputSchema({
  supportsTimeRange: videoCategory.upstream.supportsTimeRange,
});
export type VideoSearchInput = z.infer<typeof videoSearchInput>;
export const videoSearchOutput = categoryEnvelopeSchema(videoCategory.resultSchema);
export type VideoSearchResponse = z.infer<typeof videoSearchOutput>;
export type VideoSearchResult = z.infer<(typeof videoSearchOutput.shape)['results']['element']>;

export const musicSearchInput = categoryInputSchema({
  supportsTimeRange: musicCategory.upstream.supportsTimeRange,
});
export type MusicSearchInput = z.infer<typeof musicSearchInput>;
export const musicSearchOutput = categoryEnvelopeSchema(musicCategory.resultSchema);
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
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset into the extracted content, to continue reading via nextOffset.'),
});
export type FetchInput = z.infer<typeof fetchInput>;

export const fetchOutput = z.object({
  url: z.string(),
  finalUrl: z.string(),
  title: z.string().optional(),
  byline: z.string().optional(),
  content: z.string(),
  truncated: z.boolean(),
  // Present only when the fetched resource was a PDF (D4).
  pages: z.number().int().positive().optional(),
  // Present only when content remains beyond the returned window (D5).
  nextOffset: z.number().int().nonnegative().optional(),
});
export type FetchResult = z.infer<typeof fetchOutput>;

/** Internal search parameters: tool args (snake_case) mapped to camelCase. */
type TimeRange = NonNullable<z.infer<typeof timeRangeArg>>;
type Safesearch = NonNullable<z.infer<(typeof searchInput.shape)['safesearch']>>;

export interface SearchParams {
  query: string;
  categories?: string[] | undefined;
  engines?: string[] | undefined;
  language?: string | undefined;
  timeRange?: TimeRange | undefined;
  pageno?: number | undefined;
  safesearch?: Safesearch | undefined;
  maxResults: number;
  minScore?: number | undefined;
}

/** Tool arguments shared by every category tool, time_range included when supported. */
export interface CategoryToolInput {
  query: string;
  engines?: string[] | undefined;
  language?: string | undefined;
  pageno?: number | undefined;
  safesearch?: Safesearch | undefined;
  max_results: number;
  time_range?: TimeRange | undefined;
  detail?: DetailLevel | undefined;
}

function mapCommonParams(input: CategoryToolInput): SearchParams {
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
    // The superRefine guard guarantees query whenever queries (batch) is absent.
    query: input.query ?? '',
    categories: input.categories,
    engines: input.engines,
    language: input.language,
    timeRange: input.time_range,
    pageno: input.pageno,
    safesearch: input.safesearch,
    maxResults: input.max_results,
    minScore: input.min_score,
  };
}

/** Registry-driven mapping: a category tool pins its upstream categories (D1). */
export function toCategorySearchParams(
  input: CategoryToolInput,
  upstream: { categories: string[] },
): SearchParams {
  return {
    ...mapCommonParams(input),
    categories: upstream.categories,
    timeRange: input.time_range,
  };
}

export function toImageSearchParams(input: ImageSearchInput): SearchParams {
  return toCategorySearchParams(input, imageCategory.upstream);
}

export function toNewsSearchParams(input: NewsSearchInput): SearchParams {
  return toCategorySearchParams(input, newsCategory.upstream);
}

export function toVideoSearchParams(input: VideoSearchInput): SearchParams {
  return toCategorySearchParams(input, videoCategory.upstream);
}

export function toMusicSearchParams(input: MusicSearchInput): SearchParams {
  return toCategorySearchParams(input, musicCategory.upstream);
}

export const listEnginesInput = z.object({});
export type ListEnginesInput = z.infer<typeof listEnginesInput>;

export const listEnginesOutput = z.object({
  engines: z.array(
    z.object({
      name: z.string(),
      categories: z.array(z.string()),
    }),
  ),
  categories: z.array(z.string()),
  counts: z.object({ engines: z.number(), categories: z.number() }),
});
export type ListEnginesResponse = z.infer<typeof listEnginesOutput>;
export type ListEngineEntry = z.infer<(typeof listEnginesOutput.shape)['engines']['element']>;
