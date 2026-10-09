# Stage 9 · MCP Execution

**Contents**

- 9.0a Fair conditions — before anything is dispatched
- 9.0b Test data — use what exists, create only what is missing (3.7)
- 9.0 The write gate — run this before anything is dispatched
- 9.1 Startup
- 9.2 Two-phase execution — the 0-row fallback
- 9.3b Multi-step tests — a workflow is judged on the job, not the last step
- 9.3 Verdicts and fault ownership
- 9.4 Transient errors retry; only fatal ones cascade
- 9.5 Checkpoint — append one line per test
- 9.5a Record what the AI actually generated
- 9.6 Track during the run

Prerequisite: `00-contracts.md` §3 (verdicts), §4 (fault ownership), §5 (step types).

**Two roles, two contexts.** The *agent under test* generates the SQL; the *orchestrator* judges
it. When `config.models.isolate_execution` is true (default), each test is dispatched to a fresh
subagent that sees only the prompt and the MCP tools — never the plan, never `expected_sql`,
never the previous test. The orchestrator stays in the main thread for everything that must be
consistent and ordered: classifying the returned call log into steps, assigning verdict and
owner, and appending the checkpoint line. Dispatch runs in **parallel batches** of
`config.defaults.parallel_batch_size` (default: 5) TCs — each batch fires concurrently, the
orchestrator waits for all agents in the batch to finish, classifies their results, and appends
checkpoint lines before dispatching the next batch. Checkpoint writes remain sequential within
each batch so ordering is stable.

Why isolate: if the orchestrator plays the agent itself, the same context that wrote
`expected_sql` is the one "answering cold", and the separation is a rule rather than a boundary.
Isolation also lets `under_test` be a different model from the orchestrator — the model your
production agents actually run — which is the only way the measurement is of the right thing.

---

## 9.0a Fair conditions — before anything is dispatched

Two checks keep the environment out of the result.

```bash
node "<skill>/scripts/check-harness.mjs" --server <MCP server id> --project "<project dir>"
```

Lists the connector tools that are not on the permission allow list. In auto mode the permission
classifier can refuse those at random, so an attempt fails for reasons that are neither the
model's nor the connector's. **Ask the user** to allow them (one rule, `mcp__<server id>`, covers
all). Never edit the settings yourself. A result whose attempt was refused by the harness and did
not end correct is not reused: `scope.mjs prepare-run` runs it again.

```bash
node "<skill>/scripts/preflight-data.mjs" prep --dir "<dir>" --me <connection user id>
```

Run every listed reference query through `queryData`, write `{"checks":[{"tc","rows","error"}]}`,
then `preflight-data.mjs merge --checks <file>`. A read test whose reference finds nothing is held
(`executable: false`, `data_hold: true`): any answer would be unverifiable and the attempts would be
paid for and measure nothing. Seed the data in the test account (with the user's agreement — it
is a write) and run `prep` again, or `release` the test to run it anyway.

The list covers read tests, every test with `check.data_sql` (a judged question, an action on an
existing record), and actions that only change existing records — their record must exist (3.5).
`merge` then prints each business area's **readiness**: how many of its use cases can test the AI
on this account. **`AREA NOT READY`** means fewer than `execution.area_ready_min` can: stop and
ask the user to seed data, switch to an account that has the area's features, or run anyway
knowing the report will mostly describe the account. Never decide it yourself. (asn-tr1: Asana's
test plan had no time tracking or resource management, so 3 of 43 use cases tested the AI.)

## 9.0b Test data — use what exists, create only what is missing (3.7)

This is **Stage 8.0**, run in capability mode before `generate-tests.mjs` (Stage 8). The router
sends a run here (it prints stage 8) while any fixture in scope was never looked for. For a frozen
area whose use cases use fixtures (`--me` is `run_meta.me` from Stage 1):

1. `test-data.mjs find-prep --dir "<dir>" --areas <A> --me <user id>` → run each `find_sql` through
   `queryData` → `find-merge --checks <file>`. Repeat until `find-prep` lists nothing: a fixture
   that lives under another is looked for once its parent is bound.
2. `seed-prep` lists the INSERTs for fixtures still missing, with their parents' real ids. **Show
   them to the user and run them (`execute_insert`) only after a yes.** `seed-merge` records each
   result; a refusal for the account's plan or rights marks the fixture *refused*.
3. Run find again to bind what was created. `test-data.mjs status` shows, per area, found ·
   seeded · missing · refused and how many use cases have their data.

`generate-tests.mjs` then writes every request and check with the bound records. A use case whose
fixture is missing is held as *no test data*; one whose fixture the account refused is *blocked by
the account* — neither is dispatched, and both run once their data exists. The records bound are
part of the run's environment, so results on other records are never mixed with these.

## 9.0 The write gate — run this before anything is dispatched

```bash
node "<skill>/scripts/preflight-writes.mjs" --dir "<dir>"
```

**Exit 3 means nothing runs.** Not the mutating tests, not the read-only ones — the run stops and
the reason goes to the user. Exit 0 means the target is settled and Stage 9 proceeds.

**The pinned-workspace gate is opt-in (2.2.0).** Connectors are tested against test accounts, so
by default (`write_policy.require_workspace_pin: false`) the script only refuses a write that is
not flagged `mutates: true`, lists the objects that will be written and any irreversible writes,
and exits 0. A `workspace` that is set is still passed to the agent in `agent_context`. Turn the
strict gate below on with `require_workspace_pin: true`, `run_meta.require_workspace_pin: true`
for a single run, or `--strict`. Everything in the rest of this section describes strict mode.

A mutating test says *what* to change and never says *where*. The Asana plan reached this stage
with 61 tests flagged `mutates: true`, 47 of them irreversible, and not one naming a workspace id
— 47 said the word "workspace" in their prompt, which reads like a constraint and is not one. The
catalog reaches four workspaces and one is a production organization, so the agent under test
would have chosen the write target itself and the report would have called it a clean pass,
because nothing was measuring where the records landed.

The policy meant to prevent exactly this held the sentence *"test environment — confirmed by the
operator; residue is acceptable there"*. A policy no code can evaluate is a note.

The gate refuses unless all four hold:

| | |
|---|---|
| a workspace id is pinned | `run_meta.workspace` (this run) or `config.defaults.write_policy.workspace` (standing default). The run-level pin wins |
| discovery captured the catalog | `run_meta.workspace_catalog` — `[{id, name, is_organization}]`. An unverified id is refused, not trusted |
| the pin is in it and is not an organization | a real id spelled correctly is still wrong if it is the production org |
| every mutating test carries the pin | in its `agent_context` (2.2.0) or prompt — otherwise the operator chose a workspace the agent was never told about |

A plan that writes nothing, or whose mutating tests are all held back with `executable: false`,
passes without a pin — it risks nothing, and a gate that fires when it need not is one people
learn to bypass.

## 9.1 Startup

Read `$PLAN_FILE`. Use its `tc_list` as the **authoritative** list.

### 9.1 Pre-execution deduplication — conservative, priority-safe

Before dispatching any TC, run one final deduplication pass. This is a safety net — Stages 8.4
and 8.5 already deduplicate, but new TCs added by the reviewer or edge-case merges can leave
residual duplicates.

Compute a **fingerprint** for each TC: lowercase `expected_sql`, whitespace collapsed, literals
→ `?`. Group TCs that share a fingerprint.

For each group of 2+ TCs with the same fingerprint, mark the lower-priority TC for removal
**only when all of these hold**:

| Condition | Required |
|---|---|
| Same fingerprint | ✓ must match |
| Survivor's `gap_ids[]` fully contains the candidate's `gap_ids[]` | ✓ must be a superset — if the candidate has even one gap_id the survivor does not, keep both |
| Candidate's priority is strictly lower (P3 < P2 < P1) | ✓ higher-priority TC always survives |
| Candidate's `group_type` is not `boundary`, `behavior`, or `procedure` | ✓ these test behavior, not data — same SQL can be two different tests |
| Candidate's `business_intent` matches the survivor's | ✓ same SQL answering a different business intent tests intent coverage, not a duplicate |

**Never remove a TC when any of:**
- It is `priority: "P1"` — P1 TCs are never deduplicated away, regardless of fingerprint match
- It is the **sole** TC covering any gap_id in its list
- Its `group_type` is `boundary`, `behavior`, or `procedure`
- The fingerprint match is from a **different round** (a round-2 rewrite of a round-1 failure is intentional — keep both)

When removing a TC: union its `gap_ids[]` onto the surviving TC, then log to the checkpoint:
```json
{"type":"dedup","removed_tc":"TC-047","kept_tc":"TC-022",
 "unioned_gap_ids":["GAP-031"],"reason":"identical fingerprint, subset gaps, P3 vs P2"}
```

After the pass, re-write `$PLAN_FILE.tc_list` and log one line:
```
Pre-exec dedup: 3 TCs removed · 0 P1/P2 affected · 6 gap_ids redistributed onto survivors
```
If nothing was removed, log `Pre-exec dedup: no duplicates found` and proceed.

Skip any TC id that already has a `tc` record in the checkpoint (resume mode).

**A TC dispatched but never recorded is recovered, then re-dispatched — never waited on.**
A `batch_dispatched` record with no matching `tc` record means the batch was cut off mid-flight.
Waiting for those results is the wrong instruction and used to deadlock the run: the compaction
that interrupted the batch also destroyed the context the agent would have returned into, so the
result can never arrive. Those TCs were then neither terminal nor re-dispatchable, and the router
routed to Stage 9 forever. On a long connector that silently drops ~6 tests per compaction.

Resume in this order:

1. **Merge `_agent_out/<run id>/`.** Stage 9 agents write their call log to
   `<connectorDir>/_agent_out/<run id>/stage9-<TC-id>-a<N>.json` *before* returning it (one folder
   per run, so an eval's models never overwrite each other). Any file there for a TC with no `tc`
   record is a completed attempt whose result was stranded — classify and checkpoint it from the
   file. No connector call, no re-run.
2. **Re-dispatch the rest — attempt by attempt.** A TC's `tc` checkpoint line is written after its
   *last* attempt. On resume, re-dispatch only the attempts with no `stage9-<TC>-a<N>.json`; never
   repeat an attempt that left a file. Every remaining `batch_dispatched` id with neither a `tc`
   record nor any attempt file genuinely never finished. Dispatch it again.

Include the write-to-disk instruction in every Stage 9 dispatch prompt. See §9.5 for how
duplicate checkpoint records are handled.

Fire each `prompt` **cold** against the MCP connector. Do not pre-feed the expected SQL — the
run is measuring what the AI does with a business question, not whether it can copy a query.

### Isolated subagent per test — Stage 9 execution

When `config.models.isolate_execution` is true (the default), **each test case is dispatched to
a fresh `general-purpose` subagent** with `model: config.models.under_test` (omit when `session`),
one at a time, in plan order. The subagent receives **only**:

- the natural-language `prompt`,
- the instruction to answer it using the connector's MCP tools, and
- the instruction to return a verbatim log of every MCP call it made — tool, input, and the
  result or error text — plus its final answer to the user.

It receives **nothing else**: not the plan, not `expected_sql`, not the gap it closes, not the
journey of the previous test. That is what makes the run a measurement rather than a
self-graded exercise — the author of the test and the agent under test are different contexts,
and the agent's model is whatever you set as `under_test`, independent of the orchestrator's.

The **orchestrator** then does what only it should: classifies each logged call as `p`/`f`/`b`/`d`
from the raw log (`references/00-contracts.md` §5), assigns the verdict and owner, records
`observed.sql`, appends the jsonl checkpoint line, and moves to the next test. Sequential dispatch
keeps checkpoint ordering and MCP state exactly as before; only the *generation of the SQL* moves
out of the orchestrator's head.

Set `isolate_execution: false` to run Stage 9 in the main thread as before. Do that only when
subagent dispatch is unavailable — and record it in `run_meta.execution_mode`, because a
self-executed run is a weaker measurement and the report should say so.

### 9.1a The subagent brief (isolated mode)

**Before dispatching each batch**, append a batch-dispatched marker to the checkpoint:
```json
{"type":"batch_dispatched","batch_id":"B3","tc_ids":["TC-016","TC-017","TC-018","TC-019","TC-020"],"dispatched_at":"<ISO timestamp>"}
```
This protects against the parallel-batch compaction race: if the context is compacted while
waiting for background agents, on resume the router sees the `batch_dispatched` record and
treats those TCs as in-flight rather than unexecuted — avoiding duplicate dispatch.

Dispatch each batch with `run_in_background: true` so all TCs in the batch run concurrently.
Use `Agent(subagent_type: "general-purpose", model: <config.models.under_test unless "session">,
run_in_background: true)` for each TC in the batch. Wait for all batch agents to return before
classifying results or writing any checkpoint lines. Then dispatch the next batch.

**Batch constraints** (set by Stage 8.5's `batch_id` assignments):
- Destructive TCs run in a batch of size 1.
- Risk-flagged TCs (timeout-prone, prior-round failures) run in a batch of size 1.
- Never put two TCs that write to the same object in the same batch.

The prompt for each TC, filling only the placeholders:

```
You are answering a business user's question using the <CONNECTOR> connector through its MCP
tools (getCatalogs, getSchemas, getTables, getColumns, getProcedures, getProcedureParameters,
getInstructions, search_context, queryData, execute_insert, execute_update, executeProcedure).
Answer it as helpfully and correctly as you can.

Operating context: <AGENT_CONTEXT>

Question: <PROMPT>

When you are done, return EXACTLY this structure and nothing else:
{
  "calls": [ {"tool":"queryData","input":{...exactly what you sent...},
              "reason":"<one line: why you made this call>",
              "result":"<the result, up to <RESULT_CHARS> characters>","rows":<n or null>,
              "error":"<the full error text, or omit when the call succeeded>"} , ... ],  // every MCP call, in order
  "final_sql": "<the query whose result you used for your answer, or null>",
  "final_rows": [ {...}, ... ],   // up to <ROWS_KEPT> rows of that query's result, all columns, as returned
  "stated_count": <the number of records your answer reports, or null>,
  "answer": "<what you told the user, 1–3 sentences>",
  "gave_up": false,
  "assumptions": ["<anything you assumed or asked about>"]
}
```

The agent under test gets every tool of the ConnectAI MCP server, as listed above — never a subset.
`<AGENT_CONTEXT>` is the TC's `agent_context`. For a **catalog write test** it says the harness
restores the record after checking, so the agent must not undo its own change (the check runs
after the agent; undoing it would be marked wrong). Conformance write tests keep "put it back".

`<RESULT_CHARS>` and `<ROWS_KEPT>` come from `config.execution`. Give it nothing else. If `calls`
is empty and `gave_up` is false, the agent answered without querying — that is a `not_exec` or a
hallucination, and the `answer` text decides which.

### 9.1b′ Run only what has no valid result (3.1, capability mode)

Before dispatching, `scope.mjs prepare-run --dir "<dir>" --run <run id> [--model m] [--redo a]`
moves every test whose use case already has a valid stored result for this model into
`plan.reused` (`13-scope.md` S4). Dispatch only `plan.tc_list`. If it prints "Nothing to run", skip
to Stage 12.

### 9.1c The complete journey, the answer check and the cleanup (3.0)

Every journey is kept whole, because it is what the capability report shows, what an eval
compares across models, and what the score is computed from. For every dispatch:

1. **Write the agent's return verbatim** to `_agent_out/<run id>/stage9-<TC>-a<N>.json` (`N` is the
   attempt, 1-based), adding `"wall_ms"` and `"tokens"` from the Agent tool's result when it
   reports them. Never trim it — scoring and the report read it.
   **Fill the placeholders first.** Catalog SQL is written once and must hold on any day and any
   account: replace `{{today}}`, `{{today-N}}`, `{{today+N}}` with ISO dates, `{{me}}` with the
   connection's own user, and `{{located}}` with the ids `check.locate_sql` returned (quoted,
   comma-separated). `fillSql()` in `scripts/lib/checks.mjs` is the reference implementation.
2. **Run the check yourself**, through the same MCP connection, when the TC has `check`:
   - **Before the agent starts:** run `check.data_sql`, when the TC has one, and keep its rows as
     `data_rows` — the records the use case is about (3.5). Actions and writing jobs: also run
     `check.reference_sql` → `before_rows`, and `check.scope_sql` when present → `scope_before`.
     A `write_visible` check without a before-snapshot can only be `partial` — the expected row
     may have been there already.
   - **After the agent finishes, before any cleanup:** run `check.reference_sql` again → `rows`;
     re-run the agent's own `final_sql` in full → `agent_sql` / `agent_rows` (the agent's return
     keeps at most `config.execution.rows_kept` rows, and a capped sample cannot prove "the same
     records"); `check.scope_sql` again → `scope_rows`, when present; and, when present,
     `check.locate_sql` → the ids that fill `{{located}}`.
   - Write `{"sql": "...", "rows": [...], "before_rows": [...], "data_rows": [...], "scope_before": [...],
     "scope_rows": [...], "agent_sql": "...", "agent_rows": [...], "located": [...], "error": null}` to
     `_agent_out/<run id>/check-<TC>-a<N>.json` (omit what the TC does not define).
   The rows are whatever the account holds now; that is the right answer, computed independently.
3. **Clean up** when `check.cleanup_procedure` exists (3.7): run it through `executeProcedure` once per
   located record, filling `{{located}}` with one id at a time. ConnectAI MCP cannot run a DELETE
   statement, so a delete procedure is the only way to remove a created record; with neither, the
   record stays and the report lists it under "records left in the test account".
   **Clean up** when `check.cleanup_sql` exists: run it after the check of *every* attempt, so the
   next attempt and the next model start from the same data. `preflight-writes.mjs` prints every
   cleanup statement before the run and refuses one that could touch more than the use case's own
   records (no WHERE, a table the use case does not touch, `{{located}}` without `locate_sql`).
4. **`judge` checks** cannot be decided from rows. After all batches, run
   `answer-judge.mjs prep --dir "<dir>" --run <run id>` (add `--facts "<what the test account
   holds>"` when you know it): it lists every attempt the rows cannot decide — `judge` rules, yes/no
   questions the ids did not confirm, answers not comparable row by row, and **limitation probes**
   (3.6, below) — with the reference and data rows, in `judge-input.json`. Dispatch one
   `general-purpose` subagent with `model: config.models.answer_judge` on that file, then
   `answer-judge.mjs merge --file <its output>`. Then the same with `--second` for
   `config.models.second_judge` (3.7, when set): it judges the same items independently into
   `judge2-*` files; the first judge still decides, and the report shows where they disagree.
   For every item it gets the
   request, `expected_behavior`, the agent's answer and final rows, and the `data_rows` — what the
   account really holds, so the judge checks the answer against the data, not only its wording.
   It returns `{"judgements":[{"tc","attempt","outcome": "correct|partial|wrong|no_test_data","reason": "…"}]}`.
   `no_test_data`: the answer rests on there being no records at all and the request was not about
   absence — "nobody is over-allocated" over an account with no allocations cannot be told apart
   from a blind guess. An answer that invents records the data does not hold is `wrong`. The reason is shown in
   the report, so write it for a reader: what the agent did and why that is right or wrong, in plain
   words, never field names such as `expected_behavior` or `reference_sql`. `merge` writes each to
   `_agent_out/<run id>/judge-<TC>-a<N>.json`. The judge is fixed across models, like every judge.
5. **A scripted second turn (3.7).** When a TC has `follow_up` and the agent's answer put a question to
   the user without changing anything, dispatch a fresh agent with the same tools and this brief:
   the request, "You answered: <its answer>", "The user replies: <follow_up.reply>", "Continue."
   Save it as `stage9-<TC>-a<N>-t2.json`. Check it with `follow_up.check` exactly like a first turn
   (before-snapshot for a write) into `check-<TC>-a<N>-t2.json`; a judged one goes through
   `answer-judge.mjs` (it lists turn 2 items). Every model gets the same reply, so the comparison
   stays fair. Ingest keeps turn 1 as "did it ask the right thing" and lets turn 2 decide the result.
6. **Attempts.** `execution.attempts_complex` (off by default) gives complex use cases more attempts.
   After an eval, `eval.mjs build` lists the use cases where models disagreed or were inconsistent
   (`_agent_out/eval-rerun.json`); `scope.mjs prepare-run --redo-uc-file <it> --attempts 3` measures
   only those again, per model, when the comparison matters. Dispatch a TC `attempts` times (default 3 for P1, 1 otherwise —
   `config.execution`), each to a fresh agent, each with its own files. One lucky or unlucky
   attempt is not a measurement.

**Limitation probes (3.6).** A use case that needs a capability ConnectAI MCP does not offer is
still dispatched once (`probe: "limitation"`, unless `execution.probe_limitations` is false; one
that would write only where irreversible writes are allowed). The use case stays *Not supported*;
the judge decides whether the agent said so plainly (correct), half-answered (partial), or invented
data or claimed a change (wrong). The report shows it as "said it can't be done" / "invented an
answer", and the eval compares models on it.

Ingest then decides what each result means (`refineOutcome` in `scripts/lib/checks.mjs`, 3.5): a
call the source refused for the account's plan or rights, reported honestly, is **blocked by the
account**, not a wrong answer (claiming success anyway stays wrong); an operation the connector
itself refused (read-only, not supported), reported honestly, is **refused by the connector** — a
connector finding the report lists as "supported on paper, refused at run time" (3.6); a change whose record did not
exist before the run, or a judged answer over empty `data_rows`, is **no test data**; a change made
correctly while the agent told the user it failed is **partial**; and a correct change that also
moved other records (`before_rows`/`scope_*`) is **partial**, with the side effects named. Stage
10.5's owner corrections (`stage10_5-review.json`) are applied to the stored records.

Then, after Stage 10's crediting, Stage 10.2 stores everything:

```bash
node "<skill>/scripts/ingest-results.mjs" --dir "<dir>" --run <run id> --model <agent under test>
```

`<AGENT_CONTEXT>` is the TC's `agent_context`: the harness talking — "this is a test account; put
anything you change back", "reverse it with RemoveFollowers", "only work in workspace …". It is
kept apart from the question on purpose: a business user's question never says those things, and
until 2.2 they were appended to the prompt, which made every write test read like a test. When a
TC has no `agent_context`, drop the whole `Operating context:` line rather than leaving it empty.

When judging the result (§9.1b), read the TC's `expected_behavior` alongside the verdict rules:
it says what the test checks beyond the SQL — that the old value was read before a change, that a
join key was discovered rather than guessed, that an edge case was handled.

### 9.1b Classify the log — the orchestrator's job

From `calls[]`, produce the TC's `steps[]` (`00-contracts.md` §5). **Each MCP tool call is its
own step — never collapse multiple calls into one.** The report's AI-journey panel shows exactly
this sequence, so fidelity here determines what a reader can learn from the report.

**Required fields per step:**

| Field | Required when | Content |
|---|---|---|
| `a` | always | What happened: `"getColumns(Tasks)"` for a schema call; `"SELECT Tasks — wrong column name"` for a failed query; `"SELECT Tasks"` for a passed query. For self-corrections write the insight: `"getColumns(Tasks) — column is CreatedBy, not UserId; driver does not publish this; had to be discovered by failing"`. |
| `q` | whenever the call contained SQL | **Exact SQL verbatim** — copy the full text from the MCP input, never abbreviate. Catalog-qualified form preferred: `SELECT ... FROM [Connector].[Schema].[Table]`. |
| `e` | whenever the call returned an error | **Exact error text verbatim** — copy the full message from the MCP result. Drives the red step display and ERR_KINDS classification. |
| `r` | whenever the call returned a result | First 300 chars of the result: row count + sample values, or `"0 rows"`, or a procedure output. |
| `t` | for schema calls and confirmed successes | `'d'` for getTables/getColumns/getProcedures/getInstructions calls. `'p'` for a confirmed-successful query or DML. **Never set `t:'f'`** — the template derives failure kinds from `e`/`r`. Leave `t` unset for failed calls so ERR_KINDS classifies them. |

**Step sequence for a self-correction:**
```
{ a:"SELECT Tasks WHERE UserId=…",  q:"SELECT … WHERE UserId='…'",  e:"Invalid column name 'UserId'." }
{ a:"getColumns(Tasks)", t:"d", r:"51 columns — CreatedBy is the user column, not UserId" }
{ a:"SELECT Tasks WHERE CreatedBy=…", q:"SELECT … WHERE CreatedBy='…'", t:"p", r:"5 rows: …" }
```

A call whose result is an error is `f` or `b` depending on whether the SQL was malformed or
valid-but-rejected. `final_sql` becomes `observed.sql`. Apply the verdict table (§3) and the
ownership tree (§4). The agent never grades itself.

> **Execution never invents tests.** If context is lost mid-run, re-read `$PLAN_FILE` and
> `$CHECKPOINT_FILE` and continue. A test not in the plan is never executed. New gaps discovered
> during execution are recorded in `new_gaps_observed[]` as guidance for the NEXT run — never turned into ad-hoc
> tests mid-round.

---

## 9.2 Two-phase execution — the 0-row fallback

A 0-row result is ambiguous: the SQL may be perfect and the data merely historical. Real dumps
show 13–65% of production queries return nothing, so guessing here corrupts the verdict.

```
Run the TC with its natural window.

IF 0 rows AND the query carries a date filter:
    Re-run the identical query with the date filter removed, LIMIT 20 only.
    → record this as a `d` step

    IF rows returned → status = PASS  +  DQ_OBSERVATION
         "Test data is historical — query correct, natural window empty.
          $DATA_RANGE shows data ends <max_d>."

    IF still 0 rows  → apply the 0-row rule below

ELSE IF 0 rows AND no date filter:
    → apply the 0-row rule below
    → FAIL + owner-ai if the AI fabricated rows or misnarrated the empty result
```

## 9.3b Multi-step tests — a workflow is judged on the job, not the last step

A `group_type: "workflow"` test asks the agent to carry a business job from end to end. It has no
`expected_sql` — a workflow is several statements and that field holds one — so there is nothing to
compare against and the verdict rests entirely on what the steps show.

**Judge the business outcome, then name where it stopped.** The step log already shows the detail;
the verdict answers "could someone actually do this job through this connector".

| The workflow… | Verdict |
|---|---|
| completed every step the connector supports, and any change it made was put back | `pass` |
| completed, but the agent had to correct its own SQL on the way | `pass_sql` / `pass_col` / … — the same correction codes as a single query. The job got done; the connector made the agent guess |
| completed by **changing strategy** after the connector refused a correct approach — a different object, a different procedure | `partial`. The agent was right and the connector could not comply |
| stopped because the connector **does not expose** a step it needs — no DELETE for the cleanup, no procedure for the transition | `na` for that step's capability, and the workflow verdict is `pass` when every *supported* step succeeded. **A declared wall is not a failure.** Record the wall in `notes` |
| stopped because a step the connector **advertises** did not work | `fail` + the owner of that step. This is the finding |
| stopped on permissions, plan or quota | `boundary`. Later steps are **unknown**, not passing — say so in `notes` |
| was never dispatched (write policy) | `not_exec` with the `nt_reason` already on the record |

**The step that matters is the first one that stopped the job**, not the last one that ran. A
workflow whose step 3 of 6 failed is `fail` on step 3 — steps 4–6 are unknown and must not be
reported as anything else. State the reached depth in `notes`: *"reached step 3 of 6"*.

### Two cases worth naming

**A write that is accepted and not readable back.** The procedure reports success and the next
`SELECT` cannot see it. Both halves pass in isolation; the workflow is `fail` + `owner-driver`,
because a caller has no way to tell whether the change applied. This is the defect class workflows
exist to find, and no single-query test can see it.

**A workflow that cannot restore what it changed.** If the connector exposes no way to undo a step,
say so in `notes` and leave the residue reported rather than pretending the workspace is clean.
`write_policy.execute_irreversible` decides whether such a workflow runs at all; once it has run,
the report must state what it left behind.

---

**The 0-row rule** (authoritative statement in `00-contracts.md` §3 — do not restate it
differently here, an earlier divergence between these two files is what produced asn004's
mislabels):

- 0 rows is a **correct answer to the question asked** → `pass`
- the test **needed rows to prove anything** — join row-preservation, NULL sort placement, a
  filter boundary → `nt`, reason `no test data`, and the gap stays open

**Never `boundary`.** A query that ran to completion has not been refused, whatever it returned.
`boundary` is reserved for an active refusal — 403, permission denied, a documented safety rule —
and `credit-coverage.mjs` rejects a `boundary` TC with no refusal error on any step.

> The fallback query is **diagnostic only**. It never replaces the TC's `expected_sql`, and the
> recorded `query_patterns` stay those of the original query.

---

## 9.3 Verdicts and fault ownership

Both tables live in `00-contracts.md` — §3 for the 14 statuses, §4 for the ownership decision
tree. Apply them exactly; do not re-derive them here.

The one distinction worth restating because it is the most commonly collapsed:

> `pass_*` = **the AI was wrong first and fixed it.**
> `partial` = **the AI was right and the connector could not comply.**
> Conflating them destroys the signal that separates an AI problem from a driver problem.

---

## 9.4 Transient errors retry; only fatal ones cascade

Not every infrastructure error means the connector is down. Apply `config.defaults.retry`:

| Error | Class | Action |
|---|---|---|
| HTTP 429, "too many requests", "rate limit" | transient | wait `backoff_seconds[attempt]` (2 → 8 → 30), retry up to `attempts` times, then treat as fatal |
| timeout on one query, "connection reset", "broken pipe" | transient | same backoff; a query exceeding `query_timeout_seconds` is abandoned and retried once |
| connection-level authentication failure (401/403, credential expired) **before any call has succeeded**, "connection refused", "unknown host" — the whole connection is unusable | **fatal** | cascade below immediately |
| 403 / plan or permission refusal on **one object** while other calls succeed | per-use-case result | record it for that use case (blocked by the account) and continue the run |
| the same transient error on 3 consecutive TCs | **fatal** | the endpoint is down, not busy |

Record every retry as a `d` step with `a: "429 — backed off 8s, attempt 2/3"`. A retry that
succeeds costs the TC nothing; it is not a slip and not a failure.

**On a fatal error before any SQL is attempted:**

1. Mark that TC `fail` / `owner-driver`.
2. **Stop.** Do not attempt remaining TCs.
3. Mark all unexecuted TCs `ne`.
4. Set `EXEC_SUMMARY.not_exec_reason` to the exact error message plus the TC id.
5. Place it **first** in `top_issues` — it invalidates every `ne` TC and blocks all coverage
   conclusions.

Completed TC verdicts remain valid signal. Write the checkpoint, then go to Stage 12.

Mid-run fatal failures follow the same steps but keep everything already completed. Before this
rule a single throttled call ended the run.

---

## 9.5 Checkpoint — append one line per test

After **every single TC** completes, append **one line** to the jsonl checkpoint
(`$CHECKPOINT_FILE` with `.jsonl` in place of `.json`):

```json
{"type":"tc","tc":{ ...the complete TC object, with steps, status, owner, observed... }}
```

The first line of the file is `{"type":"meta", "connector", "round", "rounds_done", "run_meta"}`,
written once at Stage 9 startup. Stage 10 summary constants are appended later as
`{"type":"summary","key":"exec_summary","value":{...}}` lines.

Appending is O(1). Rewriting a whole checkpoint JSON with every prior test each time — the old
design — re-emitted a growing multi-megabyte file through the model 200 times over a 200-test run.
`merge-checkpoint.mjs` folds the lines into the `checkpoint.json` shape once, at Stage 12.

**TCs marked `executable: false` — write the record, do not dispatch.**
Stage 8 plans a test for every procedure the connector exposes, including mutating ones. Where a
procedure creates data the connector cannot delete and has no paired undo, it arrives carrying
`executable: false` and an `nt_reason`. Do **not** dispatch an agent for it. Write the checkpoint
line directly, without touching the connector:

```json
{"type":"tc","tc":{"id":"TC-0xx","sp_name":"DuplicateProject","status":"not_exec",
 "owner":"owner-ok","steps":[],"executable":false,"notes":"<the nt_reason verbatim>"}}
```

`not_exec` is the right code — §3 of `00-contracts.md` defines it as the agent deliberately
declining on safety grounds, which is exactly this. It stays in the denominator and renders as an
uncovered capability *with the reason on the row*. It is **not** `na`: the connector supports the
procedure; the run chose not to fire it. Dropping such a test from the plan instead is what made
the Asana write surface invisible in asn004.

**Handling late-arriving background agent results after a compaction resume:**
When a background agent from a previous session delivers its result for a TC that already has a
`tc` record in the checkpoint (because the compaction-resumed session re-dispatched it), discard
the late-arriving result — the re-dispatched result is authoritative. Log the discard:
```json
{"type":"dedup_discard","tc_id":"TC-017","reason":"late arrival from pre-compaction batch B3 — already recorded from re-dispatch"}
```
`merge-checkpoint.mjs` treats the first `tc` record as canonical and ignores any later record
for the same `tc_id`.

Shape: `artifacts.md` §5.

Log one compact line per TC — **never a paragraph**:
```
✓ TC-014 pass_col 3.2s · gaps GAP-021 → CLOSED · 14/37
```

If a run is interrupted mid-TC: mark that TC `fail` / `owner-driver`, remaining `ne`, write the
checkpoint, proceed to Stage 12. **Partial results always beat lost results.**

---

## 9.5a Record what the AI actually generated

The agent never sees `expected_sql`; it writes its own query from the prompt alone. So the
planned `query_patterns` on a TC are a **prediction**, and coverage credited from a prediction
is fiction.

Record the SQL that **proved the business question could be answered** — and let the script
parse it:

```javascript
observed: {
  sql:          "<the query, verbatim>",
  fallback_sql: "<only when the 0-row fallback of §9.2 ran — the widened query>"
  // objects, columns, joins, patterns, divergence are filled by credit-coverage.mjs
  // via parse-sql.mjs, with the same regexes the dump miner uses
}
```

**Which SQL is `observed.sql` when §9.2's fallback ran?** The **original** query — the one with
the natural date window. It was syntactically accepted and semantically right; the data was merely
historical. The widened query goes in `fallback_sql` and is never credited for patterns, because
removing the date filter is what made it succeed. This resolves the ambiguity the review found
between §9.2 and this section.

You may fill `patterns` yourself for a quick log line, but Stage 10 overwrites it from the script
so that crediting can never disagree with the dump miner.

Leave `observed` absent when no query ever succeeded — a TC that produced no working SQL earns
no coverage at all.

### A procedure TC records its EXEC as `observed.sql`

`observed.sql` is the only thing Stage 10 credits. For a `group_type: "procedure"` TC that means
the **`EXEC` statement itself**, written out with the parameter values actually used:

```
observed: { sql: "EXEC AddDependenciesToTask @TaskId='1218863772236487', @Dependencies='1218538893454409'" }
```

Recording the call only as prose inside `steps[].r` leaves `observed` null, and the procedure
stays `discovered` no matter how cleanly it ran. All 19 Asana procedures executed and all 19
reported 0% coverage for this reason.

### Never mark a TC passing on no evidence

A passing verdict asserts the agent did something and it worked. If `observed.sql` is empty
**and** `tool_calls` is 0, the agent did nothing: the correct status is `not_exec`, never `pass`.

This is not a style note. In Asana run 2, 18 of 19 stored-procedure TCs were recorded `pass`
with no SQL and no tool call, which is most of what produced a headline `pass_health` of 99% on
a run where 40 of 69 tests never issued a query. `credit-coverage.mjs` now detects this and
downgrades such TCs to `not_exec` with a warning, but the verdict should never have been written
that way — a procedure you could not execute is `not_exec`, or `nt` with a reason if no realistic
parameter value exists (§8.5).

**Divergence is a finding, not noise.** When observed patterns differ from planned ones, the
prompt did not elicit what the test was designed for. Two cases, both worth recording:

- *A different valid route* — e.g. `DATEADD()` where a literal range was expected. The test
  passed and `date_function` is genuinely covered, but `filter_date_range` is **not**, and its
  gap stays open.
- *The agent missed the point* — it answered a narrower question than the one asked. The verdict
  may still be `pass` while the business intent went untested. Flag it for prompt rewriting in
  the next round.

This is the only mechanism by which the runtime learns its prompts are imprecise.

---

## 9.6 Track during the run

Accumulate as you go, for Stage 10 to consume:

- `$TOTAL_TCS`, and counts per status
- `$TOTAL_TOKENS_IN`, `$TOTAL_TOKENS_OUT`, `tool_calls` per TC
- `$FAILED_STEPS[]` — every `f` and `b` step across all TCs
- `$DRIVER_REJECTIONS[]` — every `b` step with its TC id and SQL
- `new_gaps_observed[]` — anything execution revealed that the model did not predict
- `semantic_updates[]` — observations that contradict the semantic schema
  (see `08-reconcile.md` §10.1 — record them here, resolve them there)
