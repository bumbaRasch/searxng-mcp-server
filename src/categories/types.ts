import type * as z from 'zod/v4';
import { categoryEnvelopeSchema } from './shared.js';

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

export interface CategoryUpstream<Time extends boolean = boolean> {
  /** SearXNG categories sent upstream, e.g. ["images"]. */
  categories: string[];
  supportsTimeRange: Time;
}

/**
 * A category is data: one declaration carries everything needed to generate the
 * tool slice (input/output schemas, handler, renderer). `Time` stays literal so
 * schema generation can key off the flag at compile time.
 */
export interface CategoryDeclaration<R, Time extends boolean = boolean> {
  tool: CategoryToolMeta;
  upstream: CategoryUpstream<Time>;
  /** Heading word, e.g. "Image" in "# Image results for ...". */
  heading: string;
  resultSchema: z.ZodType<R>;
  /** Defensive projection; undefined drops a garbage item without consuming the result budget. */
  projectResult(this: void, raw: unknown): R | undefined;
  /** Per-result markdown lines, rendered inside the untrusted wrapper. */
  renderResultLines(this: void, result: R): string[];
}

/** A registered category: the declaration plus its generated output schema. */
export interface CategoryDefinition<R, Time extends boolean = boolean> extends CategoryDeclaration<
  R,
  Time
> {
  /** Output envelope schema over `resultSchema`, computed by `defineCategory`. */
  envelopeSchema: ReturnType<typeof categoryEnvelopeSchema<R>>;
}

/** Pins inference of R from `resultSchema`/`projectResult` at the definition
 * site and derives the envelope schema while R is still precise. */
export function defineCategory<R, Time extends boolean>(
  declaration: CategoryDeclaration<R, Time>,
): CategoryDefinition<R, Time> {
  return {
    ...declaration,
    envelopeSchema: categoryEnvelopeSchema(declaration.resultSchema),
  };
}
