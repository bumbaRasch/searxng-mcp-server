import { URLSearchParams } from 'node:url';
import type { Config } from './config.js';
import { readCapped, type FetchLike } from './http.js';
import {
  DEFAULT_MAX_RESULTS,
  MAX_URLS_PER_INFOBOX,
  toImageSearchParams,
  toMusicSearchParams,
  toNewsSearchParams,
  toVideoSearchParams,
  type ImageSearchInput,
  type ImageSearchResponse,
  type ImageSearchResult,
  type MusicSearchInput,
  type MusicSearchResponse,
  type MusicSearchResult,
  type NewsSearchInput,
  type NewsSearchResponse,
  type NewsSearchResult,
  type SearchAnswer,
  type SearchInfobox,
  type SearchParams,
  type SearchResponse,
  type SearchResult,
  type VideoSearchInput,
  type VideoSearchResponse,
  type VideoSearchResult,
} from './schemas.js';

const MAX_RESULT_CONTENT_CHARS = 1000;
const MAX_INFOBOX_ID_CHARS = 200;
const MAX_INFOBOX_URL_CHARS = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_TITLE_CHARS = 500;
const MAX_SOURCE_CHARS = 200;
const MAX_MEDIA_FIELD_CHARS = 50;
const MAX_URL_CHARS = 1000;
const MAX_AUTHOR_CHARS = 200; // same bound as MAX_SOURCE_CHARS, different semantics

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

/** SearXNG leaks the string 'None' (and blank strings) for missing dates. */
function pickPublishedDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'None' ? undefined : trimmed;
}

/** Upstream `length` is either a display string ("14:54") or numeric seconds. */
function pickLength(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : truncateText(trimmed, MAX_MEDIA_FIELD_CHARS);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const total = Math.round(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return truncateText(
      hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`,
      MAX_MEDIA_FIELD_CHARS,
    );
  }
  return undefined;
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
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  if (typeof raw.category === 'string') result.category = raw.category;
  if (typeof raw.score === 'number') result.score = raw.score;
  const publishedDate = pickPublishedDate(raw.publishedDate);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  return result;
}

export function mapSearchResponse(raw: unknown, maxResults: number): SearchResponse {
  const data = isRecord(raw) ? raw : {};
  const rawResults: unknown[] = Array.isArray(data.results) ? data.results : [];
  const answers = (Array.isArray(data.answers) ? data.answers : [])
    .map(projectAnswer)
    .filter((item): item is SearchAnswer => item !== null)
    .slice(0, MAX_ARRAY_ITEMS);
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: rawResults.slice(0, Math.max(0, maxResults)).map(projectResult),
    answers,
    corrections: asStringArray(data.corrections).slice(0, MAX_ARRAY_ITEMS),
    infoboxes: (Array.isArray(data.infoboxes) ? data.infoboxes : [])
      .map(projectInfobox)
      .filter((item): item is SearchInfobox => item !== null)
      .slice(0, MAX_ARRAY_ITEMS),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines: projectUnresponsiveList(data),
  };
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the configured instance';
  }
}

/** Shared search cycle: URL + auth + timeout + byte cap + status/JSON errors. */
async function fetchSearchJson(
  config: Config,
  params: SearchParams,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  // No SSRF guard here on purpose: SEARXNG_URL is operator-provided trusted
  // configuration (unlike fetch_content's arbitrary URLs), and the search
  // path never follows redirects to untrusted hosts.
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
  try {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal });
    } catch (error) {
      throw new SearxngError(
        `Could not reach SearXNG at ${origin(config.searxngUrl)}. Is the container running and is SEARXNG_URL correct?`,
        { cause: error },
      );
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

    let body: string;
    try {
      body = await readCapped(response, config.maxResponseBytes);
    } catch (error) {
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
  opts: { fetchImpl?: FetchLike } = {},
): Promise<SearchResponse> {
  const raw = await fetchSearchJson(config, params, opts);
  return mapSearchResponse(raw, params.maxResults ?? DEFAULT_MAX_RESULTS);
}

function pickThumbnail(value: Record<string, unknown>): string | undefined {
  const primary =
    typeof value.thumbnail_src === 'string' && value.thumbnail_src.trim() !== ''
      ? value.thumbnail_src
      : undefined;
  const fallback =
    typeof value.thumbnail === 'string' && value.thumbnail.trim() !== ''
      ? value.thumbnail
      : undefined;
  return primary ?? fallback;
}

function projectImageResult(value: unknown): ImageSearchResult | null {
  if (!isRecord(value)) return null;
  // An image result without a usable img_src is useless: drop it entirely.
  const imgSrc = typeof value.img_src === 'string' ? value.img_src.trim() : '';
  if (imgSrc === '') return null;
  const result: ImageSearchResult = {
    title: truncateText(typeof value.title === 'string' ? value.title : '', MAX_TITLE_CHARS),
    url: truncateText(typeof value.url === 'string' ? value.url : '', MAX_URL_CHARS),
    imgSrc: truncateText(imgSrc, MAX_URL_CHARS),
  };
  const thumbnail = pickThumbnail(value);
  if (thumbnail !== undefined) result.thumbnailSrc = truncateText(thumbnail, MAX_URL_CHARS);
  if (typeof value.resolution === 'string')
    result.resolution = truncateText(value.resolution, MAX_MEDIA_FIELD_CHARS);
  if (typeof value.img_format === 'string')
    result.imgFormat = truncateText(value.img_format, MAX_MEDIA_FIELD_CHARS);
  if (typeof value.source === 'string')
    result.source = truncateText(value.source, MAX_SOURCE_CHARS);
  if (Array.isArray(value.engines))
    result.engines = asStringArray(value.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

function projectUnresponsiveList(data: Record<string, unknown>): [string, string][] {
  return (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [])
    .map(projectUnresponsive)
    .filter((item): item is [string, string] => item !== null)
    .slice(0, MAX_ARRAY_ITEMS);
}

export function mapImageResponse(raw: unknown, maxResults: number): ImageSearchResponse {
  const data = isRecord(raw) ? raw : {};
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: (Array.isArray(data.results) ? data.results : [])
      .map(projectImageResult)
      .filter((item): item is ImageSearchResult => item !== null)
      .slice(0, Math.max(0, maxResults)),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines: projectUnresponsiveList(data),
  };
}

function projectNewsResult(value: unknown): NewsSearchResult {
  const raw: {
    title?: unknown;
    url?: unknown;
    content?: unknown;
    publishedDate?: unknown;
    engines?: unknown;
  } = isRecord(value) ? value : {};
  const result: NewsSearchResult = {
    title: truncateText(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS),
    url: truncateText(typeof raw.url === 'string' ? raw.url : '', MAX_URL_CHARS),
    content: truncateText(
      typeof raw.content === 'string' ? raw.content : '',
      MAX_RESULT_CONTENT_CHARS,
    ),
  };
  const publishedDate = pickPublishedDate(raw.publishedDate);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

export function mapNewsResponse(raw: unknown, maxResults: number): NewsSearchResponse {
  const data = isRecord(raw) ? raw : {};
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: (Array.isArray(data.results) ? data.results : [])
      .slice(0, Math.max(0, maxResults))
      .map(projectNewsResult),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines: projectUnresponsiveList(data),
  };
}

export async function imageSearch(
  config: Config,
  input: ImageSearchInput,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ImageSearchResponse> {
  const raw = await fetchSearchJson(config, toImageSearchParams(input), opts);
  return mapImageResponse(raw, input.max_results ?? DEFAULT_MAX_RESULTS);
}

export async function newsSearch(
  config: Config,
  input: NewsSearchInput,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<NewsSearchResponse> {
  const raw = await fetchSearchJson(config, toNewsSearchParams(input), opts);
  return mapNewsResponse(raw, input.max_results ?? DEFAULT_MAX_RESULTS);
}

function projectVideoResult(value: unknown): VideoSearchResult {
  const raw = isRecord(value) ? value : {};
  const result: VideoSearchResult = {
    title: truncateText(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS),
    url: truncateText(typeof raw.url === 'string' ? raw.url : '', MAX_URL_CHARS),
  };
  if (typeof raw.thumbnail === 'string' && raw.thumbnail.trim() !== '')
    result.thumbnailSrc = truncateText(raw.thumbnail, MAX_URL_CHARS);
  const length = pickLength(raw.length);
  if (length !== undefined) result.length = length;
  if (typeof raw.author === 'string') result.author = truncateText(raw.author, MAX_AUTHOR_CHARS);
  const publishedDate = pickPublishedDate(raw.publishedDate);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

export function mapVideoResponse(raw: unknown, maxResults: number): VideoSearchResponse {
  const data = isRecord(raw) ? raw : {};
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: (Array.isArray(data.results) ? data.results : [])
      .slice(0, Math.max(0, maxResults))
      .map(projectVideoResult),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines: projectUnresponsiveList(data),
  };
}

function projectMusicResult(value: unknown): MusicSearchResult {
  const raw = isRecord(value) ? value : {};
  const result: MusicSearchResult = {
    title: truncateText(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS),
    url: truncateText(typeof raw.url === 'string' ? raw.url : '', MAX_URL_CHARS),
  };
  if (typeof raw.audio_src === 'string' && raw.audio_src.trim() !== '')
    result.audioSrc = truncateText(raw.audio_src, MAX_URL_CHARS);
  if (typeof raw.thumbnail === 'string' && raw.thumbnail.trim() !== '')
    result.thumbnailSrc = truncateText(raw.thumbnail, MAX_URL_CHARS);
  const length = pickLength(raw.length);
  if (length !== undefined) result.length = length;
  if (typeof raw.author === 'string') result.author = truncateText(raw.author, MAX_AUTHOR_CHARS);
  const publishedDate = pickPublishedDate(raw.publishedDate);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

export function mapMusicResponse(raw: unknown, maxResults: number): MusicSearchResponse {
  const data = isRecord(raw) ? raw : {};
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: (Array.isArray(data.results) ? data.results : [])
      .slice(0, Math.max(0, maxResults))
      .map(projectMusicResult),
    suggestions: asStringArray(data.suggestions).slice(0, MAX_ARRAY_ITEMS),
    unresponsiveEngines: projectUnresponsiveList(data),
  };
}

export async function videoSearch(
  config: Config,
  input: VideoSearchInput,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<VideoSearchResponse> {
  const raw = await fetchSearchJson(config, toVideoSearchParams(input), opts);
  return mapVideoResponse(raw, input.max_results ?? DEFAULT_MAX_RESULTS);
}

export async function musicSearch(
  config: Config,
  input: MusicSearchInput,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<MusicSearchResponse> {
  const raw = await fetchSearchJson(config, toMusicSearchParams(input), opts);
  return mapMusicResponse(raw, input.max_results ?? DEFAULT_MAX_RESULTS);
}
