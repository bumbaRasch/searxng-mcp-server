# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-09-26

### Added

- Declarative category registry ([#30](https://github.com/bumbaRasch/searxng-mcp-server/pull/30), [#32](https://github.com/bumbaRasch/searxng-mcp-server/pull/32)): a search tool is now one `defineCategory` file in `src/categories/` (tool metadata, upstream categories, `supportsTimeRange` flag, result zod schema, defensive projector, per-result markdown lines); input schemas, the output envelope (`query`/`results`/`suggestions`/`unresponsiveEngines`), handlers, renderer and registration are generated from it. `TOOL_NAMES` is derived; `search` keeps its bespoke answers/corrections/infoboxes envelope on top of its registry entry.
- `paper_search` tool ([#34](https://github.com/bumbaRasch/searxng-mcp-server/pull/34)): scientific-publications category (arxiv and peers) — titles, abstracts, authors, journal/DOI metadata and direct PDF/page links, with a `time_range` freshness filter.
- `autocomplete` tool ([#35](https://github.com/bumbaRasch/searxng-mcp-server/pull/35)): query suggestions via SearXNG's `/autocompleter` (flat-array contract with `X-Requested-With: XMLHttpRequest`), capped at 20 suggestions of 200 chars; suggestions follow the instance's configured language; dedicated 403/429 limiter messages.
- Text-PDF reading in `fetch_content` ([#37](https://github.com/bumbaRasch/searxng-mcp-server/pull/37)): `application/pdf` joins the content-type allowlist; text is extracted per page via `unpdf` and rendered as `[Page N]` sections; the output gains `pages` and a best-effort metadata `title`. SSRF/redirect/size caps unchanged.
- Offset continuation in `fetch_content` ([#39](https://github.com/bumbaRasch/searxng-mcp-server/pull/39)): new `offset` input (int ≥ 0) windows the extracted content — HTML and PDF alike; the output gains `nextOffset`, present exactly when content remains beyond the returned window.
- Passive `/healthz` liveness endpoint for the HTTP transport ([#33](https://github.com/bumbaRasch/searxng-mcp-server/pull/33)): `GET /healthz` answers `200 {"status":"ok"}` without a bearer token and without probing SearXNG (Host/Origin validation still applies) — for compose, Kubernetes and load-balancer probes. stdio mode is unaffected.
- Instance failover via `SEARXNG_URLS` ([#36](https://github.com/bumbaRasch/searxng-mcp-server/pull/36)): comma-separated failover instances tried in order after `SEARXNG_URL` on network errors, timeouts, 5xx, 429 and 403 — never on 400 (a request error would fail everywhere); exhaustion surfaces the last error. Applies to the search family, `autocomplete` and `/config`; never to `fetch_content`.
- Opt-in response cache via `SEARXNG_CACHE_TTL_MS` ([#36](https://github.com/bumbaRasch/searxng-mcp-server/pull/36)): default `0` = off (stateless behavior byte-identical); when set, an in-memory LRU (128 entries, keyed by canonical method+URL) fronts instance-bound GETs only — `fetch_content` is never cached.
- Search ergonomics ([#38](https://github.com/bumbaRasch/searxng-mcp-server/pull/38)): `time_range` on `image_search`/`music_search`; `min_score` (web only) drops scored results below a floor before the `max_results` slice; `queries` (2–5 strings, web only) runs a batch with one result set per query in input order (output is an `anyOf` union: single envelope or `{ batch: [...] }`); `detail: 'full' | 'compact'` on every category tool — markdown only, `structuredContent` never changes; richer optional projected fields: video `views`/`iframeSrc`, image `filesize`/`formats`, web `metadata`/`thumbnailSrc`.
- End-to-end coverage for the new surface ([#41](https://github.com/bumbaRasch/searxng-mcp-server/pull/41)): `paper_search`, `autocomplete`, PDF fetch, `detail: 'compact'` + `min_score` and `/healthz` assertions in `scripts/e2e.mjs` / `scripts/e2e-http.mjs` (PDF soft-skips when offline).

### Changed

- Wave-B integration quality pass ([#40](https://github.com/bumbaRasch/searxng-mcp-server/pull/40)): `autocomplete` moved onto the shared client path (failover + opt-in cache); envelope-schema generation centralized in `defineCategory`.

### BREAKING

No 0.3.x compatibility shims (pre-1.0 minor, per the release policy):

- Internal module layout restructured around the category registry: new `src/categories/{types,shared,index,general,images,news,videos,music,paper}.ts`, `src/autocompleter.ts`, `src/pdf.ts`, `src/cache.ts`; the per-category slices were removed from `schemas.ts`/`searxng.ts`/`format.ts`/`tools.ts`.
- Exported schema handles changed source and shape: the media `*SearchOutput` schemas are now the registry-generated envelopes (`<category>.envelopeSchema`) composed from the shared envelope atoms; `searchOutput` composes the same envelope, so the wire property order changed; new `searchToolOutput` union and `searchBatchOutput`; `DEFAULT_MAX_RESULTS`, `sanitizeUntrusted` and `sanitizeMeta` moved to `src/categories/shared.ts`.
- `src/searxng.ts`: the per-category functions (`imageSearch`, `mapImageResponse`, …) are now thin wrappers over the generic `runCategorySearch(definition, …)`; new failover seams (`fetchWithFailover`, `ClientOptions`, `InstanceRequest`, `ExplainStatus`).
- `tools/list` regenerated: category output schemas are composed from the envelope, and the tool surface grew from 7 to 9 tools (`paper_search` and `autocomplete` added).
- `docs/extending.md` rewritten to the registry workflow: add one category file, one index line, tests — no other module edits.

## [0.3.2] - 2026-09-21

### Added

- Security policy (`SECURITY.md`): private vulnerability reporting via GitHub, supported versions and scope.

### Changed

- Streamable HTTP documentation moved from the README to [docs/http.md](docs/http.md); the README keeps a short overview.

### Fixed

- Search-like tools (`search`, `image_search`, `news_search`, `video_search`, `music_search`) no longer fail with `-32602 InvalidParams` when SearXNG reports unresponsive engines: `unresponsiveEngines` now compiles to a plain fixed-length string array instead of a JSON Schema 2020-12 tuple (`prefixItems` + `items: false`) that draft-07-only clients reject.

## [0.3.1] - 2026-09-20

### Security

- The non-localhost HTTP bind guard now also covers the `--transport http` flag path (previously only `SEARXNG_TRANSPORT=http` was validated, letting the flag start an unauthenticated server on an exposed interface).

## [0.3.0] - 2026-09-20

### Added

- Opt-in Streamable HTTP transport alongside stdio ([#9](https://github.com/bumbaRasch/searxng-mcp-server/issues/9)): `SEARXNG_TRANSPORT=http` or `--transport http` serves a single `/mcp` endpoint speaking the 2026-07-28 MCP protocol revision only (no 2025-era fallback, stateless per-request serving — no `Mcp-Session-Id` sessions). stdio remains the default; existing `npx` setups are unchanged.
- HTTP security: loopback bind by default (`HOST`/`PORT`); startup refused on a non-localhost bind without `SEARXNG_AUTH_TOKEN`; optional bearer-token auth (`401`/`403` with `WWW-Authenticate`, timing-safe compare); `Host`/`Origin` validation on every request (localhost allowlist + `SEARXNG_ALLOWED_HOSTS`/`SEARXNG_ALLOWED_ORIGINS`) for DNS-rebinding protection.
- Docker deployment: `Dockerfile` and `docker-compose.http.yml` — the server in HTTP mode behind an nginx reverse proxy on top of the base SearXNG stack.

## [0.2.0] - 2026-09-20

### Added

- `list_engines` tool: discovery of the engines and categories enabled on the connected SearXNG instance (via `/config`) — makes the `engines` parameter of the search tools instance-aware ([#8](https://github.com/bumbaRasch/searxng-mcp-server/issues/8)).

## [0.1.2] - 2026-09-20

### Added

- MCP `icons` metadata (SEP-973) for the server and every tool — self-contained data URIs, rendered by icon-aware clients.
- Coverage gate: vitest thresholds enforced in CI (`pnpm test:coverage`) plus a successful `tools/call` transport test.
- OIDC release workflow: tag `v*` → npm publish with provenance + GitHub Release (no tokens, no OTP).
- GitHub issue forms (bug report, feature request, tool request) with a router — no blank issues.
- Listing metadata: `server.json` (official MCP Registry), `smithery.yaml`, `glama.json`, npm `mcpName`/`repository` provenance.
- Renovate dependency automation (pinned-action updates, npm release-age security delay).

### Changed

- npm package renamed to `searxng-mcp-server` (`searxng-mcp-ts` was taken on npm); the GitHub repository keeps the matching name.
- `actions/checkout` updated to v7.

## [0.1.1] - 2026-09-20

### Added

- npm provenance metadata (`mcpName`, `repository`) required by the official MCP Registry ownership verification.

## [0.1.0] - 2026-09-20

### Added

- Initial public release: six tools for a self-hosted SearXNG instance — `search`, `fetch_content`, `image_search`, `news_search`, `video_search`, `music_search`.
- SSRF and DNS-rebind guard on page fetch: pre-validation on every redirect hop, connect-time re-check, private/reserved range blocking, https→http downgrade refusal.
- Prompt-injection mitigation: untrusted-content wrapping with marker neutralization; sanitized error text.
- MCP `icons`, tool annotations, `outputSchema` validation, stdin/stdout hygiene (stderr-only logs).
- Bundled SearXNG Docker stack (pinned image, loopback-only) and end-to-end verification script.
- 260 unit tests, CI matrix (Node 22.19/24/26), type-aware linting, coverage.

[Unreleased]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.3.1
[0.3.0]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.2.0
[0.1.2]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://www.npmjs.com/package/searxng-mcp-server/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/searxng-mcp-server/v/0.1.0
