import * as z from 'zod/v4';

// Single source of truth for tool input/output shapes: the zod schemas below
// both validate wire data and (via z.infer) type the internal data model.
// Hand-written duplicates of these shapes are intentionally absent.

const timeRange = z.enum(['day', 'week', 'month', 'year']);

export const DEFAULT_MAX_RESULTS = 10;
/** Projection bound for infobox urls; also caps how many are rendered. */
export const MAX_URLS_PER_INFOBOX = 10;

export const searchInput = z.object({
  query: z.string().min(1).max(500).describe('The search query.'),
  categories: z
    .array(z.string().min(1))
    .optional()
    .describe('SearXNG categories, e.g. ["general"], ["news"]. Unknown values are ignored.'),
  engines: z
    .array(z.string().min(1))
    .optional()
    .describe('Restrict to specific SearXNG engines (best-effort).'),
  language: z.string().min(2).optional().describe('Language code, e.g. "en", "de".'),
  time_range: timeRange.optional().describe('Restrict results by time.'),
  pageno: z.number().int().min(1).optional().describe('Page number (default 1).'),
  safesearch: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional()
    .describe('0 = off, 1 = moderate, 2 = strict.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_MAX_RESULTS)
    .describe(`Maximum results to return (default ${DEFAULT_MAX_RESULTS}).`),
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
  suggestions: z.array(z.string()),
  unresponsiveEngines: z.array(z.tuple([z.string(), z.string()])),
});
export type SearchResponse = z.infer<typeof searchOutput>;
export type SearchResult = z.infer<(typeof searchOutput.shape)['results']['element']>;
export type SearchAnswer = z.infer<(typeof searchOutput.shape)['answers']['element']>;
export type SearchInfobox = z.infer<(typeof searchOutput.shape)['infoboxes']['element']>;

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
export type TimeRange = z.infer<typeof timeRange>;
export type Safesearch = NonNullable<z.infer<(typeof searchInput.shape)['safesearch']>>;

export interface SearchParams {
  query: string;
  categories?: string[];
  engines?: string[];
  language?: string;
  timeRange?: TimeRange;
  pageno?: number;
  safesearch?: Safesearch;
  maxResults?: number;
}

/** Single mapping site from MCP tool arguments to internal search params. */
export function toSearchParams(input: SearchInput): SearchParams {
  return {
    query: input.query,
    categories: input.categories,
    engines: input.engines,
    language: input.language,
    timeRange: input.time_range,
    pageno: input.pageno,
    safesearch: input.safesearch,
    maxResults: input.max_results ?? DEFAULT_MAX_RESULTS,
  };
}
