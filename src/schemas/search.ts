import * as z from 'zod/v4';
import {
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
} from '../categories/shared.js';
import { generalCategory } from '../categories/general.js';

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
    rerank: z
      .boolean()
      .optional()
      .describe(
        'Reorder results with a heuristic rerank (query/title overlap, freshness, configured domain boosts) on top of the instance ranking.',
      ),
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
  ...generalCategory.envelopeSchema.shape,
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
