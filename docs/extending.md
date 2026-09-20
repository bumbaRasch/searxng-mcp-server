# Adding a new search tool (category)

Every category tool touches the same vertical slice. Work top to bottom:

1. **`src/schemas.ts`** — add `<name>SearchInput` (compose from the shared argument
   atoms `queryArg`/`enginesArg`/`languageArg`/`pagenoArg`/`safesearchArg`/`maxResultsArg`;
   add `time_range` from the shared `timeRange` enum only if SearXNG supports
   `time_range` for the category), `<name>SearchOutput` (build on the
   query/results/suggestions/unresponsiveEngines envelope), and `to<Name>SearchParams`
   mapping to `categories=<searxng-category>`.
2. **`src/searxng.ts`** — add `project<Name>Result` (normalize + truncate; reuse
   `normalizeDuration`/`pickPublishedDate`/`asStringArray`) and expose
   `map<Name>Response` via `mapCategoryResponse`. Add a thin client
   `<name>Search(config, params: SearchParams, opts)`.
3. **`src/format.ts`** — add `format<Name>Results` on the `renderCategoryResults`
   skeleton; keep every web-derived string inside the untrusted wrapper or behind
   `sanitizeMeta`.
4. **`src/tools.ts`** — build the handler with `createCategoryHandler` (it maps args via
   `to<Name>SearchParams`), add the `registerTool` block (description via
   `withUntrustedSuffix`, `TOOL_ANNOTATIONS`), and append the name to `TOOL_NAMES`.
5. **Tests** — `test/schemas.test.ts` (input/output/mapper), `test/searxng.test.ts`
   (projector + client), `test/format.test.ts` (renderer exact-match),
   `test/tools.test.ts` (handler success + error path).
6. **`scripts/e2e.mjs`** — the `TOOL_NAMES` import covers listing; add a live call
   only if the bundled SearXNG has engines for the category.
7. **Docs** — README intro + Tools section and the `docs/design.md` intro (tool
   list and the tool-count sentence above the module table); the module table
   itself is invariant.

Definition of done: `pnpm lint && pnpm lint:types && pnpm typecheck && pnpm test`
and the `registerTools` test (which asserts `TOOL_NAMES` parity) is green.
