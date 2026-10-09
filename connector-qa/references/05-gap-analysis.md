# Stages 6–7 · Gap Analysis and Prioritization

**Contents**

- Stage 6 — GAP ANALYSIS
  - 6.1 A gap is computed, not brainstormed — so a script computes it
  - 6.2 Gap record
  - 6.2a Rubric for `business_importance`
  - 6.3 The pre-execution set is permanent
- Stage 7 — Gap Prioritization
  - 7.1 Score — by script
  - 7.2 Then answer the only question that matters
  - 7.3 Persist

Prerequisite: `00-contracts.md` §6 (gap categories), `04-coverage-model.md` §5.2 (objectives).

---

## Stage 6 — GAP ANALYSIS

> ### Checkpoint before starting
> **No business test has executed yet.** If any has, the architecture has been violated — stop
> and report it rather than continuing.

### 6.1 A gap is computed, not brainstormed — so a script computes it

```bash
node "<skill>/scripts/compute-gaps.mjs" \
  --knowledge "$KNOWLEDGE_FILE" --coverage "$COVERAGE_FILE" --out "$GAPS_FILE" --round 0
```

The definition it implements:

```
FOR each objective O in $OBJECTIVES applicable to item I:
    IF $COVERAGE does not satisfy O for I
       AND I is not NOT_APPLICABLE and not NOT_TESTABLE
    THEN emit a gap
```

It walks all **nine** categories in `00-contracts.md` §6 — including `EXPOSURE`, which
reconciles Stage 2's vendor domains against Stage 1's connector objects — and writes the
**discovery funnel** into `$COVERAGE_FILE`. On a 40-object connector a model could walk this loop;
on a 500-object one it drops rows and nothing notices. That is why it is code.

The script emits **skeletons**. Read its printed summary — not the full file — and then fill
exactly two fields on every new gap: `description` (one sentence, ≤ 160 characters) and
`business_importance` by the rubric in §6.2a. Nothing else on a gap is yours to set here.

### 6.2 Gap record

```javascript
{
  id: "GAP-014",
  category: "CUSTOMER",                      // 00-contracts.md §6
  description: "'Invalid column name' error cluster (152 occurrences) never reproduced",
  impacted: { objects:["Case"], columns:["Status__c"], relationships:[], patterns:[] },
  tier: "T1",
  business_importance: "HIGH",               // HIGH | MEDIUM | LOW
  evidence: "customer_evidence: 152 failing production queries, 3 distinct columns",
  evidence_strength: "STRONG",               // STRONG (measured) | MEDIUM (documented) | WEAK (inferred)
  detected_round: 0,                         // 0 = pre-execution
  priority: null, priority_score: null,      // filled in Stage 7
  planned_tests: [],                         // filled in Stage 8
  final_status: "OPEN"                       // 00-contracts.md §6
}
```

### 6.2a Rubric for `business_importance`

This field carries a weight of 3 in the priority score, so it needs a rule, not a feeling:

| Value | Give it when |
|---|---|
| `HIGH` | a vendor standard report depends on it · a persona's stated job-to-be-done cannot be done without it · it is a known production failure · it involves money, compliance or a write · it is the `EXPOSURE` of a whole domain |
| `MEDIUM` | a documented workflow uses it but a workaround exists · it is a T2 object's normal operation · it is a relationship between two T1/T2 objects |
| `LOW` | supporting or lookup data · a pattern the measured prior puts under 1% · anything a reader would not miss if it stayed untested for a release |

Torn between two levels on a T1 object, choose the higher; on a T3/T4 object, the lower.

### 6.3 The pre-execution set is permanent

**Report the pre-execution gap set verbatim.** Stage 12 shows the gaps that existed *before* any
test ran — that is the diagnostic value of the whole exercise. **Never retroactively delete a gap
because it was later closed.** Set `final_status` instead.

The script logs, for example:
```
GAP ANALYSIS — round 0: 45 new gap(s), 45 total
  BEHAVIOR 3 · BUSINESS 4 · CUSTOMER 3 · EXPOSURE 1 · INTENT 2 · PROCEDURE 1 · QUERY 27 · RELATIONSHIP 1 · SCHEMA 3
FUNNEL  vendor domains 3 (1 with NO connector object) · connector objects 5 · meaning FACT 2 / INFERENCE 2 / UNKNOWN 1 · T1+T2 3
ASSESSMENT CONFIDENCE 60%
```

The `EXPOSURE` line is the one that did not exist before: a vendor domain with no connector
object, counted and named, instead of vanishing from every denominator.

---

## Stage 7 — Gap Prioritization

### 7.1 Score — by script

```bash
node "<skill>/scripts/score-gaps.mjs" --gaps "$GAPS_FILE" --knowledge "$KNOWLEDGE_FILE"
```

It **refuses** to run while any gap lacks `business_importance` and lists them, so an unscored
gap can never quietly become P4. The formula it applies:

```
priority_score = tier_weight        (T1=4 · T2=3 · T3=2 · T4=1)
               + importance_weight  (HIGH=3 · MEDIUM=2 · LOW=1)
               + evidence_weight    (STRONG=3 · MEDIUM=2 · WEAK=1)
                                     ── no-dump floor: a T1 gap with no customer evidence
                                        scores MEDIUM at minimum, never WEAK ──
               + risk_weight        (+2 known production failure
                                     +2 EXPOSURE of a vendor standard report — a shipped
                                        report no customer can run is a production failure
                                     +1 write / permission / data-integrity
                                     +1 touches a Band-1 pattern)
               + dependency_weight  (+1 blocks another gap — relationships always do)
               − cost_weight        (−1 needs many tests, or parameter values unavailable)
```

> **Why the no-dump floor exists.** Without a dump nothing can be STRONG, so every T1 gap on a
> no-dump connector used to land at P3 and be deferred — on exactly the connectors where inference
> runs unchecked. The floor makes "no evidence" mean "documented", not "unimportant".

Each gap keeps `score_terms` so the report can show why it landed where it did.

| Score | Priority |
|---|---|
| ≥11 | **P1** |
| 8–10 | **P2** |
| 5–7 | **P3** |
| ≤4 | **P4** — closed only by a test that already exists |

Stage 8 plans P1–P3 in one pass (`06-test-generation.md` §8.6); there are no rounds.

### 7.2 Then answer the only question that matters

> **What is the minimum set of tests that closes every P1 and P2 gap?**

Maximize gaps closed per test. One well-designed test legitimately closes several gaps — a
persona-driven join across two T1 objects with a date filter and an aggregation can close a
`BUSINESS`, a `RELATIONSHIP` and two `QUERY` gaps at once.

**Never invent a fixed test count.** A plan padded to a round number is a worse plan.

### 7.3 Persist

`score-gaps.mjs` sets `prioritized: true` itself once every gap is scored. Shape: `artifacts.md`
§3. Stage 8 resumes from this flag. If the script exits non-zero, return to the last step of §6.1.
