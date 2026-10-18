/**
 * Instance doctor: probes the primary SearXNG and reports structured checks —
 * JSON API availability, /config reachability, unresponsive engines on a probe
 * search, and limiter state. Diagnoses the primary instance only (probeInstanceJson
 * does not fail over): a failover probe would report a healthy replica, not the
 * configured instance the operator asked about.
 */

import { isRecord, sanitizeMeta } from './categories/shared.js';
import type { Config } from './config.js';
import type { DoctorResponse } from './schemas.js';
import {
  mapEnginesResponse,
  probeInstanceJson,
  SearxngError,
  type ClientOptions,
} from './searxng.js';

const PROBE_QUERY = 'searxng';

function describeError(error: unknown): string {
  return sanitizeMeta(error instanceof Error ? error.message : String(error));
}

function unresponsiveEngineNames(body: unknown): string[] {
  const data = isRecord(body) ? body : {};
  const pairs = Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : [];
  return pairs
    .map((pair) => (Array.isArray(pair) && typeof pair[0] === 'string' ? pair[0] : null))
    .filter((name): name is string => name !== null);
}

export async function runDoctor(config: Config, opts: ClientOptions = {}): Promise<DoctorResponse> {
  const checks: DoctorResponse['checks'] = [];

  // /config probe: reachability, engine inventory, limiter + version state.
  let limiterOn = false;
  try {
    const raw = await probeInstanceJson(config, '/config', opts);
    const data = isRecord(raw) ? raw : {};
    limiterOn = data.limiter === true;
    const version = typeof data.version === 'string' ? data.version : '';
    const counts = mapEnginesResponse(raw).counts;
    checks.push({
      id: 'config_endpoint',
      ok: true,
      detail: `reachable — ${counts.engines} engines across ${counts.categories} categories${
        version !== '' ? `, instance version ${sanitizeMeta(version)}` : ''
      }`,
    });
  } catch (error) {
    checks.push({ id: 'config_endpoint', ok: false, detail: describeError(error) });
  }

  // Search probe: JSON API availability + engine responsiveness.
  let probeBody: unknown;
  let probeError: unknown;
  try {
    probeBody = await probeInstanceJson(
      config,
      `/search?q=${encodeURIComponent(PROBE_QUERY)}&format=json`,
      opts,
    );
  } catch (error) {
    probeError = error;
  }

  if (probeError === undefined) {
    checks.push({ id: 'json_api', ok: true, detail: 'answers with JSON results' });
    const unresponsive = unresponsiveEngineNames(probeBody);
    checks.push(
      unresponsive.length === 0
        ? {
            id: 'unresponsive_engines',
            ok: true,
            detail: 'every engine responded on the probe search',
          }
        : {
            id: 'unresponsive_engines',
            ok: false,
            detail: `unresponsive on the probe search: ${unresponsive.map(sanitizeMeta).join(', ')}`,
          },
    );
    checks.push({
      id: 'limiter',
      ok: true,
      detail: limiterOn
        ? 'enabled — the instance rate-limits suspicious traffic'
        : 'disabled — no rate limiting configured',
    });
  } else {
    const status = probeError instanceof SearxngError ? probeError.status : undefined;
    if (status === 403) {
      checks.push({
        id: 'json_api',
        ok: false,
        detail:
          'HTTP 403 — the JSON API is disabled (or a limiter blocked the probe). Add "json" to search.formats in settings.yml.',
      });
    } else if (status === 429) {
      checks.push({
        id: 'json_api',
        ok: false,
        detail: 'HTTP 429 — the instance rate-limited the probe search.',
      });
      checks.push({
        id: 'limiter',
        ok: false,
        detail: 'rate-limited the probe (HTTP 429); requests may be throttled.',
      });
    } else {
      checks.push({ id: 'json_api', ok: false, detail: describeError(probeError) });
    }
  }

  return { healthy: checks.every((check) => check.ok), checks };
}
