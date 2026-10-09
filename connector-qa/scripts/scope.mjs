#!/usr/bin/env node
/**
 * scope.mjs — what exists for each business area, what to research next, and what still has to run (3.1).
 *
 *   node scope.mjs status        --dir <d> [--areas a,b | --all] [--model m] [--json]
 *   node scope.mjs research-plan --dir <d> (--areas a,b | --all) [--fill] [--cross A,B]
 *   node scope.mjs prepare-run   --dir <d> --run <id> [--model m] [--redo a,b|all]
 *
 * status         one row per area: research state, completeness, use cases, tests, valid results for
 *                the model, stale results, evals — and the next step. --json for the orchestrator.
 * research-plan  appends research batches to {C}_research_plan.json: ≤ scope.max_areas_per_batch areas
 *                and ≤ scope.max_capabilities_per_batch capabilities each. Areas with a pending batch
 *                keep it (continue); frozen areas are skipped (reset them with manage-catalog.mjs
 *                reset-area to redo). --fill plans a batch for only what the completeness check says
 *                is missing. --cross plans the cross-area pass for two frozen, related areas.
 * prepare-run    makes {C}_plan.json run only what has no valid stored result for the model: use
 *                cases already measured in this environment, on their current wording, are moved to
 *                plan.reused. The full plan is kept in plan.full_tc_list, so a later model or --redo
 *                starts from it again.
 */
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { readJson, writeJson, loadConfig, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { areaCompleteness, areaFreezeState, areaMix, personaBalance, MIX_DEFAULTS, PERSONA_DEFAULTS } from './lib/catalog.mjs';
import { fingerprintFor } from './lib/results.mjs';
import { accountReadiness } from './lib/capabilities.mjs';
import { compareView } from './lib/reference-mcp.mjs';
import { resolveAreas, researchBatches, crossDue, latestResults, areaStatus, nextStep, readEvals, SCOPE_DEFAULTS } from './lib/scope.mjs';

const CMDS = ['status', 'research-plan', 'prepare-run'];
const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'root', 'areas', 'all', 'model', 'json', 'fill', 'cross', 'run', 'redo', 'redo-uc', 'redo-uc-file', 'attempts'],
  usage: `usage: scope.mjs <${CMDS.join('|')}> --dir <connectorDir> [--areas a,b | --all]`,
});
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: scope.mjs <${CMDS.join('|')}> --dir <connectorDir> [--areas a,b | --all]`); process.exit(EXIT.USAGE); }

const cfg = loadConfig();
const L = { ...SCOPE_DEFAULTS, ...(cfg.scope || {}) };
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const root = resolve(a.root || process.env.CONNECTOR_QA_ROOT || cfg.root || dirname(resolve(a.dir)));
const maybe = n => existsSync(P(n)) ? readJson(P(n)) : null;

const capsDoc = maybe('capabilities');
if (!capsDoc || !(capsDoc.areas || []).length) fail(`no business areas yet — Stage 1.5 groups the capability list into areas (references/10-capabilities.md)`);
const cat = maybe('catalog') || { use_cases: [] };
const K = maybe('knowledge') || {};
const RP = P('research_plan');
const researchPlan = existsSync(RP) ? readJson(RP) : { connector: conn, batches: [] };
const model = a.model || cfg.models?.under_test || 'sonnet';

/** What a fill batch must find evidence for besides uncovered capabilities. */
function fillNeeds(id) {
  const mix = areaMix(cat, id, { ...MIX_DEFAULTS, ...(cfg.catalog?.mix || {}) });
  const out = mix.untagged ? [] : mix.missing.map(m => ({ kind: 'mix', need: m.need, what: `${m.min - m.have} more use case(s) that test: ${m.label}` }));
  const pb = personaBalance(cat, capsDoc, id, { ...PERSONA_DEFAULTS, ...(cfg.catalog || {}) });
  for (const p of pb.thin) out.push({ kind: 'persona', need: `persona:${p.persona}`, what: `${p.min - p.have} more use case(s) of ${p.persona}'s own work` });
  const rv = cat.areas?.[id]?.coverage_review;
  for (const f of rv?.findings || []) if (f.type.startsWith('missing_') && !rv.answers?.[f.n])
    out.push({ kind: 'review', need: f.n, what: f.what, persona: f.persona || null });
  return out;
}

/** --areas / --all → area ids; refuses unknown names and over-long lists. */
function scopeAreas({ required }) {
  if (a.all === true) return (capsDoc.areas || []).map(x => x.id);
  if (!a.areas || a.areas === true) { if (required) fail('name the scope: --areas <a,b> or --all', EXIT.USAGE); return null; }
  const { ids, unknown } = resolveAreas(capsDoc, a.areas);
  if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')}\n    areas: ${(capsDoc.areas || []).map(x => `${x.id} (${x.name})`).join(', ')}`, EXIT.USAGE);
  if (ids.length > L.max_areas_per_run) fail(`${ids.length} areas in one run — at most ${L.max_areas_per_run} (scope.max_areas_per_run). Name fewer, or use --all, which researches every area in batches.`, EXIT.USAGE);
  return ids;
}
const env = fingerprintFor(K, cat, maybe('test_data')).env_key;

/* ── status ──────────────────────────────────────────────────────────────── */
if (cmd === 'status') {
  const only = scopeAreas({ required: false });
  const results = latestResults(root, conn, { model, cat, env, capsDoc, testData: maybe('test_data') });
  const rows = areaStatus({ capsDoc, cat, researchPlan, plan: maybe('plan'), results, evals: readEvals(root, conn) })
    .filter(r => !only || only.includes(r.id));
  for (const r of rows) r.next = nextStep(r);
  const cross = crossDue(capsDoc, cat, researchPlan);
  if (a.json) { console.log(JSON.stringify({ connector: conn, model, env_key: env, areas: rows, cross_due: cross, limits: L })); process.exit(EXIT.OK); }
  const total = (capsDoc.areas || []).length;
  console.log(`SCOPE — ${conn} · ${total} business area(s) · ${(capsDoc.capabilities || []).length} capabilities · results for ${model}`);
  const W = (s, n) => String(s ?? '—').slice(0, n).padEnd(n);
  console.log(`  ${W('id', 6)} ${W('area', 24)} ${W('caps', 5)} ${W('personas', 9)} ${W('research', 16)} ${W('complete', 9)} ${W('use cases', 10)} ${W('results', 14)} ${W('eval', 10)} next`);
  for (const r of rows) {
    const research = r.research === 'frozen' ? `frozen v${r.version}` : r.research.replace('_', ' ');
    const comp = r.completeness && r.use_cases ? `${r.completeness.covered}/${r.completeness.total}${r.completeness.personas_missing ? '*' : ''}` : '—';
    const ex = r.executed && r.executed.total ? `${r.executed.valid}/${r.executed.total}${r.executed.stale ? ` ${r.executed.stale} stale` : ''}` : '—';
    console.log(`  ${W(r.id, 6)} ${W(r.name, 24)} ${W(r.capabilities, 5)} ${W(r.personas.length || '—', 9)} ${W(research, 16)} ${W(comp, 9)} ${W(r.use_cases || '—', 10)} ${W(ex, 14)} ${W(r.evaluated.join(',') || '—', 10)} ${r.next}`);
  }
  if (cross.length) console.log(`\n  cross-area pass due: ${cross.join(' · ')}  (scope.mjs research-plan --cross A,B)`);
  console.log(`\n  ${rows.filter(r => r.research === 'frozen').length} of ${rows.length} area(s) frozen · * = a persona of the area has no use case`);
  /* 3.6 — what the test account can show, per area (account-probe.mjs), before an area is chosen */
  const acct = maybe('account');
  if (acct) {
    console.log(`\n  TEST ACCOUNT (probed ${String(acct.at || '').slice(0, 10)}) — tables holding data per area`);
    for (const r of accountReadiness(capsDoc, acct).filter(x => !only || only.includes(x.id)))
      console.log(`  ${r.share >= 0.5 ? '✓' : '⚠'} ${W(r.id, 6)} ${W(r.name, 24)} ${r.data} of ${r.tables} hold data · ${r.empty} empty · ${r.refused} refused${r.needs_filter ? ` · ${r.needs_filter} need a filter` : ''}`);
  } else console.log('\n  Test account not probed yet — account-probe.mjs shows which areas it can really test.');
  /* 3.8 — the vendor's own MCP server (Stage 1.5e, on by default) */
  const ref = maybe('reference_mcp');
  if (ref?.none) console.log(`  Vendor MCP: none found (checked ${String(ref.checked_at || '').slice(0, 10)}).`);
  else if (ref?.tools?.length) {
    const v = compareView({ capsDoc, ref, catalog: maybe('catalog'), areas: only || null });
    const b = v?.caps.buckets;
    console.log(b ? `  Vendor MCP (${ref.server?.name}): ${b.both} both · ${b.cdata_only} only CData · ${b.vendor_only} only the vendor MCP · ${b.neither} neither${b.unmapped ? ` · ${b.unmapped} not compared yet (reference-mcp.mjs prep)` : ''}`
      : `  Vendor MCP (${ref.server?.name}): tool list read, not compared yet — reference-mcp.mjs prep`);
  } else if (cfg.capabilities?.compare_vendor_mcp !== false) console.log('  Vendor MCP not compared yet — Stage 1.5e (reference-mcp.mjs) runs by default.');
  process.exit(EXIT.OK);
}

/* ── research-plan ───────────────────────────────────────────────────────── */
if (cmd === 'research-plan') {
  const stamp = new Date().toISOString();
  const nextId = () => `RB-${String((researchPlan.batches || []).length + 1).padStart(3, '0')}`;
  const added = [], kept = [], skipped = [];
  if (a.cross) {
    const { ids, unknown } = resolveAreas(capsDoc, a.cross);
    if (unknown.length || ids.length !== 2) fail('--cross needs exactly two business areas, e.g. --cross TM,PP', EXIT.USAGE);
    const not = ids.filter(id => areaFreezeState(cat, id) !== 'frozen');
    if (not.length) fail(`the cross-area pass runs after both areas are frozen — ${not.join(', ')} is not`);
    const key = [...ids].sort().join('+');
    if ((researchPlan.batches || []).some(b => b.cross && [...b.areas].sort().join('+') === key && b.status !== 'superseded'))
      fail(`a cross-area batch for ${key} already exists — see ${RP}`);
    const caps = ids.flatMap(id => (capsDoc.areas.find(x => x.id === id).capability_ids || []));
    const b = { id: nextId(), cross: true, areas: ids, flows: null, capability_ids: [...new Set(caps)], personas: [], status: 'planned', planned_at: stamp };
    researchPlan.batches.push(b); added.push(b);
  } else {
    const ids = scopeAreas({ required: true });
    const fresh = [];
    for (const id of ids) {
      const st = areaFreezeState(cat, id);
      const pending = researchPlan.batches.filter(b => !b.cross && b.areas.includes(id) && b.status === 'planned');
      if (pending.length) { kept.push(...pending.filter(b => !kept.includes(b))); continue; }      // continue, never duplicate
      if (st === 'frozen' && !a.fill) { skipped.push(`${id}: already frozen — manage-catalog.mjs reset-area --areas ${id} to research it again`); continue; }
      if (a.fill) {
        const comp = areaCompleteness(cat, capsDoc, id);
        /* beyond capabilities: kinds of request below their floor, thin personas, and what the
         * coverage review found missing and nobody has answered yet */
        const needs = fillNeeds(id);
        if (comp.ok && !needs.length) { skipped.push(`${id}: complete — nothing to fill`); continue; }
        const thin = personaBalance(cat, capsDoc, id, { ...PERSONA_DEFAULTS, ...(cfg.catalog || {}) }).thin.map(p => p.persona);
        const b = { id: nextId(), fill: true, areas: [id], flows: null, capability_ids: comp.missing_caps.map(c => c.id),
          personas: [...new Set([...comp.personas_missing, ...thin])], ...(needs.length ? { needs } : {}), status: 'planned', planned_at: stamp };
        researchPlan.batches.push(b); added.push(b); continue;
      }
      const researched = researchPlan.batches.some(b => !b.cross && b.areas.includes(id) && b.status === 'done');
      if (researched && cat.use_cases.some(u => u.area === id && u.status !== 'retired')) {
        skipped.push(`${id}: researched, not frozen yet — continue at review (or --fill for what the completeness check lists)`); continue;
      }
      fresh.push(id);
    }
    for (const b of researchBatches(capsDoc, fresh, L)) {
      const nb = { id: nextId(), ...b, status: 'planned', planned_at: stamp };
      researchPlan.batches.push(nb); added.push(nb);
    }
  }
  researchPlan.connector = conn;
  writeJson(RP, researchPlan);
  console.log(`RESEARCH PLAN — ${conn} · limits ${L.max_areas_per_batch} area(s) / ${L.max_capabilities_per_batch} capabilities per batch`);
  for (const b of [...kept, ...added]) console.log(`  ${b.id} ${kept.includes(b) ? '(continuing)' : '(new)       '} ${b.cross ? 'cross-area ' : b.fill ? 'fill ' : ''}${b.areas.join('+')}${b.flows ? ` · flows ${b.flows.join(',')}` : ''} · ${b.capability_ids.length} capabilities · ${b.personas.length} persona(s)${b.needs?.length ? ` · ${b.needs.length} other gap(s)` : ''}`);
  for (const s of skipped) console.log(`  · ${s}`);
  if (!kept.length && !added.length) console.log('  nothing to research');
  else console.log(`\n  Dispatch agents/usecase-researcher.md once per batch, then: manage-catalog.mjs add --from <output> --batch <id>`);
  console.log(`\n→ ${RP}`);
  process.exit(EXIT.OK);
}

/* ── prepare-run ─────────────────────────────────────────────────────────── */
if (cmd === 'prepare-run') {
  if (!a.run || a.run === true) fail('--run <id> names the run this plan is prepared for', EXIT.USAGE);
  const plan = maybe('plan');
  if (!plan) fail(`no ${P('plan')} — generate-tests.mjs --areas … first`);
  const full = plan.full_tc_list || plan.tc_list || [];
  const redoAll = a.redo === 'all' || a.redo === true;
  const redo = redoAll ? null : new Set(a.redo ? resolveAreas(capsDoc, a.redo).ids : []);
  /* 3.7 — re-measure chosen use cases (eval.mjs lists where models disagreed): --redo-uc UC-1,UC-2
   * or --redo-uc-file <eval-rerun.json>, optionally with --attempts N for them */
  const ucFile = a['redo-uc-file'] && a['redo-uc-file'] !== true ? readJson(String(a['redo-uc-file'])) : null;
  const redoUc = new Set([...(a['redo-uc'] && a['redo-uc'] !== true ? String(a['redo-uc']).split(',').map(s => s.trim()) : []), ...((ucFile?.use_cases || []).map(x => x.id || x))]);
  const moreAttempts = Number(a.attempts) || 0;
  const res = latestResults(root, conn, { model, cat, env, capsDoc, testData: maybe('test_data') });
  const reused = [], run = [];
  for (const t of full) {
    const k = `${t.use_case_id}#${t.variant || 0}`;
    const again = redoAll || (redo && redo.has(t.business_domain)) || redoUc.has(t.use_case_id);
    if (redoUc.has(t.use_case_id) && moreAttempts > (t.attempts || 1)) t.attempts = moreAttempts;
    if (t.suite === 'business' && t.use_case_id && !again && res.valid.has(k)) reused.push({ tc_id: t.id, use_case_id: t.use_case_id, variant: t.variant || 0, run_id: res.chosen_from.get(k) });
    else run.push(t);
  }
  const stale = run.filter(t => t.use_case_id && res.stale.has(`${t.use_case_id}#${t.variant || 0}`));
  writeJson(P('plan'), { ...plan, full_tc_list: full, tc_list: run, reused,
    prepared: { model, run_id: a.run, at: new Date().toISOString(), env_key: env, to_run: run.length, reused: reused.length, redo: redoAll ? 'all' : [...(redo || [])] } });
  console.log(`PREPARE RUN — ${conn} · ${a.run} · ${model}`);
  console.log(`  ${run.length} test(s) to run · ${reused.length} reused from stored runs${stale.length ? ` · ${stale.length} re-run because their stored result is stale` : ''}`);
  if (!run.length) console.log(`\n  Nothing to run: every test in scope has a valid result for ${model}. Build the report (build-capability-report.mjs).`);
  const blockedReused = reused.filter(x => ['no_test_data', 'blocked_account'].includes(res.records.find(r => r.use_case_id === x.use_case_id && (r.variant || 0) === x.variant)?.outcome));
  if (blockedReused.length) console.log(`  ${blockedReused.length} reused result(s) were blocked by test data or the account; after seeding data or changing the account, run with --redo <area> to measure them again.`);
  process.exit(EXIT.OK);
}
