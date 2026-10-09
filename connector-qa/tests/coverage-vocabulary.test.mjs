/* The script that OPENS gaps and the script that CLOSES them must agree on "already covered".
 *
 * They did not. `compute-gaps.mjs` carried six separate per-dimension predicates and
 * `generate-tests.mjs` a seventh, and they disagreed about `not_applicable`: compute-gaps opened a
 * gap for a relationship or behaviour in that state, and generate-tests then refused to write a
 * test for one. The result was a gap nothing could ever close — permanently open, permanently
 * counted against coverage, and impossible to act on.
 *
 * The invariant: every gap the pipeline opens must be closable by the plan it generates, or be
 * explicitly reported as not-testable. Nothing in between.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isCovered, COVERED_STATES } from '../scripts/lib/coverage-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });

const cols = [{ name: 'Id', role: 'identifier', important: true }, { name: 'Name', role: 'dimension', important: true },
              { name: 'Status', role: 'status', important: true }, { name: 'DueOn', role: 'date', important: true },
              { name: 'ProjectId', role: 'relationship_key', important: true }];
const objs = ['Task', 'Project'].map(n => ({ name: n, type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
  business_meaning: { v: n, confidence: 'FACT', source: 'vendor_docs' }, columns: cols }));
const rels = [{ id: 'REL-001', from: 'Task', to: 'Project', from_col: 'ProjectId', to_col: 'Id',
                confidence: 'FACT', source: 'cdata_metadata' }];

/* Every dimension set to `not_applicable` — the state that used to split the two scripts. */
const dir = join(mkdtempSync(join(tmpdir(), 'cqa-vocab-')), 'Demo');
mkdirSync(dir, { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), JSON.stringify(o, null, 2));

W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
  run_meta: { run_id: 'r1', started_at: '2026-09-01T00:00:00Z', models: {} },
  connector_meta: { app: 'Demo', workflow_domains: [], personas: [], roles: [] },
  physical: { procedures: [{ name: 'DoThing', params_total: 1 }], permissions: { select: true } },
  objects: objs, relationships: rels });

W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: 2, by_tier: {}, rows: [
      { name: 'Task', tier: 'T1', state: 'not_applicable', tc_ids: [] },
      { name: 'Project', tier: 'T1', state: 'discovered', tc_ids: [] }] },
    views: { total: 0, rows: [] },
    procedures: { total: 1, rows: [{ name: 'DoThing', params_total: 1, state: 'not_applicable', tc_ids: [] }] } },
  columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
  relationships: { rows: [{ id: 'REL-001', from: 'Task', to: 'Project', state: 'not_applicable', confidence: 'FACT', tc_ids: [] }] },
  use_cases: { rows: [{ id: 'UC-1', name: 'Something', domain: 'X', persona: 'Y', objects: ['Project'], source: 'vendor_report', state: 'not_applicable', tc_ids: [] }] },
  patterns: { rows: [{ pattern: 'select_projection', applicable: true, state: 'uncovered', tc_ids: [] },
                     { pattern: 'join_inner', applicable: true, state: 'not_applicable', tc_ids: [] }] },
  intents: { rows: [{ id: 'INT-1', canonical: 'thing', phrasings: ['a', 'b'], objects: ['Project'], state: 'not_applicable', tc_ids: [] }] },
  behaviors: { rows: [{ behavior: 'empty_result_interpretation', applicable: true, state: 'not_applicable', tc_ids: [] }] } });

run('compute-gaps.mjs', ['--knowledge', P('Demo_knowledge.json'), '--coverage', P('Demo_coverage.json'), '--out', P('Demo_gaps.json')]);
const G0 = JSON.parse(readFileSync(P('Demo_gaps.json'), 'utf8'));
for (const g of G0.gaps) { g.description = String(g.evidence).slice(0, 120); g.business_importance = 'HIGH'; }
W('Demo_gaps.json', G0);
run('score-gaps.mjs', ['--gaps', P('Demo_gaps.json'), '--knowledge', P('Demo_knowledge.json')]);
run('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo']);

const gaps = JSON.parse(readFileSync(P('Demo_gaps.json'), 'utf8')).gaps;
const plan = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));

test('`not_applicable` is a covered state, in one shared definition', () => {
  assert.ok(isCovered('not_applicable'));
  assert.ok(isCovered('covered') && isCovered('tested') && isCovered('fully_covered'));
  /* `not_testable` must NOT be covered — we could not test it, and the gap stays visible */
  assert.ok(!isCovered('not_testable'), 'not_testable means the gap is still open');
  assert.ok(!isCovered('uncovered') && !isCovered('discovered') && !isCovered(''));
  assert.equal(COVERED_STATES.size, 4);
});

test('no gap is opened for a dimension already marked not_applicable', () => {
  const offenders = gaps.filter(g => /^(rel|beh|uc|intent|sp|obj_untested):/.test(String(g.key || '')));
  const opened = offenders.map(g => g.key);
  assert.deepEqual(opened.filter(k => /^rel:REL-001$/.test(k)), [], 'a not_applicable relationship still produced a gap');
  assert.deepEqual(opened.filter(k => /^beh:/.test(k)), [], 'a not_applicable behaviour still produced a gap');
  assert.deepEqual(opened.filter(k => /^uc:UC-1$/.test(k)), [], 'a not_applicable use case still produced a gap');
  assert.deepEqual(opened.filter(k => /^sp:DoThing$/.test(k)), [], 'a not_applicable procedure still produced a gap');
  assert.deepEqual(opened.filter(k => /^obj_untested:Task$/.test(k)), [], 'a not_applicable object still produced a gap');
});

test('every gap the pipeline opens can be closed by the plan it generates', () => {
  /* The invariant. A gap with no planned test and no not-testable reason is unactionable: it will
     read as an open failure on every future run and nothing will ever address it. */
  const planned = new Set(plan.tc_list.flatMap(t => t.gap_ids || []));
  const orphans = gaps.filter(g => !planned.has(g.id)
    && !/premium|subscription|403|not exposed|no DELETE/i.test(String(g.description || ''))
    && g.category !== 'EXPOSURE'      // exposure gaps are by definition untestable — nothing to query
    && g.category !== 'INTENT');      // intents need phrasings a human writes, not a generated query
  assert.deepEqual(orphans.map(g => `${g.key} (${g.category})`), [],
    'these gaps can never be closed by any generated test');
});
