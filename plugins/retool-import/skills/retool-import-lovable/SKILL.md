---
name: retool-import-lovable
description: Use this skill when the user wants to import a Lovable-generated React app (legacy Vite + Supabase) into Retool as a Retool React app. Detected by `lovable-tagger` in package.json or a `.lovable/` directory at the repo root. The skill skips vendor-agnostic discovery because Lovable's structure (Vite + react-router-dom + Supabase edge functions calling Lovable's connector gateway) is known up front; it pre-fills the import plan from structural facts, asks targeted HITL only for the choices that genuinely need a human (which Retool resource backs each Supabase edge function and migration), and hands a prepared import plan to Retool's React app sandbox agent via the `retool_submit_prepared_import` MCP tool.
---

# retool-import-lovable

Lovable-specialized variant of the [`retool-import`](../retool-import/SKILL.md) skill. Use this skill instead of the generic one when the project shows Lovable signals — the generic skill detects those signals in its Phase 0 and delegates here automatically. The skill remains directly invocable for users who already know they have a Lovable export.

## Why this exists

The generic `retool-import` skill is vendor-agnostic by design: it runs a closed-taxonomy discovery scan against an arbitrary React repo. That works for any source tool, but it's wasted work for projects with predictable structure. A legacy-Vite Lovable project ALWAYS has:

- Vite + React + `react-router-dom` for the frontend (entry at `src/main.tsx` → `src/App.tsx`)
- Tailwind + shadcn primitives under `src/components/ui/`
- Supabase as the backend: edge functions under `supabase/functions/<name>/index.ts` (Deno runtime) and migrations under `supabase/migrations/*.sql`
- Lovable's connector gateway (`connector-gateway.lovable.dev/<service>`) proxying third-party APIs (Linear, Slack, S3, Gmail, etc.) from inside the edge functions
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_PROJECT_ID` env vars

Because the shape is known, this skill pre-fills the IMPORT_PLAN.md from structural facts and only asks HITL questions that genuinely cannot be answered from the source tree (which Retool resource owns the schema, which Retool resource backs each connector-gateway service).

## Scope

This skill handles **legacy Vite Lovable projects** only. Lovable began emitting TanStack Start projects (with `@tanstack/react-start`, `src/app/__root.tsx`, file-based routing, SSR) around April 2026. Those projects have a different entry shape and routing model and are NOT supported here. See [TanStack guard](#tanstack-guard) below for the refuse behavior.

## State machine overview

The skill runs these steps sequentially. Each has a fixed input, a fixed output, and a fixed exit condition.

1. Prerequisites check — confirm React repo + MCP tools.
2. Lovable signal validation — confirm Lovable signals are present; refuse TanStack projects.
3. Pre-fill — populate the structural facts table from the known Lovable layout (no discovery scan).
4. Targeted HITL — one prompt per Supabase edge function, one combined prompt per migration directory, one prompt for Supabase Auth if used.
5. Produce artifacts — cleaned source tree (shared filter + Lovable-specific drops) plus pre-populated IMPORT_PLAN.md.
6. Handoff — call `retool_submit_prepared_import` with the cleaned tree and plan.

Do NOT skip steps. Do NOT pause for user input outside step 4.

## 1. Prerequisites check

Same as the generic skill. Verify and stop with a clear error if either fails:

1. **React repo.** Read `package.json` at the repo root. The `dependencies` (or `devDependencies`) must include `react`. If not, stop and tell the user this skill targets React apps.
2. **Required MCP tools.** `retool_list_resources` and `retool_submit_prepared_import` must both be visible. If `retool_submit_prepared_import` is missing, stop with: "The retool-import-lovable skill requires `retool_submit_prepared_import`, which is gated by the `mcpServerRetoolImportEnabled` flag. Ask your Retool admin to enable that flag for your org."

## 2. Lovable signal validation

### Lovable signal present

Confirm at least one of:

- `lovable-tagger` in `devDependencies` of the repo root `package.json`
- `.lovable/` directory exists at the repo root
- `src/integrations/supabase/client.ts` AND `src/integrations/supabase/types.ts` both exist (a weaker signal — only treat as positive if combined with one of the above)

If none of these are present, stop and tell the user: "No Lovable signals detected. Use the generic `retool-import` skill instead — it works on any React app via vendor-agnostic discovery."

### TanStack guard

If the repo root `package.json` contains `@tanstack/react-start` (in either `dependencies` or `devDependencies`), OR `src/app/__root.tsx` exists, stop with this message:

```
This project appears to be a Lovable TanStack Start app (post-April 2026
format). This skill currently supports legacy Vite Lovable projects only —
TanStack Start has a different entry shape, file-based routing, and SSR
that need their own transformation recipes.

For now, please run the generic `retool-import` skill, which uses
vendor-agnostic discovery and will still produce a useful import plan
(it just won't pre-fill from Lovable structural knowledge).
```

Do NOT attempt a best-effort import on TanStack projects.

### React entry exists

Confirm `src/main.tsx` and `src/App.tsx` both exist. If either is missing, this isn't a standard Lovable scaffold — stop and point the user at the generic skill.

## 3. Pre-fill from structural facts

The following file-role mapping is true for every legacy-Vite Lovable project. Treat it as ground truth; do not re-derive it via discovery.

| Source path | Role | Disposition |
| ----------- | ---- | ----------- |
| `src/main.tsx` | `createRoot` bootstrap | DROP — Retool's baked `/frontend/index.tsx` owns this |
| `src/App.tsx` | `<Routes>` table | PORT to `/frontend/App.tsx` |
| `src/pages/*.tsx` | route page components | PORT to `/frontend/pages/` |
| `src/components/<feature>.tsx` | feature components | PORT to `/frontend/components/` |
| `src/components/ui/*.tsx` | shadcn primitives | DROP — Retool has these baked at `/frontend/lib/shadcn/` |
| `src/hooks/use-toast.ts`, `src/hooks/use-mobile.tsx` | shadcn hook duplicates | DROP — Retool baked |
| `src/hooks/<other>.{ts,tsx}` | user hooks | PORT to `/frontend/hooks/` |
| `src/lib/utils.ts` | `cn()` helper | DROP — Retool baked has it |
| `src/lib/edge.ts` | `callEdgeFunction` wrapper | DROP — call sites rewrite to generated backend-fn hooks |
| `src/integrations/supabase/client.ts` | Supabase client | DROP — call sites rewrite to generated backend-fn hooks |
| `src/integrations/supabase/types.ts` | auto-generated DB types | DROP from the import; surface schema in HITL instead |
| `src/index.css` | Tailwind directives + global CSS | MERGE custom rules into Retool's baked Tailwind; surface non-default `@layer` blocks in Styling adapters |
| `src/App.css` | additional CSS | PORT to `/frontend/App.css` only if non-empty and not just Vite defaults |
| `src/vite-env.d.ts` | Vite TS shim | DROP — Retool baked |
| `supabase/functions/<name>/index.ts` | Deno edge function | REWRITE as Retool backend function — one HITL prompt per function (see step 4.1) |
| `supabase/migrations/*.sql` | Postgres schema migrations | Surface tables in HITL; user picks Retool Postgres resource (see step 4.2). Do NOT auto-apply. |
| `supabase/config.toml` | Supabase project ID | DROP |
| `public/*` | static assets (favicon, robots.txt, etc.) | PORT to `/frontend/public/` |
| `vite.config.ts` | Vite config (loads `lovable-tagger`) | DROP — Retool owns its baked Vite config |
| `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` | TS configs | DROP — Retool baked |
| `tailwind.config.ts` / `tailwind.config.js` | Tailwind theme | DROP the file; surface non-default theme extensions in Styling adapters |
| `postcss.config.{js,cjs,mjs}` | PostCSS config | DROP — Retool baked |
| `eslint.config.{js,cjs}` | ESLint config | DROP — Retool baked |
| `components.json` | shadcn registry config | DROP — Retool owns its shadcn registry |
| `index.html` | Vite HTML entry | DROP — Retool baked |
| `playwright.config.ts`, `playwright-fixture.ts`, `vitest.config.ts` | testing scaffold | DROP — Retool doesn't execute these |
| `.lovable/sync.config.json` | Lovable GitHub sync metadata | DROP |
| `.env`, `.env.local` | secrets | DROP (already filtered by shared zip filter) |
| `.env.example` | env template | KEEP (shared zip filter already preserves this) |
| lockfiles (`bun.lockb`, `bun.lock`, `package-lock.json`, etc.) | DROP (shared filter) |
| `README.md` | project readme | DROP — usually just the Lovable scaffold placeholder |

If the project contains files at paths NOT listed above (e.g. `src/contexts/`, `src/stores/`, `src/utils/`), default to PORT under `/frontend/<same-relative-path>/`. Only deviate from the table when the source path matches a row.

## 4. Targeted HITL

Run all three prompts in this order. The user answers each in the terminal. After all answers are in, present the resolutions back in a single summary and ask `Proceed? (y/n)`.

### 4.1. Supabase edge functions → Retool resources

For each `supabase/functions/<name>/index.ts` (skip the `_shared/` subdirectory if present — it holds shared helpers, not a function):

1. Read the file.
2. Look for `connector-gateway.lovable.dev/<service>` URLs. The path segment after `.dev/` identifies the upstream service. Common mappings:

   | Gateway path | Inferred category | Compatible Retool resource types |
   | ------------ | ----------------- | -------------------------------- |
   | `linear`, `github`, `notion`, `asana`, `monday`, `jira` | `http_api` | `rest_api`, `graphql` |
   | `slack` | `http_api` | `rest_api` (Retool's Slack integration is wrapped REST) |
   | `aws_s3`, `gcs_storage` | `object_storage` | `s3`, `gcs` |
   | `gmail`, `sendgrid_email` | `email` | `sendgrid`, `smtp`, `rest_api` |
   | `postgres`, `mysql`, `bigquery`, `snowflake` | `database` | the matching native type |
   | `stripe` | `payments` | `stripe`, `rest_api` |
   | `openai`, `anthropic` | `ai` | `openai`, `rest_api` |
   | anything else | `unknown` | (no filter — surface all candidates) |

3. If NO gateway URL is present, the function talks directly to some service via SDK imports or env-var-driven `fetch` calls. Apply the three generic detection heuristics from the [discovery subagent brief](../../agents/discovery-subagent.md#detection-heuristics--apply-generically) — third-party imports, env var references, non-relative HTTP calls — to that single file. Pick the strongest signal and infer the category as above.
4. Call `retool_list_resources` with the compatible-types filter (or no filter for `unknown`). Take the top 3 candidates scored by case-insensitive token overlap between resource name/displayName and the gateway-path tokens.
5. Present the prompt:

   ```
   Edge function: supabase/functions/<name>/
   Calls: <service> via Lovable connector gateway
       (or: "direct <vendor> SDK usage" if no gateway URL)
   Will become Retool backend function: <camelCase from name>

   Compatible Retool resources of type [<types>]:
     1) <name> (<type>, environments: ...)
     2) <name> (<type>, environments: ...)
     3) <name> (<type>, environments: ...)

   Note: resource matching is currently by name + type only;
   host metadata isn't surfaced yet.

   Pick a resource by number, type USE_MOCK_DATA to mock,
   or type a resource name not in the list above.
   ```

6. Record the answer keyed by `(function name, inferred category)`.

### 4.2. Supabase migrations → Retool Postgres resource

If `supabase/migrations/` contains any `*.sql` files:

1. Read every `.sql` file in that directory.
2. Extract table names from `CREATE TABLE [IF NOT EXISTS] <schema>.<name>` statements. Also note any `CREATE POLICY` (RLS) statements, but do NOT try to translate them — surface as open questions.
3. Treat all migrations as one combined Data needs row: `vendor: supabase`, `category: database`.
4. Call `retool_list_resources` with `resource_type=postgres`. Take the top 3 candidates (name + type only).
5. Present:

   ```
   Detected Supabase schema:
     Migrations: <N> .sql files in supabase/migrations/
     Tables: <comma-separated list>
     RLS policies: <count> (will be surfaced as open questions, not auto-translated)

   Compatible Retool Postgres resources:
     1) <name> (postgres, environments: ...)
     2) <name> (postgres, environments: ...)
     3) <name> (postgres, environments: ...)

   Pick a resource by number, USE_MOCK_DATA, or type a custom resource name.

   IMPORTANT: this skill does NOT auto-apply your migrations. After import,
   you'll need to apply the SQL in supabase/migrations/ against your chosen
   Postgres resource manually (or via Retool's follow-up flow).
   ```

6. Record the answer.

### 4.3. Supabase Auth (if detected)

Scan the ported source files for any reference to `supabase.auth.<method>` or imports of `signIn` / `signUp` / `signOut` / `onAuthStateChange` from `@supabase/supabase-js`.

If any are found, present:

```
Supabase Auth detected. Used in: <comma-separated file paths>.

Retool does not currently auto-translate Supabase Auth to Retool sessions.
Pick a strategy:
  1) USE_MOCK_DATA — mock the current user during import; wire later
  2) MAP_TO_RETOOL_SESSION — replace useAuth() / supabase.auth calls
     with Retool's useCurrentUser() hook (best-effort substitution; some
     code paths may need manual review)
  3) Type a custom resolution strategy describing what you want
```

Record the answer.

If no Supabase Auth calls are detected, skip this prompt.

### 4.4. Summary

Present every recorded resolution in one block:

```
Resolutions:
  - <function name>  →  <resource pick or USE_MOCK_DATA>
  - <function name>  →  <resource pick or USE_MOCK_DATA>
  - Supabase schema  →  <postgres resource pick or USE_MOCK_DATA>
  - Supabase Auth    →  <strategy>
```

Then ask `Proceed? (y/n)`. On `n`, return to whichever prompt the user wants to revise. On `y`, proceed to step 5.

## 5. Produce artifacts

### 5a. Cleaned source tree

Walk the repo and apply the shared zip filter at `../../references/filter-constants.ts` (`shouldSkipZipEntry`, `isTextFile`, per-file 1 MiB cap, aggregate 50 MiB cap, 5,000 file count cap).

In addition to the shared filter, drop these Lovable-specific paths (always):

- `vite.config.ts`
- `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
- `postcss.config.js`, `postcss.config.cjs`, `postcss.config.mjs`
- `eslint.config.js`, `eslint.config.cjs`
- `components.json`
- `tailwind.config.ts`, `tailwind.config.js`
- `index.html`
- `playwright.config.ts`, `playwright-fixture.ts`, `vitest.config.ts`
- `supabase/config.toml`
- All files under `.lovable/`
- All files under `src/components/ui/`
- `src/main.tsx`
- `src/integrations/supabase/client.ts`
- `src/integrations/supabase/types.ts`
- `src/lib/edge.ts`
- `src/vite-env.d.ts`
- `README.md` (drop only if its content is the default Lovable scaffold; otherwise keep)

Stop and warn the user if the file count exceeds 5,000 or the aggregate size exceeds 50 MiB. Surface the offending paths and ask how to proceed.

Build a `Record<string, { code: string }>` keyed by repo-relative path. This is the `files` payload for `retool_submit_prepared_import`.

### 5b. IMPORT_PLAN.md

Start from `../../references/IMPORT_PLAN.template.md`. Fill in:

**`<plan_state>status=prepared_by_mcp</plan_state>`** — already in the template; keep it.

**Overview** — 2-3 sentences identifying this as a Lovable (legacy Vite) + Supabase project. Mention the React entry, the count of Supabase edge functions, and the count of migrations. Example: "Legacy-Vite Lovable project with React entry at `src/main.tsx` → `src/App.tsx`. Backend is 3 Supabase edge functions and 1 migration creating 1 table. The edge functions proxy Linear, Slack, and AWS S3 via Lovable's connector gateway."

**Routes & pages** — parse the `<Routes>` table from `src/App.tsx`. For each `<Route path="..." element={<X />} />`:

| route | page file | purpose | auth required |
| ----- | --------- | ------- | ------------- |
| `/` | `src/pages/Index.tsx` | <one-line purpose from the page component> | Y/N |

`auth required` is `Y` if the page imports anything from `@supabase/supabase-js` auth helpers, else `N`. If `src/App.tsx`'s route table can't be parsed cleanly (unusual route shape, dynamic imports), leave the `<!-- TODO: Retool fills this in -->` marker and an empty table.

**Component tree** — walk `src/App.tsx` → page imports → component imports to depth 3. Indented bullet list. Annotate nodes:
- `(data-fetching)` if they use `useQuery`, `supabase.from()`, or `callEdgeFunction`
- `(stateful)` if they call `useState` with more than trivial flags

**Data needs (resolved)** — one row per Supabase edge function whose inferred category is `database`/`auth`/`object_storage`/`realtime`, plus the combined migrations row.

| category | vendor | evidence_paths | resolved_target | notes |
| -------- | ------ | -------------- | --------------- | ----- |
| database | supabase | `supabase/migrations/*.sql` | <user pick> | tables: <comma-sep> |
| object_storage | aws-s3-via-lovable-gateway | `supabase/functions/s3-files/index.ts` | <user pick> | via Lovable connector gateway |

**External services (resolved)** — one row per Supabase edge function whose inferred category is `http_api`/`email`/`sms`/`payments`/`queue`/`analytics`/`search`/`ai`/`unknown`.

| category | vendor | evidence_paths | resolved_target | notes |
| -------- | ------ | -------------- | --------------- | ----- |
| http_api | linear-via-lovable-gateway | `supabase/functions/linear-tickets/index.ts` | <user pick> | via Lovable connector gateway |

**Backend functions to author** — pre-populate one row per edge function. Retool fills the target path and any implementation hints.

| backend fn | source | description |
| ---------- | ------ | ----------- |
| `<camelCase of dir name>` | `supabase/functions/<name>/index.ts` | <one-sentence summary from the file's first comment or first call> |

**Source → target mapping** — pre-populate every row from the structural-facts table in step 3 (every file the skill actually saw, with its disposition). Leave the `class` column BLANK — Retool fills it in Phase M classification.

| source path | target path | class | transform notes |
| ----------- | ----------- | ----- | --------------- |
| `src/App.tsx` | `/frontend/App.tsx` | | port verbatim; substitute react-router import to Retool's react-router |
| `src/pages/Index.tsx` | `/frontend/pages/Index.tsx` | | port; rewrite supabase.from/callEdgeFunction to generated hooks |
| `src/integrations/supabase/client.ts` | DROP | | call sites rewrite to generated backend-fn hooks |
| `supabase/functions/linear-tickets/index.ts` | `/backend/functions/getLinearTickets.ts` (or similar) | | call Retool Linear resource (<user pick>); preserve action routing |

Above the table, place `<!-- partial: rows populated by retool-import-lovable; class column left blank for Retool -->` so Retool knows the rows are real, not placeholders.

**Styling & theming adapters** — if `tailwind.config.ts` extends the default theme, list the extension keys here (e.g. "custom colors: brand-primary, brand-secondary; custom fontFamily: 'Sora'"). If `src/index.css` contains `@layer` blocks beyond Tailwind's defaults, list those. If neither, write "No non-default theme extensions detected. Use Retool's baked Tailwind config as-is."

**Dependency delta** — list the packages in `package.json` that need migration treatment:

- ADD: <leave blank — Retool decides what's missing from `/frontend/package.json`>
- SUBSTITUTE: `@supabase/supabase-js` → generated backend-fn hooks (no direct dep)
- DELETE: `lovable-tagger`, `@vitejs/plugin-react-swc` (Retool baked uses its own Vite plugin)
- KEEP: `react`, `react-dom`, `react-router-dom`, all `@radix-ui/*`, `@tanstack/react-query`, `lucide-react`, `tailwind-merge`, `clsx`, `class-variance-authority`, `recharts`, `date-fns`, `react-hook-form`, `zod`, etc.

**Cut list** — populate from step 5a's drop list. Include both canonical drops (lockfiles, `.env`, `__MACOSX/`) and Lovable-specific drops (`lovable-tagger`-loading `vite.config.ts`, `components.json`, `src/components/ui/`, etc.). One bullet per dropped path with a one-line reason.

**Open questions / known gaps** — always include:

- "Migrations are NOT auto-applied. Run `supabase/migrations/*.sql` against the chosen Postgres resource manually after import."
- "Resource matching is currently name + type only; host metadata isn't yet surfaced by `retool_list_resources`."
- For every `USE_MOCK_DATA` resolution: "<service name> is mocked during import; wire to a real resource later."
- If Supabase Auth was detected and resolved to MAP_TO_RETOOL_SESSION: "Retool will attempt a best-effort substitution of `useAuth()` / `supabase.auth.*` calls with `useCurrentUser()`. Some code paths may require manual review."
- If any RLS policies were detected in the migrations: "RLS policies in the original schema are NOT translated. Retool will apply at the application layer if you specify per-row permissions; otherwise the Retool resource's access controls apply."
- If any edge function's category was `unknown`: "<function name> couldn't be classified from the gateway URL or imports. Retool will need to determine the right backend-function shape."

**Phased build order** — leave the `<!-- TODO: Retool fills this in -->` marker. Retool derives this in Phase M.

## 6. Handoff

Call `retool_submit_prepared_import` with:

```
{
  files: <cleaned source tree from step 5a>,
  importPlan: <IMPORT_PLAN.md content from step 5b>,
  targetAppId: <optional — ask the user "Import into an existing app? (paste app ID, or press Enter for a new app)" before calling>
}
```

Stream progress notifications as they arrive. When the tool returns, surface the editor URL:

```
Done. Your Retool app is at: <editor URL>
```

If the tool call fails, surface the error verbatim and stop. Do NOT retry silently.

## Hard rules / safety

- Never read `.env` or `.env.local`. Only `.env.example` is safe.
- Never auto-apply `supabase/migrations/*.sql` against any database — always surface the SQL and tell the user to apply manually.
- Never auto-resolve a Retool resource pick without HITL, even when there's exactly one candidate of the matching type.
- TanStack Start Lovable projects are out of scope. Refuse with the message in [TanStack guard](#tanstack-guard). Do NOT attempt a best-effort import.
- If a Supabase edge function's gateway URL doesn't match the known mapping table, classify the inferred category as `unknown` and surface in open questions — do NOT force-fit it into a category it doesn't belong to.
- Never write outside the user's repo. The skill's only outputs are the in-terminal HITL prompts and the `retool_submit_prepared_import` MCP tool call.

## Summary for the user

This skill imports a legacy-Vite Lovable + Supabase project into Retool as a Retool React app. It skips the generic vendor-agnostic discovery scan because Lovable's structure is well-known: it pre-fills the import plan from structural facts, asks one HITL prompt per Supabase edge function (mapping each to a Retool resource) plus one combined prompt per migration directory, packages your source tree with secrets and vendor-specific configs stripped, and hands the prepared plan to Retool's React app sandbox agent. You'll get an editor URL when Retool finishes generating the app.
