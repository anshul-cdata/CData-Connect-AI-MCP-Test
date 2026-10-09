/* 3.7 — a second judge. One model deciding every judged answer, and every realism score, is one
 * marker: it can be wrong or partial to itself. A second model judges the same items independently;
 * the first still decides, disagreement is reported, and the human sample looks there first. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sampleForReview } from '../scripts/lib/catalog.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (script, args) => execFileSync(process.execPath, [join(SK, 'scripts', script), ...args], { encoding: 'utf8' });

test('the second answer judge works on the same items, and its verdict sits beside the first', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-j2-'));
  const dir = join(root, 'Demo'), out = join(dir, '_agent_out', 'r1');
  mkdirSync(out, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  const A = (f, o) => writeFileSync(join(out, f), JSON.stringify(o));
  W('Demo_knowledge.json', { connector: 'Demo', objects: [], run_meta: { run_id: 'r1' } });
  const tc = id => ({ id, use_case_id: `UC-${id}`, suite: 'business', kind: 'question', attempts: 1, executable: true, prompt: 'Who is overloaded next month?', check: { rule: 'judge' }, expected_behavior: ['names them'] });
  W('Demo_plan.json', { tc_list: [tc('TC-1'), tc('TC-2')] });
  for (const t of ['TC-1', 'TC-2']) A(`stage9-${t}-a1.json`, { calls: [{ tool: 'queryData', input: { query: 'SELECT 1' }, result: 'ok', rows: 1 }], final_rows: [], answer: 'Priya.' });
  A('judge-TC-1-a1.json', { outcome: 'correct', reason: 'Right.' }); A('judge-TC-2-a1.json', { outcome: 'correct', reason: 'Right.' });
  assert.match(node('answer-judge.mjs', ['prep', '--dir', dir, '--run', 'r1', '--second']), /2 attempt\(s\) to judge/, 'judged by the first, not yet by the second');
  assert.ok(existsSync(join(out, 'judge-input-2.json')));
  writeFileSync(join(dir, 'j2.json'), JSON.stringify({ judgements: [{ tc: 'TC-1', attempt: 1, outcome: 'correct', reason: 'Agree.' }, { tc: 'TC-2', attempt: 1, outcome: 'wrong', reason: 'Priya is not overloaded.' }] }));
  node('answer-judge.mjs', ['merge', '--dir', dir, '--run', 'r1', '--second', '--file', join(dir, 'j2.json')]);
  assert.ok(existsSync(join(out, 'judge2-TC-2-a1.json')) && !JSON.parse(readFileSync(join(out, 'judge-TC-2-a1.json'), 'utf8')).judged_at, 'the first judge file is untouched');
  node('ingest-results.mjs', ['--dir', dir, '--root', root, '--run', 'r1', '--model', 'sonnet']);
  const recs = readFileSync(join(root, '_results', 'Demo', 'r1', 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const r2 = recs.find(r => r.tc_id === 'TC-2');
  assert.equal(r2.outcome, 'correct', 'the first judge decides');
  assert.deepEqual([r2.second_judge.outcome, r2.second_judge.agree], ['wrong', false]);
  assert.equal(recs.find(r => r.tc_id === 'TC-1').second_judge.agree, true);
});

test('where the two realism judges disagree, the human sample looks first', () => {
  const u = (id, a, b) => ({ id, area: 'TM', persona: 'P', request: `request ${id}`, status: 'approved', realism: { score: a }, ...(b ? { realism_second: { score: b, judged_request: `request ${id}` } } : {}) });
  const cat = { use_cases: [u('U1', 5, 5), u('U2', 5, 2), u('U3', 4, 4), u('U4', 4)] };
  assert.equal(sampleForReview(cat, 1)[0].id, 'U2');
});
