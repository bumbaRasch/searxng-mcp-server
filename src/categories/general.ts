import * as z from 'zod/v4';
import {
  asStringArray,
  isRecord,
  sanitizeMeta,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_RESULT_CONTENT_CHARS,
  MAX_URL_CHARS,
} from './shared.js';
import { defineCategory } from './types.js';

/** Upstream payload subset read by the web projector. */
export interface RawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown;
  category?: unknown;
  score?: unknown;
  publishedDate?: unknown;
  metadata?: unknown;
  thumbnail?: unknown;
}

/** SearXNG leaks the string 'None' (and blank strings) for missing dates. */
export function pickPublishedDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'None' ? undefined : trimmed;
}

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  engine: z.string().optional(),
  engines: z.array(z.string()).optional(),
  category: z.string().optional(),
  score: z.number().optional(),
  publishedDate: z.string().optional(),
  metadata: z.string().optional(),
  thumbnailSrc: z.string().optional(),
});
type Result = z.infer<typeof resultSchema>;

function projectResult(value: unknown): Result | undefined {
  const raw: RawResult = isRecord(value) ? value : {};
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (url === '') return undefined; // a result without a URL is unusable
  const result: Result = {
    title: typeof raw.title === 'string' ? raw.title : '',
    url,
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
  if (typeof raw.metadata === 'string' && raw.metadata.trim() !== '')
    result.metadata = truncateText(raw.metadata, MAX_RESULT_CONTENT_CHARS);
  if (typeof raw.thumbnail === 'string' && raw.thumbnail.trim() !== '')
    result.thumbnailSrc = truncateText(raw.thumbnail, MAX_URL_CHARS);
  return result;
}

export const generalCategory = defineCategory({
  tool: {
    name: 'search',
    title: 'Web search (SearXNG)',
    description:
      'Search the web through the configured SearXNG instance. Returns ranked results with titles, URLs and snippets. Supports batch queries (2-5 via "queries"), a min_score relevance floor and detail: "compact". For images, news, videos or music, prefer the dedicated *_search tools — they return richer typed fields.',
  },
  // Upstream categories are user-chosen via the tool's categories argument.
  upstream: { categories: [], supportsTimeRange: true },
  heading: 'Search',
  resultSchema,
  projectResult,
  renderResultLines: (result) => {
    const lines: string[] = [];
    if (result.url) lines.push(sanitizeMeta(result.url));
    if (result.content) lines.push('', result.content);
    const meta: string[] = [];
    if (result.engine) meta.push(`engine: ${sanitizeMeta(result.engine)}`);
    if (result.publishedDate) meta.push(`published: ${sanitizeMeta(result.publishedDate)}`);
    if (result.metadata) meta.push(`metadata: ${sanitizeMeta(result.metadata)}`);
    if (result.thumbnailSrc) meta.push(`thumbnail: ${sanitizeMeta(result.thumbnailSrc)}`);
    if (meta.length > 0) lines.push('', `_${meta.join(' · ')}_`);
    return lines;
  },
});
