/** search_and_fetch: one query, the search envelope, and the top results'
 * full content fetched in the same call (Stage 1). */
import * as z from 'zod/v4';
import {
  enginesArg,
  languageArg,
  maxResultsArg,
  minScoreArg,
  pagenoArg,
  queryArg,
  safesearchArg,
  timeRangeArg,
} from '../categories/shared.js';
import { fetchInput } from './fetch.js';
import { searchOutput } from './search.js';

export const searchAndFetchInput = z.object({
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
  min_score: minScoreArg,
  rerank: z
    .boolean()
    .optional()
    .describe(
      'Reorder results with a heuristic rerank (query/title overlap, freshness, configured domain boosts) on top of the instance ranking.',
    ),
  fetch_top: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe('Fetch the full content of the top N results (1-5, default 3).'),
  max_chars: fetchInput.shape.max_chars,
});
export type SearchAndFetchInput = z.infer<typeof searchAndFetchInput>;

export const fetchedPageSchema = z.object({
  ref: z.number().int().positive(),
  url: z.string(),
  finalUrl: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  // Present instead of content when the page could not be fetched.
  error: z.string().optional(),
});
export type FetchedPage = z.infer<typeof fetchedPageSchema>;

export const searchAndFetchOutput = z.object({
  ...searchOutput.shape,
  pages: z.array(fetchedPageSchema),
});
export type SearchAndFetchResponse = z.infer<typeof searchAndFetchOutput>;
