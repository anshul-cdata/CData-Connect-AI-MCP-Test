#!/usr/bin/env node
/**
 * build-report.mjs — Stage 12. Assemble both HTML reports from the artifacts, deterministically.
 *
 *   node build-report.mjs --dir <connector folder> --template assets/report-template.html
 *
 * Reads knowledge / coverage / gaps / checkpoint(.json, merged) / plan, builds every constant
 * the template declares, injects them, writes <C>_dynamic_test_report.html and
 * <C>_gap_analysis_report.html, then runs validate-report.mjs on both.
 *
 * Before this script the model read megabytes of JSON and re-emitted megabytes of JSON into
 * the template — slow, expensive, and exposed to transcription error that only surfaced when
 * someone opened the tab. Now the model never touches the template at all.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readJson, SKILL_VERSION, loadConfig, writePolicy } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { enhanceCheckpoint } from './enhance-steps.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'template', 'connector', 'out'],
  usage: 'usage: build-report.mjs --dir <connector folder> --template <report-template.html>',
});
if (!a.dir || !a.template) { console.error('usage: build-report.mjs --dir <connector folder> --template <report-template.html>'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const dir = a.dir;
const connector = resolveConnector(dir, a.connector);
const path = k => join(dir, cfg.artifacts[k].replace('{connector}', connector));

const K = readJson(path('knowledge'));
const C = readJson(path('coverage'));
const G = readJson(path('gaps'));
const CK = readJson(path('checkpoint'), { required: false }) || {};
if (CK.groups) {
  const n = enhanceCheckpoint(CK);
  if (n) console.log(`enhance-steps: enriched ${n} TCs`);
}
const P = readJson(path('plan'), { required: false }) || {};
const S10 = readJson(path('coverage').replace(/\.json$/, '.stage10-summary.json'), { required: false }) || {};
/* Stage 8.5's own findings. Written to the checkpoint as tc_review_summary and, before this,
 * rendered nowhere — so the completeness audit was unauditable. */
const TCR = (CK.summaries && CK.summaries.tc_review_summary)
  || readJson(path('tc_review'), { required: false })
  || null;

const meta = K.connector_meta || {};
const runMeta = CK.run_meta || K.run_meta || {};

/* The model writes these sections into the checkpoint. When it runs short of context it leaves
 * `{}` behind, and `x || []` does not catch `{}` because an empty object is truthy — so the tab
 * rendered blank and the page said "No failures recorded", which is a different claim entirely.
 * Coerce to an array and remember that nothing was generated, so the template can say so. */
const notGenerated = [];
const list = (v, name) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && !Object.keys(v).length) { notGenerated.push(name); return []; }
  if (v == null) { notGenerated.push(name); return []; }
  return [v];
};
/* "Top Issues — None recorded" on a run with a driver crash and 32 blocked tests is a false
 * all-clear: the panel reads as good news when nobody wrote the narrative. Derive it from what
 * the tests actually hit, grouped by error signature so one repeated limitation is one issue. */
/* Same classification the report uses on each step: the message says whose problem it is far
 * more reliably than the verdict code does, and an empty result set is nobody's defect. */
const ERR_KINDS = [
  [/out of bounds|nullpointer|stack ?overflow|internal ?error|unhandled|\bHTTP ?\[?5\d\d/i, 'driver defect'],
  [/HTTP ?\[?4\d{4}|premium|cannot access|not authoriz|no permission|forbidden|\b40[13]\b/i, 'api / permission'],
  [/not responding|timed ?out|timeout|connection (closed|reset|refused)/i, 'server timeout'],
  [/is not supported|not implemented|unsupported/i, 'unsupported'],
  [/is required|must be specified|specify one of|mandatory/i, 'filter required'],
  [/invalid column name|invalid table|is not recognized|syntax error|unknown column/i, 'agent error'],
  [/\b0 rows\b|no data|empty result|headers only/i, 'no rows returned'],
];
const classify = t => (ERR_KINDS.find(([re]) => re.test(String(t || ''))) || [, 'blocked'])[1];
const RANK = { 'driver defect': 0, 'server timeout': 1, 'unsupported': 1, 'filter required': 2, 'api / permission': 3, 'blocked': 4, 'agent error': 5, 'no rows returned': 6 };
function deriveTopIssues(groups) {
  const tcs = groups.flatMap(g => g.tcs || []);
  const sig = new Map();
  for (const tc of tcs) {
    if (!['fail', 'partial', 'boundary'].includes(tc.status)) continue;
    const bad = (tc.steps || []).filter(s => s.t === 'f' || s.t === 'b');
    const last = bad[bad.length - 1];
    const text = String((last && (last.e || last.r)) || tc.notes || 'no error text recorded');
    const kind = classify((last && last.e) || '') === 'blocked' ? classify(text) : classify(last && last.e);
    /* collapse ids, quoted literals and row counts so "0 rows for TaskId='1'" and "...='2'"
       are one issue rather than two */
    const key = text.replace(/'[^']*'/g, "'…'").replace(/\b\d{6,}\b/g, '…').replace(/\b\d+ rows?\b/gi, 'N rows').slice(0, 120);
    if (!sig.has(key)) sig.set(key, { text: text.slice(0, 200), n: 0, ids: [], kind });
    const r = sig.get(key); r.n++; r.ids.push(tc.id);
    if ((RANK[kind] ?? 9) < (RANK[r.kind] ?? 9)) r.kind = kind;
  }
  const notExec = tcs.filter(t => ['not_exec', 'ne'].includes(t.status));
  const out = [...sig.values()]
    .sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || b.n - a.n)
    .slice(0, 6)
    .map(r => ({ type: r.kind,
                 description: `${r.text} — ${r.n} test${r.n > 1 ? 's' : ''} (${r.ids.slice(0, 5).join(', ')}${r.ids.length > 5 ? ` +${r.ids.length - 5}` : ''})` }));
  if (notExec.length) out.push({ type: 'not executed',
    description: `${notExec.length} test${notExec.length > 1 ? 's' : ''} never produced a query: ${notExec.map(t => t.id).join(', ')}` });
  for (const r of (S10.verdict_reasons || [])) if (/never covered/.test(r)) out.push({ type: 'coverage', description: r });
  return out;
}

const constants = {
  CONNECTOR: connector,
  CONNECTOR_META: {
    app: connector, subtitle: meta.subtitle || '', role_complexity: meta.role_complexity || 'low',
    recommendation: meta.recommendation || '', total_roles: (meta.roles || []).length,
    total_workflows: (meta.workflow_domains || []).reduce((s, d) => s + (d.workflows || []).length, 0),
    total_domains: (meta.workflow_domains || []).length, sources: meta.sources || [],
  },
  GROUPS: (() => {
    const raw = CK.groups || [];
    /* Re-group by business_process when the plan provides it — the checkpoint was merged before
     * business_process existed, so its groups still reflect the technical `group` field. */
    const bpMap = new Map((P.tc_list || []).filter(t => t.business_process).map(t => [t.id, t.business_process]));
    if (!bpMap.size) return raw;
    const allTCs = raw.flatMap(g => g.tcs || []);
    if (!allTCs.some(t => bpMap.has(t.id))) return raw;
    /* Stamp business_process onto each TC, then re-group */
    for (const tc of allTCs) { if (bpMap.has(tc.id)) tc.business_process = bpMap.get(tc.id); }
    const groups = []; const gIdx = new Map();
    for (const tc of allTCs) {
      const key = tc.business_process || tc.group || 'Ungrouped';
      if (!gIdx.has(key)) { gIdx.set(key, groups.length); groups.push({ id: `grp-${String(groups.length + 1).padStart(2, '0')}`, title: key, desc: '', tcs: [] }); }
      groups[gIdx.get(key)].tcs.push(tc);
    }
    for (const g of groups) g.tcs.sort((x, y) => { const p = String(x.id), q = String(y.id); return p < q ? -1 : p > q ? 1 : 0; });
    return groups;
  })(),
  /* Field-by-field, not all-or-nothing. The checkpoint's exec_summary carries counts and
   * top_issues but no `health`, and an `||` fallback on the whole object meant the template read
   * EXEC_SUMMARY.health as undefined and printed "undefined" as the headline score. */
  EXEC_SUMMARY: {
    verdict: S10.verdict || 'needs_attention', verdictLabel: S10.verdictLabel || 'Needs Attention',
    verdictDetail: S10.verdict === 'production_ready' ? 'Pass health and P1–P3 gap closure both at or above 90%.'
                 : 'Derived by rule from gap closure and pass rate — reasons below.',   // reasons render in their own panel
    health: S10.pass_health ?? 0, gap_health: S10.gap_health ?? null, verdict_reasons: S10.verdict_reasons || [],
    top_issues: [], not_exec_reason: 'All TCs executed', production_cost_note: '',
    ...(CK.exec_summary || {}),
  },
  INSTR_EVAL: (CK.instr_eval && Object.keys(CK.instr_eval).length) ? CK.instr_eval
    : (notGenerated.push('INSTR_EVAL'), { scores: { completeness: 0, accuracy: 0, actionability: 0, overall: 0 }, prevented: 0, trialerror: 0, verdict: 'not_generated', findings: [], recommendations: [], raw: K.instructions_raw || '' }),
  caps: list(CK.caps, 'MCP capability matrix'),
  FAULT_TABLE: list(CK.fault_table, 'Fault attribution'),
  /* the miner writes data-quality observations into coverage.json, not the checkpoint */
  DQ_OBSERVATIONS: list(CK.dq_observations, 'Data quality observations').length ? list(CK.dq_observations, '') : (C.dq_observations || []),
  COVERAGE_MATRIX: (CK.coverage_matrix && Object.keys(CK.coverage_matrix).length) ? CK.coverage_matrix : null,
  SCHEMA_COVERAGE: (CK.schema_coverage && Object.keys(CK.schema_coverage).length) ? CK.schema_coverage : null,
  PERSONAS: list(CK.personas, '').length ? list(CK.personas, '') : (meta.personas || []),
  KNOWLEDGE: {
    source_overview: K.source_overview || '', capabilities: K.capabilities || [], limitations: K.limitations || [],
    objects: K.objects || [], relationships: K.relationships || [], procedures: (K.physical && K.physical.procedures) || [],
    data_range: K.data_range || {}, semantic_updates: K.semantic_updates || CK.semantic_updates || [],
    semantic_conflicts: K.semantic_conflicts || [],
  },
  COVERAGE: C,
  GAPS: G.gaps || [],
  CUSTOMER_EVIDENCE: K.customer_evidence || { available: false },
  /* `write_policy` travels with the report because the footer has to say whether this run created
   * records it cannot delete, and against which workspace — neither is reconstructable afterwards
   * from the catalog name alone. */
  TC_REVIEW_SUMMARY: TCR,
  RUN_META: { ...runMeta, skill_version: runMeta.skill_version || SKILL_VERSION, connector, generated_at: new Date().toISOString(),
              has_customer_evidence: !!(K.customer_evidence && K.customer_evidence.available),
              write_policy: writePolicy(cfg, a.dir) || null,
              wrote_irreversibly: false },   // set below, from what the run actually issued
  FUNNEL: C.funnel || null,
  NOT_GENERATED: [],     // filled below — sections the model never wrote
};
constants.NOT_GENERATED = [...new Set(notGenerated.filter(Boolean))];

/* CAPABILITY COVERAGE — what the connector says it can do, against what the run actually sent.
 * asn004 issued 118 SELECTs, 0 INSERTs and 0 UPDATEs against a connector advertising insert and
 * update, and reported 96% pass health without ever mentioning that three of four advertised
 * capabilities went untested. A percentage is only meaningful beside its denominator. */
{
  const perms = (K.physical && K.physical.permissions) || K.permissions || {};
  const tcs = constants.GROUPS.flatMap(g => g.tcs || []);
  const stmts = tcs.flatMap(t => (t.steps || []).map(s => String(s.q || '')));
  const count = re => stmts.filter(q => re.test(q)).length;
  const planned = re => tcs.filter(t => re.test(String(t.expected_sql || '')) || (t.query_patterns || []).includes('write')).length;
  constants.CAPABILITY_COVERAGE = [
    { cap: 'select',  advertised: perms.select !== false, issued: count(/^\s*select/i),               planned: tcs.length },
    { cap: 'insert',  advertised: !!perms.insert,         issued: count(/^\s*insert/i),               planned: planned(/^\s*insert/i) },
    { cap: 'update',  advertised: !!perms.update,         issued: count(/^\s*update/i),               planned: planned(/^\s*update/i) },
    { cap: 'delete',  advertised: !!perms.delete,         issued: count(/^\s*delete/i),               planned: planned(/^\s*delete/i) },
    { cap: 'execute', advertised: !!perms.execute,        issued: count(/^\s*(exec|executeProcedure)/i), planned: tcs.filter(t => t.sp_name).length },
  ].filter(r => r.advertised);

  /* What the run DID, not what the config permitted. Reading the policy flag meant a read-only run
   * rendered the red "this run created records it cannot delete" — an alarming claim about someone
   * else's data, made on the basis of a setting nothing had acted on. An irreversible write is one
   * that actually issued an INSERT or DELETE and had no undo to put it back. */
  constants.RUN_META.wrote_irreversibly = tcs.some(t =>
    t.reversible === false && t.executable !== false
    && /^\s*(insert|delete)\b/i.test(String((t.observed || {}).sql || '')));
  /* a capability the connector advertises and the run never exercised is a hole, not a footnote */
  const untested = constants.CAPABILITY_COVERAGE.filter(r => !r.issued).map(r => r.cap);
  if (untested.length) constants.EXEC_SUMMARY.top_issues = [
    { type: 'untested capability',
      description: `the connector advertises ${untested.join(', ')} but this run never issued one — those capabilities are unverified` },
    ...(constants.EXEC_SUMMARY.top_issues || []),
  ];
  const ne = tcs.filter(t => t.executable === false);
  if (ne.length) constants.EXEC_SUMMARY.top_issues = [
    ...(constants.EXEC_SUMMARY.top_issues || []),
    { type: 'not executed by policy',
      description: `${ne.length} planned test(s) were deliberately not run: ${ne.map(t => t.sp_name || t.id).slice(0, 6).join(', ')}${ne.length > 6 ? ` +${ne.length - 6}` : ''}` },
  ];
}
/* Derived issues used to run only when top_issues was empty — but the capability block above has
 * usually just pushed a synthetic entry, so the list was never empty and the real failures were
 * never derived. A driver NullPointerException sat in the checkpoint while the panel showed only
 * "untested capability": the precise false all-clear this derivation exists to prevent. Always
 * derive, then merge, de-duplicating on type+description so nothing is listed twice. */
{
  const derived = deriveTopIssues(constants.GROUPS) || [];
  const have = constants.EXEC_SUMMARY.top_issues || [];
  const key = i => `${i.type}||${i.description}`;
  const seen = new Set(have.map(key));
  constants.EXEC_SUMMARY.top_issues = [...have, ...derived.filter(i => !seen.has(key(i)))];
}
{ const n = constants.GROUPS.flatMap(g => g.tcs || []).filter(t => !t.prompt).length;
  if (n) constants.EXEC_SUMMARY.prompts_missing = n; }
// always inject EXEC_SUMMARY.gap_health / verdict_reasons from Stage 10 when the model's summary lacks them
if (constants.EXEC_SUMMARY.gap_health == null && S10.gap_health != null) constants.EXEC_SUMMARY.gap_health = S10.gap_health;
if (!(constants.EXEC_SUMMARY.verdict_reasons || []).length && (S10.verdict_reasons || []).length) constants.EXEC_SUMMARY.verdict_reasons = S10.verdict_reasons;
if (S10.verdict && constants.EXEC_SUMMARY.verdict !== S10.verdict) {
  // the rule wins over the model's opinion — record both
  constants.EXEC_SUMMARY.model_verdict = constants.EXEC_SUMMARY.verdict;
  constants.EXEC_SUMMARY.verdict = S10.verdict; constants.EXEC_SUMMARY.verdictLabel = S10.verdictLabel;
}

/* ── inject into template ────────────────────────────────────────────────── */
const tpl = readFileSync(a.template, 'utf8');
const startMark = 'DATA CONSTANTS', endMark = 'UTILITY & CONSTANTS';
const s = tpl.indexOf(startMark), e = tpl.indexOf(endMark);
if (s < 0 || e < 0) { console.error('template is missing the DATA CONSTANTS / UTILITY & CONSTANTS banners'); process.exit(1); }
// keep the banner comment lines themselves; replace only the const declarations between them
const bannerEnd = tpl.indexOf('*/', s) + 2;
const nextBannerStart = tpl.lastIndexOf('/*', e);
const head = tpl.slice(0, bannerEnd), tail = tpl.slice(nextBannerStart);
const js = kind => Object.entries({ REPORT_KIND: kind, ...constants })
  .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n');

const outputs = [[path('report'), 'test'], [path('gap_report'), 'gap']];
for (const [out, kind] of outputs) {
  // the <title> carries its own placeholder outside the script block
  const titled = (head + '\n\n' + js(kind) + '\n\n' + tail)
    .replace('<title>/* FILL: CONNECTOR */ MCP Test Report</title>',
             `<title>${connector} — ${kind === 'gap' ? 'Gap Analysis' : 'MCP Test Report'}</title>`);
  writeFileSync(out, titled, 'utf8');
}

/* ── validate both ───────────────────────────────────────────────────────── */
let failed = 0;
for (const [out] of outputs) {
  try { execFileSync(process.execPath, [join(here, 'validate-report.mjs'), out], { stdio: 'pipe' }); console.log(`✓ ${out}`); }
  catch (err) { failed++; console.error(`✗ ${out}\n${(err.stdout || '').toString()}${(err.stderr || '').toString()}`); }
}
console.log(`\nbuilt ${outputs.length} report(s) from artifacts — model never touched the template · ${constants.GROUPS.reduce((s, g) => s + (g.tcs || []).length, 0)} TCs · ${constants.GAPS.length} gaps · verdict ${constants.EXEC_SUMMARY.verdict}`);
process.exit(failed ? 1 : 0);

