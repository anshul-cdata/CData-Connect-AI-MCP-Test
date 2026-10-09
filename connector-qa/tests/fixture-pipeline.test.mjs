/**
 * fixture-pipeline.test.mjs — the deterministic pipeline, end to end, on a synthetic connector.
 *
 *   node --test tests/          (or: npm test)
 *
 * Proves the review's Critical fixes hold without an MCP server:
 *   C1  a completed run routes the next invocation to Stage 1, not Stage 8
 *   C2  a vendor domain with no connector object becomes an EXPOSURE gap and shows in the funnel
 *   C3  one FAILED P1 gap caps the verdict at needs_attention despite an 80% pass rate
 *   C4  gaps, priorities, credit and the report are produced by scripts, reproducibly
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const S = f => join(SK, 'scripts', f);
const run = (script, args) => execFileSync(process.execPath, [S(script), ...args], { encoding: 'utf8', stdio: 'pipe' });
const runJson = (script, args) => JSON.parse(run(script, args).trim().split('\n').pop());
const dir = join(mkdtempSync(join(tmpdir(), 'cqa-')), 'NetSuite');
const R = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));

/* ── fixture (mirrors the review scenario) ─────────────────────────────────── */
const objs = [
  { name: 'transaction', type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true, business_meaning: { v: 'Financial transaction', confidence: 'FACT', source: 'vendor_docs' },
    columns: [{ name: 'tranid', role: 'identifier', important: true }, { name: 'trandate', role: 'date', important: true }, { name: 'entity', role: 'relationship_key', important: true }, { name: 'usertotal', role: 'measure', important: true }, { name: 'approvalstatus', role: 'status', important: true }] },
  { name: 'vendor', type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true, business_meaning: { v: 'Supplier', confidence: 'FACT', source: 'vendor_docs' }, columns: [{ name: 'id', role: 'identifier', important: true }, { name: 'companyname', role: 'dimension', important: true }] },
  { name: 'CUSTOMRECORD_x', type: 'TABLE', tier: 'T2', category: 'custom', columns_loaded: false, business_meaning: { v: null, confidence: 'UNKNOWN', source: 'ai_inference' }, columns: [] },
  { name: 'systemnote', type: 'TABLE', tier: 'T4', category: 'audit', columns_loaded: false, business_meaning: { v: 'Audit', confidence: 'INFERENCE', source: 'ai_inference' }, columns: [] },
];
mkdirSync(dir, { recursive: true });
W('NetSuite_knowledge.json', { schema_version: '2.0.0', connector: 'NetSuite', semantic_complete: true, run_state: 'in_progress',
  run_meta: { run_id: 'run_test', started_at: new Date().toISOString(), models: { under_test: 'test-model' }, metadata_snapshot_at: new Date().toISOString() },
  connector_meta: { app: 'NetSuite', workflow_domains: [
    { id: 'AP', name: 'Accounts Payable', table_refs: ['transaction', 'vendor'], standard_reports: ['A/P Aging'], workflows: [{ id: 'AP01', name: 'Approve bills', permission: 'write' }] },
    { id: 'FA', name: 'Fixed Assets', table_refs: [], standard_reports: ['Depreciation Schedule'], workflows: [{ id: 'FA01', name: 'Run depreciation', permission: 'write' }] } ],
    personas: [{ id: 'P_AP', name: 'AP Clerk', jobs_to_be_done: ['Clear the approval queue before the payment run'] }], roles: [] },
  physical: { procedures: [] }, objects: objs,
  relationships: [{ id: 'REL-001', from: 'transaction', to: 'vendor', confidence: 'INFERENCE', source: 'customer_evidence', tested: false }],
  customer_evidence: { available: true, query_count: 100, object_frequency: { transaction: 60, vendor: 14 }, error_clusters: [{ pattern: "Invalid column name 'X'", count: 152, likely_owner: 'owner-schema', reproduced: false }], join_pairs: [{ from: 'transaction', to: 'vendor', on: 'entity = id', count: 14, covered: false }] } });
const pats = [['select_projection', true], ['filter_equality', true], ['limit', true], ['order_by', true], ['join_inner', true], ['filter_date_range', true], ['filter_null', true], ['group_by', true], ['aggregate_sum_avg_minmax', true], ['having', false], ['date_function', false]]
  .map(([p, a]) => ({ pattern: p, applicable: a, applicability_reason: a ? '' : 'measured <1%', state: a ? 'uncovered' : 'not_applicable', tc_ids: [] }));
W('NetSuite_coverage.json', { schema_version: '2.0.0', connector: 'NetSuite', objectives: {},
  objects: { tables: { total: 4, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: o.tier, state: 'discovered', tc_ids: [] })) }, views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
  relationships: { rows: [{ id: 'REL-001', from: 'transaction', to: 'vendor', state: 'uncovered', confidence: 'INFERENCE', tc_ids: [] }] },
  use_cases: { rows: [{ id: 'UC-1', name: 'Bills awaiting approval', domain: 'Accounts Payable', persona: 'AP Clerk', objects: ['transaction'], source: 'vendor_report', state: 'uncovered', tc_ids: [] }] },
  patterns: { rows: pats }, intents: { rows: [] }, behaviors: { rows: [{ behavior: 'empty_result_interpretation', applicable: true, state: 'uncovered', tc_ids: [] }] } });

/* ── tests ─────────────────────────────────────────────────────────────────── */
test('router: knowledge + coverage on disk, no gaps → Stage 6', () => { assert.equal(runJson('detect-stage.mjs', ['--dir', dir]).stage, 6); });

test('C2: compute-gaps emits EXPOSURE for the domain with no objects, and a funnel', () => {
  run('compute-gaps.mjs', ['--knowledge', join(dir, 'NetSuite_knowledge.json'), '--coverage', join(dir, 'NetSuite_coverage.json'), '--out', join(dir, 'NetSuite_gaps.json'), '--round', '0']);
  const G = R('NetSuite_gaps.json'), C = R('NetSuite_coverage.json');
  const exposure = G.gaps.filter(g => g.category === 'EXPOSURE');
  assert.equal(exposure.length, 1); assert.equal(exposure[0].domain_name, 'Fixed Assets'); assert.equal(exposure[0].on_standard_report, true);
  assert.equal(C.funnel.domains_without_connector_object, 1);
  assert.equal(C.funnel.meaning_unknown, 1);
  assert.ok(G.gaps.some(g => g.category === 'CUSTOMER' && g.known_production_failure));
  assert.ok(G.gaps.every(g => g.description === null && g.business_importance === null), 'skeletons only — the model fills judgement fields');
});

test('C4: score-gaps refuses unscored gaps, then scores deterministically', () => {
  assert.throws(() => run('score-gaps.mjs', ['--gaps', join(dir, 'NetSuite_gaps.json'), '--knowledge', join(dir, 'NetSuite_knowledge.json')]));
  const G = R('NetSuite_gaps.json');
  for (const g of G.gaps) { g.description = g.evidence.slice(0, 120); g.business_importance = g.tier === 'T1' || g.category === 'EXPOSURE' ? 'HIGH' : 'MEDIUM'; }
  W('NetSuite_gaps.json', G);
  run('score-gaps.mjs', ['--gaps', join(dir, 'NetSuite_gaps.json'), '--knowledge', join(dir, 'NetSuite_knowledge.json')]);
  const G2 = R('NetSuite_gaps.json');
  assert.equal(G2.prioritized, true);
  assert.ok(G2.gaps.every(g => g.priority && typeof g.priority_score === 'number'));
  const ex = G2.gaps.find(g => g.category === 'EXPOSURE'); assert.equal(ex.priority, 'P1', 'an EXPOSURE of a standard report is P1');
  assert.equal(runJson('detect-stage.mjs', ['--dir', dir]).stage, 8);
});

test('C3: one FAILED P1 gap caps the verdict at needs_attention despite 80% pass rate', () => {
  const G = R('NetSuite_gaps.json');
  const byKey = k => G.gaps.find(g => g.key === k);
  const errGap = G.gaps.find(g => g.known_production_failure);
  const tcs = [
    { id: 'TC-001', gap_ids: [byKey('uc:UC-1').id, byKey('pattern:filter_equality').id, byKey('pattern:order_by').id, byKey('pattern:limit').id, byKey('pattern:select_projection').id], uc: 'approval queue', prompt: 'Which bills are waiting for approval so I can follow up?', status: 'pass', group: 'AP', process_group: 'AP', roles: ['AP Clerk'], target_objects: ['transaction'], query_patterns: ['filter_equality', 'order_by', 'limit'], steps: [{ t: 'p', q: 'x', r: '18 rows' }], owner: 'owner-ok', use_case_ids: ['UC-1'],
      observed: { sql: "SELECT [tranid],[trandate] FROM [transaction] WHERE [approvalstatus]='Pending' ORDER BY [trandate] LIMIT 20" } },
    { id: 'TC-002', gap_ids: [byKey('rel:REL-001').id, byKey('pattern:join_inner').id, byKey('pattern:group_by').id, byKey('pattern:aggregate_sum_avg_minmax').id], uc: 'vendor spend', prompt: 'Top vendors by spend so I can plan negotiations', status: 'pass', group: 'AP', process_group: 'AP', roles: ['AP Clerk'], target_objects: ['transaction', 'vendor'], query_patterns: ['join_inner'], steps: [{ t: 'p', q: 'x', r: '10 rows' }], owner: 'owner-ok',
      observed: { sql: "SELECT v.[companyname], SUM(t.[usertotal]) AS s FROM [transaction] t JOIN [vendor] v ON t.[entity]=v.[id] GROUP BY v.[companyname] ORDER BY s DESC LIMIT 10" } },
    { id: 'TC-003', gap_ids: [errGap.id], uc: 'custom approver', prompt: 'Flag bills with a custom approver so I can route them', status: 'fail', group: 'AP', process_group: 'AP', roles: [], target_objects: ['transaction'], query_patterns: ['filter_equality'], steps: [{ t: 'f', q: 'SELECT [custbody_x] FROM [transaction]', e: 'Invalid column name', a: 'Metadata advertises the column; driver rejects it.' }], owner: 'owner-schema', observed: null },
    { id: 'TC-004', gap_ids: [byKey('beh:empty_result_interpretation').id, byKey('pattern:filter_null').id], uc: 'no vendor', prompt: 'Before close, show transactions with no vendor assigned', status: 'pass', group: 'AP', process_group: 'AP', roles: [], target_objects: ['transaction'], query_patterns: ['filter_null'], group_type: 'behavior', behavior: 'empty_result_interpretation', steps: [{ t: 'p', q: 'x', r: '0 rows' }], owner: 'owner-ok',
      observed: { sql: 'SELECT [tranid] FROM [transaction] WHERE [entity] IS NULL LIMIT 20' } },
    { id: 'TC-005', gap_ids: [byKey('pattern:filter_date_range').id], uc: 'this month', prompt: 'Bills from this month for the close', status: 'pass_col', group: 'AP', process_group: 'AP', roles: [], target_objects: ['transaction'], query_patterns: ['filter_date_range', 'limit'], steps: [{ t: 'f', q: 'x', e: 'bad col', a: 'fixed' }, { t: 'p', q: 'y', r: '5 rows' }], owner: 'owner-ok',
      observed: { sql: "SELECT [tranid] FROM [transaction] WHERE [trandate] >= DATEADD('m',-1,GETDATE()) LIMIT 20" } },
  ];
  for (const g of G.gaps) g.planned_tests = tcs.filter(t => t.gap_ids.includes(g.id)).map(t => t.id);
  W('NetSuite_gaps.json', G);
  W('NetSuite_plan.json', { schema_version: '2.0.0', connector: 'NetSuite', round: 1, tc_list: tcs.map(t => ({ ...t, status: 'ne' })), tcs_completed: [] });
  const jl = join(dir, 'NetSuite_checkpoint.jsonl');
  writeFileSync(jl, JSON.stringify({ type: 'meta', connector: 'NetSuite', round: 1, rounds_done: 0, run_meta: R('NetSuite_knowledge.json').run_meta }) + '\n');
  for (const t of tcs) appendFileSync(jl, JSON.stringify({ type: 'tc', tc: t }) + '\n');
  appendFileSync(jl, JSON.stringify({ type: 'summary', key: 'caps', value: [[1, 'SELECT']] }) + '\n');

  run('credit-coverage.mjs', ['--checkpoint', jl, '--coverage', join(dir, 'NetSuite_coverage.json'), '--gaps', join(dir, 'NetSuite_gaps.json'), '--knowledge', join(dir, 'NetSuite_knowledge.json')]);
  const S = R('NetSuite_coverage.stage10-summary.json');
  assert.equal(S.pass_health, 80);
  assert.equal(S.verdict, 'needs_attention', 'pass_health 80 but a P1 FAILED and a standard-report EXPOSURE is open → capped');
  assert.ok(S.verdict_reasons.some(r => /P1/.test(r)) && S.verdict_reasons.some(r => /Fixed Assets/.test(r)));
  const G2 = R('NetSuite_gaps.json');
  assert.equal(G2.gaps.find(g => g.id === errGap.id).final_status, 'FAILED');
  assert.equal(G2.gaps.find(g => g.key === 'uc:UC-1').final_status, 'CLOSED');
  const C = R('NetSuite_coverage.json');
  assert.equal(C.funnel.objects_tested, 2, 'transaction + vendor credited from observed SQL; the failed TC credited nothing');
  assert.ok(S.divergences.some(d => d.id === 'TC-005'), 'planned filter_date_range, agent used DATEADD → divergence recorded');
  assert.ok(C.patterns.rows.find(p => p.pattern === 'filter_date_range').tc_ids.length === 0, 'date_range NOT credited — the agent never sent it');
  assert.ok(C.patterns.rows.find(p => p.pattern === 'join_inner').tc_ids.includes('TC-002'));
});

test('C4: merge + build both reports from artifacts, validated', () => {
  run('merge-checkpoint.mjs', ['--jsonl', join(dir, 'NetSuite_checkpoint.jsonl'), '--out', join(dir, 'NetSuite_checkpoint.json')]);
  run('build-report.mjs', ['--dir', dir, '--template', join(SK, 'assets', 'report-template.html')]);
  for (const f of ['NetSuite_dynamic_test_report.html', 'NetSuite_gap_analysis_report.html']) {
    assert.ok(existsSync(join(dir, f)), f);
    const html = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/=\s*\/\* FILL/.test(html), `${f} has no unfilled constant declarations`);
    assert.ok(/<title>NetSuite — /.test(html), `${f} title names the connector`);
    assert.ok(html.includes('"domains_without_connector_object":1'), `${f} carries the funnel`);
    assert.ok(html.includes('"verdict":"needs_attention"'), `${f} carries the rule verdict`);
  }
});

test('C1: finish-run marks complete; router sends the next run to Stage 1, --resume reopens', () => {
  // all TCs terminal, P1/P2 gaps still open, rounds remain → the router correctly asks for
  // another reconcile/iterate pass. Stopping is the model's decision, made explicit by finish-run.
  assert.equal(runJson('detect-stage.mjs', ['--dir', dir]).stage, 10);
  run('finish-run.mjs', ['--dir', dir]);
  assert.equal(R('NetSuite_knowledge.json').run_state, 'complete');
  assert.ok(existsSync(join(dir, 'runs')), 'archive folder exists');
  assert.ok(!existsSync(join(dir, 'NetSuite_checkpoint.jsonl')), 'checkpoint removed');
  assert.ok(existsSync(join(dir, 'NetSuite_plan.json')), 'plan RETAINED — test cases survive the report so a compaction or a later round cannot lose them');
  const next = runJson('detect-stage.mjs', ['--dir', dir]);
  assert.equal(next.stage, 1, 'the bug: this used to be 8'); assert.equal(next.run_state, 'complete');
  assert.equal(runJson('detect-stage.mjs', ['--dir', dir, '--fresh']).stage, 1);
  assert.notEqual(runJson('detect-stage.mjs', ['--dir', dir, '--resume']).stage, 1, '--resume reopens the finished artifacts');
});

test('agent output validation rejects malformed research', () => {
  const ok = execFileSync(process.execPath, [S('validate-agent-output.mjs'), '--agent', 'domain'], { input: JSON.stringify([{ id: 'AP', name: 'AP', prevalence: 'core', table_refs: [], workflows: [{ id: 'A1', name: 'x', permission: 'read' }] }]), encoding: 'utf8' });
  assert.equal(JSON.parse(ok).valid, true, 'empty table_refs is valid — it becomes an EXPOSURE gap');
  assert.throws(() => execFileSync(process.execPath, [S('validate-agent-output.mjs'), '--agent', 'domain'], { input: '[{"id":"bad id","workflows":[]}]', stdio: 'pipe' }));
});

/* 2.2.0 — research that is well-formed but impossible, or that the realism work cannot use. */
const validate = (agent, data, extra = []) => {
  try { return JSON.parse(execFileSync(process.execPath, [S('validate-agent-output.mjs'), '--agent', agent, ...extra],
    { input: JSON.stringify(data), encoding: 'utf8', stdio: 'pipe' })); }
  catch (e) { return JSON.parse(e.stdout); }
};

test('a domain without prevalence is rejected — tiering cannot tell core work from an add-on', () => {
  const r = validate('domain', [{ id: 'AP', name: 'AP', table_refs: [], workflows: [{ id: 'A1', name: 'x', permission: 'read' }] }]);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some(p => /prevalence/.test(p)));
});

test('a role matrix where no role can use a domain is rejected, as asn005\'s was', () => {
  const roles = [
    { name: 'Admin', source: 'doc', access: { TM: 'F', FC: 'N' } },
    { name: 'Member', source: 'doc', access: { TM: 'E', FC: 'N' } },
  ];
  const r = validate('role', { roles, role_complexity: 'low' }, ['--domains', 'TM,FC']);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some(p => /no role has any access to domain FC/.test(p)), r.problems.join('\n'));
});

test('a role missing a domain key is a hole, not "no access"', () => {
  const r = validate('role', { roles: [{ name: 'Admin', source: 'doc', access: { TM: 'F' } },
                                       { name: 'Member', source: 'doc', access: { TM: 'E', FC: 'E' } }], role_complexity: 'low' },
                     ['--domains', 'TM,FC']);
  assert.ok(r.problems.some(p => /Admin\) has no access level for domain FC/.test(p)), r.problems.join('\n'));
});

const persona = (over = {}) => ({ id: 'P1', name: 'Project Manager', archetype: 'coordinator', primary_domains: ['TM'],
  jobs_to_be_done: ['Post the weekly status before the Friday review'],
  daily_questions: ['Which projects are slipping this week?', 'Who has the most overdue tasks right now?'], ...over });

test('personas need archetypes, everyday questions, and a doer, coordinator and analyst', () => {
  const good = validate('persona', [persona(), persona({ id: 'P2', name: 'Team Member', archetype: 'doer' }),
                                    persona({ id: 'P3', name: 'Ops Analyst', archetype: 'analyst' })]);
  assert.equal(good.valid, true, good.problems.join('\n'));
  const noAnalyst = validate('persona', [persona(), persona({ id: 'P2', name: 'Team Member', archetype: 'doer' })]);
  assert.ok(noAnalyst.problems.some(p => /archetype analyst/.test(p)), 'the analyst is the persona most often missed');
  const noQs = validate('persona', [persona({ daily_questions: [] })]);
  assert.ok(noQs.problems.some(p => /daily_questions/.test(p)));
});

test('an everyday question that leaks the schema is not a real person\'s question', () => {
  const r = validate('persona', [persona({ daily_questions: ['List Tasks where DueOn < today and Completed = false', 'Show me the TaskDependencies records'] }),
                                 persona({ id: 'P2', name: 'Team Member', archetype: 'doer' }), persona({ id: 'P3', name: 'Analyst', archetype: 'analyst' })]);
  assert.equal(r.valid, false);
  assert.ok(r.problems.some(p => /CamelCase|SQL vocabulary/.test(p)), r.problems.join('\n'));
});

test('parse-sql uses the same regexes as the miner and detects composed patterns', () => {
  const o = JSON.parse(run('parse-sql.mjs', ["SELECT v.[n], COUNT(*) FROM [t] LEFT JOIN [v] ON [t].[a]=[v].[b] WHERE [d] BETWEEN '2026-01-01' AND '2026-03-31' AND ([s]='A' OR [s]='B') GROUP BY v.[n] ORDER BY 2 DESC LIMIT 5"]));
  for (const p of ['join_left', 'aggregate_count', 'group_by', 'filter_date_range', 'filter_logic_grouped', 'order_by', 'limit', 'select_projection']) assert.ok(o.patterns.includes(p), p);
  assert.ok(!o.patterns.includes('join_inner'), 'a LEFT JOIN is not also an inner join');
  assert.deepEqual(o.objects.sort(), ['t', 'v']);
});

test.after(() => { try { rmSync(dirname(dir), { recursive: true, force: true }); } catch {} });
