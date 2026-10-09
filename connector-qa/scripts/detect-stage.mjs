#!/usr/bin/env node
/**
 * detect-stage.mjs — Step 0.4 auto-detect, as code.
 *
 *   node detect-stage.mjs --dir <connector folder> [--max-rounds 3] [--resume] [--fresh]
 *
 * Prints one JSON line: {"stage":N,"reason":"...","run_state":"...","warnings":[...]}.
 *
 * Review finding C1: a completed run kept knowledge/coverage/gaps and deleted plan/checkpoint,
 * so the prose routing table sent the NEXT run to Stage 8 holding already-resolved gaps and
 * never called getTables() again. This script is the fix: a run marked complete routes to
 * Stage 1 unless --resume is given, and archives are the model's business, not the router's.
 *
 *   --fresh   ignore everything on disk (the user wants a clean run)
 *   --resume  continue a completed run's artifacts as-is (rare; for debugging a report)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonl, loadConfig } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { areaFreezeState } from './lib/catalog.mjs';
import { resolveAreas } from './lib/scope.mjs';
import { apiListState, frozenAreasReferencing, UNVERIFIED_NOTE } from './lib/api-provenance.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'fresh', 'resume', 'rerun', 'max-rounds', 'areas', 'all'],
  usage: 'usage: detect-stage.mjs --dir <connector folder> [--max-rounds N] [--resume] [--fresh]',
});
if (!a.dir) { console.error('usage: detect-stage.mjs --dir <connector folder> [--max-rounds N] [--resume] [--fresh]'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const connector = resolveConnector(a.dir, a.connector);
const p = k => join(a.dir, cfg.artifacts[k].replace('{connector}', connector));
const jsonl = p('checkpoint').replace(/\.json$/, '.jsonl');
/* rounds removed — single-pass, surface-driven generation. --max-rounds is accepted and ignored. */
const warnings = [];
const out = (stage, reason, extra = {}) => { console.log(JSON.stringify({ stage, reason, warnings, ...extra })); process.exit(0); };

/* Delegated agents write their JSON to _agent_out/ before returning it, because a compaction
 * while they are in flight destroys a returned-only result — one Stage 3 batch ran 38 minutes.
 * Anything still sitting here on resume is finished work the orchestrator never merged. Surface
 * it on EVERY route, so a resumed run merges it rather than silently re-dispatching the same
 * research, or carrying on without it. */
{
  const agentOut = join(a.dir, '_agent_out');
  const entries = existsSync(agentOut) ? readdirSync(agentOut, { withFileTypes: true }) : [];
  /* Not "unmerged": capability and catalog reviews (stage1_5*, stage5_5*) are kept as evidence
   * once applied, and journeys (stage9-*, check-*, judge-*) are read by ingest-results, never merged. */
  /* inputs prepared for an agent or the orchestrator, and outputs already applied, are not pending merges */
  const KEPT = /^(stage1_5|stage5_5|stage9-|check-|judge|stage2-|stage3-|stage8_6|stage10_5|account-probe|test-data-|data-check|eval-rerun|recheck)/;
  const pending = entries.filter(e => e.isFile() && e.name.endsWith('.json') && !KEPT.test(e.name)).map(e => e.name);
  if (pending.length) warnings.push(
    `${pending.length} unmerged agent result(s) in _agent_out/ — merge these before re-dispatching: ${pending.join(', ')}`);
  /* Stage 9 journeys live in _agent_out/<run id>/. A run whose journeys never reached the results
   * store is invisible to every report and eval. */
  const root = resolve(process.env.CONNECTOR_QA_ROOT || cfg.root || dirname(resolve(a.dir)));
  for (const e of entries.filter(x => x.isDirectory())) {
    const has = readdirSync(join(agentOut, e.name)).some(f => /^stage9-.*\.json$/.test(f));
    if (has && !existsSync(join(root, '_results', connector, e.name, 'manifest.json')))
      warnings.push(`journeys for run ${e.name} in _agent_out/${e.name}/ are not in the results store — run ingest-results.mjs --run ${e.name}`);
  }
}

if (a.fresh) out(1, '--fresh: ignoring artifacts on disk', { run_state: 'fresh' });

let K = null;
try { K = readJson(p('knowledge'), { required: false }); }
catch (e) { out(1, `knowledge.json unreadable or incompatible schema (${e.message}); starting fresh`, { run_state: 'incompatible' }); }

/* C1 — a completed run is a finished run */
if (K && K.run_state === 'complete' && !a.resume && !a.rerun) {
  out(1, `previous run completed ${K.completed_at || '(time unknown)'}; starting fresh so discovery re-runs against current metadata. Pass --resume to reopen the finished artifacts instead.`,
      { run_state: 'complete', previous_run: K.run_meta || null });
}

const has = f => existsSync(f);
/* what the checkpoint recorded as started, and what it recorded as finished */
const marker = key => (ckJsonl || []).some(r => r.type === 'stage_start' && r.key === key);
const summary = key => (ckJsonl || []).find(r => r.type === 'summary' && r.key === key);
/* shard packages and returned patches, counted from disk rather than from memory */
const countFiles = re => { try { return readdirSync(a.dir).filter(f => re.test(f)).length; } catch { return 0; } };
const ckJsonl = has(jsonl) ? readJsonl(jsonl) : null;
const ckJson  = has(p('checkpoint')) ? readJson(p('checkpoint')) : null;
const plan    = has(p('plan')) ? readJson(p('plan')) : null;
const gaps    = has(p('gaps')) ? readJson(p('gaps')) : null;
const cov     = has(p('coverage')) ? readJson(p('coverage')) : null;
const review  = has(p('tc_review')) ? readJson(p('tc_review')) : null;

/* 3.1 · a business-area scope exists only in capability mode — refused before any route is taken */
const scopeGiven = !!((a.areas && a.areas !== true) || a.all === true);
if (scopeGiven && K && K.run_meta?.mode !== 'capability')
  out('abort', '--areas / --all need capability mode (run_meta.mode = "capability"): the 2.x coverage flow has no business-area scope — references/13-scope.md', { run_state: 'error' });

/* ── Stage 8.5 · resume a review that a compaction interrupted ──────────────
 * The review is the most expensive thing before execution: it reads everything, researches, and
 * writes the missing tests. Losing it to a compaction means paying for it twice — or worse,
 * routing to Stage 9 with an unreviewed plan, which is the failure the stage exists to prevent.
 *
 * Everything needed to resume is on disk. review-prep writes the shard packages; each returned
 * patch is written as it arrives. So the question "where did we get to" is answered by counting
 * files, and a resumed run re-dispatches only the shards whose patch is missing. */
if (plan && !plan.reviewed_at && marker('stage_8_5') && !summary('tc_review_summary')) {
  const shards  = countFiles(/_review_input(_\d+of\d+)?\.json$/);
  const patches = countFiles(/_review_patch/);
  /* Name the missing shards. "2 of 6 returned" says to resume but not WHAT to resume, and
   * re-dispatching all six would discard a review already paid for. */
  const listed = (() => { try { return readdirSync(a.dir)
    .map(f => (f.match(/_review_patch_(\d+)of\d+/) || [])[1]).filter(Boolean).map(Number); } catch { return []; } })();
  const done = new Set(listed);
  const missing_shards = shards > 1
    ? Array.from({ length: shards }, (_, i) => i + 1).filter(i => !done.has(i)) : [];
  if (shards) {
    out(8.5, patches >= shards
      ? `Stage 8.5 was interrupted after all ${patches} patch(es) returned — run review-merge.mjs to apply them; nothing needs re-reviewing`
      : `Stage 8.5 was interrupted: ${patches} of ${shards} shard patch(es) are on disk. Re-dispatch ONLY shard(s) ${missing_shards.join(', ') || '(single shard)'} — the returned patches are durable and must not be discarded`,
      { run_state: 'reviewing', shards, patches_on_disk: patches, missing_shards,
        resume: patches >= shards ? 'merge' : 'redispatch_missing' });
  }
}

/* A finished Stage 8.5 that was never written back to the plan is invisible to every other rule:
 * the plan looks complete, so the router sends the run to Stage 9 and the review is silently
 * discarded. In asn005 that would have executed the unreviewed plan — including seven behaviour
 * prompts that interpolated to the literal string "undefined" — and thrown away 32 added tests.
 * The review is only applied once `plan.reviewed_at` is stamped, so check that, not file presence. */
if (plan && review && !plan.reviewed_at && (review.updated_tc_list || []).length) {
  out(8.5, `Stage 8.5 completed (${review.updated_tc_list.length} TCs reviewed, ${review.tcs_added ?? 0} added) but the plan still holds ${(plan.tc_list || []).length} and carries no reviewed_at — apply updated_tc_list to the plan before executing`,
      { run_state: 'reviewing', review_tcs: review.updated_tc_list.length, plan_tcs: (plan.tc_list || []).length });
}

/* The JDBC suite is written at the end of Stage 8.5, the moment the plan stops changing, so that
 * the driver can be verified directly while the MCP run is still going. A run interrupted between
 * 8.5 and 9 resumes into execution and would never produce it — and by Stage 12 the point of
 * having it early is gone. Cheap to notice here, expensive to notice afterwards. */
/* Gating on `reviewed_at` meant the warning never fired for a run with skip_tc_review: true —
 * which is exactly the run that reaches Stage 9 with no suite and nobody to notice. Any plan that
 * exists is a plan that should have produced one. */
if (plan && (plan.tc_list || []).length && cfg.artifacts.jdbc_suite && !existsSync(p('jdbc_suite')))
  warnings.push(`plan is reviewed but the JDBC suite is missing — run export-jdbc-suite.mjs before Stage 9 so the driver can be verified alongside execution rather than after it`);

/* ── Stage 10.5 · the post-execution review, same shape ────────────────────
 * Documented in the routing table and unreachable from the router: nothing read the marker, so an
 * interrupted post-exec review was simply skipped and the report shipped without it. */
if (ckJsonl && marker('stage_10_5') && !summary('post_exec_review')) {
  out(10.5, 'Stage 10.5 started but recorded no post_exec_review — the reviewer was interrupted; re-dispatch it with the same inputs',
      { run_state: 'reviewing' });
}

/* ── Stage 3 · sub-stage resume ────────────────────────────────────────────
 * On a large connector Stage 3 is the longest stage in the run — getColumns across hundreds of
 * objects. It was all-or-nothing: a compaction anywhere inside it restarted the whole thing.
 * 3a tiers from signals, 3b scans dumps for frequencies, 3c fetches columns for T1+T2. */
if (K && !K.semantic_complete) {
  if (K.stage_3b_complete)      out('3c', 'Stage 3a and 3b are done — resume at 3c, the getColumns pass for T1+T2 objects', { run_state: 'discovering' });
  if (K.stage_3a_complete)      out('3b', 'Stage 3a (tiering) is done — resume at 3b, the dump frequency scan', { run_state: 'discovering' });
  if (K.stage_progress)         out('3c', `Stage 3 was interrupted mid-getColumns (${JSON.stringify(K.stage_progress)}) — resume from the recorded position rather than refetching`, { run_state: 'discovering' });
}

/* ── Stage 4 · customer evidence ───────────────────────────────────────────
 * Mining a dump can take minutes. If the evidence file exists but was never reconciled into the
 * knowledge model, the mining is done and only the merge is outstanding. */
if (K && has(join(a.dir, 'customer_evidence.json')) && !K.customer_evidence_complete) {
  out(4, 'customer_evidence.json exists but was never reconciled into knowledge — resume Stage 4 at the merge, the mining is already done',
      { run_state: 'discovering' });
}

/* --rerun: the connector has not changed, so keep knowledge + gaps and go straight to planning or
 * executing. SKILL.md §0.2 has documented this flag since v2.0.0 but the router never read it, so
 * it silently did nothing and every rerun paid for a full rediscovery. */
if (K && K.run_state === 'complete' && a.rerun) {
  if (plan && (plan.tc_list || []).length) out(9, `--rerun: executing the ${plan.tc_list.length} TC(s) already planned`, { run_state: 'executing' });
  if (gaps && gaps.prioritized) out(8, '--rerun: knowledge and gaps kept; regenerating tests', { run_state: 'planning' });
  out(7, '--rerun: gaps exist but are not yet prioritized', { run_state: 'planning' });
}

if (ckJsonl || ckJson) {
  const done = new Set(ckJsonl ? ckJsonl.filter(l => l.type === 'tc').map(l => l.tc.id) : (ckJson.tcs_completed || []));
  const planned = (plan && plan.tc_list || []).map(t => t.id);
  const remaining = planned.filter(id => !done.has(id));
  /* P3 counts here. The scorer puts most real work in P3 when there is no customer dump, so a
   * P1/P2-only trigger ends the run while the actual backlog is untouched. */
  const openGaps = (gaps && gaps.gaps || []).filter(g => ['P1', 'P2', 'P3'].includes(g.priority) && (g.final_status === 'OPEN' || g.final_status === 'PARTIALLY_CLOSED')).length;
  /* A TC dispatched into a parallel batch but with no result recorded was IN FLIGHT when the
   * compaction hit. It is not the same as never started: the agent may have run, mutated data and
   * returned into a context that no longer exists. Re-dispatching a write blindly would apply it
   * twice, so these are named separately and the orchestrator is told to check before re-running. */
  const dispatched = new Set(ckJsonl ? ckJsonl.filter(l => l.type === 'batch_dispatched')
    .flatMap(l => l.tc_ids || (l.tc_id ? [l.tc_id] : [])) : []);
  const inFlight = [...dispatched].filter(id => !done.has(id));
  if (inFlight.length) warnings.push(
    `${inFlight.length} TC(s) were dispatched but recorded no result — in flight when the run was interrupted: ` +
    `${inFlight.slice(0, 6).join(', ')}${inFlight.length > 6 ? ' …' : ''}. ` +
    `Check whether a mutating one already applied before re-dispatching it.`);

  if (remaining.length) out(9, `checkpoint has ${done.size}/${planned.length} TCs; resuming at ${remaining[0]}`,
    { run_state: 'executing', resume_at: remaining[0], remaining: remaining.length,
      ...(inFlight.length ? { in_flight: inFlight } : {}) });
  if (!planned.length) warnings.push('checkpoint exists but plan.json is missing or empty — TCs cannot be matched to the plan');
  /* Single pass — no iteration. Generation is surface-driven, so there is nothing to converge
   * toward, and the old round loop corrupted gap.planned_tests by renumbering TCs on each pass.
   * Gaps still open at the end are reported as guidance for the next run, not re-tested here. */
  const reconciled = ckJsonl ? ckJsonl.some(l => l.type === 'summary' && l.key === 'exec_summary') : !!ckJson.exec_summary;
  if (reconciled) out(12, `all ${done.size} TCs terminal and reconciled; ${openGaps} P1–P3 gaps remain open — reported, not re-tested`, { run_state: 'reporting' });
  out(10, `all ${done.size} TCs terminal; reconciling ${openGaps} open P1–P3 gap(s)`, { run_state: 'reconciling' });
}
/* ── Stages 1.5 / 5.5 · capability mode (3.0) ───────────────────────────────
 * A run that answers "can I do through CData what the source can do?" needs the source's
 * capability list mapped and reviewed before research builds on it, and an approved catalog
 * before any test is generated. Only routes when the run declared the mode, so every other run
 * behaves exactly as before. */
/* 3.1 · scope. With --areas / --all the run covers those areas: each must be researched and
 * frozen (5.5) before it is planned, and a plan that does not cover them is regenerated (8).
 * Without a scope, any frozen area lets the run move on — the plan covers the frozen ones. */
/* a plan prepare-run emptied: every test in scope already has a valid stored result */
/* …for the model this session runs: in an eval, a plan prepared for opus says nothing about sonnet */
/* 3.9.2 · an API list assembled without evidence (lib/api-provenance.mjs) is rebuilt with
 * api-from-docs.mjs before research builds on it. A rebuild keeps reviewed mappings and frozen areas;
 * frozen areas whose use cases need a removed or moved capability are named, never unfrozen. */
let apiState = null;
if (K && K.run_meta?.mode === 'capability' && has(p('capabilities'))) {
  const caps0 = readJson(p('capabilities'));
  apiState = apiListState(a.dir, connector, caps0, K.run_meta);
  const r = caps0.rebuild;
  if (r) for (const f of frozenAreasReferencing(has(p('catalog')) ? readJson(p('catalog')) : null, [...(r.removed || []), ...(r.moved || [])]))
    warnings.push(`frozen area ${f.area}: ${f.use_cases} use case(s) need a capability the API list rebuild removed or moved (${f.capabilities.slice(0, 6).join(', ')}${f.capabilities.length > 6 ? ' …' : ''}) — check them; the area stays frozen`);
  if (apiState.status === 'unverified' && !apiState.kept && plan && (plan.tc_list || []).length)
    warnings.push(`${UNVERIFIED_NOTE} (references/10-capabilities.md §1.5a); the plan was built on it. Why: ${apiState.reasons[0]}`);
}
const nothingToRun = !!(plan?.prepared && plan.prepared.to_run === 0 && (plan.full_tc_list || []).length
  && plan.prepared.model === (K?.run_meta?.models?.under_test || cfg.models?.under_test));
if (K && K.run_meta?.mode === 'capability' && (scopeGiven || !(plan && (plan.tc_list || []).length))) {
  const capsP = p('capabilities'), catP = p('catalog');
  const caps = has(capsP) ? readJson(capsP) : null;
  if (!caps) out(1.5, 'capability mode: no capability list yet — read the source\'s API description (references/10-capabilities.md)', { run_state: 'discovering' });
  const cat = has(catP) ? readJson(catP) : null;
  if (apiState?.status === 'unverified' && !apiState.kept) {
    const frozen = Object.keys(cat?.areas || {}).filter(id => areaFreezeState(cat, id) === 'frozen');
    out('1.5a', `capability mode: ${UNVERIFIED_NOTE} (references/10-capabilities.md §1.5a). Why: ${apiState.reasons[0]}`,
      { run_state: 'discovering', api_list: 'unverified', reasons: apiState.reasons, frozen_areas: frozen,
        next: `rebuild with api-from-docs.mjs (its status shows how far a rebuild got), then capability-list.mjs read: reviewed mappings and area grouping are kept for ids that still match; frozen areas stay frozen${frozen.length ? ` (${frozen.join(', ')}) — status names any whose use cases need a changed capability` : ''}` });
  }
  const unreviewed = (caps.capabilities || []).filter(c => !c.mapping || (c.mapping.confidence === 'low' && !c.review)).length;
  /* after a rebuild, 1.5c reviews only what changed */
  const rb = caps.rebuild ? ` (the API list rebuild added ${caps.rebuild.added.length} and moved ${caps.rebuild.moved.length} — review only those; capability-list.mjs status lists them)` : '';
  if (unreviewed || !(caps.areas || []).length)
    out(1.5, `capability mode: ${unreviewed} capabilit${unreviewed === 1 ? 'y' : 'ies'} unmapped or awaiting review${(caps.areas || []).length ? '' : ', no business areas yet'} — finish 1.5c${unreviewed ? rb : ''}`, { run_state: 'discovering' });
  let scope = null;
  if (scopeGiven) {
    if (a.all === true) scope = caps.areas.map(x => x.id);
    else {
      const r = resolveAreas(caps, a.areas);
      if (r.unknown.length) out('abort', `unknown business area(s): ${r.unknown.join(', ')} — areas: ${caps.areas.map(x => x.id).join(', ')}`, { run_state: 'error' });
      scope = r.ids;
    }
  }
  const states = Object.fromEntries((scope || caps.areas.map(x => x.id)).map(id => [id, cat ? areaFreezeState(cat, id) : 'empty']));
  const extra = { run_state: 'planning', scope: scope || null, areas: states };
  if (K.semantic_complete) {
    const open = Object.entries(states).filter(([, st]) => st !== 'frozen').map(([id]) => id);
    if (scope && open.length)
      out(5.5, `capability mode: ${open.length} area(s) in scope not frozen — ${open.map(id => `${id} ${states[id] === 'empty' ? 'not researched' : states[id]}`).join(', ')} — references/13-scope.md`, extra);
    if (!scope && !Object.values(states).includes('frozen'))
      out(5.5, `capability mode: ${cat ? 'no business area frozen yet' : 'no use case catalog yet'} — references/11-catalog.md`, extra);
    if (scope) {
      /* Stage 8 plans from the coverage model and the prioritised gaps. A fresh scoped run reaches
       * this point with neither (asn-tr1: generate-tests failed "missing Asana_coverage.json"), so
       * Stages 5–7 come first, exactly as in an unscoped run. */
      if (!cov) out(5, 'capability mode: areas in scope are frozen; no coverage model yet — Stage 5 (references/04-coverage-model.md), then 6 and 7, before planning', extra);
      if (!gaps) out(6, 'capability mode: coverage model exists; no gaps file — Stage 6 (references/05-gap-analysis.md)', extra);
      if (!gaps.prioritized) out(7, `capability mode: ${(gaps.gaps || []).length} gaps computed, not yet prioritised — Stage 7`, extra);
      /* 3.7.1: the records the use cases need are found (or seeded) before the plan is written */
      const fxIn = (cat?.fixtures || []).filter(f => scope.includes(f.area));
      const tdP = join(a.dir, `${connector}_test_data.json`);
      const td = has(tdP) ? readJson(tdP) : null;
      const notLooked = fxIn.filter(f => !td?.fixtures?.[f.id]?.status);
      if (notLooked.length) out(8, `capability mode: ${notLooked.length} fixture(s) not yet looked for in the account — test data first: test-data.mjs find-prep/find-merge, then seed-prep with the user's approval (references/07-execution.md §9.0b)`, extra);
      const covered = new Set(plan?.scope?.areas || []);
      const stalePlan = plan && cat && scope.some(id => (cat.areas?.[id]?.frozen_at || '') > (plan.generated_at || ''));
      if (!plan || !(plan.full_tc_list || plan.tc_list || []).length || scope.some(id => !covered.has(id)) || stalePlan)
        out(8, `capability mode: the plan does not cover ${scope.join(', ')} as frozen — generate-tests.mjs --areas ${scope.join(',')}`, extra);
    }
  }
  if (nothingToRun)
    out(12, `capability mode: every test in scope already has a valid stored result for ${plan.prepared.model} — nothing to run; build the combined report (build-capability-report.mjs)`, { ...extra, run_state: 'reporting' });
}

/* ── Stages 8.5 / 8.6 · business prompts must be rewritten and judged before anything runs ──
 * Business tests are born as drafts (generate-tests.mjs). Executing them unrewritten measures the
 * generator's template, and executing them unjudged is how asn005 ran 329 prompts that management
 * then found unrealistic. So a plan with business tests routes to 8.5 while any are still drafts,
 * and to 8.6 until realism-check.mjs has passed them — unless realism.enforce is off. */
if (plan && (plan.tc_list || []).length && cfg.defaults?.realism?.enforce !== false) {
  const biz = plan.tc_list.filter(t => t.suite === 'business');
  const drafts = biz.filter(t => t.prompt_status === 'draft');
  const rs = plan.realism_summary;
  /* A use case from the frozen catalog was judged and human-sampled when the catalog was frozen
   * (3.0), for this exact wording — it needs no second pass. Anything else needs Stage 8.6. */
  const approved = t => t.prompt_status === 'approved' && t.realism && t.realism.judged_prompt === t.prompt;
  const pending = biz.filter(t => !approved(t));
  const passed = !pending.length || (rs && rs.passing === biz.length && !(rs.drafts || []).length
    && biz.every(t => t.realism && t.realism.judged_prompt === t.prompt));
  if (biz.length && drafts.length && !cfg.defaults?.skip_tc_review)
    out(8.5, `${drafts.length} of ${biz.length} business scenario(s) are still generator drafts — Stage 8.5 rewrites them in the persona's words before anything runs`, { run_state: 'reviewing' });
  if (biz.length && !passed)
    out(8.6, `${biz.length} business scenario(s) not yet passed by the realism judge${rs ? ` (${rs.passing}/${biz.length} passing at last check)` : ''} — run realism-check.mjs --prep, dispatch config.models.realism_judge, then --merge`, { run_state: 'reviewing' });
}
if (plan && (plan.tc_list || []).length) out(9, `plan has ${plan.tc_list.length} TCs and no checkpoint`, { run_state: 'executing' });
if (gaps) {
  if (gaps.prioritized) out(8, `${(gaps.gaps || []).length} gaps prioritized; no plan yet`, { run_state: 'planning' });
  out(7, `${(gaps.gaps || []).length} gaps computed; ${(gaps.gaps || []).filter(g => !g.business_importance).length} still need business_importance`, { run_state: 'prioritizing' });
}
if (cov) out(6, 'coverage model exists; no gaps file', { run_state: 'gap_analysis' });
if (K) {
  if (K.semantic_complete) out(5, 'knowledge complete; no coverage model', { run_state: 'modelling' });
  if (K.stage_progress && K.stage_progress.stage === 3) out(3, `semantic schema ${K.stage_progress.done}/${K.stage_progress.total} objects; resuming`, { run_state: 'semantic', progress: K.stage_progress });
  out(3, 'knowledge exists but semantic schema incomplete', { run_state: 'semantic' });
}
/* ── Stage 0.5 · driver source analysis ────────────────────────────────────
 * The router never emitted 0.5, so every run with a configured driver root still went straight
 * to Stage 1 — skipping the one stage that tells the pipeline which objects CData documented vs
 * which were generated at runtime. Check here, immediately before the Stage 1 fallback, so that
 * a fresh run with a known driver root routes to 0.5 first. Only fires when no knowledge.json
 * exists yet (K is null at this point), so a run already past Stage 1 is not re-routed back. */
const driverRoot = process.env.CONNECTOR_QA_DRIVER_ROOT || (cfg.driver_source && cfg.driver_source.root) || '';
const driverSchema = join(a.dir, `${connector}_driver_schema.json`);
if (driverRoot && !existsSync(driverSchema)) {
  out(0.5, `driver source configured — no driver schema on disk yet; run Stage 0.5 before discovery to separate documented objects from generated ones`, { run_state: 'fresh', driver_root: driverRoot });
}

out(1, 'no artifacts found', { run_state: 'fresh' });



