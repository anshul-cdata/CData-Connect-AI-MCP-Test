/* The 3.0 libraries, one rule at a time. The pipeline test proves they fit together; these prove
 * each one does what its comments promise on the cases most likely to go wrong. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSpec, toCapabilities, classify, tableFor, procedureFor } from '../scripts/lib/capabilities.mjs';
import { normalizeJourney, classifyError } from '../scripts/lib/journey.mjs';
import { compare } from '../scripts/lib/checks.mjs';
import { scoreJourney } from '../scripts/lib/scoring.mjs';
import { similarity, assignIds, validateCatalog, catalogHash, sampleForReview, agreement } from '../scripts/lib/catalog.mjs';
import { fingerprint, writeRun, findReusable, byUseCase } from '../scripts/lib/results.mjs';

/* ── capabilities ─────────────────────────────────────────────────────── */
test('the YAML reader takes paths, methods, tags and parameters from an OpenAPI file', () => {
  const s = parseSpec(`openapi: 3.0.0
info:
  title: Sample
  version: "2.1"
paths:
  /tasks:
    get:
      summary: Get tasks
      operationId: getTasks
      tags:
        - Tasks
      parameters:
        - name: assignee
          in: query
        - $ref: '#/components/parameters/limit'
  "/tasks/{task_gid}/setParent":
    post:
      operationId: setParentForTask
      summary: Set the parent of a task
      tags: [Tasks]
      requestBody:
        required: true
      deprecated: false
components:
  schemas: {}`);
  assert.equal(s.title, 'Sample'); assert.equal(s.version, '2.1');
  assert.equal(s.operations.length, 2);
  assert.deepEqual(s.operations[0].params, ['assignee', 'limit']);
  assert.deepEqual(s.operations[1].tags, ['Tasks']);
  assert.equal(s.operations[1].has_body, true);
});

test('operations are classified by method and path shape', () => {
  const k = (m, p) => classify({ method: m, path: p }).kind;
  assert.equal(k('GET', '/tasks'), 'list');
  assert.equal(k('GET', '/tasks/{gid}'), 'get');
  assert.equal(k('POST', '/tasks'), 'create');
  assert.equal(k('POST', '/tasks/{gid}/subtasks'), 'create');
  assert.equal(k('POST', '/tasks/{gid}/addFollowers'), 'action');
  assert.equal(k('PUT', '/tasks/{gid}'), 'update');
  assert.equal(k('DELETE', '/tasks/{gid}'), 'delete');
  assert.equal(classify({ method: 'GET', path: '/projects/{gid}/tasks' }).noun, 'tasks');
});

test('tables and procedures are matched by name, and a procedure for another noun is not taken', () => {
  assert.equal(tableFor('time_tracking_entries', ['Tasks', 'TimeTrackingEntries']).name, 'TimeTrackingEntries');
  assert.equal(tableFor('user_task_lists', ['UserTaskList']).name, 'UserTaskList');
  assert.equal(tableFor('project_briefs', ['Projects']), null, 'a brief is not a project');
  const cap = { operation_id: 'addFollowersForProject', action: 'addFollowers', noun: 'projects', parent: 'projects' };
  assert.equal(procedureFor(cap, ['AddFollowersForTask', 'AddFollowersForProject']).name, 'AddFollowersForProject');
});

test('capability ids are stable and unique', () => {
  const caps = toCapabilities({ operations: [{ method: 'GET', path: '/a', operationId: 'getA', tags: [], params: [] }, { method: 'GET', path: '/b', operationId: 'getA', tags: [], params: [] }] });
  assert.deepEqual(caps.map(c => c.id), ['CAP-geta', 'CAP-geta_x']);
});

/* ── journeys ─────────────────────────────────────────────────────────── */
test('CData error messages are classified, with the party who owns the fix', () => {
  assert.deepEqual(classifyError("STMT The catalog 'Asana' either does not exist or is inaccessible."), { class: 'catalog_not_found', cause: 'instructions' });
  assert.equal(classifyError("Column 'Priority' was not found in table 'Tasks'").class, 'column_not_found');
  assert.equal(classifyError('Function DATE_TRUNC is not supported').class, 'unsupported_function');
  assert.equal(classifyError('Query timed out after 30 seconds').class, 'timeout');
  assert.equal(classifyError('HTTP 429 Too Many Requests').class, 'rate_limit');
  assert.equal(classifyError('something odd').class, 'unclassified');
});

test('a journey records retries, recoveries, dead ends and the reason the agent gave', () => {
  const j = normalizeJourney({ calls: [
    { tool: 'queryData', input: { query: 'SELECT 1 FROM [X].[Y].[T]', llmContext: '{"reason":"first try"}' }, result: "Error: The catalog 'X' does not exist" },
    { tool: 'getCatalogs', input: {}, result: 'X1' },
    { tool: 'queryData', input: { query: 'SELECT 1 FROM [X1].[Y].[T]' }, result: '1 row', rows: 1, ms: 400 },
    { tool: 'executeProcedure', input: { name: 'Nope' }, error: 'Procedure not supported' },
  ], final_rows: [{ Id: 1 }], wall_ms: 900, tokens: 3000 });
  assert.equal(j.steps[0].reason, 'first try');
  assert.equal(j.steps[0].error_class, 'catalog_not_found');
  assert.equal(j.steps[1].recovery_of, 1);
  assert.equal(j.steps[2].retry_of, 1);
  const m = j.metrics;
  assert.equal(m.calls, 4); assert.equal(m.failed, 2); assert.equal(m.recoveries, 1); assert.equal(m.dead_ends, 1);
  assert.equal(m.calls_before_first_result, 3);
  assert.equal(m.first_attempt, false);
  assert.equal(m.time_ms, 900);
});

test('a write is recognised from its SQL, whatever tool carried it', () => {
  const j = normalizeJourney({ calls: [{ tool: 'queryData', input: { query: "UPDATE [T] SET [A]=1 WHERE [Id]='2'" }, result: '1 row updated' }] });
  assert.equal(j.steps[0].category, 'write');
  assert.equal(j.metrics.writes, 1);
});

/* ── checks ───────────────────────────────────────────────────────────── */
test('answers are compared on data, by rule', () => {
  const ref = { rows: [{ Id: 1 }, { Id: 2 }] };
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ id: 2 }, { ID: 1 }] }, ref).result, 'correct', 'keys match case-insensitively');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] }, ref).result, 'partial');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: 9 }] }, ref).result, 'wrong');
  assert.equal(compare({ rule: 'contains', key: 'Id' }, { rows: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] }, ref).result, 'correct');
  assert.equal(compare({ rule: 'same_count' }, { rows: [], stated_count: 7 }, { rows: [{ n: 7 }] }).result, 'correct', 'a COUNT(*) reference is a scalar');
  assert.equal(compare({ rule: 'values_within', key: 'Id', field: 'Hrs', tolerance: 0.1 }, { rows: [{ Id: 1, Hrs: 10.5 }] }, { rows: [{ Id: 1, Hrs: 10 }] }).result, 'correct');
  assert.equal(compare({ rule: 'write_visible', expect: { Status: 'done' } }, {}, { rows: [{ Status: 'open' }] }).result, 'wrong');
});

test('an empty reference is "no test data", never a pass', () => {
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [] }, { rows: [] }).result, 'no_test_data');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: 1 }] }, { error: 'boom' }).result, 'not_checked');
});

/* ── scoring ──────────────────────────────────────────────────────────── */
const J = (calls, failed = 0, extra = {}) => ({ metrics: { calls, failed, recoveries: failed, dead_ends: 0, repeated: 0, gave_up: false, time_ms: null, tokens: null, ...extra } });
test('a smooth correct journey is blue; a fast wrong one is red', () => {
  assert.equal(scoreJourney(J(2), 'correct', { shortest: 2 }).grade, 'blue');
  const wrong = scoreJourney(J(2), 'wrong', { shortest: 2 });
  assert.equal(wrong.grade, 'red');
  assert.equal(scoreJourney(J(2), 'partial', { shortest: 2 }).grade, 'yellow', 'partial is never blue');
});
test('friction costs points; missing timing is left out, not punished', () => {
  const smooth = scoreJourney(J(3), 'correct', { shortest: 3 }).score;
  const rough = scoreJourney(J(8, 3), 'correct', { shortest: 3 }).score;
  assert.ok(rough < smooth && rough >= 60, `${rough} vs ${smooth}`);
  assert.equal(scoreJourney(J(3), 'correct', { shortest: 3 }).parts.speed, null);
  assert.equal(scoreJourney(J(3), 'no_test_data').score, null);
});

/* ── catalog ──────────────────────────────────────────────────────────── */
test('ids are permanent: new use cases get the next number, existing ones keep theirs', () => {
  const cat = { use_cases: [{ id: 'UC-ASN-0007' }, {}, {}] };
  assignIds(cat, 'ASN');
  assert.deepEqual(cat.use_cases.map(u => u.id), ['UC-ASN-0007', 'UC-ASN-0008', 'UC-ASN-0009']);
});
test('near-duplicate requests are flagged; the hash ignores notes but not wording', () => {
  assert.ok(similarity('Which of my tasks are overdue?', 'Which tasks of mine are overdue') >= 0.8);
  assert.ok(similarity('Which of my tasks are overdue?', 'Log two hours on the launch task') < 0.3);
  const a = { use_cases: [{ id: 'U1', request: 'x y z', kind: 'question', check: { rule: 'judge' }, note: 'a' }] };
  const b = { use_cases: [{ ...a.use_cases[0], note: 'b' }] };
  const c = { use_cases: [{ ...a.use_cases[0], request: 'x y z w' }] };
  assert.equal(catalogHash(a), catalogHash(b)); assert.notEqual(catalogHash(a), catalogHash(c));
});
test('a use case without evidence, a check, or clean wording is refused', () => {
  const v = validateCatalog({ use_cases: [{ id: 'U1', request: 'Show me each ProjectFollowers record please', persona: 'PM', goal: 'g', area: 'A', kind: 'question',
    capabilities: ['CAP-x'], check: { rule: 'same_ids', reference_sql: 'SELECT 1' } }] }, { capabilities: [{ id: 'CAP-y' }], schema: { objects: ['ProjectFollowers'] } });
  const all = v.problems.join('\n');
  assert.match(all, /no source/); assert.match(all, /CAP-x is not in the capability list/); assert.match(all, /needs a key/); assert.match(all, /ProjectFollowers/);
});
test('the human sample spreads across areas and personas, and agreement is judged on the bar', () => {
  const ucs = ['A', 'B', 'C'].flatMap(ar => [1, 2, 3].map(i => ({ id: `U-${ar}${i}`, area: ar, persona: 'P' + i, realism: { score: i === 3 ? 3 : 5 } })));
  const s = sampleForReview({ use_cases: ucs }, 3);
  assert.equal(new Set(s.map(u => u.area)).size, 3);
  const ag = agreement(ucs, [{ id: 'U-A1', rating: '5' }, { id: 'U-A3', rating: '5' }]);
  assert.equal(ag.n, 2); assert.equal(ag.agree, 1); assert.equal(ag.disagreements[0].id, 'U-A3');
});

/* ── results ──────────────────────────────────────────────────────────── */
test('a stored run is reused only for the same fingerprint, model and a complete run', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-res-'));
  const fp = fingerprint({ catalog_version: 1, catalog_hash: 'h', connector_build: 'b', instructions: 'i', workspace: 'w' });
  writeRun(root, 'X', 'r1', { model: 'sonnet', fingerprint: fp, complete: true, finished_at: '2026-10-01' }, []);
  writeRun(root, 'X', 'r2', { model: 'sonnet', fingerprint: fp, complete: false, finished_at: '2026-10-02' }, []);
  assert.equal(findReusable(root, 'X', fp.key, 'sonnet').run_id, 'r1', 'the incomplete newer run is not reused');
  assert.equal(findReusable(root, 'X', fp.key, 'opus'), null);
  const other = fingerprint({ catalog_version: 2, catalog_hash: 'h', connector_build: 'b', instructions: 'i', workspace: 'w' });
  assert.equal(findReusable(root, 'X', other.key, 'sonnet'), null, 'a new catalog version is a different exam');
});
test('attempts collapse to the median attempt, with pass rate and spread', () => {
  const rows = byUseCase([{ use_case_id: 'U', attempt: 1, score: 40, outcome: 'partial' }, { use_case_id: 'U', attempt: 2, score: 90, outcome: 'correct' }, { use_case_id: 'U', attempt: 3, score: 70, outcome: 'correct' }]);
  assert.equal(rows[0].score, 70); assert.equal(rows[0].spread, 50); assert.ok(Math.abs(rows[0].pass_rate - 2 / 3) < 1e-9);
});

/* ── edge cases found in review ──────────────────────────────────────────── */
import { mapToConnector, tableOps } from '../scripts/lib/capabilities.mjs';
import { fillSql, cleanupProblems } from '../scripts/lib/checks.mjs';
import { rescore } from '../scripts/lib/scoring.mjs';

test('path-level parameters reach every operation, and folded summaries are read whole', () => {
  const s = parseSpec(`openapi: 3.0.0
info:
  title: Sample
  version: "1"
paths:
  /tasks/{task_gid}:
    parameters:
      - name: task_gid
        in: path
    get:
      operationId: getTask
      summary: >-
        Get a task
        by its id
    delete:
      operationId: deleteTask
      summary: Delete a task
`);
  assert.equal(s.operations.length, 2);
  for (const op of s.operations) assert.ok(op.params.some(p => (p.name || p) === 'task_gid'), `${op.operationId} lost the path parameter`);
  assert.match(s.operations.find(o => o.operationId === 'getTask').summary, /^Get a task/);
});

test('a plural noun that starts like a verb is a resource, not an action', () => {
  assert.equal(classify({ method: 'POST', path: '/tasks/{task_gid}/attachments' }).kind, 'create');
  assert.equal(classify({ method: 'POST', path: '/tasks/{task_gid}/addFollowers' }).kind, 'action');
  assert.equal(classify({ method: 'POST', path: '/projects/{project_gid}/duplicate' }).kind, 'action');
});

test('writes are trusted only when the table\'s remarks and the permissions agree', () => {
  assert.deepEqual(tableOps({ remarks: 'To Create, Update and Query the Tasks table.' }), { insert: true, update: true, delete: false, select: true });
  assert.equal(tableOps({ remarks: 'Tasks assigned to people.' }), null, 'silent remarks are not read as a no');
  const caps = toCapabilities({ operations: [
    { method: 'POST', path: '/tasks', operationId: 'createTask', tags: ['Tasks'], params: [] },
    { method: 'DELETE', path: '/tasks/{gid}', operationId: 'deleteTask', tags: ['Tasks'], params: [] },
    { method: 'POST', path: '/stories', operationId: 'createStory', tags: ['Stories'], params: [] },
  ] });
  const K = { objects: [{ name: 'Tasks', remarks: 'To Create, Update and Query' }, { name: 'Stories', remarks: 'Comments on tasks.' }],
              physical: { procedures: [], permissions: { insert: true, update: true, delete: true } } };
  const m = Object.fromEntries(mapToConnector(caps, K).map(c => [c.operation_id, c.mapping]));
  assert.deepEqual([m.createTask.status, m.createTask.confidence], ['exposed', 'high']);
  assert.equal(m.deleteTask.status, 'not_exposed', 'the remarks leave out Delete, whatever the global flag says');
  assert.deepEqual([m.createStory.status, m.createStory.confidence], ['exposed', 'low'], 'silent remarks go to review');
});

test('a write counts only if it was not already there', () => {
  const check = { rule: 'write_visible', expect: { Name: 'Launch' } };
  const after = [{ Name: 'Launch' }];
  assert.equal(compare(check, {}, { rows: after, before_rows: [] }).result, 'correct');
  assert.equal(compare(check, {}, { rows: after, before_rows: [{ Name: 'Launch' }] }).result, 'wrong', 'it was there before the agent ran');
  assert.equal(compare(check, {}, { rows: after }).result, 'partial', 'no before-snapshot, so not proven');
  assert.equal(compare({ rule: 'write_visible' }, {}, { rows: after, before_rows: [] }).result, 'not_checked', 'no expect, no verdict');
});

test('a count is read from a count column, not from any one-cell result', () => {
  assert.equal(compare({ rule: 'same_count' }, { stated_count: 5 }, { rows: [{ TaskCount: 5 }] }).result, 'correct');
  assert.equal(compare({ rule: 'same_count' }, { stated_count: 1 }, { rows: [{ Name: '7' }] }).result, 'correct', 'one row named Name is one record, not the number 7');
  assert.equal(compare({ rule: 'same_count', scalar: true }, { stated_count: 7 }, { rows: [{ Name: '7' }] }).result, 'correct');
});

test('a capped sample proves nothing about the whole set without a matching total', () => {
  const ref = { rows: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] };
  const sample = { rows: [{ Id: 1 }, { Id: 2 }], truncated: true };
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { ...sample, stated_count: 3 }, ref).result, 'correct');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, sample, ref).result, 'wrong', 'no stated total');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: 1 }, { Id: 9 }], truncated: true, stated_count: 3 }, ref).result, 'wrong');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, sample, { ...ref, agent_rows: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] }).result, 'correct', 'the orchestrator re-ran the agent\'s query in full');
});

test('check SQL is filled at run time, and cleanup is held to a narrow shape', () => {
  assert.equal(fillSql("WHERE [DueOn] < '{{today}}' AND [Mod] > '{{today-7}}'", { today: '2026-10-01' }), "WHERE [DueOn] < '2026-10-01' AND [Mod] > '2026-09-24'");
  assert.equal(fillSql('WHERE [Id] IN ({{located}})', { located: ["a'b", 'c'] }), "WHERE [Id] IN ('a''b','c')");
  assert.equal(fillSql('WHERE [Id] IN ({{located}})', {}), "WHERE [Id] IN ('')", 'nothing located matches nothing');
  assert.deepEqual(cleanupProblems("DELETE FROM [Tasks] WHERE [Name] = 'x'", ['Tasks']), []);
  assert.ok(cleanupProblems('DELETE FROM [Tasks]', ['Tasks']).some(p => /no WHERE/.test(p)));
  assert.ok(cleanupProblems("DELETE FROM [Users] WHERE [Id] = '1'", ['Tasks']).some(p => /does not touch/.test(p)));
  assert.ok(cleanupProblems("DELETE FROM [Tasks] WHERE 1 = 1 OR 1 = 1", ['Tasks']).length);
});

test('a run is re-scored against the pool it is shown with, so a better path elsewhere lowers efficiency', () => {
  const rec = (calls, run) => ({ run_id: run, use_case_id: 'UC-X-0001', kind: 'question', outcome: 'correct',
    metrics: { calls, acting_calls: calls, failed: 0, recoveries: 0, dead_ends: 0, repeated: 0, time_ms: 5000, tokens: 5000, first_attempt: true } });
  const alone = rescore([rec(4, 'a')], {}, {})[0];
  const pooled = rescore([rec(4, 'a')], { pool: [rec(1, 'b')] }, {})[0];
  assert.ok(pooled.parts.efficiency < alone.parts.efficiency, `${pooled.parts.efficiency} should be below ${alone.parts.efficiency}`);
});

test('an action must say what it expects to see, and a job whether it writes', () => {
  const base = { persona: 'P', goal: 'g', area: 'A', capabilities: ['CAP-x'], source: { kind: 'help_center', title: 't' } };
  const { problems } = validateCatalog({ use_cases: [
    { ...base, id: 'UC-A-0001', kind: 'action', request: 'Create a follow-up task for the launch', check: { rule: 'write_visible', reference_sql: 'SELECT 1' } },
    { ...base, id: 'UC-A-0002', kind: 'job', request: 'Tidy up the work finished last week', check: { rule: 'judge' } },
    { ...base, id: 'UC-A-0003', kind: 'action', request: 'Close out the tasks I finished today', writes: true,
      check: { rule: 'write_visible', expect: { Completed: true }, reference_sql: 'SELECT 1', cleanup_sql: 'UPDATE [Tasks] SET [Completed] = false WHERE [Id] IN ({{located}})' } },
  ] });
  assert.ok(problems.some(p => /UC-A-0001.*needs expect/.test(p)));
  assert.ok(problems.some(p => /UC-A-0002.*writes: true \| false/.test(p)));
  assert.ok(problems.some(p => /UC-A-0003.*no locate_sql/.test(p)));
});

/* ── second review ───────────────────────────────────────────────────────── */
test('models in one eval share one speed norm — a run in the pool is not counted twice', () => {
  const rec = (run, ms) => ({ run_id: run, tc_id: 'TC-1', use_case_id: 'UC-X-0001', attempt: 1, kind: 'question', outcome: 'correct',
    metrics: { calls: 2, acting_calls: 1, failed: 0, recoveries: 0, dead_ends: 0, repeated: 0, time_ms: ms, tokens: 5000, first_attempt: true } });
  const a = rec('A', 1000), b = rec('B', 9000);
  const pool = [a, b];                                     // what eval.mjs passes: every compared run, own included
  const sa = rescore([a], { pool }, {})[0], sb = rescore([b], { pool }, {})[0];
  assert.ok(sb.parts.speed < sa.parts.speed, `the 9-second run (${sb.parts.speed}) must score below the 1-second run (${sa.parts.speed})`);
});

test('contains is proven by a capped sample that holds every expected record', () => {
  const ref = { rows: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] };
  const capped = { rows: Array.from({ length: 50 }, (_, i) => ({ Id: i + 1 })), truncated: true };
  assert.equal(compare({ rule: 'contains', key: 'Id' }, capped, ref).result, 'correct');
  assert.equal(compare({ rule: 'contains', key: 'Id' }, { rows: [{ Id: 1 }, { Id: 9 }], truncated: true }, ref).result, 'wrong');
});

test('negated remarks are not read as support', () => {
  assert.equal(tableOps({ remarks: 'You can create and update tasks; you cannot delete them.' }), null);
  assert.equal(tableOps({ remarks: 'To Query. Insert, update and delete are not supported.' }), null);
  assert.equal(tableOps({ remarks: 'This view is read-only. To Query' }), null);
});

test('a cleanup WHERE with a range or negation is refused; dotted names resolve to the table', () => {
  for (const w of ["NOT [Id] = 'x'", "[Id] = 'x' OR [Id] IS NOT NULL", "[Id] = 'x' OR 1 = 1", "[Owner] IS NULL", "[Id] != 'x'", "[Id] >= '0'", "[Id] <= '9'", "[Id] <> 'x'", "[Id] NOT IN ('a')", "[Name] LIKE 'x%'", "[Id] > 0 AND [Name] = 'x'"])
    assert.ok(cleanupProblems(`DELETE FROM [Tasks] WHERE ${w}`, ['Tasks']).length, `accepted: ${w}`);
  assert.deepEqual(cleanupProblems("DELETE FROM Demo1.Demo.Tasks WHERE [Id] = 'x'", ['Tasks']), []);
  assert.deepEqual(cleanupProblems("UPDATE [Demo1].[Demo].[Tasks] SET [Completed] = false WHERE [Id] IN ('1','2')", ['Tasks']), []);
});

test('a write counts as fresh per record, not because a timestamp moved', () => {
  const check = { rule: 'write_visible', key: 'Id', expect: { Completed: true } };
  const before = [{ Id: 1, Completed: true, ModifiedAt: '09:00' }];
  const after = [{ Id: 1, Completed: true, ModifiedAt: '10:00' }];
  assert.equal(compare(check, {}, { rows: after, before_rows: before }).result, 'wrong', 'it was already complete');
  assert.equal(compare(check, {}, { rows: [...after, { Id: 2, Completed: true, ModifiedAt: '10:00' }], before_rows: before }).result, 'correct');
});

test('a column with "count" inside a word is not a count', () => {
  assert.equal(compare({ rule: 'same_count' }, { stated_count: 1 }, { rows: [{ AccountId: 500 }] }).result, 'correct', 'one account, not 500 records');
  assert.equal(compare({ rule: 'same_count' }, { stated_count: 1 }, { rows: [{ Discount: 15 }] }).result, 'correct');
  for (const k of ['CountryCode', 'NumericValue', 'Totality', 'COUNTRY'])
    assert.equal(compare({ rule: 'same_count' }, { stated_count: 1 }, { rows: [{ [k]: 44 }] }).result, 'correct', `${k} is not a count`);
  for (const k of ['CountTasks', 'TotalHours', 'NumOpen', 'total_open'])
    assert.equal(compare({ rule: 'same_count' }, { stated_count: 44 }, { rows: [{ [k]: 44 }] }).result, 'correct', `${k} is a count`);
  for (const k of ['count', 'TaskCount', 'task_count', 'Total', 'num_tasks', 'record_cnt', 'COUNT_STAR'])
    assert.equal(compare({ rule: 'same_count' }, { stated_count: 7 }, { rows: [{ [k]: 7 }] }).result, 'correct', k);
});

test('the catalog hash ignores key order but not content', () => {
  const a = { use_cases: [{ id: 'UC-A-0001', request: 'Which tasks are overdue?', kind: 'question', check: { rule: 'judge' } }] };
  const b = { use_cases: [{ check: { rule: 'judge' }, kind: 'question', request: 'Which tasks are overdue?', id: 'UC-A-0001' }] };
  assert.equal(catalogHash(a), catalogHash(b));
  assert.notEqual(catalogHash(a), catalogHash({ use_cases: [{ ...a.use_cases[0], variants: ['Anything late?'] }] }));
});
