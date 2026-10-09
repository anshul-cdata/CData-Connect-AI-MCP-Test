/* 3.7 — test data: use the records the account has, create only what is missing, and name them in
 * checks by fixture, never by one account's ids. Write safety is off by default on test accounts,
 * and every run starts with one question about writes. Generic: no source names in the code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fixtureRefs, renderUseCase, fixtureProblems, withExamples, bindOrder, bindingsHash, HARDCODED_ID } from '../scripts/lib/fixtures.mjs';
import { validateCatalog, areaHash } from '../scripts/lib/catalog.mjs';
import { writePolicy } from '../scripts/lib/artifacts.mjs';
import { fingerprintFor, fingerprint, writeRun } from '../scripts/lib/results.mjs';
import { latestResults } from '../scripts/lib/scope.mjs';
import { ucHash } from '../scripts/lib/catalog.mjs';
import { fillSql } from '../scripts/lib/checks.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (script, args) => execFileSync(process.execPath, [join(SK, 'scripts', script), ...args], { encoding: 'utf8' });

const FX = [
  { id: 'proj', area: 'TR', table: 'Projects', describe: 'an active project with open tasks', example: { Name: 'Website Relaunch' },
    find_sql: "SELECT [Id],[Name] FROM [C].[S].[Projects] WHERE [Archived] = false", seed: ["INSERT INTO [C].[S].[Projects] ([Name],[Workspace]) VALUES ('Website Relaunch','{{workspace}}')"] },
  { id: 'task', area: 'TR', table: 'Tasks', describe: 'an open task in that project', example: { Name: 'Fix broken image links' }, depends_on: ['proj'],
    find_sql: "SELECT [Id],[Name] FROM [C].[S].[Tasks] WHERE [ProjectId] = '{{fixture:proj.Id}}' AND [Completed] = false",
    seed: ["INSERT INTO [C].[S].[Tasks] ([Name],[ProjectId]) VALUES ('Fix broken image links','{{fixture:proj.Id}}')"] },
];
const UC = { id: 'UC-1', area: 'TR', kind: 'action', status: 'draft', persona: 'Lead', goal: 'log time', capabilities: [],
  request: 'Log 45 minutes on the "{{fixture:task.Name}}" task in {{fixture:proj.Name}} for today.',
  expected_behavior: ['finds {{fixture:task.Name}}'], difficulty: 'simple', tests: ['write'],
  source: { kind: 'community', title: 't', url: 'https://x' },
  check: { rule: 'write_visible', key: 'Id', expect: { DurationMinutes: 45 }, reference_sql: "SELECT [Id],[DurationMinutes] FROM [C].[S].[Entries] WHERE [TaskId] = '{{fixture:task.Id}}'" } };

test('a use case refers to records by fixture, rendered with what the account holds', () => {
  assert.deepEqual([...fixtureRefs(UC)].sort(), ['proj', 'task']);
  const r = renderUseCase(UC, { proj: { Id: '77', Name: "Q4 Launch" }, task: { Id: '91', Name: "Draft O'Neil brief" } });
  assert.equal(r.request, 'Log 45 minutes on the "Draft O\'Neil brief" task in Q4 Launch for today.');
  assert.match(r.check.reference_sql, /\[TaskId\] = '91'/);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(renderUseCase(UC, { proj: { Id: '77', Name: 'Q4' } }).missing.sort(), ['task.Id', 'task.Name']);
  assert.equal(withExamples(UC.request, { fixtures: FX }), 'Log 45 minutes on the "Fix broken image links" task in Website Relaunch for today.');
  assert.deepEqual(bindOrder(FX).order.map(f => f.id), ['proj', 'task']);
  assert.equal(fillSql("x = '{{workspace}}'", { workspace: 'W1' }), "x = 'W1'");
});

test('the catalog refuses checks that name records by an account\'s ids, and checks fixtures', () => {
  const idBound = { ...UC, id: 'UC-2', request: 'Log 30 minutes on the review task today.', expected_behavior: ['logs it'],
    check: { ...UC.check, reference_sql: "SELECT [Id] FROM [Entries] WHERE [TaskId] = '1219080094470421'" } };
  const v = validateCatalog({ fixtures: FX, use_cases: [UC, idBound] });
  assert.ok(v.problems.some(p => /UC-2: reference_sql names records by an account's ids/.test(p)));
  assert.ok(!v.problems.some(p => /^UC-1/.test(p) && /ids|fixture/.test(p)), v.problems.join('\n'));
  assert.ok(HARDCODED_ID.test("'1219080094470421'") && !HARDCODED_ID.test("'{{today}}'") && !HARDCODED_ID.test('LIMIT 50'));
  const bad = fixtureProblems({ fixtures: [{ id: 'x', describe: 'a', find_sql: "SELECT [Name] FROM T WHERE [Id] = '1219080094470421'", seed: ['DELETE FROM T'] }, { ...FX[1], id: 'y', depends_on: ['nope'] }],
    use_cases: [{ id: 'U', request: '{{fixture:ghost.Name}}' }] });
  for (const re of [/describe the record/, /must return the record's Id/, /names a record by its id/, /must be an INSERT/, /needs example values/, /depends on nope/, /fixture ghost, which is not defined/])
    assert.ok(bad.some(p => re.test(p)), `expected ${re}`);
  /* fixtures are part of what an area froze; an area without them hashes as before */
  const cat = { fixtures: FX, use_cases: [{ ...UC, status: 'approved' }] };
  const before = areaHash(cat, 'TR');
  assert.notEqual(areaHash({ ...cat, fixtures: [{ ...FX[0], find_sql: FX[0].find_sql + ' ORDER BY [Name]' }, FX[1]] }, 'TR'), before);
  assert.equal(areaHash({ use_cases: [{ ...UC, status: 'approved' }] }, 'TR'), areaHash({ fixtures: [], use_cases: [{ ...UC, status: 'approved' }] }, 'TR'));
});

test('test data: find what exists first, seed only what is missing, then bind it', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-td-')), 'Demo');
  mkdirSync(join(dir, '_agent_out'), { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  const R = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  W('Demo_knowledge.json', { connector: 'Demo', run_meta: { catalog: 'C', schema: 'S', workspace: { id: 'W1', name: 'test01' } } });
  W('Demo_capabilities.json', { areas: [{ id: 'TR', name: 'Time', capability_ids: ['C1'] }], capabilities: [{ id: 'C1', mapping: { exposure: [{ kind: 'table', name: 'Projects' }] } }] });
  W('Demo_catalog.json', { fixtures: FX, use_cases: [{ ...UC, status: 'approved' }] });
  /* survey: real rows for the writer */
  node('test-data.mjs', ['survey-prep', '--dir', dir, '--areas', 'TR']);
  assert.match(R('_agent_out/test-data-survey.json').items[0].sql, /SELECT \* FROM \[C\]\.\[S\]\.\[Projects\] LIMIT 5/);
  W('survey.json', { tables: [{ table: 'Projects', rows: [{ Id: '77', Name: 'Q4 Launch', Notes: 'x'.repeat(500) }] }] });
  node('test-data.mjs', ['survey-merge', '--dir', dir, '--checks', join(dir, 'survey.json')]);
  assert.deepEqual(R('Demo_data_survey.json').tables.Projects.rows[0], { Id: '77', Name: 'Q4 Launch' }, 'long values are dropped');
  /* find: the parent first; the child waits for it */
  node('test-data.mjs', ['find-prep', '--dir', dir, '--me', 'u1']);
  assert.deepEqual(R('_agent_out/test-data-find.json').items.map(i => i.fixture), ['proj']);
  W('f1.json', { finds: [{ fixture: 'proj', rows: [{ Id: '77', Name: 'Q4 Launch' }] }] });
  node('test-data.mjs', ['find-merge', '--dir', dir, '--checks', join(dir, 'f1.json')]);
  node('test-data.mjs', ['find-prep', '--dir', dir, '--me', 'u1']);
  const it = R('_agent_out/test-data-find.json').items;
  assert.deepEqual(it.map(i => i.fixture), ['task']);
  assert.match(it[0].sql, /\[ProjectId\] = '77'/, 'the child is looked for under the bound parent');
  W('f2.json', { finds: [{ fixture: 'task', rows: [] }] });
  node('test-data.mjs', ['find-merge', '--dir', dir, '--checks', join(dir, 'f2.json')]);
  /* seed only the missing one, with its parent's real id */
  const seedMsg = node('test-data.mjs', ['seed-prep', '--dir', dir, '--me', 'u1']);
  assert.match(seedMsg, /1 fixture\(s\) to create/);
  const seed = R('_agent_out/test-data-seed.json');
  assert.match(seed.instructions[0], /SHOW EVERY STATEMENT TO THE USER FIRST/);
  assert.deepEqual(seed.items[0].statements, ["INSERT INTO [C].[S].[Tasks] ([Name],[ProjectId]) VALUES ('Fix broken image links','77')"]);
  W('s.json', { seeds: [{ fixture: 'task', ok: true }] });
  node('test-data.mjs', ['seed-merge', '--dir', dir, '--checks', join(dir, 's.json')]);
  W('f3.json', { finds: [{ fixture: 'task', rows: [{ Id: '91', Name: 'Fix broken image links' }] }] });
  node('test-data.mjs', ['find-prep', '--dir', dir, '--me', 'u1']);
  node('test-data.mjs', ['find-merge', '--dir', dir, '--checks', join(dir, 'f3.json')]);
  const td = R('Demo_test_data.json');
  assert.deepEqual([td.fixtures.proj.status, td.fixtures.task.status], ['found', 'seeded']);
  assert.match(node('test-data.mjs', ['status', '--dir', dir]), /TR: 2 fixture\(s\) · 1 found · 1 seeded · 0 missing · 0 refused · 0 not looked for — 1 of 1 use cases have their data/);
  /* 3.7.1: binding test data does not change the environment — results are compared per use case,
   * on the records each one used, so binding one area never invalidates another */
  const K = R('Demo_knowledge.json');
  assert.equal(fingerprintFor(K, null, td).env_key, fingerprintFor(K, null, null).env_key);
  assert.ok(fingerprintFor(K, null, td).test_data, 'the bindings are still recorded in the fingerprint');
  assert.ok(bindingsHash(td));
  const root = join(dir, '..');
  const uc = { ...UC, status: 'approved' };
  const rec = ids => ({ run_id: 'r1', suite: 'business', use_case_id: 'UC-1', variant: 0, attempt: 1, outcome: 'correct', score: 90, uc_hash: ucHash(uc), fixtures: ids, steps: [{ ok: true }] });
  const fp = fingerprint({ connector_build: 'b', instructions: 'i', workspace: 'W1' });
  writeRun(root, 'Demo', 'r1', { model: 'm', fingerprint: fp, run_started_at: '2026-01-01' }, [rec({ proj: '77', task: '91' })]);
  const q = t => latestResults(root, 'Demo', { model: 'm', cat: { use_cases: [uc] }, env: fp.env_key, testData: t });
  assert.ok(q(td).valid.has('UC-1#0'), 'same records: the result stands');
  const moved = JSON.parse(JSON.stringify(td)); moved.fixtures.task.values.Id = '92';
  assert.match(q(moved).stale.get('UC-1#0').why, /bound to other records/);
  const otherArea = JSON.parse(JSON.stringify(td)); otherArea.fixtures.unrelated = { status: 'found', values: { Id: '5' } };
  assert.ok(q(otherArea).valid.has('UC-1#0'), 'binding another area\'s fixture changes nothing here');
  /* a seed the account refuses blocks the use cases that need it, by the account */
  W('s2.json', { seeds: [{ fixture: 'task', ok: false, error: 'HTTP [40002] Tasks are not available on your current plan or add-ons.' }] });
  node('test-data.mjs', ['seed-merge', '--dir', dir, '--checks', join(dir, 's2.json')]);
  assert.equal(R('Demo_test_data.json').fixtures.task.status, 'refused');
});

test('write safety is off by default; safe mode and a read-only answer restore it', () => {
  const cfg = JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8'));
  const p = writePolicy(cfg);
  assert.equal(p.safe_mode, false);
  assert.equal(p.execute_irreversible, true, 'test accounts: creates the connector cannot delete still run');
  assert.equal(p.confirm_at_start, true, 'the shipped config asks at the start of every run');
  const safe = writePolicy({ defaults: { write_policy: { safe_mode: true } } });
  assert.deepEqual([safe.execute_irreversible, safe.require_workspace_pin], [false, true]);
  const dir = mkdtempSync(join(tmpdir(), 'cqa-wp-'));
  const ask = node('write-policy.mjs', ['status', '--dir', dir]);
  assert.match(ask, /^WRITES — on, including creates the connector cannot delete/);
  assert.match(ask, /ASK — "This run can create and change records/);
  node('write-policy.mjs', ['confirm', '--dir', dir, '--answer', 'readonly']);
  assert.equal(writePolicy(cfg, dir).execute_irreversible, false, 'answered read only: this connector folder is in safe mode');
  node('write-policy.mjs', ['confirm', '--dir', dir, '--answer', 'test']);
  assert.equal(writePolicy(cfg, dir).execute_irreversible, true);
});
