import {
  sanitizeMeta,
  sanitizeUntrusted,
  truncateText,
  UNTRUSTED_WARNING,
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
  type DetailLevel,
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
  type FetchResult,
  type ListEnginesResponse,
  type SearchBatchResponse,
  type SearchResponse,
} from './schemas.js';

/** Compact mode keeps the snippet to roughly one line (D6). */
const COMPACT_SNIPPET_CHARS = 160;

export { sanitizeMeta, sanitizeUntrusted };

/** The wrapper only fences the text channel, so structured output needs the same defusing. */
export function sanitizeStructured<T>(value: T): T {
  if (typeof value === 'string') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return sanitizeUntrusted(value) as T;
  }
  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return value.map(sanitizeStructured) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeStructured(item)]),
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return sanitized as T;
  }
  return value;
}

export function wrapUntrusted(content: string): string {
  return [
    '',
    UNTRUSTED_WARNING,
    UNTRUSTED_OPEN,
    '',
    sanitizeUntrusted(content),
    UNTRUSTED_CLOSE,
  ].join('\n');
}

/** Error text may embed attacker-controlled strings (URLs, hosts), so sanitize it too. */
export function sanitizeToolError(message: string): string {
  return sanitizeMeta(message);
}

/** Compact per-result rendering: title (in the heading) + URL + capped snippet (D6). */
function compactResultLines(result: { url: string; content?: string }): string[] {
  const lines: string[] = [sanitizeMeta(result.url)];
  if (result.content) lines.push('', truncateText(result.content, COMPACT_SNIPPET_CHARS));
  return lines;
}

export function formatSearchResults(response: SearchResponse, detail?: DetailLevel): string {
  const lines: string[] = [`# Search results for "${sanitizeMeta(response.query)}"`];
  lines.push(renderSearchBody(response, detail));
  return lines.join('\n').trim();
}

export function formatSearchBatchResults(
  response: SearchBatchResponse,
  detail?: DetailLevel,
): string {
  const lines: string[] = [`# Search results for ${response.batch.length} queries`];
  response.batch.forEach((entry, index) => {
    lines.push('', `## Query ${index + 1}: "${sanitizeMeta(entry.query)}"`);
    lines.push(renderSearchBody(entry, detail));
  });
  return lines.join('\n').trim();
}

/** Wrapped body shared by the single and batch renderers (detail affects markdown only). */
function renderSearchBody(response: SearchResponse, detail?: DetailLevel): string {
  const body: string[] = [];

  if (response.answers.length > 0) {
    body.push(
      '',
      `Answers: ${response.answers.map((answer) => sanitizeMeta(answer.answer)).join(' | ')}`,
    );
  }
  if (response.corrections.length > 0) {
    body.push('', `Corrections: ${response.corrections.map(sanitizeMeta).join(', ')}`);
  }
  if (response.unresponsiveEngines.length > 0) {
    body.push(
      '',
      `Unresponsive engines: ${response.unresponsiveEngines
        .map(([engine = '', message = '']) => `${sanitizeMeta(engine)} (${sanitizeMeta(message)})`)
        .join(', ')}`,
    );
  }

  if (response.results.length === 0 && response.infoboxes.length === 0) body.push('No results.');

  response.infoboxes.forEach((box, index) => {
    const name = box.infobox ?? box.id ?? `#${index + 1}`;
    body.push('', `## Infobox: ${sanitizeMeta(name)}`);
    if (box.content) body.push('', box.content); // inside the wrapper below
    if (box.urls && box.urls.length > 0) {
      body.push(
        '',
        `Links: ${box.urls.slice(0, MAX_URLS_PER_INFOBOX).map(sanitizeMeta).join(' | ')}`,
      );
    }
  });

  response.results.forEach((result, index) => {
    body.push(
      '',
      `## ${index + 1}. ${sanitizeMeta(result.title) || '(untitled)'}`,
      ...(detail === 'compact'
        ? compactResultLines(result)
        : generalCategory.renderResultLines(result)),
    );
  });

  if (response.suggestions.length > 0) {
    body.push('', `Did you mean: ${response.suggestions.map(sanitizeMeta).join(', ')}`);
  }

  return wrapUntrusted(body.join('\n'));
}

export function formatFetchedPage(response: FetchResult): string {
  const lines: string[] = [];
  if (response.title) lines.push(`# ${sanitizeMeta(response.title)}`, '');
  lines.push(`Source: ${sanitizeMeta(response.finalUrl)}`);
  if (response.byline) lines.push(`Author: ${sanitizeMeta(response.byline)}`);
  lines.push(wrapUntrusted(response.content));
  return lines.join('\n').trim();
}

/** Shared category skeleton; per-result lines come from the definition (D1).
 * `detail: 'compact'` swaps them for title + URL + capped snippet. */
export function formatCategoryResults<R extends { title: string; url: string; content?: string }>(
  definition: CategoryDeclaration<R>,
  response: Pick<CategoryEnvelope<R>, 'query' | 'results' | 'suggestions'>,
  detail?: DetailLevel,
): string {
  const lines: string[] = [`# ${definition.heading} results for "${sanitizeMeta(response.query)}"`];
  const body: string[] = [];
  if (response.results.length === 0) body.push('No results.');

  response.results.forEach((result, index) => {
    body.push(
      '',
      `## ${index + 1}. ${sanitizeMeta(result.title) || '(untitled)'}`,
      ...(detail === 'compact' ? compactResultLines(result) : definition.renderResultLines(result)),
    );
  });

  if (response.suggestions.length > 0) {
    body.push('', `Did you mean: ${response.suggestions.map(sanitizeMeta).join(', ')}`);
  }

  lines.push(wrapUntrusted(body.join('\n')));
  return lines.join('\n').trim();
}

export function formatImageResults(response: ImageSearchResponse, detail?: DetailLevel): string {
  return formatCategoryResults(imageCategory, response, detail);
}

export function formatNewsResults(response: NewsSearchResponse, detail?: DetailLevel): string {
  return formatCategoryResults(newsCategory, response, detail);
}

export function formatVideoResults(response: VideoSearchResponse, detail?: DetailLevel): string {
  return formatCategoryResults(videoCategory, response, detail);
}

export function formatMusicResults(response: MusicSearchResponse, detail?: DetailLevel): string {
  return formatCategoryResults(musicCategory, response, detail);
}

export function formatListEngines(response: ListEnginesResponse): string {
  const byCategory = new Map<string, string[]>(response.categories.map((name) => [name, []]));
  for (const engine of response.engines) {
    for (const category of engine.categories) {
      byCategory.get(category)?.push(engine.name);
    }
  }
  const lines: string[] = [
    '# SearXNG instance capabilities',
    `${response.counts.engines} engines enabled across ${response.counts.categories} categories.`,
  ];
  for (const category of response.categories) {
    const names = byCategory.get(category) ?? [];
    if (names.length === 0) continue;
    lines.push(
      '',
      `**${sanitizeMeta(category)}** (${names.length}): ${names.map(sanitizeMeta).join(', ')}`,
    );
  }
  return lines.join('\n').trim();
}
