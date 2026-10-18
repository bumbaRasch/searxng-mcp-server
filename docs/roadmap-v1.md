# Roadmap — searxng-mcp-server v1.0.0 ("wow edition")

Everything below ships as ONE release, v1.0.0. Stages build in dependency order;
the dev gate (`pnpm lint && pnpm lint:types && pnpm format:check && pnpm typecheck
&& pnpm test && pnpm build`) must stay green after every stage; both e2e scripts
(`node scripts/e2e.mjs`, `node scripts/e2e-http.mjs`, local SearXNG stack required)
must pass before the release is declared done. Commit locally after each verified
stage (conventional commits); do not push without asking.

Ground rules: verify every protocol/API fact against primary sources (MCP spec
repos via `gh`, Context7 for library docs) before coding a stage; repo
conventions per AGENTS.md (Node >= 22.19, ESM only, relative imports end in
`.js`, oxlint only, MCP logs to stderr, never log secrets); smallest complete
change per feature; reuse what lives in `src/`.

Protocol facts verified for the whole roadmap (2026-07-28 spec, source repos):

- Tools return `structuredContent` conforming to the tool's `outputSchema`;
  clients may validate against it. The TS SDK validates structuredContent
  server-side before the result leaves, and skips validation on `isError`
  results — anything added to structured output must be declared in the schema.
- SEP-2106: under 2026-07-28 `structuredContent` may be any JSON value (the
  2025-era object-only constraint is gone on the new wire).
- There is **no** protocol-level citation/reference-token facility: ref tokens
  are an application-level convention carried in structured content + text.
- Roots, Sampling and Logging are DEPRECATED in 2026-07-28 — server features
  must not depend on them (no client-side sampling in deep_search).
- Stateless serving: one fresh `McpServer` per HTTP request (already this
  repo's HTTP model); any cross-request state must live at process scope.

---

## Stage 1 — Citations & ref-tokens + search_and_fetch

Scope: search results carry stable numbered source IDs (`ref`); `fetch_content`
accepts `ref:N` instead of a URL; a combined `search_and_fetch` tool cuts
round trips.

Design notes:

- `src/refs.ts`: `RefRegistry` — bounded map URL↔ref. `assign(url)` returns the
  existing ref for a known URL, else mints the next sequential number
  (monotonic, never reused); `resolve(ref)` returns the URL or undefined.
  Eviction (oldest first, bounded at 512) makes evicted refs resolve to
  `undefined` — never silently remapped to a different URL. A module-level
  shared instance is the production default: the ref session is per-process
  (HTTP serving is stateless per request, so per-server state would break
  search → ref → fetch across two requests). Tests inject fresh registries.
- Refs are minted on the delivered results of `search` (single AND batch — the
  batch path maps over `search()`), after min_score filtering and slicing.
- `fetch_content.url` accepts `ref:N` (resolved before the SSRF guard — the
  mapped URL then goes through the normal guarded pipeline unchanged).
- `search_and_fetch`: search + concurrent guarded fetch of the top
  `fetch_top` (1–5, default 3) delivered results, each capped by `max_chars`;
  a failed page fetch degrades to an `error` entry in `pages[]`, never a tool
  failure (same pattern as D15 replica errors).

Acceptance criteria:

1. `search` (and every entry of a batch) carries `ref` on each result in
   structuredContent, declared in the output schema; the text rendering shows
   `[ref:N]` next to each result URL. Same URL → same ref within the process
   session, including across separate tool calls.
2. `fetch_content` with `url: "ref:N"` fetches the mapped URL through the
   unchanged SSRF-guarded pipeline; an unknown/evicted ref returns a tool
   error telling the model to re-search (no partial state leaks).
3. `search_and_fetch` returns the search envelope (with refs) plus `pages[]`;
   first-page `pages[0].ref === results[0].ref`; a failing page produces an
   error entry while the tool still succeeds.
4. Unit tests: registry stability/uniqueness/eviction; ref resolution in
   `fetch_content` (hit + miss); `search_and_fetch` handler (success, partial
   fetch failure, respects fetch_top); schema validation for the new shapes;
   text rendering includes `[ref:N]`.
5. e2e (`scripts/e2e.mjs`): live search → take `results[0].ref` →
   `fetch_content {url: "ref:N"}` succeeds → `search_and_fetch` returns pages
   aligned with results (soft-skip patterns for public-network flakiness).
6. Dev gate green; commit `feat: citations, ref tokens and search_and_fetch`.

Spec sources read before coding: `modelcontextprotocol/modelcontextprotocol`
`docs/specification/2026-07-28/server/tools.mdx` (structuredContent/outputSchema
contract); TS SDK v2 docs via Context7 (server-side output validation, isError
skips validation).

## Stage 2 — Heuristic rerank + doctor + observability resources

Scope: optional `rerank` on `search` (query/title term overlap, freshness,
domain weighting — layered on top of `min_score`); a `doctor` tool diagnosing
the instance; `config://` and `stats://` resources.

Design notes:

- Rerank is a pure function over delivered results (no new network I/O):
  score = weighted(query/title overlap, freshness from `publishedDate`,
  domain weight); stable tie-break keeps original order. Reordering happens
  after min_score filtering, before ref minting so refs stay stable.
- `doctor` probes the instance through the existing client seams: JSON API
  enabled? (`format=json` probe), limiter behavior (403/429 signature),
  unresponsive engines (from a probe search's `unresponsive_engines`),
  `/config` reachability. Output: `checks[] {id, ok, detail}` structured.
- `config://`/`stats://` resources: registered via the SDK resource API,
  backed by the same failover client; verify SearXNG's `/stats` endpoint shape
  against the searxng repo before coding.

Acceptance criteria:

1. `search` with `rerank: true` returns results reordered by the heuristic
   (unit-tested scoring: overlap dominant, freshness boost, tie stability);
   `rerank` omitted → behavior byte-identical to today.
2. `doctor` returns a check list covering JSON API, limiter, engines, config;
   every probe failure mode is unit-tested with stubbed fetch; a fully broken
   instance still returns a structured report (isError only on total failure).
3. `resources/list` exposes `config://` and `stats://`; `resources/read`
   returns sanitized instance data (unit + e2e).
4. e2e: `search` with rerank succeeds; `doctor` returns all-ok checks against
   the live stack; resources readable.
5. Dev gate green; commit per feature (`feat: heuristic rerank`, `feat: doctor`,
   `feat: observability resources`).

Spec sources: 2026-07-28 `server/resources.mdx` (resource URIs, readResource);
searxng repo `searx/webapp.py` for `/stats`; SearXNG settings docs for limiter.

## Stage 3 — crawl_site + archive fallback

Scope: crawl a site into a URL/title/snippet manifest with content cached for
later `fetch_content`; opt-in Wayback fallback for dead links (SSRF-guarded).

Design notes:

- `crawl_site`: BFS from a seed URL, same-origin links only, bounded
  (`max_pages` 1–30, default 10) and depth-capped; every page through the
  existing guarded fetch + extraction; manifest entries get registry refs so
  `fetch_content ref:N` reads cached pages without re-fetching (cache the
  extracted content keyed by final URL).
- Wayback fallback: opt-in (env `SEARXNG_ARCHIVE_FALLBACK`, default off, plus
  per-call override); on dead target (4xx/network) query
  `archive.org/wayback/available`, fetch the closest snapshot through the same
  guarded pipeline; the response marks `archived: true` + snapshot URL.
- Robots: respect robots.txt best-effort (fetch + honor Disallow for the crawl
  path); document the residual gap (no crawl-delay handling).

Acceptance criteria:

1. `crawl_site` returns a manifest (`pages[] {ref, url, title, snippet}`),
   stays same-origin, honors max_pages, and seeded refs resolve through
   `fetch_content ref:N` hitting the in-process cache (unit: stubbed fetch
   graph; off-site link ignored; cap respected; cycle-safe).
2. Archive fallback: dead URL + fallback on → snapshot fetched and marked;
   fallback off → today's error; SSRF guard still applies (private hosts
   never fetched, including via snapshot URLs); unit-tested both ways.
3. e2e: crawl a small real page set (soft-skip on network); ref-based fetch of
   a crawled page.
4. Dev gate green; commits `feat: crawl_site`, `feat: archive fallback`.

Spec sources: fetch pipeline is internal (no new protocol surface); Wayback
API verified against `archive.org/wayback/available` docs.

## Stage 4 — Tasks extension + deep_search

Scope: implement `io.modelcontextprotocol/tasks` per the ext-tasks repo (task
handle, `tasks/get` polling) for long-running operations; `deep_search` as the
first task-backed tool (iterative search → source selection → SSRF-guarded
fetch → cited dossier; optional OpenAI-compatible/Ollama synthesis endpoint,
degrading to dossier-only when unset). NO client-side sampling (deprecated in
2026-07-28).

Design notes:

- Verify the ext-tasks repo shape before coding: task creation via
  `tools/call` with task `_meta`, `tasks/get`, `tasks/result`, `tasks/list`,
  `tasks/cancel`; augmentation requirements in `tools/list` (task support
  declaration per tool); what the SDK v2 already provides (do not re-implement
  what ships in `@modelcontextprotocol/server` v2.x).
- Task store is process-scope (same reasoning as the ref registry); TTL + cap.
- `deep_search`: max_iterations (default 2), per-iteration search (rerank +
  refs) → select top uncited sources → guarded fetch → accumulate cited
  notes; synthesis step only when `SEARXNG_SYNTHESIS_URL` is configured
  (OpenAI-compatible `/chat/completions` or Ollama `/api/chat`), else
  dossier-only. All secrets: URL may embed a key → never logged.
- Progress: task status updates while iterating.

Acceptance criteria:

1. A negotiated-tasks client can start `deep_search` as a task, poll
   `tasks/get` to `completed`, and read the dossier via `tasks/result`;
   `tasks/cancel` stops a running task (unit-tested lifecycle with fake
   clock/stubbed network).
2. Without tasks support, `deep_search` runs inline (bounded, still returns
   the dossier) — graceful degradation like MCP Apps fallback.
3. Synthesis unset → valid dossier-only output; synthesis set → dossier plus
   cited synthesis; synthesis endpoint failure degrades to dossier-only with a
   note (never a tool failure).
4. All fetches SSRF-guarded; task store bounded and TTL-expired; secrets never
   logged.
5. e2e (stdio + HTTP): deep_search inline run; tasks lifecycle over stdio with
   a tasks-capable client stub.
6. Dev gate green; commits `feat: tasks extension`, `feat: deep_search`.

Spec sources: `modelcontextprotocol/ext-tasks` (spec + schema files, read in
full before coding); `modelcontextprotocol/modelcontextprotocol` 2026-07-28
`deprecated.mdx` (sampling status).

## Stage 5 — Skills over MCP

Scope: expose 2–3 built-in skills (fact-check workflow, literature review,
news monitoring) via Resources per `modelcontextprotocol/ext-skills` (SEP-2640,
Final).

Design notes:

- Verify the ext-skills repo for the exact conventions: resource URI scheme
  for skills, SKILL.md frontmatter fields (name, description, license?,
  allowed-tools?), progressive disclosure (metadata list vs. full body read),
  and whether a capability/announcement field is expected.
- Built-ins ship as embedded SKILL.md strings (no fs reads at runtime);
  instructions reference this server's tools (`search` + refs, `fetch_content`,
  `search_and_fetch`, `doctor`, `deep_search`).

Acceptance criteria:

1. `resources/list` advertises the built-in skills with name + description
   metadata; `resources/read` returns the full SKILL.md body per the ext-skills
   conventions (exact URI + frontmatter shape verified from the repo).
2. Skill bodies are static, sanitized (no secrets), and exercise only tools
   that exist on this server.
3. Unit tests: listing shape, read-back, frontmatter validity; e2e: list +
   read one skill over stdio.
4. Dev gate green; commit `feat: built-in skills over MCP`.

Spec sources: `modelcontextprotocol/ext-skills` (SEP-2640 Final) — read the
spec text and reference server implementation before coding.

## Stage 6 — MCP Apps

Scope: interactive gallery for `image_search`/`video_search` per
`modelcontextprotocol/ext-apps`, with text-only fallback for clients without
Apps support.

Design notes:

- Verify from the ext-apps repo: the `_meta.ui.resourceUri` tool annotation
  pattern, the hosted HTML resource (text/html + base CSP), the postMessage
  bridge handshake (`ui/initialize`, host context), sandbox requirements, and
  what the SDK v2 exposes (`registerApp`? `_meta` helpers) — do not hand-roll
  what the SDK ships.
- The gallery app renders `structuredContent` images/videos; announces
  `ui` capability; degrades: clients without Apps see today's text/markdown
  output unchanged (graceful degradation is part of the spec).
- App HTML is served as a resource from an embedded string (self-contained,
  no build step, CSP pinned to sandbox allowances only).

Acceptance criteria:

1. `image_search`/`video_search` tool definitions carry the Apps `_meta.ui`
  resourceUri; the HTML resource is listed and readable; CSP/sandbox matches
  the ext-apps requirements (verified from the repo).
2. Clients without Apps support get unchanged text output (assert in e2e stdio
  — no regression); the app HTML is served with the right content type.
3. Unit tests: `_meta` presence, resource registration, CSP sanity; e2e:
  resource read + tool call unaffected.
4. Dev gate green; commit `feat: MCP Apps gallery`.

Spec sources: `modelcontextprotocol/ext-apps` — spec + example apps, read
before coding; SDK v2 Apps support verified via Context7.

## Stage 7 — Protocol polish

Scope: `server/discover` + the stateless requirements of 2026-07-28 (first
check what `@modelcontextprotocol/sdk` v2 already covers — do not
re-implement); `ttlMs`/`cacheScope` on cacheable tool results; deterministic
`tools/list` ordering; optional OTel trace-context passthrough.

Design notes:

- Read 2026-07-28 `server/discover.mdx`, `server/utilities/caching.mdx`, and
  the stateless/streamable-http requirements; inventory what SDK v2.3.x
  provides (server/discover helpers, cacheable-result `_meta` typing,
  deterministic ordering guarantees) and implement only the delta.
- Deterministic order: `TOOL_NAMES` is already a fixed literal order — verify
  registration emits that order on the wire and add a regression test.
- Cacheable results: declare `ttlMs`/`cacheScope` `_meta` on read-only tools
  per caching.mdx; the D9 TTL cache stays operator-side.
- OTel passthrough: accept W3C `traceparent` in `_meta`/headers per the spec's
  trace conventions and propagate to outbound instance calls (opt-in, no
  exporter dependency).

Acceptance criteria:

1. `server/discover` answered per spec (or the SDK's implementation verified
   and documented in design.md — no duplicate re-implementation).
2. Cacheable tools advertise `ttlMs`/`cacheScope` per caching.mdx; e2e-http
   asserts the `_meta` on a tool listing.
3. `tools/list` order is exactly `TOOL_NAMES` (regression test).
4. Incoming trace context propagates to outbound requests when present;
   absent → wire behavior unchanged.
5. Dev gate green; commits per polish item.

Spec sources: 2026-07-28 `server/discover.mdx`, `server/utilities/caching.mdx`,
`basic/transports/streamable-http.mdx` (stateless), OTel `_meta` conventions
(spec index + changelog); SDK v2 via Context7.

## Release — v1.0.0

1. One v1.0.0 CHANGELOG entry covering every stage above.
2. README: tools table (all new tools), configuration table (new env vars),
   security section (new attack surface: crawl, archive, synthesis endpoint),
   session example featuring refs.
3. `docs/design.md`: module map additions (refs, crawl, tasks, deep-search,
   skills, apps), architecture notes for process-scope state, non-goals
   revised (site crawling is now IN scope — rewrite that entry).
4. Registry manifests: `server.json`, `glama.json`, `smithery.yaml` updated.
5. Full dev gate + `node scripts/e2e.mjs` + `node scripts/e2e-http.mjs` green.
6. Version bump to 1.0.0 (package.json + `src/version.ts` sync test), commit
   `chore: release v1.0.0`. Do not push or publish without asking.
