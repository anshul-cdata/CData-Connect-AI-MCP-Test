#!/usr/bin/env node
/**
 * merge-checkpoint.mjs — fold the append-only checkpoint.jsonl into the checkpoint.json shape
 * the report builder expects.
 *
 *   node merge-checkpoint.mjs --jsonl ckpt.jsonl --out ckpt.json [--plan plan.json]
 *
 * Why jsonl: Stage 9 checkpoints after EVERY test. Rewriting a whole JSON file with all prior
 * tests each time is O(n²) through the model — 200 tests × a growing multi-MB file. Appending
 * one line per test is O(1), and this script does the O(n) merge exactly once at Stage 12.
 *
 * Line types:
 *   {"type":"meta", ...}                       run metadata, first line
 *   {"type":"tc", "tc":{...}}                  one completed test case, in full
 *   {"type":"summary","key":"exec_summary","value":{...}}   Stage 10 constants, one per line
 *   {"type":"semantic_update","value":{...}} / {"type":"new_gap","value":{...}}
 *
 * A later "tc" line for the same id supersedes an earlier one (re-runs, decompositions).
 */
import { readJsonl, readJson, writeJson } from './lib/artifacts.mjs';
import { parseArgs } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['jsonl', 'out', 'plan'],
  usage: 'usage: merge-checkpoint.mjs --jsonl ckpt.jsonl --out ckpt.json [--plan plan.json]',
});
if (!a.jsonl || !a.out) { console.error('usage: merge-checkpoint.mjs --jsonl ckpt.jsonl --out ckpt.json [--plan plan.json]'); process.exit(2); }

const lines = readJsonl(a.jsonl);
const meta = lines.find(l => l.type === 'meta') || {};
const tcMap = new Map();
const summary = {};
const semantic_updates = [], new_gaps_observed = [];
for (const l of lines) {
  if (l.type === 'tc') {
    /* Support both nested {tc:{id,...}} and flat {id,...} formats */
    const tc = (l.tc && l.tc.id) ? l.tc : (l.id ? l : null);
    if (tc) tcMap.set(tc.id, tc);
  } else if (l.type === 'summary' && l.key) summary[l.key] = l.value;
  else if (l.type === 'semantic_update') semantic_updates.push(l.value);
  else if (l.type === 'new_gap') new_gaps_observed.push(l.value);
}
let tcs = [...tcMap.values()];

/* The checkpoint records what the agent DID; the plan records what it was ASKED. A tc line
 * written under context pressure carries only id/status/observed/steps, so the report lost the
 * prompt, the use case and the group — three of the six columns a reader actually reads, and
 * every lens that regroups by role or object. Backfill from the plan, never overwriting a field
 * execution actually observed. */
/* `risk_flag` and `nt_reason` are what the plan knew and execution cannot rediscover: that an
 * object needs a premium plan, that a column's documentation is wrong, that a procedure was never
 * dispatched and why. Without them a reader sees a bare BLOCKED with no hint the account tier
 * caused it, and a NOT EXEC with no reason at all. 119 of asn005's 237 TCs carry a risk flag. */
const PLAN_FIELDS = ['prompt', 'uc', 'group', 'group_type', 'process_group', 'priority', 'roles',
  'target_objects', 'target_columns', 'use_case_ids', 'expected_sql', 'business_domain',
  'query_patterns', 'relationships', 'access_level', 'sp_name', 'behavior', 'persona',
  /* `gap_ids` is what gap_closure is computed from. A tc line written under context pressure — the
   * exact case this backfill exists for — carries none, and without it here the closure report
   * silently empties: every gap reads unclosed on a run that closed them. */
  'gap_ids',
  /* Without these the report cannot say WHY a join test carries no reference query — it just shows
   * a blank where the SQL should be, which reads as a bug in the report rather than a gap in the
   * connector's metadata. */
  'join_key_undeclared', 'note',
  'risk_flag', 'risk_flag_all', 'nt_reason', 'executable', 'mutates', 'reversible', 'undo_procedure',
  'business_process',
  /* The report's Suite lens and the realism column read these. Without them every test reads as
   * "Unclassified" and the business/conformance split exists only in the plan. */
  'suite', 'expected_behavior', 'realism', 'prompt_status'];
let enriched = 0;
if (a.plan) {
  const plan = readJson(a.plan, { required: false }) || {};
  const byId = new Map((plan.tc_list || plan.test_cases || []).map(t => [t.id, t]));
  for (const tc of tcs) {
    const p = byId.get(tc.id);
    if (!p) continue;
    let touched = false;
    for (const f of PLAN_FIELDS) {
      const have = tc[f];
      const empty = have == null || have === '' || (Array.isArray(have) && !have.length);
      if (empty && p[f] != null && !(Array.isArray(p[f]) && !p[f].length)) { tc[f] = p[f]; touched = true; }
    }
    if (touched) enriched++;
  }
  const noPrompt = tcs.filter(t => !t.prompt).length;
  if (noPrompt) console.error(`⚠ ${noPrompt} TC(s) still have no prompt — not in the plan either`);
}

/* group by business_process when present (human-readable domain names), otherwise fall back to
 * the authored group field; business_process is populated by generate-tests.mjs on new runs and
 * back-filled by patch-business-process.mjs on existing plans. */
const hasBP = tcs.some(t => t.business_process);
const groups = [];
const gIdx = new Map();
for (const tc of tcs) {
  const key = hasBP
    ? (tc.business_process || tc.group || 'Ungrouped')
    : (tc.group_id || tc.group || 'Ungrouped');
  if (!gIdx.has(key)) {
    gIdx.set(key, groups.length);
    groups.push({ id: tc.group_id || `grp-${String(groups.length + 1).padStart(2, '0')}`, title: key, desc: tc.group_desc || '', tcs: [] });
  }
  groups[gIdx.get(key)].tcs.push(tc);
}
/* localeCompare consults the host's ICU data, so the same checkpoint could order differently on a
 * different machine. TC ids are ASCII; compare them by codepoint. */
for (const g of groups) g.tcs.sort((x, y) => { const p = String(x.id), q = String(y.id);
  return p < q ? -1 : p > q ? 1 : 0; });

/* `q` is printed in the report as the query a connector engineer copies out to reproduce a
 * defect. Shorthand there reads as real SQL and does not run, and it is invisible until someone
 * tries it — so say so at merge time rather than letting the report ship looking authoritative.
 * See 00-contracts.md §5. */
const abbrev = [];
for (const tc of tcs) for (const s of (tc.steps || [])) {
  if (s.q && (/\.\.\.|…/.test(s.q) || /^\s*(WHERE|AND|OR|ORDER BY|GROUP BY|LIMIT|JOIN)\b/i.test(s.q)))
    abbrev.push(`${tc.id}: ${String(s.q).slice(0, 70)}`);
}
if (abbrev.length) {
  console.error(`\n⚠ ${abbrev.length} step(s) record an abbreviated query instead of the verbatim SQL.`);
  console.error('  The report marks these, but they cannot be used to reproduce a defect. See 00-contracts.md §5.');
  for (const a of abbrev.slice(0, 8)) console.error('    ' + a);
  if (abbrev.length > 8) console.error(`    … and ${abbrev.length - 8} more`);
}

const gap_closure = {};
for (const tc of tcs) for (const g of tc.gap_ids || []) gap_closure[g] = gap_closure[g] || null;

const out = {
  connector: meta.connector || null, run_meta: meta.run_meta || null,
  round: meta.round || 1, rounds_done: meta.rounds_done || 0,
  tcs_completed: tcs.map(t => t.id),
  groups, gap_closure, new_gaps_observed, semantic_updates,
  exec_summary: summary.exec_summary || null, fault_table: summary.fault_table || null,
  dq_observations: summary.dq_observations || null, instr_eval: summary.instr_eval || null,
  caps: summary.caps || null, schema_coverage: summary.schema_coverage || null,
  personas: summary.personas || null, coverage_matrix: summary.coverage_matrix || null,
};
writeJson(a.out, out);
console.log(`merged ${lines.length} line(s) → ${tcs.length} TC(s) in ${groups.length} group(s), ${Object.keys(summary).length} summary constant(s)`
  + (a.plan ? ` · ${enriched} TC(s) enriched from the plan` : '') + ` → ${a.out}`);
