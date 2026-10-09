# Stages 10–11 · Coverage Reconciliation and Iteration

**Contents**

- Stage 10 — Coverage Reconciliation
- Stage 10.5 — Post-Execution AI Review
- Stage 11 — removed

Prerequisite: `00-contracts.md` §1 (provenance precedence), §2 (coverage states), §6 (gap status).

---

## Stage 10 — Coverage Reconciliation

### 10.1 Semantic schema feedback loop

Execution teaches the runtime what documentation did not.

```
AI understanding → test → MCP execution → observation contradicts the model
                                        → record semantic update
                                        → recalculate affected coverage
                                        → possibly emit a new gap
```

Each update:
```javascript
{ field:"Case.Status__c",
  old_value:"exists (cdata_metadata)",
  new_value:"driver rejects column",
  source:"execution_observation",
  evidence:"TC-014 — Invalid column name 'Status__c'" }
```

> ### Never silently overwrite higher-precedence metadata
> Precedence is in `00-contracts.md` §1. If execution contradicts `cdata_metadata`, append to
> `semantic_conflicts[]` and raise it as a finding. **A column that metadata declares exists but
> the driver rejects is a connector defect** — report it; do not quietly patch the model and move
> on. Patching it around erases the finding, which is the one thing this runtime must not do.

### 10.2 Credit coverage from results — by script, from observed SQL

```bash
node "<skill>/scripts/credit-coverage.mjs" \
  --checkpoint "$CHECKPOINT_JSONL" --coverage "$COVERAGE_FILE" \
  --gaps "$GAPS_FILE" --knowledge "$KNOWLEDGE_FILE"
```

It parses each TC's `observed.sql`, applies the credit table below, recomputes all seven
dimensions, resolves every gap's `final_status`, derives the connector verdict **by rule**
(`00-contracts.md` §12), fills `funnel.objects_tested`, and writes a compact
`<C>_coverage.stage10-summary.json`. **Read the summary, not the artifacts** — it names what still
needs your judgement.

> **Credit `tc.observed`, never `tc.query_patterns`.**
> The planned fields are what Stage 8 *predicted* the agent would write. The agent never saw
> them — it generated its own SQL from the prompt. Crediting the prediction would mean claiming
> coverage for constructs that were never sent, which turns every percentage in the report into
> a guess. A TC without `observed` earns nothing.

The credit table the script implements:

| TC status | Coverage credit |
|---|---|
| `pass`, `pass_*` | full credit |
| `partial` | partial credit — object `partially_covered`; a pattern the AI had to avoid stays **uncovered** |
| `fail` | **no credit**; item state `failed` |
| `boundary` | credit for the `permission_boundary` behavior only |
| `na` | item `not_applicable` — **removed from the denominator** |
| `nt` | item `not_testable` — stays visible, **never** counted as covered |
| `not_exec`, `ne` | no credit |

> **A failed test proves the opposite of coverage.** Never let a `fail` mark an object "tested".

Recompute all seven dimensions and per-tier objective satisfaction against `$OBJECTIVES`.

### 10.2b Store the results — the capability report and every eval read this

```bash
node "<skill>/scripts/ingest-results.mjs" --dir "<dir>" --run <run id> --model <agent under test>
```

Normalises every journey (`lib/journey.mjs`: steps, error classes and their owners, retries,
recoveries), decides each answer from its check (`lib/checks.mjs`), scores it (`lib/scoring.mjs`),
and writes `<root>/_results/<Connector>/<run id>/`. Unlike the plan and checkpoint, this is never
deleted: it is the run's permanent record and what an eval reuses instead of running a model
again. A run is marked `complete` only when every planned test has a result.

### 10.3 Build the report constants

| Constant | Contents |
|---|---|
| `$SCHEMA_COVERAGE` | table-by-table status with categories |
| `$PERSONAS` | `$CONNECTOR_META.personas` enriched with `group_id`, `tc_count`, `pass_count` |
| `$COVERAGE_MATRIX` | role × process counts — always computed |
| `$EXEC_SUMMARY` | verdict, health 0–100, top issues, not-exec reason, cost note |
| `$FAULT_TABLE` | one row per distinct failure **pattern** (`00-contracts.md` §4) |
| `$DQ_OBSERVATIONS` | data-quality findings, `sev: high｜med｜low` |
| `$INSTR_EVAL` | `getInstructions()` quality — see §10.5 |
| `caps` | capability matrix, level `1` working · `2` limited · `3` unsupported |

Shapes: `09-reporting.md`.

**Health is two numbers and the verdict is a rule** — both come from `credit-coverage.mjs`:

- `pass_health` = `round((pass + pass_* + partial + boundary) / (total − na) × 100)`
- `gap_health` = `round(P1–P3 gaps CLOSED / P1–P3 gaps not NOT_APPLICABLE or NOT_TESTABLE × 100)`
  P3 is inside the denominator on purpose. The scorer cannot reach `STRONG` evidence without a
  customer dump, so on a no-dump connector nearly every genuine gap lands in P3 — excluding it
  hid 70 of Asana's 71 open gaps and reported 57% health on a run that had closed far less.
- `verdict` per `00-contracts.md` §12. You may write a `verdictDetail` sentence and `top_issues`;
  you may **not** override the verdict. If your own read differs, put it in `verdictDetail` — the
  report shows both and says the rule won.

The old `health` was pass rate alone, and a connector with 98% passing tests and one FAILED P1 gap
scored 98. That is the number this rule exists to stop.

**Semantic conflicts and `semantic_updates[]`:** the script does not adjudicate these. Read them
from the summary, apply `00-contracts.md` §1 precedence, and write the resolution into
`$KNOWLEDGE_FILE.semantic_conflicts[]`. Two rounds recording contradictory updates for one field
is itself a finding — never let the later one silently win.

### 10.4 Intent equivalence check — structure first, judgement second

For each intent with ≥2 phrasings, compare what each phrasing's TC **observed**:

1. **Deterministic pre-check** on the parsed structure: same `observed.objects` set, same
   aggregation patterns present/absent (`aggregate_*`, `group_by`), same filter-role set (which
   column roles were filtered). Identical → `semantic_match: true` with `method: "structural"`.
   Different object sets → `false`, `method: "structural"`. No judgement needed either way.
2. **Only the residue goes to you** — same objects, same aggregation, but filters differ in a way
   the structure cannot decide (`[status]='Open'` vs `[status] IN ('Open','Pending')`). Decide
   whether both answer the *business question*; set `method: "adjudicated"` and one sentence of
   reasoning.

**Equivalent** = same target object(s) + same filter semantics + same aggregation. Column order,
aliases, literal formatting and join style are irrelevant.

A mismatch is a real finding: **the same business question produced different answers depending
on how it was phrased.** The pre-check makes most of these decisions auditable rather than
opinions.

### 10.5 Evaluate `getInstructions()`

Score 1–10 on `completeness` (does it cover all objects, required filters, quirks?),
`accuracy` (was what it claimed true at runtime?) and `actionability` (could the AI use it
without trial and error?). Count `prevented` (TCs where an instruction avoided an error) and
`trialerror` (TCs that hit trial and error through missing guidance). One `findings[]` entry per
gap: what it claimed vs. what happened vs. which TCs were affected. Include the raw output.

### 10.6 Gap closure

| Outcome | `final_status` |
|---|---|
| All planned tests passed and the objective is now met | `CLOSED` |
| Some passed, objective still unmet | `PARTIALLY_CLOSED` |
| Tests ran and failed | `FAILED` (carries the fault owner) |
| Capability proven not to apply | `NOT_APPLICABLE` |
| Could not be validated externally | `NOT_TESTABLE` |
| Never tested | `OPEN` |

Update `$GAPS_FILE` and `$COVERAGE_FILE`.

---

## Stage 10.5 — Post-Execution AI Review

**Model: `config.models.post_exec_review` (default: `sonnet`).**
Runs once, after Stage 10 completes.
The reviewer sees execution results independently — it did not run the tests and did not write
the verdicts, so its read is fresh.

Skip only when `config.defaults.skip_post_exec_review` is `true`.

**Before dispatching the reviewer agent**, append to the jsonl checkpoint:
```json
{"type":"stage_start","key":"stage_10_5","started_at":"<ISO timestamp>"}
```
A compaction mid-review would otherwise route the resumed context to Stage 10 (which re-runs
the coverage script) or Stage 12 (skipping review entirely). Without this marker, verdict
corrections and gap reclassifications from the reviewer are permanently lost.

### Review agents — Stages 8.5 and 10.5

Both review stages dispatch a single `general-purpose` subagent with
`model: config.models.tc_review` for Stage 8.5 and `config.models.post_exec_review` for Stage 10.5.
They are separate keys because 8.5 writes the tests the plan is missing while 10.5 narrates results
that already exist — the first earns the stronger model. The orchestrator stays on its own
model — the reviewer's independence from the generating context is the entire point.

`config.defaults.skip_tc_review` / `skip_post_exec_review: true` skip Stage 8.5 / 10.5. Both default to
`false`: skipping removes the independent judgment that catches prompt blind spots and misattributed verdicts.

Record `run_meta.models.tc_review` and `.post_exec_review` from the resolved models so the footer shows which
ran the review alongside which model ran as the agent under test.

### 10.5.1 What the reviewer receives

| Input | Source |
|---|---|
| All TC verdicts + observed SQL + steps | `$CHECKPOINT_FILE` |
| Gap closure status (final_status per gap) | `$GAPS_FILE` |
| Coverage across all 7 dimensions | `$COVERAGE_FILE.stage10-summary.json` |
| Semantic updates recorded during execution | `$KNOWLEDGE_FILE.semantic_updates` |
| Fault table from Stage 10 | checkpoint `{"type":"summary","key":"exec_summary"}` |
| TC Review Summary from Stage 8.5 | checkpoint `{"type":"summary","key":"tc_review_summary"}` |
| Web research findings from Stage 8.5 | same |

### 10.5.2 Review dimensions

**Verdict quality**
- For each `fail` TC: is `owner-ai` / `owner-driver` / `owner-schema` attribution correct?
  A TC that failed because the prompt was too vague is `owner-ai`; one that failed because the
  connector rejected valid SQL is `owner-driver`. Misattribution hides real connector bugs.
- For each `partial` TC: what specifically was not covered — is it a prompt design issue
  (a rewrite for the next run) or a genuine connector limitation (mark NOT_TESTABLE)?

**Gap reclassification**
- `PARTIALLY_CLOSED` gaps: is the missing coverage recoverable (better prompt) or structural
  (connector cannot support it)? Structural → reclassify `NOT_TESTABLE`; recoverable → flag
  it for the next run with a prompt rewrite suggestion.
- `OPEN` gaps that were not executed (status `ne`): why were they skipped? If a fatal error
  caused cascade, they are still `genuinely_untested`; if they were structurally excluded by
  Stage 8.5, confirm `NOT_TESTABLE` status is correct.

**Failure pattern analysis**
- Are failures clustered by object? (Multiple TCs on SubTasks all failing → connector object
  defect, not AI weakness.)
- Are failures clustered by SQL pattern? (All JOIN TCs failing → driver JOIN limitation.)
- Are failures clustered by execution position? (TCs 30–39 all `ne` → fatal cascade mid-run.)
- Each cluster is one `fault_pattern` finding, not one finding per TC.

**Guidance for the next run** (there are no rounds inside this one)
- Which remaining open gaps are recoverable, with which rewritten prompts?
- Which are `NOT_TESTABLE`, and what do they represent?

**Connector health signal**
- Summarise: what does this connector do well (consistent pass rate, good schema discovery)?
  What is genuinely broken (timeout on specific objects, unsupported SQL constructs)?
- This is the `verdictDetail` the report shows alongside the rule-derived verdict.

### 10.5.3 Output

The reviewer agent returns:

```javascript
{
  "verdict_corrections": [
    {"tc_id":"TC-004", "original_owner":"owner-ai", "corrected_owner":"owner-driver",
     "reason":"JOIN timeout is a connector limitation, not an AI SQL error — SQL was valid"}
  ],
  "gap_reclassifications": [
    {"gap_id":"GAP-095", "from":"PARTIALLY_CLOSED", "to":"NOT_TESTABLE",
     "reason":"SubTasks REL-010 JOIN always times out — structural driver limitation, not recoverable"}
  ],
  "fault_patterns": [
    {"pattern":"SubTasks JOIN timeout", "tc_ids":["TC-003","TC-004"],
     "owner":"owner-driver", "detail":"Any JOIN involving SubTasks causes connector timeout; must use separate queries"},
    {"pattern":"Goals HTTP 403", "tc_ids":["TC-036"],
     "owner":"owner-driver", "detail":"Goals requires Asana Business+ subscription — not available on this account"}
  ],
  "round2_needed": false,
  "round2_reason": "All remaining open gaps are NOT_TESTABLE (Goals subscription, SubTasks JOIN limitation). No recoverable failures.",
  "prompt_rewrites": [],
  "connector_health": {
    "strengths": ["Reliable schema discovery via getTables/getColumns", "Strong SELECT + filter support", "Stored procedures execute correctly"],
    "weaknesses": ["SubTasks JOIN always times out", "Goals requires Business+ subscription", "Server-side WHERE filter on SubTasks causes timeout"],
    "verdict_detail": "Core task/project analytics work reliably. Two structural limitations (SubTasks JOIN, Goals subscription) are connector constraints, not AI failures."
  },
  "web_research": true,
  "additional_findings": [
    {"source":"community.asana.com", "finding":"Rate limits on Tasks endpoint at >200 requests/min — not triggered in this run but relevant for production scale"}
  ]
}
```

The orchestrator:
1. Applies `verdict_corrections` — updates `owner` fields in `$CHECKPOINT_FILE`.
2. Applies `gap_reclassifications` — updates `final_status` in `$GAPS_FILE`.
3. Appends `POST_EXEC_REVIEW` to the jsonl checkpoint as
   `{"type":"summary","key":"post_exec_review","value":{...}}` for Stage 12 to read.
4. Records `prompt_rewrites` as guidance for the NEXT run — generation is single-pass, so nothing
   is re-run in this one. Take the reviewer's rewrites as they are; do not re-derive them.
5. **Persists `additional_findings[]` and `connector_health` to `$KNOWLEDGE_FILE`** — merges
   into `knowledge.web_research_findings[]` (with `stage: "10.5"` and `run_id`) and updates
   `knowledge.connector_health` so future `--rerun` passes these to Stage 8.5 as prior context.
   Also writes `connector_health.strengths/weaknesses` into `knowledge.semantic_updates[]` as
   observations with `source: "execution_observation"` so they survive across runs.

Log one line:
```
✓ Stage 10.5 complete — 2 verdicts corrected · 3 gaps reclassified NOT_TESTABLE
```

---

## Stage 11 — removed

There is no Stage 11. Generation is single-pass and surface-driven: Stage 8 enumerates the whole
connector surface in one go, so there is nothing to converge toward and no second round to plan.

The section that stood here told the model to **return to Stage 7 and append to the same
`$PLAN_FILE`**. That is the instruction that broke run asn004. Each round renumbered test cases from
TC-001 while `gap.planned_tests` appended the previous round's ids, so 525 of 697 links pointed at
tests that no longer existed. Gaps were then credited from phantom tests, which marked capabilities
covered, which made the next generation skip them — and a read-only assessment of a read-write
connector shipped as 96% healthy.

**What happens instead.** Gaps still open after Stage 10 are reported as guidance for the *next
run*, never re-tested inside this one:

- `new_gaps_observed[]` and `prompt_rewrites` are recorded and surfaced in the gap report.
- The next invocation starts at Stage 1 and rediscovers, because the connector may have changed.
- `--rerun` skips rediscovery when the operator asserts it has not.

See `config.json` `$rounds_comment` and `SKILL.md` §0.1.
