# connector-qa

Autonomous coverage-driven QA for **one CData connector at a time**, through Claude Code and the
CData Connect AI MCP server.

It discovers the connector, builds a semantic schema, optionally mines your real customer query
dumps, computes what coverage *should* look like, finds the gaps **before running a single test**,
writes only the tests that close those gaps, executes them, and reports.

---

## Install

**Prerequisites**

| | |
|---|---|
| Claude Code | 2.1+ (desktop app or CLI) |
| CData Connect AI MCP server | connected in your Claude Code session |
| Node.js 20+ | **required** — gap arithmetic, coverage crediting and report building are Node scripts. No `npm install` needed: they use only the standard library |

If you were sent `connector-qa-<version>.zip`, unzip it into the folder that should hold your
reports — e.g. `ConnectAIMCPTest\` gives you `ConnectAIMCPTest\connector-qa\`.

**One command, from inside the `connector-qa` folder:**

```powershell
.\install.ps1          # Windows — Windows PowerShell 5.1 or PowerShell 7+
```
```bash
bash install.sh        # macOS / Linux
```

That checks for Node 20+, copies the runtime part of the skill to `~/.claude/skills/connector-qa/`
and points output at this folder's parent. It ends with **Ready.** or, if any check failed,
**NOT ready** and exit code 1. Then start a **new** Claude Code session.

If PowerShell refuses to run the script (execution policy), run it once with:
`powershell -ExecutionPolicy Bypass -File .\install.ps1`

Choose a different output location:

```powershell
.\install.ps1 -Root "D:\QA\ConnectAIMCPTest"
```

Other flags: `-Link` installs as a junction so your edits here take effect with no re-run
(skip it if this folder lives in OneDrive with Files On-Demand). `-Uninstall` removes the
installed skill and leaves your output untouched.

---

## Run

```
/connector-qa NetSuite
```

That is the whole interface. There is no depth or mode flag, on purpose: coverage is decided by
the gap model, so a flag could only relabel report groups while implying a trade-off that does
not exist. Grouping is a control inside the report instead, which gives you every view rather
than one chosen before the run.

| Argument | Meaning | Default |
|---|---|---|
| `<ConnectorName>` | the connector to test — `NetSuite`, `Salesforce`, `GitHub`, … | required |
| `--dump <path>` | a specific query dump (CSV file or folder) | auto-discovered |
| `--fresh` | ignore whatever is on disk for this connector and start again at Stage 1 | off |
| `--rerun` | keep the discovered knowledge and the gap ledger, regenerate the tests and execute them again. Checks the connector is reachable first | off |
| `--resume` | reopen a *finished* run's artifacts rather than starting over — for re-reporting | off |
| `--areas <a,b>` | capability mode: research these business areas (e.g. `--areas sales,finance`) up to their freeze. Later runs add more areas; nothing already done is redone | ask |
| `--all` | capability mode: research every business area, in focused batches | ask |
| `--no-compare-mcp` | capability mode: skip the comparison with the source vendor's own MCP server for this run. By default, when the vendor runs one, every capability report shows what both servers can do, what only CData can do, what only the vendor's server can do, and what neither can (`config.capabilities.compare_vendor_mcp`) | on |
| `--api-docs <url>` | capability mode: the vendor's API documentation page, where Stage 1.5 starts looking when the vendor publishes no OpenAPI description it can find by search. The list is then read from a Postman collection, an SDK or the reference pages themselves, and the reports say so | search |
| `--report` | capability mode: when research stops (no `--execute`), also build an analysis report — capabilities, gaps, test account readiness and what each use case is expected to meet. Nothing is run; it never replaces the capability report | off |
| `--execute` | then plan, run and report the scope — only use cases without a valid stored result are run | off |
| `--eval [models]` | then compare models on the scope, e.g. `--eval opus,sonnet,haiku` — stored results are reused per use case. Implies `--execute` | off |
| `--models <a,b,c>` | the models for `--eval` | `config.eval.default_models` |
| `--continue` | an area in scope that already has work is continued, without asking | ask |
| `--redo [a,b]` | an area in scope that already has work is done again | ask |
| `--maxrounds N` | accepted and ignored. Generation is single-pass: Stage 8 enumerates the whole connector surface in one go, so there is nothing to iterate toward | — |

**Which model to run the session on (3.9).** At the start of a run the skill reads the session's model
and suggests one from what it knows about the connector — it warns once, never blocks:

| The connector | Suggested |
|---|---|
| a SaaS source with a machine-readable API description (OpenAPI, OData, …), or a database, files or a generic interface | Sonnet |
| a SaaS source whose API list is assembled from its web docs | Sonnet (Opus when many connector tables have no documented operation to sort out) |
| a large platform (ERP, CRM: more than 400 tables, 500 capabilities or 12 business areas) | Opus |
| more than 4 business areas researched in one session | Opus |

The thresholds are in `config.models.orchestrator_advice`; `required_orchestrator` stays the hard gate.
The report's run details show the model used and the one suggested.

**If a run is interrupted, run the same command again.** It reads the folder, works out which
stage completed, and resumes. Nothing is lost — execution checkpoints after every single test.

---

## What you get

```
<root>/
  _querydumps/                          drop customer query CSVs here (optional)
  NetSuite/
    NetSuite_dynamic_test_report.html   ← the QA report
    NetSuite_gap_analysis_report.html   ← what was missing, and why
    NetSuite_knowledge.json             semantic schema + provenance     (kept)
    NetSuite_coverage.json              seven coverage dimensions        (kept)
    NetSuite_gaps.json                  every gap and its outcome        (kept)
    NetSuite_plan.json                  the test plan                    (kept)
    NetSuite_capability_report.html     ← can you do through CData what NetSuite can do?
    NetSuite_capabilities.json          what NetSuite's API can do, mapped to the connector (kept)
    NetSuite_catalog.json               the approved, frozen use case catalog            (kept)
  _results/NetSuite/<run>/              every journey, check and score — never deleted; evals reuse it
```

**Two reports, for two audiences.**

The **test report** is the operational one: Test Results, Failure Analysis, Instructions
Evaluation, Schema Coverage, Coverage Model, Token & Cost. Test Results regroups on demand by
Business Process, Role, Persona, Object, Gap Category or Suite — same tests, six views. Each
test is labelled a business scenario (with its realism score) or a conformance check.

The **gap analysis report** is the planning one: the gaps that existed *before* any test ran,
the semantic schema with provenance on every claim, and Customer Reality when a dump was found.
It answers why the test plan looks the way it does.

The JSON files are kept on purpose: they are that connector's accumulated intelligence, and the
next run starts cheaper and sharper for having them. Only the checkpoint is deleted once the
report is written (`config.retain_after_report` / `delete_after_report`).

---

## Writes

A connector that advertises INSERT or UPDATE gets write tests planned. Connectors are tested on
test accounts, so since 3.7 write safety is **off by default**: writes run, including records the
connector cannot delete, and every run starts by asking once whether the workspace is a test
account (`write-policy.mjs`). Answer "read only" — or set `defaults.write_policy.safe_mode: true`
— to hold irreversible writes. Records a run creates are listed in the capability report. If you want writes confined to one workspace, set its
id in `defaults.write_policy.workspace` (it is handed to the agent as operating context) and,
for the strict gate, `require_workspace_pin: true`: `preflight-writes.mjs` then refuses any
mutating plan whose pin discovery did not actually see, or that names an organization workspace.

---

## Capability mode — "can I do through CData what the source can do?" (3.0)

When the source publishes an API description, a run measures the connector against the source
itself, not against its own table list:

1. **Capability list** (Stage 1.5) — a script reads the source's OpenAPI description and maps every
   operation onto the connector's tables, writes and procedures. A vendor without one is read down a
   ladder: another machine-readable form (OData, WSDL, RAML, GraphQL, a Postman collection), an SDK, or
   the API reference pages themselves — read with a real browser when the site is a JavaScript app,
   every operation checked word for word against its page, and the reports say the list was assembled. A model reviews the uncertain
   ones and groups them into business areas. Anything in the API the connector does not offer is a
   gap before a single test runs.
2. **Use case catalog** (Stage 5.5) — real use cases from real evidence (the vendor's own use case and
   how-to pages, help articles, templates, standard reports, community questions, integration templates;
   of two near-duplicates the better-evidenced one is kept; every report can sort and filter by evidence), each with a persona, a goal, the
   capabilities it needs, the user's own wording, and a check that decides whether an answer was
   right. Judged for realism, then **frozen** — every later run and every eval uses the same version.
   A person's rating sample is **off by default** (3.9): set `config.catalog.human_review` to `true` to
   require one before an area is frozen. While it is off, the run never pauses for the rating sheet and
   the reports say "Not reviewed — human review is off" where the human-agreement figure would be.
3. **Execution** — every use case is carried out by a fresh AI agent; the full journey (every call,
   query, error, retry and result) is kept, the answer is checked against an independent query,
   and each journey gets a 0–100 score and a blue / yellow / red grade.
4. **Capability report** — the answer first (capabilities supported, use cases that worked), then
   use cases with their full journeys, gaps and whose they are, each business area in detail, AI
   friction, a ranked fix list, personas, driver checks, use case quality and run details.

**Evals** (`--eval opus,sonnet,haiku`) run the same frozen use cases with different models as the
agent under test — everything else fixed — reusing any stored result that still applies, and
produce a separate eval report plus a full capability report per model.

### Area by area (3.1)

Researching every business area of a large connector in one go spreads one researcher too thin,
which is where invented use cases and missed scenarios come from. So research is scoped:

```
/connector-qa Asana                                    shows the areas and personas, asks: everything or which
/connector-qa Asana --areas tasks,projects             researches those two, up to their freeze
/connector-qa Asana --areas goals --execute            adds Goals; runs only what has no result yet
/connector-qa Asana --all --execute --eval             everything, run, and compared on the default models
```

- Discovery and the capability list always cover the whole connector; only research is split.
  Each researcher gets at most 3 areas or 60 capabilities (`config.scope`).
- An area is frozen only when it is **complete**: every capability the vendor's API offers in that
  area is used by a use case or explained, every persona has one, every cited page was opened and
  checked, and — when `config.catalog.human_review` is on — a person has sampled it. Related areas get a cross-area pass for flows between them.
- Work adds up. Each area is frozen on its own; each stored result is reused while its use case
  and the connector build are unchanged; the capability report combines every run and says how
  much of the connector it covers ("2 of 9 areas researched"). Existing work is never redone
  without asking — `--continue` and `--redo` answer in advance.
- `node scripts/scope.mjs status --dir <folder>` prints where every area stands.

## Business scenarios and conformance checks

Every test is one of two kinds, and the report labels which:

- **Business scenario** — a persona with a goal, in their own words: *"Which of my tasks are
  overdue?"*. These come from the persona research (everyday questions first), use cases,
  workflows and objects' business questions. The generator drafts them; Stage 8.5 rewrites each
  in the persona's words; Stage 8.6 has an independent judge score each 1–5 for realism, and a
  score below `realism.min_score` blocks execution.
- **Conformance check** — a join, SQL pattern, procedure or write check that business scenarios
  did not already exercise. Still run, never presented as a use case.

Test mechanics ("read it back", "restore it", workspace ids) never appear in a prompt: they live
in `expected_behavior` (what is checked) and `agent_context` (the operating note the agent gets
beside the question). Group the report by **Suite** to see the two side by side.

---

## Customer query dumps (optional)

Entirely optional — with no dump, documentation and schema alone still produce a full coverage
model, gap analysis and test plan. The workflow never degrades.

When you do have them, they are the most valuable input available, because they show what people
actually query rather than what anyone assumes. Drop CSVs into `<root>/_querydumps/`.

Expected columns — only `Query` is required:

```
Query, UserAgent, ErrorMessage, Duration, TimeToFirstRow, RowsReturned
```

One combined dump covering many connectors is fine. Rows are matched to the connector by the
catalog in the query text, **row by row**, never by filename.

Evidence is used to *challenge* the model, not decorate the report: it re-tiers objects by real
usage, decides which SQL patterns are worth testing, and turns recurring production errors into
test cases. Dumps are read locally and never sent anywhere.

---

## How it is organised

Standard Claude Code skill layout — `SKILL.md` plus the three bundled-resource directories
Anthropic's own skills use, so anyone who has seen one skill can navigate this one.

```
connector-qa/
  SKILL.md         orchestrator — routing only, always loaded            ┐
  config.json      the only file you configure (version 3.7.1)           │
  LICENSE.txt                                                            │ installed
  references/      one file per stage, read on demand                    │ runtime
  agents/          six agent briefs: research, use cases, catalog review │
  assets/          report-template.html — filled by build-report.mjs     │
  schemas/         JSON Schema for gaps, test cases and run metadata     │
  scripts/         the deterministic half of the runtime — see below     ┘
  README.md · CHANGELOG.md · package.json · install.ps1 · install.sh
  tests/           node --test suite proving the pipeline end to end (npm test)
  evals/           prompts + assertions for skill-creator
  tools/           package.mjs — builds the shareable zip (npm run package)
  *.docx           Setup Guide, Installation Reference, Framework design document
```

**Arithmetic is code; judgement is the model's.** Anything that is a loop, a sum, a join or a
copy runs as a script — routing (`detect-stage`), tiering (`tier-objects`), gap arithmetic
(`compute-gaps`, `score-gaps`), test generation and review (`generate-tests`, `review-prep`,
`review-merge`), realism (`realism-check`), write safety (`preflight-writes`), crediting (`credit-coverage`, `parse-sql`),
reporting (`merge-checkpoint`, `build-report`, `finish-run`), dump mining (`mine-dump`) and
validation (`validate-agent-output`, `validate-model`, `validate-report`, `check-skill`). The
model writes meanings, importance, prompts and fault narrative. That split is why a 500-object
connector fits and why two runs give the same numbers for the same inputs.

Only `SKILL.md` and `config.json` load at the start of a run; references are read as each stage
is reached. Only the runtime marked above is copied into the installed skill; everything else is
for the people who maintain it.

**Every report now opens with a discovery funnel** — vendor business areas → what the connector
exposes → what the model understood → what it tiered important → what was tested — so every
percentage says what it is a percentage *of*. It closes with a *"What this run did not assess"*
panel and a footer naming the run id, models, MCP server and skill version that produced it.

**A finished run is finished.** Re-running the same connector starts at discovery again, against
the connector as it is now; the previous run is archived under `<Connector>/runs/`.

**To modify behaviour:** edit the relevant `references/*.md`, then re-run `.\install.ps1`.
`references/00-contracts.md` holds the shared vocabulary — verdicts, fault owners, coverage
states, tiers — used by every stage.

---

## Sharing this folder

Don't zip the folder by hand — it holds `node_modules`, report previews and archived drafts.
Run:

```bash
npm run package
```

That runs `check-skill` and the full test suite, refuses to continue if `config.json` carries a
machine path, a pinned workspace or irreversible writes switched on, and writes
`dist/connector-qa-<version>.zip` with only what a recipient needs. Nothing in it contains a
username or a machine-specific path: `config.root` is empty and is filled in per machine by the
installer.

If you also want to share results, include the `<Connector>/` folders — both HTML reports are
self-contained and open in any browser.

One caution when the run used a customer query dump: the gap analysis report embeds aggregate
figures derived from it — object frequencies, SQL pattern rates, normalized error clusters.
Read it before sending it outside the team.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/connector-qa` not recognised | Start a **new** Claude Code session — skills load at session start |
| Installer says `node not found` or `too old` | Install Node 20 LTS or newer, open a new terminal, re-run the installer |
| Installer ends with **NOT ready** | Read the `[fail]` lines above it; `check-skill` names the exact problem |
| Everything lands in `Documents\ConnectAIMCPTest` | Root resolution fell through to the fallback. Re-run `.\install.ps1 -Root "<your path>"` |
| Dump ignored | Check the CSV has a `Query` column, and that its catalog matches the connector under test |
| Report panels blank | Run `node scripts\validate-report.mjs "<report.html>"` — it names any constant left unfilled |
| Run stopped early | Run the same command again; it resumes from the last checkpoint |

