import * as z from 'zod/v4';
import {
  asStringArray,
  isRecord,
  sanitizeMeta,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_RESULT_CONTENT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from './shared.js';
import { pickPublishedDate, type RawResult } from './general.js';
import { defineCategory } from './types.js';

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  publishedDate: z.string().optional(),
  engines: z.array(z.string()).optional(),
});
type Result = z.infer<typeof resultSchema>;

function projectResult(value: unknown): Result | undefined {
  if (!isRecord(value)) return undefined;
  const raw: RawResult = value;
  const result: Result = {
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

export const newsCategory = defineCategory({
  tool: {
    name: 'news_search',
    title: 'News search (SearXNG)',
    description: 'Search recent news articles. Supports a time_range freshness filter.',
  },
  upstream: { categories: ['news'], supportsTimeRange: true },
  heading: 'News',
  resultSchema,
  projectResult,
  renderResultLines: (result) => {
    const lines: string[] = [];
    lines.push(sanitizeMeta(result.url));
    if (result.content) lines.push('', result.content);
    const meta: string[] = [];
    if (result.publishedDate) meta.push(`published: ${sanitizeMeta(result.publishedDate)}`);
    if (result.engines && result.engines.length > 0)
      meta.push(`engines: ${sanitizeMeta(result.engines.join(', '))}`);
    if (meta.length > 0) lines.push('', `_${meta.join(' · ')}_`);
    return lines;
  },
});
