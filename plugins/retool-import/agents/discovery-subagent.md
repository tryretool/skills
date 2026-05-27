# Discovery subagent brief

The Phase 2 parent agent dispatches one subagent per cluster of files. Paste this entire brief verbatim into each dispatched subagent's prompt, filling the `Scope:` and `Question:` slots. Do NOT omit any slot.

```
Scope: <one or more subtree paths and/or an explicit root-file list, comma-separated>
Question: For every file in your scope, classify the external services the file talks to per the category taxonomy below. Identify every applicable category a file triggers — a single file can trigger multiple categories (e.g. a Supabase client file usually triggers database + auth + realtime). Apply the heuristics and the taxonomy verbatim — do NOT special-case any specific vendor.
Output:
  Markdown document. Emit ONE `## <category>` section per category whose rows have at least one match in your scope; OMIT sections with no rows. Use the EXACT output shape below.

  <Discovery-category reference: parent pastes the full reference below, verbatim>

Be concise. No full file dumps. Snippets are 1-3 lines maximum.
```

## Vendor-agnosticism — read first

Vendor is a free-text string you fill in based on what you observe in the file. Categories are closed; vendor is open. Do NOT special-case Supabase / Firebase / AWS / any specific provider. The same brief applied to a Firebase app and a Supabase app must produce structurally identical output, differing only in the `vendor` field and the evidence paths.

If you find yourself reaching for a vendor-specific rule, stop. Re-read the file through the lens of the generic category definition and the detection heuristics. The category is what matters; the vendor is a label.

## Detection heuristics — apply generically

Run all four heuristics across every file in scope. A single file can match multiple heuristics — record the strongest evidence, not all of it.

1. **Third-party package imports.** Look at `import ... from '<package>'` statements. If the package name looks like a service SDK (cloud provider, BaaS, ORM, payments processor, observability tool, etc.), classify it by the role its API plays in the file — not by a list of known vendors. Examples of the kind of judgment to make: a package whose top-level export creates a database client → category `database`; a package whose API revolves around `signIn` / `getUser` / `onAuthStateChange` → category `auth`; a package whose API revolves around uploading files / returning signed URLs → category `object_storage`.
2. **Env var references.** Look for `process.env.X` / `import.meta.env.X` / Vite-style `VITE_X` references. Names like `*_URL`, `*_API_KEY`, `*_SECRET`, `DATABASE_URL`, `*_PROJECT_ID` signal an external service. Cross-reference with `.env.example` at the repo root (NEVER read `.env` or `.env.local`). The variable name often discloses the vendor (`SUPABASE_URL`, `FIREBASE_API_KEY`, `STRIPE_SECRET_KEY`) — use that as the vendor string.
3. **Non-relative HTTP calls.** `fetch(url, ...)`, `axios.METHOD(url, body)`, `ky(...)`, generated SDK clients, GraphQL client setups. Group calls by host. Relative-path calls (same-origin `/api/...` etc.) are the app's OWN backend and do NOT count as an external service — skip them.
4. **Configuration files.** Files like `firebase.json`, `supabase/config.toml`, `prisma/schema.prisma`, `drizzle.config.ts`, `wrangler.toml`, `vercel.json`, `netlify.toml`, etc. The filename itself is strong evidence of the vendor and category — classify accordingly.

## Discovery-category reference

Use the EXACT output shape listed for each category. Each emitted section must use this shape. Vendor is free-text.

- **database** — clients / ORMs / query builders that talk to a primary data store (SQL, NoSQL, document, columnar, etc.).
- **auth** — sign-in / sign-up / session / token handling, identity providers, current-user lookups, role / permission checks tied to an external identity service.
- **object_storage** — file uploads, blob storage, signed-URL generation.
- **realtime** — websocket / pubsub / channel subscriptions, server-sent events tied to an external service.
- **http_api** — non-relative `fetch` / `axios` / `ky` calls, RPC clients, GraphQL clients hitting an external host. Group by host.
- **email** — transactional email SDKs / APIs.
- **sms** — SMS / messaging SDKs / APIs.
- **payments** — payments processors and billing SDKs / APIs.
- **queue** — message queues, job queues, pub/sub brokers used outside of the realtime UI subscription pattern above.
- **analytics** — product analytics, event pipelines.
- **search** — hosted search indexes.
- **ai** — LLM / embedding / vector-DB providers.
- **unknown** — a third-party SDK / env var / non-relative HTTP host that is clearly external but does not fit any category above. Surface it; do NOT force-fit it into an existing category.

### Output shape per category (verbatim)

For each category whose rows have at least one match in scope, emit a section in this exact YAML-block-inside-markdown shape:

```
## <category>

- category: <category>
  vendor: <free-text vendor string, lowercase, hyphens for spaces>
  evidence:
    - file: <repo-relative path>
      lines: <start>-<end>
      snippet: <1-3 line code or config snippet>
    - file: <repo-relative path>
      lines: <start>-<end>
      snippet: <1-3 line code or config snippet>
  inferredConfig:
    url_env_var: <env var name if discoverable, else omit>
    api_key_env_var: <env var name if discoverable, else omit>
    detected_host: <hostname if discoverable, else omit>
```

One entry per (category, vendor) pair within scope. If the same vendor triggers multiple categories (e.g. Supabase triggering database + auth + realtime), emit ONE entry per category — do NOT merge categories on a single entry. Evidence may overlap across the entries.

If the scope contains nothing that triggers a category, OMIT that category's section entirely. Do NOT emit empty sections.

## Rules

- Read source files; do NOT read `.env` or `.env.local`. `.env.example` is safe to read.
- Match by role, not by brand. If you see an SDK whose name you've never encountered but whose API shape clearly fits a category (e.g. its top-level export creates a client and you see `.from(table).select(...)`), classify it as `database` with `vendor: <package name>` and move on.
- Do NOT cap rows. Every distinct (category, vendor) tuple in scope gets an entry, even if there are many.
- Snippets are 1-3 lines. Never dump a full file.
- If you cannot confidently determine a vendor for a detected category, set `vendor: unknown` and surface the evidence so the parent can ask the user.
