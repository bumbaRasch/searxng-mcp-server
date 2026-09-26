import { parseHTML } from 'linkedom';

/** Hard cap on HTML-parsed results (D13): the page is untrusted markup. */
export const MAX_HTML_RESULTS = 30;

/** Field names mirror the JSON API so the shared web projector consumes the payload unchanged. */
export interface ParsedHtmlResult {
  title: string;
  url: string;
  content: string;
  engines?: string[];
  publishedDate?: string;
}

export interface ParsedHtmlPayload {
  query: string;
  results: ParsedHtmlResult[];
}

/** Minimal DOM seam over linkedom nodes, which are untyped for our purposes (see extract.ts). */
interface HtmlElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): HtmlElement | null;
  querySelectorAll(selector: string): ArrayLike<HtmlElement>;
  readonly textContent: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Parse one `article.result` per V7 (simple theme): `h3 > a[href]` for the real
 * URL and title, `p.content` snippet, `div.engines > span` engines,
 * `time.published_date[datetime]` date. Items without a usable link are dropped. */
function parseResult(article: HtmlElement): ParsedHtmlResult | undefined {
  const link = article.querySelector('h3 > a[href]');
  const url = link?.getAttribute('href')?.trim();
  if (!link || url === undefined || url === '') return undefined;
  const result: ParsedHtmlResult = {
    title: collapseWhitespace(link.textContent),
    url,
    content: collapseWhitespace(article.querySelector('p.content')?.textContent ?? ''),
  };
  const engines = Array.from(article.querySelectorAll('div.engines > span'))
    .map((span) => collapseWhitespace(span.textContent))
    .filter((engine) => engine !== '');
  if (engines.length > 0) result.engines = engines;
  const datetime = article.querySelector('time.published_date')?.getAttribute('datetime')?.trim();
  if (datetime !== undefined && datetime !== '') result.publishedDate = datetime;
  return result;
}

/** Parse a SearXNG `simple`-theme result page into the JSON-API result shape (D13).
 * Malformed/dirty items are dropped defensively; output is capped at MAX_HTML_RESULTS. */
export function parseSearchResultsHtml(html: string, query: string): ParsedHtmlPayload {
  const { document } = parseHTML(html);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const articles = Array.from(document.querySelectorAll('article.result')) as HtmlElement[];
  const results: ParsedHtmlResult[] = [];
  for (const article of articles) {
    if (results.length >= MAX_HTML_RESULTS) break;
    const parsed = parseResult(article);
    if (parsed !== undefined) results.push(parsed);
  }
  return { query, results };
}
