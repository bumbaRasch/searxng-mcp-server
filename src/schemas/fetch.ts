import * as z from 'zod/v4';

export const fetchInput = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      'The absolute http/https URL to fetch, or ref:N to fetch the source registered as ref N on a previous search result (session-scoped; see the ref field on search results).',
    ),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .describe('Maximum characters to return (overrides MAX_CHARS).'),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(120_000)
    .optional()
    .describe('Request timeout in milliseconds (at most 120000).'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset into the extracted content, to continue reading via nextOffset.'),
  outline: z
    .boolean()
    .optional()
    .describe(
      'Also return headings ([{text, offset, level}]: markdown #-lines; [Page N] markers for PDFs) with offsets into the scanned content.',
    ),
  section: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Return only one heading region: case-insensitive exact heading match, through the next same-or-higher-level heading.',
    ),
  archive: z
    .boolean()
    .optional()
    .describe(
      'Fall back to the closest Internet Archive snapshot when the page is dead (404/410/5xx, unreachable or timed out). Overrides SEARXNG_ARCHIVE_FALLBACK.',
    ),
});
export type FetchInput = z.infer<typeof fetchInput>;

export const fetchOutput = z.object({
  url: z.string(),
  finalUrl: z.string(),
  title: z.string().optional(),
  byline: z.string().optional(),
  content: z.string(),
  truncated: z.boolean(),
  // Present only when the fetched resource was a PDF (D4).
  pages: z.number().int().positive().optional(),
  // Present only when content remains beyond the returned window (D5).
  nextOffset: z.number().int().nonnegative().optional(),
  // Present only when outline was requested (D14); offsets index the scanned
  // content — the full document, or the section when section is given.
  headings: z
    .array(
      z.object({
        text: z.string(),
        offset: z.number().int().nonnegative(),
        level: z.number().int().min(1).max(6),
      }),
    )
    .optional(),
  // Present when the content came from an Internet Archive snapshot (Stage 3).
  archived: z.boolean().optional(),
});
export type FetchResult = z.infer<typeof fetchOutput>;
