# Stage 1.5 · Capability list — what the source can do, and how the connector exposes it

**Contents**

- 1.5a Get the source's API description — the ladder (3.9)
- 1.5b Read and map — by script
- 1.5c Review and group — by model
- 1.5d What the test account can show — before research (3.6)
- 1.5e The vendor's own MCP server — a three-way comparison (3.8, on by default)

Prerequisite: Stage 1 (the connector's tables, procedures and permissions are in `$KNOWLEDGE_FILE`).

The question this runtime answers is **"can I do through CData what the source can do?"** That
needs a list of what the source can do that does not come from us. The connector's table list
cannot show what is missing, and a model's research varies by run and by model. The source's own
API description can, and reading it is mechanical — so a script reads it.

```
source API description ──► capability list ──► mapping to the connector ──► review ──► business areas
      (vendor)                 (script)              (script)               (model)      (model)
```

## 1.5a Get the source's API description — the ladder (3.9)

Climb the ladder; the **first rung that yields a list wins**, and the rung is recorded (it is shown in
every report). Only the vendor's own material counts: a third-party mirror may be stale or partial.
With `--api-docs <url>` the user names the vendor's documentation page; otherwise search for it.

| Rung | What | How |
|---|---|---|
| 1 · spec | A machine-readable description: OpenAPI / Swagger (also behind ReadMe, Redoc, Stoplight and Swagger UI portals), OData `$metadata`, WSDL, RAML, a GraphQL schema | `api-from-docs.mjs ladder --docs <docs page> [--github <org>]` reads the page's portal config and links, tries the common paths (`/openapi.json`, `/swagger.json`, `/api-docs`, `/v3/api-docs` …) and the vendor's GitHub repositories, and saves the first file whose content is a description. Also search `"<Source> OpenAPI specification"` and look for a "Download OpenAPI" button. |
| 2 · postman · sdk | A Postman collection v2.1 from the vendor ("Run in Postman") · an official SDK's entity or service list | A collection is converted like a spec. An SDK is read like reference pages (rung 3 steps) with its source files as the pages, `merge --rung sdk`; its entity list also feeds the completeness hint (`--entities`). |
| 3 · reference_docs | The API reference web pages | Inventory, read, extract, merge — below. |

```bash
node "<skill>/scripts/api-from-docs.mjs" ladder  --dir "<dir>" --docs "<API docs page>" [--github <org>]
node "<skill>/scripts/api-from-docs.mjs" convert --dir "<dir>" --file "<dir>/_agent_out/api-docs/source.<ext>" --url "<where from>"
```

`convert` keeps a vendor OpenAPI exactly as published (`<Connector>_api.<json|yaml>`) and turns the
other forms into the same OpenAPI shape: an OData entity set becomes read, create, update and delete
(unless its Capabilities annotations say otherwise), a WSDL or GraphQL operation keeps its name, a
Postman request its folder and name. Record `run_meta.capability_spec = {url, fetched_at, source}`
with `source` the rung.

**Rung 3 — from the reference pages.** When the ladder finds nothing, read the pages with the shared
page reader (`references/10a-page-reader.md`): plain HTTP when it shows the text, a rendered browser when
the site is a JavaScript shell, never a paid crawler.

```bash
node "<skill>/scripts/api-from-docs.mjs" probe     --dir "<dir>" --url "<ref page 1>,<ref page 2>"
node "<skill>/scripts/api-from-docs.mjs" inventory --dir "<dir>" --sitemap <url|file> | --index <url|file> | --urls <file> [--include <regex>]
node "<skill>/scripts/api-from-docs.mjs" snap      --dir "<dir>" --pending                         # READER http
node "<skill>/scripts/api-from-docs.mjs" snap      --dir "<dir>" --url <u> --text-file <f> --fetcher <reader>   # READER rendered, per page
node "<skill>/scripts/api-from-docs.mjs" prep      --dir "<dir>"
node "<skill>/scripts/api-from-docs.mjs" merge     --dir "<dir>" [--entities <sdk entity list>]
node "<skill>/scripts/api-from-docs.mjs" status    --dir "<dir>"
```

1. **Inventory.** List every reference page from `sitemap.xml`, the docs navigation or an index page;
   `--include` keeps the API reference and excludes the rest with a reason. Every page ends extracted
   or excluded with a reason (`exclude --url|--match --why "…"`); `status` exits 3 until it does.
2. **Read and save.** `snap` saves each page's own text under `_agent_out/api-docs/<hash>.txt` with its
   URL (long pages also in parts). A page that still reads as a shell is refused. For a JavaScript-drawn
   site, `render` (3.9.3) reads the pages in a headless browser already on the machine and writes the text
   straight to disk — no model carries it — and refuses any page `robots.txt` disallows; `ingest` files text
   a person downloaded from their own browser (`10a-page-reader.md` §2).
3. **Extract — by model, from the saved text only.** `prep` writes `extract-input.json`: batches of
   saved pages and the contract. Dispatch one `general-purpose` agent per batch
   (`model: config.models.research`). Each returns `{"ops":[{entity, operation, method, path, summary,
   doc_url, evidence}], "pages_without_ops":[{doc_url, reason}]}` to `_agent_out/api-docs/ops-<batch>.json`:
   `method` and `path` **as documented** (Intuit updates and deletes by POST, `?operation=delete` — kept,
   never normalised), `evidence` one line copied word for word from that page.
4. **Merge — by script.** `merge` rejects an operation whose `doc_url` is not in the inventory, whose
   page was not saved, or whose `evidence` is not on that page word for word; merges duplicates (same
   entity, operation and method); and writes `<Connector>_api.json` in the OpenAPI shape `read` takes:
   the documented method and path (`x-path`), the page (`x-doc-url`), the line (`x-evidence`), the
   entity and kind (`x-entity`, `x-kind`), and `info.x-assembled {rung, fetcher, pages, excluded, at}`.
   Operation ids are `<verb><Entity>` (createInvoice, getInvoice, voidInvoice), so a re-read keeps
   reviewed mappings. **Completeness hint:** the connector's tables (from the knowledge file) and the SDK's
   entities that no operation acts on are listed for review in `merge-report.json` and
   `info.x-assembled.review` — never added automatically. Look for the missing page, or confirm the
   table is the connector's own view (a line-item table, a report).

`capability-list.mjs read` then records `source.kind` (`spec` · `postman` · `sdk` · `reference_docs`)
and `source.pages`; the capability and analysis reports say "API list assembled from N reference
pages" and link each capability to its page. A list read from a spec shows exactly what it did before.

### An API list assembled without evidence (3.9.2)

A `<Connector>_api.json` written by hand, or by a model from the docs outside `api-from-docs.mjs`,
looks like a spec to every later stage, so the numbers built on it go unchecked. `lib/api-provenance.mjs`
tells the three apart: **published** (the vendor's own description — never flagged), **assembled**
(`info.x-assembled`; from pages or an SDK every operation also has `x-doc-url` and `x-evidence`) and
**unverified**. A list is unverified only on a positive sign: `run_meta.capability_spec.source` is
`reference_docs` with no `x-assembled`; the capability list's `source.kind` says assembled but records
no assembly; the file's own title or description says it was assembled or that no OpenAPI is
published; or an assembly from pages has operations without their page or quoted line. Shape alone
never decides — a vendor spec slimmed to its paths (two specs combined, responses dropped) is still
the vendor's — but when a sign is there, "no responses, no schemas" is named beside it.

In capability mode `detect-stage.mjs` routes an unverified list to **1.5a** before research
continues, with the reason on one line and the frozen areas named (they stay frozen). Rebuild it
with the ladder above, then re-read:

```bash
node "<skill>/scripts/capability-list.mjs" read   --dir "<dir>" --spec "<dir>/<Connector>_api.json"   # lists added · removed · moved
node "<skill>/scripts/capability-list.mjs" map    --dir "<dir>"                                         # maps only the new ids
node "<skill>/scripts/capability-list.mjs" status --dir "<dir>"                                         # what changed, frozen areas affected
```

`read` keeps the reviewed mapping and the area grouping of every id that still matches, takes removed
ids out of their areas, and records `rebuild {added, removed, moved}` in the capability list.
**1.5c reviews only the added ones (and looks again at the moved ones** — same id, another documented
method, path or kind). A frozen catalog area whose use cases need a removed or moved capability is
named by `read`, `status` and the router as a warning — **flagged, never unfrozen**: check those use
cases' `capabilities`, and unfreeze the area yourself only if one no longer holds (`11-catalog.md`).
`orchestrator-advice.mjs` calls such a source "assembled (unverified)", and the capability and analysis
reports carry the header note "API list assembled without evidence — rebuild with api-from-docs".
When the docs truly cannot be read, keep the list knowingly —
`capability-list.mjs status --dir "<dir>" --keep-unverified "<why>"` — the reports still say it.

## 1.5b Read and map — by script

```bash
node "<skill>/scripts/capability-list.mjs" read --dir "<dir>" --spec "<dir>/<Connector>_api.yaml"
node "<skill>/scripts/capability-list.mjs" map  --dir "<dir>"
```

`read` turns every operation into a capability with a stable id (`CAP-<operationId>`), a kind
(`list` · `get` · `create` · `update` · `delete` · `action`) and the noun it acts on. `map` finds,
for each one, what the connector offers:

| Capability kind | Exposed when | Exposure |
|---|---|---|
| list, get | a table matches the noun | `Table · SELECT` |
| create, update, delete | the table matches **and** the connector advertises that write, or a procedure performs it | `Table · INSERT/UPDATE/DELETE`, or the procedure |
| action (`addFollowers`, `setParent`, …) | a procedure matches the action | the procedure |

Statuses: **exposed** · **partly** · **not_exposed** (in the API, not in the connector — a CData
gap) · **not_applicable** (sign-in, webhooks, batch envelopes — `config.capabilities`) ·
**product_only** (the product does it, its API does not — never a CData gap). Re-reading a newer
spec keeps every reviewed mapping.

## 1.5c Review and group — by model

`map` exits 3 until two things are done, because a capability list built on guesses would make every
later number wrong:

1. **Review every low-confidence mapping.** Name-matching cannot know, for example, that Asana's
   `getUserTaskListForUser` is the `UserTaskList` table, or that a flattened table like
   `ProjectFollowers` already answers `GET /projects/{gid}` followers. Look at the connector's
   tables, columns and procedures (from the knowledge file) and decide.
2. **Group capabilities into business areas and flows** as a person would describe the product:
   for example (Asana), Task management → *Plan my week*, *Hand work off*; Goals → *Report on goals*. Every applicable
   capability belongs to exactly one area. For each area, also name its **personas** (the Stage 2
   personas who work there) and the areas it is **related** to, where real work crosses between
   them. Research is scoped, batched and checked per area from these (3.1, `13-scope.md`), and a
   related pair gets a cross-area pass once both are frozen.

Also add what the product does that its API does not describe (forms with branching questions,
rule definitions) as `product_only` — so a reader sees them, and nobody charges them to CData.

Dispatch one `general-purpose` subagent with `model: config.models.research_business` and the
capability list, the knowledge file's object and procedure lists, and the vendor's product
documentation. It returns:

```json
{ "model": "opus",
  "mappings": [ { "id": "CAP-getuser_task_list", "status": "exposed",
                  "exposure": [{"kind": "table", "name": "UserTaskList", "op": "SELECT"}], "note": "…" } ],
  "product_only": [ { "label": "Read form questions and branching", "note": "Forms exist only in the web app", "source": "…" } ],
  "areas": [ { "id": "TM", "name": "Task management", "personas": ["Team Lead", "Individual Contributor"], "related": ["PP"],
               "flows": [ { "id": "TM1", "name": "Plan my week", "capability_ids": ["CAP-gettasks", "…"] } ] } ] }
```

**Write every `note` for the report reader**, who decides what to fix and has never seen the
script's first guess. Say what works through CData ConnectAI MCP and what does not, in that order,
naming the table or procedure: *"Offered only for tasks: UploadAttachment(TaskId, Name, Content)
uploads a file to a task. Attaching to projects or project briefs, or adding an external link, is not
supported."* Never narrate the review ("was wrongly not_exposed", "the name match was wrong"), and
never use status codes (`not_exposed`, `product_only`) — the report shows the status beside the
note. `apply` strips review history it recognises (`readerNote()` in `lib/capabilities.mjs`) and
keeps the original as `review_note`, but a note written for the reader needs no cleaning.

```bash
node "<skill>/scripts/capability-list.mjs" apply --dir "<dir>" --review "<dir>/_agent_out/stage1_5-review.json"
```

`status` passing (exit 0) is the gate into Stage 5.5. The capability list is per connector and is
re-read only when the vendor's API changes.

## 1.5d What the test account can show — before research (3.6)

Research is reusable, but a run on an account that lacks an area's features or data measures the
account, not the connector or the AI (Asana time tracking: ~300k tokens of research, then 36 of 43
use cases blocked). One read per table shows it first:

```bash
node "<skill>/scripts/account-probe.mjs" prep --dir "<dir>"
```

Run every listed `SELECT … LIMIT 1` through `queryData` (reads only), write
`{"probes":[{"table","rows","error"}]}`, then `account-probe.mjs merge --checks <file>`. Each table
becomes *data · empty · refused* (plan or rights) *· needs a filter · error*, in
`<Connector>_account.json`, and every area gets a line: tables holding data out of those it uses.
`scope.mjs status` repeats it beside the areas. **Show it to the user before they choose `--areas`.**
An area marked ⚠ can still be researched; say plainly that its run will mostly describe the account
until data is seeded or a better account is used. A write the plan refuses is not visible to a read;
it shows when test data is seeded.

## 1.5e The vendor's own MCP server — a three-way comparison (3.8, on by default)

Many sources now run an MCP server of their own. The capability list already says, per API
operation, whether CData ConnectAI MCP offers it; this stage says whether the vendor's server does,
so every capability report can show **both · only CData ConnectAI MCP · only the vendor MCP ·
neither · only in the source's app**. It reads tool descriptions; it runs nothing.

It runs by default, right after 1.5d (`13-scope.md` S1), unless `--no-compare-mcp` was given or
`config.capabilities.compare_vendor_mcp` is false. Skip it when `<C>_reference_mcp.json` already
exists and `reference-mcp.mjs status` neither says the list is older than
`config.capabilities.vendor_mcp_recheck_days` nor counts capabilities "not compared yet" for the
areas in scope — then only show its line. When the vendor has no MCP server (the research agent
finds none in its developer docs or MCP listings), record it once, with what was checked, and move on:

```bash
node "<skill>/scripts/reference-mcp.mjs" none --dir "<dir>" --note "<what was checked>" [--doc-url <page>]
```

1. **Get the tool list.** If the vendor's MCP server is connected in this session, list its tools
   (name, description, input schema — the server's own `tools/list`) and save them as JSON with
   `--source session`. Otherwise dispatch one `general-purpose` agent (`model: config.models.research`)
   to read the vendor's published tool reference and return
   `{"server":{"name","url","version"},"source":{"kind":"docs","url","title","read_at"},"tools":[{"name","description","access"}]}`
   — every tool, exact names, none invented — or `{"none": true, "checked": "<what>"}` when the vendor has
   no MCP server. Never sign in to the vendor's server for this.

   ```bash
   node "<skill>/scripts/reference-mcp.mjs" read --dir "<dir>" --tools "<dir>/_agent_out/reference-mcp-tools.json"
   node "<skill>/scripts/reference-mcp.mjs" prep --dir "<dir>"
   ```
2. **Map.** Compare the whole capability list once, not area by area: later batches reuse it.
   `prep` writes `_agent_out/reference-mcp-input.json`: the capabilities not yet compared,
   each with tools whose names suggest it (a hint only). Dispatch one `general-purpose` agent
   (`model: config.models.research`) with that file. It judges each capability from the tool names,
   descriptions and parameters only — covered · partly (with a note saying what is missing) ·
   not_covered — and lists under `extra` the vendor tools no API capability covers. Ignore the
   `cdata` field when judging: the two sides are decided independently.
3. **Store and show.**

   ```bash
   node "<skill>/scripts/reference-mcp.mjs" apply  --dir "<dir>" --mapping "<dir>/_agent_out/reference-mcp.json"
   node "<skill>/scripts/reference-mcp.mjs" status --dir "<dir>"
   ```

   `apply` refuses a tool that is not in the list, a status outside the three, and a covered or
   partly entry without its tools, and then stores nothing. Show the user the `status` lines.

It lives in `<Connector>_reference_mcp.json`, never in the capability list, so it changes no
fingerprint and no stored result. Every report built afterwards (`--analysis`, the combined
report, an eval's per-model reports) gains a **Vendor MCP** tab, a vendor column on the gaps
(filter: *the vendor MCP can do it*) and a line on the summary; a report without the file is
unchanged. A new tool list (`read` again) drops the mapping of tools that are gone; `prep` then
lists only what needs comparing again. Say plainly in the report hand-over that the vendor side is
read from tool descriptions, not measured.
