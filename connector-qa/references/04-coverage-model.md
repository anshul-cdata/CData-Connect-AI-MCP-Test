# Stage 5 · Object Tiering and the Coverage Model

**Contents**

- 5.1 Object tiering — derived from the business model, never from usage
- 5.2 Coverage objectives — what "covered" MUST mean per tier
- 5.3 Build `$COVERAGE` — all seven dimensions
- 5.3a Applying the tiering
- 5.3b Before leaving Stage 5 — check the vocabulary
- 5.4 Dimension E — decide applicability *before* testing
- 5.5 Dimension F — NL / intent coverage
- 5.6 Dimension G — agent behavior coverage
- 5.7 Persist — as you go, not at the end

Prerequisite: `00-contracts.md` §2 (coverage states), §7 (tiers), §8 (column roles).

---

## 5.1 Object tiering — derived from the business model, never from usage

Score every object. **No connector-specific object name appears anywhere in this skill.**

> **Tiering ranks by what the connector is *for*, not by what anyone has queried.**
> This runtime tests connectors on behalf of the vendor who ships them, to every customer,
> including the ones who have not arrived yet. An object nobody has queried is not unimportant —
> it is the place an undiscovered defect survives longest. So customer evidence is a *tiebreak*,
> never a gate, and its absence is never a penalty. Every signal below is computable before a
> single business query runs, which is what lets a connector nobody has used be ranked at all.

| Signal | Weight | Source |
|---|---|---|
| Subject of a **write** workflow | +4 | Stage 2.1 |
| Subject of a **read** workflow | +3 | Stage 2.1 |
| Named in a vendor standard report | +3 | Stage 2.1 |
| **Relationship centrality** — inbound FK count ÷ 3, capped | +0…3 | Stage 3.4 |
| **Role reach** — share of roles holding `F`/`E` on its domain: >50% → +2, >25% → +1 | +0…2 | Stage 2.3 |
| Category `core` | +2 | Stage 3.2 |
| **Persona coupling** — one per distinct persona naming it (by name, spaced name or Stage 3 `synonyms`), capped | +0…2 | Stage 2.2 |
| **Prevalence** — `core` +3 · `common` +1 · `specialised` 0 · `premium` −2; object-level `prevalence` overrides its domain's | −2…+3 | Stage 2.1 |
| Category `lookup` or `audit` with no workflow of its own | −2 | Stage 3.2 |
| Top 10% of `object_frequency` in customer evidence *(tiebreak only)* | +1 | Stage 4 |

**Prevalence (2.2.0)** is how widely customers use the business area, decided from the product —
which plans include it, how central the vendor's own getting-started material makes it — never
from any customer's usage, so dump parity holds. Without it asn005 tiered Allocations, an
Enterprise add-on, beside Tasks. **A domain where every role reads `N`** is a research defect, not
a permission model; role reach is recorded as *unknown* (weight 0) there and a warning is printed,
rather than silently costing every object in the domain its reach.

Three of these are new, and each answers a question usage data cannot:

- **Relationship centrality is graded, not a threshold.** An object with 40 inbound foreign keys
  and one with 2 are not equally central, and a flat "+1 if ≥2" said they were. In a 500-object
  schema the FK graph is the schema's own statement of what everything else depends on.
- **Role reach** was researched in Stage 2.3 and then used only for test authoring. An object
  every role may edit is load-bearing; one a single admin role touches is peripheral.
- **Write workflows outrank read ones.** A mutating path carries more risk per test than a
  reporting path over the same object.

| Score | Tier |
|---|---|
| ≥10 | **T1** Business Critical |
| 7–9 | **T2** Frequently Used / Important |
| 4–6 | **T3** Supporting |
| ≤3 | **T4** Technical / Lookup |

Record `tier`, `tier_score` and the `tier_signals[]` that fired. The report shows *why* an object
was tiered, so a reviewer can disagree with the evidence rather than with a black box.

### FK-elevation rule — T2-floor for FK targets of T1/T2 objects

An object that is referenced by a foreign key from a T1 or T2 object is load-bearing for every
join test of that T1/T2 object. If it is tiered T3 or T4, join tests will be planned at lower
priority — producing a plan where `join_inner` on a T1 object has no column coverage for its JOIN
partner.

**After initial scoring, apply the FK-elevation rule as a post-pass:**

1. For every T1 and T2 object, read its `relationships[]` from `{C}_driver_schema.json` or
   the discovered relationship list in `$KNOWLEDGE_FILE`.
2. For every object that appears as the `to` target of a FK from a T1 or T2 object: if its
   current tier is T3 or T4, **elevate it to T2** and record `tier_signals: ["fk_elevation_from:SourceObject"]`.
3. Re-run column loading: every newly elevated T2 object must have `columns_loaded: true`.

This is a hard floor, not a scoring signal. The FK graph can be cyclic; apply elevation in one
forward pass — do not iteratively chase transitive FKs.

```
Example: Tasks (T1, score:11) has FK ProjectId → Projects (score:5, T3).
         Projects → elevated to T2. tier_signals: ["score:5","fk_elevation_from:Tasks"]
         Column loading now required for Projects.
```

**After tiering (including FK elevation), top up column loading** (Stage 1.2): every T1 and T2
object must have `columns_loaded: true`, or carry a `SCHEMA` gap.

### Tier self-check — a cheap detector for the collapse tiering can hide

Tiering is the denominator for deep coverage, and it is self-assigned. A critical object scored
T4 because it had no workflow reference and a `lookup`-looking name is "covered" by never being
queried. So before leaving Stage 5, probe **two random T3 and two random T4 objects** with one
bounded metadata read each (`getColumns` — no business query):

| Signal on a T3/T4 object | Action |
|---|---|
| ≥ 8 important-role columns | re-score it; it looks like T2 |
| a `measure` **and** a `date` column | re-score it; lookups do not carry amounts over time |
| referenced by a persona's job-to-be-done in text but not in `table_refs` | re-score and fix the domain's `table_refs` |

Record each probe as a `TIERING` entry in `$DQ_OBSERVATIONS` whether or not it changed anything.
The report shows the check happened. Four probes cost almost nothing; a mis-tiered T1 object
that reads as covered costs the run its credibility.

The weights above are constants with no calibration record yet. Record, per run, how many objects
the self-check re-tiered — once several connectors have run, that number is the calibration signal.

---

## 5.2 Coverage objectives — what "covered" MUST mean per tier

**This table is the spine of the whole runtime.** A gap is defined as
`required (by this table) − actually covered`. Without explicit objectives, "gap" is unfalsifiable
and every coverage percentage is a vibe.

| Dimension | T1 Business Critical | T2 Important | T3 Supporting | T4 Technical |
|---|---|---|---|---|
| **A. Object** | queried + semantically understood | queried | ≥1 successful query | **≥1 successful query** |
| **B. Column** | ≥80% of *important* columns exercised | ≥50% | identifier + every `status`, `date` and `measure` column | **identifier + every `status`, `date` and `measure` column** |
| **C. Relationship** | every declared relationship tested | ≥1 tested | — | — |
| **D. Business use case** | ≥2 distinct real use cases | ≥1 | representative | — |
| **E. Query pattern** | filter · date · aggregation · join · null-handling · sort/top-N — subject to §5.4, but never below the Band 1 floor | filter + 1 more applicable | filter | — |
| **F. NL / intent** | ≥1 intent with ≥2 phrasings | — | — | — |
| **G. Agent behavior** | ≥3 behaviors across the connector (not per object) | — | — | — |

Store as `$OBJECTIVES`.

> An objective may be waived **only** by marking the item `NOT_APPLICABLE` with a written reason.
> Never by silently dropping it.

### NOT_APPLICABLE constraint — what qualifies and what does not

`NOT_APPLICABLE` means the objective **cannot be satisfied by design**, not that it would be hard
to satisfy, or that no one has asked for it yet. Every `NOT_APPLICABLE` must name a structural
reason traceable to the connector's schema or the vendor's documentation.

| Valid reason for NOT_APPLICABLE | Example |
|---|---|
| The connector exposes no objects of this type | "No procedure objects returned by getProcedures()" |
| The column role required by the pattern does not exist on any T1/T2 object | "No date column on any T1 object — filter_date_range NA" |
| The capability is explicitly excluded in the vendor's documentation or `$INSTRUCTIONS` | "DELETE is not supported; documented in connector guide p.12" |
| The relationship dimension requires at least one FK; none is declared | "zero relationships in driver schema and getTables() — join_inner NA" |

| NOT valid reason for NOT_APPLICABLE | Why it fails |
|---|---|
| "No customer evidence showed this pattern" | Absence of evidence is not evidence of absence; customer evidence cannot remove applicability |
| "AI judged it unlikely to be used" | Structural facts decide applicability, not inference |
| "The object is T3/T4" | Tier decides depth, not whether — even T4 must be queried once |
| "We couldn't find a good test case" | That is a test generation problem, not an NA |
| "The test would be slow" | A risk flag, not a structural exclusion |

A `NOT_APPLICABLE` that does not name a structural reason is treated as an open gap by
`credit-coverage.mjs`. The discrepancy is reported as a `COVERAGE_MODEL` finding.

**No tier has an objective of zero.** T4 previously required only a metadata probe and no column
coverage at all, which meant a mis-tiered object could read as covered while never being queried
— and on a 500-object connector most objects land T3/T4, so that exempted most of the surface.
Every object now gets at least one executed query, and every object's identifier plus its
`status`, `date` and `measure` columns must appear in one. Those three roles are where drivers
actually break: date pushdown, boolean mapping, numeric truncation. Tier decides **how deep**,
never **whether**.

---

## 5.3 Build `$COVERAGE` — all seven dimensions

Object state is a lattice (`00-contracts.md` §2), not a boolean.

```javascript
$COVERAGE = {
  objectives_met: false,

  // A — tables / views / procedures kept as SEPARATE populations
  objects: {
    tables:     { total:N,
                  by_tier:{ T1:{total,covered,failed,na,nt}, T2:{...}, T3:{...}, T4:{...} },
                  rows:[{name,tier,state,tc_ids:[],columns_covered,columns_important}] },
    views:      { /* same shape */ },
    procedures: { total:N,
                  rows:[{name,state,params_total,params_required_tested,
                         param_combos_tested,tc_ids:[]}] }
  },

  // B — important columns only
  columns: { total_important:N, covered:M,
    by_role:{ identifier:{t,c}, date:{t,c}, status:{t,c}, dimension:{t,c},
              measure:{t,c}, relationship_key:{t,c}, descriptive:{t,c} },
    rows:[{object,column,role,state,tc_ids:[]}] },

  // C
  relationships: { total:N, tested:M,
    rows:[{id,from,to,on,state,confidence,tc_ids:[]}] },

  // D
  use_cases: { total:N, covered:M,
    rows:[{id,name,domain,persona,objects:[],
           source:"vendor_report"|"workflow"|"customer_evidence"|"ai_inference",
           state,tc_ids:[]}] },

  // E
  patterns: { rows:[{pattern,applicable:true|false,applicability_reason,
                     customer_frequency,state,tc_ids:[]}] },

  // F
  intents: { rows:[{id,canonical,phrasings:[],objects:[],state,
                    semantic_match:true|false,tc_ids:[]}] },

  // G
  behaviors: { rows:[{behavior,applicable,state,tc_ids:[]}] }
};
```

---

## 5.3a Applying the tiering

```bash
node "<skill>/scripts/tier-objects.mjs" --dir "$ROOT/$CONNECTOR" --apply
```

Scores every object against the weights in §5.1 and writes `tier`, `tier_score` and `tier_signals`.
**Without `--apply` it prints the proposed tiering and writes nothing** — the tiering can be reviewed
before it rewrites the coverage model. An explicit `--connector` that names nothing present is an
error, never a silent retarget onto whatever the directory happens to hold.

---

## 5.3b Before leaving Stage 5 — check the vocabulary

```bash
node "<skill>/scripts/validate-model.mjs" --dir "$ROOT/$CONNECTOR" --stage 5
```

Every behaviour name, pattern name and coverage state this stage writes is read by a script that
knows a fixed set of them. Invent one and nothing fails: the model is valid, the plan is valid, and
the tests are nonsense. asn005 named ten behaviours of which the generator recognised three, and
seven tests shipped with the literal word "undefined" as the question put to the agent.

The names live in `scripts/lib/vocabulary.mjs`. Adding a behaviour means adding it there **and**
giving it a prompt in `generate-tests.mjs` — a name with no prompt is a test with no question.

---

## 5.4 Dimension E — decide applicability *before* testing

**Never blind-test every SQL pattern on every connector.** For each candidate pattern decide
`applicable`, using this priority:

1. `$INSTRUCTIONS` states it is unsupported → `false`, confidence `FACT`
2. The connector's **advertised capabilities** — `delete` absent from the catalog's permission
   list makes the `delete` pattern `false`, confidence `FACT`
3. **Schema structure** — the pattern needs a column role or relationship the schema does not
   have (see the table in §5.4 *Marking a pattern NOT_APPLICABLE*). Structure is observable from
   `getColumns` and the declared relationships, so this decides the same way on every run
4. Connector / driver documentation
5. AI inference

**Customer evidence is deliberately absent from this list.** Applicability is a statement about
what the connector *can do*, which does not change according to whether someone handed us a query
dump. Evidence enters at two points only, both of which can add coverage and neither of which can
remove it:

- it **contradicts an exclusion** — a pattern marked inapplicable while real queries use it is a
  contradiction, and the evidence wins;
- it **raises priority** on a gap that already exists.

> **Invariant:** the set of `applicable` patterns must be identical whether or not Stage 4 ran.
> `tests/dump-parity.test.mjs` runs the pipeline both ways and asserts it. A connector with no
> dump is not a connector with fewer capabilities — and it is precisely the connector where
> inference runs unchecked, so it deserves *more* scrutiny, not less.

**Candidate patterns, by family:**

| Family | Patterns |
|---|---|
| Projection | `select_projection` · `select_star_guard` · `distinct` |
| Filter — by datatype | `filter_equality` · `filter_comparison` · `filter_in` · `filter_like` · `filter_null` · `filter_date_range` · `filter_date_boundary` · `filter_numeric_threshold` · `filter_boolean` · `filter_enum` |
| Filter — logic | `filter_and` · `filter_or` · `filter_logic_grouped` · `filter_negation` · `filter_nested_deep` |
| Shaping | `order_by` · `limit` · `offset_pagination` |
| Aggregation | `aggregate_count` · `aggregate_sum_avg_minmax` · `group_by` · `having` |
| Relational | `join_inner` · `join_left` · `join_multi_table` · `join_self` · `join_right_full_cross` · `subquery` · `union` |
| Expression | `case_when` · `date_function` · `string_function` · `math_function` |
| Write / call | `stored_procedure` · `insert` · `update` · `delete` |

### Projection: measured reality

Across 12,603 real SELECT queries, **93–99% use an explicit column list**, averaging 7–9
columns (one Salesforce query projected 79). `SELECT *` is 0.9–6.7%.

So the two projection patterns test different things:

- **`select_projection`** — the realistic default. Every TC should project 5–10 named columns,
  because that is what the driver actually receives in production. It also tests whether the
  driver pushes the column list down to the source or fetches everything and filters locally.
- **`select_star_guard`** — a deliberate probe, not a default: issue `SELECT *` on a wide T1
  object and observe. Does the agent add a bound, warn about volume, or pull every column? Does
  the driver cope with a 200-column object? This closes a `BEHAVIOR` gap
  (`large_result_guarding`), not a query-pattern gap.

Writing `SELECT *` as the normal shape would test a query almost nobody sends.

**Record `applicability_reason` for every `false`.** The report prints these, and an unexplained
exclusion is indistinguishable from an oversight.

> A pattern marked inapplicable on AI inference alone while customer evidence shows real usage is
> a **contradiction** — resolve toward the evidence.

### Filters are tested per datatype, not once

A connector that filters strings correctly can still mangle dates, and reporting lives or dies on
date and numeric filtering. Cover a filter **per important column role**, not once per object.
Derive the matrix from the roles assigned in `02-semantic-schema.md` §3.3:

| Column role | Pattern | Shape to generate | What it actually probes |
|---|---|---|---|
| `date` | `filter_date_range` | `[d] BETWEEN '2026-01-01' AND '2026-03-31'` | Does the driver push a date range down, and does it accept ISO literals? |
| `date` | `filter_date_boundary` | month / quarter / period start-end | Off-by-one at boundaries, and whether period tables are needed |
| `measure` | `filter_numeric_threshold` | `[Amount] > 1000`, `>=`, `BETWEEN` | Decimal precision, and comparison on a currency column |
| `status` | `filter_enum` | `[Status] IN ('Open','Pending')` | Picklist values accepted as sent, case sensitivity |
| `status` (bool) | `filter_boolean` | `[IsActive] = true` | Representation drift — `true` vs `1` vs `'T'` vs `'Y'` |
| `descriptive` | `filter_like` | `[Memo] LIKE '%invoice%'` | Wildcard support and pushdown |
| `identifier` | `filter_in` | `[Id] IN (…)` | Batch lookup and list-length limits |
| any nullable | `filter_null` | `[Owner] IS NULL` | Three-valued logic, and whether NULL is even representable |

**Datatype fidelity is a `DQ_OBSERVATION`, not a pattern.** When a filter works but the *values*
are wrong, record it in Stage 10 — these are the findings reporting teams care most about and
that a pass/fail verdict alone would hide:

- a date column typed `VARCHAR`, so ordering and range filters are lexical rather than temporal
- a `datetime` returning shifted values — the source stores UTC, the report reads local
- a decimal losing precision, or an amount arriving as a string
- a boolean surfacing as `"true"`/`"T"`/`1` inconsistently across objects
- an enum whose stored value differs from its display label, so the obvious filter returns 0 rows

---

### The floor — what runs on every connector regardless

Applicability decides what is *worth* testing. It must not become a way to shrink the
denominator until coverage looks good. These three bands set the boundary.

**Band 1 — unconditional. Never `NOT_APPLICABLE`, on any connector.**

| Pattern | Why it cannot be waived |
|---|---|
| `select` | A connector that cannot SELECT is not a connector |
| `filter_equality` | 81–98% of all measured real traffic. Everything else is built on it |
| `limit` | The data-boundary rule (`06-test-generation.md` §8.2) puts it in every TC anyway |
| `order_by` | Needs only one sortable column, which every object has |
| `empty_result_interpretation` *(behavior)* | 13–65% of real queries return nothing |

If one of these genuinely fails, that is the **headline P1 finding of the whole run** — record it
as `FAILED`, never as `NOT_APPLICABLE`. The distinction is the difference between "this connector
is broken" and "we decided not to look."

**Band 2 — conditional, and the condition must be *structural and named*.**

Mark one `NOT_APPLICABLE` only by naming the missing structure, never by opinion:

| Pattern | Only inapplicable when |
|---|---|
| `filter_comparison`, `date_literal_range` | no date or numeric column on any T1 object |
| `filter_null` | no nullable important column |
| `filter_in` | no identifier column |
| `filter_and`, `filter_or`, `filter_logic_grouped` | fewer than two filterable columns on any T1 object |
| `join_inner`, `join_left` | zero discoverable relationships — itself a `SCHEMA` gap worth reporting |
| `join_multi_table` | fewer than two relationships reachable from one T1 object |
| `aggregate_count`, `group_by` | no dimension column |
| `aggregate_sum_avg_minmax` | no measure column |
| `stored_procedure` | `getProcedures()` returned none |
| `insert`, `update`, `delete` | writes not exposed by the connector |

"The AI judged it unlikely" is not a structural condition. If the structure exists, the pattern
is tested — and if the driver then rejects it, that is a finding, which is the point.

**Band 3 — evidence-gated. Default `NOT_APPLICABLE`; opt in with a positive reason.**

`having` · `offset_pagination` · `subquery` · `union` · `distinct` · `date_function` ·
`string_function` · `math_function` · `case_when` · `join_self` · `join_right_full_cross` ·
`filter_negation` · `filter_nested_deep`

Test one of these only when evidence shows real usage, `$INSTRUCTIONS` documents it, or a T1
use case genuinely requires it. The prior below explains why the default is off.

`join_right_full_cross` deserves a note: `RIGHT`, `FULL` and `CROSS JOIN` appear **zero times in
13,617 measured queries**. That is the strongest `NOT_APPLICABLE` evidence in the whole set —
record it with that reason rather than leaving it to look like an oversight.

**Sanity check before leaving Stage 5.** If more than half of Band 1 + Band 2 came out
`NOT_APPLICABLE`, the applicability pass was too aggressive — re-examine it. A connector with
almost no applicable patterns is far more likely to be a bad analysis than a bad connector.

---

### Prior — what real MCP traffic actually looks like

**This matters most when there is no dump**, because that is exactly when inference runs
unchecked — and inference is what these numbers contradict.

Measured across 13,826 real MCP queries spanning four connectors (NetSuite SuiteQL, NetSuite
SuiteTalk, Salesforce, QuickBooks Online):

| Signal | Measured | The naive prior, and why it is wrong |
|---|---|---|
| `date_function` (`GETDATE`, `DATEADD`, `YEAR`…) | **under 1%** | Models reach for `DATEADD('d',-30,GETDATE())` by habit. Real users bind date parameters or use literal ranges |
| `parameterized` (`@p`) | **79–95%** | Generated SQL inlines literals; real traffic binds them. Literal-dependent patterns look absent when they are merely bound |
| `having` · `offset_pagination` · `subquery` · `union` · `distinct` | **under 1% each** | Classic SQL-checklist rows. Each costs a test and reduces no real risk |
| `update` | up to **49%** (SuiteTalk) | Writes get treated as an optional extra; on some connectors they are most of the traffic |
| filter · `order_by` · `limit` · join · `aggregate_count` | **27–98%** | Where the risk actually lives |
| `join_multi_table` (2+ JOIN clauses) | **10–26%** of *all* queries | Treated as exotic. On NetSuite SuiteQL a **3-table join is more common than a 2-table one** (37 vs 26) |
| `join_left` | **~40% of all joins** | Treated as a variant of INNER. It is where row-preservation semantics break |
| `join_right_full_cross` | **0 of 13,617** | Included by SQL-completeness habit; nobody sends them |
| `filter_logic_grouped` (`A AND (B OR C)`) | **6–26%** | Where predicate pushdown quietly fails |
| `filter_negation` (`NOT IN`, `NOT LIKE`, `<>`) | **under 4%**, `NOT IN` ≈ 0% | A checklist favourite; barely used |

### Joins: what to actually test

Where relationships exist, cover **three** things, not one:

| Test | What breaks |
|---|---|
| `join_inner` on a known relationship | the join key itself — wrong FK, or no pushdown |
| `join_left` where the right side is legitimately missing for some rows | **whether unmatched rows survive.** A driver that silently degrades `LEFT` to `INNER` returns a plausible, wrong answer — the worst failure mode there is, because nothing errors |
| `join_multi_table` across 3 objects | pushdown falling apart at arity. Watch `Duration`: a 3-join that is 10× slower than its 2-join parent means the driver stopped pushing down and started joining client-side |

The `LEFT JOIN` row-preservation check is the single highest-value join test, and it needs a
prompt that makes unmatched rows the point — *"which invoices have no matching payment?"* rather
than *"show invoices with payments"*.

Treat this as a **prior on priority, not a verdict on applicability.** Rarity orders the tail of
the plan; it never empties it. `join_right_full_cross` appearing 0 times in 13,617 queries makes
it the last join test worth writing — not one to skip, because a driver that mis-handles it still
ships a defect.

**Absence of a dump is never evidence of absence.** Marking `date_function` inapplicable because
no dump proves anyone used it inverts the burden of proof: it makes the least-observed connectors
the least-tested ones. The pattern is applicable when the structure supports it — a date column
exists and the driver advertises expressions — and the rarity table then decides where it sits in
the order. Where a connector's own evidence disagrees with an exclusion, the evidence wins.

### Function categories are tested for syntax, not enumerated

`date_function`, `string_function` and `math_function` are single patterns each, deliberately.
CData exposes dozens of functions per category and enumerating them would generate dozens of
near-identical tests for capabilities almost nobody uses. One test per applicable category, using
a function that category's real users would reach for, is sufficient.

The exception worth encoding is **syntax**, not coverage — see `06-test-generation.md` §8.2a.

---

## 5.5 Dimension F — NL / intent coverage

For each T1 object, define ≥1 canonical intent with ≥2 phrasings a real person would type:

```javascript
{ id:"INT-001", canonical:"overdue_invoices", objects:["Invoice"],
  phrasings:["Show overdue invoices",
             "Which invoices haven't been paid by their due date?",
             "Find invoices that are past due"] }
```

**Judge semantic correctness, not SQL string equality.** Two queries are equivalent when they
resolve the same target object(s), the same filter semantics and the same aggregation. Column
order, alias names, literal formatting and join style are all irrelevant.

---

## 5.6 Dimension G — agent behavior coverage

Connector-level, not per object. A behavior is testable only if it has a prompt shape, a pass
criterion and an owner when it fails — a name alone gets tested inconsistently or not at all.

| Behavior | Prompt shape | Passes when | Fails to |
|---|---|---|---|
| `empty_result_interpretation` **(mandatory)** | a legitimate question whose answer is 0 rows | agent says "none found" and does **not** fabricate or widen the query | `owner-ai` |
| `wrong_column_recovery` | a question whose obvious column name is wrong for this connector | agent hits the error, calls `getColumns`, re-issues correctly | `owner-ai` if it guesses again; `owner-schema` if metadata misled it |
| `wrong_table_recovery` | a question using a business term that maps to a differently-named object | agent discovers the right object via `getTables`/instructions | as above |
| `ambiguity_handling` | *"show me the latest stuff"* / a term that fits two objects | agent asks or states its assumption before querying | `owner-ai` |
| `unsupported_request_handling` | a request the connector cannot serve (write on a read-only object, a Band-3 construct marked unsupported) | agent explains the limit instead of retrying blindly | `owner-ai` |
| `invalid_input_handling` | a nonsense id or impossible filter | 0 rows or a clear error, no hallucinated rows | `owner-ai` |
| `large_result_guarding` | *"show me everything on <wide object>"* | agent bounds or warns before pulling | `owner-ai`; `owner-driver` if the driver cannot cap |
| `pagination_handling` | *"the second page"* | agent uses OFFSET or an equivalent, or says the connector cannot | `owner-driver` if unsupported |
| `permission_boundary` | a write from a `V`/`N` role | blocked with a clear message | `owner-driver` if the write goes through |
| `retry_behavior` | a query that hits a transient error | agent retries once, then reports | `owner-ai` |
| `schema_discovery` | first query of the run on an unfamiliar object | agent consults metadata before guessing | `owner-ai` |
| `query_correction` | any `f`→`d`→`p` journey | covered whenever a self-correction succeeds | — |

> **`empty_result_interpretation` is mandatory for every connector.** Real dumps show 13–65% of
> production queries return zero rows, so how the agent narrates an empty result is a first-class
> risk, not an edge case.

---

## 5.7 Persist — as you go, not at the end

Write `$COVERAGE_FILE` with `stage_progress: {stage: 5, done, total}` every
`config.defaults.persist_every_n_items` objects while tiering, and once more on completion with
`stage_progress` removed. Shape: `artifacts.md` §2. Stage 6 resumes from its existence.

A stage that persists only when it finishes loses all of itself to a compaction. Stage 9 was
given per-test persistence for exactly this reason; the same reasoning applies here.
