import { URLSearchParams } from 'node:url';
import type { SearchParams, SearchResponse, SearchResult } from './types.js';

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

function projectResult(value: unknown): SearchResult {
  const raw: RawResult = isRecord(value) ? value : {};
  const result: SearchResult = {
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    content: typeof raw.content === 'string' ? raw.content : '',
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
  return {
    query: typeof data.query === 'string' ? data.query : '',
    results: rawResults.slice(0, Math.max(0, maxResults)).map(projectResult),
    answers: asStringArray(data.answers),
    infoboxes: Array.isArray(data.infoboxes) ? data.infoboxes : [],
    suggestions: asStringArray(data.suggestions),
    unresponsiveEngines: asStringArray(data.unresponsive_engines),
  };
}
