---
name: retool-import
description: Use this skill when the user wants to import an existing React application into Retool as an R^2 app. The skill runs in the user's repo, discovers external services the app talks to, matches them against the user's Retool resources via MCP, asks the user to confirm matches via in-terminal HITL, and hands a prepared import plan + cleaned source tree to Retool's R^2 sandbox agent for execution.
---

# retool-import

This skill is invoked when the user opens Claude Code in the root of their existing React app, has the Retool MCP server attached, and asks to import the app into Retool. The skill runs a six-phase local state machine and hands a prepared import plan to Retool's R^2 sandbox agent via the `retool_submit_prepared_import` MCP tool.

## State machine overview

The skill runs six phases sequentially. Each phase has a fixed input, a fixed output, and a fixed exit condition. Do NOT skip phases. Do NOT pause for user input outside of Phase 4 (HITL).

1. Prerequisites check — confirm we are in a React repo and that the required MCP tools are available.
2. Phase 1 — Recon. Read a tight set of files and emit a structured summary of the workspace shape.
3. Phase 2 — Discovery scan. Fan out vendor-agnostic discovery subagents against the directory tree.
4. Phase 3 — Resource matching. For each discovered service, call `retool_list_resources` for compatible types and rank candidates.
5. Phase 4 — HITL. One prompt per distinct service. User picks a resource by number or `USE_MOCK_DATA`. Summarize the resolutions back for final confirm.
6. Phase 5 — Produce artifacts. Walk the repo with the zip filter to build a cleaned source tree, and fill in `IMPORT_PLAN.template.md`.
7. Phase 6 — Handoff. Call `retool_submit_prepared_import` with the cleaned tree and partial plan. Stream progress. Surface the editor URL.

## Prerequisites check

Before Phase 1, verify two things and stop with a clear error if either fails:

1. **React repo.** Read `package.json` at the repo root. If absent, look for a single clearly-identifiable client subdirectory (`packages/<x>/package.json` or `apps/<x>/package.json`) and use that as the client root. In either case, the `dependencies` (or `devDependencies`) must include one of: `react`, `react-dom`, `next`, `vite`, `remix`, `@remix-run/*`, `gatsby`, `expo`. If none is present, stop and tell the user this skill targets React apps.
2. **Required MCP tools.** The skill needs `retool_list_resources` (existing) and `retool_submit_prepared_import` (new, gated by the `mcpServerRetoolImportEnabled` flag). If `retool_submit_prepared_import` is not visible as an MCP tool, stop and tell the user: "The retool-import skill requires `retool_submit_prepared_import`, which is gated by the `mcpServerRetoolImportEnabled` flag. Ask your Retool admin to enable that flag for your org."

If both checks pass, proceed to Phase 1.

## Phase 1 — Recon

Mirror R2's Phase 1. Discover the workspace shape and emit a structured summary. Read only what's strictly necessary.

Procedure:

1. Examine the top-level directory shape of the repo (one `ls` of the repo root).
2. Search for and read all `package.json` files across the repo (skip anything inside `node_modules`).
3. Read all `README.md` files at the root and at each `package.json`'s directory, if present.
4. Find and read the React entry file. The entry file is typically `src/main.tsx`, `src/main.ts`, `src/index.tsx`, `src/index.ts`, or `app/page.tsx` / `app/layout.tsx` for Next.js / `app/root.tsx` for Remix. Pick whichever exists.
5. If the router config lives in a separate file (`router.tsx`, `routes.ts`, `app/routes/*` for Remix, `pages/*` for older Next, or `app/*` for Next App Router), read it.
6. Identify server-side directories (`server/`, `backend/`, `api/`, `functions/`, `supabase/functions/`, etc.) if any exist.

Emit a structured recon summary in chat, in this EXACT shape:

```
Workspace shape: <one sentence>
Top-level directories: <comma-separated list of every immediate child directory of the repo root>
Entry file: <absolute path>
Client-app root: <directory containing the entry file>
Client package.json: <absolute path(s) — comma-separated if a monorepo has multiple at equal depth>
Server-side directories: <absolute path(s) or "none">
```

If the workspace shape does not match anything familiar, report what you actually found and proceed. Do NOT read more files than strictly necessary to produce the summary.

Proceed to Phase 2 immediately.

## Phase 2 — Discovery scan

Vendor-agnostic discovery, run in parallel via fanned-out subagents. The output is a flat list of discovered services keyed by `(category, vendor)`.

### Fan-out sizing

- N = (count of top-level directories from Phase 1) + 1 if any uncovered root files exist.
- K = 3 (per-cluster subtree budget — max 3 subtrees grouped into one subagent brief).
- Use the `Agent` tool to dispatch subagents in parallel. Each subagent gets its own brief.
- Every file in the repo must be covered by exactly one subagent.

### Subagent brief

Paste the verbatim brief from `references/../agents/discovery-subagent.md` into each subagent's prompt, filling the `Scope:` and `Question:` slots. The brief is a fixed template — do NOT paraphrase it. Each subagent emits a Markdown document with one `## <category>` section per category whose rows have at least one match in its scope.

### Category taxonomy (closed)

Categories are a closed set. Vendor is a free-text string the model fills in based on what it observes — NOT a closed enum.

| Category | Definition |
| :--- | :--- |
| `database` | SQL/NoSQL clients, ORMs, query builders |
| `auth` | Sign-in / sign-up / session / token handling, identity providers, current-user lookups |
| `object_storage` | File uploads, blob storage, signed URLs |
| `realtime` | Websocket / pubsub / channel subscriptions |
| `http_api` | Non-relative `fetch` / `axios` / `ky` calls, RPC clients, GraphQL clients |
| `email` | Transactional email SDKs / APIs |
| `sms` | SMS / messaging SDKs / APIs |
| `payments` | Payments processors and billing SDKs |
| `queue` | Message queues, job queues, pub/sub brokers (non-UI) |
| `analytics` | Product analytics, event pipelines |
| `search` | Hosted search indexes |
| `ai` | LLM / embedding / vector-DB providers |
| `unknown` | Surface it; do NOT force-fit |

### Detection heuristics (apply generically)

Subagents apply these four heuristics across every file in scope. Do NOT ship a static registry of vendor regexes — the model judges from the package's role.

- **Third-party package imports.** Classify by the role the SDK's API plays. A package whose top-level export creates a database client → `database`. A package whose API revolves around `signIn` / `getUser` / `onAuthStateChange` → `auth`. A package whose API revolves around uploading files / signed URLs → `object_storage`.
- **Env var references.** `process.env.X`, `import.meta.env.X`, Vite-style `VITE_X`. Names like `*_URL`, `*_API_KEY`, `*_SECRET`, `DATABASE_URL`, `*_PROJECT_ID` signal external services. Cross-reference with `.env.example`. NEVER read `.env` or `.env.local`.
- **Non-relative HTTP calls.** `fetch(url, ...)` / `axios.METHOD(url, body)` etc. with a non-relative URL. Group by host. Relative URLs (same-origin `/api/...`) are the app's OWN backend and do NOT count.
- **Configuration files.** `firebase.json`, `supabase/config.toml`, `prisma/schema.prisma`, `drizzle.config.ts`, `wrangler.toml`, etc. The filename itself is strong vendor + category evidence.

### Discovered-services output shape

The parent agent merges every subagent's output into a flat list. Each entry uses this exact shape:

```
- category: database
  vendor: supabase
  evidence:
    - file: src/lib/supabase.ts
      lines: 1-3
      snippet: import { createClient } from '@supabase/supabase-js'
    - file: .env.example
      lines: 1
      snippet: VITE_SUPABASE_URL=https://<project>.supabase.co
  inferredConfig:
    url_env_var: VITE_SUPABASE_URL
    detected_host: db.<projectid>.supabase.co
```

`vendor` is free-text and lowercase. The same vendor that triggers multiple categories produces multiple entries — one per category, evidence may overlap. If a vendor cannot be determined, set `vendor: unknown` and keep the evidence.

### Worked example (intuition, not a registry)

A Lovable + Supabase repo typically yields three entries with `vendor: supabase` and categories `database`, `auth`, `realtime`. A Firebase app should produce analogous entries with `vendor: firebase` and the same three categories — **with no code changes to this skill**. A Prisma + Postgres app should yield `{ category: database, vendor: prisma }` and (if `DATABASE_URL` points at a managed host) a separate hint in `inferredConfig`. A hand-rolled REST app with `axios.get('https://api.example.com/...')` should yield `{ category: http_api, vendor: example-api }`.

If you find yourself adding a vendor-specific code path, that is a smell — push the rule back into the generic category-based reasoning.

Proceed to Phase 3 once every subagent has returned and the merged list is built.

## Phase 3 — Resource matching

For each discovered service, build a ranked candidate list of Retool resources.

Procedure for each service:

1. **Map `category` to compatible Retool resource types.** Use this mapping:
   - `database` → `postgres`, `mongodb`, `mysql`, `bigquery`, `snowflake`, `redshift`, `mssql`, `dynamodb`, `redis`
   - `auth` → no direct Retool resource maps to auth; surface the service but expect `USE_MOCK_DATA` or a custom resolution
   - `object_storage` → `s3`, `gcs`
   - `realtime` → no direct Retool resource maps; surface the service but expect `USE_MOCK_DATA`
   - `http_api` → `rest_api`, `graphql`
   - `email` → `sendgrid`, `smtp`, `rest_api`
   - `sms` → `twilio`, `rest_api`
   - `payments` → `stripe`, `rest_api`
   - `queue` → `kafka`, `rest_api`
   - `analytics` → `rest_api`
   - `search` → `elasticsearch`, `rest_api`
   - `ai` → `openai`, `rest_api`
   - `unknown` → call `retool_list_resources` with no `resource_type` filter; surface all candidates and let the user decide
2. **Call `retool_list_resources` once per compatible type** (or once with no filter for `unknown`). Aggregate the results.
3. **Score candidates** and take the top 3:
   - Hard filter: keep only resources whose `type` is in the compatible set.
   - Soft score: case-insensitive token overlap between the resource's `name` / `displayName` and the discovered service's `vendor` plus tokens from `inferredConfig.url_env_var` (e.g. `VITE_SUPABASE_URL` → tokens `supabase`, `url`).
   - Break ties by `accessLevel` (prefer broader access) then by alphabetical `name`.

### Honest limitation note

Until A5 / A6 land, `retool_list_resources` returns only `{ name, displayName, type, accessLevel, environments }` — no host / port / database name. Scoring is name + type ONLY. Surface this limitation honestly when presenting candidates to the user. Do NOT pretend the matcher knows more than it does.

Proceed to Phase 4 once every service has its top-3 candidate list (which may be empty for some services).

## Phase 4 — HITL (in-terminal)

For each discovered service, prompt the user. HITL is one prompt per **distinct service**, NOT per row of evidence. A service is a `(category, vendor)` tuple from Phase 2.

For each service, present this exact shape (substituting the actual values):

```
Service: supabase (category: database)
Also triggers: auth, realtime
Evidence: 5 files import @supabase/supabase-js, .env.example sets VITE_SUPABASE_URL.

Compatible Retool resources of type [postgres, mongodb, mysql, bigquery, snowflake, redshift, mssql, dynamodb, redis]:
  1) prod_db (postgres, environments: production, staging)
  2) staging_db (postgres, environments: staging)
  3) analytics (bigquery, environments: production)

Note: until host metadata lands in the matcher, ranking is by name + type only.

Pick a resource by number, or type USE_MOCK_DATA to mock this service, or type a resource name not in the list above.
```

Rules:

- Always include `USE_MOCK_DATA` as an option.
- Always allow free-text input for "pick a different resource not in the top 3".
- NEVER auto-resolve without user input — even when there is exactly one candidate.
- If a vendor appears in multiple categories (e.g. Supabase = database + auth + realtime), present ONE prompt that covers all categories the vendor triggers. The user's single answer resolves every category for that vendor.
- Record the user's choice keyed by `(vendor, category)` so the Phase 5 plan-fill can look it up per category.

After every service has an answer, summarize the resolutions back to the user in a single block and ask "Proceed? (y/n)". On `n`, return to the prompt loop for the user to revise. On `y`, proceed to Phase 5.

## Phase 5 — Produce artifacts

### 5a. Cleaned source tree

Walk the repo from the root and apply the filter from `references/filter-constants.ts`:

1. Skip directories whose path contains any segment in `SKIPPED_ZIP_DIRS` (`node_modules`, `.git`, `dist`, `build`, `.next`, `.vite`, `.cache`, `.turbo`, `coverage`, `.expo`, `__pycache__`, `__MACOSX`).
2. Skip lockfiles in `SKIPPED_LOCKFILES`.
3. Skip files whose basename matches `MINIFIED_OR_MAP_RE` (minified bundles and source maps).
4. Skip `.env` and `.env.local`. KEEP `.env.example`.
5. Skip files larger than `APP_IMPORT_MAX_FILE_BYTES` (1 MiB).
6. Stop and warn the user if the file count exceeds `APP_IMPORT_MAX_FILE_COUNT` (5,000) or the aggregate size exceeds `APP_IMPORT_MAX_TOTAL_BYTES` (50 MiB). Surface the offending paths or the count and ask the user how to proceed.
7. For surviving files, read the bytes only if `isTextFile(path)` returns true. Non-text files (images, etc.) are recorded by path but with empty content unless they fit a text extension.

Build a `Record<string, { code: string }>` keyed by repo-relative path. This is the payload for `retool_submit_prepared_import`.

### 5b. Partial IMPORT_PLAN.md

Start from `references/IMPORT_PLAN.template.md`. Fill in every section the local skill can confidently populate; leave a `<!-- TODO: R2 fills this in -->` marker in sections it cannot.

- **`<plan_state>status=prepared_by_mcp</plan_state>`** — at the top. The template already includes this; keep it.
- **Overview** — 1-2 paragraphs derived from the Phase 1 recon summary.
- **Routes & pages** — populate if the router file's routes are confidently extractable. Otherwise leave the TODO marker.
- **Component tree** — populate if the entry file's top-down graph to depth 3 is confidently extractable. Otherwise leave the TODO marker.
- **Data needs (resolved)** — one row per discovered service whose category is `database` / `auth` / `object_storage` / `realtime`. Columns: `category | vendor | evidence_paths | resolved_target | notes`. `resolved_target` is the resource name the user picked in Phase 4, or `USE_MOCK_DATA`.
- **External services (resolved)** — one row per discovered service whose category is `http_api` / `email` / `sms` / `payments` / `queue` / `analytics` / `search` / `ai` / `unknown`. Same columns as Data needs (resolved).
- **Backend functions to author** — leave the TODO marker. R2 derives this from Data needs in Phase 4.
- **Source → target mapping** — leave the table header but no rows. R2 fills both the rows and the `class` column. Place a `<!-- TODO: R2 fills this in -->` marker above the table.
- **Styling & theming adapters** — leave the TODO marker.
- **Dependency delta** — leave the TODO marker.
- **Cut list** — populate with any path the zip filter dropped that the user should know about (e.g. `node_modules/`, `dist/`, `.env`, oversized files).
- **Open questions / known gaps** — populate with: every `category=unknown` service, every service for which the user picked `USE_MOCK_DATA`, the matcher's name+type-only limitation, any prerequisite-check soft warnings.
- **Phased build order** — leave the TODO marker.

Do NOT fill sections you cannot fill confidently. R2 expects to see the TODO markers and treats them as work assignments.

Proceed to Phase 6 once both artifacts are built.

## Phase 6 — Handoff

Call `retool_submit_prepared_import` with:

```
{
  files: <the cleaned source tree from 5a>,
  importPlan: <the IMPORT_PLAN.md content from 5b>,
  targetAppId: <optional — ask the user "Import into an existing app? (paste app ID, or press Enter for a new app)" before calling>
}
```

Stream progress notifications back to the user as they arrive from the tool call. When the tool returns, surface the editor URL clearly:

```
Done. Your Retool app is at: <editor URL>
```

If the tool call fails, surface the error verbatim and stop. Do NOT retry silently.

## Hard rules / safety

- Never write outside the user's repo without asking. The skill's only outputs are the in-terminal prompts and the `retool_submit_prepared_import` MCP tool call.
- Never read `.env` or `.env.local`. Only `.env.example` is safe.
- If discovery finds a service the user did not acknowledge in Phase 4, do NOT silently skip — surface it as an open question in the plan.
- If `retool_submit_prepared_import` is not available as an MCP tool, stop at Phase 5 and tell the user to enable `mcpServerRetoolImportEnabled` for their org.
- Discovery is LLM-driven against the closed category taxonomy. Vendor is a free-text string. Do NOT add vendor-specific code paths — the same skill must work on Supabase, Firebase, Prisma, hand-rolled REST, etc.

## Summary for the user

This skill recons your React repo, fans out parallel discovery subagents to find every external service your code talks to (databases, auth, storage, realtime, HTTP APIs, payments, etc.), looks up matching Retool resources for each one, asks you to pick the right resource (or `USE_MOCK_DATA`) per service in the terminal, packages your source tree with secrets and large files stripped out, builds a partially-populated `IMPORT_PLAN.md`, and hands it all to Retool's R^2 sandbox agent. R^2 finishes classification and execution; you end up with a working Retool app whose editor URL is printed at the end.
