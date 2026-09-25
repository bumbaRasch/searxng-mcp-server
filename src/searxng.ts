import { URLSearchParams } from 'node:url';
import { cached } from './cache.js';
import type { Config } from './config.js';
import type { TtlCache } from './cache.js';
import { isRedirect, readCapped, type FetchLike } from './http.js';
import {
  asStringArray,
  buildCategoryEnvelope,
  isRecord,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_RESULT_CONTENT_CHARS,
} from './categories/shared.js';
import type { CategoryDeclaration, CategoryEnvelope } from './categories/types.js';
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
  type SearchBatchResponse,
  type SearchInfobox,
  type SearchParams,
  type SearchResponse,
  type VideoSearchResponse,
} from './schemas.js';

const MAX_INFOBOX_ID_CHARS = 200;
const MAX_INFOBOX_URL_CHARS = 500;

/** Client call options: injected fetch plus the optional D9 response cache. */
export interface ClientOptions {
  fetchImpl?: FetchLike | undefined;
  cache?: TtlCache<unknown> | undefined;
}

export class SearxngError extends Error {
  /** True when a failover instance could still answer (D8: network, timeout, 5xx, 429, 403). */
  readonly retryable: boolean;
  constructor(message: string, options?: { cause?: unknown; retryable?: boolean | undefined }) {
    super(message, options);
    this.name = 'SearxngError';
    this.retryable = options?.retryable === true;
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

export function mapSearchResponse(
  raw: unknown,
  maxResults: number,
  minScore?: number,
): SearchResponse {
  const envelope = buildCategoryEnvelope(
    raw,
    maxResults,
    generalCategory.projectResult,
    // min_score applies to scored items only; unscored ones always pass (D6).
    minScore === undefined
      ? undefined
      : (item) => item.score === undefined || item.score >= minScore,
  );
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

function searchUrl(base: string, params: SearchParams): string {
  return `${base}/search?${buildSearchParams(params).toString()}`;
}

export type ExplainStatus = (status: number, base: string) => string;

const SEARCH_EXPLAIN: ExplainStatus = (status, base) => {
  if (status === 403) {
    return 'SearXNG returned 403: the JSON API is disabled. Add "json" to search.formats in settings.yml.';
  }
  if (status === 400) {
    return 'SearXNG rejected the query parameters (400). Check categories, engines, language, time_range and safesearch.';
  }
  if (status === 429) {
    return 'SearXNG returned 429: rate limited. Check the limiter settings in settings.yml.';
  }
  return `SearXNG request failed with HTTP ${status} at ${origin(base)}.`;
};

const CONFIG_EXPLAIN: ExplainStatus = (status) =>
  `Could not read the SearXNG instance configuration (HTTP ${status}). The /config endpoint may be disabled.`;

/** D8 failover statuses: 5xx, 429 (rate limited) and 403 (JSON API disabled). */
function failoverStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 403;
}

/** Per-endpoint profile for the shared instance client: endpoint-specific
 * error wording, optional extra headers, and the injectable seams. */
export interface InstanceRequest {
  fetchImpl?: FetchLike | undefined;
  /** Extra headers merged over the shared instance headers. */
  headers?: Record<string, string> | undefined;
  explainStatus: ExplainStatus;
  explainBadJson: string;
}

async function fetchInstanceJson(
  config: Config,
  url: string,
  opts: InstanceRequest,
): Promise<unknown> {
  // Cast bridges @types/node's vendored RequestInit and undici's own types
  // (two structural copies of the same dispatcher interface).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as FetchLike);
  const base = origin(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.searxngTimeoutMs);
  try {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, {
        headers: { ...instanceHeaders(config), ...opts.headers },
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SearxngError(`SearXNG timed out after ${config.searxngTimeoutMs} ms.`, {
          cause: error,
          retryable: true,
        });
      }
      throw new SearxngError(
        `Could not reach SearXNG at ${base}. Is the container running and is SEARXNG_URL correct?`,
        { cause: error, retryable: true },
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (isRedirect(response.status)) {
        throw new SearxngError(
          `SearXNG answered with an HTTP ${response.status} redirect. SEARXNG_URL must point directly at the instance.`,
        );
      }
      throw new SearxngError(opts.explainStatus(response.status, base), {
        retryable: failoverStatus(response.status),
      });
    }

    let body: string;
    try {
      body = await readCapped(response, config.maxResponseBytes);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SearxngError(`SearXNG timed out after ${config.searxngTimeoutMs} ms.`, {
          cause: error,
          retryable: true,
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
      throw new SearxngError(opts.explainBadJson, { cause: error });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Sequential instance attempts (D8): retry only network errors, timeouts, 5xx,
 * 429 and 403 — never 400; exhaustion surfaces the last error, taxonomy intact.
 * `config.searxngUrls` always lists the primary first (config contract). */
export async function fetchWithFailover(
  config: Config,
  buildUrl: (base: string) => string,
  opts: InstanceRequest,
): Promise<unknown> {
  let lastError: unknown;
  for (const base of config.searxngUrls) {
    try {
      return await fetchInstanceJson(config, buildUrl(base), opts);
    } catch (error) {
      lastError = error;
      if (!(error instanceof SearxngError) || !error.retryable) throw error;
    }
  }
  throw lastError;
}

async function fetchSearchJson(config: Config, params: SearchParams, opts: ClientOptions = {}) {
  // No SSRF guard by design: SEARXNG_URL is operator-trusted config; redirects
  // are refused so a compromised instance cannot pivot us onto internal hosts.
  return cached(opts.cache, 'GET', searchUrl(config.searxngUrl, params), () =>
    fetchWithFailover(config, (base) => searchUrl(base, params), {
      fetchImpl: opts.fetchImpl,
      explainStatus: SEARCH_EXPLAIN,
      explainBadJson:
        'SearXNG returned a non-JSON response. Ensure format=json is enabled in settings.yml.',
    }),
  );
}

export async function search(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<SearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapSearchResponse(raw, params.maxResults, params.minScore);
}

/** Batch fan-out: concurrent queries with the shared timeout, input-ordered results (D6). */
export async function searchBatch(
  config: Config,
  queries: string[],
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<SearchBatchResponse> {
  const batch = await Promise.all(
    queries.map((query) => search(config, { ...params, query }, opts)),
  );
  return { batch };
}

/** One generic client path for every registry category: fetch, project, envelope (D1). */
export async function runCategorySearch<R>(
  definition: CategoryDeclaration<R>,
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
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
  opts: ClientOptions = {},
): Promise<ImageSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapImageResponse(raw, params.maxResults);
}

export async function newsSearch(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<NewsSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapNewsResponse(raw, params.maxResults);
}

export async function videoSearch(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<VideoSearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapVideoResponse(raw, params.maxResults);
}

export async function musicSearch(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
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

async function fetchConfigJson(config: Config, opts: ClientOptions = {}): Promise<unknown> {
  return cached(opts.cache, 'GET', `${config.searxngUrl}/config`, () =>
    fetchWithFailover(config, (base) => `${base}/config`, {
      fetchImpl: opts.fetchImpl,
      explainStatus: CONFIG_EXPLAIN,
      explainBadJson: 'SearXNG returned a non-JSON configuration response.',
    }),
  );
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
  opts: ClientOptions = {},
): Promise<ListEnginesResponse> {
  const raw = await fetchConfigJson(config, opts);
  return mapEnginesResponse(raw);
}
