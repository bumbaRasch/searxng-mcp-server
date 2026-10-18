/**
 * Opt-in Wayback fallback for dead links (Stage 3): when a target turns out
 * dead or unreachable, query the Internet Archive availability API and retry
 * through the closest archived snapshot. The snapshot URL itself goes through
 * the full SSRF-guarded pipeline. Policy refusals (private hosts, unsupported
 * content types, scheme downgrades) never trigger the fallback — the archive
 * must not become a way around the guard.
 */

import { isRecord } from './categories/shared.js';
import { FetchError } from './fetch.js';
import type { FetchLike } from './http.js';

const AVAILABILITY_ENDPOINT = 'https://archive.org/wayback/available';
const AVAILABILITY_TIMEOUT_MS = 10_000;

const GUARD_REFUSAL = /Refusing to fetch|private or reserved|not allowed/i;

function isGuardRefusal(error: unknown, depth = 2): boolean {
  if (depth < 0 || !(error instanceof Error)) return false;
  if (GUARD_REFUSAL.test(error.message)) return true;
  return isGuardRefusal(error.cause, depth - 1);
}

/** True for failures a snapshot can plausibly fix: the target is gone
 * (404/410/5xx), unreachable, or timed out. Deliberately message-based —
 * policy refusals never carry these signatures. */
export function isDeadLinkError(error: unknown): boolean {
  // Undici wraps a refused guarded lookup (anti-rebind window: pre-validation
  // passed, connect-time lookup refused) in TypeError('fetch failed'), which
  // matches the dead-link signature below; a policy refusal must not be
  // routed through archive.org. Two cause levels cover undici's wrapping.
  if (isGuardRefusal(error)) return false;
  if (error instanceof FetchError) {
    const status = /HTTP (\d{3})/.exec(error.message);
    if (status !== null) {
      const code = Number(status[1]);
      return code === 404 || code === 410 || code >= 500;
    }
    return error.message.startsWith('Timed out');
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|fetch failed)\b/i.test(message);
}

/** Defensive read of the availability payload: an unusable body means no fallback. */
function closestSnapshotUrl(parsed: unknown): string | undefined {
  const snapshots =
    isRecord(parsed) && isRecord(parsed.archived_snapshots) ? parsed.archived_snapshots : {};
  const closest = isRecord(snapshots.closest) ? snapshots.closest : {};
  if (closest.available === true && typeof closest.url === 'string' && closest.url !== '') {
    return closest.url;
  }
  return undefined;
}

export async function findArchivedSnapshot(
  url: string,
  fetchImpl?: FetchLike,
): Promise<string | undefined> {
  // Cast bridges @types/node's vendored RequestInit and undici's own types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const impl: FetchLike = fetchImpl ?? (fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
  try {
    const response = await impl(`${AVAILABILITY_ENDPOINT}?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return closestSnapshotUrl(JSON.parse(await response.text()));
  } catch {
    // No snapshot answer = no fallback; the original error stands.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
