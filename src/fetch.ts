import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
// undici's fetch + Agent must come from the same installed copy so the guarded
// `lookup` handed to the dispatcher is honored by the client opening the socket.
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from './config.js';
import { readCapped, type FetchLike } from './http.js';
import { assertUrlAllowed, createGuardedLookup, type LookupAll } from './ssrf.js';
import type { FetchResult } from './types.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

function tightenListMarkers(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/^(\s*)[-*+][ \t]+/, '$1- ');
    })
    .join('\n');
}

interface WalkNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<WalkNode>;
  tagName?: string;
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'ARTICLE',
  'TR',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'PRE',
  'UL',
  'OL',
  'TABLE',
  'BR',
]);

function collectText(node: WalkNode, out: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out.push(child.textContent ?? '');
    } else if (child.nodeType === 1) {
      const isBlock = BLOCK_TAGS.has((child.tagName ?? '').toUpperCase());
      if (isBlock) out.push('\n');
      collectText(child, out);
      if (isBlock) out.push('\n');
    }
  }
}

const TRUNCATION_MARKER = '\n\n[Content truncated]';

export function extractArticle(
  html: string,
  _url: string,
): { title?: string; byline?: string; contentHtml?: string; textContent?: string } {
  if (html.trim() === '') return {};
  const { document } = parseHTML(html);
  const reader = new Readability(document, { charThreshold: 0 });
  const article = reader.parse();
  if (!article) return {};
  const result: {
    title?: string;
    byline?: string;
    contentHtml?: string;
    textContent?: string;
  } = {};
  if (article.title) result.title = article.title;
  if (article.byline) result.byline = article.byline;
  if (article.content) result.contentHtml = article.content;
  if (article.textContent) result.textContent = article.textContent;
  return result;
}

export function stripToText(html: string): string {
  if (html.trim() === '') return '';
  const { document } = parseHTML(html);
  const body = document.body;
  const root = body && body.childNodes.length > 0 ? body : (document.documentElement ?? body);
  const out: string[] = [];
  if (root) collectText(root, out);
  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toMarkdown(html: string): string {
  return tightenListMarkers(turndown.turndown(html)).trim();
}

export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { content: text, truncated: false };
  const budget = Math.max(0, limit - TRUNCATION_MARKER.length);
  const suffix = TRUNCATION_MARKER.length <= limit ? TRUNCATION_MARKER : '';
  return { content: `${text.slice(0, budget)}${suffix}`, truncated: true };
}

export interface FetchOptions {
  maxChars?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  lookup?: LookupAll;
}

const MAX_REDIRECTS = 5;

export async function fetchContent(
  config: Config,
  rawUrl: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? undiciFetch;
  const maxChars = opts.maxChars ?? config.maxChars;
  const timeoutMs = opts.timeoutMs ?? config.fetchTimeoutMs;
  const lookupOpts = opts.lookup ? { lookup: opts.lookup } : {};
  // ONE guarded lookup shared by pre-validation and the dispatcher, so DNS is
  // resolved once per host and both paths see the same addresses (anti-rebind).
  const lookup = createGuardedLookup({
    allowPrivateHosts: config.allowPrivateHosts,
    ...lookupOpts,
  });
  // Cast unavoidable: undici's connect.lookup type is narrower than the guarded
  // callback signature (same pattern as createGuardedDispatcher in ssrf.ts).
  const dispatcher = new Agent({ connect: { lookup: lookup as never } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const initialScheme = new URL(rawUrl).protocol;
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = await assertUrlAllowed(current, {
        allowPrivateHosts: config.allowPrivateHosts,
        ...lookupOpts,
      });
      if (initialScheme === 'https:' && url.protocol === 'http:') {
        throw new Error(`Refusing to downgrade ${initialScheme} to http on redirect.`);
      }
      const response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': config.userAgent, Accept: 'text/html,application/xhtml+xml' },
        dispatcher,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location)
          throw new Error(`Redirect without a Location header from ${url.toString()}.`);
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url.toString()}: HTTP ${response.status}.`);
      }

      const html = await readCapped(response, config.maxResponseBytes);
      const article = extractArticle(html, url.toString());
      const markdown = article.contentHtml
        ? toMarkdown(article.contentHtml)
        : stripToText(article.textContent ?? html);
      const { content, truncated } = truncate(markdown, maxChars);

      const result: FetchResult = {
        url: rawUrl,
        finalUrl: url.toString(),
        content,
        truncated,
      };
      if (article.title) result.title = article.title;
      if (article.byline) result.byline = article.byline;
      return result;
    }
    throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
  } finally {
    clearTimeout(timer);
    await dispatcher.close().catch(() => undefined);
  }
}
