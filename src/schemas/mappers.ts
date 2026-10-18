import * as z from 'zod/v4';
import { timeRangeArg, type DetailLevel } from '../categories/shared.js';
import { type searchInput, type SearchInput } from './search.js';

/** Internal search parameters: tool args (snake_case) mapped to camelCase. */
type TimeRange = NonNullable<z.infer<typeof timeRangeArg>>;
type Safesearch = NonNullable<z.infer<(typeof searchInput.shape)['safesearch']>>;

export type SearchParams = {
  query: string;
  categories?: string[] | undefined;
  engines?: string[] | undefined;
  language?: string | undefined;
  timeRange?: TimeRange | undefined;
  pageno?: number | undefined;
  safesearch?: Safesearch | undefined;
  maxResults: number;
  minScore?: number | undefined;
  rerank?: boolean | undefined;
};

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
    rerank: input.rerank,
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
