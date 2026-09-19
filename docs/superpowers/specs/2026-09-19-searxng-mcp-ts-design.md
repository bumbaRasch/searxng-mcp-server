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
│  ├─ fetch.ts        # fetch + Readability + Turndown + SSRF guard
│  ├─ format.ts       # Markdown rendering helpers
│  └─ config.ts       # env parsing + defaults
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
trivially testable.

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
  - also surface `answers[]`, `infoboxes[]`, `suggestions[]`,
    `unresponsive_engines[]`
- Error handling:
  - non-2xx → typed `SearxngError` with a hint.
    - `403` → "JSON format is likely disabled in SearXNG settings.yml
      (`search.formats`)".
    - `400` → invalid parameter (e.g. bad `time_range`/`language`/`safesearch`).
  - network/timeout → actionable message including the configured `SEARXNG_URL`.

### 4.3 `fetch.ts`

- `fetchContent(url, opts, config)`:
  1. Parse and validate URL (only `http:` / `https:`).
  2. **SSRF guard**: resolve the hostname and reject loopback, private,
     link-local, unique-local, and cloud metadata addresses
     (e.g. `169.254.169.254`, `::1`, `10/8`, `172.16/12`, `192.168/16`,
     `127/8`, `fc00::/7`, `fe80::/10`) unless `ALLOW_PRIVATE_HOSTS=true`.
     Also reject non-standard schemes and credentials-in-URL.
     To limit DNS rebinding, do not rely on `fetch` resolving on its own: use an
     `undici.Agent` with a custom `lookup`/`connect` hook that validates the
     resolved address and pins the IP, pass it via fetch's `dispatcher` option,
     and use `redirect: 'manual'` so every hop is re-validated. (Plain `fetch`
     cannot pin IP + SNI by itself.)
  3. Fetch with timeout, manual redirect handling (max 5 hops), and a byte cap
     enforced while streaming the body.
  4. Extract main content with `@mozilla/readability` (parsed via `linkedom`).
  5. Convert the readable HTML to Markdown with `turndown`.
  6. Fall back to stripped plain text if Readability yields nothing.
  7. Truncate to `MAX_CHARS`, appending a `[truncated]` marker.
- Returns `{ url, finalUrl, title?, byline?, content, truncated }`.

### 4.4 `format.ts`

Pure helpers producing Markdown for tool `content[].text`:
- `formatSearchResults(response)` → numbered list with title, URL, snippet, engine.
- `formatFetchedPage(result)` → title, source URL, then body.

### 4.5 `tools.ts` / `index.ts`

- `createServer(config)` builds an `McpServer` and registers the two tools.
- `index.ts` connects it via `StdioServerTransport`
  (`await server.connect(new StdioServerTransport())`) and logs to **stderr**
  only (stdout is reserved for JSON-RPC). The `serveStdio(createServer)` helper
  from the SDK's getting-started guide is an acceptable alternative.

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

- `outputSchema`: normalized `SearchResponse` (structured content).
- `max_results` only slices the current `pageno` page; requesting more results
  than the page size does not trigger additional page fetches in v1.
- `content`: the same data rendered as Markdown.
- Annotations: `readOnlyHint: true`, `openWorldHint: true`.

### 5.2 `fetch_content`

Input schema (zod):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string (url) | yes | http/https only |
| `max_chars` | number | no | overrides `MAX_CHARS` (1000–200000) |
| `timeout_ms` | number | no | overrides `FETCH_TIMEOUT_MS` |

- `outputSchema`: `{ url, finalUrl, title?, byline?, content, truncated }`.
- `content`: Markdown (title + body).
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

- **SSRF protection** on `fetch_content` is mandatory and on by default.
- No secrets are logged; env values are never echoed.
- Bounded downloads (byte cap) and bounded outputs (`MAX_CHARS`).
- Only `http`/`https` schemes; no `file:`, `data:`, `gopher:`.
- The SearXNG instance is assumed local/trusted; the MCP does not expose it
  publicly.

## 8. Testing strategy

- **Unit (vitest)**:
  - `searxng.test.ts`: query-string construction, response mapping, 403 hint,
    timeout handling (mocked `fetch`).
  - `fetch.test.ts`: SSRF guard (loopback/private/metadata rejected), HTML→MD
    extraction, truncation, fallback path, byte cap.
  - `tools.test.ts`: zod schema validation (boundary values), Markdown render.
- **Manual/integration**:
  - `npx @modelcontextprotocol/inspector node dist/index.js` with a live
    SearXNG container.
  - Live call from OpenCode.

## 9. CI

GitHub Actions on push/PR:
1. `pnpm install --frozen-lockfile`
2. `pnpm run lint`
3. `pnpm run typecheck`
4. `pnpm test`
5. `pnpm run build`

Matrix: Node 22, 24, 26 (Node 20 reached EOL on 2026-04-30; 24 is Active LTS,
26 is Current/LTS from 2026-10).

## 10. Tech stack & versions (verify via Context7 before coding)

| Concern | Choice |
| --- | --- |
| Runtime | Node ≥ 22, ESM |
| Language | TypeScript 7.x, strict (native/Go compiler; no programmatic API — see lint note) |
| MCP SDK | `@modelcontextprotocol/server` v2; `McpServer` from the root, `StdioServerTransport` from `/stdio` (or `serveStdio`) |
| Validation | `zod` v4 (`import { z } from "zod"`; `zod/v4` subpath also available) |
| HTTP | native `fetch` + explicit `undici` dep (custom `Agent`/`dispatcher` for IP pinning + `redirect: 'manual'`) |
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
- SSRF guard rejects `http://localhost` and `http://169.254.169.254`.
- README explains setup end-to-end.

## 13. Decisions log

- Language: TypeScript (per user).
- Tools: `search` + `fetch_content` only (no browser, no site crawl).
- License: MIT.
- Folder/repo: `searxng-mcp-ts`.
- Publishing: GitHub-first; npm later (name `searxng-mcp` is taken).
- Context7: remote MCP with API key header (auth tier), used for docs.
