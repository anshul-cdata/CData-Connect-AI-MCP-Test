/* 3.1 · research, run and report a connector area by area, without losing work.
 *
 * A four-area connector is taken through the incremental life it would have in practice: two areas
 * researched first, blocked by the completeness check until the gaps are filled, checked, judged,
 * human-sampled and frozen; run; then a third area researched later — without reopening the first
 * two — and run with the earlier results reused; then a cross-area pass, a redo, a build change
 * that makes results stale, and an area reset. The combined report must say what it covers at
 * every step. Agent work is simulated; everything else is the real scripts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });
const exitOf = (s, args) => { try { run(s, args); return 0; } catch (e) { return e.status; } };
const errOf = (s, args) => { try { run(s, args); return ''; } catch (e) { return String(e.stderr) + String(e.stdout); } };

const ROOT = mkdtempSync(join(tmpdir(), 'cqa-v31-'));
const dir = join(ROOT, 'Big');
mkdirSync(join(dir, '_agent_out'), { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const R = f => JSON.parse(readFileSync(P(f), 'utf8'));
const D = ['--dir', dir];
const status = (...x) => JSON.parse(run('scope.mjs', ['status', ...D, '--root', ROOT, '--json', ...x]));
const area = (st, id) => st.areas.find(a => a.id === id);

/* ── fixture: four areas ───────────────────────────────────────────────── */
const col = (name, role) => ({ name, role, important: true });
const objs = [
  { name: 'Tasks', remarks: 'Tasks in the workspace. To Create, Update and Query', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('DueOn', 'date'), col('Completed', 'status')] },
  { name: 'Projects', remarks: 'Projects. To Query', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('Archived', 'status')] },
  { name: 'Goals', remarks: 'Goals. To Query', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('Status', 'status')] },
  { name: 'Portfolios', remarks: 'Portfolios. To Query', columns: [col('Id', 'identifier'), col('Name', 'descriptive')] },
].map(o => ({ type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true, business_meaning: { v: o.name, confidence: 'FACT', source: 'vendor_docs' }, ...o }));
const KN = { schema_version: '2.0.0', connector: 'Big', semantic_complete: true, instructions_raw: 'Catalog is Big1. Schema is Big.',
  run_meta: { run_id: 'r1', mode: 'capability', started_at: '2026-10-01T00:00:00Z', models: { under_test: 'sonnet' }, connector_build: '24.0.1', workspace: '9001' },
  connector_meta: { app: 'Big', workflow_domains: [], personas: [{ id: 'IC', name: 'Individual Contributor' }, { id: 'TL', name: 'Team Lead' }], roles: [] },
  physical: { procedures: [], permissions: { select: true, insert: true, update: true, delete: false } }, objects: objs, relationships: [] };
W('Big_knowledge.json', KN);
W('Big_coverage.json', { schema_version: '2.0.0', connector: 'Big', objectives: {},
  objects: { tables: { total: 4, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) }, views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: [] }, relationships: { rows: [] }, use_cases: { rows: [] }, patterns: { rows: [] }, intents: { rows: [] }, behaviors: { rows: [] } });
run('compute-gaps.mjs', ['--knowledge', P('Big_knowledge.json'), '--coverage', P('Big_coverage.json'), '--out', P('Big_gaps.json')]);
{ const G = R('Big_gaps.json'); for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 100); g.business_importance = 'HIGH'; } W('Big_gaps.json', G); }
run('score-gaps.mjs', ['--gaps', P('Big_gaps.json'), '--knowledge', P('Big_knowledge.json')]);
W('spec.json', { openapi: '3.0.0', info: { title: 'Big API', version: '1.0' }, paths: {
  '/tasks': { get: { operationId: 'getTasks', summary: 'Get tasks', tags: ['Tasks'] }, post: { operationId: 'createTask', summary: 'Create a task', tags: ['Tasks'], requestBody: {} } },
  '/tasks/{gid}': { get: { operationId: 'getTask', summary: 'Get a task', tags: ['Tasks'] } },
  '/projects': { get: { operationId: 'getProjects', summary: 'Get projects', tags: ['Projects'] } },
  '/projects/{gid}': { get: { operationId: 'getProject', summary: 'Get a project', tags: ['Projects'] } },
  '/goals': { get: { operationId: 'getGoals', summary: 'Get goals', tags: ['Goals'] } },
  '/goals/{gid}': { put: { operationId: 'updateGoal', summary: 'Update a goal', tags: ['Goals'] } },
  '/portfolios': { get: { operationId: 'getPortfolios', summary: 'Get portfolios', tags: ['Portfolios'] } },
} });

const URL = 'https://help.example.com/guide';
const uc = o => ({ goal: 'get the week planned', frequency: 'weekly', difficulty: 'simple', tests: o.kind === 'action' ? ['write'] : ['filters'],
  source: { kind: 'help_center', title: 'Guide', url: URL }, ...o });
/* The set checks, simulated: a tiny fixture cannot reach the mix floors, so the writer explains
 * every one; then a fresh reviewer reads the whole area and finds it complete. */
const MIX_KEYS = ['simple', 'medium', 'complex', 'dates', 'aggregation', 'relationships', 'write', 'ambiguity', 'missing_info', 'limitation'];
function review(areas) {
  run('manage-catalog.mjs', ['review-prep', ...D, '--areas', areas]);
  W('review.json', { model: 'opus', areas: areas.split(',').map(area => ({ area, verdict: 'complete', findings: [] })) });
  run('manage-catalog.mjs', ['review-merge', ...D, '--review', P('review.json')]);
}
function settle(areas) {
  const cat = R('Big_catalog.json'); const caps = R('Big_capabilities.json');
  for (const area of areas.split(',')) {
    const personas = caps.areas.find(x => x.id === area).personas.map(p => `persona:${p}`);
    for (const need of [...MIX_KEYS, ...personas]) if (!(cat.mix_explained || []).some(x => x.area === area && x.need === need))
      (cat.mix_explained = cat.mix_explained || []).push({ area, need, reason: 'a tiny test fixture with one flow' });
  }
  W('Big_catalog.json', cat);
  review(areas);
}
const ids = (sql) => ({ rule: 'same_ids', key: 'Id', reference_sql: sql });
/* the steps every area goes through after research: check sources, judge, sample, freeze */
function approve(areas, rating = '4') {
  run('manage-catalog.mjs', ['sources-prep', ...D, '--areas', areas]);
  const items = R('Big_sources_to_check.json').items;
  W('checks.json', { model: 'sonnet', checks: items.map(i => ({ url: i.url, status: 'found' })) });
  if (items.length) run('manage-catalog.mjs', ['sources-merge', ...D, '--checks', P('checks.json')]);
  run('manage-catalog.mjs', ['judge-prep', ...D, '--areas', areas]);
  const toJudge = R('Big_catalog_judge_input.json').use_cases;
  W('scores.json', { model: 'opus', scores: toJudge.flatMap(u => [{ id: u.id, score: 5 }, ...u.variants.map((_, i) => ({ id: `${u.id}#v${i + 1}`, score: 5 }))]) });
  run('manage-catalog.mjs', ['judge-merge', ...D, '--scores', P('scores.json')]);
  run('manage-catalog.mjs', ['sample', ...D, '--areas', areas]);
  const csv = readFileSync(P('Big_catalog_review.csv'), 'utf8').trim().split('\n');
  W('ratings.csv', [csv[0], ...csv.slice(1).map(l => l.replace(/,(\d?),,$/, `,$1,${rating},"real"`))].join('\n'));
  run('manage-catalog.mjs', ['human-merge', ...D, '--ratings', P('ratings.csv'), '--reviewer', 'qa']);
  settle(areas);
  return toJudge.length;
}
/* Stage 9, simulated: every planned business test answers correctly */
function simulate(runId) {
  const plan = R('Big_plan.json');
  mkdirSync(join(dir, '_agent_out', runId), { recursive: true });
  const A = (f, o) => writeFileSync(join(dir, '_agent_out', runId, f), JSON.stringify(o));
  for (const t of plan.tc_list.filter(x => x.suite === 'business' && x.executable !== false)) {
    for (let n = 1; n <= (t.attempts || 1); n++) {
      /* 3.6 limitation probe: the agent says it cannot be done, the judge agrees */
      if (t.probe === 'limitation') {
        A(`stage9-${t.id}-a${n}.json`, { calls: [{ tool: 'getTables', input: {}, result: 'Tasks', rows: 1 }], final_rows: [], answer: 'That cannot be done through this connection.', wall_ms: 1000, tokens: 1500 });
        A(`judge-${t.id}-a${n}.json`, { outcome: 'correct', reason: 'Said so plainly.' });
      } else if (t.check?.rule === 'write_visible') {
        A(`stage9-${t.id}-a${n}.json`, { calls: [{ tool: 'queryData', input: { query: 'INSERT INTO [Big1].[Big].[Tasks] ([Name]) VALUES (\'x\')' }, result: '1 row', rows: 1 }], final_rows: [], answer: 'Done.', wall_ms: 2000, tokens: 3000 });
        A(`check-${t.id}-a${n}.json`, { before_rows: [], rows: [t.check.expect] });
      } else {
        A(`stage9-${t.id}-a${n}.json`, { calls: [{ tool: 'queryData', input: { query: 'SELECT [Id] FROM [Big1].[Big].[X]' }, result: '1 row', rows: 1, ms: 900 }], final_rows: [{ Id: '1' }], answer: 'One.', wall_ms: 1500, tokens: 2500 });
        A(`check-${t.id}-a${n}.json`, { rows: [{ Id: '1' }] });
      }
    }
  }
  run('ingest-results.mjs', [...D, '--root', ROOT, '--run', runId, '--model', 'sonnet']);
}
function plan(areas) {
  try { run('generate-tests.mjs', [...D, '--connector', 'Big', '--areas', areas]); } catch (e) { if (!existsSync(P('Big_plan.json'))) throw e; }
  return R('Big_plan.json');
}

test('the whole connector is mapped first, and every area is shown before anything is researched', () => {
  run('capability-list.mjs', ['read', ...D, '--spec', P('spec.json')]);
  assert.equal(exitOf('capability-list.mjs', ['map', ...D]), 3, 'no business areas yet');
  W('review.json', { model: 'opus', mappings: [], areas: [
    { id: 'TM', name: 'Task management', personas: ['Individual Contributor'], related: ['PP'], capability_ids: ['CAP-gettasks', 'CAP-createtask', 'CAP-gettask'] },
    { id: 'PP', name: 'Projects', personas: ['Team Lead'], related: ['TM'], capability_ids: ['CAP-getprojects', 'CAP-getproject'] },
    { id: 'GL', name: 'Goals', personas: ['Team Lead'], capability_ids: ['CAP-getgoals', 'CAP-updategoal'] },
    { id: 'PF', name: 'Portfolios', personas: ['Team Lead'], capability_ids: ['CAP-getportfolios'] }] });
  assert.equal(exitOf('capability-list.mjs', ['apply', ...D, '--review', P('review.json')]), 0);
  const st = status();
  assert.equal(st.areas.length, 4);
  assert.ok(st.areas.every(a => a.research === 'not_started' && a.next === 'research'));
  assert.deepEqual(area(st, 'PP').personas, ['Team Lead']);
  assert.equal(exitOf('scope.mjs', ['status', ...D, '--root', ROOT, '--areas', 'nonsense']), 2, 'an unknown area is refused, never guessed');
  assert.match(run('scope.mjs', ['status', ...D, '--root', ROOT]), /Task management/);
});

test('two areas are researched; duplicates are dropped and the completeness check blocks the freeze until the gaps are filled', () => {
  const out = run('scope.mjs', ['research-plan', ...D, '--areas', 'task management,PP']);
  assert.match(out, /RB-001 \(new\)\s+TM\+PP/);
  assert.match(run('scope.mjs', ['research-plan', ...D, '--areas', 'TM,PP']), /RB-001 \(continuing\)/, 'a pending batch is continued, never duplicated');
  assert.equal(R('Big_research_plan.json').batches.length, 1);
  assert.equal(area(status(), 'TM').research, 'researching');
  W('rb1.json', { model: 'opus', use_cases: [
    uc({ area: 'TM', persona: 'Individual Contributor', kind: 'question', request: 'Which of my tasks are overdue?', capabilities: ['CAP-gettasks'], check: ids("SELECT [Id] FROM [Tasks] WHERE [DueOn] < '{{today}}'") }),
    uc({ area: 'TM', persona: 'Individual Contributor', kind: 'question', request: 'Which of my tasks are overdue right now?', capabilities: ['CAP-gettasks'], check: ids('SELECT 1') }),
    uc({ area: 'TM', persona: 'Individual Contributor', kind: 'action', request: 'Create a task for Priya to send the launch checklist by Friday.', capabilities: ['CAP-createtask'],
         check: { rule: 'write_visible', expect: { Name: 'Send the launch checklist' }, reference_sql: "SELECT [Name] FROM [Tasks] WHERE [Name] = 'Send the launch checklist'", cleanup_sql: "DELETE FROM [Tasks] WHERE [Name] = 'Send the launch checklist'" } }),
    uc({ area: 'PP', persona: 'Team Lead', kind: 'question', request: 'Which projects is my team running this quarter?', capabilities: ['CAP-getprojects'], check: ids('SELECT [Id] FROM [Projects] WHERE [Archived] = false') }),
  ] });
  const add = run('manage-catalog.mjs', ['add', ...D, '--from', P('rb1.json'), '--batch', 'RB-001', '--prefix', 'BIG']);
  assert.match(add, /3 use case\(s\) added/);
  assert.match(add, /dropped as near-duplicates/);
  assert.equal(exitOf('manage-catalog.mjs', ['add', ...D, '--from', P('rb1.json'), '--batch', 'RB-001']), 3, 'a batch cannot be added twice');
  approve('TM,PP');
  const err = errOf('manage-catalog.mjs', ['freeze', ...D, '--areas', 'TM,PP']);
  assert.match(err, /research incomplete: 1 of 3 capabilities.*CAP-gettask/s, 'getTask is used by no use case and not explained');
  assert.match(err, /CAP-getproject/);
  assert.equal(area(status(), 'TM').research, 'needs_review');
  assert.match(area(status(), 'TM').next, /fill research gaps/);
  /* --fill plans a batch for only what is missing */
  const fill = run('scope.mjs', ['research-plan', ...D, '--areas', 'TM,PP', '--fill']);
  assert.match(fill, /RB-002 \(new\)\s+fill TM · 1 capabilities/);
  assert.match(fill, /RB-003 \(new\)\s+fill PP · 1 capabilities/);
  W('rb2.json', { model: 'opus', use_cases: [], no_business_use: [{ capability_id: 'CAP-gettask', reason: 'opening one task by id is a step inside other flows' }] });
  W('rb3.json', { model: 'opus', use_cases: [uc({ area: 'PP', persona: 'Team Lead', kind: 'question', request: 'Show me where the Website Relaunch project stands.', capabilities: ['CAP-getproject'], check: ids("SELECT [Id] FROM [Projects] WHERE [Name] = 'Website Relaunch'") })] });
  run('manage-catalog.mjs', ['add', ...D, '--from', P('rb2.json'), '--batch', 'RB-002']);
  run('manage-catalog.mjs', ['add', ...D, '--from', P('rb3.json'), '--batch', 'RB-003']);
  approve('TM,PP');
  assert.equal(exitOf('manage-catalog.mjs', ['freeze', ...D, '--areas', 'TM,PP']), 0);
  const st = status();
  assert.equal(area(st, 'TM').research, 'frozen');
  assert.equal(area(st, 'PP').research, 'frozen');
  assert.equal(area(st, 'GL').research, 'not_started');
  assert.equal(R('Big_catalog.json').frozen, false, 'the catalog as a whole is not frozen while areas are left');
});

test('a partial scope plans and runs only its areas, and the report says what it covers', () => {
  const p = plan('TM,PP');
  assert.deepEqual(p.scope.areas, ['TM', 'PP']);
  assert.equal(p.scope.partial, true);
  assert.ok(p.tc_list.every(t => t.suite === 'business'), 'a partial scope plans no driver conformance checks');
  assert.equal(p.tc_list.length, 4);
  assert.ok(p.tc_list.every(t => t.uc_hash), 'each test carries the hash of the wording it will run');
  /* without --areas, only the frozen areas are planned — and the plan says it is partial */
  try { run('generate-tests.mjs', [...D, '--connector', 'Big']); } catch { /* the thin gate does not apply to a partial plan */ }
  assert.deepEqual(R('Big_plan.json').scope.areas, ['TM', 'PP']);
  assert.equal(R('Big_plan.json').scope.partial, true);
  assert.ok(R('Big_plan.json').tc_list.every(t => t.suite === 'business'));
  plan('TM,PP');
  assert.match(run('scope.mjs', ['prepare-run', ...D, '--root', ROOT, '--run', 'r1']), /4 test\(s\) to run · 0 reused/);
  simulate('r1');
  const out = run('build-capability-report.mjs', [...D, '--root', ROOT]);
  assert.match(out, /2 of 4 area\(s\) researched · 2 with results · 1 run\(s\) combined/);
  const html = readFileSync(P('Big_capability_report.html'), 'utf8');
  assert.match(html, /"researched":2,"with_results":2,"complete":false/);
  const tabs = renderTabs(P('Big_capability_report.html'), ['summary', 'run', 'areas']);
  assert.match(tabs.summary, /Partial coverage/);
  assert.match(tabs.summary, /Not yet researched: Goals, Portfolios/);
  assert.match(tabs.run, /Coverage by business area/);
  for (const [t, h] of Object.entries(tabs)) assert.doesNotMatch(h, /undefined|NaN|\[object Object\]/, t);
});

test('3.7.6 — when the connection reaches several workspaces, every business test names the user\'s', () => {
  W('Big_knowledge.json', { ...KN, run_meta: { ...KN.run_meta, workspace: { id: '9001', name: 'test01' },
    workspace_catalog: [{ id: '9001', name: 'test01', is_organization: false }, { id: '9002', name: 'corp', is_organization: true }] } });
  try {
    const p = plan('TM,PP');
    const run = p.tc_list.filter(t => t.executable !== false);
    assert.ok(run.length);
    for (const t of run) assert.match(String(t.agent_context), /The user works in the "test01" workspace \(id 9001\)/, t.id);
  } finally { W('Big_knowledge.json', KN); plan('TM,PP'); }
  assert.ok(R('Big_plan.json').tc_list.every(t => !/The user works in/.test(t.agent_context || '')), 'one workspace: no note');
});

test('an area researched later is added without reopening the frozen ones, and earlier results are reused', () => {
  const before = R('Big_catalog.json').areas;
  run('scope.mjs', ['research-plan', ...D, '--areas', 'GL']);
  W('rb4.json', { model: 'opus', use_cases: [
    uc({ area: 'GL', persona: 'Team Lead', kind: 'question', request: 'Which of our goals are at risk this quarter?', capabilities: ['CAP-getgoals'], check: ids("SELECT [Id] FROM [Goals] WHERE [Status] = 'at_risk'") }),
    uc({ area: 'GL', persona: 'Team Lead', kind: 'action', request: 'Mark the onboarding goal as on track.', capabilities: ['CAP-updategoal'], writes: true,
         check: { rule: 'write_visible', expect: { Status: 'on_track' }, reference_sql: "SELECT [Status] FROM [Goals] WHERE [Name] = 'Onboarding'" } }),
  ] });
  run('manage-catalog.mjs', ['add', ...D, '--from', P('rb4.json'), '--batch', 'RB-004']);
  assert.equal(approve('GL'), 2, 'only the new area is judged — approved use cases are not paid for twice');
  assert.equal(exitOf('manage-catalog.mjs', ['freeze', ...D, '--areas', 'GL']), 0);
  const after = R('Big_catalog.json').areas;
  assert.equal(after.TM.version, before.TM.version, 'TM was not reopened');
  assert.equal(after.TM.hash, before.TM.hash);
  assert.equal(area(status(), 'TM').executed.valid, 2, 'TM results still stand');
  const p = plan('TM,PP,GL');
  assert.equal(p.tc_list.length, 6);
  const prep = run('scope.mjs', ['prepare-run', ...D, '--root', ROOT, '--run', 'r2']);
  assert.match(prep, /2 test\(s\) to run · 4 reused/);
  const pr = R('Big_plan.json');
  assert.ok(pr.tc_list.every(t => t.business_domain === 'GL'));
  assert.equal(pr.full_tc_list.length, 6);
  /* writes are allowed by default (3.7), so a use case that needs an unexposed capability is put to the agent once, as a limitation probe */
  const np = pr.tc_list.find(t => /onboarding/.test(t.prompt));
  assert.ok(np.probe === 'limitation' && /Not possible through the connector/.test(np.not_possible_reason), 'a use case that needs an unexposed capability is planned as a limitation probe');
  simulate('r2');
  const out = run('build-capability-report.mjs', [...D, '--root', ROOT]);
  assert.match(out, /3 of 4 area\(s\) researched · 3 with results · 2 run\(s\) combined/);
  const st = status();
  for (const id of ['TM', 'PP', 'GL']) assert.equal(area(st, id).executed.valid, area(st, id).executed.total, `${id} fully measured`);
  assert.equal(area(st, 'GL').next, 'done');
  /* everything in scope measured: prepare-run empties the plan and the router goes to the report */
  assert.match(run('scope.mjs', ['prepare-run', ...D, '--root', ROOT, '--run', 'r5']), /Nothing to run/);
  assert.equal(JSON.parse(run('detect-stage.mjs', [...D, '--connector', 'Big', '--areas', 'TM,PP,GL'])).stage, 12);
  assert.equal(JSON.parse(run('detect-stage.mjs', [...D, '--connector', 'Big'])).stage, 12);
  /* an earlier run can still be re-ingested (late judge files) from the same plan generation */
  const mf = () => JSON.parse(readFileSync(join(ROOT, '_results', 'Big', 'r2', 'manifest.json'), 'utf8'));
  const first = mf();
  run('ingest-results.mjs', [...D, '--root', ROOT, '--run', 'r2']);
  const again = mf();
  assert.equal(again.model, 'sonnet');
  assert.equal(again.planned_tests, 2, 'the tests r2 ran, not the plan prepared for r5');
  assert.equal(again.complete, true);
  assert.equal(again.run_started_at, first.run_started_at, 're-ingesting does not make a run newer');
});

test('--redo runs an area again; a changed connector build makes every result stale', () => {
  assert.match(run('scope.mjs', ['prepare-run', ...D, '--root', ROOT, '--run', 'r3', '--redo', 'TM']), /2 test\(s\) to run · 4 reused/);
  assert.ok(R('Big_plan.json').tc_list.every(t => t.business_domain === 'TM'));
  assert.equal(exitOf('ingest-results.mjs', [...D, '--root', ROOT, '--run', 'r1', '--model', 'sonnet']), 3, 'a plan prepared for r3 cannot be ingested as r1');
  assert.equal(exitOf('ingest-results.mjs', [...D, '--root', ROOT, '--run', 'r3', '--model', 'opus']), 3, '…nor as another model');
  W('Big_knowledge.json', { ...KN, run_meta: { ...KN.run_meta, connector_build: '25.0.0' } });
  try {
    const st = status();
    assert.equal(area(st, 'TM').executed.valid, 0);
    assert.equal(area(st, 'TM').executed.stale, 2, 'measured on another build: stale, not silently reused');
    assert.match(run('scope.mjs', ['prepare-run', ...D, '--root', ROOT, '--run', 'r4']), /6 test\(s\) to run · 0 reused from stored runs · 6 re-run because their stored result is stale/);
  } finally { W('Big_knowledge.json', KN); }
  run('scope.mjs', ['prepare-run', ...D, '--root', ROOT, '--run', 'r3']);
});

test('the cross-area pass adds flows between frozen areas without voiding the results already measured', () => {
  assert.deepEqual(status().cross_due, ['PP+TM']);
  assert.match(run('scope.mjs', ['research-plan', ...D, '--cross', 'PP,TM']), /cross-area TM\+PP|cross-area PP\+TM/);
  const rb = R('Big_research_plan.json').batches.find(b => b.cross);
  W('rbx.json', { model: 'opus', use_cases: [uc({ area: 'TM', persona: 'Individual Contributor', kind: 'question', request: 'Which overdue tasks belong to the Website Relaunch project?',
    capabilities: ['CAP-gettasks', 'CAP-getprojects'], check: ids('SELECT [Id] FROM [Tasks]') })] });
  run('manage-catalog.mjs', ['add', ...D, '--from', P('rbx.json'), '--batch', rb.id]);
  const x = R('Big_catalog.json').use_cases.find(u => u.cross);
  assert.deepEqual(x.also_areas, ['PP'], 'a cross-area use case names the other area it touches');
  assert.equal(area(status(), 'TM').research, 'changed');
  run('manage-catalog.mjs', ['sources-prep', ...D, '--areas', 'TM']);
  W('checks.json', { checks: R('Big_sources_to_check.json').items.map(i => ({ url: i.url, status: 'found' })) });
  run('manage-catalog.mjs', ['sources-merge', ...D, '--checks', P('checks.json')]);
  run('manage-catalog.mjs', ['judge-prep', ...D, '--areas', 'TM']);
  W('scores.json', { scores: R('Big_catalog_judge_input.json').use_cases.map(u => ({ id: u.id, score: 5 })) });
  run('manage-catalog.mjs', ['judge-merge', ...D, '--scores', P('scores.json')]);
  assert.match(errOf('manage-catalog.mjs', ['freeze', ...D, '--areas', 'TM']), /added or retired since the coverage review/, 'a new use case changes the set, so the area is reviewed again');
  review('TM');
  assert.equal(errOf('manage-catalog.mjs', ['freeze', ...D, '--areas', 'TM']), '', 'one addition does not need a new human sample');
  const st = status();
  assert.equal(R('Big_catalog.json').areas.TM.version, 2);
  assert.deepEqual(st.cross_due, []);
  assert.equal(area(st, 'TM').executed.valid, 2, 'the two measured TM use cases keep their results');
  assert.equal(area(st, 'TM').executed.total, 3);
  assert.equal(JSON.parse(run('detect-stage.mjs', [...D, '--connector', 'Big', '--areas', 'TM,PP'])).stage, 8, 'a plan made before TM v2 is regenerated');
});

test('an eval over a scope reuses each model\'s results per use case, with the default models', () => {
  const out = run('eval.mjs', ['plan', ...D, '--root', ROOT, '--areas', 'PP,GL', '--eval', 'e1']);
  const ep = R('Big_eval_plan.json');
  assert.deepEqual(ep.models.map(m => m.model), ['opus', 'sonnet', 'haiku'], 'config.eval.default_models when --models is not given');
  assert.equal(ep.models.find(m => m.model === 'sonnet').reused, true, 'sonnet already has every PP and GL result');
  assert.equal(ep.models.find(m => m.model === 'opus').missing, 4);
  assert.match(out, /RUN NEEDED as e1-opus/);
  assert.equal(exitOf('eval.mjs', ['plan', ...D, '--root', ROOT, '--areas', 'PF', '--models', 'opus,sonnet']), 3, 'an area that is not frozen cannot be evaluated');
});

test('an area can be reset and researched again; the router sends unresearched scope to 5.5', () => {
  assert.equal(JSON.parse(run('detect-stage.mjs', [...D, '--connector', 'Big', '--areas', 'PF'])).stage, 5.5);
  run('manage-catalog.mjs', ['reset-area', ...D, '--areas', 'GL']);
  const old = R('Big_research_plan.json').batches.find(b => b.areas.includes('GL') && !b.cross);
  assert.equal(old.status, 'superseded');
  assert.equal(exitOf('manage-catalog.mjs', ['add', ...D, '--from', P('rb4.json'), '--batch', old.id]), 3, 'late research for a reset area is refused');
  const cat = R('Big_catalog.json');
  assert.ok(cat.use_cases.filter(u => u.area === 'GL').every(u => u.status === 'retired'), 'retired, never deleted: ids stay permanent');
  assert.equal(area(status(), 'GL').research, 'not_started');
  assert.match(run('scope.mjs', ['research-plan', ...D, '--areas', 'GL']), /\(new\)\s+GL/, 'a reset area gets a fresh batch, not the superseded one');
  assert.match(run('scope.mjs', ['research-plan', ...D, '--areas', 'TM']), /TM: already frozen/);
});

/* run the report's own page script against a stub DOM and return what each tab rendered */
function renderTabs(file, tabsWanted) {
  const html = readFileSync(file, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const out = {};
  for (const t of tabsWanted) {
    const app = { innerHTML: '', addEventListener() {}, querySelectorAll: () => [] };
    new Function('document', 'localStorage', 'window', js)({ getElementById: id => id === 'app' ? app : null }, { getItem: k => k === 'cap-tab' ? t : null, setItem() {} }, { scrollTo() {} });
    out[t] = app.innerHTML;
  }
  return out;
}
