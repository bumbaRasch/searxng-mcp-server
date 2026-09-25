import * as z from 'zod/v4';
import type { Config } from './config.js';
import { isRedirect, readCapped, type FetchLike } from './http.js';
import { asStringArray, sanitizeMeta, truncateText, MAX_ARRAY_ITEMS } from './categories/shared.js';
import { wrapUntrusted } from './format.js';
import { SearxngError } from './searxng.js';

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

function autocompleteHeaders(config: Config): Record<string, string> {
  // Mirrors instanceHeaders in searxng.ts; the XHR header unlocks the flat array (V1).
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (config.searxngUsername) {
    const credentials = `${config.searxngUsername}:${config.searxngPassword ?? ''}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  return headers;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the configured SEARXNG URL';
  }
}

async function fetchSuggestionsJson(
  config: Config,
  query: string,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<unknown> {
  // No SSRF guard by design: SEARXNG_URL is operator-trusted config; redirects
  // are refused so a compromised instance cannot pivot us onto internal hosts.

  // Cast bridges @types/node's vendored RequestInit and undici's own types
  // (two structural copies of the same dispatcher interface).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  const url = `${config.searxngUrl}/autocompleter?${new URLSearchParams({ q: query }).toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searxngTimeoutMs);
  try {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: autocompleteHeaders(config),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SearxngError(`SearXNG timed out after ${config.searxngTimeoutMs} ms.`, {
          cause: error,
        });
      }
      throw new SearxngError(
        `Could not reach SearXNG at ${origin(config.searxngUrl)}. Is the container running and is SEARXNG_URL correct?`,
        { cause: error },
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 403) {
        throw new SearxngError(
          'SearXNG returned 403: the autocompleter is blocked (often the limiter). Check the limiter settings in settings.yml.',
        );
      }
      if (response.status === 429) {
        throw new SearxngError(
          'SearXNG returned 429: rate limited. Check the limiter settings in settings.yml.',
        );
      }
      if (isRedirect(response.status)) {
        throw new SearxngError(
          `SearXNG answered with an HTTP ${response.status} redirect. SEARXNG_URL must point directly at the instance.`,
        );
      }
      throw new SearxngError(
        `SearXNG request failed with HTTP ${response.status} at ${origin(config.searxngUrl)}.`,
      );
    }

    let body: string;
    try {
      body = await readCapped(response, config.maxResponseBytes);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SearxngError(`SearXNG timed out after ${config.searxngTimeoutMs} ms.`, {
          cause: error,
        });
      }
      throw new SearxngError(
        error instanceof Error ? error.message : 'SearXNG response could not be read.',
        { cause: error },
      );
    }

    try {
      return JSON.parse(body);
    } catch (error) {
      throw new SearxngError('SearXNG returned a non-JSON autocomplete response.', {
        cause: error,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function autocomplete(
  config: Config,
  query: string,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<AutocompleteResponse> {
  const raw = await fetchSuggestionsJson(config, query, opts);
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
