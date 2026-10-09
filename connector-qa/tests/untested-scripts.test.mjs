/* Behavioural cover for the scripts the suite never executed.
 *
 * An audit measured 795 LOC — 22% of the codebase — running in no test: mine-dump, tier-objects,
 * export-jdbc-suite, sync-skill, plus review-prep and review-merge since added. `tier-objects
 * --apply` rewrites BOTH primary artifacts and had no test at all.
 *
 * These exist so the lib/ consolidation that follows has something to fail against. They assert
 * contracts, not implementations: what each script must guarantee, so a refactor that preserves
 * behaviour passes and one that quietly changes it does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const S = f => join(SK, 'scripts', f);
const run = (script, args, opts = {}) =>
  execFileSync(process.execPath, [S(script), ...args], { encoding: 'utf8', stdio: 'pipe', ...opts });
const runCode = (script, args) => {
  try { run(script, args); return 0; } catch (e) { return e.status ?? 1; }
};

/* ── a complete, self-consistent connector directory ───────────────────────── */
function build() {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-uts-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
  const cols = [
    { name: 'Id', role: 'identifier', important: true },
    { name: 'Name', role: 'dimension', important: true },
    { name: 'Status', role: 'status', important: true },
    { name: 'DueOn', role: 'date', important: true },
    { name: 'Amount', role: 'measure', important: true },
    { name: 'ProjectId', role: 'relationship_key', important: true },
  ];
  const objs = ['Task', 'Project'].map(n => ({
    name: n, type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
    business_meaning: { v: n, confidence: 'FACT', source: 'vendor_docs' }, columns: cols,
  }));
  const rels = [{ id: 'REL-001', from: 'Task', to: 'Project', from_col: 'ProjectId', to_col: 'Id',
                  confidence: 'FACT', source: 'cdata_metadata' }];

  W('Demo_knowledge.json', {
    schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
    run_meta: { run_id: 'r_test', started_at: '2026-09-01T00:00:00Z', models: {} },
    connector_meta: {
      app: 'Demo',
      workflow_domains: [{ id: 'TM', name: 'Task Management', table_refs: ['Task'],
        standard_reports: ['Task Report'],
        workflows: [{ id: 'TM01', name: 'Complete a task', permission: 'write', edge_cases: ['already complete'] }] }],
      personas: [{ id: 'P_IC', name: 'Contributor', jobs_to_be_done: ['Close out my tasks'] }],
      roles: [{ name: 'Member', group: 'Core', access: { TM: 'F' } }],
    },
    physical: { procedures: [{ name: 'DoThing', params_total: 1, required_params: ['TaskId'] }],
                permissions: { select: true, insert: true, update: true, delete: false, execute: true } },
    objects: objs, relationships: rels,
  });

  W('Demo_coverage.json', {
    schema_version: '2.0.0', connector: 'Demo', objectives: {},
    objects: { tables: { total: 2, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) },
               views: { total: 0, rows: [] },
               procedures: { total: 1, rows: [{ name: 'DoThing', params_total: 1, state: 'discovered', tc_ids: [] }] } },
    columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
    relationships: { rows: rels.map(r => ({ id: r.id, from: r.from, to: r.to, state: 'uncovered', confidence: 'FACT', tc_ids: [] })) },
    use_cases: { rows: [{ id: 'UC-1', name: 'Close out my tasks', domain: 'TM', persona: 'Contributor',
                          objects: ['Task'], source: 'vendor_report', state: 'uncovered', tc_ids: [] }] },
    patterns: { rows: ['select_projection', 'filter_equality', 'limit', 'join_inner', 'insert', 'update']
      .map(p => ({ pattern: p, applicable: true, state: 'uncovered', tc_ids: [] })) },
    intents: { rows: [] },
    behaviors: { rows: [{ behavior: 'empty_result_interpretation', applicable: true, state: 'uncovered', tc_ids: [] }] },
  });

  run('compute-gaps.mjs', ['--knowledge', join(dir, 'Demo_knowledge.json'),
    '--coverage', join(dir, 'Demo_coverage.json'), '--out', join(dir, 'Demo_gaps.json')]);
  const G = JSON.parse(readFileSync(join(dir, 'Demo_gaps.json'), 'utf8'));
  for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 120); g.business_importance = 'HIGH'; }
  W('Demo_gaps.json', G);
  run('score-gaps.mjs', ['--gaps', join(dir, 'Demo_gaps.json'), '--knowledge', join(dir, 'Demo_knowledge.json')]);
  run('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo']);
  return dir;
}

const dir = build();
const R = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));

/* ── tier-objects ──────────────────────────────────────────────────────────── */

test('tier-objects: a dry run changes nothing on disk', () => {
  const before = readFileSync(join(dir, 'Demo_knowledge.json'), 'utf8');
  run('tier-objects.mjs', ['--dir', dir]);
  assert.equal(readFileSync(join(dir, 'Demo_knowledge.json'), 'utf8'), before,
    'without --apply the script must be read-only');
});

test('tier-objects: --apply records the score and the reasons, not just the tier', () => {
  run('tier-objects.mjs', ['--dir', dir, '--apply']);
  const o = R('Demo_knowledge.json').objects.find(x => x.name === 'Task');
  assert.ok(o.tier, 'tier assigned');
  assert.equal(typeof o.tier_score, 'number', 'the score must be recorded so a tier can be explained');
  assert.ok(Array.isArray(o.tier_signals) && o.tier_signals.length, 'the signals that produced it must be recorded');
});

test('tier-objects: an explicit --connector that does not exist is an error, not a silent retarget', () => {
  /* It used to fall through to discovery and rewrite whatever single connector was present. */
  assert.equal(runCode('tier-objects.mjs', ['--dir', dir, '--connector', 'Salesforce', '--apply']), 2);
  assert.ok(existsSync(join(dir, 'Demo_knowledge.json')), 'the wrong connector must not be touched');
});

/* ── export-jdbc-suite ─────────────────────────────────────────────────────── */

test('export-jdbc-suite: every planned test is accounted for', () => {
  run('export-jdbc-suite.mjs', ['--dir', dir]);
  const J = R('Demo_jdbc_suite.json'), plan = R('Demo_plan.json');
  assert.equal(J.counts.plan_tcs, plan.tc_list.length);
  assert.equal(J.counts.accounted, J.counts.plan_tcs,
    'a test that reaches neither queries, mutations, templates nor skipped has vanished silently');
});

test('export-jdbc-suite: `queries` is genuinely read-only', () => {
  const J = R('Demo_jdbc_suite.json');
  const writes = (J.queries || []).filter(q => /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(q.sql || ''));
  assert.deepEqual(writes.map(w => w.tc || w.id), [],
    'the file documents `queries` as read-only; a caller replaying it must not write to their source');
  for (const m of J.mutations || [])
    assert.match(m.warning || '', /CHANGES DATA/i, 'every mutation must carry its warning');
});

test('export-jdbc-suite: no LIMIT is appended to a write', () => {
  for (const m of R('Demo_jdbc_suite.json').mutations || [])
    assert.doesNotMatch(m.sql, /\bLIMIT\b/i, 'LIMIT is not valid on INSERT/UPDATE');
});

/* ── review-prep ───────────────────────────────────────────────────────────── */

test('review-prep: the reviewer gets the research and NOT the gap ledger', () => {
  run('review-prep.mjs', ['--dir', dir, '--connector', 'Demo']);
  const pkg = R('Demo_review_input.json');
  assert.ok(pkg.research.workflow_domains.length, 'workflow domains must reach the reviewer');
  assert.ok(pkg.research.personas.length, 'personas must reach the reviewer');
  assert.ok(pkg.research.roles.length, 'roles must reach the reviewer');
  assert.equal(pkg.gaps, undefined, 'the gap ledger is the pipeline\'s own reasoning — withholding it is the point');
  for (const t of pkg.test_cases)
    assert.equal(t.expected_sql, undefined, 'expected_sql is the answer key; the reviewer judges the prompt');
});

test('review-prep: all ten dimensions are counted', () => {
  const dims = R('Demo_review_input.json').completeness.dimensions.map(d => d.dimension);
  for (const need of ['objects', 'procedures', 'capabilities', 'relationships', 'query patterns',
                      'use cases', 'agent behaviors', 'workflows', 'personas', 'roles'])
    assert.ok(dims.includes(need), `"${need}" must be audited — it was one of the four that were not`);
});

test('review-prep: a package that fits is one call, and accounts for every test', () => {
  const pkg = R('Demo_review_input.json'), plan = R('Demo_plan.json');
  assert.equal(pkg.shard.of, 1, 'this fixture fits a single call');
  assert.deepEqual([...pkg.shard.tc_ids].sort(), plan.tc_list.map(t => t.id).sort(),
    'the shard manifest must account for every test in the plan');
});

test('review-prep: a budget below the shared context refuses rather than shipping a useless shard', () => {
  /* Surface, research, use cases and the completeness table cannot be split — every shard needs
     all of them. If they alone exceed the budget there is no valid shard to produce, and saying so
     beats emitting shards that omit the very context that makes the review work. */
  const out = join(dir, 'tiny.json');
  assert.notEqual(runCode('review-prep.mjs',
    ['--dir', dir, '--connector', 'Demo', '--out', out, '--max-tokens', '200']), 0,
    'an impossible budget must fail loudly');
});

/* ── review-merge ──────────────────────────────────────────────────────────── */

function patch(dirPath, over = {}) {
  const plan = JSON.parse(readFileSync(join(dirPath, 'Demo_plan.json'), 'utf8'));
  const ids = plan.tc_list.map(t => t.id);
  const p = { shard: { index: 1, of: 1 }, reviewed_ids: ids,
    counts: { reviewed: ids.length, modified: 0, added: 0, merges: 0 },
    modified: [], added: [], merges: [], ...over };
  writeFileSync(join(dirPath, 'Demo_review_patch.json'), JSON.stringify(p, null, 2));
  return join(dirPath, 'Demo_review_patch.json');
}
const fresh = () => { const d = join(mkdtempSync(join(tmpdir(), 'cqa-mrg-')), 'Demo');
  cpSync(dir, d, { recursive: true }); return d; };

test('review-merge: a declared count that does not match the patch is a truncated response', () => {
  const d = fresh();
  const f = patch(d, { counts: { reviewed: 999, modified: 0, added: 0, merges: 0 } });
  assert.notEqual(runCode('review-merge.mjs', ['--dir', d, '--connector', 'Demo', '--patch', f]), 0);
});

test('review-merge: a missing shard is named, not ignored', () => {
  const d = fresh();
  const f = patch(d, { shard: { index: 1, of: 3 } });
  assert.notEqual(runCode('review-merge.mjs', ['--dir', d, '--connector', 'Demo', '--patch', f]), 0);
});

test('review-merge: a test left unreviewed stops the merge', () => {
  const d = fresh();
  const plan = JSON.parse(readFileSync(join(d, 'Demo_plan.json'), 'utf8'));
  const f = patch(d, { reviewed_ids: plan.tc_list.slice(0, 1).map(t => t.id),
    counts: { reviewed: 1, modified: 0, added: 0, merges: 0 } });
  assert.notEqual(runCode('review-merge.mjs', ['--dir', d, '--connector', 'Demo', '--patch', f]), 0);
});

test('review-merge: an addition naming an object the connector does not expose is rejected', () => {
  const d = fresh();
  const f = patch(d, {
    added: [{ uc: 'invented', prompt: 'Ask about a thing that is not there.',
              target_objects: ['NoSuchObject'], query_patterns: ['select_projection'] }],
    counts: { reviewed: JSON.parse(readFileSync(join(d, 'Demo_plan.json'), 'utf8')).tc_list.length,
              modified: 0, added: 1, merges: 0 },
  });
  run('review-merge.mjs', ['--dir', d, '--connector', 'Demo', '--patch', f]);
  const rev = JSON.parse(readFileSync(join(d, 'Demo_tc_review.json'), 'utf8'));
  assert.equal(rev.rejected_additions.length, 1, 'a hallucinated object produces a test that can only fail');
  assert.equal(rev.tcs_added, 0);
});

test('review-merge: a valid patch stamps reviewed_at and assigns batch ids', () => {
  const d = fresh();
  const f = patch(d);
  run('review-merge.mjs', ['--dir', d, '--connector', 'Demo', '--patch', f, '--model', 'opus']);
  const plan = JSON.parse(readFileSync(join(d, 'Demo_plan.json'), 'utf8'));
  assert.ok(plan.reviewed_at, 'the router needs reviewed_at to tell a finished review from an interrupted one');
  assert.equal(plan.review_model, 'opus');
  assert.ok(plan.tc_list.every(t => t.batch_id), 'batch assignment is arithmetic and must always happen');
  assert.ok(existsSync(join(d, 'Demo_tc_review.json')));
});
