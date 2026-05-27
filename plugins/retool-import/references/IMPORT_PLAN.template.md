<plan_state>status=prepared_by_mcp</plan_state>

# Import plan

## Overview

<!-- 1-2 paragraphs derived from Phase 1 recon: what the app is, what it appears to do, what framework / build tool it uses, where the client code lives. Fill confidently from the recon summary. -->

## Routes & pages

<!-- TODO: Retool fills this in -->

<!-- If routes are confidently extractable from the router file, populate this table. Otherwise leave the TODO marker above and remove the empty table. Columns: route | page file | purpose | auth required. One row per route. -->

| route | page file | purpose | auth required |
| ----- | --------- | ------- | ------------- |

## Component tree

<!-- TODO: Retool fills this in -->

<!-- If the entry file's top-down component graph is confidently extractable to depth 3, populate this indented bullet list. Otherwise leave the TODO marker above and delete the empty list below. Annotate each node with `(data-fetching)` if it owns data fetching and `(stateful)` if it owns non-trivial local state. -->

-

## Data needs (resolved)

<!-- One row per discovered service whose category is database / auth / object_storage / realtime — every service the user resolved in Phase 4 HITL. `evidence_paths` lists the source files / config files that triggered detection. `resolved_target` is the Retool resource name the user picked, or `USE_MOCK_DATA`. -->

| category | vendor | evidence_paths | resolved_target | notes |
| -------- | ------ | -------------- | --------------- | ----- |

## External services (resolved)

<!-- One row per discovered service whose category is http_api / email / sms / payments / queue / analytics / search / ai / etc. Same shape as the data-needs table. -->

| category | vendor | evidence_paths | resolved_target | notes |
| -------- | ------ | -------------- | --------------- | ----- |

## Backend functions to author

<!-- TODO: Retool fills this in -->

## Source → target mapping

<!-- TODO: Retool fills this in — `class` column is left blank by the local skill and populated by Retool during Phase 4 classification. -->

| source path | target path | class | transform notes |
| ----------- | ----------- | ----- | --------------- |

## Styling & theming adapters

<!-- TODO: Retool fills this in -->

## Dependency delta

<!-- TODO: Retool fills this in -->

## Cut list

<!-- Files / directories from the source tree that the local skill already dropped via the zip filter (node_modules, dist, build, lockfiles, minified bundles, .env / .env.local, files > 1 MiB, etc.). Retool may append additional entries. -->

-

## Open questions / known gaps

<!-- Anything the local skill couldn't resolve. Always include:
   - Any discovered service with category=unknown.
   - Any discovered service the user did not explicitly resolve in Phase 4.
   - Any prerequisite check that surfaced a soft warning (e.g. ambiguous client-app root in a monorepo).
   - Any limitation of the local matcher (e.g. resource matching is name + type only until host metadata lands).
-->

-

## Phased build order

<!-- TODO: Retool fills this in -->
