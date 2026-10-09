# Scope · research, run and evaluate area by area, without losing work (3.1)

**Contents**

- The flags
- S1 · Show the areas, then ask
- S2 · Research in batches
- S3 · Prove each area is complete, then freeze it
- S4 · Execute the scope (`--execute`)
- S5 · Evaluate the scope (`--eval`)
- What the user is told

Applies in capability mode (`run_meta.mode = "capability"`). The 2.x coverage flow has no
business-area scope: the router aborts on `--areas` / `--all` there, and `generate-tests.mjs`
refuses them without a catalog. Tell the user why.

Even a medium connector has more business areas, personas and flows than one researcher covers
well. One pass over nine areas skims all nine, and that is where invented use cases and missed
scenarios come from. So:

- **The cheap, mechanical part always covers the whole connector:** Stage 1 discovery and the
  Stage 1.5 capability list, which turns the vendor's own API into areas, personas and flows.
- **Research is done per area, in batches**, each small enough to cover properly. An area is
  finished only when it passes its own completeness check.
- **Everything after research adds up.** The catalog is frozen per area. Results are reused per
  use case. Reports and evals are built from every valid result, whichever run produced it.

## The flags

| Command | Does |
|---|---|
| `/connector-qa X` | Discovery and capability list, then **show the areas and ask** (below) |
| `--areas a,b` | Research those areas (≤ `scope.max_areas_per_run`) up to their freeze, then stop |
| `--all` | The same for every area, in batches |
| `… --report` | When research stops, build the analysis report (`build-capability-report.mjs --analysis` → `<C>_analysis_report.html`, every area researched so far — each batch adds to it): capabilities, gaps, account readiness and an outlook per use case. Nothing is run. Without `--report`, research ends with the summary only |
| `… --execute` | Then plan, run and report the scope (Stages 5–7 → 8.0 test data → 8 → 9.0 checks → 9 → 10 → 12) |
| `… --eval` | Then evaluate the scope on `config.eval.default_models`, or on `--models a,b,c` (`--eval a,b,c` also works). Implies `--execute` |
| `--continue` / `--redo [a,b]` | Answer the "existing work" question in advance, for unattended runs |

`--execute` or `--eval` without `--areas` means `--all`. Names match an area's id, name or slug
(`task-management`, `TM`). An unknown name is refused with the list of areas, never guessed.

## S1 · Show the areas, then ask

After Stage 1.5 (`capability-list.mjs status` exits 0), run Stage 1.5d, the account probe. It
only reads (one `SELECT … LIMIT 1` per table the capability list exposes; it needs
`run_meta.catalog` and `run_meta.schema` from Stage 1):

```bash
node "<skill>/scripts/account-probe.mjs" prep  --dir "<dir>"      # run each listed read with queryData
node "<skill>/scripts/account-probe.mjs" merge --dir "<dir>" --checks "<dir>/_agent_out/account-probe.json"
node "<skill>/scripts/scope.mjs" status --dir "<dir>"
```

`merge` prints each area's readiness (data · empty · refused · needs a filter). Show it to the
user **before** areas are chosen: an area whose tables are empty or refused on this account will
mostly be blocked, though its research stays reusable on a better account.

Then, **by default**, Stage 1.5e: compare the source vendor's own MCP server with CData ConnectAI
MCP (`10-capabilities.md` §1.5e — skipped with `--no-compare-mcp` or
`config.capabilities.compare_vendor_mcp: false`, and when `scope.mjs status` shows it is already
current). `scope.mjs status` ends with its line — both · only CData · only the vendor MCP ·
neither — or says the vendor has none. Show it with the areas.

It prints one row per area: capabilities, personas, research state, completeness, use cases,
valid results for the agent under test, evals, and the next step. With no scope flag, show that
table and ask the user (AskUserQuestion) **Research everything** or **Choose areas**. If they
choose, ask which (multi-select, at most `scope.max_areas_per_run`). Then ask whether to stop
after research, execute, or execute and evaluate.

**Existing work.** For every area in scope that is not `not_started`, say what exists
(`researching` · `needs_review` · `frozen vN` · `changed` · results `n/m`, `k stale` · evaluated)
and ask **Continue** or **Redo**, unless `--continue` or `--redo` was given:

| State | Continue | Redo |
|---|---|---|
| `researching` (a batch pending) | dispatch the pending batch only | `manage-catalog.mjs reset-area`, then research again |
| `needs_review` / `changed` | carry on at S3 (sources, judge, human, freeze) | reset and research again |
| `frozen`, results valid | nothing to do for research; skip to S4 if `--execute` | reset (research) or `prepare-run --redo <area>` (execution only) |
| results stale | `prepare-run` re-runs only the stale ones | `prepare-run --redo <area>` |

Never re-research or re-run an area without one of those answers. A redo of research retires the
area's use cases (`status: retired`; ids are never reused) and supersedes its research batches.

## S2 · Research in batches

```bash
node "<skill>/scripts/scope.mjs" research-plan --dir "<dir>" --areas a,b      # or --all
```

This appends batches to `<Connector>_research_plan.json`. Each batch has at most
`scope.max_areas_per_batch` areas and `scope.max_capabilities_per_batch` capabilities. An area
bigger than that is split along its flows. Running it again keeps pending batches (that's how
continuing works) and skips frozen areas.

For each batch, dispatch `agents/usecase-researcher.md` (`model: config.models.research_business`)
with the batch's areas, flows, capability ids and personas, plus the requests the catalog already
holds for those areas. Then write the use cases from its evidence (`11-catalog.md` §5.5b) into
`_agent_out/stage5_5-usecases-<batch>.json` as `{"use_cases": [...], "no_business_use": [...]}` and merge:

```bash
node "<skill>/scripts/manage-catalog.mjs" add --dir "<dir>" --from "<dir>/_agent_out/stage5_5-usecases-RB-001.json" --batch RB-001
```

`add` drops near-duplicates of **any** use case in the catalog, whatever its area. It gives the
new ones permanent ids, records each `no_business_use` reason, and marks the batch done. Batches
are independent, so dispatch them in parallel when there are several.

## S3 · Prove each area is complete, then freeze it

```bash
node "<skill>/scripts/manage-catalog.mjs" status --dir "<dir>" --areas a,b
```

An area can be frozen only when all of these hold. `freeze` lists exactly what is missing.

1. **Completeness.** Every applicable capability of the area is used by a use case, or is under
   `no_business_use` with a reason, at `catalog.min_capability_coverage`. Every persona the area
   names has a use case. If not: `scope.mjs research-plan --areas a --fill` plans a batch for only
   what is missing. Dispatch it and `add` it like any other batch.
1a. **Mix and personas.** Every use case has `difficulty` and `tests`. The area reaches the floors
   in `catalog.mix` (complex requests, dates, totals, links between objects, a write, an
   ambiguous request, one missing information, one the source cannot do) and every persona has
   `catalog.min_per_persona` use cases of its own — or the writer explains why under
   `mix_explained`. `status` prints the counts; `--fill` plans evidence for what is short.
1b. **Coverage review answered.** A fresh reviewer read the whole set (`review-prep` →
   `agents/catalog-reviewer.md` → `review-merge`) and every finding is answered
   (`review-answer`) — `11-catalog.md` §5.5b′. Areas frozen before these checks keep their
   freeze; `status` shows what they would need when next researched.
2. **Sources checked.** `manage-catalog.mjs sources-prep --areas a,b` lists the cited pages.
   Dispatch one `general-purpose` agent (`model: config.models.research`) to open each URL and
   return `{"checks": [{"url", "status": "found|off_topic|not_found", "title_seen", "note"}]}` to
   `_agent_out/stage5_5-sources.json`, then `sources-merge --checks <file>`. A use case whose page
   is missing or off-topic blocks the freeze. Replace its source or retire it.
3. **Judged** (`judge-prep --areas`, which packages only what is not yet judged; then `judge-merge`).
4. **Human sample — only when `config.catalog.human_review` is true (3.9).** When it is false — the
   default — freeze with `--skip-human` and do not ask: the run never pauses for the rating sheet,
   `run_meta.human_review = "skipped (config)"` is recorded, every freeze is recorded as
   `human_skipped`, and the reports say "Not reviewed — human review is off". When it is true, ask the
   user to have a person fill the sheet (`sample --areas` puts unrated use cases first; `human-merge`);
   never fill it yourself. Ratings accumulate per area: the area needs `catalog.human_min_per_area`
   ratings that still match the wording, and a review stands until the area has grown by more than
   `catalog.human_regrow`.
5. **Valid** (`validate`).

```bash
node "<skill>/scripts/manage-catalog.mjs" freeze --dir "<dir>" --areas a,b
```

Each area gets its own version (`cat.areas.<id>.version`). Freezing finance does not touch sales.

**When research stops here** (no `--execute`): with `--report`, build the analysis report and give
the user its path. Without it, end with the summary and do not build one. Build it **without
`--areas`**: it then covers every area researched so far, so each batch adds its areas to the same
report instead of replacing it (an area not yet researched shows as such).

```bash
node "<skill>/scripts/build-capability-report.mjs" --dir "<dir>" --analysis
```

It reads the capability list, the catalog and `<C>_account.json` only, writes
`<C>_analysis_report.html`, and never touches the capability report or the results store. Each
use case shows an outlook — ready · needs a partly supported capability · not supported by CData
· only in the source's own app · the test account refuses it or has no data for it — a forecast
from what it needs, never a result. Say so when you hand it over.
The catalog counts as frozen as a whole only when every area of the capability list is.

**Cross-area flows.** `scope.mjs status` lists `cross-area pass due: A+B` once two related areas
(`areas[].related`, set in Stage 1.5c) are both frozen. Run `scope.mjs research-plan --cross A,B`,
dispatch the researcher with the cross-area batch, `add` it, and take the main area through S3
again. A few additions do not need a new human sample.

## S4 · Execute the scope (`--execute`)

Stages 5 → 6 → 7 run first when their artifacts are missing, as in an unscoped run. Then
**Stage 8.0, test data**, before any test is generated (`07-execution.md` §9.0b). The router
routes here (it prints stage 8) while any fixture in scope was never looked for:

```bash
node "<skill>/scripts/test-data.mjs" find-prep  --dir "<dir>" --areas a,b --me <run_meta.me>   # run each find_sql
node "<skill>/scripts/test-data.mjs" find-merge --dir "<dir>" --checks <file>                    # repeat until nothing is listed
node "<skill>/scripts/test-data.mjs" seed-prep  --dir "<dir>" --me <run_meta.me>                # SHOW the INSERTs to the user
node "<skill>/scripts/test-data.mjs" seed-merge --dir "<dir>" --checks <file>                    # only after a yes
node "<skill>/scripts/test-data.mjs" find-prep … / find-merge …                                   # binds what was seeded
node "<skill>/scripts/test-data.mjs" status     --dir "<dir>" --areas a,b
```

Then generate the plan:

```bash
node "<skill>/scripts/generate-tests.mjs" --dir "<dir>" --areas a,b
node "<skill>/scripts/scope.mjs" prepare-run --dir "<dir>" --run <run id> [--redo a]
```

`generate-tests --areas` plans the frozen areas named. It refuses one that is not frozen or was
edited since. A partial scope — fewer areas than the connector has, including `--all` while some area is not yet
researched — plans the business suite only. Driver conformance checks come with a full run (every
area frozen) or with `--with-conformance`. `prepare-run` then moves every test whose use case
already has a **valid** stored result for the agent under test into `plan.reused`, so only the rest
are dispatched. "Valid" means all of these:
- the same environment (connector build, usage instructions, workspace)
- the wording that was actually run, stamped on each test when it was planned, is still the use case's current wording
- every attempt is present
- every outcome is **decided** (correct, partial, wrong, not possible, no test data)

"Not run", "awaiting judgement" and "not checked" are never reused. "Not possible" lapses when its
capability becomes exposed. Stale results are re-run; the output says how many. If it prints
"Nothing to run", the router goes straight to Stage 12. `ingest-results.mjs` refuses a run id or
model other than the one the plan was prepared for. Runs are ordered by when they ran, never by when
they were ingested.

Then Stage 9 → `ingest-results.mjs --run <run id>` → Stage 12 as usual. Without `--run`,
`build-capability-report.mjs` builds the **combined** report: the newest valid result of every use
case across all runs, with a header that says how many areas are researched and run. Until every
area is, there is a "Partial coverage" banner and no connector-wide use-case figure.

## S5 · Evaluate the scope (`--eval`)

```bash
node "<skill>/scripts/eval.mjs" plan --dir "<dir>" --areas a,b [--models opus,sonnet,haiku] --eval <id>
```

For each model, the plan says how many use case runs it already has and how many it still needs.
For each model that needs some: `prepare-run --model <m> --run <eval id>-<m>`, Stage 9 with that
model as the agent under test, then `ingest-results --run … --model <m>`. Then `eval.mjs build
--eval <id>` (`12-eval.md`).

## What the user is told

At the end of every scoped run: the `scope.mjs status` table, what this run added (areas frozen,
tests run, results reused), what is stale, and what is left. That includes areas not researched,
cross-area passes due, and areas researched but not run.
