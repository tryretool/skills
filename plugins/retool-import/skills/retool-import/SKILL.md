---
name: retool-import
description: Use this skill when the user wants to import an existing React application into Retool as a Retool React app. The skill runs in the user's repo, discovers external services the app talks to, matches them against the user's Retool resources via MCP, asks the user to confirm matches via in-terminal HITL, and hands a prepared import plan + cleaned source tree to Retool's React app sandbox agent for execution.
---

# retool-import

This skill prepares a user's app for being imported into Retool via MCP. The skill runs a six-phase local state machine and hands a prepared import plan to Retool's React app sandbox agent via the two-step `retool_start_prepared_import` / `retool_finalize_prepared_import` MCP flow, falling back to the inline `retool_submit_prepared_import` tool only if that flow errors.

## State machine overview

The skill runs these phases sequentially. Each phase has a fixed input, a fixed output, and a fixed exit condition. Do NOT skip phases — except that Phase 0 may delegate to a sibling skill, in which case this skill stops entirely and the sibling owns the rest of the flow. Do NOT pause for user input outside of Phase 4 (HITL) and the compatibility gate's soft-no confirm.

1. Prerequisites check — confirm we are in a React repo and that the required MCP tools are available.
2. Compatibility gate — run the deterministic `import-policy` classifier. A `hard_no` app type is blocked locally before any work is done; `soft_no` (Next.js) asks the user to confirm a best-effort import; `supported` proceeds.
3. Phase 0 — Source-tool detection. Look for known source-tool signals (e.g. `lovable-tagger`, `.lovable/`). On a positive match, delegate to the matching sibling skill via the Skill tool and STOP. On no match, proceed to Phase 1.
4. Phase 1 — Recon. Read a tight set of files and emit a structured summary of the workspace shape.
5. Phase 2 — Discovery scan. Fan out vendor-agnostic discovery subagents against the directory tree.
6. Phase 3 — Resource matching. For each discovered service, call `retool_list_resources` for compatible types and rank candidates.
7. Phase 4 — HITL. One prompt per distinct service. User picks a resource by number or `USE_MOCK_DATA`. Summarize the resolutions back for final confirm.
8. Phase 5 — Produce artifacts. Walk the repo with the zip filter to build a cleaned source tree, and fill in `IMPORT_PLAN.template.md`.
9. Phase 6 — Handoff. `retool_start_prepared_import` with the plan, PUT a zip of the cleaned tree to the returned upload URL, then `retool_finalize_prepared_import` — falling back to inline `retool_submit_prepared_import` only if a step errors. Stream progress. Surface the editor URL.

## Prerequisites check

Before Phase 1, verify two things and stop with a clear error if either fails:

1. **JS/React-family repo.** Read `package.json` at the repo root. If absent, look for a single clearly-identifiable client subdirectory (`packages/<x>/package.json` or `apps/<x>/package.json`) and use that as the client root. In either case, the `dependencies` (or `devDependencies`) must include one of: `react`, `react-dom`, `next`, `vite`, `gatsby`, `expo`. If none is present, stop and tell the user this skill targets React apps. This check only confirms the repo is a JS frontend project at all — it is intentionally permissive. Whether the specific app *type* is importable (e.g. `next`/`gatsby`/`expo` are NOT supported targets) is decided authoritatively by the Compatibility gate below, not here.
2. **Required MCP tools.** The skill needs `retool_list_resources` (existing) plus the import tools gated by the `mcpServerRetoolImportEnabled` flag. The preferred handoff uses `retool_start_prepared_import` + `retool_finalize_prepared_import`; if those aren't visible but `retool_submit_prepared_import` is, the skill uses the inline submit instead (see Phase 6). If none of the import tools are visible, stop and tell the user: "The retool-import skill requires the Retool import tools, gated by the `mcpServerRetoolImportEnabled` flag. Ask your Retool admin to enable that flag for your org."

If both checks pass, proceed to the Compatibility gate.

## Compatibility gate

Retool's React app import supports a specific set of app types. This gate runs the SAME deterministic policy as Retool's browser-based import (the pre-agent classifier in `appImportClassifier/`), but LOCALLY — so an unsupported app type is blocked here, before any discovery work or any handoff to Retool's R2 agent. The policy is mirrored in `references/import-policy.mjs`; keep that file in sync with the upstream `rules.ts` / `classifier.ts`.

Run the classifier against the client root (the directory whose `package.json` you found in the prerequisites check — pass the repo root for a single-package repo):

```
node <this skill's dir>/../../references/import-policy.mjs <client-root-absolute-path>
```

It prints one line of JSON: `{ "verdict": "hard_no" | "soft_no" | "supported", "identifiedAs": "<tech>", "reasons": [...] }`. The classifier looks ONLY at manifest files (`package.json` deps, `app.json` shape, config-file presence) — never at source code — and ignores `node_modules`, build output, etc. Act on `verdict`:

- **`hard_no`** — STOP. The app type is not supported. Tell the user verbatim, substituting `identifiedAs`:

  ```
  Your app uses <identifiedAs>, which isn't supported by Retool's React app import yet.
  See supported frameworks: https://docs.retool.com/build/apps/guides/import
  ```

  Do NOT run discovery, build artifacts, or call any import tool. The skill ends here.

- **`soft_no`** — this is the Next.js carve-out. Best-effort is possible but the result may need cleanup. Prompt the user once and WAIT for an answer:

  ```
  <identifiedAs> imports are not supported.
  We're still learning how to handle <identifiedAs>. We'll attempt the build,
  but the result may need some cleanup.

  Attempt a best-effort import anyway? (y/n)
  ```

  On `n` (or anything not affirmative), STOP — no discovery, no handoff. On `y`, proceed to Phase 0, and in Phase 5 record under **Open questions / known gaps**: "Best-effort import of a `<identifiedAs>` app the user explicitly approved; the result may need cleanup."

- **`supported`** — proceed to Phase 0 with no prompt.

If `node` is unavailable or the script errors (non-zero exit), do NOT silently skip the gate: tell the user the local compatibility check couldn't run, and proceed only if they confirm — Retool's R2 agent will re-validate compatibility on its side as a fallback (its `evaluate_app_compatibility` tool), so an unsupported app may still be rejected after handoff.

## Phase 0 — Source-tool detection

Before the vendor-agnostic discovery scan runs, do a quick structural check for known source-tool conventions. If the project matches one of the supported per-tool specializations, delegate to the matching sibling skill via the Skill tool and STOP — the sibling owns the rest of the flow.

This is the ONLY place in this skill where vendor-specific knowledge is encoded. Detection looks at *signal files* (a known package name in `package.json`, a known directory) — it does NOT classify code behavior. Phases 1–4 below remain strictly vendor-agnostic.

### Detection signals

Read the repo root `package.json` and the top-level directory listing exactly once. Check signals in this order — first match wins:

| Signal (any of) | Source tool | Sibling skill |
| --------------- | ----------- | ------------- |
| `lovable-tagger` in `devDependencies` OR `.lovable/` directory exists at repo root | Lovable (legacy Vite) | `retool-import:retool-import-lovable` |

(Future per-tool specializations land here as they ship.)

### Delegation

On a positive match:

1. Tell the user briefly: "Detected this is a `<source tool>` project. Switching to the `<sibling skill name>` specialization for a more accurate import."
2. Invoke the matching sibling skill via the Skill tool. The sibling will run its own validation and proceed.
3. STOP. Do NOT continue with Phase 1+ in this skill.

On no match, proceed to Phase 1 with the generic vendor-agnostic flow.

### Why detection is structural

The generic discovery in Phases 1–4 intentionally avoids vendor-specific code paths so it works on any React app — Supabase, Firebase, Prisma, hand-rolled REST, etc. Phase 0 is the one exception, and it stays narrow on purpose: it only looks at signal files whose presence is a near-deterministic fingerprint of the source tool (e.g. `lovable-tagger` is only emitted by Lovable's Vite scaffold). This means Phase 0 cannot mistakenly route a vendor-agnostic React app to a per-tool skill.

If you find yourself wanting to add a Phase 0 signal that requires reading code behavior to disambiguate, push the rule into the matching sibling skill's own validation instead — keep Phase 0 here as a fast signal-file scan only.

## Phase 1 — Recon

Discover the workspace shape and emit a structured summary. Read only what's strictly necessary.

Procedure:

1. Examine the top-level directory shape of the repo (one `ls` of the repo root).
2. Search for and read all `package.json` files across the repo (skip anything inside `node_modules`).
3. Read all `README.md` files at the root and at each `package.json`'s directory, if present.
4. Find and read the React entry file. The entry file is typically `src/main.tsx`, `src/main.ts`, `src/index.tsx`, `src/index.ts`, or `app/page.tsx` / `app/layout.tsx` for Next.js. Pick whichever exists.
5. If the router config lives in a separate file (`router.tsx`, `routes.ts`, `pages/*` for older Next, or `app/*` for Next App Router), read it.
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

Build a `Record<string, { code: string }>` keyed by repo-relative path. This is the cleaned source tree — zipped and uploaded in the preferred two-step handoff, or passed as the inline `files` payload in the submit fallback (Phase 6).

### 5b. Partial IMPORT_PLAN.md

Start from `references/IMPORT_PLAN.template.md`. Fill in every section the local skill can confidently populate; leave a `<!-- TODO: Retool fills this in -->` marker in sections it cannot.

- **`<plan_state>status=prepared_by_mcp</plan_state>`** — at the top. The template already includes this; keep it.
- **Overview** — 1-2 paragraphs derived from the Phase 1 recon summary.
- **Routes & pages** — populate if the router file's routes are confidently extractable. Otherwise leave the TODO marker.
- **Component tree** — populate if the entry file's top-down graph to depth 3 is confidently extractable. Otherwise leave the TODO marker.
- **Data needs (resolved)** — one row per discovered service whose category is `database` / `auth` / `object_storage` / `realtime`. Columns: `category | vendor | evidence_paths | resolved_target | notes`. `resolved_target` is the resource name the user picked in Phase 4, or `USE_MOCK_DATA`.
- **External services (resolved)** — one row per discovered service whose category is `http_api` / `email` / `sms` / `payments` / `queue` / `analytics` / `search` / `ai` / `unknown`. Same columns as Data needs (resolved).
- **Backend functions to author** — leave the TODO marker. Retool derives this from Data needs in Phase 4.
- **Source → target mapping** — leave the table header but no rows. Retool fills both the rows and the `class` column. Place a `<!-- TODO: Retool fills this in -->` marker above the table.
- **Styling & theming adapters** — leave the TODO marker.
- **Dependency delta** — leave the TODO marker.
- **Cut list** — populate with any path the zip filter dropped that the user should know about (e.g. `node_modules/`, `dist/`, `.env`, oversized files).
- **Open questions / known gaps** — populate with: every `category=unknown` service, every service for which the user picked `USE_MOCK_DATA`, the matcher's name+type-only limitation, any prerequisite-check soft warnings.
- **Phased build order** — leave the TODO marker.

Do NOT fill sections you cannot fill confidently. Retool expects to see the TODO markers and treats them as work assignments.

Proceed to Phase 6 once both artifacts are built.

## Phase 6 — Handoff

Hand the prepared import to Retool's React app sandbox agent. **Prefer the two-step flow**; fall back to the inline submit only if a step of the two-step flow errors.

### Preferred — two-step flow

1. Call `retool_start_prepared_import` with `{ importPlan: <the IMPORT_PLAN.md content from 5b>, targetAppId: <optional — ask "Import into an existing app? (paste app ID, or press Enter for a new app)" first> }`. It provisions the sandbox and returns `importId` plus a time-limited `upload.url` and `upload.token`.

2. Zip the cleaned source tree from 5a (paths repo-relative, no leading slash) and PUT it to `upload.url` with `Authorization: Bearer <upload.token>` and `Content-Type: application/zip`. On a 503 the sandbox dev server is still starting — wait ~2s and retry.

3. After the PUT succeeds, call `retool_finalize_prepared_import` with the returned `importId` to confirm the upload and surface the editor URL.

### Fallback — inline submit (only on a two-step error)

If `retool_start_prepared_import` is unavailable, the upload PUT keeps failing after the 503 retry, or `retool_finalize_prepared_import` errors, recover by calling `retool_submit_prepared_import` once with the files inlined: `{ files: <the cleaned source tree from 5a>, importPlan: <the IMPORT_PLAN.md content from 5b>, targetAppId: <same optional app id> }`. Do NOT use the inline submit as the first attempt — it's the recovery path for when the two-step file transfer fails.

When the handoff returns (from finalize or the submit fallback), stream progress and surface the editor URL clearly:

```
Done. Your Retool app is at: <editor URL>
```

Surface any terminal error verbatim and stop — an error from the submit fallback, or a two-step error the fallback can't recover. Do NOT retry silently beyond the documented 503 upload retry.

## Hard rules / safety

- Never write outside the user's repo without asking. The skill's only outputs are the in-terminal prompts and the import handoff (the `retool_start_prepared_import` / upload PUT / `retool_finalize_prepared_import` flow, or the `retool_submit_prepared_import` fallback).
- Never read `.env` or `.env.local`. Only `.env.example` is safe.
- The Compatibility gate is authoritative on app-type support and runs BEFORE any discovery or handoff. Never bypass a `hard_no` verdict, and never hand a `soft_no` app to Retool without the user's explicit best-effort confirm. `references/import-policy.mjs` mirrors Retool's upstream `appImportClassifier` (`rules.ts` / `classifier.ts`) — when the upstream policy changes, update that file rather than editing the rules inline in this skill.
- If discovery finds a service the user did not acknowledge in Phase 4, do NOT silently skip — surface it as an open question in the plan.
- If none of the import tools (`retool_start_prepared_import`, `retool_finalize_prepared_import`, `retool_submit_prepared_import`) are available as MCP tools, stop at Phase 5 and tell the user to enable `mcpServerRetoolImportEnabled` for their org.
- Phase 2 (discovery) is LLM-driven against the closed category taxonomy. Vendor is a free-text string. Do NOT add vendor-specific code paths in Phase 2 — the same discovery pass must work on Supabase, Firebase, Prisma, hand-rolled REST, etc. Phase 0 is the only place vendor-specific knowledge is encoded, and it operates on signal files alone (never on code behavior).

## Summary for the user

This skill first runs a deterministic compatibility gate that blocks app types Retool can't import (mobile, non-JS backends, non-React frontends) locally before any work happens — Next.js gets a best-effort confirm. For a supported app it then recons your React repo, fans out parallel discovery subagents to find every external service your code talks to (databases, auth, storage, realtime, HTTP APIs, payments, etc.), looks up matching Retool resources for each one, asks you to pick the right resource (or `USE_MOCK_DATA`) per service in the terminal, packages your source tree with secrets and large files stripped out, builds a partially-populated `IMPORT_PLAN.md`, and hands it all to Retool's React app sandbox agent. Retool finishes classification and execution; you end up with a working Retool app whose editor URL is printed at the end.
