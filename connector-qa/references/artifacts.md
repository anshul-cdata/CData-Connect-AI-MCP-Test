# On-Disk Artifacts

**Contents**

- 1. `{connector}_knowledge.json`
- 2. `{connector}_coverage.json`
- 3. `{connector}_gaps.json`
- 4. `{connector}_plan.json`
- 5. `{connector}_checkpoint.jsonl` → `{connector}_checkpoint.json`
- 6. `{connector}_dynamic_test_report.html`

Six files under `$ROOT\$CONNECTOR\`. Names come from `config.artifacts`. Every stage is resumable
because each of these is written before the stage that produced it ends.

| # | Variable | Written by | Read by | After Stage 12 |
|---|---|---|---|---|
| 1 | `$KNOWLEDGE_FILE` | 1–4, 10 | 5, 6, 12 | kept, marked `run_state: complete`; archived |
| 2 | `$COVERAGE_FILE` | 5, 10 | 6, 7, 11, 12 | kept; archived |
| 3 | `$GAPS_FILE` | 6, 7, 11 | 8, 10, 12 | kept; archived |
| 4 | `$PLAN_FILE` | 8 | 9 | kept (`config.retain_after_report`); archived |
| 5 | `$CHECKPOINT_JSONL` | 9 *(one line per test)* | 10, 12 | deleted; archived |
| 5b | `$CHECKPOINT_FILE` | 12 *(merged from jsonl)* | 12 | deleted; archived |
| 6 | `$REPORT_FILE`, `$GAP_REPORT_FILE` | 12 | — | the deliverables; archived |
| — | `runs/<run_id>/` | 12 | next run's `--incremental` *(future)* | permanent history |

**Every artifact carries `schema_version`** (`00-contracts.md` §11). `scripts/lib/artifacts.mjs`
refuses to read a file whose major version differs from the skill's, so an old artifact can never
misroute a new skill silently.

**`run_state: complete`** on `knowledge.json` is what makes a finished run finished: the router
sends the next invocation to Stage 1. Kept files are for people, not for the router.

---

## 1. `{connector}_knowledge.json`

```javascript
{
  schema_version: "2.0.0",
  connector: "NetSuite", generated_at: "<ISO>",
  run_state: "in_progress",         // → "complete" at Stage 12 (finish-run.mjs)
  semantic_complete: true,          // Stage 5 resumes on this flag
  stage_progress: null,             // {stage, done, total} while a stage is mid-way

  run_meta: {                       // schemas/run-meta.schema.json
    run_id: "run_20260925T1430_a1b2", skill_version: "2.0.0",
    started_at: "<ISO>", finished_at: null,
    models: { orchestrator: "<resolved id>", under_test: "<resolved id>", research: "…", semantic: "…" },
    mcp_server: "<from getStarted() if reported>", driver_version: "<if reported>",
    metadata_snapshot_at: "<ISO of the getTables() call>",
    catalog: "<Connect AI catalog name, getCatalogs()>", schema: "<getSchemas()>",
    workspace: {id, name, source}, workspace_catalog: [{id, name, is_organization}],
    me: "<the connection's own user id>"           // 01-discovery.md §1.0a
  },

  connector_meta: { /* 01-discovery.md §2.4 */ },
  instructions_raw: "<verbatim getInstructions() output>",

  source_overview: "…", capabilities: [...], limitations: [...],

  physical: {
    catalogs: [...], schemas: [...],
    tables:     [{name, type:"TABLE"}],
    views:      [{name, type:"VIEW"}],
    procedures: [ /* $SP_REGISTRY — 01-discovery.md §1.3 */ ]
  },

  objects:       [ /* 02-semantic-schema.md §3.2, each with columns[] from §3.3,
                      plus tier / tier_score / tier_signals[] added in Stage 5 */ ],
  relationships: [ /* 02-semantic-schema.md §3.4 */ ],
  data_range:    { /* 02-semantic-schema.md §3.5 — enrichment only */ },

  customer_evidence: { /* §1.4 below, or {available:false} */ },

  semantic_updates:   [ /* 08-reconcile.md §10.1 */ ],
  semantic_conflicts: [ { field, higher, lower, resolution } ]
}
```

### 1.4 `customer_evidence` — written by `scripts/mine-dump.mjs`

```javascript
{
  available: true, query_count: 10690, file_count: 1,
  connector_match: "Salesforce.Salesforce",
  object_frequency:  { Case:4565, Account:1661 },
  column_frequency:  { Status:3100, CreatedDate:2870 },
  join_pairs:        [{from:"Case", to:"Account", on:"AccountId = Id", count:412, covered:false}],
  pattern_frequency: { where:0.98, order_by:0.64, join:0.27, date_function:0.00 },
  error_clusters:    [{pattern:"Invalid column name 'X' for table 'X'", count:152,
                       likely_owner:"owner-schema", reproduced:false, tc_ids:[]}],
  zero_row_rate: 0.20, slow_query_rate: 0.103,
  unusual_queries: [ /* 3–8 genuinely complex real queries worth reproducing */ ],
  reconciliation: [ {finding, action} ]      // filled by you, 03-customer-evidence.md §4.5
}
```

The script fills everything except `reconciliation`, `covered` and `reproduced`/`tc_ids` —
those are yours to complete in Stages 4.5 and 10.

---

## 2. `{connector}_coverage.json`

```javascript
{
  schema_version: "2.0.0",
  connector: "…", updated_at: "<ISO>", round: 1,
  objectives: { /* 04-coverage-model.md §5.2 */ },
  ...$COVERAGE,     // the seven dimensions, 04-coverage-model.md §5.3

  funnel: {         // written by compute-gaps.mjs, objects_tested by credit-coverage.mjs
    vendor_domains: 7, vendor_workflows: 31, vendor_standard_reports: 14,
    domains_without_connector_object: 1,          // = EXPOSURE gaps
    connector_objects: 44, tables: 38, views: 6, procedures: 1,
    meaning_fact: 26, meaning_inference: 15, meaning_unknown: 3,
    tier_counts: { T1: 6, T2: 9, T3: 21, T4: 8 }, objects_t1_t2: 15,
    objects_tested: 14, objects_failed: 1,
    assessment_confidence: 76               // (FACT + ½·INFERENCE) / objects, as a %
  }
}
```

The funnel is what lets a report say what each percentage is a percentage *of*. Its first row
(vendor domains) is the only view the framework has of what the source system does beyond what
the connector exposes.

---

## 3. `{connector}_gaps.json`

```javascript
{
  connector: "…", generated_at: "<ISO>",
  prioritized: true,               // Stage 8 resumes on this flag
  rounds_done: 0,
  gaps: [ /* 05-gap-analysis.md §6.2 */ ]
}
```

> The `gaps` array is the **pre-execution set**. Never remove an entry — resolve it via
> `final_status`.

---

## 4. `{connector}_plan.json`

```javascript
{
  connector: "…", generated_at: "<ISO>",
  has_customer_evidence: true,
  tc_list: [ /* 06-test-generation.md §8.1 — all with status:"ne" */ ],
  stage9_status: "not_started",
  tcs_completed: []
}
```

There are no rounds: Stage 8 writes the whole plan in one pass.

---

## 5. `{connector}_checkpoint.jsonl` → `{connector}_checkpoint.json`

**During Stage 9 the checkpoint is append-only jsonl**, one line per event
(`07-execution.md` §9.5):

```
{"type":"meta","connector":"…","round":1,"rounds_done":0,"run_meta":{…}}
{"type":"tc","tc":{ …complete TC object… }}
{"type":"tc","tc":{ … }}
{"type":"summary","key":"fault_table","value":[…]}        ← Stage 10, one per constant
{"type":"semantic_update","value":{…}}
{"type":"new_gap","value":{…}}
```

A later `tc` line for the same id supersedes the earlier one. `merge-checkpoint.mjs` folds the
file into the shape below at Stage 12. Never edit the jsonl by hand.

**The merged `checkpoint.json`:**

```javascript
{
  schema_version: "2.0.0",
  connector: "…", saved_at: "<ISO>", run_meta: {…},
  round: 1, rounds_done: 0,
  tcs_completed: ["TC-001","TC-002"],

  groups: [{ id:"grp-a", title:"A — Case Triage", desc:"…",
             tcs:[ /* the COMPLETE TC object from the plan, plus execution results */ ] }],

  gap_closure:       { "GAP-014":"CLOSED", "GAP-021":"FAILED" },
  new_gaps_observed: [],
  semantic_updates:  [],

  // filled at Stage 10, null until then
  exec_summary:null, fault_table:null, dq_observations:null, instr_eval:null,
  caps:null, schema_coverage:null, personas:null, coverage_matrix:null,
  coverage:null, gaps:null
}
```

`groups` is what Stage 12 feeds directly into the report's `GROUPS` constant, so copy the whole
TC object across from the plan rather than a subset. Two fields groups of fields matter:

| Fields | Dropping them costs you |
|---|---|
| `steps[]`, `status`, `time`, `est_in`, `est_out`, `tool_calls` | the AI journey column and the entire cost tab |
| `observed` | **all coverage crediting** - Stage 10 reads this, not the planned `query_patterns` |
| `roles[]`, `target_objects[]`, `group_type`, `process_group`, `gap_ids[]` | the Role, Object, Persona and Gap-Category lenses on Test Results |

The second row is the one that gets dropped, because the report still renders without it. The
template defends itself here: any lens whose field is missing from every TC is struck through,
disabled with a tooltip, and listed in red under the Group-by bar — so a missing field shows up
as "unavailable" rather than as the false claim that every test shares one role. Do not rely on
that; it reports the damage, it does not repair it. Copy the whole TC object across.

---

## 6. `{connector}_dynamic_test_report.html`

`assets/report-template.html` with its constant block replaced. See `09-reporting.md`.



