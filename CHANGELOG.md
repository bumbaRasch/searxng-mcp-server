# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Extension advertisement** — the server declares its three 2026-07-28
  extensions in `capabilities.extensions` (`src/server.ts`):
  `io.modelcontextprotocol/tasks`, `io.modelcontextprotocol/skills` and
  `io.modelcontextprotocol/ui`, each with an empty settings object — the
  specs' "supported, no server-side settings" shape (`directoryRead` is
  omitted because `resources/directory/read` is not implemented). Protocol
  basis: ext-skills makes the skills declaration a MUST, and per
  extensions/overview a client opts in per-request only after observing the
  declaration — without it the supporting side must revert to core behavior
  or reject. The SDK renders the same object into both `initialize` and
  `server/discover` responses; a test pins the exact initialize shape.
- **MCP Registry publishing** — `release.yml` publishes `server.json` to the
  official MCP Registry right after `npm publish` via GitHub OIDC
  (`mcp-publisher login github-oidc` → `publish`): no dedicated secret
  (`id-token: write` was already granted), and the manual-JWT failure mode —
  a token expired between releases — is gone. The registry hosts metadata
  only and requires the npm package to exist first.
- **Registry validation in CI** — the `build` job validates `server.json`
  with `mcp-publisher validate` (v1.8.1 tarball, sha256-checked before use),
  so registry-rejection causes like the 100-char `description` limit now
  fail a PR instead of surfacing at publish time. The pin is raised by hand:
  it is a `run:` step, which Renovate's `pinGitHubActionDigests` does not
  manage (an outdated binary fails against the registry with
  "invalid audience").
- **Version sync on release** — `pnpm version` lifecycle hooks: `preversion`
  runs the lint/typecheck/test gate, `version` runs the new
  `scripts/sync-version.mjs` (rewrites `src/version.ts` and both
  `server.json` version fields, preserving their formatting byte-for-byte)
  and `git add`s the synced files into the release commit, `postversion`
  pushes so the `v*` tag triggers the release workflow. A version bump no
  longer leaves `src/version.ts`/`server.json` stale.
- **e2e conformance assertions** — both e2e suites assert that the three
  declared extensions are advertised: `initialize` over stdio and
  `server/discover` over HTTP.

### Changed

- Internal refactor: `src/schemas.ts` split into `src/schemas/` — eight
  per-consumer zod modules with no barrel (`search`, `fetch`,
  `search-and-fetch`, `mappers`, `doctor`, `list-engines`, `crawl`,
  `deep-search`; importers go to the concrete module) — and the tasks wire
  side (`CreateTaskResult` construction, `tasks/get`/`tasks/cancel`
  handlers, the `-32021` capability gate) moved from `tools.ts` into
  `tasks.ts`. Wire behavior unchanged.
- Documentation brought in line with the code: `docs/design.md` documents
  the extension declarations and the corrected `io.modelcontextprotocol/ui`
  id, and drops the "replicas scale horizontally" claim; `docs/http.md`
  gains a "Scaling behind a load balancer" section (the three process-scope
  stores — citation refs, crawled pages, tasks — are not shared across
  replicas; pick sticky routing or an external store before the first LB
  deployment); `docs/extending.md` gains a "Young extensions policy" (wire
  pinned to concrete spec editions, quarterly upstream reconciliation, SDK
  updates are deliberate — never silent Renovate merges).

### Fixed

- Nightly e2e flake: `paper_search` in both e2e suites now retries
  epidemic-shaped upstream failures — a network-ish `isError` (timeout /
  network / HTTP 5xx) or a clean call with an empty `results[]` — up to
  three times with 2 s/5 s backoff. Deterministic tool errors still fail
  immediately in both suites; a JSON-RPC error throws immediately over HTTP
  (`client.callTool` rejects and nothing catches it), while in the stdio
  suite it is retried like an empty result before the assert fails.
- Comments and docs no longer name the MCP Apps extension by its superseded
  id `io.modelcontextprotocol/apps`: the stable ext-apps spec (2026-01-26)
  identifies it as `io.modelcontextprotocol/ui`.

## [1.0.1] - 2026-10-18

> Why not 1.0.0? The npm registry permanently blocks publishing `searxng-mcp-server@1.0.0`:
> a previous, since-removed package under this name published a `1.0.0` in April 2026 (before
> this package existed), and npm never allows re-publishing an existing version string. The
> release ships as 1.0.1; the GitHub tag is `v1.0.1`.

The "wow edition": one release, seven feature waves, all built on the
2026-07-28 protocol revision (stateless serving, no deprecated primitives —
no Sampling, Roots or Logging anywhere in the new surface).

### Added

- **Citations & ref tokens** — every `search` result (single and batch) carries
  a session-stable `ref`; the text rendering shows `[ref:N]` next to each URL.
  `fetch_content` accepts `ref:N` in place of a URL, so a model never has to
  repeat long URLs. Refs are minted by a process-scope bounded registry
  (`src/refs.ts`): the same URL keeps its ref for the process lifetime, numbers
  are never reused (an evicted ref resolves to an error, never to a different
  URL), and the session survives the per-request server instances of the HTTP
  transport. Protocol basis: `structuredContent` must conform to the tool's
  `outputSchema` (SDK-validated server-side), so `ref` is declared in the
  schema.
- **`search_and_fetch`** — one call that searches and immediately fetches the
  full Markdown of the top `fetch_top` (1–5, default 3) results; failed pages
  degrade to `error` entries in `pages[]` instead of failing the call.
- **Heuristic rerank** — opt-in `rerank: true` on `search` and
  `search_and_fetch` reorders delivered results by query/title overlap,
  freshness (linear decay over one year) and configured domain boosts
  (`SEARXNG_RERANK_BOOST_DOMAINS`), with stable tie-breaking on top of the instance
  ranking and the `min_score` floor (`src/rerank.ts`).
- **`doctor`** — diagnoses the connected instance: JSON API availability
  (`format=json` probe), `/config` reachability, unresponsive engines from a
  probe search, and limiter state. Probes the primary instance only (no
  failover — a healthy replica must not mask the configured instance) and
  returns structured `checks[]` with a `healthy` verdict.
- **Observability resources** — `config://searxng` (defensively projected
  `/config`: name, version, limiter, engines, categories) and
  `stats://engines/errors` (per-engine error counts from `/stats/errors`;
  the `/stats` page is HTML-only, verified against `searx/webapp.py`).
- **`crawl_site`** — BFS-crawls a site from a seed URL into a
  URL/title/snippet manifest with stable refs: same-origin links only (parsed
  from the absolutized Markdown), `max_pages` cap (1–30), cycle-safe,
  robots.txt honored best-effort (prefix `Disallow` for the `*` group). Every
  page goes through the existing SSRF-guarded fetch pipeline, and the
  extracted content lands in a bounded process-scope store that
  `fetch_content` serves without re-fetching (outline/section/offset controls
  intact via the shared `windowExtracted` path).
- **Wayback fallback** — opt-in (`SEARXNG_ARCHIVE_FALLBACK` or per-call
  `archive: true` on `fetch_content`): dead links (404/410/5xx, network
  failures, timeouts) retry through the closest
  `archive.org/wayback/available` snapshot, still SSRF-guarded, marked
  `archived: true`. Policy refusals (private hosts, unsupported content
  types, scheme downgrades) never trigger the fallback.
- **Tasks extension** — `io.modelcontextprotocol/tasks` per
  `modelcontextprotocol/ext-tasks`: a tasks-capable `tools/call` (capability
  declared in the request `_meta` envelope) may receive a `CreateTaskResult`
  (`resultType: "task"`) and poll `tasks/get` until `completed`; `tasks/cancel`
  is cooperative with worker `AbortSignal`s; task ids are UUIDv4 (unguessable
  per spec), terminal states are immutable, the store is bounded and TTL'd,
  and there is no `tasks/list` (by spec). Served through the SDK's
  explicit-schema custom-method seam (`tasks/get` and `tasks/cancel` are the
  only task names the 2026-07-28 wire keeps).
- **`deep_search`** — iterative research loop: search (rerank on), select the
  top uncited sources, fetch through the SSRF guard, and return a cited
  dossier with stable refs. Optional synthesis via
  `SEARXNG_SYNTHESIS_URL`/`SEARXNG_SYNTHESIS_MODEL` (OpenAI-compatible
  chat completions; Ollama's native `/api/chat` response shape also read)
  degrades to dossier-only on any failure. Without the tasks capability the
  run is bounded inline — graceful degradation per the spec. **No client-side
  sampling**: Sampling is deprecated in 2026-07-28, so the synthesis step is a
  server-side API call.
- **Skills over MCP** — `io.modelcontextprotocol/skills` per SEP-2640 (Final):
  three built-in skills in Agent Skills format — `fact-check`,
  `literature-review`, `news-monitoring` — served as `skill://<name>/SKILL.md`
  resources plus complete `skills/list`/`skills/get` entries (verbatim
  frontmatter, per-file sha256 digests and sizes over the exact bytes served,
  cacheable-result envelope).
- **MCP Apps gallery** — `io.modelcontextprotocol/apps` per `ext-apps`: one
  self-contained gallery app (`ui://searxng-gallery/app.html`,
  `text/html;profile=mcp-app`) renders `image_search`/`video_search` results
  as a thumbnail grid, linked via each tool's `_meta.ui.resourceUri`. The View
  speaks the iframe handshake with plain postMessage and renders untrusted
  data only through safe DOM APIs. Hosts without Apps support keep the
  unchanged text output — graceful degradation is part of the spec.
- **Protocol polish (2026-07-28)** — `server/discover` served by the SDK
  (verified live: versions, capabilities, serverInfo); meaningful
  `ttlMs`/`cacheScope` hints on the cacheable results (`tools/list` 300 s
  public, `resources/list` 60 s public, `server/discover` 3600 s public;
  `resources/read` keeps the conservative default because `config://` and
  `stats://` are live); deterministic `tools/list` ordering pinned by the
  `TOOL_NAMES` regression test; OTel trace passthrough (SEP-414): a W3C
  `traceparent` in the request `_meta` envelope propagates through
  AsyncLocalStorage to outbound SearXNG calls, page fetches and synthesis
  requests as a `traceparent` header — invalid values are never forwarded.

### Changed

- Tool count grows from nine to thirteen: `search`, `image_search`,
  `news_search`, `video_search`, `music_search`, `paper_search`,
  `fetch_content`, `autocomplete`, `list_engines` (as in 0.5.x) plus
  `search_and_fetch`, `doctor`, `crawl_site` and `deep_search`. `tools/list`
  advertises `ttlMs: 300000, cacheScope: "public"` and every tool keeps its
  untrusted-content suffix and icons.

### Fixed

- Task store keeps its `AbortController`s across TTL expiry, pruning and
  eviction (cancellation still reaches the worker) and never evicts a working
  task while finished ones can make room.
- `tasks/get`/`tasks/cancel` answer `-32602` on an unknown task id and
  `-32021` to clients without the tasks capability.
- `skills/list`/`skills/get` serve frontmatter verbatim (the `license` field
  is preserved) and return `-32602` on an unknown `uri` or invalid `cursor`.
- `ui/initialize` sends `appCapabilities`.
- The Wayback fallback no longer triggers on an SSRF-guard refusal (policy
  refusals are not dead links).
- `deep_search` synthesis stops when the task is cancelled.
- `doctor` always reports the limiter when `/config` answered, even when the
  search probe failed with something other than 429.

### Security

- Ref sessions, the crawl page store and the task store are process-scope and
  bounded (512 refs / 256 pages / 64 tasks) with monotonic, never-reused task
  and ref ids.
- Archive fallback is a deliberate opt-in that never bypasses the SSRF guard:
  the snapshot URL re-enters the same guarded pipeline, and policy refusals
  are ineligible for the fallback by construction.
- `SEARXNG_SYNTHESIS_URL` is operator config like `SEARXNG_URL`: validated
  http/https, redacted in warnings, never logged.

## [0.5.2] - 2026-10-14

### Changed

- Bundled SearXNG instance image pinned to `2026.10.13-22c64b8d3` (from `2026.8.22-9fea41204`): picks up the new `xprivo`/`iconify`/`findborg`/`s1search` engines, the `stock images` category, curl_cffi-backed networking (better bot-detection survival) and automatically populated embedded stream URLs for more video engines (already surfaced as `iframeSrc` by `video_search`). The JSON search API, `/config` and `/autocompleter` are unchanged — verified by the e2e suites against the new build.
- `searxng/settings.yml` disables the `openalex` engine on the bundled instance: OpenAlex removed its mailto polite pool in Feb 2026, and the SearXNG engine cannot pass an API key yet ([searxng/searxng#6513](https://github.com/searxng/searxng/issues/6513)), which leaves ~100 credits/day per IP — enough to starve `paper_search` on shared or CI IPs. Re-enable by hand once upstream gains api_key support.
- Renovate now keeps the compose pin current: a package rule teaches it the `YYYY.M.D-sha` tag format via `versionCompatibility` + semver versioning, so the SearXNG image gets update PRs like every other dependency.

### Fixed

- Nightly e2e flake: `paper_search` checks pin `engines: ['arxiv']` so the suite no longer fails on days when the OpenAlex quota is exhausted (the Oct 7/9 schedule failures), and both e2e servers now run with `SEARXNG_TIMEOUT_MS=30000` so slow-but-healthy upstream engines (arxiv can legitimately take >10s) don't trip the default timeout budget.

## [0.5.1] - 2026-09-26

### Fixed

- `fetch_content` no longer fails with `First argument to Readability constructor should be a document object` on non-HTML textual bodies (plain text, Markdown, JSON, XML/feeds), such as raw files served as `text/plain`; only `text/html`/`application/xhtml+xml` (and responses without a Content-Type) go through Readability, while other allowed textual types pass through verbatim, preserving Markdown tables, code fences and heading offsets (D17). `extractArticle`/`stripToText` additionally guard tagless input that linkedom parses without a `documentElement`.

## [0.5.0] - 2026-09-26

### Added

- Reading controls in `fetch_content` ([#60](https://github.com/bumbaRasch/searxng-mcp-server/pull/60)): `outline: true` returns `headings` — `{text, offset, level}` entries whose offsets point into the scanned content (markdown `#`-lines on the HTML branch; `[Page N]` page markers as level-1 sections on the PDF branch) — and `section` returns one heading region only: case-insensitive exact heading match, through the next same-or-higher-level heading, with `offset`/`max_chars` applying inside it and `nextOffset` relative to the sectioned content. A `section` that matches nothing is a sanitized error; call `outline` first to list headings.
- Opt-in HTML fallback for JSON-disabled instances ([#61](https://github.com/bumbaRasch/searxng-mcp-server/pull/61)): `SEARXNG_HTML_FALLBACK` (default `false`). When a `search` request fails with 403 (limiter / JSON API disabled) or answers a non-JSON body and the flag is on, the client retries the same query without `format=json` and parses the result page with a new linkedom-based parser (`src/html-results.ts`, the `simple` theme's `article.result` structure), capped at 30 sanitized results; the output envelope is identical to the JSON path with empty `suggestions`/`unresponsiveEngines`. The `search` tool only.
- Operator defaults ([#62](https://github.com/bumbaRasch/searxng-mcp-server/pull/62)): `SEARXNG_DEFAULT_LANGUAGE` and `SEARXNG_DEFAULT_SAFESEARCH` (`0`/`1`/`2`; invalid values ignored with a warning) apply when a request omits the parameter, and `SEARXNG_MAX_RESULTS` clamps a larger request `max_results` with a once-per-process warning. Explicit request values always win.
- Instance aggregation in `list_engines` ([#63](https://github.com/bumbaRasch/searxng-mcp-server/pull/63)): with more than one instance configured (`SEARXNG_URLS`), `/config` is fetched from every instance in parallel and the output gains `instances` (per-instance `engines`/`unavailableEngines`, or an `error` entry for an unreachable replica — never a tool failure) plus `commonEngines`, the intersection of selectable engines across reachable instances. Single-instance output is unchanged.
- CLI flags ([#58](https://github.com/bumbaRasch/searxng-mcp-server/pull/58)): `--help` (usage to stdout) and `--version` (print the version) both exit 0 before any server startup.

### Changed

- Config ceilings with warn + clamp ([#58](https://github.com/bumbaRasch/searxng-mcp-server/pull/58)): `SEARXNG_TIMEOUT_MS` ≤ 300000, `FETCH_TIMEOUT_MS` ≤ 300000, `SHUTDOWN_TIMEOUT_MS` ≤ 60000, `MAX_CHARS` ≤ 1000000, `MAX_RESPONSE_BYTES` ≤ 104857600 and `SEARXNG_CACHE_TTL_MS` ≤ 86400000 clamp out-of-range values to the ceiling with a warning (same path as the negative-value fallback); `SEARXNG_USERNAME` without `SEARXNG_PASSWORD` logs a startup warning instead of silently sending Basic auth with an empty password.
- `schemas.ts` slimmed to cross-tool atoms ([#59](https://github.com/bumbaRasch/searxng-mcp-server/pull/59)): the per-category schema handles moved to `src/categories/schemas.ts` (exported names keep their spellings); `schemas.ts` keeps the bespoke search/fetch/list-engines schemas, mappers and `z.infer` types.
- npm listing text and version sync guard ([#58](https://github.com/bumbaRasch/searxng-mcp-server/pull/58)): `package.json` `description` now names the 9-tool surface, and a smoke test keeps both `server.json` `version` fields equal to it.
- Coverage thresholds pinned ([#56](https://github.com/bumbaRasch/searxng-mcp-server/pull/56)): `coverage.thresholds.autoUpdate: false` with floors at lines 99.2 / functions 94.37 / branches 89.16 / statements 96.95 — no generated churn on local runs.
- Nightly e2e ([#57](https://github.com/bumbaRasch/searxng-mcp-server/pull/57)): the CI `e2e` job gains a daily `schedule` trigger (04:00 UTC) alongside `workflow_dispatch`; SSRF assertions untouched.

### BREAKING

No 0.4.x compatibility shims (pre-1.0 minor, per the release policy; the MCP wire surface is unchanged):

- Per-category schema handles moved from `src/schemas.ts` to `src/categories/schemas.ts` — import paths change, names do not.
- Out-of-range config values are now clamped to the new ceilings (with a warning) instead of being accepted verbatim.

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

[Unreleased]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.5.2...v1.0.1
[0.5.2]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/bumbaRasch/searxng-mcp-server/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.3.1
[0.3.0]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.2.0
[0.1.2]: https://github.com/bumbaRasch/searxng-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://www.npmjs.com/package/searxng-mcp-server/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/searxng-mcp-server/v/0.1.0
