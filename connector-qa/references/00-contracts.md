# Shared Contracts

**Contents**

- 1. Provenance — confidence and source
- 2. Coverage state — a lattice, not a boolean
- 3. Verdicts — 14 statuses
- 4. Fault ownership
- 5. Step types
- 6. Gap categories
- 7. Object tiers
- 8. Column roles
- 9. Object categories
- 10. Access levels
- 11. Run state and versioning
- 12. Connector verdict — derived by rule

The vocabulary every stage depends on. Read once during Stage 1. Stages 3, 5, 6, 9 and 10 all
reference these definitions — they are defined here once and never restated.

---

## 1. Provenance — confidence and source

**Never present AI inference as authoritative metadata.** Every semantic field carries both.

| `confidence` | Meaning |
|---|---|
| `FACT` | Stated by connector metadata, `getInstructions()`, or vendor documentation |
| `INFERENCE` | Deduced by AI from naming, datatype, category, or analogy |
| `UNKNOWN` | Could not be determined — an honest, reportable state |

| `source` | Where it came from |
|---|---|
| `cdata_metadata` | `getTables` / `getColumns` / `getProcedures` / `getInstructions` |
| `vendor_docs` | The source system's own documentation |
| `customer_evidence` | Observed in a query dump |
| `ai_inference` | AI reasoning |
| `execution_observation` | Learned at runtime during Stage 9/10 |

**Precedence when sources conflict:**
```
cdata_metadata > vendor_docs > customer_evidence > execution_observation > ai_inference
```

A lower source **never silently overwrites** a higher one. The disagreement is recorded in
`semantic_conflicts[]` and surfaced in the report. An execution observation that contradicts
`cdata_metadata` is exactly the schema-accuracy bug this runtime exists to find — quietly
patching the model around it erases the finding.

---

## 2. Coverage state — a lattice, not a boolean

"We touched the table" is not coverage.

```
discovered → semantically_understood → tested → partially_covered → fully_covered
                                          ├──→ failed
                                          ├──→ not_applicable
                                          └──→ not_testable
```

| State | Counted as covered? | In the denominator? |
|---|---|---|
| `fully_covered` | yes | yes |
| `partially_covered` | partial credit | yes |
| `tested` | yes, for object coverage only | yes |
| `failed` | **no** — a failed test proves the opposite | yes |
| `not_applicable` | n/a | **no** — out of scope, not a miss |
| `not_testable` | **no** | **yes** — we failed to validate it, and that must stay visible |

Never use `not_applicable` to hide something you could not test.

---

## 3. Verdicts — 14 statuses

Use the lowercase value; the report template reads these keys directly.

| Condition | `status` |
|---|---|
| Correct query, correct result, no retries | `pass` |
| First query wrong SQL syntax/semantics; corrected; passed | `pass_sql` |
| First query wrong column name; corrected; passed | `pass_col` |
| First query wrong table name; corrected; passed | `pass_tbl` |
| First query wrong schema/namespace; corrected; passed | `pass_schema` |
| First query wrong datatype assumption; corrected; passed | `pass_dtype` |
| First query wrong logic (JOIN/filter/subquery); corrected; passed | `pass_query` |
| First query **correct**, but hit a **source/connector limitation**; AI changed *strategy* and succeeded | `partial` |
| Could not achieve the result after all retries | `fail` |
| Boundary TC correctly blocked (403 / permission denied / safety rule) | `boundary` |
| AI deliberately declined to query (contradiction, ambiguity, safety) | `not_exec` |
| Capability genuinely does not apply to this connector | `na` |
| Could not be validated due to an external limitation (no credentials, no parameter values, no test data, sandbox restriction) | `nt` |
| Never reached — an infra failure halted the run earlier | `ne` |

> **`pass_*` means the AI was wrong first and fixed it. `partial` means the AI was right and the
> connector could not comply.** Never conflate them — that distinction is the entire signal
> separating an AI problem from a driver problem.
>
> **`na` vs `nt`:** `na` = correctly not supported; no gap, no defect. `nt` = we could not test it;
> the gap stays open and visible.

### The 0-row rule — one rule, because two produced two answers

An empty result is the single most misread observation in the pipeline. asn004 labelled empty
tables `boundary`, which printed "the driver rejected it" against a connector that had done
nothing wrong; the reports then counted those as blocked capabilities. Decide it by asking **what
the test was trying to prove**, never by the row count alone:

| The query ran and returned 0 rows, and… | Verdict |
|---|---|
| 0 rows is a **correct answer to the question asked** ("overdue tasks" on a project with none) | `pass` |
| the test **needed rows to prove anything** — a join's row-preservation, a sort's NULL placement, a filter's boundary | `nt`, reason `no test data` |
| the query carried a date filter | re-run without it first (`07-execution.md` §9.4); only then decide the two rows above |

**`boundary` requires a refusal.** It means the connector or API actively said no — 403, permission
denied, a documented safety rule. A query that ran to completion is never `boundary`, whatever it
returned. `credit-coverage.mjs` enforces this and will reject a `boundary` TC carrying no refusal
error on any step, exiting 3. `--allow-mislabelled-boundary` proceeds anyway — it exists so a
disputed verdict cannot wedge a finished run, and using it means the report credits coverage from
a verdict the pipeline believes is wrong.
>
> **`not_exec` vs `ne`:** `not_exec` = the AI made a deliberate decision not to query.
> `ne` = the TC was never started because an infra failure halted the run earlier.

**Mapping to coarse reporting labels:**
`pass`→PASS · `pass_*`→PASS[CORRECTED] · `partial`→PARTIAL · `fail`+`owner-ai`→FAIL_AI ·
`fail`+`owner-driver`→FAIL_DRIVER · `fail`+`owner-schema`→FAIL_SCHEMA · `na`→NOT_APPLICABLE ·
`nt`→NOT_TESTABLE

---

## 4. Fault ownership

```
IF the step sequence ends on `b`                          → owner-driver
   (valid SQL-92, logically correct, connector rejected it:
    unsupported function, unsupported join, write not exposed,
    rate limit, result too large)

ELSE IF it ends on `f`:
   non-existent table (not in $TABLES)                    → owner-ai      (hallucinated table)
   non-existent column (not in $COLUMNS)                  → owner-ai      (hallucinated column)
   wrong JOIN / filter logic / misread prompt             → owner-ai      (reasoning error)
   plausible query, but correctness was unguessable
   (misleading object name · undocumented required parent
    filter · no FK exposed · datatype contradicts name)   → owner-schema

ELSE IF connection / network / auth error, no SQL         → owner-driver
ELSE IF BOUNDARY_FAIL (write succeeded that should be blocked) → owner-driver
FOR pass and pass_* (self-corrected)                      → owner-ok
```

**Capability mode (3.x) charges every failed call, not just the verdict,** to one of seven owners —
`lib/journey.mjs` (`ERROR_CLASSES` and `attributeCauses()`), re-derived from the stored error text
whenever a report is built:

| Cause | Means | Classic owner |
|---|---|---|
| `connector` | the driver or MCP server refused or failed: operation not offered, timeout, rate limit, server down | owner-driver |
| `instructions` | the usage instructions (`getInstructions`) did not say it: catalog or schema name, a required filter, which SQL functions work | owner-schema |
| `metadata` | the schema contradicts itself: a table or column listed earlier in the same journey is then rejected | owner-schema |
| `ai` | the agent guessed a name never listed, wrote bad SQL, read too much, or answered a different question | owner-ai |
| `account` | the test account's plan or rights | — |
| `source` | the source's own API does not offer it (a "Not applicable" capability) | — |
| `harness` | the test harness refused the call before it reached the connector; the attempt is re-run | — |
| `test_data` | the test account holds nothing the use case is about, or the record to change did not exist | — |

**Every use case gets one verdict (3.5)** — `verdictOf()` in `lib/report-data.mjs` — and every
summary is a breakdown of these, never one "failed" figure:

| Verdict | From | Counts for the AI? |
|---|---|---|
| Correct | `correct` | yes |
| Partly correct | `partial` (incl. right change + wrong report, or a side effect) | yes |
| Incorrect | `wrong`, owner AI, instructions, metadata or connector error | yes |
| Not supported | `not_possible`, a capability ConnectAI MCP does not offer | no — a connector finding |
| Not applicable | `not_possible`, a capability only in the source's own app | no |
| Refused by the connector | `blocked_connector`: the connector refused the operation (read-only, not supported), reported honestly (3.6) | no — a connector finding |
| Blocked by the account | `blocked_account`: refused for the plan or rights, reported honestly | no |
| Blocked by test data | `no_test_data`: nothing to find, no record to change, or a judged answer over no data | no |
| Not measured | not run, awaiting judgement, harness refusal | no |

The AI's correct rate and score are over the first three only. A *Not supported* use case is still
put to the agent once as a limitation probe (3.6); its `probe.outcome` (said so plainly / invented)
is reported beside the verdict and never changes it. A rephrased variant (`#v1`) is the
same use case: its attempts add evidence and a "same outcome in every wording" signal, never a row.

The capability report's usage-instructions panel also lists failures charged to other owners that
one line of instructions would have prevented (business words to tables, dialect, what can be
changed, large results, finding a record).

> **Two known classification limits — report readers must understand these:**
>
> 1. **Transient failures land in `owner-driver`.** A rate limit, timeout, or connection hiccup
>    during the run produces a `b`-step and is attributed to the driver. The same query often
>    works on manual retry. This is correct attribution (the driver did fail to serve it) but
>    the report's "connector didn't serve it" label overstates the implication — it suggests a
>    reproducible defect when the failure may have been one-time. Any `owner-driver` result
>    should be retested before filing as a bug.
>
> 2. **Missing catalog prefix misclassifies as `owner-driver`.** The `b`-step rule requires
>    "valid SQL-92, logically correct" — but the classification script infers this from the
>    error *type*, not by validating the SQL. If the agent sends a query without the 3-part
>    catalog name (e.g., `FROM [Tasks]` instead of `FROM [Asana1].[Asana].[Tasks]`), the driver
>    returns a "table not found" error that surfaces as `b`, attributing to `owner-driver` when
>    the correct attribution is `owner-ai`. In Stage 10 reconciliation, verify `observed.sql`
>    contains the correct catalog prefix before accepting `owner-driver` on a table-not-found
>    error — if the prefix is missing, reclassify to `owner-ai`.

| Owner | Label in report |
|---|---|
| `owner-ai` | AI Mistake |
| `owner-driver` | Driver / Connector |
| `owner-schema` | Schema Gap |
| `owner-ok` | By Design |

**Store the owner on the TC itself** (`tc.owner`) for every `fail`, `partial` and `boundary`, so
the report can answer "whose fault is this?" on the test row rather than sending the reader to
another tab. `pass` and `pass_*` take `owner-ok`.

**Also write one `FAULT_TABLE` row per distinct failure *pattern*, not per TC.** `tc_ids[]` lists
every TC exhibiting it; `detail` states root cause and workaround. The two must agree: a TC in a
row's `tc_ids[]` carries that row's owner. `owner-ok` rows are optional — include them only when
summarizing a clean domain is informative.

> **A recovered slip is not a failure.** An `f` step inside a TC that ends `pass_col` means the AI
> was wrong once and fixed it — the TC's owner is `owner-ok`. Counting those as AI failures
> inflates the AI's fault share and hides how well it self-corrects, which is itself a result
> worth reporting.

---

## 5. Step types

Each AI action within a TC records a step: `{t, q, e, r, a}` — type, SQL sent, error returned,
result summary, narrative.

**`q` is the query verbatim, exactly as the agent sent it** — never a summary, never elided with
`...`, never a bare clause, never a description of the call:

```
✗  q: "SELECT ... FROM Portfolios WHERE WorkspaceId='…' LIMIT 10"
✗  q: "WHERE TaskId='1218600454810237'"
✗  q: "JOIN using tte.UserId=u.Id"
✗  q: "TaskDependencies for 3 more task IDs"      ← belongs in `a`, not `q`
✓  q: "SELECT [Id],[TaskId],[CreatedBy],[DurationMinutes] FROM [Asana1].[Asana].[TimeTrackingEntries] WHERE [TaskId]='1218600454810237' LIMIT 20"
```

The report prints `q` as the reproduction case a connector engineer copies into a client to
reproduce the defect, so shorthand there is worse than useless — it reads as real SQL and does
not run. The agent's returned call log already holds the full text; copy it across unchanged, and
give every distinct call its own step rather than folding several into one summarising `q`.

Omit empty fields, with one exception: **`a` is required on every `f`, `b` and `d` step**, and
it must say *why*, not just *what*.

```
✗  a: "Retried the query."
✓  a: "Driver rejected 'vendorname'. Called getColumns(vendor) → actual column is
       'companyname'. Re-issued with the corrected name."

✗  a: "Second attempt."
✓  a: "0 rows on the natural window. Re-ran without the date filter (LIMIT 20) → 12 rows,
       so the query was correct and the test data is historical."

✗  a: "Simplified."
✓  a: "Decomposition: removed HAVING → 20 rows. HAVING is the unsupported construct."
```

A `d` step without its reason renders as "🔄 Self-Correct" beside a SQL diff and leaves the
reader to reverse-engineer what the agent worked out. The reasoning *is* the finding; the diff
is only its evidence.

| Step | Code | Meaning | `a` |
|---|---|---|---|
| Correct query, correct result | `p` | pass | optional |
| Wrong / hallucinated SQL | `f` | AI fault | **required** |
| Valid SQL the driver rejected | `b` | driver / boundary fault | **required** |
| Self-correction · 0-row fallback · decomposition | `d` | discovery | **required** |

---

## 6. Gap categories

| Category | A gap exists when… |
|---|---|
| `EXPOSURE` | a vendor business domain, workflow or **standard report** exists in the source system but **no connector object** was found for it. The only category that measures what the connector does *not* expose — without it, unexposed business areas vanish from every denominator and silence reads as coverage |
| `WORKFLOW` | a researched business workflow has no end-to-end test. A workflow is a job carried from start to finish; every step of it can pass as an isolated query while the job itself is impossible — an INSERT that succeeds and a row the next SELECT cannot see is two passes and one broken workflow |
| `OBJECT` | the connector exposes an object that **no test ever queries**. Tier governs how deeply an object is covered (§5.2), never whether it is looked at once — a table nobody asked about is still one the driver can throw on |
| `SCHEMA` | important object/column has no business meaning; a relationship exists in the business but has no discoverable key; a datatype contradicts the column name; a T1/T2 object has no columns loaded; metadata is missing |
| `BUSINESS` | a domain, workflow, or persona job-to-be-done has no use case; a use case has no test |
| `QUERY` | an applicable pattern is uncovered for a tier that requires it |
| `INTENT` | a T1 business intent has no NL test, has only one phrasing, or uses terminology ambiguous in this domain |
| `PROCEDURE` | an SP was discovered but never tested; a required parameter untested; no optional-parameter variation; no meaningful parameter combination |
| `RELATIONSHIP` | a declared or evidenced relationship has never been exercised by a join |
| `CUSTOMER` | *(evidence only)* a high-frequency object/column/join/filter is uncovered; a recurring production error is unreproduced; a high-frequency pattern is missing from the model |
| `BEHAVIOR` | a required agent behavior has no test |

**Gap `final_status`:** `CLOSED` · `PARTIALLY_CLOSED` · `FAILED` · `OPEN` · `NOT_APPLICABLE` · `NOT_TESTABLE`

---

## 7. Object tiers

| Tier | Label |
|---|---|
| `T1` | Business Critical |
| `T2` | Frequently Used / Important |
| `T3` | Supporting |
| `T4` | Technical / Lookup |

Derived by weighted scoring in `04-coverage-model.md` §5.1 — **never hardcoded to object names.**

---

## 8. Column roles

Column role drives column coverage, so it must be explicit.

| Role | Signals | Why it matters |
|---|---|---|
| `identifier` | Id, *Id, Key, Number, Code, PK | lookups and `IN()` batches |
| `date` | Date, *At, *On, Created*, Modified*, Due*, tranDate | every temporal filter |
| `status` | Status, State, Stage, Type, *Flag, isActive | the most common real-world filter |
| `dimension` | Name, Department, Region, Category, Owner, Account | `GROUP BY` |
| `measure` | Amount, Total, Qty, Quantity, Rate, Price, Balance, Score | `SUM/AVG/MIN/MAX` |
| `relationship_key` | FK to another object, or `<Object>Id` naming | JOINs |
| `descriptive` | Memo, Description, Subject, Comment, Notes | `LIKE` text search |
| `technical` | audit stamps, internal flags, system columns | low value — **never a gap** |

A column is `important: true` when its role is `identifier`, `date`, `status`, `dimension`,
`measure`, or `relationship_key`. **Column coverage objectives count important columns only** —
never penalize a Tier-1 object for 200 untested technical columns.

---

## 9. Object categories

| Category | Signals |
|---|---|
| `core` | Primary business records — orders, invoices, users, tickets, tasks |
| `analytics` | Pre-aggregated views — *Balance, *Summary, *Aggregate, *Posting, *Consolidat* |
| `lookup` | Enum/config — status, type, level, period, book, role, currency, category |
| `audit` | Change logs / activity — *History, *Audit, *Feed, *Log, message, event |
| `junction` | Many-to-many links — *roles, *members, *tags, *lines, *assignments, *access |
| `custom` | Org extensions — `CUSTOMRECORD_*`, `custom_*`, `*__c`, `ext_*`, `usrSearch*` |

---

## 10. Access levels

`F` = Full · `E` = Edit · `C` = Create · `V` = View · `N` = None

`$ACCESS_MATRIX[role_name][domain_id]` holds one of these.

---

## 11. Run state and versioning

| Field | Where | Meaning |
|---|---|---|
| `schema_version` | every artifact | major must match the skill's; `scripts/lib/artifacts.mjs` refuses otherwise |
| `run_state` | `knowledge.json` | `in_progress` while running; `complete` once Stage 12 finishes. **A complete run routes the next invocation to Stage 1** |
| `run_meta` | `knowledge.json`, checkpoint meta line, report footer | `run_id`, timestamps, resolved models, MCP server, driver version, metadata snapshot time |
| `stage_progress` | any artifact mid-stage | `{stage, done, total}` written every `config.defaults.persist_every_n_items` items so a compaction loses minutes, not a stage |

---

## 12. Connector verdict — derived by rule

Three verdict levels exist and must not be confused: the **test** verdict (§3), the **coverage**
state (§2), and the **connector** verdict below. The connector verdict is computed by
`scripts/credit-coverage.mjs`, never chosen:

```
any gap FAILED whose impacted patterns include a Band-1 pattern   → not_ready
any P1 gap OPEN or FAILED, or any EXPOSURE gap on a standard report → at most needs_attention
pass_health ≥ 90 and gap_health ≥ 90                              → production_ready
otherwise                                                          → needs_improvement
```

`pass_health` = passing tests ÷ in-scope tests. `gap_health` = P1–P3 gaps CLOSED ÷ live P1–P3
gaps. Both are shown. A connector can pass 98% of its tests and still fail this rule — that is
the point of having it.
