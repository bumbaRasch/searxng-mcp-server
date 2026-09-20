# AGENTS.md

## Library documentation

When you need documentation for a library or API, use the Context7 MCP tools
(`resolve-library-id`, then `query-docs`) instead of relying on memory.

## Rules

- Node >= 22.19, ESM only. Relative imports end in `.js`.
- TypeScript 7 (native/Go) has no programmatic API until 7.1, so `typescript-eslint` is unusable. Lint with Oxlint instead (`pnpm lint`, or `pnpm lint:types` for type-aware rules). Never add ESLint/typescript-eslint.
- MCP logs go to stderr only; stdout is reserved for JSON-RPC.
- Never log secrets.
