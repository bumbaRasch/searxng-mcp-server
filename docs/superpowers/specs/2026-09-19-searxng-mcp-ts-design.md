# searxng-mcp-ts — Design Spec

Date: 2026-09-19
Status: Draft (pending review)

## 1. Overview

`searxng-mcp-ts` is a Model Context Protocol (MCP) server, written in TypeScript,
that exposes a self-hosted [SearXNG](https://github.com/searxng/searxng) instance
to MCP clients (OpenCode, Claude, Cursor, etc.).

It provides two tools:

- `search` — query SearXNG and return structured + human-readable results.
- `fetch_content` — fetch a URL and return clean Markdown for LLM consumption.

The server speaks MCP over **stdio** (local, spawned by the client). The
companion SearXNG instance runs in Docker and is configured to expose its JSON
API.

### Goals

- Privacy-respecting web search through a user-owned SearXNG instance.
- Lightweight: no headless browser, no external API keys, no cloud services.
- High-quality tool design (clear schemas, actionable errors, bounded outputs).
- Easy local setup: `docker compose up` for SearXNG + one command for the MCP.
- Publishable as an open-source GitHub project (MIT).

### Non-goals

- Site crawling / spidering (DFS, whole-site crawl).
- JavaScript rendering (no Playwright/Chromium).
- Replacing SearXNG itself or bundling an index.
- Hosted/remote MCP transport (HTTP/SSE) in v1 — stdio only.
- Version-pinned library documentation index (that is Context7's domain).

## 2. Architecture

```
MCP client (OpenCode)
      │  stdio (JSON-RPC)
      ▼
searxng-mcp-ts (node dist/index.js)
      │                        │
      │ HTTP /search?format=json│ HTTP GET (arbitrary URL)
      ▼                        ▼
SearXNG (docker, :8888)   external website
```

The server is a thin, stateless adapter. SearXNG aggregates upstream search
engines; `fetch_content` retrieves and extracts a single page.

## 3. Project layout

```
searxng-mcp-ts/
├─ src/
│  ├─ index.ts        # createServer() + stdio transport
│  ├─ tools.ts        # registerTool: search, fetch_content
│  ├─ searxng.ts      # SearXNG HTTP client + response mapping
│  ├─ http.ts         # HttpResponseLike / FetchLike / readCapped
│  ├─ ssrf.ts         # IP classification + guarded undici dispatcher
│  ├─ fetch.ts        # fetch + Readability + Turndown + truncation
│  ├─ format.ts       # Markdown rendering helpers (untrusted wrapping)
│  ├─ config.ts       # env parsing + defaults
│  └─ version.ts      # VERSION constant
├─ test/
│  ├─ searxng.test.ts
│  ├─ fetch.test.ts
│  └─ tools.test.ts
├─ searxng/settings.yml
├─ docker-compose.yml
├─ .github/workflows/ci.yml
├─ .agents/skills/    # mcp-builder, skill-creator (project-scoped)
├─ AGENTS.md
├─ package.json
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts
├─ .oxlintrc.json
├─ README.md
├─ LICENSE
├─ .env.example
└─ .gitignore
```

## 4. Components

### 4.1 `config.ts`

Reads and validates environment variables, applying defaults:

| Env var | Default | Purpose |
| --- | --- | --- |
| `SEARXNG_URL` | `http://localhost:8888` | Base URL of the SearXNG instance |
| `SEARXNG_USERNAME` | _(unset)_ | Optional basic auth user |
| `SEARXNG_PASSWORD` | _(unset)_ | Optional basic auth password |
| `SEARXNG_TIMEOUT_MS` | `10000` | Timeout for SearXNG requests |
| `FETCH_TIMEOUT_MS` | `15000` | Timeout for page fetches |
| `MAX_CHARS` | `25000` | Max characters returned by `fetch_content` |
| `MAX_RESPONSE_BYTES` | `5242880` (5 MiB) | Max download size for `fetch_content` |
| `USER_AGENT` | `searxng-mcp-ts/<version>` | Outgoing User-Agent |
| `ALLOW_PRIVATE_HOSTS` | `false` | If true, disables the SSRF private-host guard |

Config is a pure function `loadConfig(env)` returning a typed object, so it is
trivially testable. Numeric env values must be `>= 1`; `0`, negative, blank, or
non-numeric values fall back to the default. `SEARXNG_URL` is parsed with
`new URL`; non-http(s) or malformed values fall back to the default, and any
embedded credentials are stripped (basic auth uses `SEARXNG_USERNAME` /
`SEARXNG_PASSWORD`).

### 4.2 `searxng.ts`

- `search(params, config)`: builds a `URLSearchParams` with `q`, `format=json`,
  and optional `categories`, `engines`, `language`, `time_range`, `pageno`,
  `safesearch`; `max_results` is applied client-side by slicing the returned
  page (SearXNG has no such parameter), plus optional basic auth header.
  - `engines` is comma-separated and **is** parsed by SearXNG
    (`searx/webadapter.py::parse_generic`), though it is absent from the public
    Search API docs.
  - `categories` are validated; unknown values are silently dropped.
  - `time_range` values are validated by `searx/webadapter.py::parse_time_range`.
- Sends `GET {SEARXNG_URL}/search` with a timeout (AbortController).
- Maps the response to a normalized `SearchResponse`. SearXNG's JSON keys (see
  `searx/webutils.py::get_json_response`) are `query`, `results`, `answers`,
  `corrections`, `infoboxes`, `suggestions`, `unresponsive_engines`; there is
  **no** `number_of_results` in current versions.
  - `results[]`: `{ title, url, content, engine, engines[], category, score,
    publishedDate? }` (raw dicts contain many more fields via `as_dict()`; we
    project only what we use)
  - `answers[]`: upstream emits **objects** (`Answer.as_dict()`), e.g.
    `{ answer, url?, engine? }` — NOT plain strings.
  - `unresponsive_engines[]`: upstream emits **`[engine, message]` tuples**
    (`webutils.get_translated_errors`), NOT engine-name strings.
  - `corrections[]`: `string[]` (surfaced).
  - `suggestions[]`: `string[]`; `infoboxes[]`: bounded dictionaries.
- Output is bounded: each result `content` is truncated, and the counts of
  `answers` / `suggestions` / `infoboxes` are capped. The response body is read
  with a byte cap (`MAX_RESPONSE_BYTES`).
- Error handling:
  - non-2xx → typed `SearxngError` with a hint.
    - `403` → "JSON format is likely disabled in SearXNG settings.yml
      (`search.formats`)".
    - `400` → invalid parameter (e.g. bad `time_range`/`language`/`safesearch`).
  - network/timeout → actionable message that includes only the **sanitized
    origin** of `SEARXNG_URL` (never embedded credentials).

### 4.3 `fetch.ts`

- `fetchContent(config, url, opts)`:
  1. Parse and validate URL (only `http:` / `https:`; no credentials-in-URL).
  2. **SSRF guard** (`ssrf.ts`): classify resolved addresses with a
     `node:net` `BlockList` (numeric, fail closed). Covers at least —
     IPv4: `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16`
     (link-local + metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`,
     `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`,
     `240/4`; IPv6: `::`, `::1`, `::ffff:0:0/96` (IPv4-mapped), `::/96`
     (IPv4-compatible), `64:ff9b::/96` (NAT64), `100::/64`, `2001:db8::/32`,
     `2002::/16`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`.
     Numeric classification is required because `new URL()` canonicalizes
     `http://[::ffff:127.0.0.1]/` to `[::ffff:7f00:1]`; string-prefix checks
     miss it. Zone IDs (`%…`) and brackets are normalized first.
  3. **DNS-rebinding protection:** one guarded `lookup` is shared by
     pre-validation and the connect hook. `fetch` and `Agent` are imported from
     the installed `undici` package (single version) so the custom `lookup` is
     honored; `redirect: 'manual'`; every hop re-validated; an `https → http`
     downgrade on redirect is rejected; max 5 hops.
  4. Fetch with timeout and a streaming byte cap (`MAX_RESPONSE_BYTES`).
  5. Extract main content with `@mozilla/readability` (parsed via `linkedom`).
  6. Convert the readable HTML to Markdown with `turndown`.
  7. Fall back to block-separated plain text if Readability yields nothing.
  8. Truncate to `MAX_CHARS` so the returned string (including the marker)
     never exceeds the cap.
- Returns `{ url, finalUrl, title?, byline?, content, truncated }`.

### 4.4 `format.ts`

Pure helpers producing Markdown for tool `content[].text`:
- `formatSearchResults(response)` → numbered list with title, URL, snippet, engine.
- `formatFetchedPage(result)` → title, source URL, then body.

Both wrap attacker-controlled web content in explicit
`<<<UNTRUSTED_WEB_CONTENT … UNTRUSTED_WEB_CONTENT>>>` delimiters preceded by a
warning line, so the model treats it as data, never as instructions
(prompt-injection mitigation). Tool descriptions state the same.

### 4.5 `tools.ts` / `index.ts`

- `createServer(config)` builds an `McpServer` and registers the two tools.
- `index.ts` connects it via `StdioServerTransport`
  (`await server.connect(new StdioServerTransport())`) and logs to **stderr**
  only (stdout is reserved for JSON-RPC). The `serveStdio(createServer)` helper
  from the SDK's getting-started guide is an acceptable alternative.
- The self-execution guard compares `realpathSync(process.argv[1])` with
  `fileURLToPath(import.meta.url)` so the published bin works through
  npm/pnpm symlinks. stderr logging never includes credentials.

## 5. Tool contracts

### 5.1 `search`

Input schema (zod):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | 1–500 chars |
| `categories` | string[] | no | e.g. `["general"]`, `["news"]` |
| `engines` | string[] | no | comma-separated; supported by SearXNG (undocumented) |
| `language` | string | no | e.g. `"en"`, `"de"` |
| `time_range` | `"day" \| "week" \| "month" \| "year"` | no | validated by SearXNG |
| `pageno` | number | no | ≥ 1, default 1 |
| `safesearch` | `0 \| 1 \| 2` | no | 0 off, 1 moderate, 2 strict |
| `max_results` | number | no | 1–50, default 10 (client-side slice of one page) |

- `outputSchema`: normalized `SearchResponse` (structured content):
  `answers` is `{ answer: string; url?: string; engine?: string }[]`,
  `unresponsiveEngines` is `[engine, message][]`, `corrections` is `string[]`,
  and `infoboxes` is bounded in count and shape.
- Output is bounded: per-result `content` is truncated and array counts
  (`answers`, `suggestions`, `infoboxes`) are capped; the SearXNG response body
  is read with a byte cap.
- `max_results` only slices the current `pageno` page; requesting more results
  than the page size does not trigger additional page fetches in v1.
- `content`: the same data rendered as Markdown (untrusted content delimited).
- Annotations: `readOnlyHint: true`, `openWorldHint: true`.

### 5.2 `fetch_content`

Input schema (zod):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | validated at runtime: http/https, no credentials, public host |
| `max_chars` | number | no | overrides `MAX_CHARS` (1000–200000) |
| `timeout_ms` | number | no | overrides `FETCH_TIMEOUT_MS` |

- `outputSchema`: `{ url, finalUrl, title?, byline?, content, truncated }`.
- `content`: Markdown (title + body); the web body is wrapped in untrusted-content delimiters.
- Annotations: `readOnlyHint: true`, `openWorldHint: true`.

Errors are returned as `{ content:[{type:"text", text}], isError:true }` with
guidance (never stack traces).

## 6. SearXNG Docker setup

`docker-compose.yml` (based on the official SearXNG container compose):

```yaml
name: searxng
services:
  core:
    image: docker.io/searxng/searxng:latest
    restart: unless-stopped
    ports:
      - "8888:8080"
    volumes:
      - ./searxng:/etc/searxng/:Z  # :Z for SELinux (Fedora)
  valkey:
    image: docker.io/valkey/valkey:9-alpine
    command: valkey-server --save 30 1 --loglevel warning
    restart: unless-stopped
    volumes:
      - valkey-data:/data/
volumes:
  valkey-data:
```

`searxng/settings.yml`:

```yaml
use_default_settings: true
server:
  secret_key: "<generated>"
  limiter: false
general:
  instance_name: "searxng-mcp-ts"
search:
  formats:
    - html
    - json
```

Key point: the JSON API is **disabled by default**; `search.formats` must
include `json`, otherwise requests return `403`.

Generate `secret_key` with e.g. `openssl rand -hex 32` and commit a real value
in the local, untracked copy (the repo ships a placeholder only). Alternatively
set `SEARXNG_SECRET` via the container environment.

## 7. Security

- **SSRF protection** on `fetch_content` is mandatory and on by default; the
  blocklist is numeric (`node:net` `BlockList`) and fail-closed.
- The resolved IP is pinned at connect time via a single guarded `undici`
  `lookup` shared with pre-validation, and every redirect hop is re-validated;
  `https → http` redirect downgrades are rejected.
- No secrets are logged; `SEARXNG_URL` is sanitized to drop embedded
  credentials, and error/log messages never include them.
- Bounded downloads (byte cap) and bounded outputs (`MAX_CHARS`; capped result
  content and array counts for `search`).
- Only `http`/`https` schemes; no `file:`, `data:`, `gopher:`.
- **Prompt-injection mitigation:** web content returned by both tools is wrapped
  in explicit untrusted-content delimiters with a warning; tool descriptions
  state that returned content is untrusted data.
- The SearXNG instance is assumed local/trusted; the MCP does not expose it
  publicly.

## 8. Testing strategy

- **Unit (vitest)**:
  - `searxng.test.ts`: query-string construction, response mapping
    (`answers` objects, `unresponsive_engines` tuples, `corrections`), 403 hint,
    timeout handling (mocked `fetch`), bounded output.
  - `ssrf.test.ts`: numeric IP classification incl. IPv4-mapped IPv6
    (`[::ffff:127.0.0.1]` after `new URL()` normalization), `fe80::/10`,
    `fec0::/10`, NAT64, reserved IPv4 ranges; `assertUrlAllowed` through URL
    normalization; guarded `lookup` `all:true` branch.
  - `fetch.test.ts`: SSRF guard, HTML→MD extraction, block-separated fallback,
    hard truncation cap, byte cap, redirect re-validation + `https→http`
    rejection, rebinding (injected lookup) blocked at connect.
  - `tools.test.ts`: zod schema validation, Markdown render, untrusted-content
    wrapping, secret non-leakage.
- **Manual/integration**:
  - `npx @modelcontextprotocol/inspector node dist/index.js` with a live
    SearXNG container.
  - Live call from OpenCode.

## 9. CI

GitHub Actions on push/PR:
1. `pnpm install --frozen-lockfile`
2. `pnpm run lint`
3. `pnpm run lint:types`
4. `pnpm run format:check`
5. `pnpm run typecheck`
6. `pnpm test`
7. `pnpm run build`

Matrix: Node 22, 24, 26 (Node 20 reached EOL on 2026-04-30; 24 is Active LTS,
26 is Current/LTS from 2026-10).

## 10. Tech stack & versions (verify via Context7 before coding)

| Concern | Choice |
| --- | --- |
| Runtime | Node ≥ 22.19.0, ESM |
| Language | TypeScript 7.x, strict (native/Go compiler; no programmatic API — see lint note) |
| MCP SDK | `@modelcontextprotocol/server` v2; `McpServer` from the root, `StdioServerTransport` from `/stdio` (or `serveStdio`) |
| Validation | `zod` v4 (`import { z } from "zod"`; `zod/v4` subpath also available) |
| HTTP | `fetch` + `Agent` both imported from the installed `undici` (single version) so the guarded `lookup` is honored; `redirect: 'manual'` |
| HTML parse | `linkedom` |
| Extraction | `@mozilla/readability` |
| HTML→MD | `turndown` (+ `@types/turndown`) |
| Tests | `vitest` |
| Lint | **Oxlint** (+ `oxlint-tsgolint` for type-aware rules); Prettier for formatting |

**Docs-first rule:** before implementing each module, pull current docs for the
relevant library using Context7 (see `AGENTS.md`). Reconcile any mismatch
between the official SDK v2 docs and the `mcp-builder` skill (which may target
the older `@modelcontextprotocol/sdk`).

**Lint note:** TypeScript 7 (native/Go) ships **no programmatic compiler API**
until 7.1, so `typescript-eslint` cannot run on it (peer range `<6.1.0`). We
therefore use **Oxlint** (Rust), which parses TypeScript itself and does not
depend on the TS API. `oxlint-tsgolint` is built directly on TypeScript 7.0.2
and unlocks type-aware rules via `oxlint --type-aware`. Prettier is TS-version
agnostic and handles formatting.

## 11. Skills

Installed project-scoped (official Anthropic skills) into `.agents/skills/`:

- `mcp-builder` — MCP server construction guidance.
- `skill-creator` — authoring skills (note: overlaps with the global
  superpowers `writing-skills`; kept per project decision).

`AGENTS.md` will instruct agents to use Context7 for library docs.

## 12. Success criteria

- SearXNG container up; `curl 'http://localhost:8888/search?q=test&format=json'` → 200 JSON.
- `pnpm test` and `pnpm build` pass in CI.
- From OpenCode, `search` returns relevant results and `fetch_content` returns
  clean Markdown for a known page.
- SSRF guard rejects `http://localhost`, `http://169.254.169.254`, and the
  URL-normalized IPv4-mapped form `http://[::ffff:169.254.169.254]`.
- README explains setup end-to-end (MCP env is provided by the client; `.env`
  is used only by Docker Compose for `SEARXNG_SECRET`).

## 13. Decisions log

- Language: TypeScript (per user).
- Tools: `search` + `fetch_content` only (no browser, no site crawl).
- License: MIT.
- Folder/repo: `searxng-mcp-ts`.
- Publishing: GitHub-first; npm later (name `searxng-mcp` is taken).
- Context7: remote MCP with API key header (auth tier), used for docs.
