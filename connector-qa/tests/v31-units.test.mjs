/* 3.1 libraries, one rule at a time: batching, area names, per-use-case reuse, completeness,
 * source checking and the per-area human review. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { researchBatches, resolveAreas, latestResults, crossDue } from '../scripts/lib/scope.mjs';
import { areaCompleteness, areaHumanCheck, sourceProblems, ucHash, areaHash, areaFreezeState, wholeFrozen } from '../scripts/lib/catalog.mjs';
import { writeRun, fingerprint } from '../scripts/lib/results.mjs';

const cap = (id, status = 'exposed') => ({ id, label: id, mapping: { status } });
const capsDoc = (areas, n = 200) => ({ capabilities: Array.from({ length: n }, (_, i) => cap(`C${i}`)).concat([cap('NA', 'not_applicable')]), areas });

test('areas are batched within both limits, and a big area is split along its flows', () => {
  const ids = (a, b) => Array.from({ length: b - a }, (_, i) => `C${a + i}`);
  const doc = capsDoc([
    { id: 'A', name: 'A', capability_ids: ids(0, 10) }, { id: 'B', name: 'B', capability_ids: ids(10, 20) },
    { id: 'C', name: 'C', capability_ids: ids(20, 30) }, { id: 'D', name: 'D', capability_ids: ids(30, 40) },
    { id: 'BIG', name: 'Big', flows: [{ id: 'F1', capability_ids: ids(40, 70) }, { id: 'F2', capability_ids: ids(70, 100) }, { id: 'F3', capability_ids: ids(100, 120) }],
      capability_ids: [...ids(120, 125), 'NA'] },
  ]);
  const b = researchBatches(doc, ['A', 'B', 'C', 'D', 'BIG'], { max_areas_per_batch: 3, max_capabilities_per_batch: 60 });
  assert.deepEqual(b[0].areas, ['A', 'B', 'C'], 'at most three areas per batch');
  assert.deepEqual(b[1].areas, ['D']);
  const big = b.filter(x => x.areas[0] === 'BIG');
  assert.ok(big.length >= 2, 'an 85-capability area is split');
  assert.ok(big.every(x => x.capability_ids.length <= 60 && x.split));
  assert.deepEqual(big.flatMap(x => x.capability_ids).sort(), [...ids(40, 125)].sort(), 'every capability lands in exactly one batch; not-applicable ones are left out');
  assert.deepEqual(researchBatches(doc, ['A', 'B'], { max_capabilities_per_batch: 15 }).map(x => x.areas), [['A'], ['B']], 'the capability limit splits too');
});

test('area names resolve by id, name or slug, and unknown ones are reported, not guessed', () => {
  const doc = { areas: [{ id: 'TM', name: 'Task management' }, { id: 'CS', name: 'Customer support' }] };
  assert.deepEqual(resolveAreas(doc, 'tm, Customer Support,customer-support'), { ids: ['TM', 'CS'], unknown: [] });
  assert.deepEqual(resolveAreas(doc, 'task').ids, ['TM'], 'a clear prefix of a name');
  assert.deepEqual(resolveAreas(doc, 'finance,ta').unknown, ['finance', 'ta'], 'too short to be a prefix');
});

test('completeness: every capability used or explained, every persona of the area served', () => {
  const doc = { capabilities: [cap('C1'), cap('C2'), cap('C3'), cap('NA', 'not_applicable')],
    areas: [{ id: 'A', name: 'A', personas: ['Lead', 'IC'], capability_ids: ['C1', 'C2', 'C3', 'NA'] }, { id: 'B', name: 'B', capability_ids: [] }] };
  const cat = { use_cases: [{ id: 'U1', area: 'A', persona: 'IC', capabilities: ['C1'] }, { id: 'U2', area: 'B', also_areas: ['A'], persona: 'Lead', capabilities: ['C2'] }],
    no_business_use: [{ capability_id: 'C3', reason: 'too short' }] };
  let c = areaCompleteness(cat, doc, 'A');
  assert.equal(c.caps_total, 3, 'not-applicable capabilities are not counted');
  assert.deepEqual(c.missing_caps.map(x => x.id), ['C3'], 'a two-word reason does not explain anything');
  assert.deepEqual(c.personas_missing, ['Lead'], 'a cross-area use case owned by another area does not serve this area\'s persona');
  cat.no_business_use[0].reason = 'only ever a step inside the export flow';
  cat.use_cases.push({ id: 'U3', area: 'A', persona: 'Lead', capabilities: ['C1'] });
  c = areaCompleteness(cat, doc, 'A');
  assert.equal(c.ok, true);
  assert.equal(c.caps_covered, 3);
});

test('a source counts only when its page was checked and found', () => {
  const u = s => ({ source: { kind: 'help_center', title: 't', ...s } });
  assert.match(sourceProblems(u({}))[0], /no source URL/);
  assert.match(sourceProblems(u({ url: 'https://x' }))[0], /not checked/);
  assert.match(sourceProblems(u({ url: 'https://x', verified: { url: 'https://x', status: 'off_topic' } }))[0], /off topic/);
  assert.match(sourceProblems(u({ url: 'https://y', verified: { url: 'https://x', status: 'found' } }))[0], /not checked/, 'a changed URL is checked again');
  assert.deepEqual(sourceProblems(u({ url: 'https://x', verified: { url: 'https://x', status: 'found' } })), []);
  assert.deepEqual(sourceProblems({ source: { kind: 'customer_dump', title: 'q' } }), [], 'a customer dump is its own evidence');
  assert.deepEqual(sourceProblems(u({ url: 'https://x' }), { verify: false }), []);
});

test('an area\'s human review survives a few additions and rewording voids a rating', () => {
  const C = { min_score: 4, min_agreement: 0.8, human_min_per_area: 3, human_regrow: 0.25 };
  const mk = (id, at = '2026-01-01') => ({ id, area: 'A', request: `request ${id}`, realism: { score: 5 }, added_at: at });
  const cat = { use_cases: ['U1', 'U2', 'U3', 'U4'].map(id => mk(id)), areas: { A: { human_review: { at: '2026-02-01',
    ratings: ['U1', 'U2', 'U3'].map(id => ({ id, rating: 5, request: `request ${id}` })) } } } };
  assert.equal(areaHumanCheck(cat, 'A', C).ok, true);
  cat.use_cases.push(mk('U5', '2026-03-01'), mk('U6', '2026-03-01'), mk('U7', '2026-03-01'));
  assert.equal(areaHumanCheck(cat, 'A', C).ok, true, 'three additions are within the allowance');
  cat.use_cases.push(mk('U8', '2026-03-01'));
  assert.match(areaHumanCheck(cat, 'A', C).reason, /4 use cases were added since/);
  cat.use_cases.splice(4);
  cat.use_cases[0].request = 'reworded';
  assert.match(areaHumanCheck(cat, 'A', C).reason, /2 of the 3 human ratings/);
  cat.use_cases[0].request = 'request U1';
  cat.areas.A.human_review.ratings[0].rating = 1;
  cat.areas.A.human_review.ratings[1].rating = 1;
  assert.match(areaHumanCheck(cat, 'A', C).reason, /agreement 33%/);
});

test('freeze state is per area: editing one area leaves the others frozen', () => {
  const cat = { use_cases: [{ id: 'U1', area: 'A', request: 'one' }, { id: 'U2', area: 'B', request: 'two' }], areas: {} };
  cat.areas.A = { frozen: true, hash: areaHash(cat, 'A') };
  cat.areas.B = { frozen: true, hash: areaHash(cat, 'B') };
  assert.equal(wholeFrozen(cat, ['A', 'B']), true);
  assert.equal(wholeFrozen(cat, ['A', 'B', 'C']), false, 'an area never researched keeps the catalog as a whole open');
  cat.use_cases[1].request = 'two, reworded';
  assert.equal(areaFreezeState(cat, 'A'), 'frozen');
  assert.equal(areaFreezeState(cat, 'B'), 'changed');
});

test('results are reused per use case: newest valid wins, older runs fill gaps, changes and other builds are stale', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-lr-'));
  const fp = fingerprint({ connector_build: '1', instructions: 'x', workspace: 'w' });
  const other = fingerprint({ connector_build: '2', instructions: 'x', workspace: 'w' });
  const u1 = { id: 'U1', area: 'A', request: 'one', kind: 'question' }, u2 = { id: 'U2', area: 'A', request: 'two', kind: 'question' };
  const u3 = { id: 'U3', area: 'B', request: 'three', kind: 'question' };
  const rec = (u, run, extra = {}) => ({ run_id: run, suite: 'business', use_case_id: u.id, variant: 0, attempt: 1, outcome: 'correct', uc_hash: ucHash(u), ...extra });
  writeRun(root, 'X', 'old', { model: 'm', fingerprint: fp, finished_at: '2026-01-01' }, [rec(u1, 'old'), rec(u2, 'old'), rec(u3, 'old')]);
  writeRun(root, 'X', 'new', { model: 'm', fingerprint: fp, finished_at: '2026-02-01' }, [rec(u1, 'new'), rec(u2, 'new', { outcome: 'not_run', reason: 'no result recorded for this attempt' })]);
  writeRun(root, 'X', 'b2', { model: 'm', fingerprint: other, finished_at: '2026-03-01' }, [rec(u3, 'b2')]);
  writeRun(root, 'X', 'om', { model: 'other', fingerprint: fp, finished_at: '2026-04-01' }, [rec(u1, 'om')]);
  const cat = { use_cases: [u1, u2, u3] };
  let r = latestResults(root, 'X', { model: 'm', cat, env: fp.env_key });
  assert.equal(r.chosen_from.get('U1#0'), 'new', 'the newest valid result');
  assert.equal(r.chosen_from.get('U2#0'), 'old', 'an incomplete newer attempt falls back to the complete older one');
  assert.equal(r.chosen_from.get('U3#0'), 'old', 'a result from another build is skipped');
  assert.equal(r.runs.length, 2);
  u1.request = 'one, reworded';
  r = latestResults(root, 'X', { model: 'm', cat, env: fp.env_key });
  assert.ok(!r.valid.has('U1#0') && r.stale.has('U1#0'), 'a reworded use case needs a new result');
  r = latestResults(root, 'X', { model: 'm', cat, env: fp.env_key, areas: ['B'] });
  assert.deepEqual([...r.wanted.keys()], ['U3#0'], 'scoped to its areas');
  r = latestResults(root, 'X', { model: 'm', cat, env: other.env_key });
  assert.equal(r.chosen_from.get('U3#0'), 'b2');
  assert.ok(r.stale.has('U2#0'), 'everything else is stale on the new build');
  assert.equal(fingerprint({ connector_build: '1', instructions: 'x', workspace: 'w', catalog_version: 9, catalog_hash: 'z' }).env_key, fp.env_key, 'the environment ignores the catalog');
});

test('a cross-area pass is due once both related areas are frozen, and only once', () => {
  const cat = { use_cases: [{ id: 'U1', area: 'A', request: 'one' }, { id: 'U2', area: 'B', request: 'two' }], areas: {} };
  const doc = { areas: [{ id: 'A', related: ['B'] }, { id: 'B', related: ['A'] }, { id: 'C' }] };
  assert.deepEqual(crossDue(doc, cat, null), []);
  cat.areas.A = { frozen: true, hash: areaHash(cat, 'A') };
  cat.areas.B = { frozen: true, hash: areaHash(cat, 'B') };
  assert.deepEqual(crossDue(doc, cat, null), ['A+B'], 'a pair is listed once, whichever side names it');
  assert.deepEqual(crossDue(doc, cat, { batches: [{ cross: true, areas: ['B', 'A'], status: 'done' }] }), []);
});

/* ── review findings ─────────────────────────────────────────────────────── */
import { listRuns } from '../scripts/lib/results.mjs';
import { sampleForReview } from '../scripts/lib/catalog.mjs';
import { capabilityReport } from '../scripts/lib/report-data.mjs';

test('only a decided outcome is a reusable result; "not possible" lapses when the capability is exposed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-dec-'));
  const fp = fingerprint({ connector_build: '1', instructions: 'x', workspace: 'w' });
  const us = ['U1', 'U2', 'U3', 'U4', 'U5'].map(id => ({ id, area: 'A', request: id, kind: 'question', capabilities: [`C${id}`] }));
  const rec = (u, outcome, reason) => ({ run_id: 'r', suite: 'business', use_case_id: u.id, variant: 0, attempt: 1, outcome, reason, uc_hash: ucHash(u) });
  writeRun(root, 'X', 'r', { model: 'm', fingerprint: fp, run_started_at: '2026-01-01' }, [
    rec(us[0], 'not_run', 'Changes data, and write execution is disabled for this run.'), rec(us[1], 'needs_judgement'),
    rec(us[2], 'not_possible'), { ...rec(us[3], 'no_test_data'), steps: [{ ok: true, tool: 'queryData' }] },
    /* 3.7: held for data and never dispatched — runs once the data is seeded */
    rec(us[4], 'no_test_data', 'No test data: needs a project — find or seed it (test-data.mjs).')]);
  const caps = { capabilities: [{ id: 'CU3', mapping: { status: 'exposed' } }] };
  const r = latestResults(root, 'X', { model: 'm', cat: { use_cases: us }, env: fp.env_key, capsDoc: caps });
  assert.deepEqual([...r.valid], ['U4#0'], 'no test data, when the agent ran, is a measurement; the rest are not');
  assert.ok(r.incomplete.has('U5#0'), 'a test held for data is run once the data exists');
  assert.match(r.incomplete.get('U1#0').why, /write execution is disabled/);
  assert.match(r.incomplete.get('U2#0').why, /needs judgement/);
  assert.match(r.stale.get('U3#0').why, /exposed now/);
  caps.capabilities[0].mapping.status = 'not_exposed';
  assert.ok(latestResults(root, 'X', { model: 'm', cat: { use_cases: us }, env: fp.env_key, capsDoc: caps }).valid.has('U3#0'));
});

test('runs are ordered by when they ran, so re-ingesting an old run never makes it newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-ord-'));
  writeRun(root, 'X', 'old', { model: 'm', run_started_at: '2026-01-01', finished_at: '2026-03-01' }, []);
  writeRun(root, 'X', 'new', { model: 'm', run_started_at: '2026-02-01', finished_at: '2026-02-02' }, []);
  assert.deepEqual(listRuns(root, 'X').map(m => m.run_id), ['new', 'old']);
});

test('shared and oversize flows are batched without researching a capability twice', () => {
  const ids = (a, b) => Array.from({ length: b - a }, (_, i) => `C${a + i}`);
  const doc = capsDoc([{ id: 'A', name: 'A', flows: [{ id: 'F1', capability_ids: ids(0, 40) }, { id: 'F2', capability_ids: ids(30, 70) }, { id: 'F3', capability_ids: ids(70, 160) }] }]);
  const b = researchBatches(doc, ['A'], { max_capabilities_per_batch: 60 });
  const all = b.flatMap(x => x.capability_ids);
  assert.equal(all.length, new Set(all).size, 'no capability in two batches');
  assert.equal(all.length, 160);
  assert.ok(b.every(x => x.capability_ids.length <= 60), 'a 90-capability flow is split too');
});

test('an ambiguous prefix is refused, and a reworded rated use case is sampled again first', () => {
  const doc = { areas: [{ id: 'PP', name: 'Projects' }, { id: 'PR', name: 'Procurement' }] };
  assert.match(resolveAreas(doc, 'pro').unknown[0], /matches Projects, Procurement/);
  assert.deepEqual(resolveAreas(doc, 'proj').ids, ['PP']);
  const cat = { use_cases: ['U1', 'U2', 'U3'].map(id => ({ id, area: 'A', persona: 'P', request: id })),
    areas: { A: { human_review: { ratings: [{ id: 'U1', rating: 5, request: 'U1' }, { id: 'U2', rating: 5, request: 'old wording' }] } } } };
  const order = sampleForReview(cat, 3).map(u => u.id);
  assert.equal(order[2], 'U1', 'only the use case still worded as rated counts as rated');
});

test('a use case is reported under the area the catalog puts it in now', () => {
  const capsDoc = { capabilities: [], areas: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] };
  const records = [{ suite: 'business', use_case_id: 'U1', variant: 0, attempt: 1, area: 'Alpha', area_id: 'A', outcome: 'correct', score: 90, grade: 'blue', metrics: { calls: 1 } }];
  const d = capabilityReport({ manifest: {}, records, capsDoc, catalog: { use_cases: [{ id: 'U1', area: 'B' }] }, knowledge: {} });
  assert.equal(d.areas.find(a => a.id === 'B').ucs.total, 1);
  assert.equal(d.areas.find(a => a.id === 'A').ucs.total, 0);
  assert.equal(d.use_cases[0].area, 'Beta');
});

test('a grouped answer is matched on its values, whatever the agent named its columns', async () => {
  const { compare } = await import('../scripts/lib/checks.mjs');
  const ref = { rows: [{ AssigneeName: 'Ann', OpenTaskCount: 3 }, { AssigneeName: 'Bo', OpenTaskCount: 1 }] };
  const check = { rule: 'values_within', key: 'AssigneeName', field: 'OpenTaskCount', tolerance: 0 };
  assert.equal(compare(check, {}, { ...ref, agent_rows: [{ Owner: 'Ann', Open: 3 }, { Owner: 'Bo', Open: 1 }] }).result, 'correct');
  assert.equal(compare(check, {}, { ...ref, agent_rows: [{ Owner: 'Ann', Open: 2 }, { Owner: 'Bo', Open: 1 }] }).result, 'wrong', 'one of two groups off is more than the 20% a partial allows');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, {}, { rows: [{ Id: '1' }, { Id: '2' }], agent_rows: [{ TaskGid: '1' }, { TaskGid: '2' }] }).result, 'correct');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, {}, { rows: [{ Id: '1' }, { Id: '2' }], agent_rows: [{ Other: 'x' }, { Other: 'y' }] }).result, 'needs_judgement', 'no column carries the key: the judge decides, it is never a silent pass');
});

test('an agent that queried broadly and filtered in its answer is judged on its answer, not its broad query', async () => {
  const { compare } = await import('../scripts/lib/checks.mjs');
  const ref = { rows: [{ Id: '1' }, { Id: '2' }] };
  const reran = Array.from({ length: 28 }, (_, i) => ({ Id: String(i + 1) }));
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: '1' }, { Id: '2' }] }, { ...ref, agent_rows: reran }).result, 'correct', 'its two rows are all in the re-run: it filtered');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: '1' }, { Id: '99' }] }, { ...ref, agent_rows: reran }).result, 'wrong', 'a row the query never returned: the re-run counts');
});

test('an answer keyed or shaped differently from the reference goes to the judge, not to "wrong"', async () => {
  const { compare } = await import('../scripts/lib/checks.mjs');
  const ref = { rows: [{ SectionId: 's1', OpenTasks: 7 }, { SectionId: 's2', OpenTasks: 2 }] };
  assert.equal(compare({ rule: 'values_within', key: 'SectionId', field: 'OpenTasks' }, { rows: [{ Section: 'To do', Open: 7 }, { Section: 'In progress', Open: 2 }] }, ref).result, 'needs_judgement');
  const pref = { rows: [{ ProjectId: 'p1', NumberofTasks: 13 }] };
  assert.equal(compare({ rule: 'values_within', key: 'ProjectId', field: 'NumberofTasks' }, { rows: [{ ProjectId: 'p1', Completed: 'true', cnt: 3 }, { ProjectId: 'p1', Completed: 'false', cnt: 10 }] }, pref).result, 'needs_judgement');
});
