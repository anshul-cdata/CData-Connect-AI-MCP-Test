/* 3.7 — a scripted second turn: an unclear request gets the user's fixed reply if the agent asks, and
 * the finished job decides the result. Before, "log two hours for the review" only measured the asking. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { asksUser } from '../scripts/lib/checks.mjs';
import { validateCatalog, ucHash } from '../scripts/lib/catalog.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (script, args) => execFileSync(process.execPath, [join(SK, 'scripts', script), ...args], { encoding: 'utf8' });

test('a follow-up is validated and is part of the use case hash', () => {
  const base = { id: 'UC-1', area: 'TR', kind: 'action', status: 'draft', persona: 'Me', goal: 'log time', capabilities: [], difficulty: 'simple',
    tests: ['missing_info', 'write'], source: { kind: 'community', title: 't', url: 'https://x' }, expected_behavior: ['asks which review'],
    request: 'Log two hours for the review I did this morning.', check: { rule: 'judge' } };
  const fu = { ...base, follow_up: { reply: 'The Q3 budget review task.', check: { rule: 'write_visible', expect: { DurationMinutes: 120 }, reference_sql: 'SELECT 1' } } };
  assert.notEqual(ucHash(fu), ucHash(base));
  assert.ok(!validateCatalog({ use_cases: [fu] }).problems.some(p => /follow_up/.test(p)));
  const bad = validateCatalog({ use_cases: [{ ...base, tests: ['write'], follow_up: { reply: 'Q3', check: { rule: 'write_visible' } } }] });
  assert.ok(bad.problems.some(p => /follow_up.reply must be/.test(p)));
  assert.ok(bad.problems.some(p => /write_visible follow_up check needs expect/.test(p)));
  assert.ok(bad.warnings.some(w => /not tagged ambiguity or missing_info/.test(w)));
  assert.equal(asksUser('Which review do you mean — the Q3 budget review or the design review?'), true);
  assert.equal(asksUser('Logged two hours on the Q3 budget review.'), false);
});

test('turn 1 asks, turn 2 finishes the job; both are stored and the finished job decides', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-clar-'));
  const dir = join(root, 'Demo'), out = join(dir, '_agent_out', 'r1');
  mkdirSync(out, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  const A = (f, o) => writeFileSync(join(out, f), JSON.stringify(o));
  W('Demo_knowledge.json', { connector: 'Demo', objects: [], run_meta: { run_id: 'r1' } });
  const tc = (id, uc, extra) => ({ id, use_case_id: uc, suite: 'business', kind: 'action', attempts: 1, executable: true, mutates: true, prompt: 'Log two hours for the review I did this morning.',
    check: { rule: 'judge' }, expected_behavior: ['asks which review'], follow_up: { reply: 'The Q3 budget review task.', expected_behavior: ['logs 120 minutes on it'],
      check: { rule: 'write_visible', key: 'Id', expect: { DurationMinutes: 120 }, reference_sql: 'ref' } }, ...extra });
  W('Demo_plan.json', { tc_list: [tc('TC-1', 'UC-1'), tc('TC-2', 'UC-2'), tc('TC-3', 'UC-3')] });
  const asks = { calls: [{ tool: 'queryData', input: { query: 'SELECT [Id],[Name] FROM [C].[S].[Tasks]' }, result: '3 rows', rows: 3 }], final_rows: [], answer: 'Which review do you mean — the Q3 budget review or the design review?', wall_ms: 1000, tokens: 2000 };
  const logs = { calls: [{ tool: 'execute_insert', input: { query: 'INSERT INTO [C].[S].[Entries] ([TaskId],[DurationMinutes]) VALUES (\'7\',120)' }, result: '1 row', rows: 1 }], final_rows: [], answer: 'Logged two hours on the Q3 budget review.', wall_ms: 1500, tokens: 2500 };
  /* TC-1: asked, then did it */
  A('stage9-TC-1-a1.json', asks); A('judge-TC-1-a1.json', { outcome: 'correct', reason: 'Asked which review.' });
  A('stage9-TC-1-a1-t2.json', logs); A('check-TC-1-a1-t2.json', { sql: 'ref', before_rows: [], rows: [{ Id: 'e1', DurationMinutes: 120 }] });
  /* TC-2: asked, turn 2 not run yet */
  A('stage9-TC-2-a1.json', asks); A('judge-TC-2-a1.json', { outcome: 'correct', reason: 'Asked.' });
  /* TC-3: guessed without asking — no second turn, its own result stands */
  A('stage9-TC-3-a1.json', logs); A('judge-TC-3-a1.json', { outcome: 'wrong', reason: 'Logged on a guessed task.' });
  node('ingest-results.mjs', ['--dir', dir, '--root', root, '--run', 'r1', '--model', 'sonnet']);
  const recs = readFileSync(join(root, '_results', 'Demo', 'r1', 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const r1 = recs.find(r => r.tc_id === 'TC-1'), r2 = recs.find(r => r.tc_id === 'TC-2'), r3 = recs.find(r => r.tc_id === 'TC-3');
  assert.equal(r1.outcome, 'correct');
  assert.equal(r1.clarify.outcome, 'correct', 'it asked the right thing');
  assert.equal(r1.clarify.reply, 'The Q3 budget review task.');
  assert.equal(r1.metrics.calls, 2, 'both turns count');
  assert.deepEqual(r1.steps.map(s => s.turn || 1), [1, 2]);
  assert.match(r1.check.detail, /after the user's reply/);
  assert.equal(r2.outcome, 'not_run', 'asked, but the reply was not sent yet');
  assert.equal(r3.outcome, 'wrong');
  assert.equal(r3.clarify, undefined);
  /* a judged second turn is listed for the judge, and its verdict lands in its own file */
  const T2 = JSON.parse(readFileSync(join(dir, 'Demo_plan.json'), 'utf8'));
  T2.tc_list[1].follow_up.check = { rule: 'judge' };
  W('Demo_plan.json', T2);
  A('stage9-TC-2-a1-t2.json', logs);
  node('answer-judge.mjs', ['prep', '--dir', dir, '--run', 'r1']);
  const J = JSON.parse(readFileSync(join(out, 'judge-input.json'), 'utf8'));
  const it = J.items.find(i => i.tc === 'TC-2' && i.turn === 2);
  assert.ok(it, 'turn 2 listed');
  assert.equal(it.user_reply, 'The Q3 budget review task.');
  writeFileSync(join(dir, 'j.json'), JSON.stringify({ judgements: [{ tc: 'TC-2', attempt: 1, turn: 2, outcome: 'correct', reason: 'Logged it.' }] }));
  node('answer-judge.mjs', ['merge', '--dir', dir, '--run', 'r1', '--file', join(dir, 'j.json')]);
  node('ingest-results.mjs', ['--dir', dir, '--root', root, '--run', 'r1', '--model', 'sonnet']);
  const again = readFileSync(join(root, '_results', 'Demo', 'r1', 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(again.find(r => r.tc_id === 'TC-2').outcome, 'correct');
});
