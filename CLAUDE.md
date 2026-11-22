# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
pnpm test                                    # vitest (test/**/*.test.ts)
pnpm vitest run test/fetch-content.test.ts   # one file
pnpm vitest run -t "name substring"          # one test by name
pnpm test:coverage                           # enforced thresholds in vitest.config.ts (lines 99.2%), CI fails below
pnpm lint && pnpm lint:types                 # oxlint; lint:types = type-aware (tsgolint)
pnpm typecheck                               # tsc --noEmit (TypeScript 7 native)
pnpm format:check                            # prettier
pnpm build                                   # dist/ via tsconfig.build.json
node scripts/e2e.mjs                         # live e2e over stdio; needs a build + `docker compose up -d` (SearXNG on 127.0.0.1:8888)
node scripts/e2e-http.mjs                    # same over Streamable HTTP
```

CI gate (`.github/workflows/ci.yml`): lint, lint:types, format:check, typecheck, test, test:coverage, build, pack. Definition of done: `pnpm lint && pnpm lint:types && pnpm typecheck && pnpm test`.

Version bumps go through `pnpm version`; its hook runs `scripts/sync-version.mjs` to keep `src/version.ts` and `server.json` in sync with package.json (a test enforces this).

## Architecture

MCP server (13 tools) in front of a self-hosted SearXNG. Full module map and dependency direction: `docs/design.md`. Cross-file essentials:

- **Transports**: `src/index.ts` selects stdio (default) or Streamable HTTP (`src/http-server.ts`); both share the `createServer()` factory (`src/server.ts`). HTTP is stateless (fresh `McpServer` per request) and serves the 2026-07-28 revision only (`legacy: 'reject'`).
- **Process-scoped stores** deliberately outlive requests so a `ref:N` minted on one HTTP request resolves on the next: `sharedRefs` (`src/refs.ts`), `sharedPages` (`src/crawl.ts`), `sharedTaskStore` (`src/tasks.ts`).
- **Category registry** (`src/categories/`): `search`, `image_search`, `news_search`, `video_search`, `music_search`, `paper_search` are generated from one `defineCategory` declaration each (schema, projector, markdown lines); `src/tools.ts` loops over `categoryDefinitions`. `search` adds a bespoke slice (answers, infoboxes, batch `queries`); the remaining tools are registered beside the loop. New category: follow `docs/extending.md` (one file + an entry in `categories/index.ts`).
- **Schemas**: `src/schemas/` is one zod module per consumer with **no barrel**; import the concrete module.
- **Two outbound paths**: instance-bound requests (search, autocomplete, `/config`) use the failover client in `src/searxng.ts` (`SEARXNG_URLS`, opt-in TTL cache, opt-in HTML fallback, redirects refused). `fetch_content`/crawl/deep_search hit arbitrary URLs through the SSRF-guarded pipeline (`src/fetch.ts` + `src/ssrf.ts`): guarded DNS lookup re-run at connect time, every redirect hop re-validated. Never route web fetches around it.
- **Untrusted output**: all web-derived text goes through the wrapping/sanitizing helpers in `src/format.ts` (untrusted banner, marker neutralization, `sanitizeMeta` from `categories/shared.ts`). New renderers must use them.
- **Injectable seams**: `FetchLike` and DNS `lookup` are threaded via `ToolDeps` from `createServer`/`registerTools`, so tests never monkey-patch. Use `test/helpers.ts` (`makeConfig`, `asFetchLike`, `jsonResponse`, `HTML_PAGE`).
- **Declared extensions**: `src/server.ts` declares `io.modelcontextprotocol/{tasks,skills,ui}`. Declaring obligates serving (`src/tasks.ts`, `src/skills.ts`, `src/apps.ts`); `test/server.test.ts` pins the `initialize` shape.
- **SDK bumps are deliberate**: comments like "verified against SDK v2.3.1" (e.g. `src/tasks.ts`) mark places to re-check on every MCP SDK upgrade.
- SearXNG JSON API quirks (answers are objects, `unresponsive_engines` are pairs, no `number_of_results`) are in `docs/design.md` → "SearXNG JSON API notes".
- `docs/design.md` → "Non-goals" lists settled scope cuts; don't relitigate without new evidence.
