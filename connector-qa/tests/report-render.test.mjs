/* Build a report from executed tests and prove it renders.
 *
 * The suite validated reports built from artifacts with ZERO test cases, so every render path that
 * only runs when there is data was untested. Adding the Workflows tab introduced a TDZ error —
 * `renderWorkflows` ran as an IIFE and called `stepHtml`, which depends on a `const` declared
 * further down — and the whole suite stayed green. `validate-report.mjs` caught it only because I
 * ran it by hand.
 *
 * So: a fixture with executed tests of every shape, through merge → build → validate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });
const validate = f => {
  const r = spawnSync(process.execPath, [join(SK, 'scripts', 'validate-report.mjs'), f], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: String(r.stdout || '') + String(r.stderr || '') };
};

const dir = join(mkdtempSync(join(tmpdir(), 'cqa-rr-')), 'Demo');
mkdirSync(dir, { recursive: true });
const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
const cols = [{ name: 'Id', role: 'identifier', important: true },
              { name: 'Name', role: 'dimension', important: true },
              { name: 'Status', role: 'status', important: true },
              { name: 'DueOn', role: 'date', important: true }];
const objs = ['Task', 'Project'].map(n => ({ name: n, type: 'TABLE', tier: 'T1', category: 'core',
  columns_loaded: true, business_meaning: { v: n, confidence: 'FACT', source: 'vendor_docs' }, columns: cols }));

W('Demo_knowledge.json', {
  schema_version: '2.0.0', connector: 'Demo', semantic_complete: true, run_state: 'in_progress',
  run_meta: { run_id: 'r_render', started_at: '2026-09-01T00:00:00Z',
              models: { orchestrator: 'opus', under_test: 'sonnet' }, metadata_snapshot_at: '2026-09-01T00:00:00Z' },
  connector_meta: { app: 'Demo',
    workflow_domains: [{ id: 'TM', name: 'Task Management', table_refs: ['Task'], standard_reports: [],
      workflows: [{ id: 'TM01', name: 'Complete a task', permission: 'write', edge_cases: [] }] }],
    personas: [{ id: 'P1', name: 'Contributor', jobs_to_be_done: ['close out tasks'] }],
    roles: [{ name: 'Member', group: 'Core', access: { TM: 'F' } }] },
  physical: { procedures: [{ name: 'DoThing', params_total: 1 }],
              permissions: { select: true, insert: true, update: true, delete: false, execute: true } },
  objects: objs, relationships: [],
});
W('Demo_coverage.json', {
  schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: 2, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) },
             views: { total: 0, rows: [] },
             procedures: { total: 1, rows: [{ name: 'DoThing', params_total: 1, state: 'discovered', tc_ids: [] }] } },
  columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
  relationships: { rows: [] },
  use_cases: { rows: [{ id: 'UC-1', name: 'close out tasks', domain: 'TM', persona: 'Contributor',
                        objects: ['Task'], source: 'vendor_report', state: 'uncovered', tc_ids: [] }] },
  patterns: { rows: ['select_projection', 'filter_equality', 'limit'].map(p => ({ pattern: p, applicable: true, state: 'uncovered', tc_ids: [] })) },
  intents: { rows: [] },
  behaviors: { rows: [{ behavior: 'empty_result_handling', applicable: true, state: 'uncovered', tc_ids: [] }] },
  funnel: { objects_exposed: 2, objects_tested: 0 },
});
W('Demo_gaps.json', { schema_version: '2.0.0', connector: 'Demo', prioritized: true, gaps: [] });

/* One executed test per shape the renderer must handle. The Workflows tab exists only when a
   workflow test is present, so its absence here would make the whole file vacuous. */
const TCS = [
  { id: 'TC-001', group: 'Task Management', group_type: 'process', uc: 'overdue tasks',
    prompt: 'Which tasks are overdue?', status: 'pass', target_objects: ['Task'],
    query_patterns: ['select_projection'], time: '~40s', observed: { sql: 'SELECT [Id] FROM [Task]' },
    steps: [{ t: 'p', q: 'SELECT [Id],[Status] FROM [Demo1].[Demo].[Task] WHERE [Status]=\'open\'', r: '12 rows' }] },
  { id: 'TC-002', group: 'Task Management', group_type: 'process', uc: 'corrected column',
    prompt: 'List tasks with their created date.', status: 'pass_col', owner: 'owner-schema',
    target_objects: ['Task'], query_patterns: ['select_projection'], time: '~1m',
    observed: { sql: 'SELECT [Id] FROM [Task]' },
    steps: [{ t: 'f', q: 'SELECT [CreatedDate] FROM [Demo1].[Demo].[Task]', e: "Invalid column name 'CreatedDate'", a: 'the column is CreatedAt; nothing documents it' },
            { t: 'd', q: '', a: 'getColumns(Task) → the column is CreatedAt' },
            { t: 'p', q: 'SELECT [Id],[CreatedAt] FROM [Demo1].[Demo].[Task]', r: '12 rows' }] },
  { id: 'TC-003', group: 'Stored Procedures', group_type: 'procedure', uc: 'Execute DoThing',
    prompt: 'Run the thing.', status: 'fail', owner: 'owner-driver', sp_name: 'DoThing',
    target_objects: ['DoThing'], query_patterns: ['stored_procedure'], time: '~30s',
    observed: { sql: 'EXEC DoThing' },
    steps: [{ t: 'f', q: 'EXEC DoThing @TaskId=\'1\'', e: 'Range [0, -1) out of bounds for length 169', a: 'the driver crashed rather than rejecting the call' }] },
  { id: 'TC-004', group: 'Task Management', group_type: 'boundary', uc: 'premium goals',
    prompt: 'Show me the goals.', status: 'boundary', owner: 'owner-driver', risk_flag: 'premium_required',
    risk_flag_all: ['premium_required'], target_objects: ['Task'], query_patterns: ['select_projection'], time: '~20s',
    observed: { sql: 'SELECT [Id] FROM [Task]' },
    steps: [{ t: 'b', q: 'SELECT [Id] FROM [Demo1].[Demo].[Task]', e: 'HTTP 40002 — requires premium permissions', a: 'the API refused on plan' }] },
  { id: 'TC-005', group: 'Workflows', group_type: 'workflow', uc: 'Complete a task',
    workflow_id: 'TM01', workflow_domain: 'Task Management', mutates: true, risk_flag: 'mutating',
    prompt: 'Carry this out end to end: complete a task. Confirm each step took effect.',
    status: 'pass', target_objects: ['Task'], query_patterns: ['workflow', 'write'], time: '~2m',
    persona: 'Contributor', roles: ['Member'], expected_sql: null,
    observed: { sql: 'UPDATE [Task] SET [Status]=\'done\'' },
    steps: [{ t: 'p', q: 'SELECT [Id] FROM [Demo1].[Demo].[Task] LIMIT 1', r: '1 row' },
            { t: 'p', q: 'UPDATE [Demo1].[Demo].[Task] SET [Status]=\'done\' WHERE [Id]=\'1\'', r: '1 row' },
            { t: 'p', q: 'SELECT [Status] FROM [Demo1].[Demo].[Task] WHERE [Id]=\'1\'', r: 'confirmed' }] },
  { id: 'TC-006', group: 'Workflows', group_type: 'workflow', uc: 'Archive a project',
    workflow_id: 'TM02', workflow_domain: 'Task Management', mutates: true,
    prompt: 'Carry this out end to end: archive a project.', status: 'not_exec', executable: false,
    nt_reason: 'DuplicateProject creates records this connector cannot delete.',
    target_objects: ['Project'], query_patterns: ['workflow', 'write'], time: '—', expected_sql: null, steps: [] },
];

W('Demo_plan.json', { schema_version: '2.0.0', connector: 'Demo', run_id: 'r_render',
  generated_at: new Date().toISOString(), reviewed_at: new Date().toISOString(),
  review_model: 'opus', tc_list: TCS });

writeFileSync(join(dir, 'Demo_checkpoint.jsonl'),
  [JSON.stringify({ type: 'meta', run_id: 'r_render' }),
   ...TCS.map(tc => JSON.stringify({ type: 'tc', tc }))].join('\n') + '\n');

run('merge-checkpoint.mjs', ['--jsonl', join(dir, 'Demo_checkpoint.jsonl'),
  '--out', join(dir, 'Demo_checkpoint.json'), '--plan', join(dir, 'Demo_plan.json')]);
run('build-report.mjs', ['--dir', dir, '--template', join(SK, 'assets', 'report-template.html')]);

const reports = readdirSync(dir).filter(f => /\.html$/.test(f));
const testReport = reports.find(f => /test_report/.test(f));
const html = testReport ? readFileSync(join(dir, testReport), 'utf8') : '';

test('both reports are built from executed tests', () => {
  assert.equal(reports.length, 2, `expected a test report and a gap report, got: ${reports.join(', ')}`);
  assert.ok(testReport, 'the test report must exist');
});

test('the test report validates — every render path runs, not just the empty ones', () => {
  /* The assertion that would have caught the Workflows TDZ error. A report built from zero tests
     never executes the code that renders tests. */
  const { code, out } = validate(join(dir, testReport));
  assert.equal(code, 0, `a report built from executed tests must validate:\n${out.slice(0, 900)}`);
});

test('the gap report validates', () => {
  const gap = reports.find(f => /gap/.test(f));
  const { code, out } = validate(join(dir, gap));
  assert.equal(code, 0, out.slice(0, 700));
});

test('the Workflows tab appears when the plan has workflow tests', () => {
  assert.match(html, /label:'Workflows'/, 'the tab must be declared');
  assert.match(html, /"group_type":"workflow"/, 'workflow tests must reach the report data');
});

test('nothing renders as undefined, NaN or [object Object]', () => {
  /* These are the shapes a template bug takes: a field that does not exist, an object where a
     string was expected. They render silently rather than throwing. */
  const { out } = validate(join(dir, testReport));
  assert.doesNotMatch(out, /placeholder garbage/i, out.slice(0, 600));
});

test('a risk flag and a held-back test both reach the report', () => {
  assert.match(html, /premium_required/, 'risk flags must survive the merge into the report');
  assert.match(html, /cannot delete/, 'a not-executed test must carry its reason');
});
