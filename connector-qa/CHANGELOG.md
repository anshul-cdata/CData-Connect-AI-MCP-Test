# Changelog

All notable changes to the connector-qa skill. Versions follow semver; `schema_version` on the
artifacts tracks the major version and a reader refuses a mismatched major.

## 3.9.3 — 2026-10-09

Page capture without a model in the loop. Reading a JavaScript-drawn API reference (QuickBooks Online: 74
pages, each about 12k tokens of text) meant a model driving a browser tool and carrying every page's text to
disk through its own context. That cost per-page tokens, risked a copy error on every page, and froze the
browser tab more than once under long scripts. The first attempt skipped it and kept only the operation headings and
endpoint lines of each page — an excerpt the evidence check could have accepted as if it were the page (it compares against whatever text
is saved, and `snap --text-file` applies only a 400-character bar to browser text; not run on those excerpts). The skill had no way to get rendered text onto disk
without a model, so each run improvised one.

- **`render` — `api-from-docs.mjs render --dir <d> (--pending | --url u1,u2) [--browser <exe>]`.** Starts the
  Chrome, Edge, Chromium or Brave already on the machine, headless, on a throwaway profile (no cookies, no
  sign-in); loads each page; waits until its text has stopped changing; and writes the text straight to the
  snapshot store as fetcher `headless`. Page text never enters a model's context, so the per-page token cost is
  zero and there is nothing to mistype. A page that never finishes drawing, or reads as a shell, is refused
  with the reason and left pending — never saved as if it were the page. No new dependency: it speaks the
  DevTools protocol over Node's built-in WebSocket, so it needs Node 22 or newer for this command only.
- **Polite by construction, unchanged.** One page at a time, `delay_ms` apart, public pages only, an honest
  user agent, and **`robots.txt` is read first: a page it disallows is excluded with that reason and never
  loaded** (`lib/page-reader.mjs` `robotsGate`, the same rules `politeGet` applies). `render` does not
  bypass anything the plain reader would not read.
- **`ingest` — for pages a person reads in their own browser.** `ingest --snippet` prints a console snippet
  that waits for the page to draw and downloads its text as `<prefix><last path segment>.txt`; `ingest --from
  <folder>` files the downloads. It matches each file to the inventory page whose last path segment equals its
  name, **refuses a name two pages share rather than guessing**, applies the strict whole-page length bar, and
  records the browser used. This is the path for pages `robots.txt` disallows and for machines without a
  browser or Node 22. It is what was done by hand for Intuit's reference, now reproducible.
- **Where it does and does not help.** Intuit's `robots.txt` disallows `developer.intuit.com`, so `render`
  refuses those pages by design; for them `ingest` (a person in their own browser, with their say-so) is the
  path. `render` is for the many vendor sites whose reference is JavaScript-drawn and open to readers.
- **Efficiency (estimates, not measurements across vendors).** Through a model: roughly 12k tokens a page to
  read and the same to write, about 1.5–2M tokens for 74 pages, plus a browser batch per ~12 pages. With
  `render`: no model tokens for page text; wall time is the 1 s polite delay plus the settle window, about
  3–6 s a page, so 74 pages take minutes, not a session. The saved text is the page as the browser drew it, so
  the evidence check (`merge`) compares against the whole page, not an excerpt.
- **Wiring.** `headless` joins `FETCHERS` and `RENDERED` (`lib/page-reader.mjs`), so snapshots, `prep` and
  `merge` accept it unchanged. New defaults `capabilities.api_docs.render_settle_ms` (1500) and
  `render_timeout_ms` (45000). `RENDER_HELP`, `references/10a-page-reader.md` §2–3, `10-capabilities.md` §1.5a
  and `15-scripts.md` say `render` first, then the session's browser tools, then `ingest`.
- **Tests — `tests/headless-capture-393.test.mjs` (new, 10).** Against a local site: a page drawn by script
  after load is saved whole, to its last line, as `headless` (while a plain `snap` of the same page is refused as
  a shell); a `robots.txt`-disallowed page is excluded and nothing of it is stored; a page stuck on "Loading…"
  is refused and left pending; `ingest` files one download and refuses a thin file, an ambiguous name, an unknown
  name and a file without the prefix; the settle rule and browser lookup are unit-tested. The browser-driven
  tests skip where no browser or Node 22 is present.
- **Not changed, and noted.** `snap --text-file` still applies a lenient 400-character bar to browser text
  while plain HTTP applies 1,500; `render` and `ingest` use the strict bar because they save whole pages.
  Aligning `snap` and recording how each page was captured in the report is left for a later release.

## 3.9.2 — 2026-10-09

An API list assembled without evidence is found, rebuilt and said. QuickBooks Online ran on 3.9.0/3.9.1
with the hand-built `<C>_api.json` from before 3.9 (title "(assembled from reference docs)", no
`info.x-assembled`, no page or quoted line per operation). A capability list already existed, so the
router moved on, `orchestrator-advice.mjs` classified it as "spec", and the analysis report (134 use
cases, three areas frozen) rested on an unchecked list.

- **Detection — `scripts/lib/api-provenance.mjs` (new).** `apiProvenance` sorts a description into
  published · assembled · unverified · none. Unverified only on a positive sign: `run_meta.capability_spec.source`
  is `reference_docs` without `x-assembled`; the capability list's `source.kind` says assembled with no
  assembly recorded; the file's own title or description says it was assembled or that no OpenAPI is
  published; or a page/SDK assembly has operations without `x-doc-url` / `x-evidence`. Shape alone never
  decides (MailChimp's combined spec has its responses dropped and stays published); with a sign, "no
  responses, no schemas" is named beside it. Dry run: QuickBooks Online unverified (three reasons);
  Asana and MailChimp published.
- **Routing — `detect-stage.mjs`.** In capability mode an unverified list routes to **1.5a** before
  research continues, with a one-line reason, `frozen_areas` (kept frozen) and the next step. With a plan
  already built it is a warning. Asana, MailChimp and NetSuite route exactly as before (checked
  plain and with `--areas`).
- **Rebuild — `capability-list.mjs read`.** A re-read records `rebuild {added, removed, moved,
  kept_reviewed}`: reviewed mappings and area grouping are kept for ids that still match, removed ids
  leave their areas, and `read`, `status` and the router name the frozen catalog areas whose use cases
  need a removed or moved capability — flagged, never unfrozen. 1.5 tells the reviewer to review only
  the added and moved ones.
- **`capability-list.mjs status`** blocks (exit 3) on an unverified list; `--keep-unverified "<why>"`
  keeps it knowingly (recorded in `source.unverified_kept`; the reports still say it).
- **`orchestrator-advice.mjs`** — new type `assembled_unverified`, printed as "assembled (unverified)";
  suggested sonnet like any assembled list (the rebuild is scripted), opus rules unchanged.
- **Reports.** The capability and analysis reports built on an unverified list carry a header chip
  "API list unverified", a summary note "API list assembled without evidence — rebuild with
  api-from-docs" with the reasons, and the same line in the run details. Added to the report data only
  when unverified, so every other report is unchanged.
- Docs: `10-capabilities.md` §1.5a (new subsection), `14-routing.md` (two rows), `15-scripts.md`, one
  SKILL.md table row (line count unchanged).
- Tests: `tests/api-provenance-392.test.mjs` (8: detection incl. published JSON/YAML/slimmed specs,
  routing, rebuild diff and frozen-area flag with the catalog untouched, keep-unverified, advice type,
  report note). 332 pass.
- Regression: Asana asn-eval2 — the 6 reports rebuilt with the installed 3.9.1 and with 3.9.2: embedded
  DATA identical (apart from the version string) and every tab renders the same text.

## 3.9.1 — 2026-10-08

Making the analysis report legible. Everything below was already researched and already in the
dataset; none of it was reachable in the report built before a run, so the `--report` run answered
"how many capabilities" without ever showing what a capability *is*, and showed no personas at all.

- **A Capabilities tab (`capsTab`).** Every capability in one browsable place, not just the gaps.
  Per row: the label, the source's own API method and path, **what it becomes through ConnectAI MCP**
  (`Accounts · SELECT`, `SendInvoice · procedure`, `— not exposed`), the CData verdict, the vendor
  MCP verdict with its tool names when a comparison exists, and the number of researched use cases
  that need it — so a gap with a high count is visibly the one to fix first. Filter by verdict and
  business area, and search across label, path and exposure. A worked example at the top reads one
  real row end to end, because the count alone never said what a capability was. The summary panel's
  big number now carries the same one-line definition and links straight to the tab.
  Previously the 157 supported capabilities could only be seen by opening each business area in turn.

- **A Personas tab for the analysis report (`aPersonas`, `analysisView.personas`).** The results
  report builds `D.personas` from execution records, so with nothing run it was empty and the tab was
  absent from the analysis tab list entirely — the persona dimension was researched (every use case
  names one, Stage 2 describes each role) and invisible. It is now built from the catalog: use cases
  per persona and their share, the business areas each spans, the difficulty mix, how many change
  data, the average realism score, plus each role's archetype, description and jobs-to-be-done from
  the Stage 2 research. `personas_without_use_case` names any role the research found that no use
  case serves — a research gap, stated rather than silently dropped.

- **Persona filter on the Use cases tab**, in both the analysis and results reports, beside the
  existing area filter.

- **Full provenance on each analysis use case card (`aCard`).** The card showed the request, chips
  and the capability table; it now opens the same two-panel layout the results report uses — Who,
  When, Goal, How often, Source with its URL, Evidence strength, Difficulty with the skills the
  request tests, the realism score, and the variant count — beside what it needs and what a good
  answer does. `analysisView` now carries `moment`, `frequency`, `tests`, `realism` and `human`,
  which it had been dropping, so four of those rows would have rendered as "—" even if the panel
  had been reached.

### Known issue, pre-existing

`validate-report.mjs` fails on the capability and analysis reports (`showTab: NOT DEFINED`,
`regroup: NOT DEFINED` and five more). It exercises handler names belonging to
`report-template.html`, so these two report types can never pass it and currently have no working
end-to-end render check. Confirmed identical before and after these changes.

## 3.9.0 — 2026-10-08

A capability list from any API documentation site, use case evidence from the vendor's own pages, and
evidence ranking in every report. QuickBooks Online prompted it: Intuit publishes no OpenAPI, its
reference is a JavaScript application (a plain fetch returns an empty shell), and the list had been
hand-written with Intuit's real methods normalised away and no evidence.

- **Capability report wording and order.** The Gaps tab is now **Gaps vs API** (heading: "Gaps vs <Source>'s API: what
  the API can do that CData ConnectAI MCP can't"; summary panel "Biggest gaps vs the API"), and the vendor MCP
  comparison panel sits right under the two headline panels on the summary instead of at the bottom.

- **The Stage 1.5a ladder (`api-from-docs.mjs`, `lib/api-docs.mjs`).** First hit wins, the rung is
  recorded: a machine-readable description — OpenAPI/Swagger (also found behind ReadMe, Redoc, Stoplight
  and Swagger UI portals, at the common paths and in the vendor's GitHub), OData `$metadata`, WSDL, RAML,
  GraphQL (`ladder`, `convert`) → a Postman collection v2.1 or an official SDK → the reference pages.
  A vendor OpenAPI is used exactly as published; the other forms are converted to the same OpenAPI shape.
- **From reference pages, checked word for word.** `inventory` lists every page (sitemap, navigation,
  index); `snap` saves each page's own text (`_agent_out/api-docs/<hash>.txt`, long pages in parts); a
  model extracts `{entity, operation, method, path, summary, doc_url, evidence}` from the saved text
  (`prep` writes its brief); `merge` rejects an operation whose page is not in the inventory or whose
  evidence is not on that page, merges duplicates, and writes `<Connector>_api.json` with the
  **documented** method and path kept (`x-path` — a POST update stays a POST), `x-doc-url`, `x-evidence`
  and `info.x-assembled {rung, fetcher, pages, excluded, at}`. Connector tables and SDK entities no
  operation acts on are listed for review, never added. `status` exits 3 until every page is extracted
  or excluded with a reason. Operation ids are `<verb><Entity>`, so a re-read keeps reviewed mappings.
- **One page reader for every stage (`lib/page-reader.mjs`, `references/10a-page-reader.md`).** Probe
  one or two pages; a JavaScript shell (very short text, or no endpoint-like line and the signs of a
  client-side app) is read with whichever rendered browser the session has — the Claude desktop browser
  pane, Playwright MCP or Claude in Chrome — and with none the user is asked to enable Playwright MCP.
  The reader is recorded. Sequential, `delay_ms` apart, public pages, robots.txt respected; no paid
  crawler. `config.capabilities.api_docs`. New run flag `--api-docs <url>` names the docs page.
- **Use case research starts on the vendor's own site.** The researcher looks first at the vendor's use
  case, workflow, tutorial and "how to" pages (new source kind `vendor_use_case`, evidence level *vendor
  guidance*), then the help centre, templates, standard reports and the community, and reads JavaScript
  pages with the shared reader; the source checker re-reads a shell in a browser before calling a page
  missing. `validateCatalog` and `sources-prep`/`-merge` accept the new kind.
- **Of two near-duplicates, the better-evidenced one is kept** (`manage-catalog.mjs add`,
  `nearDuplicateChoice`). A draft gives way to a newcomer with strictly stronger evidence (retired with the
  reason and `replaced_by`); an approved or frozen use case never does — the stronger page is noted beside
  it (`stronger_evidence`). `validate` says which of two near-duplicates to keep.
- **Evidence in every use case list.** Capability report, analysis report and the eval's grid: an
  evidence pill and the cited page's link on every use case, a **Sort** control (*As listed* — the
  default, so existing reports read as before — *Evidence, strongest first*, *Business area*, *ID*), an
  evidence filter, and counts per evidence level on the summary.
- **Provenance in the reports.** `capabilities.json` records `source.kind` (`spec` · `postman` · `sdk` ·
  `reference_docs`) and `source.pages`; a list not read from a spec is labelled "API list assembled from N
  reference pages" on the summary and Run details, and each capability links its page. Spec-sourced
  reports are unchanged.
- **Orchestrator advice at the start of a run (`orchestrator-advice.mjs`, `lib/orchestrator.mjs`).** Step 0
  reads the session's model (get_session) and compares it with a suggestion read from what is on disk:
  sonnet for a machine-readable API description, an API list assembled from web docs, or no vendor
  business API (database, files, generic interface); opus for a large platform (more than 400 tables, 500
  capabilities or 12 business areas), for more than 4 areas in one session, or for an assembled list that
  leaves many connector tables without a documented operation to sort out. Haiku is never suggested.
  Below the suggestion, the user is asked once to continue or switch; it never blocks
  (`required_orchestrator` stays the gate). Recorded in `run_meta.orchestrator`, carried into stored runs,
  and shown in the run details as "Orchestrator: <actual> (suggested <x>, reason)"; a report without it is
  unchanged. Thresholds and `enabled`: `config.models.orchestrator_advice`.
- **The human rating sample is now off by default (`config.catalog.human_review: false`).** An area is
  frozen without the rating sheet and the run never pauses for it; each freeze is recorded as
  `human_skipped` with `human_skipped_by: config`, and `run_meta.human_review = "skipped (config)"`. The
  capability and analysis reports say "Not reviewed — human review is off (config.catalog.human_review)"
  where the human-agreement figure would be (a catalog frozen earlier with `--skip-human` reads "…was
  skipped when the catalog was frozen"). Set it to `true` for the previous behaviour: freeze blocks until
  `human_min_per_area` ratings exist. `freeze --skip-human` still skips it for one freeze. A catalog a
  person reviewed keeps its figure.
- **SKILL.md trimmed from 500 to 324 lines; stage detail moved to references, nothing removed.** SKILL.md
  keeps what every run needs (the contract, Step 0, flags, orchestrator advice, artifacts, the router
  command and its two action rows, the stage map, delegation principles, a Stage 9 isolation summary,
  main-thread-only stages, the Stage 12 commands, output discipline) and points to the rest: the full
  routing table and compaction markers → new `references/14-routing.md`; the scripts-by-stage table → new
  `references/15-scripts.md`; driver-source use → `00a-driver-source.md`; Stage 2 research agents →
  `01-discovery.md`; Stage 3 sharding → `02-semantic-schema.md`; review agents and the realism judge →
  `07a-tc-review.md` (and `08-reconcile.md` §10.5); capability-mode agents → `11-catalog.md`; Stage 9
  isolation → `07-execution.md`; the Stage 12 explanations → `09-reporting.md`. Every one of the 175 lines
  removed exists verbatim in a reference. Every reference over 100 lines opens with a contents list.
- **Regression:** the Asana asn-eval2 reports rebuilt with 3.9.0 carry the same data as 3.8.1 (the eval
  adds each use case's evidence and source, and every report a `quality.human_skipped` marker) and render
  the same text, figures and use case order in every tab, the 3.9 additions aside — Asana was frozen with
  `--skip-human`, so its "Not reviewed" now says the review was skipped.

## 3.8.1 — 2026-10-08

- **The vendor MCP comparison runs by default.** Stage 1.5e now follows the account probe in every
  capability-mode run, so every capability report shows what both MCP servers can do, what only CData
  ConnectAI MCP can do, what only the vendor's server can do, and what neither can. `--compare-mcp` is
  replaced by `--no-compare-mcp` (skip it for one run); `config.capabilities.compare_vendor_mcp: false`
  turns it off for good. It is skipped when the comparison is already current.
- **A vendor without an MCP server is recorded once** (`reference-mcp.mjs none --note …`), so the stage
  is not repeated on every run, and reports say there is nothing to compare with. A server found later
  replaces the record; a compared server is never replaced by it.
- **Re-read after `config.capabilities.vendor_mcp_recheck_days` (90).** `reference-mcp.mjs status` says
  when the tool list or the "none" record is older.
- **`scope.mjs status` shows where the comparison stands**, beside the areas and the account probe.
- **The analysis report adds up across batches.** `--report` builds it without `--areas`, so it covers every
  area researched so far; researching areas in several batches extends the same report instead of
  replacing it. The vendor MCP comparison is made once for the whole capability list and reused.
- **Vendor MCP tab: one row per area that reads at a glance** — API capabilities, how many CData
  ConnectAI MCP can do, how many the vendor MCP can do (with bars), the difference, and what neither can;
  zeros shown, a total row.

## 3.8.0 — 2026-10-08

Two reports for questions the skill could not answer before: what research found when nothing has
been run yet, and how CData ConnectAI MCP compares with the source vendor's own MCP server.

- **Analysis report on request (`--report`, `build-capability-report.mjs --analysis`).** Research
  alone used to end without a report: the capability report refused without stored results. With
  `--report`, research that stops before execution builds `<Connector>_analysis_report.html` from
  the capability list, the catalog and the account probe. It shows the capability coverage and gaps
  (weighed by how many researched use cases need each one), the test account's readiness per area,
  and an outlook for every use case: ready to test · needs a partly supported capability · not
  supported by CData ConnectAI MCP · only in the source's own app · the test account refuses it or has
  no data for it. An outlook is a forecast and is labelled "Not run yet"; it is never counted as a
  result, and the analysis never writes the capability report or touches the results store.
- **Vendor MCP comparison (`--compare-mcp`, Stage 1.5e, `reference-mcp.mjs`).** When the source
  vendor runs its own MCP server, its tool list (from the server connected in the session, or its
  published tool reference) is mapped onto the same capability list: covered · partly · not covered.
  Every capability report then shows a three-way comparison: both · only CData ConnectAI MCP · only
  the vendor MCP · neither · only in the source's app, per capability, per area and per use case. The
  gaps tab gets a vendor column and a filter for the gaps the vendor's server already closes, and the
  tab lists vendor tools outside the API. Stored in `<Connector>_reference_mcp.json`, never in the
  capability list, so no fingerprint, stored result or existing report figure changes; a report
  without the file is unchanged. The vendor side is read from tool descriptions, not measured.
- **Use case cards no longer scroll the page sideways on a phone** (a long word in a request, or a long
  source title, pushed the card wider than the screen).

## 3.7.6 — 2026-10-07

- **Every business test names the user's workspace when the connection reaches several.** The checks
  are scoped to the run's workspace (`run_meta.workspace`), but only write tests were told which one;
  a read then answered from another workspace's records and was graded on the guess. When
  `run_meta.workspace_catalog` holds more than one workspace, every runnable business test's operating
  note now says "The user works in the "<name>" workspace (id …)". A real assistant is set up for its
  user's workspace, so this measures the task, not the guess.

## 3.7.5 — 2026-10-07

- **Cleanup procedures take fixtures.** A `cleanup_procedure`'s parameters may name records as
  `{{fixture:<id>.<Field>}}`, filled when the plan is generated, like the check SQL. Moving a task
  between sections, adding a tag or a project can now be undone after each attempt, so the next attempt
  and the next model start from the same records. An unbound fixture there holds the use case as no test data.

## 3.7.4 — 2026-10-07

The eval report is shorter and plainer, and every report uses the same result names.

- **Eval report:** 7 tabs instead of 12 (Overview · Models side by side · Strengths by kind of work · Use
  cases · Where models differ · Where it goes wrong · How this was measured), about half the words, plain
  language, the status colours of 3.7.3, long lists start at 15.
- **One vocabulary in every report:** Correct, Partly correct, Incorrect, Correct first time, Not supported,
  Refused by the connector, Blocked by the account, Blocked by test data, Not applicable, Not measured. No
  more "right", "wrong" or "first-try success" for a result; API coverage says "Partly supported", so it
  is not confused with "Partly correct".
- **The eval and the model reports agree:** "Models side by side" lists what was not counted for each model
  under the same names and numbers as that model's report, instead of one "Not measured" figure.
- **Not applicable is not a connector gap:** a use case that exists only in the source's own app is
  counted as not applicable in the eval (its own filter and note), not under "the connector does not offer".
- Owners are written the same way in both owner lists; counts read "1 use case" / "2 use cases"; the gaps
  card names one suggested fix; the journey no longer tags a call "re-run by us".

## 3.7.3 — 2026-10-07

- **Status colours by who the result is about.** The AI: green, amber, red (correct, partly, incorrect).
  The CData connector: purple (not supported), pink (refused by the connector). The test account: blue
  (blocked by the account), teal (blocked by test data). Nobody: grey (not applicable), a dashed
  outline (not measured). No more striped patterns; every colour has a matching dark-mode shade, and
  the summary legend is grouped under these four headings.

## 3.7.2 — 2026-10-07

The use case page explains itself, in the order a reader asks.

- **Order:** what a good answer does · what the AI told the user · why this use case exists · what it
  needs from the source · every call the AI made (folded) · how do we know the answer is right? · how
  many times did we ask? · why is the score what it is? · what would make this smoother · earlier runs
  (only when there are any).
- **How do we know the answer is right?** In plain words for each kind of result: our own check (run
  after the AI, never seen by it), the records it found by name, the rule in words, the AI's query we
  re-ran; a judged answer with the judge's reason and whether the second judge agreed; a write read
  before and after; blocked or not-supported results saying who should act. Queries and raw errors
  are one click away.
- **How many times did we ask?** One sentence for a single run; for several runs a headline ("Correct
  all 3 times", or how the runs differed) and a table with the wording, plain results, data requests,
  and which requests failed and whether the AI fixed them. Not-supported use cases say they were not asked.
- **Why is the score what it is?** Each part of the score in words.
- The journey says every call was the AI's, and tags the call our check re-ran.
- Ingest keeps what the page needs from the check files: our check's records (up to 20) and count, the
  AI's query we re-ran and its row count, the reads before a change; each run keeps its wording and
  failed calls. Existing runs get it by re-ingesting; nothing is run again.

## 3.7.1 — 2026-10-07

Fixes from an independent review of the whole project — four read-only reviewers (Fable 5.1) on the
instructions, research-to-tests code, checking and scoring, and reports and packaging. Each confirmed
defect was checked against the code and has a test (`tests/review-371.test.mjs`, updated 3.7 tests).

- **Writes.** "Read only" at the start now means nothing that changes data runs (it held only
  irreversible writes); the question is asked again at every run start. The strict gate reads the
  run's own workspace pin (it read `{id,name}` as "[object Object]" and refused every safe-mode run)
  and accepts any id shape, not only digits. Catalog write tests no longer tell the agent to put the
  record back — the check runs after the agent and the harness restores it, so obeying the old note
  was marked wrong.
- **Verdicts and owners.** "Refused by the connector" is a finished result (it was treated as
  unfinished: dropped from combined reports, eval "run needed"). An answer's owner comes from failures
  the agent did not get past on calls that act — one recovered permission error during table lookup
  no longer turns a judged wrong answer into "blocked by the account"; only a reviewer can re-charge
  it. A connector that never answered any query is "refused/unreachable through the connector", not
  "no test data" (asn-tr1: 14 attempts). Records of the asked kind reported over an empty account are
  wrong (invented); rows read on the way are not. A value comparison where no record lines up goes
  to the judge; a capped sample with no stated total is not counted.
- **Wording rules.** "I can't…", "isn't possible", "not able to", "does not have permission" are
  recognised as telling the user; "Can you list…?" is a request, not a yes/no question; "Tell me which
  task…" is a clarifying question.
- **Eval and report numbers.** "Fail on every model" counts only use cases every model was asked (it
  counted 39 never-run "not possible" ones: 46 → 6). A gap "blocks" a use case only when the use case's
  verdict is the gap's — AI mistakes no longer appear as CData gaps or in the fix list. Personas show
  their verdicts. The representative attempt is the majority outcome; wording agreement ignores
  attempt noise; an ask-only attempt no longer sets the shortest path.
- **Test data.** Results are compared on the records each use case used, not one global hash, so
  binding one area's fixtures no longer invalidates every other area. Fixture ids may be named Id, ID,
  gid, sys_id…; `expect` values are scanned and rendered (follow-ups too); a test held for an unbound
  fixture is never released with `{{fixture:…}}` in it; `{{workspace}}` is filled in the data check
  and refused in seeds when unknown; broken fixture definitions block their area's freeze; fixture
  bookkeeping fields no longer change the area hash. The router sends a scoped run to test data (8.0)
  before planning.
- **Capabilities.** A POST that acts on an existing record (add followers, set parent) changes it,
  so its record must exist first; a delete reachable by procedure maps to the procedure; an
  exposure without an operation takes it from the method.
- **Errors.** "cannot obtain connection", "resource … not found", "expects one of", "not a valid
  regular workspace" are classified; a metadata attribution survives trimmed stored results.
- **Packaging.** The version check compares file content, so an edited source with the same version
  is caught; the installers check all three report templates; `sync-skill` no longer copies
  `dist`/`tools`; empty stray files are not packaged; saving retries when Windows briefly locks a file.
- **Reports.** Persona cards, "most use cases could not test the AI" wording, eval correct-rate
  tooltip and base, phone-width panels, escaped values, tab ARIA, distinct "not measured" and "blocked
  by test data" colours, stable "+N more" toggles.
- **Instructions.** Stage 1 records catalog, schema, me, workspace and workspace_catalog; 1.5d and
  8.0 are in the stage map; capability mode skips 8.5; the Stage 9 brief lists every MCP tool; stale
  text from older versions removed (see references).

## 3.7.0 — 2026-10-06

The rest of the use-case review, built to be tested against the old runs. All of it is generic.

- **Test data: what the account has first, created only when missing.** A catalog names the records
  its use cases need as fixtures (`lib/fixtures.mjs`: describe, find_sql, example, seed, depends_on)
  and refers to them as `{{fixture:<name>.<Field>}}` in requests and checks — never by an account's
  ids (a problem on new drafts). `test-data.mjs`: `survey` samples real rows for the writer before
  use cases are written; `find` binds each fixture to a real record; `seed` lists INSERTs for what
  is missing, for the user's approval; `status`. Tests are written with the real names; a missing
  fixture holds its use cases as no test data, a refused one as blocked by the account. The records
  bound are part of the run's environment, and the report shows each test's data source and every
  record a run left in the account.
- **Write safety off by default on test accounts.** `write_policy.safe_mode: false`: writes run,
  including creates the connector cannot delete. Every run starts with one question —
  "writes go to <workspace>; is this a test account?" (`write-policy.mjs`); "read only" or
  `safe_mode: true` restores the strict rules. The package refuses to ship without the question.
- **What ConnectAI MCP can actually run.** Its tools take SELECT, INSERT, UPDATE and procedures, never
  DELETE. A capability supported only by a driver DELETE is now *not supported through ConnectAI MCP*
  (Asana: 15 delete and remove capabilities had been counted as supported); `capability-list.mjs
  status` corrects an existing list once. Cleanup must be an UPDATE or a delete procedure
  (`check.cleanup_procedure`); a DELETE cleanup is flagged and no longer makes a write reversible;
  a writing job should give `scope_sql`.
- **A scripted second turn.** `follow_up: {reply, check}`: if the agent asks a clarifying question, a
  fresh agent gets the conversation and the fixed reply; turn 1 is kept as "asked the right thing",
  turn 2 decides. Reports show both turns; the eval shows "asked when unclear, then finished the job".
- **A second judge.** `config.models.second_judge` (Sonnet) re-judges answers (`answer-judge.mjs
  --second`) and realism (`judge-prep/-merge --second`) independently. The first still decides;
  reports show agreement and mark disagreements, which the human sample takes first.
- **Close calls.** `execution.attempts_complex` (off) gives complex use cases more attempts; the eval
  lists use cases where models disagreed, and `scope.mjs prepare-run --redo-uc-file … --attempts N`
  re-measures only those.
- **Bulk exports** are a pattern of their own; a complex or ambiguous request with one wording is a
  warning.
- Held tests read as what they are: "no test data" or "blocked by the account", not "not run"; a test
  held for data runs once the data exists.

## 3.6.0 — 2026-10-06

From a read-only review of how use cases are made (Fable 5.1, on the Asana time-tracking run and the
archived three-model eval): the pipeline designed the right agentic skills but did not measure most
of them, and some "failures" were the checks'. All changes are generic.

- **Checks that can decide the request.** A yes/no question checked by record ids, and a reference
  query narrower than the request ("our projects" checked against three named ones), are flagged by
  validation — a problem on a new draft, a warning on an approved use case. At ingest a yes/no
  question the ids did not confirm goes to the answer judge with the reference rows. (asn-eval1: 11
  use cases every model "failed"; at least 3 were check defects.)
- **Check these before blaming the models.** The eval lists every use case all models got wrong, with
  each model's check detail, on the Differences tab.
- **Refused by the connector.** An operation the connector refused (read-only, not supported), reported
  honestly, is `blocked_connector` — a connector finding, out of the AI score; the capability report
  lists it as "supported on paper, refused at run time". Claiming success anyway stays wrong.
- **Limitation probes.** A use case ConnectAI MCP cannot do is put to the agent once (`probe:
  "limitation"`, judged): did it say so plainly, or invent an answer? The use case stays Not
  supported; the capability report and the eval show the honesty rate. Probes that would write run
  only where irreversible writes are allowed; `execution.probe_limitations: false` turns them off.
- **One answer-judge step.** `answer-judge.mjs prep/merge` prepares every attempt the rows cannot
  decide (judge rules, yes/no, probes) with reference and data rows and optional account facts.
- **Know the account before research.** `account-probe.mjs` reads each table once (reads only) and
  shows per area how many tables hold data, are empty or are refused; `scope.mjs status` repeats it.
- **Evidence strength.** The source checker also grades `support` (strong/weak) and `page_kind` (user
  post, vendor page, third-party site, API docs); weak support, and a daily use case on weak, inferred
  or non-user evidence, are warnings.
- **Wording advice.** Warnings for requests bundling three or more changes, or reading like a
  scheduled export.
- The capability report says "not yet validated by a person" when the human sample was skipped.

## 3.5.0 — 2026-10-06

What a result means — from a review of the Asana time-tracking run (asn-tr1), where 23 of 47 rows
read "failed" and none was an AI mistake.

- **One verdict per use case.** Correct · Partly correct · Incorrect · Not supported · Not applicable ·
  Blocked by the account · Blocked by test data · Not measured (`verdictOf`, `lib/report-data.mjs`). The
  capability report leads with this breakdown instead of smooth / friction / failed; filters, the area
  table and every use case show it. The AI's correct rate and score count only the first three.
- **Honest refusals are not wrong answers.** A call the source refused for the account's plan or rights,
  reported honestly, is `blocked_account` (`refineOutcome`, `lib/checks.mjs`); claiming success anyway
  stays wrong. The plan-refusal pattern is shared (`PLAN_LIMIT`, `lib/journey.mjs`) — Asana's "not
  available on your current plan or add-ons" was recognised by coverage crediting but not by the report.
- **No data is not a pass.** An update or delete whose record did not exist before the run, and a judged
  answer over empty `data_rows`, are `no_test_data`. New catalog field `check.data_sql` (the records a use
  case is about): checked before the run, given to the answer judge, which may now return `no_test_data`.
- **Action and answer both checked.** A correct change the agent reported as a failure is partial; the
  write check also compares the before/after snapshots (and optional `check.scope_sql`) and marks any other
  record that changed or vanished as a side effect.
- **Variants are wordings, not use cases.** `#v1` rows fold into their use case; "same outcome in every
  wording" is shown as a robustness signal.
- **Readiness before spending.** `preflight-data.mjs` also checks judged questions (`data_sql`) and
  updates of existing records, and prints each area's readiness; `AREA NOT READY` (below
  `execution.area_ready_min`, 0.5) stops for the user's decision. A warning, never a cap.
- **Review corrections reach the report.** Stage 10.5's owner corrections are applied at ingest.
- Research guidance: cover cross-object, aggregation, clarification and read → decide → act workflows
  alongside limitations; nothing is capped.

## 3.4.3 — 2026-10-05

- **Version check at Step 0.** Claude Code runs the installed copy, which is refreshed only by re-running the
  installer; a NetSuite run used an installed 2.1.0 while the source was at 3.4.2. `install.ps1` / `install.sh`
  now record the source folder and version in `install-info.json` beside the installed skill, and
  `scripts/check-version.mjs` (Step 0.0) stops the run with the command to re-install when they differ.

## 3.4.2 — 2026-10-05

Fixes from the Asana Time tracking & resourcing run (asn-tr1), and a getting-started guide.

- **Router:** a run scoped to business areas now goes through Stages 5–7 (coverage model, gaps,
  priorities) once its areas are frozen, instead of jumping to Stage 8 and failing with "missing
  <Source>_coverage.json". Test: `tests/router-scope.test.mjs`.
- **generate-tests.mjs** reads `run_meta.workspace` when it is an object (it was printed as "[object Object]"),
  and its usage text lists `--areas` / `--all` / `--with-conformance`.
- **credit-coverage.mjs** recognises plan and edition refusals ("not available on your current plan",
  "requires … an enterprise organization") as refusals.
- **GETTING-STARTED.md:** prerequisites, install, and how to run one business area, with a prompt template.

## 3.4.1 — 2026-10-05

- **Inferred use cases must come from real use.** Only the wording may be inferred, never the work: an inferred
  use case cites a source URL showing that people really do the workflow, and that page is opened and checked
  like any other source. A workflow with no evidence of real use gets no use case.

## 3.4.0 — 2026-10-04

Reports a reader can act on in a few minutes.

### Eval report
- **Overview first screen:** the verdict; one comparison table with task success, complex-task success,
  first-try success, MCP calls, recovery, time, tokens and the overall score (last, muted); the number
  of comparable use cases; and what the benchmark contains (simple / medium / complex, read / change
  data, ambiguous / missing detail, not possible, high-discrimination, not supported).
- **Every rate with its count:** "82% (18/22)", in every matrix, the leaderboard and the takeaways.
- **New tabs:** Capability × model (every skill, plus recovery from failed calls) and Difficulty ×
  model, each with a "What this means" line. A row where any model was asked fewer than five use
  cases is faded and names no winner.
- **Use cases × model** filters by model and outcome (right first time, right after recovering,
  partly, wrong, not possible), difficulty, area, persona and skill; "recovered" is marked in cells.
- **Differences** ranks the use cases that tell models apart (different outcomes before different
  effort, harder before easier) with best and worst model and why, and holds unique wins and failures.
- Navigation: Overview · Model comparison · Capability · Difficulty · Use cases · Differences ·
  Failures by owner · Model profiles · Breakdowns · Friction · vs baseline · Methodology.
- Journeys side by side lead with what each model told the user and why; the calls are folded.
- Ties are called ties: two models recovering from the same share are named together.

### Capability report
- A use case opens with the business result: request, expected outcome, actual outcome and why, the
  owner of any problem, and what would make it smoother. The AI journey and the technical details (the
  check, every attempt, earlier runs) follow, folded.

## 3.3.3 — 2026-10-04

- **Report text is written for readers.** Capability notes say what works through CData ConnectAI MCP and
  what does not, never how the mapping was reached: `readerNote()` (`lib/capabilities.mjs`) strips review
  history ("Was wrongly not_exposed: …", "the name match was wrong") and status codes when a review is
  applied and again when a report is built; the reviewer's own wording is kept as `review_note`. The
  capability reviewer and the answer judge are told to write for the reader, and `readable()` turns field
  names that leak into judge and checker explanations (`expected_behavior`, `reference_sql`) into words.
- Script-written notes say "table description" and "ConnectAI MCP" instead of the connector's internal
  "remarks".

## 3.3.2 — 2026-10-04

- **Usage instructions are their own owner.** A failed call the instructions should have prevented —
  catalog or schema not named, a filter the source requires not stated, an SQL function that does not
  work — is charged to **usage instructions**, not metadata.
- **Metadata means the schema contradicts itself.** A table or column the connector listed earlier in the
  same journey (getTables, or getColumns of that table) and then rejected is charged to metadata. A name
  it never listed stays the agent's guess. `attributeCauses()` re-derives every stored step, so existing
  results take the new attribution without a re-run.
- **Usage instructions panel** in the capability report: whether agents read them first, whether they
  are generic or specific to the source, discovery calls before the first query, and what the
  instructions should say — by topic (names, required filters, SQL functions, business words to
  tables, dialect, what can be changed, large results, finding a record) with a suggested line, the
  owner charged today, and the failed calls and use cases each topic cost. The eval report's
  connector-vs-model view gains a usage-instructions bucket.

## 3.3.1 — 2026-10-04

- **Capability status split.** "Not possible" becomes **Not supported** (the source's API offers it,
  CData ConnectAI MCP does not: a CData gap) and **Not applicable** (it exists only in the source's own
  app, not in its API: no connector could offer it, not a CData gap). Both reports and the fix list use it.
- **Wording.** The reports say what is tested: "CData ConnectAI MCP" — the CData connector underneath,
  reached through Connect AI's MCP server. The capability report asks "Can you do through CData
  ConnectAI MCP what <source> can do?".
- **Inferred use cases for any request.** Not every real request is written down publicly. When research
  finds a real workflow without a written example, the writer may infer the use case: marked inferred,
  naming its workflow, with a reason; sampled first for the human review; at most
  `catalog.max_inferred_share` (30%) of an area. The researcher lists `workflows_without_examples`.

## 3.3.0 — 2026-10-04

A comparison you can trust. The Asana eval exposed four ways the old report misled: a wrong answer
still earned up to half the score (wrong answers averaged 32–34); "first attempt" counted clean
journeys that ended wrong (haiku: 80% with 5 of 104 right); 53 use cases "failing on every model"
were all called connector gaps, though 39 had never been run and 12 were the models' own mistakes;
and a one-use-case margin was presented as a winner. `references/12-eval.md`.

### Validity (P0)
- **Score gated by the answer.** Efficiency, robustness and speed are earned in proportion to the
  answer: wrong scores 0, partial at most 50. Grades follow the outcome (red only when wrong).
- **First-try success** = right and no failed call, in both reports.
- **Correct rate over the use cases a model was asked.** Use cases ruled out before any run (a
  capability not exposed) leave the comparison and appear as connector limitations.
- **Causes by evidence.** "Not possible" is the connector's, the test account's (plan or rights) or
  the source system's (its own API does not offer it). An all-model failure is a connector or
  metadata gap only when every model's failure traces there.
- **Environment guards.** `check-harness.mjs` lists connector tools missing from the allow list;
  `preflight-data.mjs` holds read tests whose reference query finds nothing before agents are paid
  for; a harness-refused attempt that did not end correct is re-run, never reused.
- **Judge independence** is checked: an answer or realism judge that is also a contestant is named
  in the report's limits.

### Insight (P1)
- Eval report rebuilt around the answer: a summary page that answers who is best, by how much and
  whether it is real (paired McNemar test, 95% range), most efficient (tokens per correct answer),
  best at complex work, writes, ambiguity, dates and recovery, where all models struggle, the
  connector gaps and what to do next — each with a confidence label.
- Leaderboard in order: task success, the pairwise test, MCP interaction quality, reasoning on
  harder work, recovery, efficiency, and the overall score last.
- Breakdown matrices by difficulty, skill, interaction pattern, area, persona and task type;
  agreement with unique wins and failures; use case × model with area, persona, difficulty,
  pattern, measured discrimination and agreement.
- `manage-catalog.mjs tag`: tags a catalog written before 3.2 without unfreezing it (Asana tagged).

### Depth (P2)
- Model behaviour profiles computed from journeys: strengths and weaknesses against the other
  models, typical failures (incl. clean-but-wrong), how it uses MCP, recovery, efficiency, best and
  worst suited areas.
- "Why models differ": per use case, the behaviour behind each model's outcome.
- Measured discrimination per use case. MCP interaction metrics: wrong object, wrong field,
  missed required filter, rejected SQL, discovery and repeated calls, reading the instructions first.
- Evidence strength (customer, community, vendor, docs, inferred) in the capability report; an
  `inferred` source kind allowed only for ambiguity, missing-information and limitation cases.
- The realism rubric gains a `delegation` criterion: would a person hand this to an AI assistant?

## 3.2.0 — 2026-10-03

Better use cases, not more. Each check so far looked at one use case at a time — its evidence, its
wording, its check — so nothing could see what an area was missing: the ambiguous request, the
one the source cannot do, the complex one, or a persona with no real work of its own. The catalog
now records what each use case asks of the AI and checks the set as a whole before an area is
frozen. `references/11-catalog.md` §5.5b, §5.5b′.

### Use cases
- **`difficulty` and `tests`.** Every new use case is `simple` · `medium` · `complex` and lists
  what it asks of the AI beyond finding the data: `filters` · `dates` · `aggregation` ·
  `relationships` · `multi_step` · `write` · `ambiguity` · `missing_info` · `limitation`.
  Not part of a use case's hash, so tagging an existing catalog invalidates no result.
- **The hard cases are part of the business.** Writer rules for realistic ambiguous requests,
  requests missing a detail, and requests the source cannot do — decided by the judge, where
  asking (or stating an assumption) and saying "not possible" are the right answers.
- **Persona first.** The writer lists each persona's own decisions and tasks before writing; the
  same question is never given to several personas.

### Set checks before freeze
- **Mix floors** (`catalog.mix`): per area, a minimum of each difficulty and of dates, totals,
  links between objects, a write, an ambiguous request, one missing information and one not
  possible. A floor, never a quota — a kind the area has no realistic request for is explained
  under `mix_explained`.
- **Persona balance**: each persona needs `catalog.min_per_persona` use cases (or an explanation);
  a persona holding more than `max_persona_share` of an area, and questions shared across
  personas, are flagged.
- **Coverage review** (`agents/catalog-reviewer.md`): a fresh reviewer reads each area's whole set
  and lists missing workflows, persona gaps, missing cross-object, action, ambiguity, negative,
  limitation and complex requests, and redundant or low-value use cases. Every finding is answered
  — added, retired, reworded or kept with a reason — and the answers are checked against the
  catalog. `review-prep` · `review-merge` · `review-answer` · `retire`.
- `scope.mjs research-plan --fill` now also plans evidence for mix gaps, thin personas and
  unanswered review findings (`needs`).
- `manage-catalog.mjs status` prints each area's mix and persona counts. Areas frozen before 3.2
  keep their freeze; status shows what they would need when next researched.

### Report design
- Both reports (model eval and capability) share one design: a branded header band with the run's
  facts as chips, a sticky tab bar with count badges that stays on one line, Inter type, cards and
  tables with soft shadows and hover states, square status badges, a "Highest score" marker on the
  leading model, an inline favicon, and print styles (the open tab, without controls). The partial
  coverage notice moves from the header to the top of the summary. Light and dark themes kept.

### Scoring
- A correct answer with no query at all (asking which project was meant, or saying the source
  cannot do it) gets full efficiency instead of none.

## 3.1.0 — 2026-10-01

Area by area. Researching every business area and persona of a large connector in one pass
spreads one researcher too thin, which is where invented use cases and missed scenarios come from.
Research is now scoped to business areas and done in small batches. Each area must prove it is
complete before it is frozen, and every later step adds up instead of starting over. Full runs work
as before: `--all` is the same flow over every area. `references/13-scope.md`.

### Scope and flags
- `--areas a,b` · `--all` · `--execute` · `--eval [models]` · `--models` · `--continue` · `--redo`.
  With no scope, the run shows every area with its personas, capabilities and state, and asks.
  Discovery and the capability list always cover the whole connector.
- `scripts/scope.mjs`:
  - `status`: per area, the research state, completeness, use cases, valid and stale results, evals, and the next step.
  - `research-plan`: batches of at most `scope.max_areas_per_batch` areas or `max_capabilities_per_batch` capabilities, with large areas split along their flows. Pending batches are continued, never duplicated. `--fill` covers only what the completeness check found missing; `--cross` adds the cross-area pass.
  - `prepare-run`: leaves only the tests without a valid stored result.
- The capability review names each area's `personas` and `related` areas.
- `detect-stage.mjs --areas / --all` routes an unfrozen area in scope to 5.5, and a plan that does not cover the scope to 8.

### Research checks
- **Completeness per area.** Every applicable capability is used by a use case or listed under
  `no_business_use` with a reason, and every persona of the area has a use case. The vendor's API
  is the denominator, so "did we miss anything?" becomes a count. Freeze lists the gaps.
- **Source checking.** Every source needs a URL. `sources-prep` lists the cited pages, an agent
  opens each one, and `sources-merge` records found, off-topic or not found. Evidence that doesn't
  hold blocks the freeze.
- **Whole-catalog duplicate check.** `manage-catalog.mjs add` merges a research batch, dropping
  near-duplicates of any use case in any area.
- **Per-area human review.** Ratings accumulate per area and remember the wording the person saw.
  A review stands until the area grows by more than `catalog.human_regrow`.

### Freeze and results per area
- `cat.areas.<id>` holds each area's own version and hash. `freeze --areas` freezes some areas
  without reopening the others. `reset-area` retires an area's use cases (ids stay permanent) so
  it can be researched again.
- **Results are reused per use case.** Each record carries its use case's hash, and each run has
  an environment key (connector build, instructions, workspace — not the catalog). A stored result
  counts while both are unchanged, so adding an area or a cross-area use case invalidates nothing
  already measured. A changed build makes results stale, and they are reported as stale.
- `generate-tests.mjs --areas` plans only frozen areas and refuses an edited one. A partial scope
  plans the business suite only (`--with-conformance` adds the driver checks).

### Reports and eval
- **The capability report is combined by default.** It uses the newest valid result of every use
  case across all runs. The header shows "N of M areas researched", a "Partial coverage" banner
  names what is missing, and there is no connector-wide use-case figure until every area is done.
  The Run details tab lists the runs combined and coverage by area. `--run` still reports one run.
- **Evals plan per use case** across stored runs, with `--areas` and `config.eval.default_models`.
  A model runs only what it lacks, and the summary records its areas.

### Fixes from the independent review (before release)
All 13 findings are fixed, each with a test that reproduces it:
- **Undecided results were reused.** A key is valid only when every attempt's outcome is decided.
  "Not run" (for example writes were off), "awaiting judgement" and "not checked" are re-run, and
  "not possible" lapses when its capability becomes exposed.
- **Run order.** Runs are ordered by when they ran (`run_started_at`, from `prepare-run`), and
  re-ingesting keeps the original times. Before, re-ingesting an old run made it newest, so it
  overrode newer results.
- **The hash of what was run.** Each planned test carries `uc_hash`. Ingest stamps that, not the
  catalog as it is at ingest time, and a pre-3.1 plan whose wording no longer matches the catalog is stale.
- **Router.** A prepared plan with nothing left to run goes to Stage 12, not round to Stage 8.
  `--areas` / `--all` outside capability mode abort before any route is taken.
- **Batching.** A capability shared by two flows is researched once, and a flow over the limit is split.
- **Smaller fixes:**
  - `add` refuses a batch superseded by `reset-area`.
  - Reports group a use case by its current area.
  - `plan.scope.partial` is right however the scope was chosen.
  - An ambiguous area prefix is refused.
  - A reworded rated use case is sampled again first.
  - `ingest` refuses a run id or model the plan was not prepared for.
  - Eval-scoped capability reports are written as `<C>_capability_report_<eval>_<model>.html`, so the official combined report is never overwritten.
- **Second pass.**
  - An earlier run can still be re-ingested after `prepare-run` moved on: its tests are rebuilt from its stored records, and this is refused only if the plan was regenerated since.
  - "Nothing to run" routes to Stage 12 only for the model the plan was prepared for.
  - The docs now say a partial scope, including `--all` with an unresearched area, plans no conformance checks.

### Tests
- `tests/v31-scope.test.mjs` takes a four-area connector through the cumulative workflow:
  - two areas researched, blocked by the completeness check, filled, checked, judged, sampled and frozen
  - run and reported as partial
  - a third area added without reopening the first two, run with the earlier results reused
  - a redo, then a build change that makes everything stale
  - a cross-area pass that keeps measured results
  - an eval with default models, an area reset, and the router

  `tests/v31-units.test.mjs` covers batching, area names, per-use-case reuse, completeness,
  sources, the per-area human review and cross-area pairs.

## 3.0.0 — 2026-10-01

Capability mode. A run can now answer the question the project exists for — **"can I do through
CData what the source can do?"** — measured against the source's own API, with real use cases,
complete AI journeys, scored results that are kept, and model evals that reuse them. Existing runs
and artifacts are unaffected: everything new is behind `run_meta.mode = "capability"` or a new
command, and the 2.x pipeline runs as before.

### Stage 1.5 — capability list (`scripts/capability-list.mjs`, `lib/capabilities.mjs`)
- Reads the source's OpenAPI description (JSON, or YAML through a dependency-free scanner of the
  `paths` block) into capabilities with stable ids and kinds (list · get · create · update ·
  delete · action), maps each onto the connector's tables, advertised writes and procedures, and
  marks it exposed · partly · not_exposed · not_applicable · product_only.
- Low-confidence mappings and the grouping into business areas and flows are reviewed by
  `models.research_business`; `status` gates the catalog until they are. `references/10-capabilities.md`.

### Stage 5.5 — use case catalog (`scripts/manage-catalog.mjs`, `lib/catalog.mjs`)
- Evidence first (`agents/usecase-researcher.md`): help articles, templates, standard reports,
  community questions, developer and integration templates. Every use case needs a source, a
  persona, a goal, an area, the capabilities it needs, clean wording, and a check.
- Permanent ids (`UC-<PREFIX>-0001`), a realism judge in a fresh context, a stratified one-time
  human sample with measured agreement, and `freeze` — a numbered version with a hash over ids,
  wording, kinds and checks. `references/11-catalog.md`.
- `generate-tests.mjs` takes the business suite from the frozen catalog (variants, attempts by
  priority, writes made reversible by `check.cleanup_sql`, use cases that need an unexposed
  capability planned as **not possible** and never dispatched) and stands its draft generators
  down. An unfrozen or edited catalog is refused unless `--allow-unfrozen`.

### Stage 9 — complete journeys and answer checks
- The agent returns every call with its exact input, its reason, the full result or error, and its
  final rows; files are kept per run and attempt under `_agent_out/<run id>/`.
- The orchestrator runs each use case's reference query itself, then its cleanup; `judge` checks go
  to the fixed `models.answer_judge`. `references/07-execution.md` §9.1c.

### Stage 10.2b — scored, permanent results (`scripts/ingest-results.mjs`)
- `lib/journey.mjs` normalises journeys: step categories, CData error classes with their owner
  (connector · metadata · AI agent · account), retries, recoveries, dead ends, repeats.
- `lib/checks.mjs` decides answers on data with six rules; an empty reference is "no test data",
  never a pass. `lib/scoring.mjs` scores 0–100 (correctness 50 · efficiency 20 · robustness 15 ·
  speed 15, configurable) with blue / yellow / red grades; a wrong answer is always red.
- `lib/results.mjs` writes `_results/<Connector>/<run>/` with a manifest and a fingerprint (catalog
  version and hash, connector build, instructions, workspace — not the model, and not the MCP server
  name, which differs per connection without changing what is measured).

### Reports
- **Capability report** (`build-capability-report.mjs`, `assets/capability-report-template.html`):
  the answer first, then use cases with full journeys, checks, attempts and history; gaps and whose
  they are; each business area as its own report; AI friction; a ranked fix list; personas; driver
  checks; use case quality; run details. Built from the store alone.
- **Eval** (`eval.mjs plan|build`, `assets/eval-report-template.html`, `references/12-eval.md`,
  `--eval <models>`): reuses stored runs with the same fingerprint, refuses to compare runs that
  differ in anything but the model, and reports a management summary, leaderboard, use case ×
  model grid with complete side-by-side journeys, task types, areas, friction per model, a fix list
  of problems every model hits, and changes against the previous eval. One full capability report
  per model; the official one is `models.under_test`.

### Config, routing, tests
- New config: `capabilities`, `catalog`, `execution`, `scoring`, `pricing`, `models.answer_judge`,
  and the new artifacts. `detect-stage.mjs` routes capability-mode runs through 1.5 and 5.5, and
  treats approved catalog prompts as already judged.
- `tests/v3-pipeline.test.mjs` drives the whole pipeline on a fixture — spec → capabilities →
  catalog → plan → simulated journeys → store → both reports → a two-model eval — and executes the
  reports' page scripts to prove every tab renders. `tests/v3-units.test.mjs` covers each library.

### Fixes from the independent review (before release)
A review by a stronger model found three critical, six high and thirteen medium issues; all are fixed.
- **Fair comparison.** Every report and eval re-scores its runs against one shared pool
  (`rescore()`), so efficiency and speed are measured against the same shortest path and norms;
  efficiency counts acting calls (query, procedure, write), not discovery. Eval cost uses one
  representative attempt per use case. Baselines are ordered by `built_at`.
- **Honest results.** `write_visible` needs `expect` and a before-snapshot — without one it is at
  best partial; an existing row never passes. A capped agent sample proves nothing without a
  matching stated total; the orchestrator re-runs the agent's final query in full. Counts come only
  from count-named columns. Only wrong · partial · not possible count as failures — not run or
  awaiting judgement are never charged to the AI or the connector.
- **Complete runs.** Every missing attempt is counted; a run is complete only when none are. The
  checkpoint is used only when its meta line names this run. `eval.mjs build --allow-incomplete`
  compares only the use cases every model finished; a different fingerprint is never compared.
- **Trustworthy mapping.** A write is high confidence only when the table's own remarks and the
  connector's permissions agree; every non-high mapping goes to review; `apply` rejects unknown
  statuses and exposures. YAML specs keep path-level parameters and folded summaries; plural nouns
  such as `attachments` are no longer read as actions; procedures for another noun are demoted.
- **Safe cleanup.** `cleanup_sql` must be one UPDATE or DELETE on a table the use case touches,
  pinned by `=` or `IN`; `{{located}}` needs a `locate_sql`; `{{today±N}}` and `{{me}}` keep
  frozen SQL valid. `preflight-writes.mjs` prints every cleanup before the run and refuses a loose one.
- **Catalog integrity.** The hash is key-order independent and covers variants and writes; jobs must
  say `writes`; variants must be judged before a freeze; `judge-merge` skips a bad score with a
  warning instead of failing the batch; plan and eval refuse a catalog edited after freezing.
- **Routing.** `detect-stage.mjs` no longer reports applied 1.5/5.5 reviews or journeys as unmerged,
  and warns when a run's journeys in `_agent_out/<run id>/` never reached the results store.
- **Second review pass.** The scored run is no longer counted twice in the pool, so every model in
  an eval shares one speed norm (before, speed was effectively neutralised). `--allow-incomplete`
  leaves out a use case with *any* missing attempt. `contains` is proven by a capped sample holding
  every expected record. Remarks with a negation ("cannot delete", "read-only") go to review instead
  of being read as support. Cleanup refuses `!=`, `>=`, `<=`, `<`, `>`, `NOT`, `OR`, `IS [NOT] NULL` and `LIKE`, and
  resolves unbracketed dotted names. `write_visible` decides "already there" per key, so a moved
  timestamp no longer makes an old row fresh. `AccountId`, `Discount`, `CountryCode` and `NumericValue` are not counts.
- Docs: `07-execution.md` (per-run layout, attempt-level resume, before/after snapshots,
  placeholders), `11-catalog.md` (expect, writes, locate_sql, min_calls, variants), `12-eval.md`,
  the SKILL.md `--eval` route, `01-discovery.md` and `run-meta.schema.json` (`mode`,
  `connector_build`, `workspace`, `capability_spec`).

## 2.2.0 — 2026-10-01

Realistic test cases. Management reviewed the asn005 Asana plan and found most of its 329 prompts
unrealistic, and they were right: about 60% came from four fixed templates around schema names
("Show me each ProjectFollowers record together with the Workspaces it belongs to"), about 70
carried instructions to the agent ("…then set it back exactly as you found it"), 70 carried a raw
workspace id, none of the 22 Tasks queries selected the task's Name, and everyday questions
(overdue, due this week, workload) appeared a handful of times while an Enterprise add-on got 16.

### Two suites
- **Every test carries `suite`.** `business` — persona everyday questions, use cases, workflows,
  objects with a researched business question. `conformance` — joins, SQL patterns, procedures,
  write checks, agent behaviours. The report labels each row and adds a **Suite** grouping;
  conformance checks are never presented as use cases.
- **Business tests are drafts with a `brief`** (persona, goal, the things involved in people's
  words, scope). Stage 8.5 now rewrites each in the persona's words (`07a-tc-review.md` §8.5.4a);
  a draft left neither rewritten nor `accepted_business` stays a draft and blocks the run.
- **Everyday questions come first.** The persona researcher returns `daily_questions`; each one
  becomes a P1 business scenario, verbatim, matched to the objects it is about.

### Test mechanics out of the prompt
- `expected_behavior` holds what the judge checks (old value read, change visible, key discovered,
  edge case handled); `agent_context` holds the operating note Stage 9 hands the agent beside the
  question (test-account write rules, undo procedure, workspace). Workflow, write, procedure and
  join prompts no longer say "carry this out end to end", "read it back", "say plainly", "find a
  suitable X first" or "nothing is prepared for you".
- Conformance prompts are rewritten in the words people use (`naturalize`: "one Tasks record" →
  "one task", "ProjectFollowers" → "project followers").

### Stage 8.6 — the realism gate (new)
- **`scripts/realism-check.mjs`** lints every prompt (`lib/realism.mjs`: schema names, raw ids,
  SQL words, instructions to the agent), packages business prompts for an independent judge
  (`config.models.realism_judge`, fresh context, no SQL or gaps), merges its 1–5 scores, and blocks
  Stage 9 while any business scenario is unscored, still a draft, fails lint, or scores below
  `config.defaults.realism.min_score` (4). A prompt rewritten after scoring is unscored again.
- `detect-stage.mjs` routes a plan with business drafts to 8.5 and an unjudged plan to 8.6.

### Columns a person means
- **`headlineColumns`** picks label, owner, state, key date, key figure and parent for every
  object (or `object.headline_columns` from Stage 3). `project()` selects these first and never a
  column that describes the API (`ResourceSubType`, `HtmlNotes`, `ItemURL`); `roleCol` no longer
  groups or filters on one. The old fixed role order put `descriptive` — the Name — last.

### Priorities that match real use
- **Prevalence.** The domain researcher records `prevalence` (core / common / specialised /
  premium) from plan availability and the vendor's own getting-started material; tiering weighs it
  −2…+3 and business-test priority follows it. It is a property of the product, so dump parity holds.
- **Synonyms.** Stage 3 records `synonyms`; tiering matches them like the name, so Users scores
  persona coupling from "teammate" and "owner".
- **A domain no role can use is unknown, not zero.** asn005's matrix had 7 of 14 domains all-`N`;
  tiering now scores role reach as unknown there and warns, instead of silently penalising them.
- Behaviour probes are hosted on the highest-scoring T1 object, not whichever came first in the file.

### Research that is checked for sense, not just shape
- `validate-agent-output.mjs` rejects: a domain without `prevalence`, or every domain `core`; a
  persona without `archetype` (doer · coordinator · analyst · executive · administrator ·
  integrator) or 2–5 `daily_questions`; an everyday question that leaks schema, ids or SQL; a
  persona set with no doer, coordinator or analyst; a role missing a domain key; a domain where no
  role has access; a top admin role weaker than a member across most domains.
- The domain researcher runs before the role researcher, which gets the real domain ids.
- **Old research fails these checks on purpose.** Re-run Stage 2 for a connector researched before
  2.2 (`/connector-qa <Name> --fresh`), or tiering and the everyday questions have nothing to use.

### Write safety
- **The pinned-workspace gate is opt-in.** Connectors are tested against test accounts, so
  `write_policy.require_workspace_pin` ships `false`: `preflight-writes.mjs` still refuses a write
  not flagged `mutates`, lists what will be written and passes. `true`, `run_meta.require_workspace_pin`
  or `--strict` restores the full gate, which now also accepts the pin in `agent_context`.

### Models per job
- `models.research_business` (new, `opus`) for the domain and persona researchers;
  `models.research` (`sonnet`) for role and integration-pattern; `models.realism_judge` (new,
  `opus`; `fable` is stronger but needs 30-day data retention). `tc_review` (`opus`) now also writes
  the business prompts.

### Also
- `merge-checkpoint.mjs` carries `suite`, `expected_behavior`, `realism`, `prompt_status` into the
  report; the report's Persona grouping reads `tc.persona` (it read a `group_type` nothing set).
- `schemas/test-case.schema.json` documents the new fields and the `workflow` / `write` group types.
- `check-skill.mjs` skips `dist/` and `_archive/`.
- `tests/realism.test.mjs` (19 tests) pins every defect above against an Asana-shaped fixture;
  `write-target.test.mjs` covers the opt-in gate. 124 tests.

## 2.1.1 — 2026-10-01

Shareability release. Nothing in the runtime's behaviour changes except the write default; the
installers and the shared copy are now safe to hand to someone else.

### Installer
- **Windows PowerShell 5.1 broke the installed skill.** Its `Set-Content -Encoding UTF8` writes a
  byte-order mark; `JSON.parse` in Node rejects it, so `generate-tests`, `export-jdbc-suite` and
  every script loading config through `lib/artifacts.mjs` failed on a fresh install — while the
  installer printed "Ready.". `install.ps1` now splices `root` into the original text and writes
  UTF-8 without a BOM, then reads the file back to verify.
- **Only the runtime is installed.** Both installers copied the whole folder — `node_modules`,
  `_doc/`, report previews, six `.docx` — giving a 14 MB skill folder. They now copy an explicit
  allow-list (`SKILL.md`, `config.json`, `LICENSE.txt`, `agents`, `assets`, `references`,
  `schemas`, `scripts`, minus the dev-only `sync-skill.mjs`) — the same set `sync-skill.mjs` syncs.
- **A failed check fails the install.** Any failed integrity check, including `check-skill`, ends
  with "NOT ready" and exit 1. `install.sh` now runs `check-skill` too.
- **Node 20 is checked first and is required.** Both installers stop before changing anything
  when Node is missing or older than 20, matching `package.json` `engines` (the test runner's
  directory argument is a Node 20 behaviour). README no longer calls Node optional.
- `install.sh`: writes `CONNECTOR_QA_ROOT` to `~/.zprofile` as well when the shell is zsh (macOS
  never reads `~/.profile` there); uninstall no longer leaves a `~/.profile.bak`.

### Shared configuration
- **`write_policy.execute_irreversible` ships `false`**, and `write_workspace` ships `null`. The
  shared copy carried the maintainer's own setting and the note "confirmed by the operator", which
  was not a confirmation any recipient had made. Irreversible writes are now planned, reported and
  held back until someone pins a disposable `workspace` and turns the switch on themselves.
  **If you rely on irreversible writes locally, set it back to `true` in your installed config.**

### Packaging
- **`npm run package`** (`tools/package.mjs`) runs `check-skill` and the test suite, refuses a
  config carrying a machine path, a pinned workspace or irreversible writes, and builds
  `dist/connector-qa-<version>.zip` without `node_modules`, `_`-prefixed scratch or `dist`.

### Documentation
- README: the `skill/` folder it said to zip does not exist; it named three research subagents
  (there are four); said Node 18+ was optional; and said the plan file is deleted after the report
  (config keeps it). All corrected, plus an install-from-zip path and a Writes section.
- Setup Guide and Installation Reference regenerated from `_doc/` with the same corrections; the
  three "known issues" this release fixes are removed from the guide. The Framework design
  document's config sample now shows the shipped write defaults.
- Superseded documents moved to `_archive/`: the two v1.0 `MCP-Connector-Test-*` documents
  (pre-rename) and the older of the two Framework document copies.

### Not individually logged
- Between this entry and 2.1.0, `detect-stage.mjs`, `generate-tests.mjs`, `build-report.mjs`,
  `merge-checkpoint.mjs`, `enhance-steps.mjs`, `read-driver-schema.mjs`,
  `assets/report-template.html`, `references/00-contracts.md`, `04-coverage-model.md`,
  `06-test-generation.md`, `07-execution.md`, `07a-tc-review.md`, `SKILL.md` and
  `agents/integration-pattern-researcher.md` changed (2026-09-28 to 2026-09-30) without changelog
  entries. The test suite (96 tests) passes against them; the changes themselves are not described
  here because there is no version history to recover them from.

## 2.1.0 — 2026-09-27

Coverage must not depend on luck. The theme of this release is that what gets tested is decided by
the connector's own surface, never by whether a customer happened to share a query dump, and never
by whether a review pass noticed something missing.

### Coverage independence from customer dumps
- **Applicability is structural.** `references/04-coverage-model.md` §5.4 no longer ranks customer
  evidence above schema structure when deciding whether a SQL pattern applies. Evidence may
  contradict an exclusion or raise a gap's priority; it can never mark a pattern inapplicable. The
  previous wording required a *positive reason* to test a pattern on a connector with no dump,
  which made the least-observed connectors the least-tested ones.
- **The cap reserves a coverage floor first.** `generate-tests.mjs` used to sort by priority and cut.
  Priority descends from gap scores and gap scores rise with evidence, so the same connector at the
  same cap kept a different set of tests depending on whether a dump existed. It now reserves one
  test per procedure, object, relationship, pattern and advertised capability, then trims only the
  tail. If the floor exceeds the cap, the floor wins and says so.
- **`tests/dump-parity.test.mjs`** runs the pipeline with and without evidence and asserts the same
  gaps, the same plan surface, and the same survivors under a cap.

### Coverage holes closed
- **New `OBJECT` gap category.** Nothing emitted a gap for an object that no test queries, and
  `generate-tests.mjs` wrote a baseline test only for T1/T2 — so every lower-tier object was
  untestable by construction. Tier now governs how *deeply* an object is covered, never whether it
  is looked at. asn004 hid this by tiering almost everything T1.
- **The generator writes INSERT and UPDATE tests.** `PATTERN_TC` had no entry for either, so the
  entire write surface depended on the Stage 8.5 reviewer noticing its absence — which is exactly
  how asn004 shipped 118 SELECTs and zero writes. Reversible updates execute; inserts that cannot
  be undone are planned, reported and held back with a stated reason.

### Verdict correctness
- **One 0-row rule.** `00-contracts.md` said no test data → `nt`; `07-execution.md` said a genuinely
  empty object → `pass`. Same observation, two answers. Now stated once in `00-contracts.md` §4 and
  referenced from Stage 9. `boundary` requires an actual refusal, and `credit-coverage.mjs` refuses
  to credit coverage from a `boundary` verdict with no refusal on any step.

### Tiering
- **`scripts/tier-objects.mjs`** replaces by-hand tiering with the business-model weights of §5.1 —
  workflow subject, vendor report, relationship centrality, role reach, category, persona coupling.
  Customer usage is not a signal. Records `tier_score` and `tier_signals` so a tier can be explained.
  Workflow prose is matched on the head noun as well as the literal name, so *"task dependencies"*
  credits `TaskDependencies`; an ambiguous head noun that is itself another object's name is ignored.

### Reporting
- `risk_flag`, `risk_flag_all`, `nt_reason`, `executable`, `mutates`, `reversible` and
  `undo_procedure` now survive `merge-checkpoint.mjs` and render as flags on the test row. 119 of
  asn005's 237 tests carry a risk flag that previously reached no report.
- A test that was never dispatched is labelled **"Planned, deliberately not executed"** instead of
  "What the agent learned".
- The dead **Iteration Rounds** section is gone from the gap report, along with its live JS and the
  `ITERATIONS` constant.

### Tooling
- **`scripts/check-skill.mjs`** verifies that every `config.a.b` path quoted in the docs exists in
  `config.json`. `SKILL.md` told the orchestrator to read `config.defaults.required_orchestrator`
  while the key lives under `config.models`, so the model gate read `undefined` and never fired —
  a control that looked implemented and did nothing. The same check found a second instance
  (`config.defaults.max_tcs_per_round`, stale since rounds were removed).
- **`scripts/sync-skill.mjs`** reconciles this repo with the deployed skill. The two had drifted by
  17 files, with every recent fix in the deployed copy and the only test suite in the repo — so the
  tests were passing against code nobody was running.

## 2.0.0 — 2026-09-25

Remediation of the end-to-end review. Every finding is referenced by its review id.

### Critical
- **C1** A completed run is now marked `run_state: complete` and archived to `runs/<run_id>/` by
  `scripts/finish-run.mjs`; `scripts/detect-stage.mjs` routes a completed run to Stage 1 unless
  `--resume`. Previously the next run was routed to Stage 8 holding already-resolved gaps and never
  re-ran discovery.
- **C2** New `EXPOSURE` gap category: every vendor domain / standard report / workflow with no
  connector object behind it. Discovery funnel (`coverage.funnel`) and an assessment-confidence
  score rendered at the top of both reports. Denominators are now stated, not implied.
- **C3** Connector verdict is derived by rule in `scripts/credit-coverage.mjs`: a FAILED Band-1
  pattern → `not_ready`; an OPEN/FAILED P1 gap or an EXPOSURE gap on a standard report → at most
  `needs_attention`. Health is two numbers — `pass_health` and `gap_health`.
- **C4** Gap emission, priority scoring, coverage crediting, observed-SQL parsing and report
  assembly moved from prose-for-the-model to scripts: `compute-gaps`, `score-gaps`,
  `credit-coverage`, `parse-sql`, `build-report`. Pattern regexes live once in
  `scripts/lib/sql-patterns.mjs`, shared with `mine-dump`.

### High
- **H1** Stages 5–8 persist every `persist_every_n_items` with a `stage_progress` marker.
- **H2** Retry with exponential backoff and a per-query timeout before an infra failure cascades.
- **H3** Checkpoint is append-only `checkpoint.jsonl`; `merge-checkpoint.mjs` folds it at Stage 12.
- **H4** `run_meta` on every artifact and in a footer on both reports.
- **H5** `validate-agent-output.mjs` schema-checks the three research agents; misleading `tools:`
  frontmatter removed.
- **H6** No-dump evidence floor for T1 gaps; a rubric for `business_importance`.
- **H7** `unusual_queries` persisted with literals stripped.
- **H8** Tier self-check: random T3/T4 probes raise a `TIERING` observation when they look like T2.

### Added after remediation
- **Isolated execution.** Stage 9 now dispatches each test to a fresh subagent that sees only the
  prompt and the MCP tools, on `config.models.under_test`. The orchestrator classifies the returned
  call log. Previously the orchestrator answered its own prompts, so author and agent-under-test
  were the same context and the separation was a rule, not a boundary. `run_meta.execution_mode`
  records which mode ran; the report footer flags `in_thread` as a weaker measurement.
- **Model per subagent stage.** `config.models` now holds Agent-tool model names; research and
  semantic shards are dispatched with them and the resolved model is recorded.

### Medium / Low
- **M1** `schema_version` on every artifact; this file; `version` in `config.json`.
- **M2** `check-skill.mjs` ships; `npm test` runs it plus both validators; evals carry assertions.
- **M3** After a 0-row fallback, `observed` parses the original query; fallback SQL kept separately.
- **M4** AI-inferred relationships require FK-shaped naming or are marked `UNKNOWN`.
- **M5** Every agent behavior has a prompt shape, pass criterion and owner-on-failure.
- **M6** Intent equivalence: deterministic pre-check on observed structure; model adjudicates residue.
- **M7** `install.sh`; shell-neutral environment variable references.
- **L1** "What this run did not assess" panel. **L2** Stats tiles grouped into three clusters.

## 1.0.0 — 2026-09-25

Initial refactor from the two-file `mcp-dynamic-*` commands into a standard skill layout.
