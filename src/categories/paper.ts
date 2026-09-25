import * as z from 'zod/v4';
import {
  asStringArray,
  isRecord,
  sanitizeMeta,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_AUTHOR_CHARS,
  MAX_RESULT_CONTENT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from './shared.js';
import { pickPublishedDate } from './general.js';
import { defineCategory } from './types.js';

// D2 blanket cap for paper metadata strings without a dedicated shared bound.
const MAX_PAPER_FIELD_CHARS = 1000;
const MAX_PAPER_TAGS = 10;

/** Upstream Paper payload subset read by the projector (V2). */
interface RawPaper {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  authors?: unknown;
  publishedDate?: unknown;
  date_of_publication?: unknown;
  doi?: unknown;
  journal?: unknown;
  publisher?: unknown;
  type?: unknown;
  tags?: unknown;
  pdf_url?: unknown;
  html_url?: unknown;
  engines?: unknown;
}

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  authors: z.array(z.string()).optional(),
  publishedDate: z.string().optional(),
  doi: z.string().optional(),
  journal: z.string().optional(),
  publisher: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  pdfUrl: z.string().optional(),
  htmlUrl: z.string().optional(),
  engines: z.array(z.string()).optional(),
});
type Result = z.infer<typeof resultSchema>;

function projectField(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return truncateText(value, MAX_PAPER_FIELD_CHARS);
}

function projectUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return truncateText(value, MAX_URL_CHARS);
}

function projectResult(value: unknown): Result | undefined {
  if (!isRecord(value)) return undefined;
  const raw: RawPaper = value;
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (url === '') return undefined; // a paper without a link is unusable
  const result: Result = {
    title: truncateText(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS),
    url: truncateText(url, MAX_URL_CHARS),
    content: truncateText(
      typeof raw.content === 'string' ? raw.content : '',
      MAX_RESULT_CONTENT_CHARS,
    ),
  };
  if (Array.isArray(raw.authors)) {
    const authors = asStringArray(raw.authors)
      .map((author) => truncateText(author, MAX_AUTHOR_CHARS))
      .slice(0, MAX_ARRAY_ITEMS);
    if (authors.length > 0) result.authors = authors;
  }
  const publishedDate =
    pickPublishedDate(raw.publishedDate) ?? pickPublishedDate(raw.date_of_publication);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  const doi = projectField(raw.doi);
  if (doi !== undefined) result.doi = doi;
  const journal = projectField(raw.journal);
  if (journal !== undefined) result.journal = journal;
  const publisher = projectField(raw.publisher);
  if (publisher !== undefined) result.publisher = publisher;
  const type = projectField(raw.type);
  if (type !== undefined) result.type = type;
  if (Array.isArray(raw.tags)) {
    const tags = asStringArray(raw.tags)
      .map((tag) => truncateText(tag, MAX_PAPER_FIELD_CHARS))
      .slice(0, MAX_PAPER_TAGS);
    if (tags.length > 0) result.tags = tags;
  }
  const pdfUrl = projectUrl(raw.pdf_url);
  if (pdfUrl !== undefined) result.pdfUrl = pdfUrl;
  const htmlUrl = projectUrl(raw.html_url);
  if (htmlUrl !== undefined) result.htmlUrl = htmlUrl;
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

export const paperCategory = defineCategory({
  tool: {
    name: 'paper_search',
    title: 'Paper search (SearXNG)',
    description:
      'Search scientific publications (papers, preprints, journal articles). Returns titles, abstracts, authors, journal/DOI metadata and PDF links. Supports a time_range freshness filter.',
  },
  upstream: { categories: ['scientific publications'], supportsTimeRange: true },
  heading: 'Paper',
  resultSchema,
  projectResult,
  renderResultLines: (result) => {
    const lines: string[] = [];
    if (result.authors && result.authors.length > 0)
      lines.push(`_authors: ${sanitizeMeta(result.authors.join(', '))}_`);
    const venue: string[] = [];
    if (result.journal) venue.push(sanitizeMeta(result.journal));
    if (result.doi) venue.push(`doi: ${sanitizeMeta(result.doi)}`);
    if (venue.length > 0) lines.push(`_${venue.join(' · ')}_`);
    if (result.content) lines.push('', result.content);
    if (result.pdfUrl) lines.push('', `PDF: ${sanitizeMeta(result.pdfUrl)}`);
    lines.push(`Page: ${sanitizeMeta(result.url)}`);
    const meta: string[] = [];
    if (result.type) meta.push(sanitizeMeta(result.type));
    if (result.publisher) meta.push(sanitizeMeta(result.publisher));
    if (result.publishedDate) meta.push(`published: ${sanitizeMeta(result.publishedDate)}`);
    if (result.tags && result.tags.length > 0)
      meta.push(`tags: ${sanitizeMeta(result.tags.join(', '))}`);
    if (result.engines && result.engines.length > 0)
      meta.push(`engines: ${sanitizeMeta(result.engines.join(', '))}`);
    if (meta.length > 0) lines.push('', `_${meta.join(' · ')}_`);
    return lines;
  },
});
