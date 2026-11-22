import * as z from 'zod/v4';
import { rerankResults } from '../rerank.js';
import {
  asStringArray,
  isRecord,
  sanitizeMeta,
  truncateText,
  MAX_ARRAY_ITEMS,
  MAX_AUTHOR_CHARS,
  MAX_RESULT_CONTENT_CHARS,
  MAX_SOURCE_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from './shared.js';
import { pickPublishedDate } from './general.js';
import { defineCategory } from './types.js';

const MAX_CODE_TAGS = 10;

/** Upstream `packages.html` payload subset (github, docker hub, pypi, …); Q&A and
 * docs results only carry the base title/url/content fields. */
interface RawCode {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  package_name?: unknown;
  version?: unknown;
  maintainer?: unknown;
  popularity?: unknown;
  license_name?: unknown;
  license_url?: unknown;
  tags?: unknown;
  homepage?: unknown;
  source_code_url?: unknown;
  publishedDate?: unknown;
  engines?: unknown;
}

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  packageName: z.string().optional(),
  version: z.string().optional(),
  maintainer: z.string().optional(),
  popularity: z.string().optional(),
  license: z.string().optional(),
  licenseUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  sourceCodeUrl: z.string().optional(),
  publishedDate: z.string().optional(),
  engines: z.array(z.string()).optional(),
});
type Result = z.infer<typeof resultSchema>;

function projectField(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return truncateText(value, max);
}

/** github sends stars as a number, docker hub a "5M+ pulls, 5 stars" string. */
function projectPopularity(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return projectField(value, MAX_SOURCE_CHARS);
}

function projectResult(value: unknown): Result | undefined {
  if (!isRecord(value)) return undefined;
  const raw: RawCode = value;
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (url === '') return undefined;
  const result: Result = {
    title: truncateText(typeof raw.title === 'string' ? raw.title : '', MAX_TITLE_CHARS),
    url: truncateText(url, MAX_URL_CHARS),
    content: truncateText(
      typeof raw.content === 'string' ? raw.content : '',
      MAX_RESULT_CONTENT_CHARS,
    ),
  };
  const packageName = projectField(raw.package_name, MAX_SOURCE_CHARS);
  if (packageName !== undefined) result.packageName = packageName;
  const version = projectField(raw.version, MAX_SOURCE_CHARS);
  if (version !== undefined) result.version = version;
  const maintainer = projectField(raw.maintainer, MAX_AUTHOR_CHARS);
  if (maintainer !== undefined) result.maintainer = maintainer;
  const popularity = projectPopularity(raw.popularity);
  if (popularity !== undefined) result.popularity = popularity;
  const license = projectField(raw.license_name, MAX_SOURCE_CHARS);
  if (license !== undefined) result.license = license;
  const licenseUrl = projectField(raw.license_url, MAX_URL_CHARS);
  if (licenseUrl !== undefined) result.licenseUrl = licenseUrl;
  const homepage = projectField(raw.homepage, MAX_URL_CHARS);
  if (homepage !== undefined) result.homepage = homepage;
  const sourceCodeUrl = projectField(raw.source_code_url, MAX_URL_CHARS);
  if (sourceCodeUrl !== undefined) result.sourceCodeUrl = sourceCodeUrl;
  const publishedDate = pickPublishedDate(raw.publishedDate);
  if (publishedDate !== undefined) result.publishedDate = publishedDate;
  if (Array.isArray(raw.tags)) {
    const tags = asStringArray(raw.tags)
      .map((tag) => truncateText(tag, MAX_SOURCE_CHARS))
      .slice(0, MAX_CODE_TAGS);
    if (tags.length > 0) result.tags = tags;
  }
  if (Array.isArray(raw.engines))
    result.engines = asStringArray(raw.engines).slice(0, MAX_ARRAY_ITEMS);
  return result;
}

export const codeCategory = defineCategory({
  tool: {
    name: 'code_search',
    title: 'Code search (SearXNG)',
    description:
      'Search software sources: code repositories, packages and container images (GitHub, PyPI, Docker Hub), developer docs (MDN, man pages, distro wikis) and programming Q&A (Stack Overflow and similar). Results are reranked by query relevance; package results carry license, maintainer, popularity and source links. Repository/package engines return one page only. For general web pages use search; for papers use paper_search.',
  },
  // None of the it/q&a engines support time_range: SearXNG would skip them all.
  upstream: { categories: ['it', 'q&a'], supportsTimeRange: false },
  heading: 'Code',
  resultSchema,
  projectResult,
  // Upstream scores rank off-topic Q&A above exact repo/package hits.
  rank: (query, results, opts) => rerankResults(query, results, opts),
  renderResultLines: (result) => {
    const lines: string[] = [];
    const pkg: string[] = [];
    if (result.packageName) pkg.push(sanitizeMeta(result.packageName));
    if (result.version) pkg.push(sanitizeMeta(result.version));
    if (result.license) pkg.push(sanitizeMeta(result.license));
    if (result.popularity) pkg.push(`popularity: ${sanitizeMeta(result.popularity)}`);
    if (result.maintainer) pkg.push(`by ${sanitizeMeta(result.maintainer)}`);
    if (pkg.length > 0) lines.push(`_${pkg.join(' · ')}_`);
    if (result.content) lines.push('', result.content);
    lines.push('');
    if (result.sourceCodeUrl) lines.push(`Source: ${sanitizeMeta(result.sourceCodeUrl)}`);
    if (result.homepage) lines.push(`Homepage: ${sanitizeMeta(result.homepage)}`);
    lines.push(`Page: ${sanitizeMeta(result.url)}`);
    const meta: string[] = [];
    if (result.tags && result.tags.length > 0)
      meta.push(`tags: ${sanitizeMeta(result.tags.join(', '))}`);
    if (result.publishedDate) meta.push(`published: ${sanitizeMeta(result.publishedDate)}`);
    if (result.engines && result.engines.length > 0)
      meta.push(`engines: ${sanitizeMeta(result.engines.join(', '))}`);
    if (meta.length > 0) lines.push('', `_${meta.join(' · ')}_`);
    return lines;
  },
});
