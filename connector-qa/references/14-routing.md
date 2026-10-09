# Stage 0.4 · Routing — the rules `detect-stage.mjs` applies

Read this when the router's answer looks wrong, or when resuming after a compaction. The router
(`scripts/detect-stage.mjs`) is the authority: this page explains it, it does not replace it.

```bash
node "<skill>/scripts/detect-stage.mjs" --dir "$ROOT/$CONNECTOR" [--fresh] [--resume]
```

It prints one JSON line — `{"stage": N, "reason": "...", "run_state": "...", ...}` — and you
start at that stage. The rules it applies, for the reader:

| Disk state | Stage |
|---|---|
| `--areas` / `--all` / `--execute` given (capability mode) | pass the scope to the router (`--areas a,b` or `--all`): an area in scope not frozen → **5.5** (`13-scope.md` S1–S3); then, in order, no coverage → **5**, no gaps → **6**, gaps not prioritized → **7**, fixtures in scope never looked for → **8** (the router prints 8; start at 8.0, test data), a plan that does not cover the scope → **8** |
| Capability mode · the API list was assembled without evidence (`lib/api-provenance.mjs`: no `info.x-assembled`, or `capability_spec.source: "reference_docs"` without one, or operations without page and line) and not kept with `--keep-unverified` | **1.5a** — rebuild it with `api-from-docs.mjs`, then `capability-list.mjs read`; frozen areas stay frozen (`10-capabilities.md` §1.5a). With a plan already built it is a warning, not a route |
| Capability mode · a rebuild left capabilities unmapped | **1.5** — review only what `capability-list.mjs status` lists as added or moved; a frozen area whose use cases need a removed or moved capability is a warning, never unfrozen |
| `--eval <models>` given | **eval** — bypasses the router: follow `references/12-eval.md` (plan → Stage 9 for each model that needs a run, against the existing plan → build) |
| `--rerun` given · `knowledge.json` has `run_state: "complete"` | a plan with tests present → **9**; else gaps prioritized → **8**; else **7**. The orchestrator first makes one `getCatalogs` call; if it fails, **abort** and report the error |
| `knowledge.json` has `run_state: "complete"` and `--resume` was **not** given | **1** — a finished run is finished; discovery re-runs against current metadata |
| All TCs terminal · checkpoint has `stage_10_5` started + `stage10-summary.json` exists · no `post_exec_review` in checkpoint | **10.5** — reviewer was interrupted; re-dispatch with same inputs |
| All TCs terminal · Stage 10 already reconciled (`exec_summary` present) | **12** |
| All TCs terminal · not yet reconciled | **10** |
| Checkpoint has TCs not yet terminal, **or** has `batch_dispatched` records with no matching `tc` record | **9** — merge any `_agent_out/` result first, then re-dispatch whatever is still unrecorded (see §9.1) |
| Plan exists · checkpoint has `stage_8_5` started · no `tc_review_summary` in checkpoint | **8.5** — reviewer was interrupted; re-dispatch with same inputs |
| Plan exists, no checkpoint · business scenarios still `prompt_status: "draft"` | **8.5** — the writer has not put them in the persona's words yet |
| Plan exists, no checkpoint · business scenarios not all passed by the realism judge | **8.6** — `realism-check.mjs --prep`, dispatch the judge, `--merge` |
| Plan exists, no checkpoint | **9** |
| Gaps `prioritized: true`, no plan | **8** |
| Gaps exist, not yet prioritized | **7** |
| Coverage exists, no gaps | **6** |
| `customer_evidence.json` exists · `knowledge.customer_evidence_complete` is absent | **4** — Stage 4 was interrupted after mining; resume from reconciliation |
| Knowledge `semantic_complete: true` | **5** |
| Knowledge `stage_3b_complete: true` · no `stage_progress` for Stage 3 | **3c** — tier assignments done; start `getColumns` for T1+T2 |
| Knowledge `stage_3a_complete: true` · `stage_3b_complete` absent | **3b** — tiering done; run quick dump scan |
| Knowledge with `stage_progress` for Stage 3 | **3c**, resuming mid-`getColumns` |
| Nothing | **1** |

> The `run_state: "complete"` → Stage 1 rule exists to prevent a past bug where kept artifacts
> silently skipped `getTables()` on re-runs. `--rerun` bypasses it deliberately — you are
> asserting the connector has not changed. No script checks connectivity: the orchestrator makes
> one `getCatalogs` call before trusting the cached schema.
>
> **Compaction resilience flags** — these small markers in `knowledge.json` and the checkpoint
> protect against a compaction happening mid-stage and silently skipping work:
> `stage_3a_complete`, `stage_3b_complete` (§3 tiering), `customer_evidence_complete` (§4),
> `stage_8_5` / `stage_10_5` stage-start markers (in checkpoint JSONL). The routing table above
> uses them to resume at the exact right sub-stage rather than re-running or skipping.
> `batch_dispatched` checkpoint records tell the Stage 9 resume path which TCs a cut-off batch
> had already sent. Those are recovered from `_agent_out/` where a result landed, and
> **re-dispatched** where none did — never waited on, because the compaction that interrupted the
> batch also destroyed the context the result would have returned into.
