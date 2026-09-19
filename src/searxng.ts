import { URLSearchParams } from 'node:url';
import type { Config } from './config.js';
import { readCapped, type FetchLike } from './http.js';
import type { SearchAnswer, SearchParams, SearchResponse, SearchResult } from './types.js';

const MAX_RESULT_CONTENT_CHARS = 1000;
const MAX_ARRAY_ITEMS = 20;

export class SearxngError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SearxngError';
  }
}

export function buildSearchQuery(params: SearchParams): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('q', params.query);
  qs.set('format', 'json');
  if (params.categories?.length) qs.set('categories', params.categories.join(','));
  if (params.engines?.length) qs.set('engines', params.engines.join(','));
  if (params.language) qs.set('language', params.language);
  if (params.timeRange) qs.set('time_range', params.timeRange);
  if (params.pageno !== undefined) qs.set('pageno', String(params.pageno));
  if (params.safesearch !== undefined) qs.set('safesearch', String(params.safesearch));
  return qs;
}

interface RawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown;
  category?: unknown;
  score?: unknown;
  publishedDate?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? text.slice(0, max) : `${text.slice(0, max - 1)}…`;
}

function projectAnswer(value: unknown): SearchAnswer | null {
  if (typeof value === 'string') return { answer: value };
  if (!isRecord(value)) return null;
  const answer =
    typeof value.answer === 'string'
      ? value.answer
      : typeof value.content === 'string'
        ? value.content
        : null;
  if (answer === null) return null;
  const out: SearchAnswer = { answer };
  if (typeof value.url === 'string') out.url = value.url;
  if (typeof value.engine === 'string') out.engine = value.engine;
  return out;
}

function projectUnresponsive(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const engine = value[0];
  if (typeof engine !== 'string') return null;
  const message = typeof value[1] === 'string' ? value[1] : String(value[1] ?? '');
  return [engine, message];
}

function projectResult(value: unknown): SearchResult {
  const raw: RawResult = isRecord(value) ? value : {};
  const result: SearchResult = {
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    content: truncateText(
      typeof raw.content === 'string' ? raw.content : '',
      MAX_RESULT_CONTENT_CHARS,
    ),
  };
  if (typeof raw.engine === 'string') result.engine = raw.engine;
  if (Array.isArray(raw.engines)) result.engines = asStringArray(raw.engines);
  if (typeof raw.category === 'string') result.category = raw.category;
  if (typeof raw.score === 'number') result.score = raw.score;
  if (typeof raw.publishedDate === 'string') result.publishedDate = raw.publishedDate;
  return result;
}

export function mapSearchResponse(raw: unknown, maxResults: number): SearchResponse {
  const data = isRecord(raw) ? raw : {};
  const rawResults: unknown[] = Array.isArray(data.results) ? data.results : [];
  const answers = (Array.isArray(data.answers) ? data.answers : [])
    .map(projectAnswer)
    .filter((item): item is SearchAnswer => item !== null)
    .slice(0, MAX_ARRAY_ITEMS);
  const unresponsiveEngines = (
    Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []
  )
    .map(projectUnresponsive)
    .filter((item): item is [string, string] => item !== null)
    .slice(0, MAX_ARRAY_ITEMS);
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: rawResults.slice(0, Math.max(0, maxResults)).map(projectResult),
    answers,
    corrections: asStringArray(data.corrections).slice(0, MAX_ARRAY_ITEMS),
    infoboxes: (Array.isArray(data.infoboxes) ? data.infoboxes : []).slice(0, MAX_ARRAY_ITEMS),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines,
  };
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export async function search(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<SearchResponse> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const url = `${config.searxngUrl}/search?${buildSearchQuery(params).toString()}`;
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'application/json',
  };
  if (config.searxngUsername) {
    const credentials = `${config.searxngUsername}:${config.searxngPassword ?? ''}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searxngTimeoutMs);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new SearxngError(
      `Could not reach SearXNG at ${origin(config.searxngUrl)}. Is the container running and is SEARXNG_URL correct?`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 403) {
    throw new SearxngError(
      'SearXNG returned 403: the JSON API is disabled. Add "json" to search.formats in settings.yml.',
    );
  }
  if (response.status === 400) {
    throw new SearxngError(
      'SearXNG rejected the query parameters (400). Check categories, engines, language, time_range and safesearch.',
    );
  }
  if (!response.ok) {
    throw new SearxngError(`SearXNG request failed with HTTP ${response.status}.`);
  }

  const body = await readCapped(response, config.maxResponseBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    throw new SearxngError(
      'SearXNG returned a non-JSON response. Ensure format=json is enabled in settings.yml.',
      { cause: error },
    );
  }
  return mapSearchResponse(raw, params.maxResults ?? 10);
}
