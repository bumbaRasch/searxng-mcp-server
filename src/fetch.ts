// Same undici copy as the guarded dispatcher in ssrf.ts — a different copy's
// fetch would ignore the guarded `lookup` when opening the socket.
import { fetch as undiciFetch } from 'undici';
import type { Config } from './config.js';
import { extractArticle, stripToText } from './extract.js';
import { isRedirect, readCapped, type FetchLike } from './http.js';
import { toMarkdown, truncateWithMarker } from './markdown.js';
import type { FetchResult } from './schemas.js';
import { assertUrlAllowed, createGuardedDispatcher, type LookupAll } from './ssrf.js';

interface FetchOptions {
  maxChars?: number | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchLike | undefined;
  lookup?: LookupAll | undefined;
}

export const MAX_REDIRECTS = 5;
const MAX_CONTENT_TYPE_CHARS = 100;
// Exact tokens with a parameter boundary: prefix siblings like xml-dtd or
// jsonp are NOT textual; any application/*+xml (rss, atom, xhtml, svg…) is.
const ALLOWED_CONTENT_TYPE = /^(text\/[\w.+-]*|application\/(json|xml|[\w.+-]+\+xml))\s*(;|$)/i;

export class FetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
  }
}

export async function fetchContent(
  config: Config,
  rawUrl: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  // Cast bridges @types/node's vendored RequestInit and undici's own types
  // (two structural copies of the same dispatcher interface).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fetchImpl: FetchLike = opts.fetchImpl ?? (undiciFetch as FetchLike);
  const maxChars = opts.maxChars ?? config.maxChars;
  const timeoutMs = opts.timeoutMs ?? config.fetchTimeoutMs;
  const lookupOpts = opts.lookup ? { lookup: opts.lookup } : {};
  // Pre-validation and the dispatcher share the same guarded lookup, so both
  // see the same addresses (anti-rebind).
  const dispatcher = createGuardedDispatcher({
    allowPrivateHosts: config.allowPrivateHosts,
    ...lookupOpts,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let initialScheme: string | undefined;
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = await assertUrlAllowed(current, {
        allowPrivateHosts: config.allowPrivateHosts,
        ...lookupOpts,
      });
      if (initialScheme === undefined) initialScheme = url.protocol;
      if (initialScheme === 'https:' && url.protocol === 'http:') {
        throw new FetchError(
          `Refusing to downgrade ${initialScheme.replace(':', '')} to http on redirect.`,
        );
      }
      const response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': config.userAgent, Accept: 'text/html,application/xhtml+xml' },
        dispatcher,
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location)
          throw new FetchError(`Redirect without a Location header from ${url.toString()}.`);
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new FetchError(`Failed to fetch ${url.toString()}: HTTP ${response.status}.`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType !== '' && !ALLOWED_CONTENT_TYPE.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new FetchError(
          `Refusing to fetch ${url.toString()}: unsupported Content-Type "${contentType.slice(0, MAX_CONTENT_TYPE_CHARS)}".`,
        );
      }

      const html = await readCapped(response, config.maxResponseBytes);
      const article = extractArticle(html, url.toString());
      const markdown = article.contentHtml
        ? toMarkdown(article.contentHtml)
        : stripToText(article.textContent ?? html);
      const { content, truncated } = truncateWithMarker(markdown, maxChars);

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
    throw new FetchError(`Too many redirects (max ${MAX_REDIRECTS}).`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new FetchError(`Timed out after ${timeoutMs} ms while fetching ${rawUrl}.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await dispatcher.close().catch(() => undefined);
  }
}
