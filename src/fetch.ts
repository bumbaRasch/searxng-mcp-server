// undici's fetch must come from the same installed copy as the guarded
// dispatcher (built in ssrf.ts) so the guarded `lookup` handed to the
// dispatcher is honored by the client opening the socket.
import { fetch as undiciFetch } from 'undici';
import type { Config } from './config.js';
import { extractArticle, stripToText } from './extract.js';
import { readCapped, type FetchLike } from './http.js';
import { toMarkdown, truncate } from './markdown.js';
import type { FetchResult } from './schemas.js';
import { assertUrlAllowed, createGuardedDispatcher, type LookupAll } from './ssrf.js';

export interface FetchOptions {
  maxChars?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  lookup?: LookupAll;
}

export const MAX_REDIRECTS = 5;

export async function fetchContent(
  config: Config,
  rawUrl: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const fetchImpl = opts.fetchImpl ?? undiciFetch;
  const maxChars = opts.maxChars ?? config.maxChars;
  const timeoutMs = opts.timeoutMs ?? config.fetchTimeoutMs;
  const lookupOpts = opts.lookup ? { lookup: opts.lookup } : {};
  // Pre-validation (assertUrlAllowed) and the guarded dispatcher both apply the
  // same SSRF guard to the same underlying lookup, so both paths see the same
  // validated addresses (anti-rebind).
  const dispatcher = createGuardedDispatcher({
    allowPrivateHosts: config.allowPrivateHosts,
    ...lookupOpts,
  });

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
        throw new Error(
          `Refusing to downgrade ${initialScheme.replace(':', '')} to http on redirect.`,
        );
      }
      const response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': config.userAgent, Accept: 'text/html,application/xhtml+xml' },
        dispatcher,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location)
          throw new Error(`Redirect without a Location header from ${url.toString()}.`);
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
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
