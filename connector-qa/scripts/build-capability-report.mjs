#!/usr/bin/env node
/**
 * build-capability-report.mjs — Stage 12: the capability report, from the results store.
 *
 *   node build-capability-report.mjs --dir <connectorDir> [--root <root>] [--model m] [--areas a,b] [--out <file>]
 *   node build-capability-report.mjs --dir <connectorDir> --run <id>        one stored run only
 *   node build-capability-report.mjs --dir <connectorDir> --analysis [--areas a,b]   research only, nothing run
 *
 * By default the report is COMBINED (3.1): for every use case in the catalog, the newest stored
 * result that is still valid — measured in this environment, on the use case's current wording —
 * whichever run produced it. Areas researched and run at different times therefore add up to one
 * report, and the header says how much of the connector it covers. --run reports a single run.
 *
 * Builds <Connector>_capability_report.html (or <Connector>_capability_report_<model>.html when the
 * model is not config.models.under_test — the official report is the customers' model).
 *
 * --analysis (3.8) builds <Connector>_analysis_report.html from the capability list, the catalog and
 * the account probe alone — no stored result is read. Each use case shows an outlook (ready · needs a
 * partly supported capability · not supported · source app only · the test account refuses it or has
 * no data), a forecast from what it needs, never a result. It never replaces the capability report.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, loadConfig, fail, EXIT, SKILL_VERSION } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { readRun, listRuns, fingerprintFor } from './lib/results.mjs';
import { capabilityReport, analysisView } from './lib/report-data.mjs';
import { compareView } from './lib/reference-mcp.mjs';
import { rescore } from './lib/scoring.mjs';
import { latestResults, resolveAreas, runEnvKey } from './lib/scope.mjs';
import { areaFreezeState, areaUseCases, ucKeys, areaCompleteness } from './lib/catalog.mjs';
import { apiListState } from './lib/api-provenance.mjs';

function load(dir, conn) {
  const Pd = n => join(dir, `${conn}_${n}.json`);
  const m = n => existsSync(Pd(n)) ? readJson(Pd(n)) : null;
  const capsDoc = m('capabilities'), knowledge = m('knowledge');
  /* 3.9.2 — a list assembled without evidence says so in the report (in memory only; nothing is written) */
  if (capsDoc?.source) { const st = apiListState(dir, conn, capsDoc, knowledge?.run_meta);
    if (st.status === 'unverified') capsDoc.source = { ...capsDoc.source, unverified: { reasons: st.reasons, ...(st.kept ? { kept: st.kept } : {}) } }; }
  return { capsDoc, catalog: m('catalog'), knowledge, plan: m('plan'), testData: m('test_data'), account: m('account'), reference: m('reference_mcp') };
}

/* 3.8 — the vendor's own MCP server beside CData's (reference-mcp.mjs). Added only once something
 * has been compared, so a report without it is exactly what it was. */
function withReference(data, { capsDoc, reference, catalog, areas = null }) {
  const v = compareView({ capsDoc, ref: reference, catalog, areas });
  if (v) data.reference = v;
  else if (reference?.none) data.reference_none = { checked_at: reference.checked_at || null, note: reference.note || null };
  return data;
}

/** The same use case in other stored runs, newest first — the report's history column. */
function historyOf(root, conn, exclude) {
  const history = new Map();
  for (const m of listRuns(root, conn)) {
    if (exclude.has(m.run_id)) continue;
    for (const r of readRun(root, conn, m.run_id).records) {
      if (r.suite !== 'business' || !r.use_case_id || r.variant || r.attempt !== 1 || !Number.isFinite(r.score)) continue;
      if (!history.has(r.use_case_id)) history.set(r.use_case_id, []);
      history.get(r.use_case_id).push({ run_id: m.run_id, date: String(m.finished_at || '').slice(0, 10), model: m.model, score: r.score });
    }
  }
  return history;
}
const minCallsOf = catalog => new Map((catalog?.use_cases || []).filter(u => u.check?.min_calls).map(u => [u.id, u.check.min_calls]));

/**
 * One stored run.
 * @param {{pool?: object[], only?: Set<string>}} opts  pool: records to re-score against. An eval passes exactly the runs it
 *   compares; a lone report uses every stored run of the connector, so its scores are measured
 *   against the best path any model has found, not against itself. only: "<use case or test id>#<variant>"
 *   keys to keep — an eval with --allow-incomplete shows every model the same use cases.
 */
export function buildData(root, conn, runId, dir, opts = {}) {
  const run = readRun(root, conn, runId);
  if (!run) fail(`no stored run ${runId} for ${conn} under ${join(root, '_results', conn)} — run ingest-results.mjs first`);
  const { capsDoc, catalog, knowledge, plan, testData, reference } = load(dir, conn);
  const cfg = loadConfig();
  const pool = opts.pool ?? listRuns(root, conn).filter(m => m.run_id !== runId).flatMap(m => readRun(root, conn, m.run_id).records);
  const mine = opts.only ? run.records.filter(r => opts.only.has(`${r.use_case_id || r.tc_id}#${r.variant || 0}`)) : run.records;
  const records = rescore(mine, { pool, minCalls: minCallsOf(catalog) }, cfg.scoring || {});
  /* 3.9.2 — the run's list is still the unverified one on disk: say so */
  const ms = run.manifest.capability_source, unv = capsDoc?.source?.unverified;
  const manifest = unv && ms && ms.path === capsDoc.source.path && ms.title === capsDoc.source.title ? { ...run.manifest, capability_source: { ...ms, unverified: unv } } : run.manifest;
  return withReference(capabilityReport({ manifest, records, capsDoc, catalog, knowledge, history: historyOf(root, conn, new Set([runId])), plan, testData }), { capsDoc, reference, catalog });
}

/** Where the report's results stand, area by area — what the header and banner print. */
export function scopeSummary(capsDoc, catalog, sel, areas = null) {
  const rows = (capsDoc?.areas || []).filter(ar => !areas || areas.includes(ar.id)).map(ar => {
    const keys = areaUseCases(catalog, ar.id).flatMap(ucKeys);
    const comp = catalog ? areaCompleteness(catalog, capsDoc, ar.id) : null;
    return { id: ar.id, name: ar.name, research: areaFreezeState(catalog, ar.id), use_cases: areaUseCases(catalog, ar.id).length,
      results: keys.filter(k => sel.valid.has(k)).length, total: keys.length,
      stale: keys.filter(k => sel.stale.has(k)).length, missing: keys.filter(k => !sel.valid.has(k)).length,
      complete: comp ? comp.ok : null };
  });
  const frozen = rows.filter(r => r.research === 'frozen');
  const all = (capsDoc?.areas || []).length;
  return { areas: rows, total_areas: all, researched: frozen.length, with_results: rows.filter(r => r.results > 0).length,
    complete: !areas && all > 0 && frozen.length === all && rows.every(r => r.total && r.missing === 0),
    not_researched: rows.filter(r => r.research !== 'frozen').map(r => r.name),
    runs: sel.runs };
}

/**
 * The combined report for one model: the newest valid result of every use case, across runs.
 * @param {{model?: string, areas?: string[]|null, pool?: object[], only?: Set<string>}} opts
 */
export function buildCombined(root, conn, dir, opts = {}) {
  const cfg = loadConfig();
  const { capsDoc, catalog, knowledge, plan, testData, reference } = load(dir, conn);
  if (!catalog) fail(`no ${conn}_catalog.json — a combined report reads use cases from the catalog (or pass --run <id>)`);
  const model = opts.model || cfg.models?.under_test || 'sonnet';
  const env = fingerprintFor(knowledge || {}, catalog, testData).env_key;
  const sel = latestResults(root, conn, { model, cat: catalog, env, areas: opts.areas || null, capsDoc, testData });
  if (!sel.runs.length) fail(`no stored result for ${model} in this environment (connector build, instructions, workspace) — run and ingest first`);
  const keep = r => !opts.only || opts.only.has(`${r.use_case_id || r.tc_id}#${r.variant || 0}`);
  const mine = [...sel.records.filter(keep), ...(opts.only ? [] : sel.conformance)];
  const pool = opts.pool ?? listRuns(root, conn).filter(m => runEnvKey(m) === env).flatMap(m => readRun(root, conn, m.run_id).records);
  const records = rescore(mine, { pool, minCalls: minCallsOf(catalog) }, cfg.scoring || {});
  const newest = listRuns(root, conn).find(m => sel.runs.some(r => r.run_id === m.run_id));
  const scope = scopeSummary(capsDoc, catalog, sel, opts.areas || null);
  const manifest = {
    connector: conn, run_id: sel.runs.length === 1 ? sel.runs[0].run_id : `combined · ${sel.runs.length} runs`, model,
    finished_at: newest?.finished_at || null, catalog_version: catalog.version ?? null,
    fingerprint: { ...(newest?.fingerprint || {}), env_key: env }, skill_version: SKILL_VERSION,
    complete: scope.areas.every(a => a.missing === 0), scoring: { weights: cfg.scoring?.weights || null },
    capability_source: capsDoc?.source || null, fixed_models: newest?.fixed_models || null,
    ...(newest?.orchestrator?.actual ? { orchestrator: newest.orchestrator } : {}),
  };
  const data = capabilityReport({ manifest, records, capsDoc, catalog, knowledge, history: historyOf(root, conn, new Set(sel.runs.map(r => r.run_id))), plan, testData });
  data.scope = scope;
  data.run.runs = sel.runs;
  return withReference(data, { capsDoc, reference, catalog, areas: opts.areas || null });
}

/**
 * The analysis report: what research found, before anything is run (3.8). The capability report's
 * data with no records — so its capability counts and gaps are the numbers a later run shows too —
 * plus an outlook per planned use case.
 * @param {{areas?: string[]|null}} opts
 */
export function buildAnalysis(root, conn, dir, opts = {}) {
  const { capsDoc, catalog, knowledge, plan, testData, account, reference } = load(dir, conn);
  if (!capsDoc) fail(`no ${conn}_capabilities.json — an analysis report needs the capability list (Stage 1.5)`);
  const areas = opts.areas || null;
  const stamp = [catalog?.updated_at, account?.at, capsDoc?.source?.read_at].filter(Boolean).sort().pop() || null;
  const manifest = {
    connector: conn, run_id: 'analysis', model: null, finished_at: stamp, catalog_version: catalog?.version ?? null,
    fingerprint: {}, skill_version: SKILL_VERSION, complete: false, scoring: { weights: null },
    capability_source: capsDoc?.source || null, fixed_models: null,
    ...(knowledge?.run_meta?.orchestrator?.actual ? { orchestrator: knowledge.run_meta.orchestrator } : {}),
  };
  const data = capabilityReport({ manifest, records: [], capsDoc, catalog, knowledge, plan, testData });
  const view = analysisView({ capsDoc, catalog, account, areas, knowledge });
  /* before a run a gap blocks nothing yet: weigh it by the planned use cases that need it */
  data.gaps = data.gaps.map(g => ({ ...g, blocked: view.needs[g.id] || 0 })).sort((a, b) => b.blocked - a.blocked || a.label.localeCompare(b.label));
  if (areas) data.areas = data.areas.filter(a => areas.includes(a.id));
  for (const a of data.areas) for (const c of a.capabilities) c.needed = view.needs[c.id] || 0;
  data.analysis = view;
  data.scope = scopeSummary(capsDoc, catalog, { valid: new Set(), stale: new Set(), runs: [] }, areas);
  return withReference(data, { capsDoc, reference, catalog, areas });
}

/** One line on the vendor MCP comparison, when there is one. */
const refLine = d => { const R = d.reference; if (!R) return null; const b = R.caps.buckets;
  return `  vs ${R.server?.name || 'vendor MCP'}: ${b.both} both · ${b.cdata_only} only CData · ${b.vendor_only} only the vendor MCP · ${b.neither} neither${b.app_only ? ` · ${b.app_only} source app only` : ''}${b.unmapped ? ` · ${b.unmapped} not compared` : ''}`; };

export function renderHtml(data, templatePath) {
  const tpl = readFileSync(templatePath, 'utf8');
  if (!tpl.includes('/*__DATA__*/null')) fail(`${templatePath} has no /*__DATA__*/ slot`);
  /* JSON inside a script tag: break any "</script" and HTML comment openers so the data cannot end the tag */
  const json = JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  return tpl.replace('/*__DATA__*/null', () => json).replace('__TITLE__', `${data.connector} ${data.analysis ? 'Analysis' : 'Capability'} Report`.replace(/[<>&]/g, ''));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const a = parseArgs(process.argv.slice(2), {
    known: ['dir', 'connector', 'root', 'run', 'out', 'model', 'areas', 'analysis'],
    usage: 'usage: build-capability-report.mjs --dir <connectorDir> [--root <root>] [--model m] [--areas a,b] [--run <id>] [--analysis] [--out file]',
  });
  if (!a.dir) { console.error('usage: build-capability-report.mjs --dir <connectorDir> [--run <id>]'); process.exit(EXIT.USAGE); }
  const cfg = loadConfig();
  const conn = resolveConnector(a.dir, a.connector);
  const root = resolve(a.root || process.env.CONNECTOR_QA_ROOT || cfg.root || dirname(resolve(a.dir)));
  const { capsDoc, catalog } = load(a.dir, conn);
  const areaIds = () => {
    if (!a.areas || a.areas === true) return null;
    const { ids, unknown } = resolveAreas(capsDoc, a.areas);
    if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')}`, EXIT.USAGE);
    return ids;
  };
  const tpl = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'capability-report-template.html');

  if (a.analysis) {
    if (a.run || a.model) fail('--analysis reads no results — drop --run / --model', EXIT.USAGE);
    const data = buildAnalysis(root, conn, a.dir, { areas: areaIds() });
    const out = a.out || join(a.dir, `${conn}_analysis_report.html`);
    writeFileSync(out, renderHtml(data, tpl), 'utf8');
    const v = data.analysis, o = v.outlook;
    console.log(`ANALYSIS REPORT — ${conn} · research only, nothing run`);
    console.log(`  capabilities ${data.caps.supported}/${data.caps.total} supported · ${data.caps.partly} partly · ${data.caps.not_exposed} not supported · ${data.caps.product_only} not applicable`);
    console.log(`  use cases ${v.use_cases.length} planned · ${o.ready} ready · ${o.partly} need a partly supported capability · ${o.unsupported} not supported · ${o.not_applicable} source app only · ${o.account_refused + o.account_empty} blocked by the test account${o.unknown ? ` · ${o.unknown} need a capability not in the list` : ''}`);
    if (refLine(data)) console.log(refLine(data));
    if (!v.account_probed) console.log('  account not probed — run account-probe.mjs (Stage 1.5d) to see what the test account can show');
    console.log(`\n→ ${out}`);
    process.exit(EXIT.OK);
  }

  let data;
  if (a.run || !catalog) {
    let runId = a.run;
    if (!runId || runId === true) runId = listRuns(root, conn)[0]?.run_id;
    if (!runId) fail(`no run to report on — pass --run, or ingest one first`);
    data = buildData(root, conn, runId, a.dir);
  } else {
    data = buildCombined(root, conn, a.dir, { model: a.model, areas: areaIds() });
  }
  const official = !cfg.models?.under_test || data.run.model === cfg.models.under_test;
  const out = a.out || join(a.dir, `${conn}_capability_report${official ? '' : '_' + String(data.run.model).replace(/[^A-Za-z0-9_-]/g, '')}.html`);
  writeFileSync(out, renderHtml(data, tpl), 'utf8');
  console.log(`CAPABILITY REPORT — ${conn} · ${data.run.id} · ${data.run.model}${official ? ' (official)' : ''}`);
  console.log(`  capabilities ${data.caps.supported}/${data.caps.total} supported · ${data.caps.partly} partly · ${data.caps.not_exposed + data.caps.product_only} not possible`);
  const pl = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
  console.log(`  use cases ${data.ucs.worked}/${data.ucs.total} correct · avg score ${data.ucs.avg_score ?? '—'} · ${pl(data.gaps.length, 'gap')} · ${pl(data.friction.length, 'friction class', 'friction classes')}`);
  if (refLine(data)) console.log(refLine(data));
  if (data.scope) {
    const s = data.scope;
    console.log(`  scope: ${s.researched} of ${s.total_areas} area(s) researched · ${s.with_results} with results · ${s.runs.length} run(s) combined${s.complete ? ' · complete' : ''}`);
    for (const ar of s.areas.filter(x => x.stale)) console.log(`  ⚠ ${ar.id}: ${ar.stale} result(s) stale — re-run with scope.mjs prepare-run`);
  }
  console.log(`\n→ ${out}`);
}
