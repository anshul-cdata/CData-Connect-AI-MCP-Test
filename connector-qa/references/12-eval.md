# Eval mode · comparing AI models on the same use cases

**Contents**

- What stays fixed, and what varies
- E1 · Plan
- E2 · Run the models that need it
- E3 · Build

`/connector-qa <Connector> [--areas a,b | --all] --execute --eval [--models opus,sonnet,haiku]`

(`--eval opus,sonnet,haiku` also works. Without a list, `config.eval.default_models`. Scope as in `13-scope.md`.)

An eval answers a different question from a normal run: not "can I do it through CData?" but
"which AI model does it best through CData?". It needs a **frozen catalog** — the same exam for
every model — and it reuses every stored run it can.

## What stays fixed, and what varies

| Part of the run | In an eval |
|---|---|
| Capability list (script, from the source's API) | fixed |
| Use case catalog — research, wording, checks, realism | fixed: each area in scope frozen; each use case's own hash |
| Answer checks and scoring (scripts) | fixed |
| Verdict classification, answer judge, post-run review | fixed models |
| Connector build, usage instructions, workspace | fixed — recorded as the fingerprint |
| **The agent under test** | **varies** — one run per model |

If anything in the fixed column differs, the results are not comparable and `eval.mjs build`
refuses. Since 3.1 this is decided **per use case**: a stored result counts when it was measured
in this environment and its use case is worded as it is now, so adding an area never voids the
results of the others.

## E1 · Plan

```bash
node "<skill>/scripts/eval.mjs" plan --dir "<dir>" --areas a,b --models opus,sonnet,haiku --eval <id>
```

For each model it counts the use cases in scope that already have a valid stored result, whichever
run produced them, and how many still need one. A model with all of them is reused as it is; the
rest get a run id. An area in scope that is not frozen, or was edited since, is refused. Freeze it again.

## E2 · Run the models that need it

For each model marked **RUN NEEDED**: `generate-tests.mjs --areas …` (once, for the scope), then
`scope.mjs prepare-run --model <that model> --run <the id printed>`, which leaves in the plan only
the use cases that model has no valid result for. Then carry out Stage 9 as normal, with two
differences: dispatch the agent under test with `model: <that model>`, and set `run_meta.run_id`
to that id. Everything else — the plan, the checks, the judge —
is unchanged. Then store it:

```bash
node "<skill>/scripts/ingest-results.mjs" --dir "<dir>" --run <id> --model <model>
```

Raw agent files are per run: Stage 9 writes them to `_agent_out/<run id>/`, so one model's
results can never overwrite another's.

## E3 · Build

```bash
node "<skill>/scripts/eval.mjs" build --dir "<dir>" --eval <eval id>
```

Every model is **re-scored against the same pool** — the records of exactly the runs compared —
so the shortest path and the speed norms are shared, and a few points' difference is a difference
in the models, not in when each run was ingested. Cost per correct answer uses one representative
attempt per use case, as the score does.

A run with a different fingerprint is never compared. A run that is incomplete (some attempts
left no result) is refused unless `--allow-incomplete` is given; then only the use cases **every**
model finished are compared, and the report says how many.

Writes `<Connector>_eval_report_<eval id>.html`, one `<Connector>_capability_report_<eval id>_<model>.html`
per model (scoped to the eval's areas and the use cases every model finished, so it never
overwrites the official combined `<Connector>_capability_report.html`), and `_results/<Connector>/evals/<eval
id>.json` (stamped `built_at`), which the next eval uses as its baseline — the most recently
built earlier eval of the same connector.

### What the eval measures, and how it decides (3.3)

The question an eval answers: *given the same connector, the same MCP interface, the same business
task and the same environment, which model most often accomplishes the user's objective — and
why?* `lib/eval-analysis.mjs` computes the answer from the stored journeys; no model writes it.

- **Task success leads.** The headline is the **correct rate**: right answers over the use cases a
  model was actually asked. It is absolute — no other model can move it. A use case the planner
  marked "not possible" before any agent ran (a capability it needs is not exposed) measures the
  connector, not the models: it leaves every model's denominator and is reported under connector
  limitations.
- **The score is a summary, gated by the answer.** Efficiency, robustness and speed are earned only
  in proportion to the answer, so a wrong answer scores 0 (`lib/scoring.mjs`). Efficiency and speed
  are relative to the compared models; the report says so.
- **First-try success** = right *and* no failed call. A clean journey that ends wrong is not a
  success — it is the most misleading kind of failure, and the profiles name it ("every call
  worked, but it answered a different question").
- **Is the difference real?** For every pair of models, McNemar's exact test on the same use cases,
  with a 95% range on the difference in correct rate. Below p 0.05 the summary says one model is
  more often right; otherwise it says they cannot be told apart. An answer from fewer than
  ten use cases is labelled *indicative*; under five, *too few to call*.
- **Breakdowns** by difficulty, skill tested, interaction pattern, business area, persona and task
  type — a model that leads overall is not always best for every kind of work. They need the
  catalog's `difficulty` and `tests` tags (`manage-catalog.mjs tag` for a catalog written before 3.2).
- **Agreement** per use case: all right, only one right (a unique win), only one wrong (a unique
  failure), split, all fail, not exposed, not measured on every model.
- **Discrimination is measured**, not predicted: high when models reach different outcomes, medium
  when they reach the same one at very different cost or a model is inconsistent across attempts,
  low otherwise. Use it to read the benchmark, never to prune it to today's models.
- **Connector vs model.** A failure every model shares is a connector or metadata gap only when
  each model's failure is charged there. Every model wrong through its own mistakes, or for
  different reasons, is "cause unclear" — a hard task, not proof of a gap. Account, source-system,
  harness and test-data problems are the environment's.
- **Two judges, asking, and close calls (3.7).** Each model's judged answers show how often the second
  judge agreed; "asked when unclear, then finished the job" counts the use cases with a scripted reply;
  bulk exports are their own pattern. The build lists the use cases where models disagreed or were
  inconsistent, for an optional re-run with more attempts (`07-execution.md` §9.1c).
- **Check these before blaming the models (3.6).** A use case every model got wrong is listed with
  each model's check detail on the Differences tab. In asn-eval1 at least 3 of 11 were check defects
  (a yes/no question compared on ids, a reference narrower than the request) — confirm the check
  before calling it hard.
- **Limitation handling (3.6).** Probes of requests ConnectAI MCP cannot fulfil stay out of task
  success; each model's share that "said so plainly" (and how many invented an answer) is its own row.
- **Limits.** The method tab lists what weakens the comparison: a judge that is also a contestant
  (`answer_judge` or `realism_judge` among the compared models — prefer one outside them), single
  attempts, use cases not measured on every model, harness refusals.

Tell the user, in this order: whether there is a decisive winner (and by how much, with the
verdict of the paired test), what each model is best and worst at, use cases that fail on every
model **by owner** (never "all connector gaps" without the evidence), the top of the fix list, the
limits of this eval, and any regressions against the baseline.

Cost appears only when `config.pricing` has a blended `per_mtok` rate for a model and the runs
recorded tokens; otherwise the report shows tokens and no price.
