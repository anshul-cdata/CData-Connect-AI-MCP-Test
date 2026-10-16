# Scripts by stage

Anything that is a loop, a sum, a join or a copy runs as a script; the model does the parts that need
judgement. Every script prints a short summary; where it wrote a `*-summary.json`, read that, never the
full artifact. Each stage's reference gives the exact commands.

| Stage | Script | Does |
|---|---|---|
| 0 | `detect-stage.mjs` | routes to the right stage from disk state |
| 0.5 | `read-driver-schema.mjs` | reads the driver source: which objects CData **documented**, the driver class, and the generated catalog. Optional — skipped when no enlistment is configured, and nothing downstream requires its artifact |
| 2 | `validate-agent-output.mjs` | schema-checks each research agent's JSON before it enters the model |
| 3, 5 | `validate-model.mjs` | checks a model-authored artifact's **vocabulary** against `lib/vocabulary.mjs` before the next stage consumes it. Structure was never the problem: Stage 5 named ten behaviours and the generator recognised three, so seven tests shipped asking the literal word "undefined" — all of it valid JSON |
| 4 | `mine-dump.mjs` | parses customer dumps → `customer_evidence.json`; never read the CSVs |
| 6 | `compute-gaps.mjs` | `required − covered` over every objective × item; emits gap skeletons, the **EXPOSURE** category and the discovery funnel |
| 7 | `score-gaps.mjs` | the priority formula; refuses gaps you have not yet given `business_importance` |
| 8 | `generate-tests.mjs` | walks every persona everyday question, use case, workflow, procedure, behavior, relationship, pattern and object; emits one TC each with its `gap_ids`, its `suite` (business or conformance), and the `use_case_ids`/`sp_name`/`behavior` binding Stage 10 credits from. Business TCs are drafts with a `brief`; test mechanics go to `expected_behavior` and `agent_context`, never the prompt |
| 8.6 | `realism-check.mjs` | lints every prompt (schema names, ids, SQL words, instructions to the agent), packages business prompts for the realism judge, merges its scores, and **blocks Stage 9** while any business scenario is unscored, still a draft, or below `realism.min_score` |
| 9 | `check-harness.mjs` | lists connector tools missing from the permission allow list — an auto-mode refusal makes an attempt fail for reasons that are neither the model's nor the connector's. Reports only; the user grants permissions |
| 9.1c | `answer-judge.mjs` | `prep` lists every attempt the rows cannot decide (judge rules, yes/no questions, limitation probes) with reference and data rows; `merge` writes the judge's verdicts |
| 5.5a′, 8.0 | `test-data.mjs` | `survey` real rows for the writer · `find` fixtures in the account · `seed` only what is missing (user approves) · `status` (`07-execution.md` §9.0b) |
| 0 | `orchestrator-advice.mjs` | suggests sonnet or opus as orchestrator from what is on disk; `ADVISE` → ask once; `--record` → `run_meta.orchestrator` (never blocks) |
| 0.1b | `write-policy.mjs` | the start-of-run question about writes (`status` prints ASK) and the answer (`confirm`) |
| 9 | `preflight-data.mjs` | `prep` lists the data each test needs; `merge` holds tests with none (no test data) and prints area readiness — `AREA NOT READY` → ask the user; `release` puts them back |
| 9 | `preflight-writes.mjs` | **the write gate — runs before any dispatch.** Always refuses a write not flagged `mutates`. With `write_policy.require_workspace_pin: true` (off by default — connectors are tested on test accounts) it also refuses a mutating plan with no pinned, verified, non-organization workspace carried by every mutating test |
| 9 | `parse-sql.mjs` | observed SQL → objects, columns, joins, patterns — same regexes as the dump miner |
| 1.5d | `account-probe.mjs` | one read per table → what the test account holds per area, shown before `--areas` is chosen |
| 1.5e | `reference-mcp.mjs` | `read` the vendor MCP server's tool list · `prep` the capabilities to compare · `apply` the mapping agent's answer · `status` · `none` (the vendor has no MCP server) — kept in `<C>_reference_mcp.json`, never in the capability list |
| 1.5a | `api-from-docs.mjs` | no OpenAPI: `ladder` (spec, Postman, SDK) · `convert` · `probe` (HTTP or rendered browser) · `inventory` · `snap` page text · `render` (headless browser → disk, no model in the loop; refuses robots.txt-disallowed pages) · `ingest` (files text a person downloaded from their own browser) · `prep` extraction · `merge` (evidence checked word for word) → `<C>_api.json` · `status` |
| 1.5 | `capability-list.mjs` | `read` the source's API description (a re-read lists added · removed · moved) · `map` it onto tables, writes and procedures (a procedure that needs a local file or stream is marked unusable from its parameters, `lib/file-transfer.mjs`; `map` warns when none were recorded) · `apply` the model's review · `status` gates Stage 5.5, and blocks an API list assembled without evidence (`lib/api-provenance.mjs`) unless `--keep-unverified "<why>"` |
| 5.5 | `manage-catalog.mjs` | `add` a research batch · `validate` · `tag` (difficulty and skills, outside the hash) · `review-prep`/`-merge`/`-answer` (whole-area coverage review) · `retire` · `sources-prep`/`-merge` · `judge-prep`/`-merge` · `sample`/`human-merge` · `freeze --areas` · `reset-area` — an area is frozen only when complete, at its mix floors, coverage-reviewed, sourced, judged and — only when `config.catalog.human_review` is true (off by default) — human-sampled |
| scope | `scope.mjs` | `status` per area · `research-plan` batches (`--fill`, `--cross`) · `prepare-run` leaves only what has no valid stored result |
| 10.2b | `ingest-results.mjs` | journeys → error classes, retries, recoveries · checks → correct/partial/wrong · score 0–100 · the permanent results store |
| 12, eval | `build-capability-report.mjs` · `eval.mjs plan/build` | the capability report from the store · model comparison reusing stored runs |
| 10 | `credit-coverage.mjs` | credits coverage from `observed`, resolves gap status, derives the verdict **by rule** |
| 12 | `merge-checkpoint.mjs` → `build-report.mjs` → `finish-run.mjs` | fold the jsonl checkpoint, build both HTML files from artifacts, archive and mark the run complete |
| any | `check-skill.mjs` | integrity check of the skill itself |
