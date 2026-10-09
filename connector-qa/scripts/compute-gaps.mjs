#!/usr/bin/env node
/**
 * compute-gaps.mjs — Stage 6, the arithmetic half.
 *
 *   node compute-gaps.mjs --knowledge K.json --coverage C.json --out gaps.json [--round N]
 *
 * A gap is `required − covered` over every objective × item. That is a loop, not a judgement,
 * so a script does it: on a 500-object connector a model walking the same loop drops rows and
 * nothing notices. The script emits gap SKELETONS; the model then fills exactly two fields per
 * gap — `description` and `business_importance` (with the rubric in 05-gap-analysis.md) — and
 * score-gaps.mjs turns those into priorities.
 *
 * Also emits the DISCOVERY FUNNEL and the EXPOSURE category: vendor-side entities (domains,
 * standard reports, workflows) with no connector object behind them. This is the one
 * comparison the pipeline gathers both halves of and previously never performed — it is what
 * lets a report say "we found what matters" rather than only "we tested what we found".
 *
 * Existing gaps are never deleted (05-gap-analysis §6.3). New ones get detected_round = --round.
 */
import { readJson, writeJson, nowIso } from './lib/artifacts.mjs';
import { bandOf } from './lib/sql-patterns.mjs';
import { isCovered } from './lib/coverage-state.mjs';
import { parseArgs } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['knowledge', 'coverage', 'out', 'round'],
  required: ['knowledge', 'coverage', 'out'],
  usage: 'usage: compute-gaps.mjs --knowledge K.json --coverage C.json --out gaps.json [--round N]',
});
if (!a.knowledge || !a.coverage || !a.out) {
  console.error('usage: compute-gaps.mjs --knowledge K.json --coverage C.json --out gaps.json [--round N]');
  process.exit(2);
}
const round = Number(a.round || 0);
const K = readJson(a.knowledge);
const C = readJson(a.coverage);
const existing = readJson(a.out, { required: false }) || { gaps: [] };
/* Retained gaps keep the judgement a model put on them — description, business_importance, the
 * priority score — because recomputing those costs a model call. They do NOT keep planned_tests:
 * generation renumbers test ids from TC-001, so every link is stale the moment the plan is
 * rewritten, and a gap credited from a test that no longer exists is how asn004 reported a
 * read-only assessment of a read-write connector as 96% healthy. */
const prior = (existing.gaps || []).map(g => ({ ...g, planned_tests: [] }));
const stale = (existing.gaps || []).filter(g => (g.planned_tests || []).length).length;
if (stale) console.error(`  · cleared planned_tests on ${stale} retained gap(s) — the plan is about to be regenerated and those ids will not survive it`);

const objects = K.objects || [];
const byName = Object.fromEntries(objects.map(o => [o.name.toLowerCase(), o]));
const tierOf = n => (byName[String(n).toLowerCase()] || {}).tier || 'T3';
const evidence = K.customer_evidence || { available: false };
const hasEvidence = !!evidence.available;

const FAMILY = {
  filter: ['filter_equality', 'filter_in', 'filter_like', 'filter_enum', 'filter_boolean', 'filter_and', 'filter_or', 'filter_logic_grouped'],
  date: ['filter_date_range', 'filter_date_boundary'],
  aggregation: ['aggregate_count', 'aggregate_sum_avg_minmax', 'group_by'],
  join: ['join_inner', 'join_left', 'join_multi_table'],
  null: ['filter_null'],
  sort: ['order_by', 'limit'],
};
const REQUIRED_FAMILIES = { T1: ['filter', 'date', 'aggregation', 'join', 'null', 'sort'], T2: ['filter'], T3: ['filter'], T4: [] };

/* ── gap factory with de-dup against prior gaps ──────────────────────────── */
let seq = prior.reduce((m, g) => Math.max(m, Number((g.id || 'GAP-000').split('-')[1]) || 0), 0);
/* `key` is a gap's stable identity — sp:Name, pattern:x, rel:REL-001, wf:TM01. The old signature
 * folded in `impacted.objects`, which for a pattern gap is "the first three T1 objects" and
 * therefore moves whenever tiering moves: the same gap then failed the de-dup and was re-added
 * under a fresh id. Regenerating Asana produced 37 duplicated keys against an unchanged coverage
 * model. Only gaps with no key fall back to the shape. */
const shapeSig = g => `${g.category}|${(g.impacted.objects || []).join(',')}|${(g.impacted.columns || []).join(',')}|${(g.impacted.relationships || []).join(',')}|${(g.impacted.patterns || []).join(',')}`;
const sig = g => g.key ? `key:${g.key}` : shapeSig(g);
const have = new Set(prior.map(sig));
const fresh = [];
function gap(category, impacted, tier, evidenceText, strength, extra = {}) {
  const g = { category, impacted: { objects: [], columns: [], relationships: [], patterns: [], ...impacted }, tier, ...extra };
  const s = sig(g);
  if (have.has(s)) return;
  have.add(s);
  fresh.push({
    id: `GAP-${String(++seq).padStart(3, '0')}`,
    category, description: null, business_importance: null,
    impacted: g.impacted, tier,
    evidence: evidenceText, evidence_strength: strength,
    detected_round: round, priority: null, priority_score: null,
    planned_tests: [], final_status: 'OPEN',
    needs_model: ['description', 'business_importance'],
    ...extra,
  });
}
const strengthFromSource = src => src === 'customer_evidence' || src === 'cdata_metadata' ? 'STRONG' : src === 'vendor_docs' ? 'MEDIUM' : 'WEAK';

/* ── EXPOSURE: vendor-side entities with no connector object ─────────────── */
const domains = (K.connector_meta && K.connector_meta.workflow_domains) || [];
const objNames = new Set(objects.map(o => o.name.toLowerCase()));
let exposureCount = 0;
for (const d of domains) {
  const refs = (d.table_refs || []).filter(t => objNames.has(String(t).toLowerCase()));
  if (refs.length === 0) {
    exposureCount++;
    const reports = d.standard_reports || [];
    gap('EXPOSURE', { objects: [] }, 'T1',
      `vendor_docs: domain "${d.name}" has ${(d.workflows || []).length} workflow(s)${reports.length ? ` and standard report(s) ${reports.slice(0, 3).map(r => `"${r}"`).join(', ')}` : ''} but no connector object was found for it`,
      'MEDIUM',
      { key: `domain:${d.id}`, domain: d.id, domain_name: d.name, standard_reports: reports,
        known_production_failure: false, on_standard_report: reports.length > 0 });
  }
}

/* ── OBJECT — dimension A: every object gets at least one query ──────────── */
/* §5.2 requires a query against every object, T4 included: a table nobody asked about can still
 * be the one that throws. Nothing emitted this gap, and generate-tests only wrote a baseline test
 * for T1/T2, so every lower-tier object went untested. asn004 hid it by tiering almost everything
 * T1; with real tiering that was 15 of Asana's 33 objects silently uncovered. */
for (const row of (((C.objects || {}).tables || {}).rows || []).concat((((C.objects || {}).views || {}).rows || []))) {
  if (isCovered(row.state) || (row.tc_ids || []).length) continue;
  gap('OBJECT', { objects: [row.name] }, row.tier || 'T3',
    `objective: ${row.tier || 'T3'} object exposed by the connector and never queried`,
    'STRONG', { key: `obj_untested:${row.name}` });
}

/* ── SCHEMA ──────────────────────────────────────────────────────────────── */
for (const o of objects) {
  if ((o.tier === 'T1' || o.tier === 'T2') && o.columns_loaded === false)
    gap('SCHEMA', { objects: [o.name] }, o.tier, 'cdata_metadata: T1/T2 object with no columns loaded', 'STRONG', { key: 'no_columns' });
  const conf = o.business_meaning && o.business_meaning.confidence;
  if ((o.tier === 'T1' || o.tier === 'T2') && conf === 'UNKNOWN')
    gap('SCHEMA', { objects: [o.name] }, o.tier, 'business meaning could not be determined', 'WEAK', { key: 'unknown_meaning' });
}
for (const r of K.relationships || []) {
  if (r.confidence === 'UNKNOWN')
    gap('SCHEMA', { objects: [r.from, r.to], relationships: [r.id] }, Math.min(tierOf(r.from), tierOf(r.to)) === 'T1' ? 'T1' : tierOf(r.from),
      'relationship exists in the business but has no discoverable join key', 'MEDIUM', { key: 'unknown_join_key' });
}

/* ── BUSINESS ────────────────────────────────────────────────────────────── */
const useCases = (C.use_cases && C.use_cases.rows) || [];
const ucDomains = new Set(useCases.map(u => String(u.domain || '').toLowerCase()));
const ucPersonas = new Set(useCases.map(u => String(u.persona || '').toLowerCase()));
for (const d of domains) {
  const refs = (d.table_refs || []).filter(t => objNames.has(String(t).toLowerCase()));
  if (refs.length && !ucDomains.has(String(d.name).toLowerCase()) && !ucDomains.has(String(d.id).toLowerCase()))
    gap('BUSINESS', { objects: refs.slice(0, 5) }, tierOf(refs[0]), `vendor_docs: domain "${d.name}" has objects but no use case`, 'MEDIUM', { key: `domain_no_uc:${d.id}` });
}
for (const p of (K.connector_meta && K.connector_meta.personas) || []) {
  if (!ucPersonas.has(String(p.name).toLowerCase()))
    gap('BUSINESS', { objects: [] }, 'T2', `vendor_docs: persona "${p.name}" has no use case covering any job-to-be-done`, 'MEDIUM', { key: `persona_no_uc:${p.id || p.name}` });
}
for (const u of useCases) {
  if (!isCovered(u.state))
    gap('BUSINESS', { objects: u.objects || [] }, (u.objects || []).length ? tierOf(u.objects[0]) : 'T2',
      `${u.source || 'ai_inference'}: use case "${u.name}" untested`, strengthFromSource(u.source), { key: `uc:${u.id}`, use_case: u.id });
}

/* ── QUERY ───────────────────────────────────────────────────────────────── */
const patterns = (C.patterns && C.patterns.rows) || [];
const patState = Object.fromEntries(patterns.map(p => [p.pattern, p]));
const t1Objects = objects.filter(o => o.tier === 'T1').map(o => o.name);
for (const p of patterns) {
  if (!p.applicable || isCovered(p.state)) continue;
  const band = bandOf(p.pattern);
  const tier = band === 1 ? 'T1' : band === 2 ? 'T2' : 'T3';
  const freq = p.customer_frequency;
  gap('QUERY', { patterns: [p.pattern], objects: t1Objects.slice(0, 3) }, tier,
    freq != null ? `customer_evidence: ${(freq * 100).toFixed(0)}% of real queries use ${p.pattern}` : `pattern ${p.pattern} applicable (band ${band}) and untested`,
    freq != null && hasEvidence ? 'STRONG' : band === 1 ? 'MEDIUM' : 'WEAK',
    { key: `pattern:${p.pattern}`, band, known_production_failure: false });
}
// per-T1-object family objective (only families with at least one applicable pattern)
for (const oName of t1Objects) {
  for (const fam of REQUIRED_FAMILIES.T1) {
    const inFamily = FAMILY[fam].filter(pn => patState[pn] && patState[pn].applicable);
    if (!inFamily.length) continue;
    /* The objective is met when any pattern in the family is settled — tested, or correctly not
     * applicable. Requiring tc_ids meant a family containing only a not_applicable pattern stayed
     * permanently open with nothing able to close it. */
    const settled = inFamily.some(pn => isCovered(patState[pn].state) || (patState[pn].tc_ids || []).length);
    const applicable = inFamily;
    if (!settled) gap('QUERY', { objects: [oName], patterns: applicable }, 'T1', `objective: T1 object requires the ${fam} family`, 'MEDIUM', { key: `fam:${oName}:${fam}`, family: fam });
  }
}

/* ── INTENT ──────────────────────────────────────────────────────────────── */
const intents = (C.intents && C.intents.rows) || [];
const intentObjs = new Set(intents.flatMap(i => (i.objects || []).map(o => o.toLowerCase())));
for (const oName of t1Objects) if (!intentObjs.has(oName.toLowerCase()))
  gap('INTENT', { objects: [oName] }, 'T1', 'objective: T1 object has no NL intent defined', 'MEDIUM', { key: `intent_missing:${oName}` });
for (const i of intents) {
  if ((i.phrasings || []).length < 2) gap('INTENT', { objects: i.objects || [] }, 'T1', `intent "${i.canonical}" has only ${(i.phrasings || []).length} phrasing(s)`, 'MEDIUM', { key: `intent_phrasings:${i.id}` });
  else if (!isCovered(i.state)) gap('INTENT', { objects: i.objects || [] }, 'T1', `intent "${i.canonical}" untested`, 'MEDIUM', { key: `intent:${i.id}` });
}

/* ── WORKFLOW ────────────────────────────────────────────────────────────── */
/* Stage 2 researches these and nothing opened a gap for them, so a connector could have every
 * workflow untested and the ledger would show nothing missing. asn005: 64 researched, 0 tested,
 * audit clean. A workflow is a business job carried end to end — the only place a lifecycle
 * defect shows, because each step passes in isolation. */
for (const d of domains) for (const w of d.workflows || []) {
  const refs = (K.objects || []).filter(o => {
    const t = (w.name + ' ' + (w.edge_cases || []).join(' ')).toLowerCase();
    const n = o.name.toLowerCase();
    return t.includes(n) || t.includes(n.replace(/ies$/, 'y').replace(/s$/, ''));
  }).map(o => o.name);
  if (!refs.length) continue;   // no exposed object takes part — an EXPOSURE gap, not a workflow one
  gap('WORKFLOW', { objects: refs.slice(0, 4) }, tierOf(refs[0]),
    `vendor_docs: workflow "${w.name}" (${d.id}) has no end-to-end test`,
    w.permission === 'write' ? 'STRONG' : 'MEDIUM',
    { key: `wf:${w.id}`, workflow_id: w.id, permission: w.permission || null });
}

/* ── PROCEDURE ───────────────────────────────────────────────────────────── */
for (const sp of (C.objects && C.objects.procedures && C.objects.procedures.rows) || []) {
  if (!isCovered(sp.state) && sp.state !== 'not_testable')
    gap('PROCEDURE', { objects: [sp.name] }, 'T2', `cdata_metadata: procedure exposed with ${sp.params_total ?? '?'} parameter(s), untested`, 'STRONG', { key: `sp:${sp.name}`, cost_high: (sp.params_total || 0) === 0 });
}

/* ── RELATIONSHIP ────────────────────────────────────────────────────────── */
for (const r of (C.relationships && C.relationships.rows) || []) {
  if (!isCovered(r.state) && r.confidence !== 'UNKNOWN')
    gap('RELATIONSHIP', { objects: [r.from, r.to], relationships: [r.id], patterns: ['join_inner'] },
      tierOf(r.from) === 'T1' || tierOf(r.to) === 'T1' ? 'T1' : 'T2',
      `${r.confidence}: ${r.from} → ${r.to} never exercised by a join`, r.confidence === 'FACT' ? 'STRONG' : 'MEDIUM',
      { key: `rel:${r.id}`, blocks: true });
}

/* ── CUSTOMER (evidence only) ────────────────────────────────────────────── */
if (hasEvidence) {
  for (const c of evidence.error_clusters || []) if (!c.reproduced && c.count >= 2)
    gap('CUSTOMER', {}, 'T1', `customer_evidence: ${c.count} production failures — "${String(c.pattern).slice(0, 80)}"`, 'STRONG',
      { key: `err:${String(c.pattern).slice(0, 60)}`, known_production_failure: true, error_pattern: c.pattern, likely_owner: c.likely_owner });
  for (const j of evidence.join_pairs || []) if (!j.covered && j.count >= 3)
    gap('CUSTOMER', { objects: [j.from, j.to], patterns: ['join_inner'] }, 'T1', `customer_evidence: ${j.count} real queries join ${j.from} → ${j.to}`, 'STRONG', { key: `cjoin:${j.from}:${j.to}` });
  /* Ties broke on JSON key insertion order, so which objects reached the top decile — and hence
   * which CUSTOMER gaps exist and how every later gap is numbered — depended on how the dump miner
   * happened to serialise its output. Name breaks the tie, by codepoint so no locale can move it. */
  const freq = Object.entries(evidence.object_frequency || {})
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const top = freq.slice(0, Math.max(1, Math.ceil(freq.length * 0.1)));
  const objRows = Object.fromEntries((((C.objects || {}).tables || {}).rows || []).map(r => [r.name.toLowerCase(), r]));
  for (const [name, n] of top) {
    const row = objRows[name.toLowerCase()];
    if (!row || row.state === 'fully_covered' || row.state === 'tested') continue;
    gap('CUSTOMER', { objects: [name] }, 'T1', `customer_evidence: ${n} real queries hit ${name}; coverage state ${row ? row.state : 'not in model'}`, 'STRONG', { key: `cobj:${name}` });
  }
}

/* ── BEHAVIOR ────────────────────────────────────────────────────────────── */
for (const b of (C.behaviors && C.behaviors.rows) || []) {
  if (b.applicable && !isCovered(b.state))
    gap('BEHAVIOR', {}, 'T1', `agent behavior "${b.behavior}" untested`, b.behavior === 'empty_result_interpretation' ? 'STRONG' : 'MEDIUM', { key: `beh:${b.behavior}`, behavior: b.behavior });
}

/* ── FUNNEL — the denominators, stated ───────────────────────────────────── */
const tables = objects.filter(o => o.type !== 'VIEW');
const views  = objects.filter(o => o.type === 'VIEW');
const confOf = o => (o.business_meaning && o.business_meaning.confidence) || 'UNKNOWN';
const funnel = {
  vendor_domains: domains.length,
  vendor_workflows: domains.reduce((s, d) => s + (d.workflows || []).length, 0),
  vendor_standard_reports: domains.reduce((s, d) => s + (d.standard_reports || []).length, 0),
  domains_without_connector_object: exposureCount,
  connector_objects: objects.length, tables: tables.length, views: views.length,
  procedures: ((C.objects || {}).procedures || {}).total || 0,
  meaning_fact: objects.filter(o => confOf(o) === 'FACT').length,
  meaning_inference: objects.filter(o => confOf(o) === 'INFERENCE').length,
  meaning_unknown: objects.filter(o => confOf(o) === 'UNKNOWN').length,
  tier_counts: { T1: 0, T2: 0, T3: 0, T4: 0 },
  objects_t1_t2: 0,
  objects_tested: null,           // filled by credit-coverage.mjs
  computed_at: nowIso(),
};
for (const o of objects) { funnel.tier_counts[o.tier || 'T3'] = (funnel.tier_counts[o.tier || 'T3'] || 0) + 1; }
funnel.objects_t1_t2 = funnel.tier_counts.T1 + funnel.tier_counts.T2;
funnel.assessment_confidence = objects.length
  ? Math.round(100 * (funnel.meaning_fact + 0.5 * funnel.meaning_inference) / objects.length) : 0;

/* ── persist ─────────────────────────────────────────────────────────────── */
const all = [...prior, ...fresh];
writeJson(a.out, { ...existing, connector: K.connector, prioritized: false, gaps: all, rounds_done: existing.rounds_done || 0,
  iterations: existing.iterations || { rounds: [], rounds_used: 0, max_rounds: null, stop_reason: '' } });
writeJson(a.coverage, { ...C, funnel });

const byCat = fresh.reduce((m, g) => (m[g.category] = (m[g.category] || 0) + 1, m), {});
console.log(`\nGAP ANALYSIS — round ${round}: ${fresh.length} new gap(s), ${all.length} total`);
console.log('  ' + Object.entries(byCat).sort().map(([k, v]) => `${k} ${v}`).join(' · '));
console.log(`\nFUNNEL  vendor domains ${funnel.vendor_domains} (${exposureCount} with NO connector object) · connector objects ${funnel.connector_objects} · meaning FACT ${funnel.meaning_fact} / INFERENCE ${funnel.meaning_inference} / UNKNOWN ${funnel.meaning_unknown} · T1+T2 ${funnel.objects_t1_t2}`);
console.log(`ASSESSMENT CONFIDENCE ${funnel.assessment_confidence}%  (FACT counts 1, INFERENCE ½, UNKNOWN 0)`);
console.log(`\n→ ${fresh.length} gap(s) need description + business_importance from the model (needs_model). Then run score-gaps.mjs.\n→ ${a.out}`);
