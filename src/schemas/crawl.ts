/** crawl_site: BFS-crawl a site into a manifest with cached content (Stage 3). */
import * as z from 'zod/v4';

export const crawlInput = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe('The seed URL; same-origin links are followed from it.'),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe('Maximum pages to fetch (1-30, default 10).'),
});
export type CrawlInput = z.infer<typeof crawlInput>;

export const crawlOutput = z.object({
  seed: z.string(),
  crawled: z.number().int().nonnegative(),
  pages: z.array(
    z.object({
      ref: z.number().int().positive(),
      url: z.string(),
      title: z.string(),
      snippet: z.string(),
    }),
  ),
});
export type CrawlResponse = z.infer<typeof crawlOutput>;
