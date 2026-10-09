# Stage 8.5 · Pre-Execution Review

**Contents**

- Why this stage exists
- 8.5.0 Prepare the package
- 8.5.1 What the reviewer receives
- 8.5.2 First job — close the completeness table
- 8.5.3 Research
- 8.5.4a First job — write the business scenarios
- 8.5.4 Review the tests you were given
- 8.5.5 Output — a patch, never the whole plan
- 8.5.6 Merge
- 8.5.7 Export the JDBC suite
- 8.5.8 Gate — proceed or block
- 8.6 The realism gate — would a real person ask this?

**Model: `config.models.tc_review` (default: `opus`).** The orchestrator stays on its own model.

**When:** after Stage 8 writes `$PLAN_FILE`, before Stage 9 executes.
Skip only when `config.defaults.skip_tc_review` is `true`.

**Capability mode:** this stage does not run for catalog tests. They are born approved; the
catalog's own coverage review, realism judge and human sample (`11-catalog.md`) replace it. If a
reviewer does see catalog tests, it must not change their `persona` or `business_domain` — those
come from the frozen catalog.

---

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

## Why this stage exists

Every stage before this one reasons from the **gap ledger** the pipeline built. `compute-gaps`
writes it, `generate-tests` consumes it. If the ledger is wrong, every downstream stage inherits
the error and none of them can see it — they are all reading the same wrong thing.

That is exactly what run asn004 was. The ledger claimed the procedures were covered (its
`planned_tests` pointed at tests that no longer existed), so the generator skipped them, so the
review found nothing wrong with the tests that *did* exist, and a read-only assessment of a
read-write connector shipped as 96% healthy. Every stage did its job correctly against a corrupt
premise.

**So this stage checks the plan against the CONNECTOR and the BUSINESS, not against the pipeline.**
It is the only place that can catch a plan that is internally consistent and wrong.

It is also the last cheap moment. A missing test found here costs a prompt; found after Stage 9 it
costs the whole run.

---

## 8.5.0 Prepare the package

```bash
node "<skill>/scripts/review-prep.mjs" --dir "$ROOT/$CONNECTOR"
```

Counting is arithmetic and belongs in a script; only judgement needs a model. `review-prep.mjs`
computes every denominator, clusters the duplicate query shapes, and writes the reviewer's input.

It emits **one package** when the inputs fit a single call, or **N shards** when they do not —
decided on measured size, not on a test count, because a connector with a rich schema and long
prompts reaches the ceiling sooner than one with the same test count and a thin schema.

> **Sharding does not divide the context.** Surface, research, use cases, the completeness table
> and the duplicate clusters are **global and identical in every shard**; only the test bodies
> split. A shard is told "these items have no test *anywhere in the plan*" — it never infers that
> from its own slice, which would invent gaps that other shards cover. The script asserts that the
> shard assignment is a true partition: a test reviewed twice wastes a call, a test reviewed zero
> times is the silent hole this stage exists to prevent.

Append the start marker to the jsonl checkpoint before dispatching, so a compaction mid-review
resumes here rather than routing to Stage 9 with an unreviewed plan:

```json
{"type":"stage_start","key":"stage_8_5","started_at":"<ISO timestamp>"}
```

---

## 8.5.1 What the reviewer receives

Everything in `{connector}_review_input.json` (or each shard). Pass the file; do not summarise it.

| Input | Why |
|---|---|
| **surface** — objects with columns and roles, procedures with parameters, relationships with join keys, advertised capabilities, `instructions_raw` | what the connector actually exposes |
| **research** — workflow domains and their edge cases, personas and jobs-to-be-done, roles and the access matrix | what the business actually does with it. **This was never passed before**, and without it the reviewer cannot judge whether a prompt is realistic for the person supposedly asking |
| **use_cases** | what someone would actually ask |
| **test_cases** — prompts, no `expected_sql` | what we wrote |
| **completeness** — ten dimensions, each with surface count, covered count, and the named untested items | computed mechanically, so the reviewer argues with facts rather than producing them |
| **shared_query_shapes** | use cases whose tests send the same query |
| **persona_jobs** | listed, deliberately not scored |

### Two deliberate omissions

**`gaps.json` is not passed.** It is the pipeline's own reasoning about what to test. Given it, the
reviewer validates the plan against the ledger — and a wrong ledger validates a wrong plan. That is
asn004's `tcs_added: 0`. Withheld, the reviewer must judge the tests against the connector and the
research directly. Gap ids are attached afterwards by `review-merge.mjs`.

**`expected_sql` is not passed.** The reviewer judges whether the natural-language prompt is strong
enough to elicit the right query, not whether it matches a known answer.

Both are the same rule: **never hand a reviewer the answer key that produced the thing it is
checking.**

---

## 8.5.2 First job — close the completeness table

The table arrives computed. **The job is to close it, not restate it.**

| Dimension | Covered when |
|---|---|
| objects | the object is queried by at least one test |
| procedures | the procedure is invoked |
| capabilities | every advertised capability is exercised at least once |
| relationships | the join is tested |
| query patterns | the pattern appears in a test |
| **use cases** | a test exists **that could only pass if this use case works** — see below |
| agent behaviors | the behaviour is probed |
| **workflows** | every step in the workflow has TC coverage — see §8.5.2a |
| **personas** | at least one test is written from that persona's point of view |
| **roles** | a test exercises a domain that role can reach |

The bottom three did not exist before. asn005 passed its audit with **64 workflows and 0 workflow
tests**, because workflows were not a dimension. A reviewer can only report on what it is asked to
count.

### 8.5.2a Workflow-traversal gate — steps, not just names

A workflow test that only invokes the terminal step proves nothing about the workflow. A workflow
named "Approve and pay vendor bill" is not covered by a test that queries paid bills — it is
covered only when **each step in the workflow's path has at least one TC that exercises it**:

```
workflow: "Approve and pay vendor bill"
  step 1 — CREATE a draft bill                → TC covering INSERT on VendorBill
  step 2 — SUBMIT for approval                → TC covering UPDATE of approval status
  step 3 — APPROVE                            → TC covering approval state transition
  step 4 — MARK as paid                       → TC covering INSERT on VendorPayment (or UPDATE)
  step 5 — VERIFY payment appears on AR ledger → TC covering SELECT with join to payment
```

For every **write** workflow (permission: "write") in the research output:
1. Enumerate the steps from the workflow's `edge_cases` and domain knowledge.
2. Map each step to the operation it requires: CREATE → INSERT, UPDATE, state transition, or JOIN.
3. Check whether the plan contains a TC that exercises that operation on the correct object.
4. For any step with no TC: **add** one (or **BLOCK** Stage 9 if writing to that object is not
   permitted for this run — see §8.5.8).

For **read** workflows (permission: "read"): coverage of the final read is sufficient.

**This is a step-level check, not a workflow-name check.** A plan that names the workflow in a
test's `uc` field but never fires an INSERT has not covered the write workflow's most important
risk — that writes work at all.

### 8.5.2b Data-independence audit

Before passing the plan to Stage 9, check every TC prompt and `expected_sql` for hardcoded IDs.

**A hardcoded ID makes a test brittle and non-repeatable:**

```
✗  WHERE [Id] = 'gid://asana/Task/1234567890'          — will fail on a different workspace
✗  WHERE [ProjectId] = '42'                            — tenant-specific; nobody else has this
✓  WHERE [ProjectId] IN (SELECT [Id] FROM [Projects] WHERE [Name] = 'Acme Q3 Plan' LIMIT 1)
✓  LIMIT 20                                             — discovers existing rows, any ID
```

For each TC that contains a literal ID in its `expected_sql` or in its `prompt`:
- **WEAKEN** the prompt to ask for the record by a descriptive attribute, not by a known ID.
- Replace the ID filter in `expected_sql` with a subquery or a named-attribute filter.
- If the TC exists specifically to test a known-ID lookup (e.g., `filter_in`), refer to a fixture
  (`{{fixture:<name>.<Field>}}`, bound at Stage 8.0), not a hardcoded id. `steps[]` is filled from
  the agent's log at Stage 9 and is never authored.

**0 rows:** one rule decides it — `00-contracts.md` §3. Do not restate it.

### Use-case coverage is judged, not counted

A use case is **not** covered because a test carries its name. asn005 has **77 use-case tests
sharing 14 distinct queries** — twelve different use cases all resolving to the same
`SELECT … FROM Projects`, every one of them counted as covered.

`shared_query_shapes` lists these clusters. For each: are these genuinely distinct business
questions that happen to start from the same read, or is this one test wearing several names?
Where they are the same, write the tests that actually distinguish them — a use case about
*duplicating a project* and one about *reordering its sections* cannot both be a plain select.

### Writing the missing tests

Name the hole **and fill it**. `added: []` is a valid outcome only when the table was already
clean. Where a test genuinely cannot exist, say so per dimension and name the blocker — *"Forms are
not exposed through this connector's API"* is a blocker; *"this would be slow"* is not.

Every object and procedure you name must exist in the surface you were given.
`review-merge.mjs` rejects additions that reference anything else, because a test against an object
the connector does not expose can only fail, and it would be filed as a connector defect.

> **A capability the run chose not to exercise is not out of scope.** A procedure that mutates data
> the connector cannot delete is planned, reported, and left unexecuted with `executable: false`
> and an `nt_reason` — it stays in the denominator as uncovered. Dropping it from the plan is what
> made the Asana write surface invisible. See `00-contracts.md` §3 on `na` vs `nt`.

---

## 8.5.3 Research

Research what the audit raised — a procedure whose parameters are undocumented, a capability the
vendor describes differently from the connector, a workflow whose edge cases are not visible in the
schema. Record each as a finding with `source`, `insight` and `action_taken`. A finding that
identifies a real-world scenario with no test becomes a new test.

**Research fresh each run.** Prior findings are loaded **only under `--rerun`**, which is the
operator explicitly asserting the connector has not changed. Otherwise a report can carry a
conclusion nobody re-checked, presented as this run's evidence — the connector gets rebuilt, the
vendor changes a quota, and a finding from weeks ago is silently still being believed. Reused
findings keep the `run_id` they came from so their age is visible in the report.

If web search is unavailable, say so in `web_search: false` rather than skipping quietly.

---

## 8.5.4a First job — write the business scenarios

Do this before anything else in the review. Management read asn005's Asana plan and found most of
it unrealistic — "Show me each ProjectFollowers record together with the Workspaces it belongs
to", "Change the Archived on one Projects record … then set it back exactly as you found it". The
generator cannot write the way a person talks; you can.

Every test with `suite: "business"` and `prompt_status: "draft"` arrives with a `brief`: the
persona (name, archetype, what they do all day), the goal, the things involved in the words people
use for them (`brief.things[].words`), the details a person means by "show me" them, and the scope
the reference query applies. The package lists them in `business_writing.drafts`. For each one,
write the question **that persona would actually ask, on an ordinary day**, and return it in
`modified` with the same id:

| Draft (generator) | Rewritten (you) |
|---|---|
| As a Project Manager, show me our projects that are still not archived and already past their due date. | Which of my projects are past their due date and still open? |
| I need to create and assign a task with a due date. | Create a task to send the launch checklist to Priya, due this Friday. |
| Show me our tasks that are still not completed and due within the next week. | What's on my plate this week that I haven't finished yet? |

Rules — `realism-check.mjs` enforces the mechanical ones and the judge scores the rest:

- **The persona's words.** No table, column or procedure names; `brief.things[].words` gives the
  words people use. No ids, no SQL vocabulary.
- **No instructions to the AI.** "Read it back", "say plainly", "do not invent", "work out the
  steps yourself" are the harness talking. Anything the test must check goes in
  `expected_behavior` (you may edit it); the write rules and workspace are in `agent_context`,
  which you may not change.
- **Keep the scope.** If the draft says "due within the next week", the rewrite still means that,
  or the reference query no longer matches the question.
- **Concrete where a person is concrete** — a real-sounding name, a day, a project — but never an
  id the person would have to look up.
- Prompts with `prompt_status: "research"` came verbatim from the persona researcher's everyday
  questions; polish them only if they fail the rules.
- A draft you judge already right goes in `accepted_business: ["TC-…"]`. A draft left in neither
  list stays a draft, and the realism gate (§8.6) stops the run — "reviewed and unchanged" and
  "never reached" look identical otherwise.

Conformance tests (`suite: "conformance"`) are connector checks — joins, SQL patterns, procedures,
write checks. Fix them if they leak an id or an instruction to the agent, but do not dress them up
as business questions: the report labels them as checks, and that honesty is the point.

## 8.5.4 Review the tests you were given

For each test in your shard:

**Prompt quality.** Would this prompt elicit the right query from an agent that has never seen this
connector? It must read like a person asking, carry enough specificity to be answerable, and name
no column or table the person would not know.

**Risk flags.** Flag anything likely to be slow, gated behind a plan, destructive, or dependent on
data that may not exist: `premium_required`, `required_filter`, `mutating`, `irreversible_write`,
`pushdown_risk`.

**Duplicates.** The clusters are given to you. Propose merges; do not assume them. State which to
keep, which to drop, and why. **A wrong merge is a lost test** — `review-merge.mjs` refuses merges
with no reason, merges naming a non-existent test, and any beyond 5% of the plan, on the grounds
that a reviewer proposing to delete more than that has misunderstood its job.

---

## 8.5.5 Output — a patch, never the whole plan

The reviewer used to return `updated_tc_list`, the entire plan rewritten, and the orchestrator did
`tc_list = updated_tc_list`. A **replace**. A reviewer that ran out of room at test 180 of 237 left
the plan silently holding 180 tests. Nothing errored. The file stayed valid, just smaller.

Return only what changed:

```json
{
  "shard": { "index": 1, "of": 1 },
  "reviewed_ids": ["TC-001", "TC-002", "…"],
  "counts": { "reviewed": 237, "modified": 12, "added": 8, "merges": 2, "blocked": 1, "weakened": 3 },

  "modified": [
    { "id": "TC-001", "prompt": "…", "reason": "was ambiguous about the date window" },
    { "id": "TC-014", "prompt": "What's on my plate this week that I haven't finished yet?",
      "expected_behavior": ["returns open tasks due in the next 7 days", "shows name, project and due date"],
      "reason": "business draft rewritten in the Individual Contributor's words (§8.5.4a)" },
    { "id": "TC-042", "risk_flag": "premium_required", "reason": "Goals needs an Advanced plan" }
  ],
  "accepted_business": ["TC-031"],
  "added": [
    { "uc": "…", "prompt": "…", "target_objects": ["Tasks"],
      "query_patterns": ["select_projection", "limit"],
      "persona": "Executive Sponsor", "dimension": "personas",
      "reason": "no test served this persona" }
  ],
  "weakened": [
    { "id": "TC-015", "reason": "hardcoded ProjectId '42' replaced with subquery filter",
      "prompt": "…updated prompt…", "expected_sql_note": "replace literal ID with subquery" }
  ],
  "blocked": [
    { "id": "TC-088", "reason": "irreversible_write on object that cannot be deleted; move to nt_reason",
      "action": "set executable:false, nt_reason:'No delete operation available for Invoices'" }
  ],
  "merges": [
    { "keep": "TC-005", "drop": "TC-200", "reason": "same question, weaker phrasing" }
  ],
  "completeness_response": [
    { "dimension": "workflows", "action": "added 6 tests covering 4 write workflow steps" },
    { "dimension": "use cases", "blocker": "Forms are not exposed through this connector's API" }
  ],
  "dimension_coverage_matrix": {
    "objects":       { "total": 34, "covered": 28, "pct": 82 },
    "procedures":    { "total":  8, "covered":  8, "pct": 100 },
    "relationships": { "total": 12, "covered":  9, "pct": 75 },
    "use_cases":     { "total": 22, "covered": 18, "pct": 82 },
    "workflows":     { "total": 15, "covered": 13, "pct": 87 },
    "personas":      { "total":  4, "covered":  4, "pct": 100 },
    "roles":         { "total":  3, "covered":  3, "pct": 100 },
    "behaviors":     { "total": 12, "covered":  9, "pct": 75 }
  },
  "web_findings": [
    { "source": "…", "insight": "…", "action_taken": "…" }
  ],
  "web_search": true
}
```

### Three output categories — not two

Previous reviews only had `modified` and `added`. The full set:

| Category | When to use | Effect |
|---|---|---|
| **`modified`** | prompt quality, risk flags, metadata corrections | changes the TC in place |
| **`added`** | missing coverage for a dimension, workflow step, persona or role | new TC appended to plan |
| **`weakened`** | TC has a hardcoded ID that makes it brittle; §8.5.2b applies | prompt and expected_sql note updated; test stays in plan |
| **`blocked`** | TC is an irreversible write with no corresponding delete, or requires a resource that cannot be cleaned up; cannot safely execute | sets `executable: false` and `nt_reason`; TC stays in denominator as uncovered |

**`blocked` is not a delete.** The TC stays in the plan and in the coverage denominator as
`NOT_TESTABLE`. Removing it hides the gap; blocking it keeps it visible. The report will show it
as uncovered with the reason — that is the difference between "we know we cannot test this yet"
and silently dropping a write surface.

### Dimension coverage matrix — the gate

After applying all patches, compute the matrix above for every dimension.

**If any required dimension is below 80% after all adds are applied, Stage 9 does not start.**
Append a `gate_verdict` to the output:

```json
"gate_verdict": {
  "pass": false,
  "failing_dimensions": [
    { "dimension": "relationships", "pct": 75, "required": 80,
      "gap": "3 relationships have no TC: Tasks→Projects, Tasks→Tags, Sections→Projects" }
  ],
  "action": "BLOCK — add TCs for the listed gaps before proceeding to Stage 9"
}
```

When `pass: false`, the orchestrator must address the listed gaps before proceeding. This is not
advisory. A plan that enters Stage 9 with known dimension gaps will deliver a report that
misrepresents coverage — exactly the failure asn005 demonstrated.

When `pass: true`:
```json
"gate_verdict": { "pass": true, "all_dimensions_pct": { "min": 82, "weakest": "relationships" } }
```

`counts` is not decoration. A truncated patch is still valid JSON and is otherwise
indistinguishable from a reviewer that had little to say — the declared numbers are what make
truncation detectable.

Fields you may change on an existing test: `prompt`, `uc`, `risk_flag`, `target_objects`,
`target_columns`, `query_patterns`, `roles`, `persona`, `business_domain`, `priority`, `note`.
Anything else is ignored. `expected_sql` is not among them: a reviewer that never saw it must not
be able to rewrite it. In capability mode, never change `persona` or `business_domain` on a
catalog test — they come from the frozen catalog.

---

## 8.5.6 Merge

```bash
node "<skill>/scripts/review-merge.mjs" --dir "$ROOT/$CONNECTOR" \
     --patch "<patch file or directory>" --model opus
```

It verifies before it applies, and refuses rather than guessing:

1. **every shard returned** — 1..N, naming any that did not
2. **every test reviewed exactly once** — naming the unreviewed
3. **declared counts match the patch** — the truncation check
4. **additions reference real objects and procedures**

Then it applies the patch, maps the new tests back to gaps by object, pattern and use case,
assigns `batch_id` (a deterministic partition, not a judgement — it used to be a model job for no
reason), stamps `plan.reviewed_at` and `plan.review_model`, writes `$TC_REVIEW_FILE`, and appends
`tc_review_summary` to the checkpoint.

> **A new test that maps to no gap is itself a finding**, recorded in `unmapped_additions`: the gap
> analysis missed something the reviewer found by reading the connector directly. That is the
> signal that would have surfaced asn005's untested workflows — there are no workflow gaps in the
> ledger at all, so no reviewer reading the ledger could ever have noticed.

`plan.reviewed_at` and `$TC_REVIEW_FILE` are what `detect-stage.mjs` uses to tell a completed
review from an interrupted one. `review-merge.mjs` writes both; nothing else should.

---

## 8.5.7 Export the JDBC suite

The plan is final here, so this is where it is written:

```bash
node "<skill>/scripts/export-jdbc-suite.mjs" --dir "$ROOT/$CONNECTOR"
```

It derives entirely from the plan and owes nothing to execution, so producing it now lets the
driver be verified directly — on a JDBC runner, in CI, by an engineer — *in parallel with* the MCP
run, or instead of it. Left until Stage 12 it would arrive only after the expensive part was paid
for. If `skip_tc_review` is true and this stage never runs, export straight after Stage 8: the rule
is **as soon as the plan stops changing**.

---

## 8.5.8 Gate — proceed or block

After `review-merge.mjs` applies the patch:

1. **Run the dimension coverage matrix check** (§8.5.5 `dimension_coverage_matrix`).
2. If any dimension is below 80%: **BLOCK** — log the failing dimensions, do not proceed to
   Stage 9. The orchestrator must generate the missing TCs and re-run Stage 8.5.
3. If all dimensions are ≥80%: **proceed** to Stage 8.6, the realism gate.

The 80% threshold is a floor, not a target. A connector with rich research may reach higher;
a connector with very few objects or workflows may have a natural ceiling — record it. The
threshold is never reduced to make the gate pass.

**Exception: a connector with fewer than 5 documented objects.** For micro-connectors, the
dimension coverage check still runs, but the threshold is 100% (every object must be covered),
because with 3–4 objects there is no statistical case for missing any.

Log one line, then proceed to Stage 8.6:

```
✓ Stage 8.5 — 237 reviewed · 12 modified · 8 added · 3 weakened · 1 blocked · 2 merged · 3 dimensions closed · gate PASS (min 82%) · JDBC suite exported
```

Or, when blocked:

```
✗ Stage 8.5 — gate BLOCK — relationships 75% < 80% — 3 TCs needed before Stage 9
```

---

## 8.6 The realism gate — would a real person ask this?

### Realism judge — Stage 8.6

One `general-purpose` subagent with `model: config.models.realism_judge`, in a fresh context, given
only `<Connector>_realism_input.json` (prompts, personas, goals, rubric — no SQL, no gaps). It must
be at least as capable as `tc_review` and never the same context: the writer scoring its own
prompts measures its confidence. `fable` is the strongest judge but needs 30-day data retention on
the account; `opus` is the shipped default. Record `run_meta.models.realism_judge`.
`config.defaults.realism.enforce: false` turns the gate into a warning.

Coverage says every object, pattern and procedure is touched. It cannot say whether anyone would
ever ask the question — and a fully covered plan of prompts nobody would type is how asn005 ended
up in front of management. So the business scenarios are judged before anything runs.

```bash
node "<skill>/scripts/realism-check.mjs" --dir "<dir>" --prep
```

That writes `<Connector>_realism_input.json`: every business prompt with its persona, goal and
`expected_behavior`, plus the rubric. **Not** the SQL, the gaps or the writer's notes — the judge
scores the question, not the bookkeeping behind it.

Dispatch `Agent(subagent_type: "general-purpose", model: config.models.realism_judge)` in a fresh
context with that file and its instructions. The judge must be at least as capable as the writer
(`tc_review`) and must not be the same context — a writer scoring its own prompts measures its
confidence, not their realism. It returns
`{"model", "scores": [{"id", "score": 1-5, "criteria": {…}, "issues": [], "suggestion": ""}]}`
for every id, and does not rewrite anything. Persist it to `_agent_out/stage8_6-realism.json`
before returning, as every agent does. Then:

```bash
node "<skill>/scripts/realism-check.mjs" --dir "<dir>" --merge "<dir>/_agent_out/stage8_6-realism.json" --model <judge>
```

| Rubric criterion | Asks |
|---|---|
| persona_fit | would THIS persona, doing their job, ask it? |
| real_goal | is there a decision or task behind it, not data for its own sake? |
| natural_wording | their words — no schema, ids, SQL or instructions to an AI? |
| everyday | asked routinely, not an edge case invented to exercise a feature? |
| answerable | could the system plausibly answer it from its own data? |

**Exit 3 blocks Stage 9** while `config.defaults.realism.enforce` is true, when any business test is
unscored, still fails lint, scores below `realism.min_score` (default 4), or is still a draft.
For a block: send the failing ids with the judge's `issues` and `suggestion` back through the
Stage 8.5 writer (a patch touching only those ids), then re-run `--prep`, the judge, and `--merge`.
A prompt rewritten after it was scored counts as unscored — a score is for a wording.

Conformance tests are linted for raw ids and harness phrases only and are never judged: they are
connector checks, and the report labels them that way.

Log one line, then proceed to Stage 9:

```
✓ Stage 8.6 — 117 business scenarios judged by opus · mean 4.4/5 · 117 passing at ≥4 · 82 conformance checks linted
```
