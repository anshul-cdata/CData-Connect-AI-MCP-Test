/* Set-level catalog checks (3.2): every use case says how hard it is and what it asks of the AI;
 * each area reaches the mix floors (or explains why not), serves each persona with its own work,
 * and is read as a whole by a coverage reviewer whose every finding is answered before freeze. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, areaMix, personaBalance, coverageReviewState, answerProblems, areaSetHash, MIX_DEFAULTS } from '../scripts/lib/catalog.mjs';
import { scoreJourney } from '../scripts/lib/scoring.mjs';

const SRC = { kind: 'community', title: 'Forum', url: 'https://forum.example.com/t/1' };
const uc = (id, o = {}) => ({ id, area: 'TM', persona: 'Team Lead', goal: 'plan the week', kind: 'question', source: SRC,
  capabilities: ['CAP-a'], request: `Which tasks are slipping for request ${id}?`, check: { rule: 'judge' }, status: 'draft',
  difficulty: 'simple', tests: ['filters'], ...o });

test('a draft must say how hard it is and what it tests; an approved one keeps its freeze', () => {
  const v = validateCatalog({ use_cases: [uc('UC-X-0001', { difficulty: undefined, tests: undefined }), uc('UC-X-0002', { status: 'approved', difficulty: undefined, tests: undefined, request: 'Who on my team has the most overdue work?' })] });
  assert.ok(v.problems.some(p => /UC-X-0001: no difficulty/.test(p)));
  assert.ok(v.problems.some(p => /UC-X-0001: no tests/.test(p)));
  assert.ok(!v.problems.some(p => p.startsWith('UC-X-0002')), 'approved before the tags existed: not a problem');
  assert.ok(v.warnings.some(w => /1 approved use case\(s\) have no difficulty/.test(w)));
});

test('tags are checked: known values, write matches the kind, ambiguity is judged', () => {
  const v = validateCatalog({ use_cases: [
    uc('UC-X-0001', { difficulty: 'hard', tests: ['vibes'] }),
    uc('UC-X-0002', { kind: 'action', writes: true, tests: ['filters'], request: 'Move the review to next week please', check: { rule: 'write_visible', reference_sql: 'SELECT 1', expect: { A: 1 } } }),
    uc('UC-X-0003', { tests: ['ambiguity'], request: 'How is the launch going for us?', check: { rule: 'same_ids', key: 'Id', reference_sql: 'SELECT 1' } }),
  ] });
  assert.ok(v.problems.some(p => /UC-X-0001: difficulty must be/.test(p)));
  assert.ok(v.problems.some(p => /UC-X-0001: tests has vibes/.test(p)));
  assert.ok(v.warnings.some(w => /UC-X-0002: changes data but tests does not list write/.test(w)));
  assert.ok(v.problems.some(p => /UC-X-0003: an ambiguity or missing_info use case is decided by the judge/.test(p)));
});

test('the mix counts each kind of request against its floor; an explained kind is not missing', () => {
  const cat = { use_cases: [
    uc('UC-X-0001', { difficulty: 'simple', tests: ['filters', 'dates'] }),
    uc('UC-X-0002', { difficulty: 'complex', tests: ['relationships', 'multi_step', 'aggregation'] }),
  ], mix_explained: [{ area: 'TM', need: 'limitation', reason: 'every task action is exposed by the connector' }, { area: 'TM', need: 'ambiguity', reason: 'no' }] };
  const m = areaMix(cat, 'TM');
  assert.equal(m.counts.dates, 1);
  assert.equal(m.counts.complex, 1);
  const need = m.missing.map(x => x.need);
  assert.ok(need.includes('complex') && need.includes('dates') && need.includes('ambiguity'), 'a one-word reason does not count');
  assert.ok(!need.includes('limitation'));
  assert.deepEqual(m.explained.map(x => x.need), ['limitation']);
  assert.equal(m.floors.complex, MIX_DEFAULTS.complex);
  assert.equal(areaMix(cat, 'TM', { complex: 1 }).missing.some(x => x.need === 'complex'), false, 'catalog.mix overrides a floor');
});

test('persona balance: thin personas, one persona holding most of the area, questions copied across roles', () => {
  const caps = { areas: [{ id: 'TM', personas: ['Team Lead', 'Executive Sponsor', 'Analyst'] }] };
  const cat = { use_cases: [
    ...[1, 2, 3, 4, 5].map(i => uc(`UC-X-000${i}`, { request: `Team lead request number ${i} about sprint workload` })),
    uc('UC-X-0006', { persona: 'Executive Sponsor', request: 'Team lead request number 1 about sprint workload' }),
    uc('UC-X-0007', { persona: 'Analyst', request: 'How many tasks closed per week this quarter?' }),
  ], mix_explained: [{ area: 'TM', need: 'persona:Analyst', reason: 'analysts mostly report from portfolios instead' }] };
  const pb = personaBalance(cat, caps, 'TM');
  assert.deepEqual(pb.thin.map(p => p.persona), ['Executive Sponsor']);
  assert.equal(pb.dominant.persona, 'Team Lead');
  assert.ok(pb.overlaps.some(o => o.ids.includes('UC-X-0006')), 'the sponsor was given the team lead\'s question');
});

test('the coverage review must be answered, and stands until the set of use cases changes', () => {
  const cat = { use_cases: [uc('UC-X-0001'), uc('UC-X-0002', { request: 'Who has the most overdue work right now?' })], areas: {} };
  assert.match(coverageReviewState(cat, 'TM').reason, /no coverage review yet/);
  cat.areas.TM = { coverage_review: { set_hash: areaSetHash(cat, 'TM'), findings: [
    { n: 'F1', type: 'missing_ambiguity', what: 'a vague status question' }, { n: 'F2', type: 'redundant', what: 'same scenario', ids: ['UC-X-0002'] }], answers: {} } };
  assert.match(coverageReviewState(cat, 'TM').reason, /2 coverage-review finding\(s\) not answered/);
  /* answers are checked against the catalog */
  assert.match(answerProblems(cat, 'TM', [{ finding: 'F2', action: 'retired', ids: ['UC-X-0002'] }])[0], /is not retired/);
  assert.match(answerProblems(cat, 'TM', [{ finding: 'F1', action: 'kept', reason: 'no' }])[0], /kept needs a reason/);
  assert.match(answerProblems(cat, 'TM', [{ finding: 'F9', action: 'kept', reason: 'a good long reason' }])[0], /no such finding/);
  cat.use_cases[1].status = 'retired';
  cat.use_cases.push(uc('UC-X-0003', { tests: ['ambiguity'], request: 'How is the launch going?' }));
  const answers = [{ finding: 'F1', action: 'added', ids: ['UC-X-0003'] }, { finding: 'F2', action: 'retired', ids: ['UC-X-0002'] }];
  assert.deepEqual(answerProblems(cat, 'TM', answers), []);
  const rv = cat.areas.TM.coverage_review;
  for (const x of answers) rv.answers[x.finding] = x;
  rv.set_after = areaSetHash(cat, 'TM');
  assert.equal(coverageReviewState(cat, 'TM').ok, true);
  cat.use_cases[0].request = 'Which of my tasks are slipping this week?';
  assert.equal(coverageReviewState(cat, 'TM').ok, true, 'rewording (the realism judge) does not void the review');
  cat.use_cases.push(uc('UC-X-0004', { request: 'Which projects have no owner?' }));
  assert.match(coverageReviewState(cat, 'TM').reason, /added or retired since/);
});

test('a correct answer that needed no query — asking, or saying it cannot be done — is not marked inefficient', () => {
  const m = { calls: 2, acting_calls: 0, dead_ends: 0, recoveries: 0, repeated: 0, gave_up: false };
  assert.equal(scoreJourney({ metrics: m }, 'correct').parts.efficiency, 20);
  assert.equal(scoreJourney({ metrics: m }, 'wrong').parts.efficiency, 0);
});
