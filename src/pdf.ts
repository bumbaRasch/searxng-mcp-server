// PDF branch of fetch_content (D4): unpdf's serverless pdf.js build — no native
// deps, no worker config. readCapped() decodes UTF-8, which loses binary bytes,
// so PDF responses are read as capped raw bytes here instead.
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import type { HttpResponseLike } from './http.js';

export interface PdfExtraction {
  content: string;
  pages: number;
  title?: string;
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

function byteLimitError(limit: number): Error {
  return new Error(`Response exceeds the ${limit} byte limit.`);
}

export async function readPdfResponse(
  response: HttpResponseLike,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PDF response has no readable body stream.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw byteLimitError(limit);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Metadata is best-effort (D4): a broken Info dictionary never fails the tool.
async function pdfTitle(pdf: PdfDocument): Promise<string | undefined> {
  try {
    const { info } = await getMeta(pdf);
    const title = info['Title'];
    if (typeof title !== 'string') return undefined;
    const trimmed = title.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

export async function extractPdfContent(data: Uint8Array): Promise<PdfExtraction> {
  // Fresh copy: pdf.js may transfer the backing buffer it is handed.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    // mergePages: false documents a per-page array; tolerate a merged string.
    const pages = typeof text === 'string' ? [text] : text;
    const sections = pages.map((page, index) => `[Page ${index + 1}]\n${page.trim()}`);
    const result: PdfExtraction = { content: sections.join('\n\n'), pages: totalPages };
    const title = await pdfTitle(pdf);
    if (title) result.title = title;
    return result;
  } finally {
    // getDocumentProxy proxies are caller-owned (unpdf docs): release the parse.
    try {
      await pdf.loadingTask.destroy();
    } catch {
      // destroy is best-effort cleanup.
    }
  }
}
