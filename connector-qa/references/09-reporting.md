# Stage 12 · Reports

## Contents

| | Section |
|---|---|
| 12.1 | Assemble from disk, not memory |
| 12.2 | Two reports from one template |
| 12.3 | Constant → source map |
| 12.4 | Clean up |
| 12.5 | Summarize to the user |
| 12.6 | Constant shapes — one `###` heading per constant, in template order |

Jump straight to 12.6 when filling a specific constant; those shapes are authoritative.

---

## 12.1 Assemble from disk, not memory

Read, in this order:

| File | Provides |
|---|---|
| `$CHECKPOINT_FILE` | authoritative `groups` — exact steps, token counts, error strings |
| `$GAPS_FILE` | the pre-execution gap set with final statuses |
| `$COVERAGE_FILE` | all seven dimensions |
| `$KNOWLEDGE_FILE` | semantic schema, provenance, conflicts, customer evidence |
| `$PLAN_FILE` | anything still missing |

Use in-context values only for fields still `null` on disk.

```
Stage 12 source: checkpoint (N TCs) + gaps (M) + coverage + knowledge
```

---

## 12.1b The capability report (3.0) — the answer to "can I do it through CData?"

```bash
node "<skill>/scripts/build-capability-report.mjs" --dir "<dir>"            # combined (3.1)
node "<skill>/scripts/build-capability-report.mjs" --dir "<dir>" --run <id>  # one run only
```

By default the report is **combined**: for every use case, the newest valid stored result for the
agent under test, whichever run produced it. Areas researched and run weeks apart add up to one
report. The header says how many business areas are researched; a "Partial coverage" banner names
what is not yet covered; the Run details tab lists the runs combined and the coverage by area
(`13-scope.md`). `--areas` limits it to some areas. Builds `<Connector>_capability_report.html`
from the results store, the capability list and the catalog alone (`assets/capability-report-template.html`). Tabs: Summary · Use cases (each with its
full AI journey, check, attempts and history) · Gaps · Business areas (each opens to its own
report) · AI friction · Fix list · Personas · Driver checks · Use case quality · Run details. A run
whose agent is not `config.models.under_test` gets `_<model>` in the file name: only the
customers' model gives the official answer. This is the report to lead with; the two below remain
the detailed test and gap-analysis records.

**Evidence and provenance (3.9).** Every use case card — in this report, the analysis report and the
eval's grid — shows its evidence level as a pill (customer queries · real users · vendor guidance ·
documentation · inferred) and links the page it cites. Each use case list has a **Sort** control
(*As listed* — the report's own order, the default, so a report reads as it always did — *Evidence,
strongest first*, *Business area*, *ID*) and an **evidence filter**; the summary counts the use cases
per evidence level. When the capability list was not read from a published API description
(`capabilities.json` `source.kind` is `postman`, `sdk` or `reference_docs`), the summary and Run details
say "API list assembled from N reference pages" and every capability links the page it was read from
(`10-capabilities.md` §1.5a). A list read from a spec shows neither.

## 12.2 Two reports from one template — built by script

```bash
node "<skill>/scripts/merge-checkpoint.mjs" --jsonl "$CHECKPOINT_JSONL" --out "$CHECKPOINT_FILE" --plan "$PLAN_FILE"
node "<skill>/scripts/build-report.mjs" --dir "$ROOT/$CONNECTOR" --template "<skill>/assets/report-template.html"
```

Pass `--plan`. Stage 9 writes each `tc` line from what the agent did, and under context pressure
that line carries only `id`/`status`/`observed`/`steps` — no prompt, no use case, no group. The
merge backfills those from the plan (never overwriting an observed field), which is the difference
between a results table a reader can follow and one whose Prompt column says "no prompt recorded".

`build-report.mjs` reads every artifact, constructs every constant in 12.6, injects them into the
template's constant block, writes both files, and runs `validate-report.mjs` on each. **You do not
copy the template, do not edit it, and do not re-emit JSON you already wrote.** Before this script
the model pushed megabytes of checkpoint JSON through context to fill `GROUPS`; the only thing that
bought was transcription risk.

The Stage 10 constants the model owns — `exec_summary.verdictDetail`/`top_issues`, `fault_table`,
`dq_observations`, `instr_eval`, `caps`, `schema_coverage`, `personas`, `coverage_matrix` — are
appended to the jsonl checkpoint as `{"type":"summary","key":...}` lines **before** you run the
merge. The verdict itself comes from `credit-coverage.mjs`; if your `exec_summary.verdict`
disagrees, the report shows the rule's verdict and notes yours.

`assets/report-template.html` renders both outputs. A `REPORT_KIND` constant selects the tab set,
so the two share every renderer and cannot drift apart as the template evolves. Both open with
the **discovery funnel** and end with a **"What this run did not assess"** panel and a run-metadata
footer.

| Output | `REPORT_KIND` | Tabs |
|---|---|---|
| `$REPORT_FILE` | `"test"` | Test Results · Failure Analysis · **AI Review** · Instructions Evaluation · Schema Coverage · Coverage Model · Token & Cost |
| `$GAP_REPORT_FILE` | `"gap"` | Gap Analysis · **TC Quality Review** · Semantic Schema · Customer Reality *(only when evidence exists)* · Coverage Model |

**AI Review tab** (test report) — sourced from `POST_EXEC_REVIEW`:
Shows fault pattern clusters, verdict corrections applied, gap reclassifications, Round 2
decision with reasoning, and connector health summary (strengths / weaknesses). Also surfaces
any additional web research findings from Stage 10.5.

**TC Quality Review tab** (gap report) — sourced from `TC_REVIEW_SUMMARY`:
Shows what Stage 8.5 changed before execution: prompts rewritten, TCs added, duplicates merged,
risk flags set, gaps reclassified NOT_TESTABLE pre-execution, and web research findings that
drove those changes. Gives readers confidence that the TC list was independently validated before
a single agent ran.

Coverage Model appears in both deliberately: it is the bridge between them, and it lets either
file stand alone when someone is sent only one.

`build-report.mjs` fills every constant of both files from the artifacts; nothing is copied or
filled by hand, and the model never pastes the template through context.

### The Stage 12 commands, explained

`--plan` is not optional in practice: a `tc` line written under context pressure carries only
`id`/`status`/`observed`/`steps`; the merge backfills the prompt, use case and group from the plan
(never overwriting an observed field), or the report loses the columns a reader actually reads.

`build-report.mjs` reads the artifacts, fills every constant, writes both HTML files
(`REPORT_KIND` `"test"` and `"gap"` from one template), and runs `validate-report.mjs` on each.
The model never touches the template and never re-emits JSON it has already written.

| Output | Tabs |
|---|---|
| `$REPORT_FILE` | Test Results · Failure Analysis · Instructions Evaluation · Schema Coverage · Coverage Model · Token & Cost |
| `$GAP_REPORT_FILE` | Gap Analysis · Semantic Schema · Customer Reality · Coverage Model |

Both open with the **discovery funnel** and close with a **"what this run did not assess"** panel
and a run-metadata footer, so a reader sees what every percentage is a percentage of, and what
produced the report.

`finish-run.mjs` stamps `run_state: complete`, archives everything to `runs/<run_id>/`, and
removes the checkpoint — `config.delete_after_report`. **The plan is kept** (`config.retain_after_report`): it is the
record of what was tested, and the JDBC suite is derived from it. The next invocation starts at
Stage 1.


### Test Results carries five lenses

Test Results regroups client-side by Business Process, Role, Persona, Object or Gap Category.
Each lens reads fields the TC already holds, so all five work only if the checkpoint preserved
`process_group`, `roles[]`, `group_type`, `target_objects[]` and `gap_ids[]`. Dropping them
collapses four views into one "Unassigned" bucket, silently. See `artifacts.md` §5.

### Verify both before handing them over

```bash
node "<skill>/scripts/validate-report.mjs" "$REPORT_FILE"
node "<skill>/scripts/validate-report.mjs" "$GAP_REPORT_FILE"
```

It renders each page headless, names any constant still holding a placeholder, and exercises
every interactive handler. Exit 0 means every panel rendered and every control works.

---

## 12.3 Constant → source map

| Constant | Comes from |
|---|---|
| `REPORT_KIND` | `"test"` or `"gap"` — see 12.2 |
| `CONNECTOR`, `CONNECTOR_META` | Step 0, Stage 2 |
| `GROUPS` | checkpoint `groups` |
| `EXEC_SUMMARY`, `FAULT_TABLE`, `DQ_OBSERVATIONS`, `INSTR_EVAL`, `caps` | Stage 10.3 |
| `SCHEMA_COVERAGE`, `PERSONAS`, `COVERAGE_MATRIX` | Stage 10.3 |
| `TC_REVIEW_SUMMARY` | Stage 8.5 — pre-execution review findings |
| `POST_EXEC_REVIEW` | Stage 10.5 — post-execution AI review findings |
| `KNOWLEDGE` | `$KNOWLEDGE_FILE` |
| `COVERAGE` | `$COVERAGE_FILE` |
| `GAPS` | `$GAPS_FILE` — **pre-execution set with final statuses** |
| `CUSTOMER_EVIDENCE` | `$KNOWLEDGE_FILE`; `{available:false}` when no dump |

The Role × Process matrix is a section inside the Coverage Model tab rather than a tab of its
own — it is one view of data every TC carries, not a separate report mode.

---

## 12.4 Finish the run

```bash
node "<skill>/scripts/finish-run.mjs" --dir "$ROOT/$CONNECTOR"
```

It stamps `run_state: "complete"` and `completed_at` into `$KNOWLEDGE_FILE`, archives every
artifact and both reports to `runs/<run_id>/`, and deletes only the checkpoint from the
working folder. Knowledge, coverage and gaps stay in place for a human to read — but the router
now treats a complete run as finished, so **the next invocation starts at Stage 1** and re-runs
discovery against the connector as it is *then*.

The previous behaviour — keep three files, delete two, let the router sort it out — sent the next
run to Stage 8 with already-resolved gaps and never called `getTables()` again. That is the bug
`finish-run.mjs` + `detect-stage.mjs` together close.

---

## 12.5 Summarize to the user

One short paragraph: **both report paths** · TC count with
pass / corrected / fail / na / nt breakdown · gap closure (n of m, by priority) · coverage across
the seven dimensions · whether customer evidence was used · top 1–2 findings.

> **Never report a coverage number without saying what it is coverage *of*.**
> "83% coverage" is meaningless. "83% of Tier-1 important columns exercised; 4 of 9 relationships
> untested" is a result.

---

## 12.6 Constant shapes

Everything below documents the exact shape of each constant, for reading a report or debugging
`build-report.mjs`, which fills all of them.

### REPORT_KIND
Selects the tab set. Everything else about the two reports is identical.
```javascript
const REPORT_KIND = "test";   // "test" → test report · "gap" → gap analysis report
```

### CONNECTOR
```javascript
const CONNECTOR = "Asana"; // exact $CONNECTOR value from Step 0
```

### CONNECTOR_META
```javascript
const CONNECTOR_META = {
  app:             "Asana",
  subtitle:        "Business process regression suite via CData Connect AI MCP",
  role_complexity: "medium",        // low | medium | high  (from Stage 1.4)
  recommendation:  "Complex role hierarchy - permission boundaries carry real risk here",
  total_roles:     5,
  total_workflows: 28,
  total_domains:   5,
  sources:         ["https://developers.asana.com/docs", "https://asana.com/guide/help/permissions/roles"]
};
```

### EXEC_SUMMARY
New fields: `verdict`, `verdictLabel`, `verdictDetail`, `health` (0–100 integer).

`verdict` must be one of: `production_ready` | `needs_attention` | `not_ready` | `needs_improvement`

```javascript
const EXEC_SUMMARY = {
  verdict:          "production_ready",
  verdictLabel:     "Production-Ready with Caveats",
  verdictDetail:    "Core task/project analytics, aggregation, and pagination all work. Two schema gaps block subtasks and date filtering on CreatedAt.",
  health:           79,              // integer 0–100: (pass+partial)*100/total
  top_issues: [
    "Subtask queries return 0 rows — ParentTaskId filter undocumented and undiscoverable",
    "DATEADD() rejected on CreatedAt column — works on DueDate only"
  ],
  not_exec_reason:      "All TCs executed",
  production_cost_note: "At Sonnet 5 pricing, this 28-TC run costs ~$0.07. 50 users × 15 queries/day ≈ $135/month."
};
```

### INSTR_EVAL
Evaluate `getInstructions()` quality after Stage 3. Score each dimension 1–10.

`verdict` must be one of: `excellent` | `good` | `needs_improvement` | `needs_attention`

```javascript
const INSTR_EVAL = {
  scores: {
    completeness:  6,   // do instructions cover all tables, required filters, quirks?
    accuracy:      8,   // is what they claim actually true at runtime?
    actionability: 5,   // can the AI use them without trial-and-error?
    overall:       6
  },
  prevented:   3,      // count of TCs where instructions prevented an error
  trialerror:  3,      // count of TCs that hit trial-and-error due to missing guidance
  verdict:     "needs_improvement",
  findings: [
    {
      category: "ParentTaskId undocumented",
      claimed:  "Instructions do not mention subtasks or ParentTaskId at all.",
      actual:   "Subtask queries silently return 0 rows without ParentTaskId filter. Field absent from schema.",
      impact:   "TC-P0105 FAIL — any user prompt about subtasks returns wrong answer."
    },
    {
      category: "DATEADD on CreatedAt",
      claimed:  "Instructions say DATEADD is supported. No column restrictions listed.",
      actual:   "DATEADD() is rejected by driver on CreatedAt. Works on DueDate and ModifiedAt only.",
      impact:   "TC-P0202 FAIL — project creation-date filtering non-functional."
    }
    // add one finding per instruction gap found
  ],
  recommendations: [
    "Document ParentTaskId: 'Subtask queries require ParentTaskId filter — omit it and you get 0 rows.'",
    "Document DATEADD column restrictions: 'DATEADD() works on DueDate/ModifiedAt. NOT on CreatedAt.'"
    // ordered by priority
  ],
  raw: `[raw getInstructions() output goes here — copied verbatim from Stage 1.1]`
};
```

### caps — MCP Capability Matrix
One entry per testable capability.
Level: `1` = working · `2` = limited/partial · `3` = not supported

```javascript
const caps = [
  [1, "SELECT with mandatory WorkspaceId filter"],
  [1, "Single-column WHERE filter"],
  [1, "Multi-condition AND / OR"],
  [1, "ORDER BY + LIMIT top-N"],
  [1, "LIMIT N OFFSET M pagination"],
  [1, "COUNT + GROUP BY aggregation"],
  [1, "MIN() / MAX() on date columns"],
  [1, "JOIN (primary + related tables)"],
  [1, "IS NULL / IS NOT NULL"],
  [1, "CASE WHEN conditional categorization"],
  [1, "HAVING clause on aggregates"],
  [1, "Stored procedures"],
  [1, "Boundary enforcement (write blocked for low-privilege roles)"],
  [2, "Subtask queries via ParentTaskId (undocumented — not discoverable without hint)"],
  [2, "DATEADD() on CreatedAt column (driver rejects — works on DueDate only)"],
  [3, "INSERT directly on primary table (must use stored procedure)"],
  [3, "Custom field access (not exposed as SQL columns)"]
];
```

### GROUPS
One entry per test group. Each TC now carries `uc` (use case name) and `time` (execution time).

`status` per TC: `pass` | `partial` | `fail` | `boundary` | `ne`

Steps use `{t, q, e, r, a}`:
- `t` — step type: `p` | `f` | `b` | `d`
- `q` — SQL query sent (string or omit)
- `e` — error message returned (string or omit)
- `r` — result summary (string or omit)
- `a` — action / narrative (string or omit — for self-correction or no-query steps)

```javascript
const GROUPS = [
  {
    id:    "grp-a",
    title: "A — Task Management",
    desc:  "Core task operations: list, filter, aggregate, pagination, subtasks, write, negative TCs",
    tcs: [
      {
        id:        "TC-P0101",
        uc:        "List workspace tasks",                     // 3–6 word noun phrase
        prompt:    "List all tasks in the Engineering workspace",
        status:    "pass",
        time:      "3.2s",
        est_in:    310,
        est_out:   190,
        tool_calls: 1,
        steps: [
          {t:"p", q:"SELECT * FROM Tasks WHERE WorkspaceId='895623401'", r:"134 rows returned"}
        ]
      },
      {
        id:        "TC-P0103",
        uc:        "Find overdue tasks by assignee",
        prompt:    "Find overdue tasks assigned to Sarah Johnson that aren't complete",
        status:    "partial",                                  // self-corrected but no degradation
        time:      "7.1s",
        est_in:    510,
        est_out:   385,
        tool_calls: 3,
        steps: [
          {t:"f", q:"SELECT * FROM Tasks WHERE AssigneeEmail='...'", e:"Invalid column name 'AssigneeEmail'."},
          {t:"d", a:"Self-correction: called getColumns(Tasks) → correct column is AssigneeName."},
          {t:"p", q:"SELECT * FROM Tasks WHERE AssigneeName='Sarah Johnson' AND Completed=false", r:"8 rows"}
        ]
      },
      {
        id:        "TC-P0105",
        uc:        "List subtasks of parent task",
        prompt:    "Show all subtasks of the task named 'API Integration Sprint'",
        status:    "fail",
        time:      "9.4s",
        est_in:    620,
        est_out:   445,
        tool_calls: 4,
        steps: [
          {t:"f", q:"SELECT * FROM Tasks WHERE Name LIKE '%API Integration%'", r:"0 rows"},
          {t:"f", q:"SELECT * FROM Tasks WHERE Name LIKE '%API Integration%' AND Type='subtask'", e:"Invalid column name 'Type'."},
          {t:"f", a:"Gave up — reported 'no subtasks found' (incorrect)."}
        ]
      }
      // ... more TCs
    ]
  }
  // ... more groups
];
```

### FAULT_TABLE
```javascript
const FAULT_TABLE = [
  {
    issue:       "Subtask queries return 0 rows — ParentTaskId filter undocumented",
    tc_ids:      ["TC-P0105"],
    owner_cls:   "owner-schema",   // owner-ai | owner-driver | owner-schema | owner-ok
    owner_label: "Schema Gap",
    detail:      "ParentTaskId filter required for subtask queries but not documented. Undiscoverable from schema alone."
  }
];
```

### DQ_OBSERVATIONS
```javascript
const DQ_OBSERVATIONS = [
  {sev:"high", title:"DueDate stored as VARCHAR", detail:"Date math functions behave unexpectedly — recommend changing schema type to DATE."}
];
```

### COVERAGE_MATRIX
```javascript
const COVERAGE_MATRIX = {
  roles:     ["Global Admin", "Member", "Guest"],
  processes: ["Task Management", "Project Management", "Admin"],
  cells: {
    "Global Admin:Task Management": {count:8, pass:7, fail:1},
    "Member:Task Management":       {count:6, pass:6, fail:0}
    // omit cells with count:0
  }
};
```
Always computed. Set to `null` only when the connector exposes no meaningful roles.

### SCHEMA_COVERAGE
One entry per table in the connector's schema, built from `$TABLE_CATEGORIES` after Stage 3.
`status`: `"pass"` = ≥1 passing TC · `"fail"` = only failing TCs · `"not_tested"` = no TC reached it.

```javascript
const SCHEMA_COVERAGE = {
  total:  42,
  tested: 35,
  pct:    83,
  by_category: {
    core:      { total: 10, tested: 10, label: "Core / Transactional" },
    analytics: { total:  8, tested:  4, label: "Analytics / Reporting" },
    lookup:    { total: 12, tested: 12, label: "Lookup / Configuration" },
    audit:     { total:  5, tested:  4, label: "Audit / Activity" },
    junction:  { total:  5, tested:  4, label: "Junction / Relationship" },
    custom:    { total:  2, tested:  1, label: "Custom / Extension" }
  },
  rows: [
    { name: "Tasks",         category: "core",      status: "pass",       tc_ids: ["TC-P0101","TC-P0102"] },
    { name: "Projects",      category: "core",      status: "pass",       tc_ids: ["TC-P0201"] },
    { name: "ActivityFeed",  category: "audit",     status: "fail",       tc_ids: ["TC-S0301"] },
    { name: "budgets",       category: "analytics", status: "not_tested", tc_ids: [] }
    // one row per table
  ]
};
```

### PERSONAS
One entry per persona from `$CONNECTOR_META.personas`, enriched with TC counts from Stage 3.

```javascript
const PERSONAS = [
  {
    id:          "PERSONA_FIN",
    name:        "Finance Analyst",
    description: "GL, budgeting, P&L, reconciliation reporting",
    group_id:    "grp-pe01",
    tc_count:    5,
    pass_count:  4
  },
  {
    id:          "PERSONA_SOPS",
    name:        "Sales Ops",
    description: "Rep activity, pipeline aging, customer touch metrics",
    group_id:    "grp-pe02",
    tc_count:    4,
    pass_count:  4
  }
  // one entry per persona
];
```

### KNOWLEDGE — semantic schema and provenance
From `$CONNECTOR_knowledge.json`. Every semantic field carries `confidence`
(`FACT` | `INFERENCE` | `UNKNOWN`) and `source` (`cdata_metadata` | `vendor_docs` |
`customer_evidence` | `ai_inference` | `execution_observation`).

```javascript
const KNOWLEDGE = {
  source_overview: "NetSuite ERP — financials, order-to-cash, procure-to-pay, inventory.",
  capabilities:    ["SuiteQL read", "SuiteTalk read/write", "Saved search execution"],
  limitations:     ["No DATEADD on custom date fields", "5,000-row result cap per call"],
  objects: [
    { name:"VendorBill", type:"TABLE", tier:"T1", tier_score:9,
      tier_signals:["workflow_ref","customer_top10pct","category_core"],
      category:"core",
      business_meaning:{v:"A payable invoice received from a vendor", confidence:"FACT", source:"vendor_docs"},
      business_domain:{v:"Accounts Payable", confidence:"INFERENCE", source:"ai_inference"},
      personas:["AP Clerk","Controller"],
      columns_loaded:true,
      columns:[
        {name:"TranDate", role:"date",       important:true,
         meaning:{v:"Date the bill was recorded", confidence:"FACT", source:"cdata_metadata"}},
        {name:"Entity",   role:"relationship_key", important:true,
         meaning:{v:"FK to Vendor.InternalId", confidence:"INFERENCE", source:"customer_evidence"}}
      ]}
  ],
  relationships: [
    { id:"REL-001", from:"VendorBill", to:"Vendor", on:"Entity = InternalId",
      meaning:"Each bill is issued by one vendor",
      confidence:"INFERENCE", source:"customer_evidence", evidence_count:14, tested:true }
  ],
  procedures: [
    { name:"SubmitApproval", description:"Submits a bill into the approval workflow",
      params:[{name:"billId", type:"string", required:true}], state:"tested" }
  ],
  data_range: { VendorBill:{min:"2013-01-15", max:"2015-06-30", count:6625} },
  semantic_updates: [
    { field:"Case.Status__c", old_value:"exists (cdata_metadata)", new_value:"driver rejects column",
      source:"execution_observation", evidence:"TC-014 — Invalid column name 'Status__c'" }
  ],
  semantic_conflicts: [
    { field:"Case.Status__c", higher:"cdata_metadata says column exists",
      lower:"execution_observation says driver rejects it",
      resolution:"Reported as connector defect — metadata not corrected." }
  ]
};
```

### COVERAGE — the seven dimensions
From `$CONNECTOR_coverage.json`. Object state is a lattice, not a boolean:
`discovered` → `semantically_understood` → `tested` → `partially_covered` → `fully_covered`,
plus terminal `failed` / `not_applicable` / `not_testable`.

```javascript
const COVERAGE = {
  objectives_met: false,
  objects: {
    tables: { total:42,
      by_tier:{ T1:{total:8,covered:8,failed:0,na:0,nt:0},
                T2:{total:11,covered:9,failed:1,na:0,nt:1},
                T3:{total:15,covered:11,failed:0,na:2,nt:2},
                T4:{total:8,covered:8,failed:0,na:0,nt:0} },
      rows:[{name:"VendorBill",tier:"T1",state:"fully_covered",
             columns_covered:9,columns_important:11,tc_ids:["TC-001","TC-004"]}] },
    views:      { total:6,  by_tier:{/* same shape */}, rows:[] },
    procedures: { total:4,
      rows:[{name:"SubmitApproval",state:"tested",params_total:2,
             params_required_tested:1,param_combos_tested:2,tc_ids:["TC-031"]}] }
  },
  columns: { total_important:186, covered:142,
    by_role:{ identifier:{t:42,c:40}, date:{t:31,c:27}, status:{t:24,c:22},
              dimension:{t:35,c:26}, measure:{t:28,c:19},
              relationship_key:{t:19,c:6}, descriptive:{t:7,c:2} },
    rows:[{object:"VendorBill",column:"TranDate",role:"date",state:"covered",tc_ids:["TC-001"]}] },
  relationships: { total:9, tested:5,
    rows:[{id:"REL-001",from:"VendorBill",to:"Vendor",on:"Entity = InternalId",
           state:"covered",confidence:"INFERENCE",tc_ids:["TC-004"]}] },
  use_cases: { total:23, covered:18,
    rows:[{id:"UC-003",name:"Vendor bills awaiting approval >5 days",
           domain:"Accounts Payable",persona:"AP Clerk",objects:["VendorBill"],
           source:"vendor_report",state:"covered",tc_ids:["TC-001"]}] },
  patterns: { rows:[
    {pattern:"filter_equality",  applicable:true,  applicability_reason:"",
     customer_frequency:0.98, state:"covered",       tc_ids:["TC-001"]},
    {pattern:"date_function",    applicable:false,
     applicability_reason:"0 of 10,690 real queries use date functions; driver rejects DATEADD on custom fields",
     customer_frequency:0.00, state:"not_applicable", tc_ids:[]},
    {pattern:"having",           applicable:false,
     applicability_reason:"27 of 10,690 real queries (0.3%) — below relevance threshold",
     customer_frequency:0.003, state:"not_applicable", tc_ids:[]}
  ]},
  intents: { rows:[
    {id:"INT-001", canonical:"overdue_invoices", objects:["Invoice"],
     phrasings:["Show overdue invoices",
                "Which invoices haven't been paid by their due date?",
                "Find invoices that are past due"],
     state:"covered", semantic_match:true, tc_ids:["TC-021","TC-022","TC-023"]}
  ]},
  behaviors: { rows:[
    {behavior:"empty_result_interpretation", applicable:true, state:"covered", tc_ids:["TC-040"]},
    {behavior:"wrong_column_recovery",       applicable:true, state:"covered", tc_ids:["TC-014"]}
  ]}
};
```

### GAPS — the pre-execution gap set with final outcomes
From `$CONNECTOR_gaps.json`. **These are the gaps that existed BEFORE any test ran.**
Never delete a gap because it was later closed — set `final_status` instead.

`final_status`: `CLOSED` | `PARTIALLY_CLOSED` | `FAILED` | `OPEN` | `NOT_APPLICABLE` | `NOT_TESTABLE`

```javascript
const GAPS = [
  { id:"GAP-014", category:"CUSTOMER",
    description:"'Invalid column name' error cluster (152 production occurrences) never reproduced",
    impacted:{objects:["Case"], columns:["Status__c"], relationships:[], patterns:[]},
    tier:"T1", business_importance:"HIGH",
    evidence:"customer_evidence: 152 failing production queries across 3 columns",
    evidence_strength:"STRONG",
    detected_round:0, priority:"P1", priority_score:13,
    planned_tests:["TC-014"], final_status:"FAILED" },
  { id:"GAP-021", category:"RELATIONSHIP",
    description:"VendorBill → Vendor relationship never exercised by a join",
    impacted:{objects:["VendorBill","Vendor"], columns:[], relationships:["REL-001"], patterns:["join_two_table"]},
    tier:"T1", business_importance:"HIGH", evidence:"14 real queries join these objects",
    evidence_strength:"STRONG",
    detected_round:0, priority:"P1", priority_score:12,
    planned_tests:["TC-004"], final_status:"CLOSED" }
];
```
Categories: `SCHEMA` · `BUSINESS` · `QUERY` · `INTENT` · `PROCEDURE` · `RELATIONSHIP` · `CUSTOMER` · `BEHAVIOR`

### CUSTOMER_EVIDENCE
Set `{available:false}` when no query dump was found — the report then states
"Customer Query Evidence: Not Available" and hides the Customer Reality tab.

```javascript
const CUSTOMER_EVIDENCE = {
  available: true, query_count: 10690, file_count: 1, connector_match: "Salesforce.Salesforce",
  object_frequency:  { Case:4565, Account:1661, CaseComment:1461, User:1307 },
  pattern_frequency: { where:0.98, order_by:0.64, limit:0.42, in_list:0.33, join:0.27,
                       like:0.16, is_null:0.12, group_by:0.03, update:0.09,
                       date_function:0.00, having:0.003, offset:0.01 },
  join_pairs:    [{from:"Case", to:"Account", on:"AccountId = Id", count:412, covered:true}],
  error_clusters:[{pattern:"Invalid column name 'X' for table 'X'", count:152,
                   likely_owner:"owner-schema", reproduced:true, tc_ids:["TC-014"]}],
  zero_row_rate: 0.20, slow_query_rate: 0.103,
  reconciliation: [
    {finding:"Date functions absent from real traffic (0 of 10,690)",
     action:"Marked date_function NOT_APPLICABLE; generated date_literal_range TCs instead"},
    {finding:"UPDATE is 9% of real traffic",
     action:"Promoted write coverage to Tier-1 — 3 write TCs added"}
  ]
};
```

### TC_REVIEW_SUMMARY
From Stage 8.5 checkpoint line `{"type":"summary","key":"tc_review_summary"}`.
Set to `null` when `config.defaults.skip_tc_review` was true — report tab shows "Pre-execution review was skipped."

```javascript
const TC_REVIEW_SUMMARY = {
  model:             "claude-sonnet-5",
  tcs_reviewed:      90,
  tcs_rewritten:     12,
  tcs_added:         4,
  tcs_merged:        2,
  tcs_risk_flagged:  3,
  gaps_newly_covered: ["GAP-031","GAP-044"],
  gaps_reclassified_nt: [
    { id:"GAP-072", reason:"AsanaOAuthAuthorizationUrl returns a URL only — not testable via queryData" }
  ],
  web_search: true,
  web_findings: [
    { source:"stackoverflow.com",    insight:"SubTasks require ParentTaskId or return 0 rows",        action_taken:"Added risk_flag to TC-003, TC-004" },
    { source:"community.asana.com",  insight:"Goals requires Asana Business+ subscription",           action_taken:"Reclassified GAP-099 to GAP-102 as NOT_TESTABLE" }
  ],
  execution_order_note: "Destructive procs placed in final batch. SubTasks TCs isolated — known timeout risk."
};
```

### POST_EXEC_REVIEW
From Stage 10.5 checkpoint line `{"type":"summary","key":"post_exec_review"}`.
Set to `null` when `config.defaults.skip_post_exec_review` was true — report tab shows "Post-execution review was skipped."

```javascript
const POST_EXEC_REVIEW = {
  model: "claude-sonnet-5",
  verdict_corrections: [
    { tc_id:"TC-004", original_owner:"owner-ai", corrected_owner:"owner-driver",
      reason:"JOIN timeout is a connector limitation — SQL was valid" }
  ],
  gap_reclassifications: [
    { gap_id:"GAP-095", from:"PARTIALLY_CLOSED", to:"NOT_TESTABLE",
      reason:"SubTasks REL-010 JOIN always times out — structural driver limitation" }
  ],
  fault_patterns: [
    { pattern:"SubTasks JOIN timeout",  tc_ids:["TC-003","TC-004"],  owner:"owner-driver",
      detail:"Any JOIN involving SubTasks causes connector timeout; must use separate queries" },
    { pattern:"Goals HTTP 403",         tc_ids:["TC-036"],           owner:"owner-driver",
      detail:"Goals requires Asana Business+ subscription — not available on this account" }
  ],
  round2_needed: false,
  round2_reason: "All remaining open gaps are NOT_TESTABLE. No recoverable failures.",
  prompt_rewrites: [],
  connector_health: {
    strengths: [
      "Reliable schema discovery via getTables/getColumns",
      "Strong SELECT + filter support on Tasks, Projects, Portfolios",
      "Stored procedures execute correctly"
    ],
    weaknesses: [
      "SubTasks JOIN always times out — must use separate queries",
      "Goals requires Asana Business+ subscription",
      "Server-side WHERE filter on SubTasks causes timeout"
    ],
    verdict_detail: "Core task/project analytics work reliably. Two structural limitations (SubTasks JOIN, Goals subscription) are connector constraints, not AI failures."
  },
  web_research: true,
  additional_findings: [
    { source:"community.asana.com",
      finding:"Rate limits on Tasks endpoint at >200 req/min — not triggered in this run but relevant at production scale" }
  ]
};
```

---


