#!/usr/bin/env node
/**
 * eval.mjs — compare AI models on the same frozen use cases, reusing stored results.
 *
 *   node eval.mjs plan  --dir <connectorDir> [--models opus,sonnet,haiku] [--areas a,b] [--eval <id>] [--root <root>]
 *   node eval.mjs build --dir <connectorDir> [--eval <id>] [--root <root>] [--allow-incomplete]
 *
 * plan   for each model, which use cases in scope already have a valid stored result (measured in
 *        this environment — connector build, usage instructions, workspace — on the use case's
 *        current wording) and which still need a run. Since 3.1 this is decided per use case, so a
 *        model run on sales last month is reused for sales and run only for finance. Without
 *        --models, config.eval.default_models. Writes {C}_eval_plan.json.
 * build  once every model has a valid result for every use case in scope: one capability report
 *        per model, the eval report, and an eval summary under _results/<C>/evals/ that the next
 *        eval uses as its baseline. Everything that produces or judges the tests is fixed; only
 *        the agent under test varies (references/12-eval.md).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, loadConfig, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { fingerprintFor } from './lib/results.mjs';
import { areaFreezeState, liveUseCases, ucKeys } from './lib/catalog.mjs';
import { latestResults, resolveAreas } from './lib/scope.mjs';
import { evalReport } from './lib/report-data.mjs';
import { buildCombined, renderHtml } from './build-capability-report.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'models', 'eval', 'root', 'allow-incomplete', 'areas', 'all'],
  usage: 'usage: eval.mjs <plan|build> --dir <connectorDir> [--models a,b,c] [--areas a,b] [--eval id] [--root root]',
});
const cmd = a._[0];
if (!a.dir || !['plan', 'build'].includes(cmd)) { console.error('usage: eval.mjs <plan|build> --dir <connectorDir> [--models a,b,c] [--areas a,b] [--eval id]'); process.exit(EXIT.USAGE); }
const cfg = loadConfig();
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const root = resolve(a.root || process.env.CONNECTOR_QA_ROOT || cfg.root || dirname(resolve(a.dir)));
const here = dirname(fileURLToPath(import.meta.url));
const PLAN = P('eval_plan');
const safe = s => String(s).replace(/[^A-Za-z0-9_-]/g, '');
const K = readJson(P('knowledge'), { kind: 'knowledge' });
const cat = existsSync(P('catalog')) ? readJson(P('catalog')) : null;
const capsDoc = existsSync(P('capabilities')) ? readJson(P('capabilities')) : null;
if (!cat) fail('an eval needs a frozen use case catalog — the same exam for every model (manage-catalog.mjs freeze)');
const TDATA = existsSync(P('test_data')) ? readJson(P('test_data')) : null;
const env = fingerprintFor(K, cat, TDATA).env_key;

if (cmd === 'plan') {
  const models = (a.models && a.models !== true ? String(a.models).split(',') : (cfg.eval?.default_models || [])).map(s => String(s).trim()).filter(Boolean);
  if (models.length < 2) fail('an eval compares at least two models — --models opus,sonnet,haiku, or set config.eval.default_models', EXIT.USAGE);
  const withUc = [...new Set(liveUseCases(cat).map(u => u.area).filter(Boolean))];
  let areas;
  if (a.areas && a.areas !== true) {
    const { ids, unknown } = resolveAreas(capsDoc, a.areas);
    if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')}`, EXIT.USAGE);
    areas = ids;
  } else areas = withUc;
  /* Every area in scope must be frozen and unchanged: an edited area is a different exam. */
  const bad = areas.map(id => [id, areaFreezeState(cat, id)]).filter(([, s]) => s !== 'frozen');
  if (bad.length) fail(`every area in an eval must be frozen — ${bad.map(([id, s]) => `${id} is ${s === 'changed' ? 'edited since it was frozen' : s === 'empty' ? 'not researched' : 'not frozen'}`).join(' · ')}. Freeze it again so every model sits the same exam.`);
  const keys = liveUseCases(cat).filter(u => areas.includes(u.area)).flatMap(ucKeys);
  const evalId = a.eval && a.eval !== true ? a.eval : `evl_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)}`;
  const plan = { eval_id: evalId, created_at: new Date().toISOString(), env_key: env, fingerprint: fingerprintFor(K, cat, existsSync(P('test_data')) ? readJson(P('test_data')) : null),
    catalog_version: cat.version ?? null, areas, use_case_keys: keys,
    models: models.map(m => {
      const sel = latestResults(root, conn, { model: m, cat, env, areas, capsDoc, testData: TDATA });
      const have = keys.filter(k => sel.valid.has(k)).length;
      return { model: m, reused: have === keys.length, valid: have, missing: keys.length - have, stale: keys.filter(k => sel.stale.has(k)).length,
               run_id: `${evalId}-${safe(m)}`, reused_runs: sel.runs.map(r => r.run_id) };
    }) };
  writeJson(PLAN, plan);
  console.log(`EVAL PLAN — ${conn} · ${evalId} · ${areas.length} area(s) (${areas.join(', ')}) · ${keys.length} use case run(s) per model · environment ${env}`);
  for (const m of plan.models) console.log(`  ${m.model.padEnd(10)} ${m.reused ? `reuse stored results (${m.reused_runs.join(', ')})` : `RUN NEEDED as ${m.run_id} — ${m.missing} of ${keys.length} without a valid result${m.stale ? ` (${m.stale} stale)` : ''}${m.valid ? `, ${m.valid} reused` : ''}`}`);
  const todo = plan.models.filter(m => !m.reused);
  if (todo.length) {
    console.log(`\n  For each model above that needs a run:`);
    console.log(`    generate-tests.mjs --areas ${areas.join(',')} (once) · scope.mjs prepare-run --model <model> --run <id>`);
    console.log(`    Stage 9 with that model as the agent under test · ingest-results.mjs --run <id> --model <model>`);
    console.log(`  When all are stored: eval.mjs build --dir "${a.dir}" --eval ${evalId}`);
  } else console.log(`\n  Every model has a valid result for every use case. Next: eval.mjs build --dir "${a.dir}" --eval ${evalId}`);
  console.log(`\n→ ${PLAN}`);
  process.exit(EXIT.OK);
}

/* ── build ─────────────────────────────────────────────────────────────────── */
if (!existsSync(PLAN)) fail(`no ${PLAN} — run "eval.mjs plan" first`);
const plan = readJson(PLAN);
if (a.eval && a.eval !== true && a.eval !== plan.eval_id) fail(`${PLAN} is for eval ${plan.eval_id}, not ${a.eval}`);
/* the exam must still be the one the plan was made for */
if (plan.env_key && plan.env_key !== env) fail(`the environment changed since the eval was planned (${plan.env_key} → ${env}: connector build, usage instructions or workspace) — plan the eval again`);
const pricing = cfg.pricing || {};
const areas = plan.areas || null;
const keys = new Set(plan.use_case_keys || []);
const problems = [], warnings = [];
const sels = plan.models.map(m => {
  const sel = latestResults(root, conn, { model: m.model, cat, env, areas, capsDoc, testData: TDATA });
  const missing = [...keys].filter(k => !sel.valid.has(k));
  if (!sel.valid.size) problems.push(`${m.model} has no valid stored result for this exam — a run against a different connector build, instructions, workspace or wording is never compared`);
  else if (missing.length) {
    const stale = missing.filter(k => sel.stale.has(k)).length, inc = missing.filter(k => sel.incomplete.has(k)).length;
    const msg = `${m.model}: ${missing.length} of ${keys.size} use case run(s) without a valid result${stale ? ` (${stale} stale)` : ''}${inc ? ` (${inc} with a missing attempt)` : ''}`;
    (a['allow-incomplete'] ? warnings : problems).push(msg);
  }
  return { ...m, sel };
});
if (problems.length) fail(`cannot build the eval:\n    ${problems.join('\n    ')}\n    Every model needs a valid result for every use case in scope (pass --allow-incomplete to compare only the use cases every model finished).`);
for (const w of warnings) console.error(`  ⚠ ${w}`);

/* Compare like with like: only the use cases every model has a valid result for. */
const common = sels.reduce((set, m) => new Set([...set].filter(k => m.sel.valid.has(k))), keys);
if (!common.size) fail('no use case has a valid result on every model — nothing to compare');
/* every model re-scored against the same pool — the same shortest paths and speed norms */
const pool = sels.flatMap(m => m.sel.records.filter(r => common.has(`${r.use_case_id}#${r.variant || 0}`)));

const models = sels.map(m => {
  const data = buildCombined(root, conn, a.dir, { model: m.model, areas, pool, only: common });
  const rate = Number(pricing[m.model]?.per_mtok);
  /* cost per correct use case: one representative attempt per use case, as the score is */
  const tokens = data.use_cases.reduce((x, u) => x + (u.metrics?.tokens || 0), 0);
  const cost = Number.isFinite(rate) && tokens && data.ucs.worked ? Math.round((tokens / 1e6) * rate / data.ucs.worked * 100 * 10) / 10 : null;
  const reused = m.sel.runs.every(r => r.run_id !== m.run_id);
  return { model: m.model, run_id: m.sel.runs.map(r => r.run_id).join(', '), reused, data, cost_per_100_correct: cost };
});

/* baseline: the newest earlier eval of this connector, by when it was built */
const evDir = join(root, '_results', conn, 'evals');
mkdirSync(evDir, { recursive: true });
const earlier = readdirSync(evDir).filter(f => f.endsWith('.json') && f !== `${safe(plan.eval_id)}.json`)
  .map(f => JSON.parse(readFileSync(join(evDir, f), 'utf8')))
  .sort((x, y) => String(y.built_at || y.date).localeCompare(String(x.built_at || x.date)))[0] || null;

/* one capability report per model; the official one is the customers' model */
const reports = {};
for (const m of models) {
  /* eval-scoped (its areas, the use cases every model finished) — so never the connector's official report file */
  const official = m.model === cfg.models?.under_test;
  const file = `${conn}_capability_report_${safe(plan.eval_id)}_${safe(m.model)}.html`;
  writeFileSync(join(a.dir, file), renderHtml(m.data, join(here, '..', 'assets', 'capability-report-template.html')), 'utf8');
  reports[m.model] = { file, official };
}
const data = evalReport({ evalId: plan.eval_id, models, baseline: earlier });
data.reports = reports;
data.compared = { use_cases: common.size, incomplete: warnings, areas };

writeJson(join(evDir, `${safe(plan.eval_id)}.json`), { eval_id: plan.eval_id, date: data.date, built_at: new Date().toISOString(),
  env_key: env, fingerprint: plan.fingerprint, areas,
  models: models.map(m => ({ model: m.model, run_id: m.run_id, score: m.data.ucs.avg_score,
    scores: Object.fromEntries(m.data.use_cases.filter(u => Number.isFinite(u.score)).map(u => [u.id, u.score])) })) });

const tpl = readFileSync(join(here, '..', 'assets', 'eval-report-template.html'), 'utf8');
const json = JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const out = join(a.dir, `${conn}_eval_report_${safe(plan.eval_id)}.html`);
writeFileSync(out, tpl.replace('/*__DATA__*/null', () => json).replace('__TITLE__', `${conn} Model Eval`.replace(/[<>&]/g, '')), 'utf8');
console.log(`EVAL — ${conn} · ${plan.eval_id} · ${common.size} use case run(s) compared${areas ? ` · ${areas.join(', ')}` : ''}`);
for (const p of data.leaderboard) console.log(`  ${String(p.model).padEnd(10)} score ${p.score ?? '—'} · ${p.correct}/${p.total} correct · ${p.reused ? 'reused' : 'fresh'}`);
console.log(`  ${data.grid.filter(g => g.all_fail).length} use case(s) fail on every model · baseline ${earlier ? earlier.eval_id : 'none'}`);
/* 3.7 — where the models disagreed, or one model disagreed with itself across attempts: the use cases
 * worth measuring again with more attempts, if the comparison matters. Written, never run by itself. */
{ const cases = data.analysis?.cases || [];
  const close = cases.filter(c => ['split', 'unique_win', 'unique_failure'].includes(c.agreement)
    || Object.values(c.cells || {}).some(x => x && x.pass_rate != null && x.pass_rate > 0 && x.pass_rate < 1));
  if (close.length) {
    const f = join(a.dir, '_agent_out', 'eval-rerun.json');
    writeFileSync(f, JSON.stringify({ eval_id: plan.eval_id, at: new Date().toISOString(), use_cases: close.map(c => ({ id: c.id, agreement: c.agreement })) }, null, 2));
    console.log(`  ${close.length} use case(s) where the models disagreed or were inconsistent — to measure them again with more attempts, per model:`);
    console.log(`    scope.mjs prepare-run --dir "${a.dir}" --model <m> --run <id> --redo-uc-file "${f}" --attempts 3`);
  } }
console.log(`\n→ ${out}`);
for (const [, r] of Object.entries(reports)) console.log(`→ ${join(a.dir, r.file)}${r.official ? '  (official)' : ''}`);
