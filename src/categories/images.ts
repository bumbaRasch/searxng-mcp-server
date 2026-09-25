import * as z from 'zod/v4';
import {
  asStringArray,
  isRecord,
  sanitizeMeta,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_MEDIA_FIELD_CHARS,
  MAX_SOURCE_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from './shared.js';
import { defineCategory } from './types.js';

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

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  imgSrc: z.string(),
  thumbnailSrc: z.string().optional(),
  resolution: z.string().optional(),
  imgFormat: z.string().optional(),
  source: z.string().optional(),
  engines: z.array(z.string()).optional(),
});
type Result = z.infer<typeof resultSchema>;

function projectResult(value: unknown): Result | undefined {
  if (!isRecord(value)) return undefined;
  // An image result without a usable img_src is useless: drop it entirely.
  const imgSrc = typeof value.img_src === 'string' ? value.img_src.trim() : '';
  if (imgSrc === '') return undefined;
  const result: Result = {
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

export const imageCategory = defineCategory({
  tool: {
    name: 'image_search',
    title: 'Image search (SearXNG)',
    description:
      'Search the web for images. Returns direct image links, thumbnails, resolution and format.',
  },
  upstream: { categories: ['images'], supportsTimeRange: false },
  heading: 'Image',
  resultSchema,
  projectResult,
  renderResultLines: (result) => {
    const lines: string[] = [];
    if (result.thumbnailSrc) lines.push(`![](<${sanitizeMeta(result.thumbnailSrc)}>)`);
    if (result.url) lines.push(`Page: ${sanitizeMeta(result.url)}`);
    lines.push(`Image: ${sanitizeMeta(result.imgSrc)}`);
    const meta: string[] = [];
    if (result.resolution) meta.push(sanitizeMeta(result.resolution));
    if (result.imgFormat) meta.push(sanitizeMeta(result.imgFormat));
    if (result.source) meta.push(`source: ${sanitizeMeta(result.source)}`);
    if (meta.length > 0) lines.push(`_${meta.join(' · ')}_`);
    return lines;
  },
});
