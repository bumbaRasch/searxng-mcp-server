# searxng-mcp-server — Design

`searxng-mcp-server` is a Model Context Protocol (MCP) server, written in
TypeScript, that exposes a self-hosted [SearXNG](https://github.com/searxng/searxng)
instance to MCP clients (OpenCode, Claude, Cursor, …). It provides six tools:

- `search` — query SearXNG and return structured + human-readable results.
- `fetch_content` — fetch a URL and return clean Markdown for LLM consumption.
- `image_search` — find images: direct file links, optional thumbnails, resolution
  and format.
- `news_search` — find recent news articles with a freshness filter.
- `video_search` — find videos with previews, duration and a freshness filter.
- `music_search` — find music, including direct audio file links when available.

The server speaks MCP over **stdio**; the companion SearXNG instance runs in
Docker (loopback-only) and is configured to expose its JSON API.

## Architecture

```
MCP client
      │  stdio (JSON-RPC)
      ▼
searxng-mcp-server (node dist/index.js)
      │                        │
      │ HTTP /search?format=json│ HTTP GET (arbitrary URL)
      ▼                        ▼
SearXNG (docker, 127.0.0.1:8888)   external website
```

The server is a thin, stateless adapter. SearXNG aggregates upstream search
engines; `fetch_content` retrieves and extracts a single page.

Six tools are exposed: `search`, `fetch_content`, `image_search`,
`news_search`, `video_search`, and `music_search`. The media tools are thin
category-specialized wrappers over the same SearXNG client
(`fetchSearchJson` + dedicated projections); they never download media —
only URL strings (`thumbnailSrc`/`audioSrc` are hooks for future embedded
previews). Dates pass through `pickPublishedDate` (SearXNG leaks the string
`'None'` for missing dates) and durations through `normalizeDuration` (numeric
seconds are normalized to `M:SS`/`H:MM:SS`).

## Module layout

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | stdio bin entrypoint (transport wiring only) |
| `src/server.ts` | `createServer()` — transport-agnostic server factory |
| `src/tools.ts` | MCP tool registration + error boundary (sanitizes reflected strings) |
| `src/schemas.ts` | zod input/output schemas — the single source of truth for data shapes (`z.infer` types used everywhere) + `to*SearchParams` mappers |
| `src/searxng.ts` | SearXNG HTTP client + defensive response projection |
| `src/http.ts` | `FetchLike`/`HttpResponseLike` seams + capped stream reading |
| `src/ssrf.ts` | IP classification + guarded undici dispatcher (anti-rebind) |
| `src/fetch.ts` | fetch orchestration: redirect loop + SSRF wiring + pipeline |
| `src/extract.ts` | Readability extraction, DOM cleaning/absolutization, text stripping |
| `src/markdown.ts` | turndown HTML→Markdown + output truncation |
| `src/format.ts` | Markdown rendering + untrusted-content wrapping/sanitization + tool error text |
| `src/config.ts` | env parsing + defaults (warns on stderr for invalid `SEARXNG_URL`) |
| `src/version.ts` | `VERSION` constant (kept in sync with package.json by a test) |

Dependency direction (per-module, as imported): `config`, `schemas`, `http`,
`ssrf`, `extract`, `markdown` and `version` are leaves. Above them:
`format` → `schemas`; `searxng` → `http`/`config`/`schemas`; `fetch` →
`config`/`ssrf`/`extract`/`markdown`/`http`/`schemas`; `tools` →
`config`/`fetch`/`format`/`schemas`/`searxng` plus type-only imports of
`http` (`FetchLike`) and `ssrf` (`LookupAll`), and the MCP SDK; `server` →
`config`/`tools`/`version` (+ MCP); `index` → `config`/`server`/`version`
(+ MCP stdio transport). All network seams (`FetchLike`, DNS `lookup`) are
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
- `unresponsive_engines[]` are **`[engine, message]` tuples**, not names.
- `engines` (comma-separated) **is** parsed from the query string even though
  it is absent from the public API docs; `categories` are validated server-side
  (unknown values dropped); `time_range` is validated in `parse_time_range`.
- `max_results` has no server-side parameter — the client slices the page.
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
  `application/xml`, and any `application/*+xml` type — exact tokens with a
  parameter boundary, so prefix siblings like `application/xml-dtd` are
  refused; responses without a Content-Type header are treated as textual;
  output capped at `MAX_CHARS`; per-call `timeout_ms` bounded to 120 s.
  Residual risk: HTML parsing (Readability + turndown) runs synchronously on
  the event loop — a hostile page can stall the server for the parse
  duration — but the input is bounded by the 5 MiB response cap.
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
- **Lifecycle**: Shutdown is bounded by `SHUTDOWN_TIMEOUT_MS` (default 5 s, minimum 100 ms): if a graceful `close()` does not finish within it — or a second signal arrives — the process exits immediately with code 0.

## Non-goals

- Site crawling/spidering, JavaScript rendering, hosted/remote transports
  (stdio only), replacing SearXNG itself.
