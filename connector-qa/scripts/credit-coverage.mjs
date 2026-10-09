#!/usr/bin/env node
/**
 * credit-coverage.mjs — Stage 10, the arithmetic half.
 *
 *   node credit-coverage.mjs --checkpoint ckpt.jsonl|ckpt.json --coverage C.json --gaps gaps.json --knowledge K.json
 *
 * Credits coverage from what each test ACTUALLY sent (tc.observed), never from the plan.
 * If a test has observed.sql but no parsed fields, parses it here with the same regexes the
 * dump miner uses. Then recomputes every dimension, resolves each gap's final_status, and
 * derives the connector verdict by RULE (review C3):
 *
 *   any FAILED gap touching a Band-1 pattern         → not_ready
 *   any P1 gap OPEN or FAILED                        → at most needs_attention
 *   any EXPOSURE gap on a vendor standard report     → at most needs_attention
 *   pass_health ≥ 90 and gap_health ≥ 90            → production_ready
 *   otherwise                                        → needs_improvement
 *
 * Health is reported as TWO numbers — pass_health (tests) and gap_health (P1+P2 closure) —
 * so 98% passing with one open critical gap can no longer read as healthy.
 */
import { readJson, writeJson, readJsonl } from './lib/artifacts.mjs';
import { parseSql, bandOf } from './lib/sql-patterns.mjs';
import { parseArgs } from './lib/cli.mjs';
import { PLAN_LIMIT } from './lib/journey.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['checkpoint', 'coverage', 'gaps', 'knowledge', 'allow-mislabelled-boundary'],
  usage: 'usage: credit-coverage.mjs --checkpoint ckpt.jsonl --coverage C.json --gaps gaps.json --knowledge K.json',
});
for (const k of ['checkpoint', 'coverage', 'gaps', 'knowledge']) if (!a[k]) {
  console.error('usage: credit-coverage.mjs --checkpoint ckpt.jsonl --coverage C.json --gaps gaps.json --knowledge K.json'); process.exit(2); }

const C = readJson(a.coverage);
const G = readJson(a.gaps);
const K = readJson(a.knowledge);

/* ── load TCs from jsonl (preferred) or legacy json ──────────────────────── */
let tcs;
if (a.checkpoint.endsWith('.jsonl')) tcs = readJsonl(a.checkpoint).filter(r => r.type === 'tc').map(r => r.tc);
else { const ck = readJson(a.checkpoint); tcs = (ck.groups || []).flatMap(g => g.tcs || []); }
const PASS = new Set(['pass', 'pass_sql', 'pass_col', 'pass_tbl', 'pass_schema', 'pass_dtype', 'pass_query']);
const TERMINAL = new Set([...PASS, 'partial', 'fail', 'boundary', 'not_exec', 'na', 'nt']);
const KNOWN = new Set([...TERMINAL, 'ne']);

/* An unknown verdict code is a contract violation. Filtering it away silently loses the test
 * and quietly shrinks every denominator — the Asana run lost two TCs this way (pass_tab, pass_fix). */
const badStatus = tcs.filter(t => !KNOWN.has(t.status));
if (badStatus.length) {
  console.error(`\n✗ ${badStatus.length} TC(s) carry a verdict code that is not in 00-contracts.md §3:`);
  for (const t of badStatus) console.error(`    ${t.id}: "${t.status}"`);
  console.error('  Fix the verdict in the checkpoint, then re-run. Nothing was credited.');
  process.exit(1);
}

/* A passing verdict with no observed SQL and no tool call never executed. Crediting it
 * inflates pass_health with tests that did not run, which is how 18 unexecuted stored-procedure
 * TCs read as 99% passing. Downgrade to not_exec so the number tells the truth. */
const unproven = tcs.filter(t => PASS.has(t.status) && !(t.observed && t.observed.sql) && !(t.tool_calls > 0));
for (const t of unproven) { t.status = 'not_exec'; t.owner = t.owner || 'owner-ai'; }
if (unproven.length) {
  console.error(`\n⚠ ${unproven.length} TC(s) marked passing with no observed SQL and no tool call — downgraded to not_exec:`);
  console.error('    ' + unproven.map(t => t.id).join(' '));
}

tcs = tcs.filter(t => TERMINAL.has(t.status));

/* column roles for refinement */
const roles = {};
for (const o of K.objects || []) for (const c of o.columns || []) if (c.role) roles[c.name] = c.role === 'status' && /^is|^has|flag$/i.test(c.name) ? 'bool' : c.role;

/* ── ensure observed is parsed ───────────────────────────────────────────── */
for (const t of tcs) {
  if (t.observed && t.observed.sql && !(t.observed.patterns && t.observed.patterns.length)) {
    const p = parseSql(t.observed.sql, roles);
    t.observed = { ...t.observed, objects: p.objects, columns: p.columns, patterns: p.patterns, joins: p.joins,
      divergence: t.observed.divergence || (t.query_patterns || []).filter(x => !p.patterns.includes(x)).map(x => `planned ${x}, not observed`) };
  }
}

/* ── boundary audit: a boundary verdict must carry an actual refusal ─────── */
/* asn004 labelled empty tables `boundary`, and the report then printed "the driver rejected it"
 * next to a connector that had answered correctly and found nothing. `boundary` means the
 * connector or API actively said no; a query that ran to completion is never boundary, whatever
 * it returned. See 00-contracts.md §4, "The 0-row rule". */
/* No trailing \b: the real Asana refusal reads "without premium permissions", and anchoring the
 * word end rejected it on the plural — a guard against false accusations that made its own.
 * Plan and edition refusals count too: Asana says "not available on your current plan or add-ons"
 * and "requires resource management features to be enabled in an enterprise organization". */
const REFUSAL = /(\b40[13]\b|permission|denied|forbidden|unauthori[sz]ed|not allowed|refus|restricted|premium|licen[cs]e|entitle|quota|rate.?limit|safety|blocked|insufficient|current plan|plan or add-?ons|not available for free|requires .{0,80}\benterprise\b)/i;
const refused = x => REFUSAL.test(x) || PLAN_LIMIT.test(x);    // plan wording shared with lib/journey.mjs
const mislabelled = tcs.filter(t => t.status === 'boundary'
  && !(t.steps || []).some(s => refused(String(s.e || '')) || refused(String(s.r || ''))));
if (mislabelled.length) {
  console.error(`\n⚠ ${mislabelled.length} TC(s) marked \`boundary\` carry no refusal on any step.`);
  console.error(`  \`boundary\` asserts the connector said no. These ran to completion, so the verdict`);
  console.error(`  accuses the connector of a defect it did not commit. Re-verdict with the 0-row rule`);
  console.error(`  (00-contracts.md §4): \`pass\` if 0 rows answers the question, \`nt\` if the test needed rows.`);
  for (const t of mislabelled.slice(0, 10)) console.error(`    ${t.id} — ${String(t.uc || t.prompt || '').slice(0, 68)}`);
  if (mislabelled.length > 10) console.error(`    …and ${mislabelled.length - 10} more`);
  if (!a['allow-mislabelled-boundary']) {
    console.error(`\n  Refusing to credit coverage from verdicts that cannot be true.`);
    console.error(`  Fix the verdicts, or pass --allow-mislabelled-boundary to proceed anyway.`);
    process.exit(3);
  }
}

/* ── credit table (08-reconcile §10.2) ───────────────────────────────────── */
const credit = s => PASS.has(s) ? 'full' : s === 'partial' ? 'partial' : s === 'fail' ? 'failed' : s === 'boundary' ? 'boundary' : s === 'na' ? 'na' : s === 'nt' ? 'nt' : 'none';
const lower = s => String(s || '').toLowerCase();

const objRows = (((C.objects || {}).tables || {}).rows || []).concat((((C.objects || {}).views || {}).rows || []));
const objByName = Object.fromEntries(objRows.map(r => [lower(r.name), r]));
const colRows = (C.columns && C.columns.rows) || [];
const colKey = (o, c) => `${lower(o)}.${lower(c)}`;
const colByKey = Object.fromEntries(colRows.map(r => [colKey(r.object, r.column), r]));
const relRows = (C.relationships && C.relationships.rows) || [];
const patRows = (C.patterns && C.patterns.rows) || [];
const patByName = Object.fromEntries(patRows.map(r => [r.pattern, r]));
const intRows = (C.intents && C.intents.rows) || [];
const behRows = (C.behaviors && C.behaviors.rows) || [];
const spRows = (((C.objects || {}).procedures || {}).rows || []);
const ucRows = (C.use_cases && C.use_cases.rows) || [];

const creditedBy = new Set();
const bump = (row, state, tcId) => {
  if (!row) return;
  creditedBy.add(tcId);
  row.tc_ids = [...new Set([...(row.tc_ids || []), tcId])];
  const rank = { failed: 1, not_testable: 1, partially_covered: 2, tested: 3, covered: 4, fully_covered: 4, not_applicable: 5 };
  if (!row.state || (rank[state] || 0) >= (rank[row.state] || 0) || row.state === 'failed' && state !== 'failed' && state !== 'not_testable') row.state = state;
};

for (const t of tcs) {
  const c = credit(t.status), o = t.observed || {};
  const objState = c === 'full' ? 'tested' : c === 'partial' ? 'partially_covered' : c === 'failed' ? 'failed' : c === 'na' ? 'not_applicable' : c === 'nt' ? 'not_testable' : null;
  const itemState = c === 'full' ? 'covered' : c === 'partial' ? 'partially_covered' : c === 'failed' ? 'failed' : c === 'na' ? 'not_applicable' : c === 'nt' ? 'not_testable' : null;
  /* A boundary TC yields no object state — the query was refused, so no object was read — and the
   * `!objState` guard therefore returned before the boundary branch below could ever run. The
   * permission_boundary behaviour stayed uncovered no matter how many boundary tests passed, and
   * reconciliation reported "agent behaviors 0/1" on a run that had proven exactly that behaviour.
   * Credit it first, then return. */
  if (c === 'boundary') { const b = behRows.find(x => x.behavior === 'permission_boundary'); bump(b, 'covered', t.id); continue; }

  if (!objState) continue;

  for (const on of o.objects || []) bump(objByName[lower(on)], objState, t.id);
  for (const on of o.objects || []) for (const cn of o.columns || []) bump(colByKey[colKey(on, cn)], itemState, t.id);
  for (const j of o.joins || []) {
    const r = relRows.find(x => (lower(x.from) === lower(j.from) && lower(x.to) === lower(j.to)) || (lower(x.from) === lower(j.to) && lower(x.to) === lower(j.from)));
    bump(r, itemState, t.id);
  }
  for (const pn of o.patterns || []) if (patByName[pn]) bump(patByName[pn], itemState, t.id);
  if (t.business_intent) { const i = intRows.find(x => x.canonical === t.business_intent || x.id === t.business_intent); bump(i, itemState, t.id); }
  if (t.group_type === 'procedure' && t.sp_name) bump(spRows.find(x => x.name === t.sp_name), c === 'full' ? 'tested' : objState, t.id);
  if (t.group_type === 'behavior' && t.behavior) bump(behRows.find(x => x.behavior === t.behavior), itemState, t.id);
  for (const uid of t.use_case_ids || []) bump(ucRows.find(u => u.id === uid), itemState, t.id);
}

/* A passing test that credits nothing is a measurement that did not happen. Usually the TC is
 * missing its binding field (sp_name / behavior / use_case_ids), or a procedure recorded its EXEC
 * only as prose in steps[] instead of observed.sql — both leave the dimension reading 0. */
const whyUncreditable = t =>
    t.group_type === 'procedure' && !t.sp_name ? 'procedure TC carries no sp_name — the procedure stays uncovered'
  : t.group_type === 'procedure' && !(t.observed && t.observed.sql) ? 'procedure TC recorded no EXEC in observed.sql'
  : t.group_type === 'behavior' && !t.behavior ? 'behavior TC carries no behavior key — the behavior stays uncovered'
  : !creditedBy.has(t.id) ? 'credited nothing at all'
  : null;
const uncreditable = tcs.filter(t => PASS.has(t.status) && whyUncreditable(t));
if (uncreditable.length) {
  console.error(`\n⚠ ${uncreditable.length} passing TC(s) cannot be credited to the dimension they were written for:`);
  for (const t of uncreditable.slice(0, 12)) console.error(`    ${t.id}  ${whyUncreditable(t)}`);
  if (uncreditable.length > 12) console.error(`    … and ${uncreditable.length - 12} more`);
}

/* partial credit rule: a pattern the AI had to AVOID stays uncovered — mark from divergence */
for (const t of tcs) if (t.status === 'partial') for (const d of (t.observed || {}).divergence || []) {
  const m = /^planned (\w+)/.exec(d); if (m && patByName[m[1]] && patByName[m[1]].state !== 'covered') patByName[m[1]].state = 'not_covered';
}

/* ── recompute dimension totals ──────────────────────────────────────────── */
/* Deliberately NOT the shared isCovered: tally() reports `covered` and `na` as separate columns,
 * so a not_applicable row must not also be counted as covered or the two columns double-count. */
const isCredited = s => s === 'covered' || s === 'tested' || s === 'fully_covered';
/* …but for "was this dimension looked at", correctly-not-supported counts as settled. */
const isSettled = s => isCredited(s) || s === 'not_applicable';
const tally = rows => ({ total: rows.length, covered: rows.filter(r => isCredited(r.state)).length, failed: rows.filter(r => r.state === 'failed').length, na: rows.filter(r => r.state === 'not_applicable').length, nt: rows.filter(r => r.state === 'not_testable').length });
for (const pop of ['tables', 'views']) {
  const p = (C.objects || {})[pop]; if (!p) continue;
  p.by_tier = {};
  for (const T of ['T1', 'T2', 'T3', 'T4']) p.by_tier[T] = tally((p.rows || []).filter(r => r.tier === T));
  p.total = (p.rows || []).length;
}
if (C.columns) { C.columns.covered = colRows.filter(r => isCredited(r.state)).length; C.columns.total_important = colRows.length;
  C.columns.by_role = {}; for (const r of colRows) { const k = r.role || 'other'; C.columns.by_role[k] = C.columns.by_role[k] || { t: 0, c: 0 }; C.columns.by_role[k].t++; if (isCredited(r.state)) C.columns.by_role[k].c++; } }

/* per-object column rollup — the Schema Coverage tab reads these, and without this loop every
 * object reports columns_covered 0 no matter how many of its columns a test actually touched */
for (const o of objRows) {
  const mine = colRows.filter(r => lower(r.object) === lower(o.name));
  o.columns_important = mine.length;
  o.columns_covered = mine.filter(r => isCredited(r.state)).length;
}
if (C.relationships) { C.relationships.total = relRows.length; C.relationships.tested = relRows.filter(r => isCredited(r.state)).length; }
if (C.use_cases) { C.use_cases.total = ucRows.length; C.use_cases.covered = ucRows.filter(r => isCredited(r.state)).length; }

/* ── gap closure ─────────────────────────────────────────────────────────── */
/* true / false when the gap's key names an item in the coverage model, null when it does not */
const itemState = key => {
  const i = key.indexOf(':'); if (i < 0) return null;
  const kind = key.slice(0, i), name = key.slice(i + 1);
  const row = kind === 'uc'      ? ucRows.find(r => r.id === name)
            : kind === 'sp'      ? spRows.find(r => r.name === name)
            : kind === 'beh'     ? behRows.find(r => r.behavior === name)
            : kind === 'rel'     ? relRows.find(r => r.id === name)
            : kind === 'pattern' ? patRows.find(r => r.pattern === name)
            : null;
  return row ? isCredited(row.state) : null;
};

const tcById = Object.fromEntries(tcs.map(t => [t.id, t]));
for (const g of G.gaps || []) {
  if (['NOT_APPLICABLE', 'NOT_TESTABLE'].includes(g.final_status) && !(g.planned_tests || []).length) continue;
  const tests = (g.planned_tests || []).map(id => tcById[id]).filter(Boolean);
  if (!tests.length) { if (g.final_status !== 'NOT_TESTABLE' && g.final_status !== 'NOT_APPLICABLE') g.final_status = 'OPEN'; continue; }
  const st = tests.map(t => credit(t.status));
  if (st.some(s => s === 'na')) g.final_status = 'NOT_APPLICABLE';
  else if (st.every(s => s === 'full')) g.final_status = 'CLOSED';
  else if (st.some(s => s === 'full' || s === 'partial')) g.final_status = 'PARTIALLY_CLOSED';
  else if (st.every(s => s === 'nt')) g.final_status = 'NOT_TESTABLE';
  else if (st.some(s => s === 'failed')) { g.final_status = 'FAILED'; g.failed_owner = tests.find(t => t.status === 'fail' && t.owner)?.owner || null; }
  else g.final_status = 'OPEN';

  /* A gap that names a specific item cannot be CLOSED while that item reads uncovered. Closure
   * used to depend only on "did the planned test pass", so 50 use-case gaps closed against a
   * use-case dimension sitting at 0/35 — the gap ledger and the coverage model disagreed and the
   * ledger was the one being reported. */
  if (g.final_status === 'CLOSED') {
    const state = itemState(String(g.key || ''));
    if (state === false) { g.final_status = 'PARTIALLY_CLOSED'; g.closure_note = 'tests passed but the item this gap names was never credited — see credited_nothing'; }
  }
}

/* ── health, two numbers, and the verdict rule (C3) ──────────────────────── */
const counts = tcs.reduce((m, t) => (m[t.status] = (m[t.status] || 0) + 1, m), {});
const total = tcs.length, na = counts.na || 0;
const passing = tcs.filter(t => PASS.has(t.status) || t.status === 'partial' || t.status === 'boundary').length;
const pass_health = total - na ? Math.round(100 * passing / (total - na)) : 0;

/* gap_health spans P1–P3. P3 was excluded before, and because the scorer lands most real work
 * in P3 on a connector with no customer dump, 70 of 71 genuinely open gaps were invisible here
 * and to the Stage 11 iteration trigger — the run stopped at round 1 reporting 57% health. */
const DEAD = new Set(['NOT_APPLICABLE', 'NOT_TESTABLE']);
const scored = (G.gaps || []).filter(g => ['P1', 'P2', 'P3'].includes(g.priority));
const live = scored.filter(g => !DEAD.has(g.final_status));
const gap_health = live.length ? Math.round(100 * live.filter(g => g.final_status === 'CLOSED').length / live.length) : 100;
const openByPriority = live.filter(g => g.final_status !== 'CLOSED')
  .reduce((m, g) => (m[g.priority] = (m[g.priority] || 0) + 1, m), {});

const gaps = G.gaps || [];
const band1Failed = gaps.filter(g => g.final_status === 'FAILED' && (g.impacted?.patterns || []).some(p => bandOf(p) === 1));
const p1open = gaps.filter(g => g.priority === 'P1' && (g.final_status === 'OPEN' || g.final_status === 'FAILED'));
const exposureOnReport = gaps.filter(g => g.category === 'EXPOSURE' && g.on_standard_report && g.final_status !== 'NOT_APPLICABLE');

/* A whole dimension at zero is not a low score, it is an unmeasured dimension. Without this the
 * verdict reads only pass_health and gap_health, so a run testing no use case and no stored
 * procedure could still be called production-ready. */
/* "Never covered" must mean never LOOKED AT, not "nothing passed". A dimension whose every item
 * is correctly not_applicable has been settled — reporting it as a dark dimension forced
 * needs_attention on a run at 100 pass_health and 100 gap_health, which is a verdict nobody can
 * act on. Denominators therefore exclude the settled items rather than counting them as misses. */
const settledCount = rows => rows.filter(r => isSettled(r.state)).length;
const spReal  = spRows.filter(r => !r.system && !/OAuth|^SYS_/i.test(r.name));
const behReal = behRows.filter(r => r.applicable !== false);
const dark = [
  ['use cases', settledCount(ucRows), ucRows.length],
  ['stored procedures', settledCount(spReal), spReal.length],
  ['agent behaviors', settledCount(behReal), behReal.length],
  ['relationships', settledCount(relRows), relRows.length],
].filter(([, settled, tot]) => tot > 0 && settled === 0).map(([n, , tot]) => `${n} (0/${tot})`);

let verdict, reasons = [];
if (band1Failed.length) { verdict = 'not_ready'; reasons.push(`${band1Failed.length} Band-1 pattern(s) FAILED: ${band1Failed.map(g => g.id).join(', ')}`); }
else if (p1open.length || exposureOnReport.length || dark.length) {
  verdict = 'needs_attention';
  if (p1open.length) reasons.push(`${p1open.length} P1 gap(s) still OPEN/FAILED: ${p1open.map(g => g.id).join(', ')}`);
  if (exposureOnReport.length) reasons.push(`${exposureOnReport.length} vendor standard report(s) have no connector object: ${exposureOnReport.map(g => g.domain_name).join(', ')}`);
  if (dark.length) reasons.push(`whole dimension(s) never covered: ${dark.join(', ')}`);
} else if (pass_health >= 90 && gap_health >= 90) verdict = 'production_ready';
else { verdict = 'needs_improvement'; reasons.push(`pass_health ${pass_health} · gap_health ${gap_health}`); }

const verdictLabel = { production_ready: 'Production-Ready', needs_attention: 'Needs Attention', not_ready: 'Not Ready', needs_improvement: 'Needs Improvement' }[verdict];

/* ── funnel: tested count ────────────────────────────────────────────────── */
if (C.funnel) { C.funnel.objects_tested = objRows.filter(r => isCredited(r.state)).length; C.funnel.objects_failed = objRows.filter(r => r.state === 'failed').length; }
C.objectives_met = verdict === 'production_ready';

/* ── persist ─────────────────────────────────────────────────────────────── */
writeJson(a.coverage, C);
writeJson(a.gaps, G);

const gapDist = gaps.reduce((m, g) => (m[g.final_status] = (m[g.final_status] || 0) + 1, m), {});
const summary = {
  tcs: total, counts, pass_health, gap_health, verdict, verdictLabel, verdict_reasons: reasons,
  gaps: gapDist, open_by_priority: openByPriority, unproven_downgraded: unproven.map(t => t.id),
  credited_nothing: uncreditable.map(t => t.id), funnel: C.funnel || null,
  coverage: {
    objects_t1: ((C.objects || {}).tables || {}).by_tier?.T1 || null,
    columns: C.columns ? `${C.columns.covered}/${C.columns.total_important}` : null,
    relationships: C.relationships ? `${C.relationships.tested}/${C.relationships.total}` : null,
    use_cases: C.use_cases ? `${C.use_cases.covered}/${C.use_cases.total}` : null,
    procedures: `${spRows.filter(r => isCredited(r.state)).length}/${spRows.length}`,
    behaviors: `${behRows.filter(r => isCredited(r.state)).length}/${behRows.length}`,
    patterns_covered: patRows.filter(p => p.applicable && isCredited(p.state)).length, patterns_applicable: patRows.filter(p => p.applicable).length,
  },
  divergences: tcs.filter(t => (t.observed?.divergence || []).length).map(t => ({ id: t.id, divergence: t.observed.divergence })),
  needs_model: ['FAULT_TABLE narrative', 'DQ_OBSERVATIONS', 'INSTR_EVAL', 'semantic_conflicts adjudication', 'intent semantic_match for items the deterministic pre-check could not decide'],
};
writeJson(a.coverage.replace(/\.json$/, '.stage10-summary.json'), summary);

console.log(`\nRECONCILIATION — ${total} TC(s) credited from observed SQL`);
console.log(`  pass_health ${pass_health}%   gap_health ${gap_health}% (P1–P3 closed / live)`);
if (Object.keys(openByPriority).length) console.log(`  still open: ${Object.entries(openByPriority).sort().map(([p, n]) => `${p} ${n}`).join(' · ')}`);
console.log(`  verdict → ${verdict.toUpperCase()}${reasons.length ? '\n    because: ' + reasons.join('\n             ') : ''}`);
console.log(`  gaps: ${Object.entries(gapDist).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
if (summary.divergences.length) console.log(`  ⚠ ${summary.divergences.length} TC(s) diverged from plan — prompts to rewrite next round`);
console.log(`\n→ ${a.coverage}\n→ ${a.gaps}\n→ ${a.coverage.replace(/\.json$/, '.stage10-summary.json')}  (read THIS, not the full artifacts)`);
