import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

interface WalkNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<WalkNode>;
  tagName?: string;
}

interface DomElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): unknown;
  removeAttribute(name: string): unknown;
  remove(): unknown;
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

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function collectText(node: WalkNode, out: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      out.push(child.textContent ?? '');
    } else if (child.nodeType === ELEMENT_NODE) {
      const tag = (child.tagName ?? '').toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) out.push('\n');
      collectText(child, out);
      if (isBlock) out.push('\n');
    }
  }
}

/** Absolutize one URL-valued attribute against the page's final URL;
 * mailto:/tel: pass through, dangerous schemes (javascript:, data:) are removed. */
function absolutizeAttribute(element: DomElement, attribute: string, baseUrl: string): void {
  const value = element.getAttribute(attribute);
  if (value === null || /^\s*(mailto:|tel:)/i.test(value)) return;
  try {
    const resolved = new URL(value, baseUrl);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      element.setAttribute(attribute, resolved.toString());
    } else {
      element.removeAttribute(attribute);
    }
  } catch {
    element.removeAttribute(attribute);
  }
}

/** Strip junk and absolutize link/image URLs so the Markdown works without the base URL. */
export function cleanContentHtml(html: string, baseUrl: string): string {
  // Readability emits fragments without <body>, and linkedom drops fragment
  // content unless it is wrapped in a document first.
  const source = /<body[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><body>${html}</body></html>`;
  const { document } = parseHTML(source);
  // linkedom's NodeList elements are structurally compatible but untyped for
  // our minimal DOM seam; the cast is confined to this one accessor.
  const select = (selector: string): DomElement[] =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Array.from(document.querySelectorAll(selector)) as unknown as DomElement[];
  for (const element of select('script, style, noscript, template')) {
    element.remove();
  }
  for (const element of select('a[href]')) {
    absolutizeAttribute(element, 'href', baseUrl);
  }
  for (const element of select('img[src], source[src]')) {
    absolutizeAttribute(element, 'src', baseUrl);
  }
  return document.body ? document.body.innerHTML : html;
}

interface ExtractedArticle {
  title?: string;
  byline?: string;
  contentHtml?: string;
  textContent?: string;
}

export function extractArticle(html: string, url: string): ExtractedArticle {
  if (html.trim() === '') return {};
  const { document } = parseHTML(html);
  // charThreshold: 0 keeps articles the 500-char default would reject.
  const reader = new Readability(document, { charThreshold: 0 });
  const article = reader.parse();
  if (!article) return {};
  const result: ExtractedArticle = {};
  if (article.title) result.title = article.title;
  if (article.byline) result.byline = article.byline;
  if (article.content) result.contentHtml = cleanContentHtml(article.content, url);
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
