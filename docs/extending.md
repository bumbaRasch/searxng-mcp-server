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
     `max_results` budget; reuse the shared bounds and helpers from
     `categories/shared.ts` (`truncateText`, `asStringArray`,
     `pickPublishedDate`, ...).
   - `renderResultLines`: the per-result markdown lines. They land inside the
     untrusted wrapper; run every web-derived string through `sanitizeMeta`.
2. **`src/categories/index.ts`** — export the file and add the definition to
   `categoryDefinitions`. That is the only edit outside the new file: input
   schemas are composed from the shared atoms (`categoryInputSchema`, keyed on
   `upstream.supportsTimeRange`) and the output schema comes from the
   definition itself; optional convenience handles may live in
   `src/schemas.ts`. `registerTools` and `TOOL_NAMES` pick the tool up
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

Definition of done: `pnpm lint && pnpm lint:types && pnpm typecheck && pnpm test`
and the `registerTools` test (which asserts `TOOL_NAMES` parity) is green.
