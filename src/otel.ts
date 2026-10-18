/**
 * OTel trace-context passthrough (Stage 7, SEP-414): when a request carries a
 * W3C `traceparent` in its per-request `_meta` envelope, the same context is
 * attached to the outbound SearXNG and page-fetch calls as a `traceparent`
 * header. Opt-in by construction: absent context leaves every wire shape
 * unchanged. The context rides Node's AsyncLocalStorage, so handlers need no
 * signature changes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isRecord } from './categories/shared.js';

const context = new AsyncLocalStorage<{ traceparent: string }>();

/** W3C traceparent: version(2)-traceId(32)-parentId(16)-flags(2). */
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Validated traceparent from a request's `_meta` envelope; anything else is
 * ignored (never forwarded, never forged). */
export function extractTraceparent(envelope: unknown): string | undefined {
  if (!isRecord(envelope)) return undefined;
  const raw = envelope.traceparent;
  if (typeof raw !== 'string' || !TRACEPARENT_PATTERN.test(raw)) return undefined;
  return raw;
}

export async function runWithTraceContext<T>(envelope: unknown, run: () => Promise<T>): Promise<T> {
  const traceparent = extractTraceparent(envelope);
  if (traceparent === undefined) return run();
  return context.run({ traceparent }, run);
}

/** The in-flight request's validated traceparent, when present. */
export function currentTraceparent(): string | undefined {
  return context.getStore()?.traceparent;
}

/** The trace header for an outbound request, or undefined when no context. */
export function traceHeaders(): Record<string, string> | undefined {
  const traceparent = currentTraceparent();
  return traceparent === undefined ? undefined : { traceparent };
}
