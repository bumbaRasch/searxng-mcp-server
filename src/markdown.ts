import TurndownService from 'turndown';

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

export function toMarkdown(html: string): string {
  return tightenListMarkers(turndown.turndown(html)).trim();
}

const TRUNCATION_MARKER = '\n\n[Content truncated]';

export function truncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { content: text, truncated: false };
  const budget = Math.max(0, limit - TRUNCATION_MARKER.length);
  const suffix = TRUNCATION_MARKER.length <= limit ? TRUNCATION_MARKER : '';
  return { content: `${text.slice(0, budget)}${suffix}`, truncated: true };
}
