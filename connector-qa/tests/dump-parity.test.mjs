/* Dump parity — the invariant that a customer query dump must not decide what gets tested.
 *
 * A dump is a lucky accident of which customers happened to share their traffic. If its presence
 * changes which objects, procedures or SQL patterns a run covers, then the least-observed
 * connectors get the least testing — exactly backwards, because those are the ones whose
 * behaviour nobody has checked. Evidence is allowed to ADD gaps (the CUSTOMER category) and to
 * RAISE priority. It is never allowed to remove a gap, change an applicability decision, or
 * change which surface items survive a cap.
 *
 * This builds one fixture twice — identical but for customer_evidence — and runs
 * compute-gaps → score-gaps → generate-tests on both.
 *
 * See 04-coverage-model.md §5.4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const S = f => join(SK, 'scripts', f);
const run = (script, args) => execFileSync(process.execPath, [S(script), ...args], { encoding: 'utf8', stdio: 'pipe' });

const objs = [
  { name: 'transaction', type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
    business_meaning: { v: 'Financial transaction', confidence: 'FACT', source: 'vendor_docs' },
    columns: [{ name: 'tranid', role: 'identifier', important: true }, { name: 'trandate', role: 'date', important: true },
              { name: 'entity', role: 'relationship_key', important: true }, { name: 'usertotal', role: 'measure', important: true },
              { name: 'approvalstatus', role: 'status', important: true }] },
  { name: 'vendor', type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
    business_meaning: { v: 'Supplier', confidence: 'FACT', source: 'vendor_docs' },
    columns: [{ name: 'id', role: 'identifier', important: true }, { name: 'companyname', role: 'dimension', important: true },
              { name: 'createddate', role: 'date', important: true }, { name: 'isinactive', role: 'status', important: true }] },
  { name: 'systemnote', type: 'TABLE', tier: 'T4', category: 'audit', columns_loaded: true,
    business_meaning: { v: 'Audit', confidence: 'INFERENCE', source: 'ai_inference' },
    columns: [{ name: 'id', role: 'identifier', important: true }, { name: 'date', role: 'date', important: true }] },
];
const PATS = ['select_projection', 'filter_equality', 'limit', 'order_by', 'join_inner', 'filter_date_range',
              'filter_null', 'group_by', 'aggregate_sum_avg_minmax', 'aggregate_count', 'date_function',
              /* the fixture advertises insert+update in permissions, so the coverage model must list
                 them as patterns too — otherwise the completeness gate correctly calls it thin */
              'insert', 'update'];

const EVIDENCE = { available: true, query_count: 100,
  object_frequency: { transaction: 60, vendor: 14 },
  error_clusters: [{ pattern: "Invalid column name 'X'", count: 152, likely_owner: 'owner-schema', reproduced: false }],
  join_pairs: [{ from: 'transaction', to: 'vendor', on: 'entity = id', count: 14, covered: false }] };

/* Build a complete connector directory. `evidence` is the ONLY difference between the two runs. */
function build(evidence) {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-parity-')), 'NetSuite');
  mkdirSync(dir, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
  const R = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));

  W('NetSuite_knowledge.json', {
    schema_version: '2.0.0', connector: 'NetSuite', semantic_complete: true, run_state: 'in_progress',
    run_meta: { run_id: 'run_parity', started_at: new Date().toISOString(), models: {}, metadata_snapshot_at: new Date().toISOString() },
    connector_meta: { app: 'NetSuite', workflow_domains: [
      { id: 'AP', name: 'Accounts Payable', table_refs: ['transaction', 'vendor'], standard_reports: ['A/P Aging'],
        workflows: [{ id: 'AP01', name: 'Approve bills', permission: 'write' }] }],
      personas: [{ id: 'P_AP', name: 'AP Clerk', jobs_to_be_done: ['Clear the approval queue before the payment run'] }], roles: [] },
    physical: { procedures: [{ name: 'ApproveBill', params_total: 2 }], permissions: { select: true, insert: true, update: true } },
    objects: objs,
    /* from_col/to_col are required: a relationship that does not declare its join keys gets no
       join test at all, because a guessed key produces SQL that is valid and wrong. */
    relationships: [{ id: 'REL-001', from: 'transaction', to: 'vendor', from_col: 'entity', to_col: 'id',
                      confidence: 'FACT', source: 'cdata_metadata', tested: false }],
    ...(evidence ? { customer_evidence: evidence } : {}),
  });

  /* Applicability is decided from structure, so it is identical in both runs by construction —
     that is the point being protected. */
  W('NetSuite_coverage.json', {
    schema_version: '2.0.0', connector: 'NetSuite', objectives: {},
    objects: {
      tables: { total: objs.length, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: o.tier, state: 'discovered', tc_ids: [] })) },
      views: { total: 0, rows: [] },
      procedures: { total: 1, rows: [{ name: 'ApproveBill', params_total: 2, state: 'discovered', tc_ids: [] }] } },
    columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
    relationships: { rows: [{ id: 'REL-001', from: 'transaction', to: 'vendor', state: 'uncovered', confidence: 'FACT', tc_ids: [] }] },
    use_cases: { rows: [{ id: 'UC-1', name: 'Bills awaiting approval', domain: 'Accounts Payable', persona: 'AP Clerk',
                          objects: ['transaction'], source: 'vendor_report', state: 'uncovered', tc_ids: [] }] },
    patterns: { rows: PATS.map(p => ({ pattern: p, applicable: true, applicability_reason: '', state: 'uncovered', tc_ids: [] })) },
    intents: { rows: [] },
    behaviors: { rows: [{ behavior: 'empty_result_interpretation', applicable: true, state: 'uncovered', tc_ids: [] }] } });

  const K = join(dir, 'NetSuite_knowledge.json'), C = join(dir, 'NetSuite_coverage.json'), Gp = join(dir, 'NetSuite_gaps.json');
  run('compute-gaps.mjs', ['--knowledge', K, '--coverage', C, '--out', Gp]);

  /* The judgement fields the model normally fills — assigned by a fixed rule here so the two runs
     differ in evidence alone and nothing else. */
  const G = R('NetSuite_gaps.json');
  for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 120); g.business_importance = g.tier === 'T1' ? 'HIGH' : 'MEDIUM'; }
  W('NetSuite_gaps.json', G);
  run('score-gaps.mjs', ['--gaps', Gp, '--knowledge', K]);
  return { dir, R };
}

/* Every surface item the plan touches. This — not the test count — is what coverage means. */
const surfaceOf = plan => {
  const s = new Set();
  for (const t of plan.tc_list || []) {
    for (const o of t.target_objects || []) s.add(`obj:${o}`);
    for (const p of t.query_patterns || []) s.add(`pat:${p}`);
    for (const r of t.relationships || []) s.add(`rel:${typeof r === 'string' ? r : r.id}`);
    if (t.sp_name) s.add(`sp:${t.sp_name}`);
    if (t.behavior) s.add(`beh:${t.behavior}`);
  }
  return s;
};
const sorted = s => [...s].sort();

const withDump = build(EVIDENCE);
const noDump = build(null);

test('parity: the same gaps are found with and without a dump (evidence only ADDS the CUSTOMER category)', () => {
  const a = withDump.R('NetSuite_gaps.json').gaps, b = noDump.R('NetSuite_gaps.json').gaps;
  const keys = gs => new Set(gs.filter(g => g.category !== 'CUSTOMER').map(g => g.key));
  assert.deepEqual(sorted(keys(a)), sorted(keys(b)),
    'a dump changed which gaps exist — evidence must never remove or invent a non-CUSTOMER gap');
  assert.ok(a.some(g => g.category === 'CUSTOMER'), 'the dump run should still raise CUSTOMER gaps');
  assert.ok(!b.some(g => g.category === 'CUSTOMER'), 'the no-dump run cannot have CUSTOMER gaps');
});

test('parity: evidence may raise a gap\'s priority, never lower it', () => {
  const a = withDump.R('NetSuite_gaps.json').gaps, b = noDump.R('NetSuite_gaps.json').gaps;
  const byKey = Object.fromEntries(b.map(g => [g.key, g]));
  const RANK = { P1: 3, P2: 2, P3: 1, P4: 0 };
  for (const g of a) {
    const other = byKey[g.key]; if (!other) continue;
    assert.ok(RANK[g.priority] >= RANK[other.priority],
      `${g.key} scored ${g.priority} with a dump but ${other.priority} without — evidence demoted a gap`);
  }
});

test('parity: the generated plan covers the identical connector surface', () => {
  for (const c of [withDump, noDump])
    run('generate-tests.mjs', ['--dir', c.dir, '--connector', 'NetSuite']);
  const sa = surfaceOf(withDump.R('NetSuite_plan.json')), sb = surfaceOf(noDump.R('NetSuite_plan.json'));
  assert.deepEqual(sorted(sa), sorted(sb),
    'the dump changed which objects, patterns, procedures or relationships get tested');
});

test('parity: a cap trims the tail but never a surface item — identically either way', () => {
  /* The real failure mode: priority decides what a cap keeps, and evidence moves priority. Before
     the floor was reserved, the same connector capped at the same number kept different tests
     depending on whether a dump existed. */
  const CAP = '12';
  for (const c of [withDump, noDump])
    run('generate-tests.mjs', ['--dir', c.dir, '--connector', 'NetSuite', '--max', CAP]);
  const pa = withDump.R('NetSuite_plan.json'), pb = noDump.R('NetSuite_plan.json');
  const sa = surfaceOf(pa), sb = surfaceOf(pb);
  assert.deepEqual(sorted(sa), sorted(sb), 'under a cap, the dump decided which surface items survived');

  /* and the floor genuinely holds: every object, the procedure and the relationship keep a test */
  for (const need of ['obj:transaction', 'obj:vendor', 'obj:systemnote', 'sp:ApproveBill', 'rel:REL-001'])
    assert.ok(sa.has(need), `coverage floor lost ${need} to the cap`);
});
