import * as z from 'zod/v4';
import { cached } from './cache.js';
import type { Config } from './config.js';
import { asStringArray, sanitizeMeta, truncateText, MAX_ARRAY_ITEMS } from './categories/shared.js';
import { wrapUntrusted } from './format.js';
import { fetchWithFailover, type ClientOptions, type ExplainStatus } from './searxng.js';

export const autocompleteInput = z.object({
  query: z.string().min(1).max(200).describe('The query prefix to complete.'),
});
export type AutocompleteInput = z.infer<typeof autocompleteInput>;

export const autocompleteOutput = z.object({
  query: z.string(),
  suggestions: z.array(z.string()),
});
export type AutocompleteResponse = z.infer<typeof autocompleteOutput>;

const MAX_SUGGESTION_CHARS = 200;

/** Flat string array is the contract (V1); the OpenSearch shape falls back to index 1. */
export function mapAutocompleteResponse(raw: unknown, query: string): AutocompleteResponse {
  const source = Array.isArray(raw) && Array.isArray(raw[1]) ? raw[1] : raw;
  return {
    query,
    suggestions: asStringArray(source)
      .slice(0, MAX_ARRAY_ITEMS)
      .map((suggestion) => truncateText(suggestion, MAX_SUGGESTION_CHARS)),
  };
}

/** The XHR header unlocks the flat array shape (V1). */
const AUTOCOMPLETE_HEADERS = { 'X-Requested-With': 'XMLHttpRequest' } as const;

const AUTOCOMPLETE_EXPLAIN: ExplainStatus = (status, base) => {
  if (status === 403) {
    return 'SearXNG returned 403: the autocompleter is blocked (often the limiter). Check the limiter settings in settings.yml.';
  }
  if (status === 429) {
    return 'SearXNG returned 429: rate limited. Check the limiter settings in settings.yml.';
  }
  return `SearXNG request failed with HTTP ${status} at ${base}.`;
};

function autocompleteUrl(base: string, query: string): string {
  return `${base}/autocompleter?${new URLSearchParams({ q: query }).toString()}`;
}

export async function autocomplete(
  config: Config,
  query: string,
  opts: ClientOptions = {},
): Promise<AutocompleteResponse> {
  // No SSRF guard by design: SEARXNG_URL is operator-trusted config; redirects
  // are refused so a compromised instance cannot pivot us onto internal hosts.
  const raw = await cached(opts.cache, 'GET', autocompleteUrl(config.searxngUrl, query), () =>
    fetchWithFailover(config, (base) => autocompleteUrl(base, query), {
      fetchImpl: opts.fetchImpl,
      headers: { ...AUTOCOMPLETE_HEADERS },
      explainStatus: AUTOCOMPLETE_EXPLAIN,
      explainBadJson: 'SearXNG returned a non-JSON autocomplete response.',
    }),
  );
  return mapAutocompleteResponse(raw, query);
}

export function formatAutocomplete(response: AutocompleteResponse): string {
  const lines: string[] = [`# Query suggestions for "${sanitizeMeta(response.query)}"`];
  const body =
    response.suggestions.length > 0
      ? response.suggestions.map((suggestion) => `- ${sanitizeMeta(suggestion)}`).join('\n')
      : 'No suggestions.';
  lines.push(wrapUntrusted(body));
  return lines.join('\n').trim();
}
