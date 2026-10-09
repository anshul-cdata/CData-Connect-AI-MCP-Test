---
name: connector-qa
description: "Test, validate and measure real-world coverage for one CData connector through the Connect AI MCP server. Use this skill whenever the user wants to test, validate, QA, benchmark, regression-check or measure coverage for a connector — NetSuite, Salesforce, QuickBooks, ServiceNow, Jira, GitHub, Office365, or any of the 300+ CData connectors. Triggers include: 'test <connector>', 'validate <connector>', 'run connector QA', 'check MCP coverage', 'gap analysis for <connector>', 'does <connector> actually work', 'which business use cases does <connector> support', 'why are <connector> queries failing', 'generate a connector test report', or any mention of connector coverage, MCP query validation, SQL capability testing, or customer query dumps. Also use it to resume an interrupted connector run — re-invoking picks up from the last checkpoint. Produces two HTML reports: test results, and a separate gap analysis."
license: Internal use. See LICENSE.txt
version: 3.9.2
---

# Connector QA Runtime

Orchestrator. Decide what runs next and which reference to load; the domain detail lives in
`references/`, read on demand.

## The architectural contract

This runtime is not `research → generate many tests → execute`. It is coverage-driven: compute
what coverage is *required*, measure what is *missing*, then write only the tests that close the
difference.

Three rules override everything else here:

1. **No business query executes before Stage 6 completes.** Metadata calls (`getTables`,
   `getColumns`, `getProcedures`, `getInstructions`) and the bounded probes in Stage 3 are
   discovery. Anything else before Stage 8 means tests were written before anyone knew what was
   missing, which is the failure mode this design exists to prevent — stop and report it.
2. **Every test case cites at least one `gap_id`.** A test that closes no gap does not get
   written. This is what keeps the plan at its minimum useful size instead of a round number.
3. **Optimize for coverage, never test count.** Ten tests closing twelve high-priority gaps beat
   a hundred repetitive SELECTs, because the hundred leave the same risks unexamined.

---

## Step 0 — Load config, parse arguments, route

### 0.0 Check the skill version first

Run `node "<skill>/scripts/check-version.mjs"`. Exit 3: the installed copy differs from its source
folder — **stop**, show the user the message (it names the re-install command) and do not start.

### 0.1 Load configuration

Read `config.json` from this skill's folder. It is the only configurable surface.

Resolve `$ROOT` in this order and take the first that yields a usable directory:

| # | Source | Notes |
|---|---|---|
| 1 | environment variable `CONNECTOR_QA_ROOT` (`$env:` in PowerShell, `$` in Bash) | set by the installer; machine-specific, never shared |
| 2 | `config.root` | non-empty only after a local install |
| 3 | The **parent of this skill folder**, when it is named `ConnectAIMCPTest` or already contains `_querydumps/` | the zero-config case |
| 4 | `config.root_fallback`, expanding `%USERPROFILE%` | last resort |

Create the directory if absent. Name the rule that won, in one clause, on the Step 0 line. Say so
explicitly when rule 4 wins — the user almost certainly meant a project folder, and silently
writing to Documents hides that.

**There are no rounds.** Stage 8 enumerates the whole surface in one pass; gaps still open at the
end are guidance for the **next** run, never re-tested inside this one.

Never hardcode a path elsewhere, and never write a username into a file that ships. `config.root`
is filled per machine by the installer; the shared copy keeps it empty.

### 0.1b Ask about writes — first thing, then run unattended (3.7)

The connector folder name comes from the argument; create `$ROOT/<Connector>` if needed, then run
`node "<skill>/scripts/write-policy.mjs" status --dir "$ROOT/<Connector>"`. It prints `ASK` at
**every** run start while config allows writes. Put the question to the user **now**, before any
other work (AskUserQuestion), and record the answer with `write-policy.mjs confirm --answer test`
(writes run) or `--answer readonly` (nothing that changes data runs, reversible or not, for that
connector folder until answered again). Never decide it yourself. Separately,
`config.defaults.write_policy.safe_mode: true` holds only irreversible writes and requires a pinned
workspace (`write_policy.workspace`; `write_workspace` is retired).

### 0.2 Arguments

```
/connector-qa <ConnectorName> [--areas a,b | --all] [--report] [--no-compare-mcp] [--api-docs <url>] [--execute] [--eval [models]] [--models a,b] [--continue | --redo [a,b]] [--dump <path>] [--maxrounds N] [--fresh] [--rerun] [--resume]
```

| Token | Meaning | Default |
|---|---|---|
| first word after the skill name | Connector name — store as `$CONNECTOR` | required |
| `--dump <path>` | A specific query dump, CSV file or folder — store as `$DUMP_ARG` | auto-discovered |
| `--maxrounds N` | **Accepted and ignored.** Generation is single-pass and surface-driven — see below | — |
| `--fresh` | Ignore everything on disk for this connector and start at Stage 1 | off |
| `--rerun` | Skip Stages 1–7 (use existing knowledge + gaps): with a plan present, execute it; otherwise regenerate tests. The orchestrator makes one `getCatalogs` call first to confirm the connection. Use when the connector has not changed. | off |
| `--resume` | Reopen a *completed* run's artifacts instead of starting fresh (rare; for re-reporting) | off |
| `--areas <a,b>` | *Capability mode.* Research these business areas (id, name or slug; ≤ `scope.max_areas_per_run`) up to their freeze — `references/13-scope.md` | ask |
| `--all` | *Capability mode.* Research every business area, in batches | ask |
| `--no-compare-mcp` | *Capability mode.* Skip Stage 1.5e for this run. By default the source vendor's own MCP server (connected in this session, or its published tool list) is compared with CData ConnectAI MCP: both · only CData · only the vendor MCP · neither, in every capability report. `config.capabilities.compare_vendor_mcp: false` turns it off for good | on |
| `--api-docs <url>` | *Capability mode.* The vendor's API documentation page: Stage 1.5a starts its ladder there (spec → Postman/SDK → reference pages, `api-from-docs.mjs`) instead of searching for it. Needed only when no OpenAPI description is found by search | search |
| `--report` | *Capability mode.* When research stops (no `--execute`), build the analysis report: capabilities, gaps, account readiness and an outlook per use case — nothing run (`build-capability-report.mjs --analysis`, Stage 12) | off |
| `--execute` | Then plan, run and report the scope; only use cases without a valid stored result run. Alone: the whole connector | off |
| `--eval [models]` | Then compare models on the scope, reusing stored results per use case — `references/12-eval.md`. Implies `--execute` | off |
| `--models <a,b,c>` | The models for `--eval` | `config.eval.default_models` |
| `--continue` | Where an area in scope already has work, continue it without asking | ask |
| `--redo [a,b]` | Where an area in scope already has work, do it again (research: reset; execution: re-run) | ask |

**Record run metadata at Step 0** — `run_id`, `started_at`, `skill_version` (from `config.version`),
the orchestrator model, and the MCP server name if `getStarted()` reports one. It goes into
`knowledge.json.run_meta` and onto the checkpoint's first line, and both reports print it in the
footer. Without it two runs of the same connector cannot be compared or reproduced.

**Capability mode (3.0).** When the source publishes an API description, set `run_meta.mode =
"capability"`: the run then answers "can I do through CData what the source can do?" — Stage 1.5
builds the capability list, Stage 5.5 the use case catalog, and Stage 12 leads with the capability
report. Record `run_meta.connector_build` (from `getStarted()` or the driver) — it is part of the
fingerprint that decides whether a stored run can be reused.

**Read the orchestrator model; never type it.** `get_session` (`session_id: "self"`) gives `model`; a
typed value is an assertion nothing can check (asn005 recorded `claude-sonnet-4-6` while Opus 5 ran).
If `config.models.required_orchestrator` is non-null and differs, **stop before Stage 1** and name the
model to pick — only the user can switch a session. Record the model read, per stage if it changes;
delegated stages record the family alias dispatched (`sonnet`, `opus`), never a version.

**Orchestrator advice (3.9) — warns, never blocks.** Run `orchestrator-advice.mjs --dir "$ROOT/$CONNECTOR"
--model <model> [--areas …|--all]` now and, with `--record`, again after Stage 1.5. On `ADVISE` ask the
user once — continue or switch; `--record` keeps actual and suggested in `run_meta.orchestrator`, and the
reports' run details show both. Thresholds: `config.models.orchestrator_advice`. Haiku is never suggested.

| The connector | Suggested orchestrator |
|---|---|
| machine-readable API description · no vendor business API (database, files, generic interface) | sonnet |
| API list assembled from web docs (1.5a), or "assembled (unverified)" and rebuilt that way first | sonnet; opus when many tables have no documented operation |
| large platform: more than `max_tables` tables, `max_capabilities` capabilities or `max_areas` areas | opus |
| more than `max_areas_per_session` business areas in this session | opus |

**Scope (3.1, capability mode).** Research is done per business area, in batches, and every
later stage adds up — catalog frozen per area, results reused per use case, one combined report.
With no `--areas`/`--all`, show `scope.mjs status` and ask. Follow `references/13-scope.md`.
There is deliberately no depth flag: coverage is decided by the gap model; grouping is a report control.

### 0.3 Resolve artifact paths

Create `$ROOT\$CONNECTOR\`. Resolve every name in `config.artifacts`, substituting `{connector}`:

| Variable | Written by | Read by |
|---|---|---|
| `$KNOWLEDGE_FILE` | 1–4, 10 | 5, 6, 12 |
| `$COVERAGE_FILE` | 5, 10 | 6, 7, 11, 12 |
| `$GAPS_FILE` | 6, 7, 11 | 8, 10, 12 |
| `$PLAN_FILE` | 8 | 9 |
| `$CHECKPOINT_FILE` | 9, per test | 10, 12 |
| `$REPORT_FILE` | 12 | — |
| `$GAP_REPORT_FILE` | 12 | — |

`references/artifacts.md` holds the JSON shape of each. Read it when first writing one.

### 0.4 Auto-detect — run the router, do not interpret a table

Routing is code, so it is the same every time and testable:

```bash
node "<skill>/scripts/detect-stage.mjs" --dir "$ROOT/$CONNECTOR" [--fresh] [--resume]
```

It prints one JSON line — `{"stage": N, "reason": "...", "run_state": "...", ...}` — and you
start at that stage. Two of its rules are actions for you, not routing:

| Disk state | Stage |
|---|---|
| `--eval <models>` given | **eval** — bypasses the router: follow `references/12-eval.md` (plan → Stage 9 for each model that needs a run, against the existing plan → build) |
| `--rerun` given · `knowledge.json` has `run_state: "complete"` | a plan with tests present → **9**; else gaps prioritized → **8**; else **7**. The orchestrator first makes one `getCatalogs` call; if it fails, **abort** and report the error |

Every rule the router applies, and the compaction-resilience markers it reads, are in
`references/14-routing.md` — read it when the router's answer looks wrong or when resuming after a compaction.

Log one line, then proceed:
```
$CONNECTOR | run=$RUN_ID | root=<rule that won> | resume=<stage> | <reason from router>
```

### 0.5 Read the driver source, if there is one

Only when a driver enlistment is configured (`config.driver_source.root`, `CONNECTOR_QA_DRIVER_ROOT`
or `--root`), and only when the artifact is not already present:

```bash
node "<skill>/scripts/read-driver-schema.mjs" --connector "$CONNECTOR" --out "$ROOT/$CONNECTOR/${CONNECTOR}_driver_schema.json"
```

Optional: with no enlistment the stage is skipped. What it reads, the `parse_warnings` AI fallback (apply
it before Stage 2) and the fields to pass to Stage 2 agents: `references/00a-driver-source.md` (Stage 0.5).

---

## Stage map — load each reference on arrival

Read a reference when entering its stage, not before. The whole runtime does not fit in context
at once and does not need to.

| Stage | Name | Read |
|---|---|---|
| **0.5** | Driver Source *(optional — only when a driver enlistment is configured)* | `references/00a-driver-source.md` |
| **1** | Connector Discovery | `references/01-discovery.md` |
| **1.5** | **Capability list** — the source's API, mapped to the connector; no OpenAPI → the 1.5a ladder, pages read with the shared page reader *(capability mode)* | `references/10-capabilities.md`, `references/10a-page-reader.md` |
| **1.5d** | **Account probe** — `account-probe.mjs prep`/`merge`, reads only; show per-area readiness before areas are chosen *(capability mode)* | `references/13-scope.md` |
| **1.5e** | **Vendor MCP comparison** — `reference-mcp.mjs read`/`prep`/`apply`; the vendor's own MCP server checked against the same capability list — **on by default** (`--no-compare-mcp` skips it); a vendor without one is recorded with `none` *(capability mode)* | `references/10-capabilities.md` §1.5e |
| **2** | Source Understanding | `references/01-discovery.md` |
| **3** | Semantic Schema — 3a: tier · 3b: dump scan · 3c: getColumns | `references/02-semantic-schema.md` |
| **4** | Customer Evidence *(optional)* | `references/03-customer-evidence.md` |
| **5** | Coverage Model + Tiering | `references/04-coverage-model.md` |
| **5.5** | **Use case catalog** — evidence, wording, checks, coverage review, judge, human sample (off by default; `freeze --skip-human`, record `run_meta.human_review = "skipped (config)"`), freeze; built once; 5.5a′ `test-data.mjs survey-prep`/`survey-merge` before use cases are written *(capability mode)* | `references/11-catalog.md` |
| **6** | **Gap Analysis** | `references/05-gap-analysis.md` |
| **7** | Gap Prioritization | `references/05-gap-analysis.md` |
| **8.0** | **Test data** — `test-data.mjs find-prep`/`find-merge` until nothing is listed, `seed-prep` (show the INSERTs; run only after a yes), `seed-merge`, find again, `status` *(capability mode)* | `references/07-execution.md` §9.0b |
| **8** | Targeted Test Generation | `references/06-test-generation.md` |
| **8.5** | Pre-Execution TC Review *(Opus)* · **writes every business scenario in its persona's words** · exports the JDBC suite. *Capability mode: does not run for catalog tests — they are born approved; the catalog's review, realism judge and human sample replace it* | `references/07a-tc-review.md` |
| **8.6** | **Realism gate** — an independent judge scores every business prompt 1–5; below `realism.min_score` blocks execution | `references/07a-tc-review.md` §8.6 |
| **9** | MCP Execution — parallel batches | `references/07-execution.md` |
| **10** | Coverage Reconciliation · **10.2b stores scored journeys** (`ingest-results.mjs`) | `references/08-reconcile.md` |
| **10.5** | Post-Execution AI Review *(Sonnet 5)* | `references/08-reconcile.md` |
| **12** | Reports — **capability report first** (§12.1b) | `references/09-reporting.md` |
| **scope** | Area-by-area research, execution and eval *(`--areas`, `--all`)* | `references/13-scope.md` |
| **eval** | Model comparison on the frozen catalog *(`--eval`)* | `references/12-eval.md` |

Capability-mode order: 1 → 1.5 → 1.5d → 1.5e → (2–4) → 5.5 → 5 → 6 → 7 → 8.0 → 8 → 9.0 checks → 9 → 10 → 12.
Stage 1 records `run_meta.catalog`, `schema`, `workspace`, `workspace_catalog` and `me`
(`references/01-discovery.md`); the later scripts read them.

Read `references/00-contracts.md` once during Stage 1. It defines the shared vocabulary — the 14
verdicts, 4 fault owners, provenance model, coverage states, gap categories, tiers and column
roles — that Stages 3, 5, 6, 9 and 10 all depend on.

---

## Delegation policy

Delegate only where it genuinely reduces context or wall-clock time. Several stages need the
whole picture in one head; splitting those fragments the very signal the runtime exists to catch.

### Every delegated agent writes its result to disk before returning it

A returned result lives only in the orchestrator's context. When a compaction lands while agents
are in flight — and Stage 3 agents run for tens of minutes — their reports arrive in a context
that no longer knows what to do with them, and the work is gone. In asn005 one semantic batch ran
38 minutes; it survived only because that agent happened to save a scratch file of its own.

So every dispatch tells the agent to **write its JSON to
`$ROOT/$CONNECTOR/_agent_out/<stage>-<name>.json` first, then return it**. The return value is a
convenience; the file is the record.

On entering any stage that dispatched agents, check `_agent_out/` before re-dispatching:

| `_agent_out/` holds | Do |
|---|---|
| a file for an agent whose result was never merged | merge it — do not re-run the agent |
| nothing for that stage | dispatch as normal |

`detect-stage.mjs` reports unmerged files so a resumed run does not silently pay for the same
research twice, or worse, proceed without it.

**Stage 2 research agents** run in parallel when `config.delegation.parallel_research_agents` is true —
the agent table, the domain-first rule, the models per agent and the validation are in
`references/01-discovery.md` (Stage 2).

**Stage 3 semantic schema** tiers first above `config.delegation.tier_before_columns_above_objects` objects and
shards above `config.delegation.shard_semantic_schema_above_objects` — `references/02-semantic-schema.md`.

### Scripts — arithmetic is code, judgement is yours

Anything that is a loop, a sum, a join or a copy runs as a script. The model does the parts that
need judgement: meaning, importance, prompt writing, fault narrative, conflict adjudication. This
split is what makes results reproducible and lets a 500-object connector fit.

Which script does what, stage by stage: `references/15-scripts.md` — read it when you need a script
you have not used in this run.

Every script prints a short summary; where it wrote a `*-summary.json`, **read that**, never the full artifact.

### Agents and the model each uses

- Stages 8.5 / 10.5 reviewers: one `general-purpose` subagent each, `config.models.tc_review` /
  `config.models.post_exec_review` — `references/07a-tc-review.md`, `references/08-reconcile.md` §10.5.
- Capability mode: `config.models.research_business` (1.5c review, research, writer, coverage reviewer),
  `config.models.realism_judge`, `config.models.answer_judge` and `second_judge` — `references/11-catalog.md`.
- Stage 8.6 realism judge: `config.models.realism_judge`, fresh context — `references/07a-tc-review.md` §8.6.

---

### Isolated subagent per test — Stage 9 execution

When `config.models.isolate_execution` is true (the default), each test goes to a **fresh
`general-purpose` subagent** with `model: config.models.under_test`, one at a time, in plan order. It
receives **only** the prompt, the instruction to answer it with the connector's MCP tools, and the
instruction to return a verbatim log of every MCP call plus its final answer — **nothing else** (no plan,
no expected SQL, no gap, no earlier journey). The orchestrator classifies, judges and checkpoints. Full
text, and when the main thread may run it instead: `references/07-execution.md` §9.1a.

### Main thread only

| Stage | Why |
|---|---|
| **5–8** coverage, gaps, prioritization, test generation | One test legitimately closes several gaps; an agent that cannot see the other gaps cannot find that overlap, so sharding produces duplicate narrow tests |
| **9** verdicts, ownership, checkpointing | The agent under test generates the SQL in isolation; classifying what it did, and persisting it, stays here |
| **10–12** reconciliation, iteration, reports | Need every result at once |

---

## Stage 12 — three commands, no template editing

```bash
node "<skill>/scripts/build-capability-report.mjs" --dir "<dir>"   # capability mode: the combined report — lead with this (--run <id> builds one stored run only)
node "<skill>/scripts/build-capability-report.mjs" --dir "<dir>" --analysis   # research only (--report): <C>_analysis_report.html, every area researched so far, reads no results
node "<skill>/scripts/merge-checkpoint.mjs" --jsonl "<dir>/<C>_checkpoint.jsonl" --out "<dir>/<C>_checkpoint.json" --plan "<dir>/<C>_plan.json"
node "<skill>/scripts/build-report.mjs"     --dir "<dir>" --template "<skill>/assets/report-template.html"
node "<skill>/scripts/finish-run.mjs"       --dir "<dir>"
```

What `--plan`, `build-report.mjs` and `finish-run.mjs` do, and the tabs of each report:
`references/09-reporting.md` §12.2.

---

## Output discipline

Log one compact line per completed test, never a paragraph.

State what every coverage number is coverage *of*. "83% coverage" carries no information;
"83% of Tier-1 important columns exercised; 4 of 9 relationships untested" is a result someone
can act on.

Keep `NOT_TESTABLE` visible and counted as uncovered. Reaching for `NOT_APPLICABLE` to make a
number look better destroys the one property that makes these reports worth reading.
