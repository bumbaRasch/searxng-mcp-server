import * as z from 'zod/v4';
import {
  asStringArray,
  isRecord,
  sanitizeMeta,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_AUTHOR_CHARS,
  MAX_MEDIA_FIELD_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from './shared.js';
import { pickPublishedDate } from './general.js';
import { defineCategory } from './types.js';

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  thumbnailSrc: z.string().optional(),
  length: z.string().optional(),
  author: z.string().optional(),
  publishedDate: z.string().optional(),
  engines: z.array(z.string()).optional(),
});
type Result = z.infer<typeof resultSchema>;

/** Upstream `length` is either a display string ("14:54") or numeric seconds. */
function normalizeDuration(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : truncateText(trimmed, MAX_MEDIA_FIELD_CHARS);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const total = Math.round(value);
    // Sub-second durations round to zero; drop rather than render "0:00".
    if (total === 0) return undefined;
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

function projectResult(value: unknown): Result | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value;
  const result: Result = {
    title: truncateText(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS),
    url: truncateText(typeof raw.url === 'string' ? raw.url : '', MAX_URL_CHARS),
  };
  if (typeof raw.thumbnail === 'string' && raw.thumbnail.trim() !== '')
    result.thumbnailSrc = truncateText(raw.thumbnail, MAX_URL_CHARS);
  const length = normalizeDuration(raw.length);
  if (length !== undefined) result.length = length;
  if (typeof raw.author === 'string') result.author = truncateText(raw.author, MAX_AUTHOR_CHARS);
  const publishedDate = pickPublishedDate(raw.publishedDate);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

export const videoCategory = defineCategory({
  tool: {
    name: 'video_search',
    title: 'Video search (SearXNG)',
    description:
      'Search the web for videos. Returns page links, preview thumbnails, duration, author and publish date. Supports a time_range freshness filter.',
  },
  upstream: { categories: ['videos'], supportsTimeRange: true },
  heading: 'Video',
  resultSchema,
  projectResult,
  renderResultLines: (result) => {
    const lines: string[] = [];
    if (result.thumbnailSrc) lines.push(`![](<${sanitizeMeta(result.thumbnailSrc)}>)`);
    if (result.url) lines.push(sanitizeMeta(result.url));
    const meta: string[] = [];
    if (result.length) meta.push(sanitizeMeta(result.length));
    if (result.author) meta.push(sanitizeMeta(result.author));
    if (result.publishedDate) meta.push(`published: ${sanitizeMeta(result.publishedDate)}`);
    if (meta.length > 0) lines.push(`_${meta.join(' · ')}_`);
    return lines;
  },
});
