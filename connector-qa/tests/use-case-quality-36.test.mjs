/* 3.6 — from a read-only review of how use cases are made (Fable, on the Asana TR run and the archived
 * three-model eval asn-eval1): checks that cannot decide the request, honest connector refusals
 * marked wrong, "not possible" requests never put to an agent, and an account whose missing
 * features were found only after research. Everything here is generic: no source names in code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isYesNo, refineOutcome } from '../scripts/lib/checks.mjs';
import { validateCatalog, referenceNarrows } from '../scripts/lib/catalog.mjs';
import { adviseRequest } from '../scripts/lib/realism.mjs';
import { accountReadiness } from '../scripts/lib/capabilities.mjs';
import { verdictOf } from '../scripts/lib/report-data.mjs';
import { analyseEval, notAttempted } from '../scripts/lib/eval-analysis.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (script, args) => execFileSync(process.execPath, [join(SK, 'scripts', script), ...args], { encoding: 'utf8' });

test('yes/no questions are recognised', () => {
  assert.equal(isYesNo('Is the SSO setup fix still flagged as blocked?'), true);
  assert.equal(isYesNo('Has anyone liked my comment on the banner task?'), true);
  assert.equal(isYesNo('Which projects are at risk?'), false);
  assert.equal(isYesNo('Show my overdue tasks', ['answers yes or no, then lists them']), true);
});

test('an honest connector refusal is the connector\'s, a hidden one stays wrong', () => {
  const refused = { tool: 'execute_update', category: 'write', ok: false, cause: 'connector', error_class: 'unsupported_operation', recovered: false,
    error: "STMT STMT Unable to perform 'UPDATE' operation on 'Teams' table." };
  const r = { outcome: 'wrong', detail: 'the re-read does not show the change' };
  const uc = { kind: 'action', check: { rule: 'write_visible' } };
  assert.equal(refineOutcome(r, { steps: [refused], answer: 'I could not update it: the connector does not allow changing teams.' }, uc).outcome, 'blocked_connector');
  assert.equal(refineOutcome(r, { steps: [refused], answer: 'Done, the description is updated.' }, uc).outcome, 'wrong');
  /* a timeout is not a refusal: the agent could have narrowed the read */
  const slow = { ...refused, error_class: 'timeout', error: 'timed out' };
  assert.equal(refineOutcome(r, { steps: [slow], answer: 'I could not read it.' }, uc).outcome, 'wrong');
  assert.equal(verdictOf({ outcome: 'blocked_connector', steps: [] }), 'blocked_connector');
});

test('the catalog flags checks that cannot decide the request', () => {
  const base = { area: 'TM', persona: 'Lead', goal: 'g', kind: 'question', capabilities: [], source: { kind: 'community', title: 't', url: 'https://x' },
    difficulty: 'simple', tests: ['filters'], expected_behavior: ['answers'] };
  const yn = { ...base, id: 'UC-1', request: 'Is the SSO fix still flagged as blocked?', check: { rule: 'contains', key: 'Id', reference_sql: "SELECT [Id] FROM [Tags] WHERE [TaskId] = '1'" } };
  const narrow = { ...base, id: 'UC-2', request: 'Which of our projects are flagged at risk?',
    check: { rule: 'same_ids', key: 'Id', reference_sql: "SELECT [Id] FROM [Projects] WHERE [Name] IN ('Website Relaunch','Mobile Launch')" } };
  const draft = validateCatalog({ use_cases: [{ ...yn, status: 'draft' }, { ...narrow, status: 'draft' }] });
  assert.ok(draft.problems.some(p => /UC-1: a yes\/no question checked by contains/.test(p)));
  assert.ok(draft.problems.some(p => /UC-2: the reference limits itself to "Website Relaunch", "Mobile Launch"/.test(p)));
  const approved = validateCatalog({ use_cases: [{ ...yn, status: 'approved' }] });
  assert.ok(approved.warnings.some(w => /UC-1: a yes\/no question/.test(w)), 'a frozen area is warned, never reopened');
  assert.ok(!approved.problems.some(p => /yes\/no/.test(p)));
  assert.deepEqual(referenceNarrows("SELECT [Id] FROM [Tasks] WHERE [ProjectName] = 'Website Relaunch'", 'Which Website Relaunch tasks are overdue?'), []);
  assert.deepEqual(referenceNarrows("SELECT x FROM T WHERE [ProjectId] IN ('1219079947972803','1219079817085423')", 'open tasks across our projects'), ['2 records by id']);
});

test('wording advice warns, never refuses', () => {
  assert.equal(adviseRequest('Add a Client meetings category, rename Design to UX and delete Misc.').length, 1);
  assert.equal(adviseRequest('Pull every time entry for our billing export.').length, 1);
  assert.deepEqual(adviseRequest('Move my two lowest-priority tasks to Priya.'), []);
});

test('the account probe shows, per area, which tables hold data', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-acct-')), 'Demo');
  mkdirSync(join(dir, '_agent_out'), { recursive: true });
  const caps = { areas: [{ id: 'TR', name: 'Time', capability_ids: ['C1', 'C2'] }, { id: 'TM', name: 'Tasks', capability_ids: ['C3'] }],
    capabilities: [{ id: 'C1', mapping: { exposure: [{ kind: 'table', name: 'TimeEntries' }] } }, { id: 'C2', mapping: { exposure: [{ kind: 'table', name: 'Allocations' }] } },
      { id: 'C3', mapping: { exposure: [{ kind: 'table', name: 'Tasks' }] } }] };
  writeFileSync(join(dir, 'Demo_capabilities.json'), JSON.stringify(caps));
  writeFileSync(join(dir, 'Demo_knowledge.json'), JSON.stringify({ connector: 'Demo', run_meta: { catalog: 'Demo1', schema: 'Demo' } }));
  node('account-probe.mjs', ['prep', '--dir', dir]);
  const items = JSON.parse(readFileSync(join(dir, '_agent_out', 'account-probe-input.json'), 'utf8')).items;
  assert.deepEqual(items.map(i => i.sql), ['SELECT * FROM [Demo1].[Demo].[Allocations] LIMIT 1', 'SELECT * FROM [Demo1].[Demo].[Tasks] LIMIT 1', 'SELECT * FROM [Demo1].[Demo].[TimeEntries] LIMIT 1']);
  writeFileSync(join(dir, 'probes.json'), JSON.stringify({ probes: [{ table: 'TimeEntries', rows: 0 },
    { table: 'Allocations', rows: 0, error: 'HTTP [40002] Allocations are not available on your current plan or add-ons.' }, { table: 'Tasks', rows: 1 }] }));
  const out = node('account-probe.mjs', ['merge', '--dir', dir, '--checks', join(dir, 'probes.json')]);
  assert.match(out, /⚠ Time: 0 of 2 table\(s\) hold data · 1 empty · 1 refused by the account/);
  assert.match(out, /✓ Tasks: 1 of 1/);
  const acct = JSON.parse(readFileSync(join(dir, 'Demo_account.json'), 'utf8'));
  assert.equal(acct.tables.Allocations.status, 'refused');
  assert.equal(accountReadiness(caps, acct)[0].share, 0);
});

test('the answer judge gets judged, yes/no and probe attempts, with the rows beside them', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-judge-')), 'Demo');
  const out = join(dir, '_agent_out', 'r1');
  mkdirSync(out, { recursive: true });
  const W = (f, o) => writeFileSync(join(out, f), JSON.stringify(o));
  writeFileSync(join(dir, 'Demo_knowledge.json'), JSON.stringify({ connector: 'Demo', run_meta: { run_id: 'r1' } }));
  const t = (id, uc, extra) => ({ id, use_case_id: uc, suite: 'business', kind: 'question', attempts: 1, executable: true, expected_behavior: ['answers'], ...extra });
  writeFileSync(join(dir, 'Demo_plan.json'), JSON.stringify({ tc_list: [
    t('TC-1', 'UC-1', { prompt: 'Who is over-allocated next month?', check: { rule: 'judge' } }),
    t('TC-2', 'UC-2', { prompt: 'Is the SSO fix still blocked?', check: { rule: 'contains', key: 'Id', reference_sql: 'ref' } }),
    t('TC-3', 'UC-3', { prompt: 'Set a budget on the launch project.', probe: 'limitation', not_possible_reason: 'Not possible through the connector: budgets.', check: { rule: 'judge' } }),
    t('TC-4', 'UC-4', { prompt: 'Which tasks are overdue?', check: { rule: 'same_ids', key: 'Id', reference_sql: 'ref' } }),
  ] }));
  const journey = (answer, rows = []) => ({ calls: [{ tool: 'queryData', input: { query: 'SELECT 1' }, result: 'ok', rows: rows.length }], final_rows: rows, answer });
  W('stage9-TC-1-a1.json', journey('Nobody.')); W('check-TC-1-a1.json', { data_rows: [] });
  W('stage9-TC-2-a1.json', journey('Yes, still tagged Blocked.', [{ Id: 'task-1' }])); W('check-TC-2-a1.json', { sql: 'ref', rows: [{ Id: 'tag-9' }] });
  W('stage9-TC-3-a1.json', journey('Budgets are not available through this connection.'));
  W('stage9-TC-4-a1.json', journey('Two.', [{ Id: 'a' }, { Id: 'b' }])); W('check-TC-4-a1.json', { sql: 'ref', rows: [{ Id: 'a' }, { Id: 'b' }] });
  const msg = node('answer-judge.mjs', ['prep', '--dir', dir, '--run', 'r1', '--facts', 'one user, no allocations']);
  assert.match(msg, /3 attempt\(s\) to judge/);
  const J = JSON.parse(readFileSync(join(out, 'judge-input.json'), 'utf8'));
  assert.deepEqual(J.items.map(i => [i.tc, i.why]), [['TC-1', 'judge_rule'], ['TC-2', 'yes_no'], ['TC-3', 'limitation_probe']]);
  assert.deepEqual(J.items[0].data_rows, []);
  assert.equal(J.items[0].account_facts, 'one user, no allocations');
  assert.match(J.items[2].not_possible, /budgets/);
  writeFileSync(join(dir, 'j.json'), JSON.stringify({ judgements: [{ tc: 'TC-2', attempt: 1, outcome: 'correct', reason: 'Right.' }] }));
  node('answer-judge.mjs', ['merge', '--dir', dir, '--run', 'r1', '--file', join(dir, 'j.json')]);
  assert.ok(existsSync(join(out, 'judge-TC-2-a1.json')));
  assert.match(node('answer-judge.mjs', ['prep', '--dir', dir, '--run', 'r1', '--out', join(dir, 'again.json')]), /2 attempt\(s\) to judge/, 'judged attempts are skipped');
});

test('the eval keeps probes out of task success and lists every-model failures as check suspects', () => {
  const uc = (id, model, o) => ({ id, request: `request ${id}`, area: 'TM', persona: 'Lead', kind: 'question', steps: [{ ok: true }], metrics: { calls: 2 }, check: { rule: 'contains', detail: `${model} detail` }, ...o });
  const data = m => ({ use_cases: [
    uc('UC-1', m, { outcome: 'wrong', result: 'Wrong' }),
    uc('UC-2', m, { outcome: 'not_possible', probe: { outcome: m === 'a' ? 'correct' : 'wrong' } }),
    uc('UC-3', m, { outcome: 'correct', result: 'Right' }),
  ] });
  assert.equal(notAttempted({ outcome: 'not_possible', steps: [{ ok: true }], probe: { outcome: 'correct' } }), true);
  const A = analyseEval([{ model: 'a', data: data('a') }, { model: 'b', data: data('b') }]);
  assert.deepEqual(A.check_suspects.map(c => c.id), ['UC-1']);
  assert.deepEqual(A.check_suspects[0].details.map(d => d.detail), ['a detail', 'b detail']);
  const S = Object.fromEntries(A.stats.map(s => [s.model, s]));
  assert.equal(S.a.n, 2, 'the probe is not a task the model was asked');
  assert.deepEqual([S.a.limitation.correct, S.a.limitation.n, S.b.limitation.wrong], [1, 1, 1]);
});
