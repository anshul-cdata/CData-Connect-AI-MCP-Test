/* 3.5 — what a result means. Asana asn-tr1 (time tracking & resourcing on a plan without time
 * tracking): honest plan refusals were scored "wrong", updates of records that never existed were
 * "wrong", "nobody is over-allocated" over an empty account was "correct", rephrased variants counted
 * as extra use cases, and the headline added connector gaps and AI mistakes into one "failed". */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { classifyError } from '../scripts/lib/journey.mjs';
import { compare, refineOutcome, sideEffects } from '../scripts/lib/checks.mjs';
import { useCaseRows, verdictOf, causeOf } from '../scripts/lib/report-data.mjs';
import { changesExisting } from '../scripts/lib/capabilities.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Asana plan refusals are the account\'s', () => {
  for (const t of ['STMT HTTP [40002] Time tracking is not available on your current plan or add-ons.',
    'STMT HTTP [40002] Creating, updating, or deleting allocations requires resource management features to be enabled in an enterprise organization.'])
    assert.deepEqual(classifyError(t), { class: 'plan_limit', cause: 'account' });
  /* a required filter is still the instructions' */
  assert.equal(classifyError('Column Id or [OwnerId and WorkspaceId] is required to retrieve the results').cause, 'instructions');
});

const refusedWrite = { n: 5, tool: 'execute_insert', category: 'write', ok: false, cause: 'account', recovered: false,
  error: 'STMT HTTP [40002] Time tracking is not available on your current plan or add-ons.' };
const found = { n: 4, tool: 'queryData', category: 'query', ok: true };
const action = { kind: 'action', check: { rule: 'write_visible', key: 'Id', expect: { DurationMinutes: 45 } } };

test('an honest plan refusal is blocked by the account, a claimed success stays wrong', () => {
  const r = { outcome: 'wrong', detail: 'the re-read found no record carrying the change' };
  const honest = refineOutcome(r, { steps: [found, refusedWrite], answer: 'I could not log the 45 minutes: Asana rejected the entry.' }, action, { before_rows: [] });
  assert.equal(honest.outcome, 'blocked_account');
  assert.match(honest.detail, /plan or rights/);
  const lied = refineOutcome(r, { steps: [found, refusedWrite], answer: 'Done — 45 minutes logged on the task.' }, action, { before_rows: [] });
  assert.equal(lied.outcome, 'wrong');
  assert.match(lied.detail, /did not tell the user/);
  /* a read the plan refused, judged correct for saying so, has still not tested the capability */
  const judged = refineOutcome({ outcome: 'correct', detail: 'said so' }, { steps: [{ ...refusedWrite, tool: 'queryData', category: 'query' }], answer: 'Custom fields are not available on this plan.' },
    { kind: 'question', check: { rule: 'judge' } }, {});
  assert.equal(judged.outcome, 'blocked_account');
});

test('changing a record that never existed is no test data', () => {
  const upd = { ...action, check: { ...action.check, expect: { DurationMinutes: 60 } }, modifiesExisting: true };
  const r = { outcome: 'wrong', detail: 'the re-read found no record carrying the change' };
  const out = refineOutcome(r, { steps: [found], answer: 'The task has no time entries at all, so there is no 90-minute entry to correct. I made no changes.' }, upd, { before_rows: [] });
  assert.equal(out.outcome, 'no_test_data');
  /* a create needs no existing record: nothing to refine */
  assert.equal(refineOutcome(r, { steps: [found], answer: 'I could not log it.' }, action, { before_rows: [] }).outcome, 'wrong');
  /* data_sql decides when present, for judged actions too */
  const judgedAction = refineOutcome({ outcome: 'correct', detail: 'said none' }, { steps: [found], answer: 'There is no allocation to remove. I made no changes.' },
    { kind: 'action', check: { rule: 'judge' } }, { data_rows: [] });
  assert.equal(judgedAction.outcome, 'no_test_data');
});

test('a judged answer over no data is no test data — unless the use case is about the request', () => {
  const q = { kind: 'question', check: { rule: 'judge' }, tests: ['aggregation'] };
  const j = { steps: [found], answer: 'No. Nobody has any allocation, so nobody is over-allocated.' };
  assert.equal(refineOutcome({ outcome: 'correct', detail: 'ok' }, j, q, { data_rows: [] }).outcome, 'no_test_data');
  assert.equal(refineOutcome({ outcome: 'correct', detail: 'ok' }, j, q, { data_rows: [{ Id: 1 }] }).outcome, 'correct');
  assert.equal(refineOutcome({ outcome: 'wrong', detail: 'invented' }, j, q, { data_rows: [] }).outcome, 'wrong', 'inventing data over an empty account is a real failure');
  assert.equal(refineOutcome({ outcome: 'correct', detail: 'asked' }, j, { ...q, tests: ['ambiguity'] }, { data_rows: [] }).outcome, 'correct');
  assert.equal(refineOutcome({ outcome: 'correct', detail: 'ok' }, j, q, {}).outcome, 'correct', 'no data_sql, no data_rows: the judge decides');
});

test('a right change reported as a failure is partial', () => {
  const wrote = { n: 6, tool: 'execute_insert', category: 'write', ok: true };
  const r = { outcome: 'correct', detail: '1 record(s) now show DurationMinutes = 45' };
  assert.equal(refineOutcome(r, { steps: [wrote], answer: "I couldn't log the time — please try again." }, action, {}).outcome, 'partial');
  assert.equal(refineOutcome(r, { steps: [wrote], answer: 'Logged 45 minutes; there is no other entry today.' }, action, {}).outcome, 'correct');
  /* not being able to verify a change that was made is not saying it failed */
  assert.equal(refineOutcome(r, { steps: [wrote], answer: 'I archived the project; the update reported 1 row affected. I could not run a follow-up read to confirm it.' }, action, {}).outcome, 'correct');
});

test('the write check reports side effects', () => {
  const before = [{ Id: '1', DurationMinutes: 30 }, { Id: '2', DurationMinutes: 15 }];
  const ok = compare(action.check, {}, { rows: [...before, { Id: '3', DurationMinutes: 45 }], before_rows: before });
  assert.equal(ok.result, 'correct');
  assert.match(ok.detail, /nothing else changed/);
  const side = compare(action.check, {}, { rows: [{ Id: '1', DurationMinutes: 0 }, { Id: '3', DurationMinutes: 45 }], before_rows: before });
  assert.equal(side.result, 'partial');
  assert.deepEqual(side.side_effects, ['1 durationminutes changed', '2 removed']);
  /* volatile columns are not changes */
  assert.deepEqual(sideEffects([{ Id: 'a', Name: 'x', ModifiedAt: 1 }], [{ Id: 'a', Name: 'x', ModifiedAt: 2 }], 'Id'), []);
});

test('only-changing capabilities are told from creating ones', () => {
  const caps = new Map([['C-upd', { id: 'C-upd', method: 'PUT' }], ['C-get', { id: 'C-get', method: 'GET' }], ['C-new', { id: 'C-new', method: 'POST' }],
    ['C-del', { id: 'C-del', label: 'Delete a time entry' }]]);
  assert.equal(changesExisting(['C-get', 'C-upd'], caps), true);
  assert.equal(changesExisting(['C-del'], caps), true);
  assert.equal(changesExisting(['C-get', 'C-new'], caps), false);
  assert.equal(changesExisting(['C-upd', 'C-new'], caps), false);
  assert.equal(changesExisting(['C-get'], caps), false);
});

const rec = (o) => ({ suite: 'business', use_case_id: 'UC-1', tc_id: 'TC-1', variant: 0, attempt: 1, outcome: 'correct', score: 90, metrics: { calls: 3 }, ...o });

test('a rephrased variant is the same use case, with a wording-agreement signal', () => {
  const rows = useCaseRows([rec({}), rec({ tc_id: 'TC-4', variant: 1 }), rec({ use_case_id: 'UC-2', tc_id: 'TC-2' }), rec({ use_case_id: 'UC-2', tc_id: 'TC-5', variant: 1, outcome: 'wrong', score: 0 })]);
  assert.deepEqual(rows.map(r => r.id).sort(), ['UC-1', 'UC-2']);
  assert.equal(rows.find(r => r.id === 'UC-1').phrasings, 2);
  assert.equal(rows.find(r => r.id === 'UC-1').phrasings_agree, true);
  assert.equal(rows.find(r => r.id === 'UC-2').phrasings_agree, false);
  assert.deepEqual(rows.find(r => r.id === 'UC-2').attempts.map(a => a.variant), [0, 1]);
});

test('every use case gets one verdict, and only three measure the AI', () => {
  const st = new Map([['C-x', 'not_exposed'], ['C-app', 'product_only']]);
  const V = o => verdictOf({ capabilities: [], steps: [], ...o }, st);
  assert.equal(V({ outcome: 'correct' }), 'correct');
  assert.equal(V({ outcome: 'partial' }), 'partly');
  assert.equal(V({ outcome: 'wrong' }), 'incorrect');
  assert.equal(V({ outcome: 'not_possible', capabilities: ['C-x'] }), 'unsupported');
  assert.equal(V({ outcome: 'not_possible', capabilities: ['C-app'] }), 'not_applicable');
  assert.equal(V({ outcome: 'blocked_account' }), 'blocked_account');
  assert.equal(V({ outcome: 'no_test_data' }), 'blocked_data');
  assert.equal(V({ outcome: 'not_run' }), 'not_measured');
  /* a reviewer's owner correction is honoured */
  assert.equal(V({ outcome: 'wrong', review: { cause: 'account', reason: 'plan refusal' } }), 'blocked_account');
  assert.equal(causeOf({ outcome: 'wrong', steps: [], review: { cause: 'connector' } }), 'connector');
});

test('preflight checks judged questions and updates, and warns when an area cannot test the AI', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-ready-')), 'Demo');
  mkdirSync(join(dir, '_agent_out'), { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  W('Demo_knowledge.json', { connector: 'Demo' });
  W('Demo_capabilities.json', { capabilities: [{ id: 'C-get', method: 'GET' }, { id: 'C-upd', method: 'PUT' }] });
  const base = { suite: 'business', business_domain: 'TR', business_process: 'Time tracking', executable: true };
  W('Demo_plan.json', { tc_list: [
    { ...base, id: 'TC-1', use_case_id: 'UC-1', kind: 'question', check: { rule: 'judge', data_sql: 'SELECT [Id] FROM [Allocations]' } },
    { ...base, id: 'TC-2', use_case_id: 'UC-2', kind: 'action', capabilities: ['C-get', 'C-upd'], check: { rule: 'write_visible', reference_sql: 'SELECT [Id] FROM [Entries] WHERE [TaskId] = 1' } },
    { ...base, id: 'TC-3', use_case_id: 'UC-3', kind: 'question', check: { rule: 'same_ids', key: 'Id', reference_sql: 'SELECT [Id] FROM [Tasks]' } },
    { ...base, id: 'TC-4', use_case_id: 'UC-3', variant: 1, kind: 'question', check: { rule: 'same_ids', key: 'Id', reference_sql: 'SELECT [Id] FROM [Tasks]' } },
  ] });
  const run = (...x) => execFileSync(process.execPath, [join(SK, 'scripts', 'preflight-data.mjs'), ...x, '--dir', dir], { encoding: 'utf8' });
  run('prep', '--me', 'u1');
  const items = JSON.parse(readFileSync(join(dir, '_agent_out', 'data-check-input.json'), 'utf8')).items;
  assert.deepEqual(items.map(i => i.tc), ['TC-1', 'TC-2', 'TC-3', 'TC-4'], 'judged question by data_sql, update by its reference');
  W('checks.json', { checks: [{ tc: 'TC-1', rows: 0 }, { tc: 'TC-2', rows: 0 }, { tc: 'TC-3', rows: 4 }, { tc: 'TC-4', rows: 4 }] });
  const out = run('merge', '--checks', join(dir, 'checks.json'));
  assert.match(out, /AREA NOT READY Time tracking: 1 of 3 ready · 2 held for data/, 'variants count once');
  const plan = JSON.parse(readFileSync(join(dir, 'Demo_plan.json'), 'utf8'));
  assert.match(plan.tc_list.find(t => t.id === 'TC-2').nt_reason, /record this action changes does not exist/);
  assert.equal(plan.data_check.readiness[0].ready, 1);
});
