/* Every capability the connector advertises must get a test from the GENERATOR.
 *
 * asn004 ran 118 SELECTs and zero writes against a connector advertising insert and update.
 * The cause was structural, not an oversight: generate-tests had no insert/update generator at
 * all, so the whole write surface depended on the Stage 8.5 reviewer noticing its absence. A
 * review is a second opinion; it must never be the only thing between a capability and no
 * coverage. This asserts the generator covers writes on its own, with the review switched off.
 */
import { test } from 'node:test';
import { writePolicy } from '../scripts/lib/artifacts.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });

const dir = join(mkdtempSync(join(tmpdir(), 'cqa-write-')), 'Demo');
mkdirSync(dir, { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), JSON.stringify(o, null, 2));

const base = [{ name: 'Id', role: 'identifier', important: true }, { name: 'Name', role: 'dimension', important: true },
              { name: 'Status', role: 'status', important: true }, { name: 'DueOn', role: 'date', important: true },
              { name: 'Amount', role: 'measure', important: true }];
const fk = { Task: 'ProjectId', Project: 'TeamId', Team: null };
const SCORE = { Task: 14, Project: 12, Team: 10 };
const objs = ['Task', 'Project', 'Team'].map(n => ({ name: n, type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
  tier_score: SCORE[n], business_meaning: { v: n, confidence: 'FACT', source: 'vendor_docs' },
  columns: fk[n] ? [...base, { name: fk[n], role: 'relationship_key', important: true }] : base }));

/* a two-hop chain, so join_left has a pair and join_multi_table has A→B→C */
const rels = [
  { id: 'REL-001', from: 'Task', to: 'Project', from_col: 'ProjectId', to_col: 'Id', confidence: 'FACT', source: 'cdata_metadata', tested: false },
  { id: 'REL-002', from: 'Project', to: 'Team', from_col: 'TeamId', to_col: 'Id', confidence: 'FACT', source: 'cdata_metadata', tested: false },
];

W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
  run_meta: { run_id: 'r1', started_at: '2026-09-01T00:00:00Z', models: {} },
  connector_meta: { app: 'Demo', workflow_domains: [], personas: [], roles: [] },
  /* the connector says it can do all four */
  physical: { procedures: [], permissions: { select: true, insert: true, update: true, delete: false } },
  objects: objs, relationships: rels });

W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: objs.length, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) },
             views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
  relationships: { rows: rels.map(r => ({ id: r.id, from: r.from, to: r.to, on: r.from_col + ' = ' + r.to_col, state: 'uncovered', confidence: 'FACT', tc_ids: [] })) },
  use_cases: { rows: [] },
  patterns: { rows: ['select_projection', 'filter_equality', 'insert', 'update', 'delete',
    'distinct', 'filter_like', 'filter_null', 'filter_negation', 'filter_enum', 'offset_pagination',
    'having', 'subquery', 'union', 'date_function', 'string_function', 'case_when', 'group_by',
    'aggregate_count', 'join_left', 'join_multi_table']
    .map(p => ({ pattern: p, applicable: p !== 'delete', applicability_reason: p === 'delete' ? 'connector does not expose DELETE' : '',
                 state: p === 'delete' ? 'not_applicable' : 'uncovered', tc_ids: [] })) },
  intents: { rows: [] }, behaviors: { rows: [] } });

run('compute-gaps.mjs', ['--knowledge', P('Demo_knowledge.json'), '--coverage', P('Demo_coverage.json'), '--out', P('Demo_gaps.json')]);
const G = JSON.parse(readFileSync(P('Demo_gaps.json'), 'utf8'));
for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 120); g.business_importance = 'HIGH'; }
W('Demo_gaps.json', G);
run('score-gaps.mjs', ['--gaps', P('Demo_gaps.json'), '--knowledge', P('Demo_knowledge.json')]);
run('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo']);

const plan = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));
const pats = new Set(plan.tc_list.flatMap(t => t.query_patterns || []));
const writes = plan.tc_list.filter(t => t.group_type === 'write');

test('the generator writes UPDATE and INSERT tests without any review pass', () => {
  assert.ok(pats.has('update'), 'no UPDATE test for a connector advertising update');
  assert.ok(pats.has('insert'), 'no INSERT test for a connector advertising insert');
  assert.ok(writes.length >= 2, `expected write tests, got ${writes.length}`);
});

test('a capability the connector does NOT advertise gets no test', () => {
  assert.ok(!pats.has('delete'), 'invented a DELETE test the connector never claimed to support');
});

test('an UPDATE is reversible and always runs', () => {
  const upd = writes.find(t => (t.query_patterns || []).includes('update'));
  assert.equal(upd.reversible, true, 'an update is reversible by restoring the old value');
  assert.equal(upd.executable, true);
});

test('an irreversible INSERT follows write_policy rather than a hardcoded answer', () => {
  /* This asserted `executable === false` outright and broke the moment the policy legitimately
     changed to allow irreversible writes against a disposable environment. The contract is that
     the generator OBEYS the policy — not that any particular policy is in force. */
  const cfg = JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8'));
  const allowed = writePolicy(cfg).execute_irreversible;
  const ins = writes.find(t => (t.query_patterns || []).includes('insert'));
  assert.equal(ins.reversible, false, 'no DELETE is exposed, so an insert cannot be cleaned up');

  if (allowed) {
    assert.equal(ins.executable, true, 'policy allows irreversible writes, so the insert should run');
  } else {
    assert.equal(ins.executable, false, 'policy forbids irreversible writes, so the insert must be held back');
    assert.match(ins.nt_reason, /cannot delete/, 'a test held back must say why, in the report');
  }
});

test('writes land on the most important objects, not alphabetical order', () => {
  const upd = writes.filter(t => (t.query_patterns || []).includes('update'));
  assert.equal(upd[0].target_objects[0], 'Task', 'writes should start at the highest-scoring object');
});

test('the generator reaches every applicable pattern without a review pass', () => {
  /* Pattern breadth used to come from Stage 8.5: the generator reached 20 of Asana's 37 applicable
     patterns and Opus filled the rest. A skipped or weak review silently cost 15 patterns. */
  const cov = JSON.parse(readFileSync(P('Demo_coverage.json'), 'utf8'));
  const applicable = cov.patterns.rows.filter(p => p.applicable).map(p => p.pattern);
  const missing = applicable.filter(p => !pats.has(p));
  assert.deepEqual(missing, [], `the generator left ${missing.length} applicable pattern(s) untested: ${missing.join(', ')}`);
});

test('a join uses the relationship\'s declared keys, never a guessed column', () => {
  /* The previous version of this test could not fail. It looped over matches of a regex that
     required QUALIFIED operands (`ON a.[X] = b.[Y]`), so against the broken `ON bId = Id` it
     matched zero times, the loop body never ran, and it reported success. A test that only
     inspects well-formed input verifies nothing. Assert the shape first, then the contents. */
  const joins = plan.tc_list.filter(t => /\bJOIN\b/i.test(t.expected_sql || ''));
  assert.ok(joins.length, 'fixture produced no joins — this test would be vacuous');

  const colsOf = n => new Set((objs.find(o => o.name === n) || { columns: [] }).columns.map(c => c.name));
  for (const j of joins) {
    assert.doesNotMatch(j.expected_sql, /\[(null|undefined)\]/, `${j.id} built a join from a missing column`);

    const ons = [...j.expected_sql.matchAll(/\bON\s+([^\s]+)\s*=\s*([^\s]+)/gi)];
    assert.ok(ons.length, `${j.id} has a JOIN with no ON clause: ${j.expected_sql}`);

    for (const [, left, right] of ons) {
      for (const side of [left, right]) {
        assert.match(side, /^\w+\.\[\w+\]$/,
          `${j.id} has an unqualified join operand "${side}" — ambiguous when both tables share the column: ${j.expected_sql}`);
      }
    }
    /* and every qualified column must exist on the object its alias refers to */
    const alias = {};
    for (const [, tbl, al] of j.expected_sql.matchAll(/\[(\w+)\]\s+(\w+)\b/g)) alias[al] = tbl;
    for (const [, a, col] of j.expected_sql.matchAll(/\b(\w+)\.\[(\w+)\]/g)) {
      const tbl = alias[a]; if (!tbl) continue;
      const known = colsOf(tbl);
      if (known.size) assert.ok(known.has(col),
        `${j.id} references ${a}.[${col}] but ${tbl} has no such column: ${j.expected_sql}`);
    }
  }
});
