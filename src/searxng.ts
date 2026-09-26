import { URLSearchParams } from 'node:url';
import { cached } from './cache.js';
import type { Config } from './config.js';
import type { TtlCache } from './cache.js';
import { isRedirect, readCapped, type FetchLike } from './http.js';
import { parseSearchResultsHtml } from './html-results.js';
import {
  asStringArray,
  buildCategoryEnvelope,
  isRecord,
  sanitizeMeta,
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
import type {
  ImageSearchResponse,
  MusicSearchResponse,
  NewsSearchResponse,
  VideoSearchResponse,
} from './categories/schemas.js';
import {
  MAX_URLS_PER_INFOBOX,
  type ListEngineEntry,
  type ListEnginesResponse,
  type SearchAnswer,
  type SearchBatchResponse,
  type SearchInfobox,
  type SearchParams,
  type SearchResponse,
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
  /** HTTP status when the failure was a non-ok response; undefined otherwise. */
  readonly status: number | undefined;
  /** True when a 2xx body failed JSON.parse (D13 HTML-fallback trigger). */
  readonly badJson: boolean;
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean | undefined;
      status?: number | undefined;
      badJson?: boolean | undefined;
    },
  ) {
    super(message, options);
    this.name = 'SearxngError';
    this.retryable = options?.retryable === true;
    this.status = options?.status;
    this.badJson = options?.badJson === true;
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

/** Fetch one instance URL through the shared error taxonomy (timeout,
 * unreachable, redirect refusal, byte cap) and return the raw body text. */
async function fetchInstanceBody(
  config: Config,
  url: string,
  opts: Pick<InstanceRequest, 'fetchImpl' | 'headers' | 'explainStatus'>,
): Promise<string> {
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
          { status: response.status },
        );
      }
      throw new SearxngError(opts.explainStatus(response.status, base), {
        retryable: failoverStatus(response.status),
        status: response.status,
      });
    }

    try {
      return await readCapped(response, config.maxResponseBytes);
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
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInstanceJson(
  config: Config,
  url: string,
  opts: InstanceRequest,
): Promise<unknown> {
  const body = await fetchInstanceBody(config, url, opts);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new SearxngError(opts.explainBadJson, { cause: error, badJson: true });
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

/** Same query without `format=json` — the instance's HTML UI (D13). */
function htmlSearchUrl(base: string, params: SearchParams): string {
  const qs = buildSearchParams(params);
  qs.delete('format');
  return `${base}/search?${qs.toString()}`;
}

async function fetchSearchHtml(config: Config, params: SearchParams, opts: ClientOptions) {
  return fetchInstanceBody(config, htmlSearchUrl(config.searxngUrl, params), {
    fetchImpl: opts.fetchImpl,
    headers: { Accept: 'text/html' },
    explainStatus: SEARCH_EXPLAIN,
  });
}

/** True only for the D13 triggers: a 403 (limiter / JSON API disabled) or a
 * non-JSON body — and only when the operator opted in. */
function htmlFallbackEligible(config: Config, error: unknown): boolean {
  if (!config.htmlFallback) return false;
  if (!(error instanceof SearxngError)) return false;
  return error.status === 403 || error.badJson;
}

const clampWarned = new WeakSet<Config>();

function warnResultClampOnce(config: Config, requested: number, ceiling: number): void {
  if (clampWarned.has(config)) return;
  clampWarned.add(config);
  console.error(
    `SEARXNG_MAX_RESULTS: clamping request max_results ${requested} to the configured ceiling ${ceiling}`,
  );
}

/** D16 operator defaults, applied in the params layer before URL building and
 * slicing: explicit request values always win; the ceiling clamps max_results. */
export function applyOperatorDefaults(config: Config, params: SearchParams): SearchParams {
  const ceiling = config.maxResults;
  const clamped = ceiling !== undefined && params.maxResults > ceiling;
  if (clamped) warnResultClampOnce(config, params.maxResults, ceiling);
  return {
    ...params,
    language: params.language ?? config.defaultLanguage,
    safesearch: params.safesearch ?? config.defaultSafesearch,
    maxResults: clamped ? ceiling : params.maxResults,
  };
}

export async function search(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<SearchResponse> {
  const effective = applyOperatorDefaults(config, params);
  let raw: unknown;
  try {
    raw = await fetchSearchJson(config, effective, opts);
  } catch (error) {
    if (!htmlFallbackEligible(config, error)) throw error;
    raw = await cached(opts.cache, 'GET', htmlSearchUrl(config.searxngUrl, effective), () =>
      fetchSearchHtml(config, effective, opts).then((html) =>
        parseSearchResultsHtml(html, effective.query),
      ),
    ).catch((fallbackError: unknown) => {
      throw new SearxngError(
        `HTML fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        { cause: fallbackError },
      );
    });
  }
  return mapSearchResponse(raw, effective.maxResults, effective.minScore);
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
  const effective = applyOperatorDefaults(config, params);
  const raw = await fetchSearchJson(config, effective, opts);
  return buildCategoryEnvelope(raw, effective.maxResults, definition.projectResult);
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
  const effective = applyOperatorDefaults(config, params);
  const raw = await fetchSearchJson(config, effective, opts);
  return mapImageResponse(raw, effective.maxResults);
}

export async function newsSearch(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<NewsSearchResponse> {
  const effective = applyOperatorDefaults(config, params);
  const raw = await fetchSearchJson(config, effective, opts);
  return mapNewsResponse(raw, effective.maxResults);
}

export async function videoSearch(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<VideoSearchResponse> {
  const effective = applyOperatorDefaults(config, params);
  const raw = await fetchSearchJson(config, effective, opts);
  return mapVideoResponse(raw, effective.maxResults);
}

export async function musicSearch(
  config: Config,
  params: SearchParams,
  opts: ClientOptions = {},
): Promise<MusicSearchResponse> {
  const effective = applyOperatorDefaults(config, params);
  const raw = await fetchSearchJson(config, effective, opts);
  return mapMusicResponse(raw, effective.maxResults);
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

const CONFIG_REQUEST = {
  explainStatus: CONFIG_EXPLAIN,
  explainBadJson: 'SearXNG returned a non-JSON configuration response.',
};

async function fetchConfigJson(config: Config, opts: ClientOptions = {}): Promise<unknown> {
  return cached(opts.cache, 'GET', `${config.searxngUrl}/config`, () =>
    fetchWithFailover(config, (base) => `${base}/config`, {
      ...CONFIG_REQUEST,
      fetchImpl: opts.fetchImpl,
    }),
  );
}

/** One instance's /config with its own timeout — the D15 fan-out unit (no failover:
 * a dead replica is data, not a retry). */
async function fetchInstanceConfig(
  config: Config,
  base: string,
  opts: ClientOptions,
): Promise<unknown> {
  return cached(opts.cache, 'GET', `${base}/config`, () =>
    fetchInstanceJson(config, `${base}/config`, { ...CONFIG_REQUEST, fetchImpl: opts.fetchImpl }),
  );
}

/** Engine names in a /config body: enabled ones when `selectable`, otherwise the disabled ones. */
function engineNames(raw: unknown, selectable: boolean): string[] {
  const source = isRecord(raw) && isRecord(raw.engines) ? raw.engines : {};
  const names = new Set<string>();
  for (const engine of Object.values(source)) {
    if (!isRecord(engine) || typeof engine.name !== 'string' || engine.name.trim() === '') continue;
    if ((engine.enabled === true) !== selectable) continue;
    names.add(engine.name);
  }
  return [...names].toSorted((a, b) => a.localeCompare(b)).slice(0, MAX_ENGINES);
}

function instanceEngineView(raw: unknown): { engines: string[]; unavailableEngines: string[] } {
  return { engines: engineNames(raw, true), unavailableEngines: engineNames(raw, false) };
}

/** Sanitized message for a failed replica's error entry (D15). */
export function replicaErrorText(reason: unknown): string {
  return sanitizeMeta(reason instanceof Error ? reason.message : String(reason));
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

/** Single instance: today's behavior, byte-identical. More than one: D15 —
 * fan /config out over every configured instance and aggregate; a failing
 * replica becomes an error entry, never a tool failure (all failing does throw). */
export async function listEngines(
  config: Config,
  opts: ClientOptions = {},
): Promise<ListEnginesResponse> {
  if (config.searxngUrls.length === 1) {
    return mapEnginesResponse(await fetchConfigJson(config, opts));
  }
  const outcomes: ({ url: string; raw: unknown } | { url: string; reason: unknown })[] =
    await Promise.all(
      config.searxngUrls.map(async (base) => {
        try {
          return { url: base, raw: await fetchInstanceConfig(config, base, opts) };
        } catch (reason) {
          return { url: base, reason };
        }
      }),
    );
  const instances: NonNullable<ListEnginesResponse['instances']> = [];
  let primary: { raw: unknown; engines: string[] } | undefined;
  let lastReason: unknown;
  for (const outcome of outcomes) {
    if ('raw' in outcome) {
      const view = instanceEngineView(outcome.raw);
      instances.push({
        url: outcome.url,
        engines: view.engines,
        unavailableEngines: view.unavailableEngines,
      });
      if (primary === undefined) {
        primary = { raw: outcome.raw, engines: view.engines };
      } else {
        // Fold the next reachable instance into the running intersection.
        const present = new Set(view.engines);
        primary.engines = primary.engines.filter((name) => present.has(name));
      }
    } else {
      lastReason = outcome.reason;
      instances.push({ url: outcome.url, error: replicaErrorText(outcome.reason) });
    }
  }
  if (primary === undefined) throw lastReason;
  return { ...mapEnginesResponse(primary.raw), instances, commonEngines: primary.engines };
}
