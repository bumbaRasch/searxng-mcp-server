# searxng-mcp-server — Design

`searxng-mcp-server` is a Model Context Protocol (MCP) server, written in
TypeScript, that exposes a self-hosted [SearXNG](https://github.com/searxng/searxng)
instance to MCP clients (OpenCode, Claude, Cursor, …). It provides nine tools:

- `search` — query SearXNG and return structured + human-readable results
  (a single query or a 2–5 query batch).
- `image_search` — find images: direct file links, optional thumbnails,
  resolution, format and file size.
- `news_search` — find recent news articles with a freshness filter.
- `video_search` — find videos with previews, duration, view counts, embed
  links and a freshness filter.
- `music_search` — find music, including direct audio file links when available.
- `paper_search` — find scientific publications: abstracts, authors,
  journal/DOI metadata and direct PDF links.
- `fetch_content` — fetch a URL (HTML page or text PDF) and return clean
  Markdown for LLM consumption, with offset continuation for long pages.
- `autocomplete` — query suggestions for a prefix (`/autocompleter`).
- `list_engines` — the engines and categories enabled on the instance
  (`/config`).

The server speaks MCP over **stdio** (default) or **Streamable HTTP**
(opt-in, `SEARXNG_TRANSPORT=http` / `--transport http`); the companion
SearXNG instance runs in Docker (loopback-only) and is configured to expose
its JSON API.

## Architecture

```
MCP client
      │  stdio (JSON-RPC) — default
      │  HTTP POST/GET /mcp (Streamable HTTP) — opt-in
      ▼
searxng-mcp-server (node dist/index.js)
      │                        │
      │ HTTP /search?format=json│ HTTP GET (arbitrary URL)
      ▼                        ▼
SearXNG (docker, 127.0.0.1:8888)   external website
```

### Transports

Both transports share the same transport-agnostic `createServer()` factory;
only `src/index.ts` differs:

- **stdio** — the default. The MCP client spawns the process (`npx`) and
  speaks newline-delimited JSON-RPC over stdin/stdout; logs go to stderr.
- **Streamable HTTP** — opt-in. A single `/mcp` endpoint served by plain
  `node:http` and the SDK's `createMcpHandler` in `legacy: 'reject'` mode:
  the endpoint speaks the **2026-07-28 protocol revision only** (per-request
  `_meta` envelopes, no `Mcp-Session-Id` sessions — serving is stateless,
  one fresh `McpServer` per request via the factory, so replicas scale
  horizontally). 2025-era requests are rejected with an
  unsupported-protocol-version error naming the supported revisions. Every
  request passes through a bearer-token gate (when `SEARXNG_AUTH_TOKEN` is
  set), then `Host` and `Origin` validation (localhost allowlist plus
  `SEARXNG_ALLOWED_HOSTS`/`SEARXNG_ALLOWED_ORIGINS`) — the DNS-rebinding
  protections the MCP spec requires. Binding to a non-localhost `HOST`
  without a token refuses startup (fail-fast in `loadConfig`, not a
  warning). See [HTTP security model](#http-transport) below.

The server is a thin, stateless adapter. SearXNG aggregates upstream search
engines; `fetch_content` retrieves and extracts a single page.

Nine tools are exposed. The category tools — `search`, `image_search`,
`news_search`, `video_search`, `music_search`, `paper_search` —
are generated from a declarative **category registry** (`src/categories/`):
one `defineCategory` declaration per category — tool metadata, upstream
categories, a `supportsTimeRange` flag, a result zod schema, a defensive
projector and per-result markdown lines — from which the input schema
(shared argument atoms), the output envelope
(`query`/`results`/`suggestions`/`unresponsiveEngines`), the handler and the
tool registration are derived. `search` keeps a bespoke slice on top of its
registry entry (user-chosen categories, answers/corrections/infoboxes, batch
`queries`, `min_score`); `fetch_content`, `autocomplete` and `list_engines`
are registered beside the registry loop. The category tools never download
media — only URL strings (`thumbnailSrc`/`audioSrc`/`iframeSrc` are hooks for
future embedded previews). Dates pass through `pickPublishedDate` (SearXNG
leaks the string `'None'` for missing dates) and durations through
`normalizeDuration` (numeric seconds are normalized to `M:SS`/`H:MM:SS`).

Instance-bound requests (search family, `autocomplete`, `/config`) ride a
failover client: with `SEARXNG_URLS` set, network errors, timeouts, 5xx, 429
and 403 move to the next instance in order — never 400, which would fail
everywhere — and exhaustion surfaces the last error. An opt-in TTL cache
(`SEARXNG_CACHE_TTL_MS`, default off; in-memory LRU of 128) fronts the same
GETs. `fetch_content` uses neither: its targets are arbitrary web URLs, not
the operator's instances.

## Module layout

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | bin entrypoint: transport selection (`--transport` flag > `SEARXNG_TRANSPORT` env), stdio wiring, HTTP listener lifecycle, signal handling |
| `src/server.ts` | `createServer()` — transport-agnostic server factory |
| `src/tools.ts` | MCP tool registration (registry loop + bespoke tools) + error boundary (sanitizes reflected strings) |
| `src/categories/` | category registry: `types.ts` (`CategoryDeclaration` + `defineCategory`), `shared.ts` (argument atoms, envelope builder, projection bounds, marker sanitizers), one file per category, `index.ts` aggregation |
| `src/schemas.ts` | zod schemas: bespoke tool schemas (search/fetch/list-engines) and convenience handles over the registry-generated category schemas (the atoms live in `categories/shared.ts`); `to*SearchParams` mappers; `z.infer` types used everywhere |
| `src/searxng.ts` | SearXNG HTTP client: failover wrapper, defensive response projection, batch search, `/config` |
| `src/autocompleter.ts` | `/autocompleter` client, flat-array suggestion projection and markdown rendering |
| `src/http.ts` | `FetchLike`/`HttpResponseLike` seams + capped stream reading |
| `src/ssrf.ts` | IP classification + guarded undici dispatcher (anti-rebind) |
| `src/fetch.ts` | fetch orchestration: redirect loop + SSRF wiring + HTML/PDF extraction pipeline + offset windows |
| `src/pdf.ts` | PDF branch of `fetch_content`: capped raw-byte reader + unpdf text extraction (`[Page N]` sections) |
| `src/extract.ts` | Readability extraction, DOM cleaning/absolutization, text stripping |
| `src/markdown.ts` | turndown HTML→Markdown + output truncation |
| `src/format.ts` | Markdown rendering + untrusted-content wrapping/sanitization + tool error text |
| `src/cache.ts` | opt-in TTL + LRU cache for instance-bound GETs (default off) |
| `src/config.ts` | env parsing + defaults (warns on stderr for invalid values; refuses insecure non-localhost HTTP binds) |
| `src/argv.ts` | `--transport stdio\|http` CLI flag parsing (throws on typos — explicit intent) |
| `src/http-server.ts` | Streamable HTTP stack: `createMcpHandler` (modern-only), bearer gate, Host/Origin validation, passive `/healthz`, `node:http` wiring |
| `src/icon.ts` | MCP `icons` metadata (self-contained data URIs) for the server and every tool |
| `src/version.ts` | `VERSION` constant (kept in sync with package.json by a test) |

Dependency direction (per-module, as imported): `config`, `http`, `ssrf`,
`extract`, `markdown`, `version`, `icon`, `cache` and the registry core
(`categories/types` + `categories/shared`, mutually type-only) are leaves.
Above them: the category files → `categories/shared`/`types` (paper also
reuses `general`'s date helper); `schemas` → categories; `format` →
categories + `schemas`; `searxng` → `cache`/`categories`/`http`/`config`/
`schemas`; `autocompleter` → `searxng`/`cache`/`format`/`config`;
`pdf` → `http`; `fetch` → `config`/`ssrf`/`extract`/`markdown`/`pdf`/
`http`/`schemas`; `tools` → `config`/`fetch`/`format`/`schemas`/`searxng`/
`autocompleter`/`categories` plus type-only imports of `http` (`FetchLike`),
`ssrf` (`LookupAll`) and `cache` (`TtlCache`), and the MCP SDK; `server` →
`config`/`tools`/`cache`/`icon`/`version` (+ MCP); `http-server` →
`config`/`server`/`tools` (types) (+ MCP server root and the
`@modelcontextprotocol/node` adapter); `index` → `argv`/`config`/
`http-server`/`server`/`version` (+ MCP stdio transport). All network seams (`FetchLike`, DNS `lookup`) are
injectable — including at the MCP boundary, where `ToolDeps` threads them
from `registerTools`/`createServer` — so the whole surface is unit-testable
without monkey-patching.

## SearXNG JSON API notes

Hard-to-discover facts encoded in `src/searxng.ts` (verified against
`searx/webadapter.py` / `searx/webutils.py`):

- Keys: `query`, `results`, `answers`, `corrections`, `infoboxes`,
  `suggestions`, `unresponsive_engines`. There is **no** `number_of_results`.
- `answers[]` are **objects** (`Answer.as_dict()`, `{answer, url?, engine?}`),
  not plain strings.
- `unresponsive_engines[]` are **`[engine, message]` pairs**, not names (projected as
  fixed-length `string[2]`, not `z.tuple`, so draft-07-only clients can validate it).
- `engines` (comma-separated) **is** parsed from the query string even though
  it is absent from the public API docs; `categories` are validated server-side
  (unknown values dropped); `time_range` is validated in `parse_time_range`.
- `max_results` has no server-side parameter — the client slices the page.
- `/autocompleter` is GET-only and reads just `q`; with the
  `X-Requested-With: XMLHttpRequest` header it returns a flat JSON array of
  strings, without it an OpenSearch-shaped `[prefix, [results], …]` payload
  (facts verified against `searx/webapp.py`).
- 403 usually means `format=json` is not enabled in `search.formats`.

Engine-specific credentials (e.g. the OpenAlex `api_key`, which replaced the
deprecated `mailto` polite pool in February 2026 — see
[searxng#6513](https://github.com/searxng/searxng/issues/6513)) are configured
in `searxng/settings.yml`, never in this server. The MCP server itself needs
no API keys.

## Security model

- **SSRF guard** (`fetch_content` only; the SearXNG target is operator
  config): scheme allowlist (http/https), embedded credentials rejected,
  private/reserved/special IPv4+IPv6 ranges blocked (IANA registries incl.
  CGNAT, benchmarking, AS112, 6to4 relay, Teredo, ORCHID, NAT64), IP-literal
  tricks normalized (brackets, zone IDs), and — critically — the same guarded
  DNS lookup is used for **both** pre-validation and the connect-time
  dispatcher hook, so DNS rebinding between check and connect is re-checked.
  Every redirect hop is re-validated; https→http downgrades are refused;
  redirects are capped; `ALLOW_PRIVATE_HOSTS=true` opts out deliberately.
  The search path, whose target is operator config rather than an arbitrary
  URL, refuses redirects outright (`redirect: 'manual'` — any redirect
  response is an error, so `SEARXNG_URL` must point directly at the instance).
- **Bounded resources**: one `AbortController` per logical request spanning
  all hops; streamed reads capped at `MAX_RESPONSE_BYTES` (applied to
  decompressed bytes); non-textual Content-Types are refused on
  `fetch_content`: the gate allows the `text/*` family, `application/json`,
  `application/xml`, any `application/*+xml` type and `application/pdf`
  (routed to the unpdf text-extraction branch instead of Readability) —
  exact tokens with a parameter boundary, so prefix siblings like
  `application/xml-dtd` are refused; responses without a Content-Type
  header are treated as textual; output capped at `MAX_CHARS` (an `offset`
  window may continue it); per-call `timeout_ms` bounded to 120 s.
  Residual risk: HTML parsing (Readability + turndown) and PDF text
  extraction run synchronously on the event loop — a hostile document can
  stall the server for the parse duration — but the input is bounded by the
  5 MiB response cap.
- **Prompt-injection mitigation**: all web-derived text is wrapped in an
  untrusted-content banner; embedded close markers *and forged open markers*
  (including zero-width/control-character gaps) are neutralized; meta fields
  rendered outside the wrapper additionally have control/format characters
  collapsed so trusted-looking lines cannot be forged; tool error messages
  that reflect attacker-controlled strings are sanitized identically.
  Residual risk: fuzzy near-markers (e.g. `UNTRUSTED_WEB_CONTENT > > >`) are
  NOT neutralized — the guarantee is scoped to the exact marker strings.
  `structuredContent` string values are marker-defused — the same
  close/forged-open neutralization recurses through arrays and objects —
  but carry no banner: clients that render structured data directly get no
  wrapper.
- **Secrets**: `SEARXNG_USERNAME`/`SEARXNG_PASSWORD` are used only to build
  the `Authorization` header; error messages surface only the sanitized
  origin of `SEARXNG_URL` (embedded credentials are stripped at config load);
  nothing is ever logged to stdout (JSON-RPC only).

### HTTP transport

- **Liveness probe**: `GET /healthz` answers `200 {"status":"ok"}`
  unauthenticated and without touching SearXNG — probes must be cheap and
  side-effect free; readiness (is SearXNG reachable?) is the operator's
  reverse-proxy concern. Host/Origin validation still applies, and every
  other path keeps the 404 behavior.
- **Fail-fast exposure guard**: `loadConfig` *throws* (unlike the
  warn-and-fallback env parsing) when `SEARXNG_TRANSPORT=http` would bind a
  non-localhost `HOST` without `SEARXNG_AUTH_TOKEN` — an unauthenticated
  remote bind must never come up by accident. `0.0.0.0`/`::` count as
  non-localhost. Docker/compose deployments (where the container must bind
  `0.0.0.0`) therefore always pair the bind with a token.
- **Bearer auth** (`SEARXNG_AUTH_TOKEN`): the SDK's `requireBearerAuth` gate
  answers `401`/`403` with proper `WWW-Authenticate` challenges. The token
  is verified by comparing SHA-256 digests with `timingSafeEqual` — no
  early-exit length leak; the token value never reaches logs or errors.
  A static token has no expiry, so the synthesized `AuthInfo` carries a
  far-future `expiresAt` (the SDK rejects tokens without one).
- **DNS-rebinding protection**: every request's `Host` and `Origin` headers
  are validated against the localhost allowlist plus operator-supplied
  extras (`SEARXNG_ALLOWED_HOSTS`/`SEARXNG_ALLOWED_ORIGINS`); the SDK
  helpers deny unparsable/`null` origins and answer `403`. Requests without
  an `Origin` pass — non-browser MCP clients do not send one.
- **Protocol-era strictness**: `legacy: 'reject'` — no 2025-era serving, no
  session state to hijack or leak. The trade-off is explicit: clients must
  speak (or negotiate to) the 2026-07-28 revision; older HTTP clients get a
  typed unsupported-protocol-version error naming the supported revisions.
- **TLS** is deliberately not implemented: the server binds loopback by
  default, and remote deployments terminate TLS at a reverse proxy
  (`docker-compose.http.yml` + `nginx/mcp-proxy.conf` show the pattern).
- **Lifecycle**: Shutdown is bounded by `SHUTDOWN_TIMEOUT_MS` (default 5 s, minimum 100 ms): if a graceful `close()` does not finish within it — or a second signal arrives — the process exits immediately with code 0.

## Non-goals

Deliberate scope cuts, with the reasoning (stable — do not relitigate
without new evidence):

- **Section/paragraph-range addressing in `fetch_content`** — the `offset`
  window plus in-content headings cover the read-long-docs scenario without
  a second addressing scheme.
- **HTML scraping fallback for JSON-disabled instances** — the bundled
  compose stack ships a JSON-enabled SearXNG, and instance failover (403
  moves to the next `SEARXNG_URLS` entry) covers the rest; parsing result
  HTML would conflict with the security posture.
- **OAuth for the HTTP transport** — a static bearer token suffices for a
  self-hosted, single-operator deployment.
- **Site crawling / `crawl_site`, JavaScript rendering** — out of scope by
  design; `fetch_content` reads one page.
- **ML reranking, Ollama synthesis, domain statistics** — dependency weight
  and philosophy (a thin, stateless adapter over SearXNG).
- **Random public SearXNG instances** — most disable the JSON API and 429
  aggressively; self-hosted is this project's core privacy stance.
- **Per-domain blocklists / learning** — no current need; SearXNG already
  filters upstream.
- Hosted search backends, replacing SearXNG itself, the deprecated HTTP+SSE
  transport and 2025-era Streamable HTTP sessions (the HTTP path is
  modern-only, 2026-07-28, by design).
