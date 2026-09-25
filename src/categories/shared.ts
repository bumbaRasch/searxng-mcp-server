import * as z from 'zod/v4';
import { commonCategoryArgs, responseTail, timeRangeArg } from '../schemas.js';
import type { CategoryEnvelope } from './types.js';

export {
  commonCategoryArgs,
  enginesArg,
  languageArg,
  maxResultsArg,
  pagenoArg,
  queryArg,
  responseTail,
  safesearchArg,
  timeRangeArg,
} from '../schemas.js';

const MAX_ARRAY_ITEMS = 20;

type CommonInputShape = typeof commonCategoryArgs;
type TimedInputShape = CommonInputShape & { time_range: typeof timeRangeArg };

/** Category tool input: shared atoms, plus time_range when the category supports it (D1). */
export function categoryInputSchema(options: {
  supportsTimeRange: true;
}): z.ZodObject<TimedInputShape>;
export function categoryInputSchema(options: {
  supportsTimeRange: false;
}): z.ZodObject<CommonInputShape>;
export function categoryInputSchema(options: {
  supportsTimeRange: boolean;
}): z.ZodObject<CommonInputShape> | z.ZodObject<TimedInputShape>;
export function categoryInputSchema(options: { supportsTimeRange: boolean }) {
  return options.supportsTimeRange
    ? z.object({ ...commonCategoryArgs, time_range: timeRangeArg })
    : z.object({ ...commonCategoryArgs });
}

/** Output envelope built once from a category's result schema; tail is draft-07-safe (V6). */
export function categoryEnvelopeSchema<R>(resultSchema: z.ZodType<R>) {
  return z.object({
    query: z.string(),
    results: z.array(resultSchema),
    ...responseTail,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Upstream sends [engine, error] pairs of arbitrary shape; keep string-engine pairs only. */
function projectUnresponsive(value: unknown): [string, string] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const engine = value[0];
  if (typeof engine !== 'string') return undefined;
  const message = typeof value[1] === 'string' ? value[1] : String(value[1] ?? '');
  return [engine, message];
}

/** Defensive envelope projection: filter garbage first, then apply the limit,
 * so dropped items never consume the maxResults budget. */
export function buildCategoryEnvelope<R>(
  raw: unknown,
  maxResults: number,
  project: (value: unknown) => R | undefined,
): CategoryEnvelope<R> {
  const data = isRecord(raw) ? raw : {};
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: (Array.isArray(data.results) ? data.results : [])
      .map(project)
      .filter((item): item is R => item !== undefined)
      .slice(0, Math.max(0, maxResults)),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines: (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [])
      .map(projectUnresponsive)
      .filter((item): item is [string, string] => item !== undefined)
      .slice(0, MAX_ARRAY_ITEMS),
  };
}
