# Stage 4 · Customer Evidence (OPTIONAL — never a prerequisite)

**Contents**

- 4.1 Locate dumps
- 4.2 Expected schema
- 4.3 Run the mining script — do not read rows into context
- 4.4 What the script extracts
- 4.4a Cross-connector behavioral model — not implemented
- 4.5 Use evidence to *challenge* the model — this is the point
- 4.6 Persist

Customer query dumps **enrich and validate** the coverage model. Their absence changes nothing
structural: with no dump, documentation and schema alone still produce a full coverage model,
gap analysis and test plan.

**Never abort, never degrade the workflow, never skip a stage because no dump exists.**

---

## 4.1 Locate dumps

Search in order:

1. `--dump <path>` argument (a CSV file or a folder)
2. `$ROOT\$CONNECTOR\` + `config.query_dumps.per_connector_dir` (`querydump/`)
3. `$ROOT\` + `config.query_dumps.shared_dir` (`_querydumps/`)

In the shared folder, a **row** belongs to this connector if its query text references a
catalog/schema matching `$CATALOGS` or `$SCHEMAS` — e.g. `[NetSuite1].[SuiteQL].[...]` → NetSuite.

> **Filter row by row, never by filename.** A combined dump legitimately contains many
> connectors, and only the matching rows are evidence for this run.

Set `$HAS_CUSTOMER_EVIDENCE`. The report states
`Customer Query Evidence: Available (N queries from M files)` or `Not Available` either way.

---

## 4.2 Expected schema

```
Query, UserAgent, ErrorMessage, Duration, TimeToFirstRow, RowsReturned
```

Tolerate extra or reordered columns. `config.query_dumps.required_column` (`Query`) is the only
one that must exist; if a file lacks a recognizable query column, skip it and log why.

> **Dumps are customer data. They are read locally and never sent anywhere.**

---

## 4.3 Run the mining script — do not read rows into context

A single dump here is 13,000+ queries across 4 MB. Parsing it with an LLM is both wasteful and
non-deterministic. Use the script:

```bash
node "<skill>/scripts/mine-dump.mjs" \
  --connector <name> \
  --catalogs "NetSuite1.SuiteQL,PROD_NS.SuiteQL" \
  --out "$ROOT\$CONNECTOR" \
  "path/to/dump1.csv" "path/to/dump2.csv"
```

It writes `customer_evidence.json` next to the other artifacts and prints a short summary. You
read the summary; you never read the CSVs.

Pass `--catalogs` from `$CATALOGS`/`$SCHEMAS`. Omit it to accept every row (use only when the
dump is known to be single-connector).

---

## 4.4 What the script extracts

| Signal | Extraction | Feeds |
|---|---|---|
| Objects | `FROM`/`JOIN` → `[Catalog].[Schema].[Object]` | object tiering, object coverage |
| Columns | bracketed identifiers in SELECT / WHERE / GROUP BY / ORDER BY | column tiering, column coverage |
| Relationships | `JOIN … ON a.[x] = b.[y]` | relationship discovery + confidence upgrade |
| Filter patterns | `=`, `IN`, `LIKE`, `BETWEEN`, `IS NULL`, `<`/`>` | query-pattern coverage |
| Aggregations | `COUNT/SUM/AVG/MIN/MAX`, `GROUP BY`, `HAVING` | query-pattern coverage |
| Date handling | date functions **vs** literal `BETWEEN` — records which style is actually used | query-pattern coverage |
| Writes | `INSERT` / `UPDATE` / `DELETE` / `EXEC` | write coverage + applicability |
| Parameterization | `@param` placeholders | prompt realism |
| **Failures** | non-empty `ErrorMessage`, normalized (digits→`N`, literals→`'X'`) and clustered | `CUSTOMER` gaps, fault-model validation |
| **Empty results** | `RowsReturned = 0` | 0-row interpretation gaps |
| **Performance** | `Duration > 10000` ms | performance / result-too-large gaps |

Result shape → `artifacts.md` §1.4.

---

## 4.4a Cross-connector behavioral model — not implemented

A shared, cross-connector `behavior-model.json` is not implemented by any script; do not write or
read one.

---

## 4.5 Use evidence to *challenge* the model — this is the point

Evidence is not decoration. After mining, explicitly reconcile it against what Stages 2–3
assumed, and record each reconciliation in `$CUSTOMER_EVIDENCE.reconciliation[]`.

| Check | Action when it fires |
|---|---|
| **Object importance** | An object with high `object_frequency` that AI tiered low → **promote its tier** and record the signal |
| **Pattern applicability** | A pattern at ~0% across thousands of real queries is a `NOT_APPLICABLE` candidate — do not burn tests on it. A high-frequency pattern missing from the model is a **high-priority `CUSTOMER` gap** |
| **Date-handling style** | If users filter dates with literal `BETWEEN` and never call date functions, generate TCs in the style users actually use — and raise the discrepancy as a finding |
| **Write volume** | If `UPDATE` is a large share of real traffic, write coverage is **Tier-1 business critical**, not an optional extra |
| **Error clusters** | Each recurring production error becomes a `CUSTOMER` gap — reproduce it as a TC and confirm whether it is still broken. `Invalid column name` clusters map directly to `owner-schema` |
| **Semantic validation** | Columns co-occurring in real WHERE clauses confirm `status`/`date` role assignments — upgrade those from `INFERENCE` to `customer_evidence` |
| **Relationships** | Real `JOIN … ON` pairs upgrade `$RELATIONSHIPS` confidence and can add relationships the schema never declared |

> **Measured baseline, for calibration.** Across 13,826 real MCP queries (NetSuite SuiteQL and
> SuiteTalk, Salesforce, QuickBooks Online): date functions appeared in **under 1%**;
> `HAVING`, `OFFSET` and subqueries in **under 1%**; parameterized `@param` in **79–95%**;
> `UPDATE` in up to **49%** of SuiteTalk traffic; **13–65%** of queries returned zero rows; and
> the largest single error cluster on every connector was **"Invalid column name"**.
>
> If your model mandates date functions and skips writes, the evidence says the model is wrong.

---

## 4.6 Persist

Append `$CUSTOMER_EVIDENCE` to `$KNOWLEDGE_FILE`. If no dump was found, write
`{available:false}` — the report needs to state that explicitly rather than stay silent.

After **all** of Stage 4 finishes — mining and reconciliation (§4.5) — write `customer_evidence_complete: true` to `$KNOWLEDGE_FILE`.

This flag is critical for compaction resilience. `mine-dump.mjs` writes `customer_evidence.json`
to disk before the reconciliation step runs. If compaction hits after the
script completes but before this final persist, the router will see `knowledge.semantic_complete:
true` on resume and skip Stage 4 entirely — losing the reconciliation permanently. The `customer_evidence_complete` flag tells the router that Stage 4 ran to
completion, not just that the mining script finished.
