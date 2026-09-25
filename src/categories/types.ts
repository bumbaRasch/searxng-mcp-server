import type * as z from 'zod/v4';

/** Output envelope shared by every category tool: built once (D1). */
export interface CategoryEnvelope<R> {
  query: string;
  results: R[];
  suggestions: string[];
  unresponsiveEngines: [string, string][];
}

export interface CategoryToolMeta {
  name: string;
  title: string;
  description: string;
}

export interface CategoryUpstream {
  /** SearXNG categories sent upstream, e.g. ["images"]. */
  categories: string[];
  supportsTimeRange: boolean;
}

/**
 * A category is data: one declaration carries everything needed to generate the
 * tool slice (input/output schemas, handler, renderer).
 */
export interface CategoryDefinition<R> {
  tool: CategoryToolMeta;
  upstream: CategoryUpstream;
  /** Heading word, e.g. "Image" in "# Image results for ...". */
  heading: string;
  resultSchema: z.ZodType<R>;
  /** Defensive projection; undefined drops a garbage item without consuming the result budget. */
  projectResult(raw: unknown): R | undefined;
  /** Per-result markdown lines, rendered inside the untrusted wrapper. */
  renderResultLines(result: R): string[];
}

/** Pins inference of R from `resultSchema`/`projectResult` at the definition site. */
export function defineCategory<R>(definition: CategoryDefinition<R>): CategoryDefinition<R> {
  return definition;
}
