/* Eval validity (3.3). The Asana eval showed four ways a model comparison misleads: wrong answers
 * earned up to half the score; "first attempt" counted clean-but-wrong journeys (haiku 80% with 5 of
 * 104 right); every failure all models shared was called a connector gap; and a one-use-case margin
 * crowned a winner. These pin the fixes, plus the guards that keep the environment out of the result. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scoreJourney } from '../scripts/lib/scoring.mjs';
import { firstTry, causeOf, patternOf, evidenceOf } from '../scripts/lib/report-data.mjs';
import { pairedTest, agreementOf, discriminationOf, analyseEval, notAttempted } from '../scripts/lib/eval-analysis.mjs';
import { validateCatalog, sourceProblems, areaHash } from '../scripts/lib/catalog.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });
const code = (s, args) => { try { run(s, args); return 0; } catch (e) { return e.status; } };

const M = (o = {}) => ({ calls: 3, acting_calls: 2, failed: 0, recoveries: 0, dead_ends: 0, repeated: 0, gave_up: false, time_ms: 10000, tokens: 5000, ...o });

test('a wrong answer scores 0, a partial one at most half, and the grade follows the outcome', () => {
  const ctx = { shortest: 2, norm_ms: 10000, norm_tokens: 5000 };
  const wrong = scoreJourney({ metrics: M() }, 'wrong', ctx);
  assert.equal(wrong.score, 0, 'a fast, clean, wrong answer earns nothing');
  assert.equal(wrong.grade, 'red');
  const partial = scoreJourney({ metrics: M() }, 'partial', ctx);
  assert.ok(partial.score <= 50 && partial.score > 0);
  assert.equal(partial.grade, 'yellow');
  const right = scoreJourney({ metrics: M() }, 'correct', ctx);
  assert.equal(right.score, 100); assert.equal(right.grade, 'blue');
  const slowRight = scoreJourney({ metrics: M({ acting_calls: 8, dead_ends: 2 }) }, 'correct', ctx);
  assert.equal(slowRight.grade, 'yellow', 'right but rough: worked with friction, never red');
  assert.ok(slowRight.score > wrong.score, 'a slow right answer always beats a fast wrong one');
});

test('first-try success needs the answer to be right, not just a clean journey', () => {
  assert.equal(firstTry({ outcome: 'correct', metrics: { failed: 0 } }), true);
  assert.equal(firstTry({ outcome: 'wrong', metrics: { failed: 0 } }), false, 'clean but wrong is the most misleading failure');
  assert.equal(firstTry({ outcome: 'correct', metrics: { failed: 1 } }), false);
});

test('"not possible" is charged by evidence: account, source system or connector; clean-but-wrong is the AI', () => {
  const caps = new Map([['C1', 'product_only'], ['C2', 'not_exposed']]);
  assert.equal(causeOf({ outcome: 'not_possible', capabilities: ['C1'] }, caps), 'source');
  assert.equal(causeOf({ outcome: 'not_possible', capabilities: ['C2'] }, caps), 'connector');
  assert.equal(causeOf({ outcome: 'not_possible', capabilities: ['C2'], steps: [{ ok: false, cause: 'account' }] }, caps), 'account');
  assert.equal(causeOf({ outcome: 'wrong', steps: [{ ok: true }] }), 'ai');
});

test('the paired test calls a one-use-case margin a tie, and a large one a real difference', () => {
  const n = 60, base = Array.from({ length: n }, (_, i) => i % 2 === 0);
  const close = pairedTest(base, base.map((x, i) => i === 1 ? true : x));
  assert.ok(close.p > 0.05, 'one use case apart is not a difference');
  const far = pairedTest(base.map(() => true), base);
  assert.ok(far.p < 0.001);
  assert.equal(far.a_only, 30); assert.equal(far.b_only, 0);
  assert.ok(far.ci[0] > 0, 'the whole 95% range is above zero');
});

test('agreement and discrimination are measured from outcomes', () => {
  const c = (o, s = 80, pr = null) => ({ outcome: o, score: s, pass_rate: pr });
  const names = ['a', 'b', 'c'];
  assert.equal(agreementOf({ a: c('correct'), b: c('wrong', 0), c: c('wrong', 0) }, names).kind, 'unique_win');
  assert.equal(agreementOf({ a: c('correct'), b: c('correct'), c: c('wrong', 0) }, names).who, 'c');
  assert.equal(agreementOf({ a: c('wrong', 0), b: c('wrong', 0), c: c('partial', 30) }, names).kind, 'all_failed');
  assert.equal(agreementOf({ a: c('blocked'), b: c('blocked'), c: c('blocked') }, names).kind, 'connector_blocked');
  assert.equal(agreementOf({ a: c('correct'), b: c('no_test_data'), c: c('correct') }, names).kind, 'not_measured');
  assert.equal(discriminationOf({ a: c('correct'), b: c('wrong', 0), c: c('correct') }, names), 'high');
  assert.equal(discriminationOf({ a: c('correct', 95), b: c('correct', 50), c: c('correct', 90) }, names), 'medium');
  assert.equal(discriminationOf({ a: c('correct', 90), b: c('correct', 88), c: c('correct', 92, 0.5) }, names), 'medium', 'right on one attempt, wrong on another');
  assert.equal(discriminationOf({ a: c('wrong', 0), b: c('wrong', 0), c: c('wrong', 0) }, names), 'low');
});

/* three models over the same use cases; U3 needs a capability the connector does not expose */
function fixture() {
  const uc = (id, outcome, o = {}) => ({ id, request: `request ${id}`, area: 'Tasks', persona: 'Team Lead', kind: 'question', difficulty: 'medium',
    tests: ['filters'], pattern: 'filter', outcome, result: outcome, score: outcome === 'correct' ? 90 : 0, grade: outcome === 'correct' ? 'blue' : 'red',
    metrics: M(), steps: [{ tool: 'queryData', ok: true, category: 'query' }], cause: outcome === 'wrong' ? 'ai' : null, ...o });
  const blocked = id => uc(id, 'not_possible', { steps: [], metrics: null, score: null, cause: 'connector' });
  const ids = Array.from({ length: 12 }, (_, i) => `U${i + 1}`);
  const make = okSet => ({ use_cases: ids.map(id => id === 'U3' ? blocked(id) : uc(id, okSet.has(id) ? 'correct' : 'wrong')) });
  return [
    { model: 'opus', data: make(new Set(['U1', 'U2', 'U4', 'U5', 'U6', 'U7', 'U8'])) },
    { model: 'sonnet', data: make(new Set(['U1', 'U2', 'U4', 'U5', 'U6', 'U7', 'U9'])) },
    { model: 'haiku', data: make(new Set(['U1'])) },
  ];
}

test('a use case no model was asked leaves the comparison and is reported as the connector\'s', () => {
  const models = fixture();
  assert.ok(notAttempted(models[0].data.use_cases.find(u => u.id === 'U3')));
  const A = analyseEval(models);
  const opus = A.stats.find(s => s.model === 'opus');
  assert.equal(opus.n, 11, 'counted over the use cases the model was asked');
  assert.equal(opus.blocked, 1);
  assert.equal(A.agreement.connector_blocked, 1);
  assert.ok(A.separation.connector.items.some(i => i.id === 'U3'));
  assert.ok(!A.separation.connector.items.some(i => i.id === 'U10'), 'every model wrong through its own mistakes is not a connector gap');
  assert.ok(A.separation.unclear.items.some(i => i.id === 'U10'));
});

test('the summary refuses to crown a winner on a tie, and every model gets a profile from its numbers', () => {
  const A = analyseEval(fixture());
  const best = A.executive.qa.find(q => q.q === 'Which model performed best?');
  assert.equal(A.executive.decisive, false, 'opus and sonnet are one use case apart');
  assert.equal(best.confidence, 'close');
  assert.match(A.pairs.find(p => p.a === 'opus' && p.b === 'sonnet').verdict, /are level|cannot be told apart/);
  assert.deepEqual(A.unique.opus.wins.map(w => w.id), ['U8'], 'only opus got U8 right');
  assert.deepEqual(A.unique.sonnet.wins.map(w => w.id), ['U9']);
  assert.deepEqual(A.unique.haiku.failures.map(w => w.id), ['U2', 'U4', 'U5', 'U6', 'U7'], 'the use cases only haiku got wrong');
  const haiku = A.profiles.find(p => p.model === 'haiku');
  assert.match(haiku.headline, /correct/);
  assert.ok(haiku.failures.some(f => /every call worked/.test(f)), 'clean-but-wrong is named as a failure pattern');
});

test('the dominant pattern and evidence strength come from tags and source kinds', () => {
  assert.equal(patternOf({ tests: ['write', 'multi_step'] }), 'read_decide_act');
  assert.equal(patternOf({ tests: ['limitation', 'write'] }), 'limitation');
  assert.equal(patternOf({ tests: ['ambiguity'] }), 'clarify');
  assert.equal(patternOf({ tests: [] }), 'retrieve');
  assert.equal(evidenceOf({ kind: 'community' }), 'community');
  assert.equal(evidenceOf({ kind: 'help_center' }), 'vendor');
  assert.equal(evidenceOf({ kind: 'inferred' }), 'inferred');
});

test('an inferred use case is allowed for any request, but only for a workflow shown to be really used', () => {
  const base = { id: 'UC-X-0001', area: 'TM', persona: 'Team Lead', goal: 'plan', kind: 'question', capabilities: ['C'], request: 'How is the launch going for us?',
    check: { rule: 'judge' }, difficulty: 'simple', status: 'draft' };
  const url = 'https://help.example.com/project-status-updates';
  const ok = { ...base, tests: ['ambiguity'], source: { kind: 'inferred', title: 'weekly project status check-ins', url,
    reason: 'people refer to a project by a nickname all the time', verified: { status: 'found', url } } };
  assert.deepEqual(validateCatalog({ use_cases: [ok] }).problems, []);
  assert.deepEqual(sourceProblems(ok), []);
  assert.match(sourceProblems({ ...ok, source: { ...ok.source, url: undefined, verified: undefined } })[0], /showing the workflow is really used/, 'no evidence of real use, no use case');
  assert.match(sourceProblems({ ...ok, source: { ...ok.source, verified: undefined } })[0], /not checked yet/, 'the workflow evidence is checked like any other source');
  assert.deepEqual(validateCatalog({ use_cases: [{ ...ok, tests: ['filters'] }] }).problems, [], 'not every real request is written down publicly');
  assert.ok(sourceProblems({ ...ok, source: { kind: 'inferred', title: 't', reason: 'because' } }).length, 'a reason of a word is not a reason');
});

test('preflight-data holds read tests whose reference finds nothing, and releases them', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-pd-')), 'Demo');
  mkdirSync(join(dir, '_agent_out'), { recursive: true });
  const plan = { tc_list: [
    { id: 'TC-001', suite: 'business', kind: 'question', use_case_id: 'U1', check: { rule: 'same_ids', reference_sql: "SELECT [Id] FROM [Tasks] WHERE [Assignee] = '{{me}}' AND [DueOn] < '{{today}}'" } },
    { id: 'TC-002', suite: 'business', kind: 'question', use_case_id: 'U2', check: { rule: 'same_ids', reference_sql: 'SELECT [Id] FROM [Attachments]' } },
    { id: 'TC-003', suite: 'business', kind: 'action', use_case_id: 'U3', check: { rule: 'write_visible', reference_sql: 'SELECT 1' } },
  ] };
  writeFileSync(join(dir, 'Demo_plan.json'), JSON.stringify(plan));
  assert.equal(code('preflight-data.mjs', ['prep', '--dir', dir]), 2, '--me is required');
  run('preflight-data.mjs', ['prep', '--dir', dir, '--me', '42', '--today', '2026-10-04']);
  const inp = JSON.parse(readFileSync(join(dir, '_agent_out', 'data-check-input.json'), 'utf8'));
  assert.deepEqual(inp.items.map(i => i.tc), ['TC-001', 'TC-002'], 'actions are not data-checked');
  assert.match(inp.items[0].sql, /'42'.*'2026-10-04'/, 'placeholders filled');
  writeFileSync(join(dir, 'checks.json'), JSON.stringify({ checks: [{ tc: 'TC-001', rows: 3 }, { tc: 'TC-002', rows: 0 }] }));
  assert.match(run('preflight-data.mjs', ['merge', '--dir', dir, '--checks', join(dir, 'checks.json')]), /1 held/);
  let p = JSON.parse(readFileSync(join(dir, 'Demo_plan.json'), 'utf8'));
  assert.equal(p.tc_list[1].executable, false); assert.equal(p.tc_list[1].data_hold, true); assert.match(p.tc_list[1].nt_reason, /No test data/);
  assert.notEqual(p.tc_list[0].executable, false);
  run('preflight-data.mjs', ['release', '--dir', dir, '--tcs', 'TC-002']);
  p = JSON.parse(readFileSync(join(dir, 'Demo_plan.json'), 'utf8'));
  assert.equal(p.tc_list[1].executable, true); assert.equal(p.tc_list[1].data_hold, undefined);
});

test('check-harness lists the connector tools the permissions do not allow, and never edits them', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-h-'));
  const home = join(root, 'home'), proj = join(root, 'proj');
  mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(proj, '.claude'), { recursive: true });
  const local = JSON.stringify({ permissions: { allow: ['mcp__abc__execute_update'] } });
  writeFileSync(join(proj, '.claude', 'settings.local.json'), local);
  const out = run('check-harness.mjs', ['--server', 'abc', '--home', home, '--project', proj]);
  assert.match(out, /11 of 12 connector tool\(s\) are not on the allow list/);
  assert.match(out, /queryData/);
  assert.equal(code('check-harness.mjs', ['--server', 'abc', '--home', home, '--project', proj, '--strict']), 3);
  assert.equal(readFileSync(join(proj, '.claude', 'settings.local.json'), 'utf8'), local, 'settings are the user\'s to change');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__abc'] } }));
  assert.match(run('check-harness.mjs', ['--server', 'abc', '--home', home, '--project', proj]), /every connector tool is allowed/);
});

test('tagging a frozen area keeps it frozen', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-tag-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  const cat = { connector: 'Demo', prefix: 'DMO', use_cases: [{ id: 'UC-DMO-0001', area: 'TM', persona: 'Team Lead', goal: 'g', kind: 'question', request: 'Which tasks are overdue for my team?',
    capabilities: ['C'], check: { rule: 'judge' }, status: 'approved', source: { kind: 'community', title: 't', url: 'https://x' } }], areas: {} };
  cat.areas.TM = { version: 1, frozen: true, hash: areaHash(cat, 'TM') };
  writeFileSync(join(dir, 'Demo_catalog.json'), JSON.stringify(cat));
  writeFileSync(join(dir, 'Demo_knowledge.json'), JSON.stringify({ objects: [] }));
  writeFileSync(join(dir, 'tags.json'), JSON.stringify({ model: 'opus', tags: [{ id: 'UC-DMO-0001', difficulty: 'medium', tests: ['filters', 'dates'] }] }));
  assert.match(run('manage-catalog.mjs', ['tag', '--dir', dir, '--from', join(dir, 'tags.json')]), /freeze states unchanged/);
  const after = JSON.parse(readFileSync(join(dir, 'Demo_catalog.json'), 'utf8'));
  assert.equal(after.use_cases[0].difficulty, 'medium');
  assert.equal(after.areas.TM.hash, areaHash(after, 'TM'), 'still frozen on the same hash');
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ tags: [{ id: 'UC-DMO-0001', difficulty: 'hard', tests: [] }] }));
  assert.equal(code('manage-catalog.mjs', ['tag', '--dir', dir, '--from', join(dir, 'bad.json')]), 3);
});
