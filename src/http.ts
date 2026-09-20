export interface HttpResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown },
) => Promise<HttpResponseLike>;

function byteLimitError(limit: number): Error {
  return new Error(`Response exceeds the ${limit} byte limit.`);
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export async function readCapped(response: HttpResponseLike, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limit) throw byteLimitError(limit);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw byteLimitError(limit);
    }
    return text;
  }
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
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}
