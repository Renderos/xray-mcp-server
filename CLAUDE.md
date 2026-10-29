# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote MCP server (Streamable HTTP, stateless) that exposes Xray Cloud (Jira test management) operations as tools for Claude: test steps, Test Plans, Test Executions, and run/step statuses. Meant to be deployed (e.g. to Railway) and added as a custom connector in Claude.

Code comments and tool descriptions are in Spanish; match that style when editing `src/tools.ts` and `src/xray.ts`.

## Commands

```bash
npm install
cp .env.example .env        # all vars optional; no Xray credentials here
npm run dev                  # tsc build + run with .env loaded
npm run build                # tsc only -> dist/
npm start                    # run compiled dist/index.js (no .env loading)
npx @modelcontextprotocol/inspector   # http://localhost:3000/mcp, OAuth with your Xray client_id/secret
```

There is no test suite or linter configured. `tsc` (`strict: true`) is the only correctness check — run `npm run build` after changes to catch type errors.

## Architecture

Three files, each with a distinct responsibility:

- **`src/index.ts`** — Express app, HTTP layer and a minimal stateless OAuth 2.1 authorization server. **No Xray credentials live on the server**: the user enters their Xray API key as the connector's OAuth Client ID/Secret; `/token` (authorization_code + PKCE S256, or refresh_token) exchanges them with Xray and returns the Xray JWT itself as `access_token`. The auth code is just base64url JSON carrying the PKCE challenge (not secret — useless without a valid client_secret); refresh tokens are opaque since refresh re-authenticates with the credentials the client resends. `/mcp` requires `Bearer <Xray JWT>` (only `exp` is checked locally; Xray verifies the signature) and answers 401 with `WWW-Authenticate: ... resource_metadata=...` otherwise. The server is **stateless per request**: `createServer()` builds a fresh `McpServer` + `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) for every POST to `/mcp`, and both are closed when the response closes. Don't add cross-request state here (e.g. sessions, in-memory caches keyed by connection) — it won't work with this model.

- **`src/xray.ts`** — Xray Cloud client: `authenticate()` (credentials → JWT, nothing cached), a single `gql()` helper wrapping the GraphQL endpoint that reads the request's JWT from `AsyncLocalStorage` (set by `withXrayToken` in `index.ts`, so tools need no token plumbing), and Jira-key → Xray `issueId` resolution (`resolveKey`/`resolveKeys`, batched 100 at a time via JQL `key in (...)`). All tools go through `gql()`; there's no REST fallback.

- **`src/tools.ts`** — All MCP tool definitions via `registerTools(server)`, called once per request-scoped server in `index.ts`. Conventions to follow when adding a tool:
  - Every user-facing test/plan/execution parameter is a Jira key (`key()`/`keys()` zod helpers validate `PROJECT-123` format); tools resolve keys to Xray `issueId`s internally via `resolveKey`/`resolveKeys` — never expose raw Xray IDs as inputs.
  - Wrap the handler body in `wrap(fn)`, which converts thrown errors into `{ isError: true }` tool results instead of letting them propagate — don't add your own try/catch for this.
  - Set `annotations` to one of `RO` (read-only), `WRITE`, or `DESTRUCTIVE` (spread with overrides like `idempotentHint` as needed) so clients can reason about side effects.
  - `xray_graphql` is the intentional escape hatch for anything not covered by a dedicated tool — it's marked `DESTRUCTIVE` since arbitrary mutations are possible through it.
  - Step lookups by ordinal (`xray_update_step_status`) are 1-indexed against the step order returned by `getTestRun`.

## Environment variables

All optional; there are intentionally no secrets in the server environment.
- `XRAY_BASE_URL` — region override, e.g. `https://eu.xray.cloud.getxray.app`; defaults to the global endpoint.
- `PUBLIC_URL` — public base URL for OAuth metadata, if it can't be derived from the request (`trust proxy` is on).
- `OAUTH_REDIRECT_URIS` — extra allowed redirect URIs (comma-separated); claude.ai/claude.com callbacks and `http://localhost` are always allowed.
- `PORT` (optional, default 3000).
