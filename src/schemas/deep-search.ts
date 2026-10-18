/** deep_search (Stage 4): iterative search-fetch dossier. No output schema:
 * when the client negotiated io.modelcontextprotocol/tasks the tool returns a
 * CreateTaskResult instead of a CallToolResult, and the SDK rejects task
 * handles on tools that declare an output schema. */
import * as z from 'zod/v4';
import { maxResultsArg, queryArg } from '../categories/shared.js';

export const deepSearchInput = z.object({
  query: queryArg,
  max_iterations: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(2)
    .describe('Search-fetch rounds (1-4, default 2).'),
  sources_per_iteration: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe('Top uncited sources fetched per iteration (1-5, default 2).'),
  max_results: maxResultsArg,
});
export type DeepSearchInput = z.infer<typeof deepSearchInput>;
