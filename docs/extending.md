# Adding a new search tool (category)

A category is data: one definition file carries the whole tool slice, and the
registry generates the schemas, params mapping, client path, handler, renderer
and registration from it.

1. **`src/categories/<name>.ts`** — one `defineCategory` call:
   - `tool`: `name` (snake_case), `title`, `description` (the untrusted-data
     suffix and annotations are appended at registration time).
   - `upstream`: `categories` (the SearXNG categories sent upstream) and
     `supportsTimeRange` (adds the shared `time_range` input when `true`).
   - `heading`: the word used in `# <heading> results for ...`.
   - `resultSchema`: the zod schema of one projected result. `defineCategory`
     derives the tool's output schema from it (the
     query/results/suggestions/unresponsiveEngines envelope over
     `resultSchema`).
   - `projectResult`: defensive `raw → Result | undefined` projection —
     return `undefined` to drop a garbage item without consuming the
     `max_results` budget; reuse the shared bounds and helpers
     (`truncateText`, `asStringArray`, `pickCount`, ... from
     `categories/shared.ts`; `pickPublishedDate` from `categories/general.ts`).
   - `renderResultLines`: the per-result markdown lines. They land inside the
     untrusted wrapper; run every web-derived string through `sanitizeMeta`.
2. **`src/categories/index.ts`** — export the file and add the definition to
   `categoryDefinitions`. That is the only edit outside the new file: input
   schemas are composed from the shared atoms (`categoryInputSchema`, keyed on
   `upstream.supportsTimeRange`) and the output schema comes from the
   definition itself; optional convenience handles live in
   `src/categories/schemas.ts`. `registerTools` and `TOOL_NAMES` pick the tool up
   automatically. If the category needs more than the shared envelope, model it
   as a bespoke slice next to the loop in `src/tools.ts` (the way `search`
   keeps its answers/corrections/infoboxes).
3. **Tests** — `test/categories.test.ts` covers the registry plumbing; add a
   category file test for projector + renderer lines, a schema test for the
   generated input/output handles, and a handler success/error test.
4. **Docs** — README intro + Tools section and the `docs/design.md` intro (tool
   list and the tool-count sentence above the module table); the module table
   itself is invariant.
5. **`scripts/e2e.mjs`** — the `TOOL_NAMES` import covers listing; add a live
   call only if the bundled SearXNG has engines for the category.

## Young extensions policy

The wire is pinned to specific spec editions, so new-tool work must not
silently drift across them:

| Wire piece | Pinned to | Anchor in code |
|---|---|---|
| `io.modelcontextprotocol/tasks` and the whole HTTP transport | the 2026-07-28 protocol revision (the `/mcp` endpoint serves that revision only; 2025-era requests get a typed rejection) | `src/tasks.ts`, `src/http-server.ts` |
| `io.modelcontextprotocol/ui` (MCP Apps) | ext-apps stable 2026-01-26 ("This extension is identified as: io.modelcontextprotocol/ui"); the iframe-handshake gallery assumes it | `src/apps.ts` |
| `io.modelcontextprotocol/skills` | SEP-2640, Final | `src/skills.ts` |
| Trace passthrough | SEP-414 | `src/otel.ts` |

Policy:

- **Quarterly reconciliation** with the upstream spec sources — the core
  protocol + ext-tasks, `modelcontextprotocol/ext-apps`,
  `modelcontextprotocol/ext-skills`, and SEP-2577's capability-declaration
  work (the SDK documents that the client capabilities SEP-2577 deprecated as
  of 2026-07-28 — `roots`, `sampling` — "remain in the specification for at
  least twelve months", so that window, not a rumor of a breaking change,
  drives when to react).
- **SDK updates are deliberate, never a silent Renovate merge.** The code
  carries wire-verified assumptions against a concrete SDK version — e.g.
  the `CreateTaskResult` field passthrough in `src/tasks.ts` is commented
  "verified against SDK v2.3.1". An SDK bump means re-checking every such
  comment-marked place before merging.

Reconciliation log: ext-tasks overview PR #35 (2026-10-20) fixed the
documented missing-client-capability error in the overview from `-32003` to
`-32021` — the code our gate already answers (`src/tasks.ts`); no wire
change on our side.

Definition of done: `pnpm lint && pnpm lint:types && pnpm typecheck && pnpm test`
and the `registerTools` test (which asserts `TOOL_NAMES` parity) is green.
