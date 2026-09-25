# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote MCP server (Streamable HTTP, stateless) that exposes Xray Cloud (Jira test management) operations as tools for Claude: test steps, Test Plans, Test Executions, and run/step statuses. Meant to be deployed (e.g. to Railway) and added as a custom connector in Claude.

Code comments and tool descriptions are in Spanish; match that style when editing `src/tools.ts` and `src/xray.ts`.

## Commands

```bash
npm install
cp .env.example .env        # fill in XRAY_CLIENT_ID, XRAY_CLIENT_SECRET, MCP_ACCESS_TOKEN
npm run dev                  # tsc build + run with .env loaded
npm run build                # tsc only -> dist/
npm start                    # run compiled dist/index.js (no .env loading)
npx @modelcontextprotocol/inspector   # test against http://localhost:3000/mcp/<MCP_ACCESS_TOKEN>
```

There is no test suite or linter configured. `tsc` (`strict: true`) is the only correctness check — run `npm run build` after changes to catch type errors.

## Architecture

Three files, each with a distinct responsibility:

- **`src/index.ts`** — Express app and HTTP/auth layer. Auth accepts the token either as a path param (`/mcp/<token>`, for Claude's custom-connector UI) or as a `Bearer` header, compared with `timingSafeEqual`. The server is **stateless per request**: `createServer()` builds a fresh `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) for every POST to `/mcp` or `/mcp/:token`, and both are closed when the response closes. Don't add cross-request state here (e.g. sessions, in-memory caches keyed by connection) — it won't work with this model.

- **`src/xray.ts`** — Xray Cloud client: JWT auth (cached in-module for ~23h, transparently re-authenticated on a 401), a single `gql()` helper wrapping the GraphQL endpoint, and Jira-key → Xray `issueId` resolution (`resolveKey`/`resolveKeys`, batched 100 at a time via JQL `key in (...)`). All tools go through `gql()`; there's no REST fallback.

- **`src/tools.ts`** — All MCP tool definitions via `registerTools(server)`, called once per request-scoped server in `index.ts`. Conventions to follow when adding a tool:
  - Every user-facing test/plan/execution parameter is a Jira key (`key()`/`keys()` zod helpers validate `PROJECT-123` format); tools resolve keys to Xray `issueId`s internally via `resolveKey`/`resolveKeys` — never expose raw Xray IDs as inputs.
  - Wrap the handler body in `wrap(fn)`, which converts thrown errors into `{ isError: true }` tool results instead of letting them propagate — don't add your own try/catch for this.
  - Set `annotations` to one of `RO` (read-only), `WRITE`, or `DESTRUCTIVE` (spread with overrides like `idempotentHint` as needed) so clients can reason about side effects.
  - `xray_graphql` is the intentional escape hatch for anything not covered by a dedicated tool — it's marked `DESTRUCTIVE` since arbitrary mutations are possible through it.
  - Step lookups by ordinal (`xray_update_step_status`) are 1-indexed against the step order returned by `getTestRun`.

## Environment variables

- `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET` — Xray API key, server-side only.
- `MCP_ACCESS_TOKEN` — must be ≥32 chars (the process exits at startup otherwise); this token is the only auth for the endpoint, so treat the deployed URL containing it as a secret.
- `XRAY_BASE_URL` (optional) — region override, e.g. `https://eu.xray.cloud.getxray.app`; defaults to the global endpoint.
- `PORT` (optional, default 3000).
