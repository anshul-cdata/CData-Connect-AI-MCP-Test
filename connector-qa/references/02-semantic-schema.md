# Stage 3 · Semantic Schema

**Contents**

- Stage 3a — Tier all objects from signals (before `getColumns`)
- Stage 3b — Quick dump scan for object frequencies
- Stage 3c — `getColumns` for T1 + T2 objects only
- 3.1 Provenance is mandatory
- 3.2 Object semantics
- 3.3 Column semantics
- 3.4 Relationships → `$RELATIONSHIPS`
- 3.5 Data-range probe — enrichment only
- 3.6 Persist

Where the runtime stops being a schema dumper and starts understanding the connector.

Prerequisite: `00-contracts.md` §1 (provenance), §8 (column roles), §9 (categories).

When `getTables()` returns more than `config.delegation.tier_before_columns_above_objects`
(default: 100) objects, follow the **tier-first approach** (Stages 3a → 3b → 3c) before calling
`getColumns`. A 1,500-object connector with every object fetched is hours of wasted schema; with
tiering it is ~150 T1+T2 objects and a usable semantic model.

For connectors ≤ 100 objects: call `getColumns` for every object in one pass, then proceed to
§3.1–3.6 directly.

**Before leaving Stage 3**, check the vocabulary:

```bash
node "<skill>/scripts/validate-model.mjs" --dir "$ROOT/$CONNECTOR" --stage 3
```

Tiers must be the strings `T1`–`T4`; a numeric `tier: 1` is valid JSON that every consumer filters
out, yielding zero T1 objects and no error. A relationship declaring `from_col` without `to_col` is
treated as undeclared and gets no reference query. Both are silent today.

---

### Sharded subagents — Stage 3 semantic schema

When `getTables()` returns more than `config.delegation.tier_before_columns_above_objects` (100)
objects, Stage 3a tiers all objects from signals first (no `getColumns` yet). Stage 3b does a
quick dump scan for object frequencies. Stage 3c then calls `getColumns` for T1+T2 objects only.

Only after Stage 3c, if the T1+T2 object count still exceeds
`config.delegation.shard_semantic_schema_above_objects` (40): split into batches of ~20 and
dispatch one agent per batch, each returning the object-semantics JSON from
`references/02-semantic-schema.md` §3.2–3.3. Merge centrally, then do relationships and the data
probe in the main thread — both need every object visible at once.

## Stage 3a — Tier all objects from signals (before `getColumns`)

Assign every object a tier **without fetching column lists**. Apply signals in this order of
reliability — earlier signals override later ones when they conflict:

| Signal | How to use | Tier impact |
|---|---|---|
| **Customer dump frequencies** (Stage 3b, if dump exists) | Top-N objects by query count → T1; next band → T2 | Strongest: confidence `FACT`, source `customer_evidence` |
| **Web research findings** (`$KNOWLEDGE_FILE.web_research_findings`) | Objects named in how-to guides, vendor reports, known workflows | Promotes to T1/T2; confidence `INFERENCE` |
| **`getTables()` TYPE / SIZE** | TYPE=`TABLE` + large estimated row count → likely T1/T2; pure `VIEW` often T3 | Structural hint |
| **`getInstructions()` mentions** | Object named with usage guidance in connector instructions | Promotes to T1/T2 for this connector |
| **Name patterns** | Names matching business patterns (`*Order*`, `*Invoice*`, `*Task*`, `*Project*`) → T1; matching `*Temp*`, `*Log*`, `*Audit*`, `*Metadata*` → T3/T4 | Name heuristic |
| **Sample `getColumns`** (3–5 objects) | One object per name-cluster; column richness and FK-shaped columns upgrades tier | Calibration only |

Record every assignment with the signal and confidence:
```javascript
{ name: "Transaction", tier: "T1", tier_signal: "dump_frequency", tier_confidence: "FACT",
  columns_loaded: false }
// columns_loaded becomes true after Stage 3c processes this object
```

Log signal conflicts — an object the dump shows is heavily queried but `getInstructions` never
mentions is a finding about documentation quality, not an error to resolve silently.

**Persist immediately after all objects are tiered.** Write to `$KNOWLEDGE_FILE` before moving
to Stage 3b:

```javascript
{ "stage_3a_complete": true,
  "tiered_objects": [
    {"name":"Transaction","tier":"T1","tier_signal":"dump_frequency","tier_confidence":"FACT"},
    {"name":"Vendor",     "tier":"T1","tier_signal":"web_research",  "tier_confidence":"INFERENCE"}
  ]
}
```

Without this write, a compaction between Stage 3a and Stage 3c loses all tier assignments. On
resume the router re-derives them from non-deterministic web searches and the T1/T2 selection
may differ — changing which objects get `getColumns` called.

---

## Stage 3b — Quick dump scan for object frequencies

**Run before Stage 3c, if a dump exists.** `mine-dump.mjs` has no frequencies-only mode: either
run the full miner now (its output is reused by Stage 4), or skip 3b.

```bash
node "<skill>/scripts/mine-dump.mjs" \
  --connector <name> \
  --out "$ROOT\$CONNECTOR" \
  "path/to/dump.csv"
```

It writes `customer_evidence.json`; its `object_frequency` (object name → query count, sorted
descending) feeds Stage 3a tiering. If no dump exists, skip this step.

After the script completes (or after skipping), write `stage_3b_complete: true` to
`$KNOWLEDGE_FILE`. This lets the router resume at Stage 3c rather than re-running the dump scan.

---

## Stage 3c — `getColumns` for T1 + T2 objects only

Call `getColumns` for every **T1** and **T2** object, plus any T3 object that is directly
referenced by a T1/T2 relationship FK. Skip all T4 objects and unreferenced T3 objects — their
column lists add no coverage value at this stage.

When T1+T2 object count exceeds `config.delegation.shard_semantic_schema_above_objects` (default: 40),
split into batches of ~20 and dispatch one `general-purpose` subagent per batch. Each agent does
§3.2 and §3.3 for its batch, **writes its JSON to `<connectorDir>/_agent_out/stage3-batch<N>.json`
before returning it**, and returns it too. Merge in the main thread.

These agents are the longest-running in the runtime — one Asana batch took 38 minutes. A
compaction inside that window destroys a returned-only result, so the file is the record. On
resume, merge whatever `_agent_out/` already holds rather than re-dispatching those batches.

§3.4 (relationships) and §3.5 (data probe) always run centrally — they need the whole picture.

After merging, mark each processed object `columns_loaded: true`. Objects skipped at T3/T4 get
`columns_loaded: false` and appear in reports as **"not analyzed — below tier threshold"**,
never as "not found". That distinction matters: a column that the runtime never fetched is
different from a column that the driver says does not exist.

---

## 3.1 Provenance is mandatory

Every semantic field carries `confidence` and `source` per `00-contracts.md` §1. This is not
decoration: the report renders these chips, and a reviewer uses them to decide how much of the
model to trust. A meaning you guessed and a meaning the vendor documented must not look alike.

---

## 3.2 Object semantics

For every table and view:

```javascript
{
  name: "VendorBill", type: "TABLE",
  category: "core",                        // 00-contracts.md §9
  business_meaning: {v:"A payable invoice received from a vendor",
                     confidence:"FACT", source:"vendor_docs"},
  business_domain:  {v:"AP", confidence:"INFERENCE", source:"ai_inference"},
  personas: ["AP Clerk","Controller"],
  business_questions: ["Which bills are awaiting approval?",
                       "Which bills are overdue?"],
  synonyms: ["invoice", "payable", "bill"],      // the words people use for it (2.2.0)
  headline_columns: { label: "TranId", owner: "ApproverName", state: "ApprovalStatus",
                      key_date: "DueDate", amount: "Total", parent: "VendorName" },
  prevalence: null,                              // set only when it differs from its domain's
  limitations: ["Write requires an ApprovalStatus transition"],
  columns_loaded: true
}
```

`business_questions` seed Stage 5's use-case dimension — write them as questions a person would
actually ask, not as table descriptions. An object with one becomes a business scenario; an object
without one only gets a conformance check.

`synonyms` are the words people use for the object — persona jobs say "teammate" and "owner",
never "Users", and without the synonym that object scores no persona coupling at all.

`headline_columns` are the columns a person means by "show me the bills": what it is called, who
owns it, where it stands, the date and figure that matter, what it belongs to. Every generated
query selects these first. Leave it out and `lib/realism.mjs` infers them from names and roles,
which gets most objects right; set it where the names mislead (an object whose label column is
called `TranId`, not `Name`).

---

## 3.3 Column semantics

Assign every loaded column a **role** from `00-contracts.md` §8 and mark `important` accordingly.

```javascript
{ name:"TranDate", role:"date", important:true,
  meaning:{v:"Date the bill was recorded", confidence:"FACT", source:"cdata_metadata"} }
```

Roles are what make column coverage measurable. An object with 220 columns of which 11 are
important is measured on the 11.

**Columns that describe the API, not the business, are `technical`** — `ResourceType`,
`ResourceSubType`, `HtmlNotes`, `ItemURL`, `*ResourceType` on every embedded reference. asn005
gave Asana's `ResourceSubType` the `dimension` role and marked 405 of 675 columns important;
the generator then grouped and filtered on it, producing questions nobody asks. `important`
should pick out the columns a person uses — on most objects that is well under half.

---

## 3.4 Relationships → `$RELATIONSHIPS`

Build from, in this order:

1. Declared FK metadata → `confidence: FACT`
2. Naming convention (`CustomerId` → `Customer`; `Entity` → an object `$INSTRUCTIONS` names) → `INFERENCE`
3. Joins observed in customer evidence (Stage 4 — revisit after mining) → `INFERENCE`, source `customer_evidence`
4. AI inference — **only when the column is FK-shaped**: `<Object>Id`, `<Object>Ref`,
   `<object>_id`, or a name that exactly matches another object. A column every object shares
   (`Id`, `Name`, `CreatedDate`, `Status`) is **not** evidence of a relationship. A relationship
   the model believes in without an FK-shaped key is recorded with `confidence: UNKNOWN` — that
   becomes a `SCHEMA` gap, which is the honest outcome, rather than a join test that fails for the
   wrong reason and gets blamed on the driver.

Persist `stage_progress: {stage: 3, done, total}` into `$KNOWLEDGE_FILE` every
`config.defaults.persist_every_n_items` objects. A compaction mid-stage then resumes instead of
restarting.

```javascript
{ id:"REL-001", from:"VendorBill", to:"Vendor",
  from_col:"Entity", to_col:"InternalId",
  meaning:"Each bill is issued by one vendor",
  confidence:"INFERENCE", source:"customer_evidence",
  evidence_count: 14, tested: false }
```

> A relationship that exists in the business but has **no FK and no discoverable join key** is
> recorded with `confidence:"UNKNOWN"`. That is a `SCHEMA` gap and one of the highest-value
> findings this runtime produces — it means an AI agent could never join those objects correctly
> without being told.

---

## 3.5 Data-range probe — enrichment only

Run one bounded probe per T1-candidate object that has a `date` column:

```sql
SELECT MIN([<date_col>]) AS min_d, MAX([<date_col>]) AS max_d, COUNT(*) AS n FROM [<obj>]
```

```javascript
$DATA_RANGE = { VendorBill: {min:"2013-01-15", max:"2015-06-30", count:6625} }
```

> ## Hard rule — test date windows are NEVER anchored to `$DATA_RANGE`
>
> Anchoring a TC to the probe makes the test environment-specific: the same TC would generate
> different SQL against sandbox versus production, so the run stops being reproducible and stops
> testing the SQL construct it was written to test.
>
> TCs always use the **natural** business window a user would actually say ("last 30 days").
> `$DATA_RANGE` is used only to *interpret* a 0-row result in Stage 9 and to raise a
> `DQ_OBSERVATION`. It never constructs a query.

---

## 3.6 Persist

Write `$KNOWLEDGE_FILE` with `semantic_complete: true` before leaving this stage. Shape:
`artifacts.md` §1. Stage 5 resumes from this flag.

