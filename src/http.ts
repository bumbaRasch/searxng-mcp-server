export interface HttpResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<HttpResponseLike>;

export async function readCapped(response: HttpResponseLike, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw new Error(`Response exceeds the ${limit} byte limit.`);
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
        throw new Error(`Response exceeds the ${limit} byte limit.`);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}
