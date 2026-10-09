# Stage 8 · Targeted Test Generation

**Contents**

- 8.1 Test case schema
- 8.2 Global data-boundary rule — every TC, no exceptions
- 8.2c Data-independence rule — never hardcode IDs
- 8.2d Write tests — act on fixtures, undo with cleanup
- 8.2a CData SQL syntax — the one rule that causes silent driver rejections
- 8.2b Query shape — compose patterns, do not isolate them
- 8.3 Prompt quality gate
- 8.4 Grouping — one pass, every lens
- 8.5 Intent, behavior and procedure TCs
- 8.6 Plan sizing check
- 8.7 Persist — every N tests, not once at the end

Generate tests **only** to close prioritized gaps. Work down P1 → P2 → P3. Before writing a new
TC, always check whether a TC already planned can be extended to close the gap too.

**Start with the script, then edit what it produced:**

```bash
node "<skill>/scripts/generate-tests.mjs" --dir "<dir>"        # add --no-write to preview
```

It walks every uncovered item in `$COVERAGE` — use cases, procedures, behaviors, relationships,
patterns, untested T1/T2 objects — and writes one TC each into `$PLAN_FILE.tc_list`, carrying the
`gap_ids` it closes and the `use_case_ids` / `sp_name` / `behavior` binding Stage 10 credits from.
It reports which live gaps the plan does **not** close, so nothing is dropped silently.

What it cannot do is judge wording. Its prompts are composed from persona jobs-to-be-done, use-case
names and behavior prompt shapes; rewrite any that read thin, and merge TCs it kept separate where
one query genuinely answers both. Enumerating the dimensions is bookkeeping and belongs in code —
missing one whole dimension is exactly the failure a human pass does not catch.

### Two suites — business scenarios and connector conformance (2.2.0)

Management reviewed asn005's Asana plan and found most of it unrealistic, because most of it was
not a use case at all: *"Show me each ProjectFollowers record together with the Workspaces it
belongs to"* is a join check. Every TC now carries `suite`:

| `suite` | What | Prompt | Presented as |
|---|---|---|---|
| `business` | persona everyday questions (first, P1), use cases, workflows, objects with a researched business question | a **draft** with a `brief`; Stage 8.5 rewrites it in the persona's words (07a §8.5.4a) and Stage 8.6 judges it | a business scenario |
| `conformance` | joins, SQL patterns, procedures, write checks, agent behaviours, objects with no business question | composed here in plain words (schema names → the words people use) | a connector check, never a use case |

Patterns are credited from the SQL each test actually sent (Stage 10), so a business scenario that
joins, filters and groups covers those patterns too; conformance tests exist for what the business
scenarios did not reach.

**Test mechanics never go in a prompt.** "Read its current value first … set it back exactly as
you found it", "work out the steps yourself from the connector's own tools", "Work only in
workspace 1209868780107533" — no user says any of it, and saying it coaches the agent being
measured. They live in two fields instead:

- `expected_behavior` — what the judge checks: the old value was read, the change was visible,
  the key was discovered, the edge case was handled.
- `agent_context` — the operating note Stage 9 hands the agent beside the question: test-account
  write rules, the workspace when one is set (07-execution §9.1a). For a catalog write test it says
  the harness restores the record after checking, so the agent must not undo its change; a
  conformance write test keeps "put it back".

**Columns are the ones a person means.** `project()` selects the object's headline columns first —
label, owner, state, key date, key figure, parent (`lib/realism.mjs` `headlineColumns`, or
`object.headline_columns` from Stage 3) — and never a column that describes the API
(`ResourceSubType`, `HtmlNotes`, `ItemURL`). asn005's 22 Tasks queries selected none of the task names.

**Main thread only.** Never shard test generation across agents — they would produce incoherent,
overlapping tests and break the gaps-per-test economics.

---

### A use case the connector cannot do is a limitation probe (3.6)

A business use case that needs a capability marked *not supported* or *not applicable* is planned
with `probe: "limitation"`, `attempts: 1`, `check: {rule: "judge"}` and `not_possible_reason`. It is
dispatched like any other test: what is measured is whether the agent says plainly that it cannot be
done or invents an answer. One that would change data runs only when
`write_policy.execute_irreversible` is true (an agent may try a substitute record); otherwise it is
held with the reason. `execution.probe_limitations: false` holds every probe.

## 8.1 Test case schema

```javascript
{
  id: "TC-001",
  gap_ids: ["GAP-014","GAP-021"],          // MANDATORY — never empty
  uc: "Reproduce invalid-column error",     // 3–6 word business action — a LABEL, for the report
  use_case_ids: ["UC-004","UC-011"],        // MANDATORY when the TC exercises a use case in
                                            // $COVERAGE.use_cases — ids, not the label above.
                                            // Stage 10 credits use-case coverage from THIS field
                                            // and nothing else; omit it and the use case stays
                                            // uncovered however well the test passes.
  business_domain: "Support",
  business_intent: "overdue_case_triage",   // links to $COVERAGE.intents when applicable
  prompt: "Which support cases have been open past their SLA so I can escalate them today?",
  expected_sql: "SELECT [CaseNumber],[Status],[CreatedDate] FROM [Case] WHERE [IsClosed]=false AND [CreatedDate] < '2026-08-26' ORDER BY [CreatedDate] LIMIT 20",
  target_objects: ["Case"],
  target_columns: ["CaseNumber","Status","CreatedDate","IsClosed"],
  relationships: [],
  query_patterns: ["filter_equality","date_literal_range","order_by","limit"],
  expected_semantics: { object:"Case", filter:{open:true, age:"beyond_sla"}, aggregation:null },
  priority: "P1",
  group: "Case Triage",
  group_type: "process",   // process|role|persona|intent|behavior|procedure|schema_sweep|boundary
  sp_name: null,           // REQUIRED when group_type is "procedure" — the exact procedure name
  behavior: null,          // REQUIRED when group_type is "behavior"  — the exact behavior key
  process_group: "Case Management",
  roles: ["Support Agent","Support Manager"],
  access_level: "V",                        // 00-contracts.md §10

  // filled in Stage 9:
  steps: [], status: "ne", time: "0s", est_in: 0, est_out: 0, tool_calls: 0,
  observed: null,       // what the AI ACTUALLY generated — 07-execution.md §9.5a
  owner: null           // "owner-ai" | "owner-driver" | "owner-schema" | "owner-ok"
                        // required whenever status is fail, partial or boundary — 00-contracts.md §4
}
```

`target_objects`, `target_columns`, `relationships` and `query_patterns` are a **prediction** of
what a competent agent will produce from this prompt. They size the plan, link it to gaps, and
give Stage 10 something to compare against.

> **They are not what Stage 10 credits.** Coverage is credited from `observed` — the SQL the
> agent actually sent. Crediting the prediction would claim coverage for constructs that were
> never issued. Where the two differ, the gap stays open and the prompt needs rewriting.

---

## 8.2 Global data-boundary rule — every TC, no exceptions

| Boundary | Rule |
|---|---|
| **Row limit** | `LIMIT 20` (or connector equivalent) unless the TC tests aggregation, where `GROUP BY` supplies its own bound |
| **Date window** | The **natural** window the user would say ("last 30 days", "this quarter"). **Never anchored to `$DATA_RANGE`.** Express it in the style customer evidence shows is actually used — literal `BETWEEN` where date functions are unsupported or unused in practice |
| **Mandatory parent filter** | If an object requires a parent filter (WorkspaceId, ProjectId, CompanyId), include it — *unless* the TC exists specifically to test whether the AI discovers that requirement |

Violating a boundary is a TC design defect, not a runtime problem.

---

## 8.2c Data-independence rule — never hardcode IDs

**A test that embeds a literal ID is a test that breaks on every workspace that is not the one
it was written against.** This applies to every authored field: prompts, `expected_sql` and checks.
(`steps[]` is never authored — Stage 9 fills it from the agent's call log.)

```
✗  WHERE [Id] = 'gid://asana/Task/1234567890'
✗  WHERE [ProjectId] = '42'
✗  WHERE [AccountId] = 'ACC-00123'

✓  LIMIT 20                                      — discovers any row
✓  WHERE [Status] = 'Open' LIMIT 20              — data-independent filter
✓  WHERE [ProjectId] IN (SELECT [Id] FROM [Projects] WHERE [Name] = 'Q3 Roadmap' LIMIT 1)
✓  ORDER BY [CreatedDate] DESC LIMIT 1            — finds the most recent record dynamically
```

**Records a test acts on are fixtures.** A catalog write test acts on a fixture — a record found
in, or seeded into, the test account at Stage 8.0 (`07-execution.md` §9.0b) — referred to as
`{{fixture:<name>.<Field>}}`, never by a literal id. `generate-tests.mjs` renders the bound values.

### 0 rows

Whether a 0-row result is a pass is decided by one rule: `00-contracts.md` §3. Do not restate it.

---

## 8.2d Write tests — act on fixtures, undo with cleanup

A write test changes a fixture and is undone by the harness after the check, never by the agent:

- `check.cleanup_sql` — an UPDATE that restores the values the test changed, run after every attempt.
- `check.cleanup_procedure` — a delete procedure, run through `executeProcedure` once per located
  record, to remove what the test created.

ConnectAI MCP runs no DELETE statement, so a created record with neither cleanup stays in the
account and the report lists it. `steps[]` is filled from the agent's call log at Stage 9; it is
never authored, and no "prior step" is ever added to it.

**If the connector is read-only** (no INSERT/UPDATE/DELETE):
- Do not generate write TCs. Mark all write gaps `NOT_APPLICABLE` with reason
  `"connector exposes no write operations"`, evidenced from `$INSTRUCTIONS` or `column_signals`
  from the driver schema.

---

## 8.2a CData SQL syntax — the one rule that causes silent driver rejections

The CData driver **interprets every SQL function input as either a string or a column
identifier**, so every literal argument must be single-quoted. This is a driver-level rule, not
a connector quirk, and it applies to `expected_sql` in every TC that calls a function.

```sql
✓  DATEADD('d', -30, GETDATE())        ✗  DATEADD(d, -30, GETDATE())
✓  DATENAME('yy', GETDATE())           ✗  DATENAME(yy, GETDATE())
✓  DATEDIFF('day', [Start], [End])     ✗  DATEDIFF(day, [Start], [End])
```

Source: *SQL Function Categories*, CData JDBC driver documentation — confidence `FACT`,
source `vendor_docs`.

**Why this earns its own section.** T-SQL and most tutorials use the unquoted form, so it is the
form a model reaches for by default. The driver rejects it, which surfaces as a `b` step and
attributes to `owner-driver` — and that attribution is wrong. The SQL was malformed, so it is an
AI fault. Encoding the rule here prevents both the failed test and the misattributed blame.

Three function categories exist — **date**, **string** and **math**. Do not enumerate their
members: CData ships dozens per category and one test each is enough (see
`04-coverage-model.md` §5.4). Commonly available, though **always confirm against
`$INSTRUCTIONS` and the connector's own SQL-functions page** before assuming support:

| Category | Typically available |
|---|---|
| Date | `GETDATE` · `DATEADD` · `DATEDIFF` · `DATENAME` · `DATEPART` · `YEAR` · `MONTH` · `DAY` |
| String | `CONCAT` · `SUBSTRING` · `TRIM` · `UPPER` · `LOWER` · `LEN` · `REPLACE` |
| Math | `ROUND` · `ABS` · `CEILING` · `FLOOR` |

Support varies per connector, and it varies **per column** — a function accepted on one date
column can be rejected on a custom field of the same type. When that happens it is a genuine
`owner-driver` or `owner-schema` finding worth reporting, not a test to quietly drop.
---

## 8.2b Query shape — compose patterns, do not isolate them

One test per pattern produces dozens of thin queries that resemble nothing a real user sends.
Measured across 12,603 real MCP SELECT queries, a production query combines **2–4 patterns**
(mean 1.96–3.66 by connector, tail to 9) and projects **7–9 named columns**.

Generate that shape. A single well-built query against a T1 object closes several `QUERY` gaps
at once *and* is a realistic test:

```sql
-- closes: select_projection · filter_equality · filter_date_range · order_by · limit
SELECT [tranid],[trandate],[entity],[usertotal],[approvalstatus]
FROM [transaction]
WHERE [approvalstatus] = 'Pending'
  AND [trandate] BETWEEN '2026-08-01' AND '2026-08-31'
ORDER BY [trandate] DESC
LIMIT 20

-- closes: join_two_table · aggregate_sum_avg_minmax · group_by · filter_date_range
SELECT v.[companyname], COUNT(*) AS bills, SUM(t.[usertotal]) AS total
FROM [transaction] t JOIN [vendor] v ON t.[entity] = v.[id]
WHERE t.[trandate] BETWEEN '2026-07-01' AND '2026-09-30'
GROUP BY v.[companyname]
ORDER BY total DESC
LIMIT 20
```

**Target 3–4 patterns per query.** Below 2 the test is unrealistically thin; above 5 it stops
being diagnostic.

### `expected_sql` is a prediction, never an input

The MCP agent receives **only the `prompt`**. It never sees `expected_sql`, and it generates its
own query cold — that is the entire measurement. `expected_sql` is the yardstick you compare the
result against, and a record of what you believed a competent agent would produce.

So a pattern gets exercised only if the **prompt makes it the natural answer**. You cannot ask
for a SQL construct: the moment a prompt says "use BETWEEN" or "group by vendor", it stops
testing whether the agent can work out what the business question needs, which is the thing
under test.

### Eliciting a pattern through phrasing

| Pattern | Phrasing whose natural answer requires it |
|---|---|
| `select_projection` | name what they want to see — *"the bill number, date, vendor and amount"* |
| `filter_equality` | *"that are still Pending"* |
| `filter_date_range` | *"in Q3"* · *"between July and September"* · *"last month"* |
| `filter_date_boundary` | *"for the September period"* · *"this quarter to date"* |
| `filter_numeric_threshold` | *"over $10,000"* · *"below the reorder point"* |
| `filter_enum` | *"Open or Pending"* |
| `filter_boolean` | *"active"* · *"unpaid"* · *"still open"* |
| `filter_null` | *"with no owner assigned"* · *"missing a due date"* |
| `filter_in` | *"these three specifically: 4471, 4482, 4490"* |
| `filter_like` | *"with 'refund' anywhere in the memo"* |
| `order_by` + `limit` | *"top 10 by amount"* · *"the 5 most recent"* |
| `group_by` + aggregate | *"by vendor"* · *"per department"* · *"broken down by status"* |
| `join_two_table` | name an attribute that lives on the other object — *"with the vendor's name"* |
| `offset_pagination` | *"the second page"* · *"records 21–40"* |
| `select_star_guard` | *"show me everything on <wide object>"* |

Combine three or four of these into one business question and the composed query follows
naturally:

> *"Which vendors did we spend the most with last quarter — show me the vendor name and total,
> top 10, so I can prepare the negotiation list."*
>
> → `join_two_table` · `aggregate_sum_avg_minmax` · `group_by` · `filter_date_range` ·
> `order_by` · `limit`

### What to compose, and what to keep alone

| Compose freely | Isolate |
|---|---|
| projection · filter · `order_by` · `limit` — the ambient shape of nearly every real query | the pattern the TC exists to prove, when it is **new or suspect** for this connector |
| a second filter on a different datatype | anything in Band 3 (`having`, `offset_pagination`, `subquery`, `union`) |
| `group_by` with its aggregate | the first `join` attempted on this connector |
| | any pattern a previous round already failed |

The reason is diagnosis, not elegance. A five-pattern query that fails tells you only that
*something* broke.

### Decompose on failure

When a composed query fails, do not record `fail` and move on — **re-run it stripped to its
simplest failing form**, one pattern removed at a time, and record the reduction as `d` steps.

```
join + group_by + date_range + having   → error
join + group_by + date_range            → 20 rows     ⇒ HAVING is the culprit
```

That converts a vague `fail` into a precise `owner-driver` finding naming the exact unsupported
construct — which is the difference between a bug report someone can act on and one they cannot.
---

## 8.3 Prompt quality gate

Every prompt is a **business decision**, not a data-fetch request. It must make clear *why* the
user needs the data and *what they will do with it*.

```
✗  "Show me journal entries from the last 30 days"
✗  "List open vendor bills"
✗  "Show customers with an overdue balance"

✓  "My period close is tomorrow — which accounts have unposted activity I need to clear?"
✓  "Which vendor bills have been waiting for approval more than 5 days so I can follow up?"
✓  "Build my AR call list: customers 45+ days overdue with no partial payment"
✓  "Before I run payroll, show me employees with no timesheet entries this pay period"
```

At least one anchor must appear:
`before I` · `so I can` · `to identify` · `ahead of` · `I need to` · `flag` · `prioritize` ·
`follow up` · `catch` · `close the` · `my <role task>`

**A draft with none of these is rewritten before it enters the plan.**

### Ground prompts in real use cases — in this order of preference

```
vendor standard reports
  → customer evidence query patterns
    → persona jobs-to-be-done
      → workflow edge cases
        → SQL construct checklist   ← last resort only
```

> The SQL checklist was once the *only* source, and it is the reason generated queries stopped
> resembling real business use. It is now the fallback of last resort, used when nothing above it
> covers the gap.

**Business scenarios carry the relationships too.** The best coverage of a `RELATIONSHIP` gap is
a business scenario that needs the join — *"Show me open bills with vendor names so I can
prioritize this week's payments"* — and Stage 10 credits the join from the SQL it sent. The plain
conformance check (*"Show me each bill alongside the vendor it belongs to"*) is what remains when
no scenario reaches it, and it is labelled as a check rather than dressed up as a use case.

---

## 8.4 Grouping — one pass, every lens

Generate each test once. Grouping is presentation, and the report switches lenses client-side,
so producing a separate test per lens would duplicate work and inflate the count without adding
a single piece of coverage.

Give every TC the fields that make all lenses possible:

| Field | Lens it enables |
|---|---|
| `process_group` | Business Process — the default view |
| `roles[]` + `access_level` | Role |
| `group_type: "persona"` + persona name | Persona |
| `target_objects[]` | Object |
| `gap_ids[]` | Gap Category |

Default `group` to the business process name; the report regroups from these fields on demand.

**Keep persona TCs as their own groups**, titled `"Persona — <name>"` with ids `grp-pe01`,
`grp-pe02`, … Folding them into process groups erases the contrast they exist to show: how the
same underlying data answers different decisions depending on who is asking.

### Deduplicate before the plan is written

Two gaps often want a near-identical query. Compute an SQL fingerprint for each candidate —
lowercased, whitespace-collapsed, literals replaced with `?` — and on a match keep one TC, then
**union its `gap_ids[]`** and its `roles[]`. One test closing three gaps is the goal, not an
accident to be tidied away.

### Permission-boundary TCs

For each role holding `V` or `N` on a domain where `F` exists elsewhere, add one TC attempting a
write, with `group_type: "boundary"`. These close `BEHAVIOR` gaps for `permission_boundary`, so
they carry a `gap_id` like every other test.

### Role × Process matrix

Compute `$COVERAGE_MATRIX[role][process_group] = {count, pass, fail}` from the finished TC list,
always. It is a view over fields every TC already carries, not a separate run.

---

## 8.5 Intent, behavior and procedure TCs

| Type | `group_type` | Must also carry | How |
|---|---|---|---|
| **Intent** | `intent` | `business_intent` | One TC per phrasing, all sharing `business_intent`. Stage 10 compares their resolved SQL for semantic equivalence |
| **Behavior** | `behavior` | `behavior` | Ambiguity (`"Show me the latest stuff"`), unsupported request, invalid input, large-result guarding, empty-result interpretation. Take the key, `prompt_shape` and `pass_when` straight from `$COVERAGE.behaviors` |
| **Procedure** | `procedure` | `sp_name` | One per uncovered SP. Derive parameters from `$PROC_PARAMS`, reusing values seen in earlier TCs |

> **The "Must also carry" column is a crediting contract, not documentation.** Stage 10 credits a
> procedure only through `sp_name`, a behavior only through `behavior`, and a use case only
> through `use_case_ids`. A TC missing its field executes, passes, and credits nothing — the
> dimension reads 0 forever and no error is raised. Asana run 2 lost all 19 procedures, all 10
> behaviors and all 35 use cases exactly this way.

> **If no realistic parameter value can be derived for a procedure, do not fabricate one.** Mark
> the gap `NOT_TESTABLE` with the reason and say so in the report. A test run on invented inputs
> proves nothing and hides the fact that the procedure is unvalidated.

---

## 8.6 Plan sizing check

Generate TCs for **all** gaps (P1 + P2 + P3) in one Stage 8 pass. Never defer a priority tier to
round 2 before execution — deferral decides coverage before the connector has had a chance to prove
itself, and silently inflates round-2 scope with gaps that might have closed trivially.

```
P1 gaps: n → closed by X tests
P2 gaps: n → closed by Y tests
P3 gaps: n → closed by Z tests
Total round-1 tests: X+Y+Z     Gaps closed per test: <ratio>
Objects:  T1 n/n · T2 n/n · T3 n/n · T4 n/n
Patterns: n applicable, n not_applicable (reasons recorded)
```

**Cap:** `generate-tests.mjs` applies `config.defaults.max_tcs` itself, and does it in two stages
rather than one sort. It first reserves a **coverage floor** — one test for every procedure,
object, relationship, pattern and advertised capability the connector exposes — and only then
trims the remaining tail by priority score.

That order matters more than it looks. Priority descends from gap scores, and gap scores rise when
customer evidence corroborates a gap, so a single priority sort made a capped plan depend on
whether a dump happened to exist: the same connector at the same cap kept a different set of
tests. The floor is computed from the connector's own surface, which no dump can move.

If the floor alone exceeds the cap, the script keeps the floor and says so — a plan that silently
skips procedures is the failure this whole audit exists to prevent. See `tests/dump-parity.test.mjs`.

- **Ratio near 1.0** → the tests are too narrow. Merge them.
- **Any gap with no planned test** → either write one, or reclassify it `NOT_TESTABLE`
  with a reason. **Silent omission is never acceptable — this applies to P3 as much as P1.**

---

## 8.7 Persist — every N tests, not once at the end

Write `$PLAN_FILE` with `stage_progress: {stage: 8, done, total_gaps_targeted}` every
`config.defaults.persist_every_n_items` test cases drafted, and once more on completion with
`stage_progress` removed and `planned_tests[]` written back onto each gap in `$GAPS_FILE`.
Shape: `artifacts.md` §4.

A compaction two-thirds through generation used to lose every drafted test. Now it loses at most
the last few.

Stage 9 reads `$PLAN_FILE` as authoritative and **never executes from context memory alone**.

