import { URLSearchParams } from 'node:url';
import type { Config } from './config.js';
import { isRedirect, readCapped, type FetchLike } from './http.js';
import {
  asStringArray,
  buildCategoryEnvelope,
  isRecord,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_RESULT_CONTENT_CHARS,
} from './categories/shared.js';
import type { CategoryDefinition, CategoryEnvelope } from './categories/types.js';
import { generalCategory } from './categories/general.js';
import { imageCategory } from './categories/images.js';
import { musicCategory } from './categories/music.js';
import { newsCategory } from './categories/news.js';
import { videoCategory } from './categories/videos.js';
import {
  MAX_URLS_PER_INFOBOX,
  type ListEngineEntry,
  type ListEnginesResponse,
  type ImageSearchResponse,
  type MusicSearchResponse,
  type NewsSearchResponse,
  type SearchAnswer,
  type SearchInfobox,
  type SearchParams,
  type SearchResponse,
  type VideoSearchResponse,
} from './schemas.js';

const MAX_INFOBOX_ID_CHARS = 200;
const MAX_INFOBOX_URL_CHARS = 500;

export class SearxngError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SearxngError';
  }
}

export function buildSearchParams(params: SearchParams): URLSearchParams {
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

function projectAnswer(value: unknown): SearchAnswer | null {
  if (typeof value === 'string') return { answer: truncateText(value, MAX_RESULT_CONTENT_CHARS) };
  if (!isRecord(value)) return null;
  const answer =
    typeof value.answer === 'string'
      ? value.answer
      : typeof value.content === 'string'
        ? value.content
        : null;
  if (answer === null) return null;
  const out: SearchAnswer = { answer: truncateText(answer, MAX_RESULT_CONTENT_CHARS) };
  if (typeof value.url === 'string') out.url = value.url;
  if (typeof value.engine === 'string') out.engine = value.engine;
  return out;
}

function projectInfobox(value: unknown): SearchInfobox | null {
  if (!isRecord(value)) return null;
  const out: SearchInfobox = {};
  if (typeof value.infobox === 'string') {
    out.infobox = truncateText(value.infobox, MAX_RESULT_CONTENT_CHARS);
  }
  if (typeof value.id === 'string') out.id = truncateText(value.id, MAX_INFOBOX_ID_CHARS);
  if (typeof value.content === 'string') {
    out.content = truncateText(value.content, MAX_RESULT_CONTENT_CHARS);
  }
  if (typeof value.engine === 'string') out.engine = value.engine;
  if (Array.isArray(value.urls)) {
    out.urls = value.urls
      .filter((url): url is string => typeof url === 'string')
      .slice(0, MAX_URLS_PER_INFOBOX)
      .map((url) => truncateText(url, MAX_INFOBOX_URL_CHARS));
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function mapSearchResponse(raw: unknown, maxResults: number): SearchResponse {
  const envelope = buildCategoryEnvelope(raw, maxResults, generalCategory.projectResult);
  const data = isRecord(raw) ? raw : {};
  const answers = (Array.isArray(data.answers) ? data.answers : [])
    .map(projectAnswer)
    .filter((item): item is SearchAnswer => item !== null)
    .slice(0, MAX_ARRAY_ITEMS);
  return {
    query: envelope.query,
    results: envelope.results,
    answers,
    corrections: asStringArray(data.corrections).slice(0, MAX_ARRAY_ITEMS),
    infoboxes: (Array.isArray(data.infoboxes) ? data.infoboxes : [])
      .map(projectInfobox)
      .filter((item): item is SearchInfobox => item !== null)
      .slice(0, MAX_ARRAY_ITEMS),
    suggestions: envelope.suggestions,
    unresponsiveEngines: envelope.unresponsiveEngines,
  };
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the configured SEARXNG URL';
  }
}

async function fetchSearchJson(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<unknown> {
  // No SSRF guard by design: SEARXNG_URL is operator-trusted config; redirects
  // are refused so a compromised instance cannot pivot us onto internal hosts.

  // Cast bridges @types/node's vendored RequestInit and undici's own types
  // (two structural copies of the same dispatcher interface).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  const url = `${config.searxngUrl}/search?${buildSearchParams(params).toString()}`;
  const headers = instanceHeaders(config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searxngTimeoutMs);
  try {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers,
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
          'SearXNG returned 403: the JSON API is disabled. Add "json" to search.formats in settings.yml.',
        );
      }
      if (response.status === 400) {
        throw new SearxngError(
          'SearXNG rejected the query parameters (400). Check categories, engines, language, time_range and safesearch.',
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
      throw new SearxngError(
        'SearXNG returned a non-JSON response. Ensure format=json is enabled in settings.yml.',
        { cause: error },
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function search(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<SearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapSearchResponse(raw, params.maxResults);
}

/** One generic client path for every registry category: fetch, project, envelope (D1). */
export async function runCategorySearch<R>(
  definition: CategoryDefinition<R>,
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<CategoryEnvelope<R>> {
  const raw = await fetchSearchJson(config, params, opts);
  return buildCategoryEnvelope(raw, params.maxResults, definition.projectResult);
}

export function mapImageResponse(raw: unknown, maxResults: number): ImageSearchResponse {
  return buildCategoryEnvelope(raw, maxResults, imageCategory.projectResult);
}

export function mapNewsResponse(raw: unknown, maxResults: number): NewsSearchResponse {
  return buildCategoryEnvelope(raw, maxResults, newsCategory.projectResult);
}

export function mapVideoResponse(raw: unknown, maxResults: number): VideoSearchResponse {
  return buildCategoryEnvelope(raw, maxResults, videoCategory.projectResult);
}

export function mapMusicResponse(raw: unknown, maxResults: number): MusicSearchResponse {
  return buildCategoryEnvelope(raw, maxResults, musicCategory.projectResult);
}

export async function imageSearch(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<ImageSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapImageResponse(raw, params.maxResults);
}

export async function newsSearch(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<NewsSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapNewsResponse(raw, params.maxResults);
}

export async function videoSearch(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<VideoSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapVideoResponse(raw, params.maxResults);
}

export async function musicSearch(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<MusicSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapMusicResponse(raw, params.maxResults);
}

function instanceHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'application/json',
  };
  if (config.searxngUsername) {
    const credentials = `${config.searxngUsername}:${config.searxngPassword ?? ''}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  return headers;
}

const MAX_ENGINES = 100;

async function fetchConfigJson(
  config: Config,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<unknown> {
  // Cast bridges @types/node's vendored RequestInit and undici's own types
  // (two structural copies of the same dispatcher interface).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  const url = `${config.searxngUrl}/config`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searxngTimeoutMs);
  try {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: instanceHeaders(config),
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
      if (isRedirect(response.status)) {
        throw new SearxngError(
          `SearXNG answered with an HTTP ${response.status} redirect. SEARXNG_URL must point directly at the instance.`,
        );
      }
      throw new SearxngError(
        `Could not read the SearXNG instance configuration (HTTP ${response.status}). The /config endpoint may be disabled.`,
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
      throw new SearxngError('SearXNG returned a non-JSON configuration response.', {
        cause: error,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export function mapEnginesResponse(raw: unknown): ListEnginesResponse {
  const source = isRecord(raw) && isRecord(raw.engines) ? raw.engines : {};
  const categorySet = new Set<string>();
  const entries: ListEngineEntry[] = [];
  for (const engine of Object.values(source)) {
    if (!isRecord(engine) || engine.enabled !== true) continue;
    if (typeof engine.name !== 'string' || engine.name.trim() === '') continue;
    const categories = asStringArray(engine.categories).slice(0, MAX_ARRAY_ITEMS);
    for (const category of categories) categorySet.add(category);
    entries.push({ name: engine.name, categories });
  }
  const sorted = entries.toSorted((a, b) => a.name.localeCompare(b.name));
  const categories = [...categorySet]
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_ARRAY_ITEMS);
  const engines = sorted.slice(0, MAX_ENGINES);
  return {
    engines,
    categories,
    counts: { engines: engines.length, categories: categories.length },
  };
}

export async function listEngines(
  config: Config,
  opts: { fetchImpl?: FetchLike | undefined } = {},
): Promise<ListEnginesResponse> {
  const raw = await fetchConfigJson(config, opts);
  return mapEnginesResponse(raw);
}
