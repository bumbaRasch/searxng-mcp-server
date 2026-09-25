import * as z from 'zod/v4';
import { isRecord, sanitizeMeta, truncateText, MAX_URL_CHARS } from './shared.js';
import { videoCategory } from './videos.js';
import { defineCategory } from './types.js';

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  audioSrc: z.string().optional(),
  thumbnailSrc: z.string().optional(),
  length: z.string().optional(),
  author: z.string().optional(),
  publishedDate: z.string().optional(),
  engines: z.array(z.string()).optional(),
});
type Result = z.infer<typeof resultSchema>;

function projectResult(value: unknown): Result | undefined {
  if (!isRecord(value)) return undefined;
  const video = videoCategory.projectResult(value);
  if (video === undefined) return undefined;
  const result: Result = { title: video.title, url: video.url };
  if (video.thumbnailSrc !== undefined) result.thumbnailSrc = video.thumbnailSrc;
  if (video.length !== undefined) result.length = video.length;
  if (video.author !== undefined) result.author = video.author;
  if (video.publishedDate !== undefined) result.publishedDate = video.publishedDate;
  if (video.engines !== undefined) result.engines = video.engines;
  if (typeof value.audio_src === 'string' && value.audio_src.trim() !== '')
    result.audioSrc = truncateText(value.audio_src, MAX_URL_CHARS);
  return result;
}

export const musicCategory = defineCategory({
  tool: {
    name: 'music_search',
    title: 'Music search (SearXNG)',
    description:
      'Search the web for music. Returns page links and, when available, direct audio file links (audioSrc).',
  },
  upstream: { categories: ['music'], supportsTimeRange: false },
  heading: 'Music',
  resultSchema,
  projectResult,
  renderResultLines: (result) => {
    const lines: string[] = [];
    if (result.thumbnailSrc) lines.push(`![](<${sanitizeMeta(result.thumbnailSrc)}>)`);
    if (result.url) lines.push(`Page: ${sanitizeMeta(result.url)}`);
    if (result.audioSrc) lines.push(`Audio: ${sanitizeMeta(result.audioSrc)}`);
    const meta: string[] = [];
    if (result.length) meta.push(sanitizeMeta(result.length));
    if (result.author) meta.push(sanitizeMeta(result.author));
    if (result.publishedDate) meta.push(`published: ${sanitizeMeta(result.publishedDate)}`);
    if (meta.length > 0) lines.push(`_${meta.join(' · ')}_`);
    return lines;
  },
});
