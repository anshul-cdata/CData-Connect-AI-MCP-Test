/* Missing metadata must cost a REFERENCE, never a TEST.
 *
 * The agent under test never sees `expected_sql` — it receives the natural-language question and
 * works the SQL out from the connector's own tools. So when the metadata does not state a join
 * key, the right response is to ask the question anyway and withhold the reference query: finding
 * the key by inspection is precisely the work being measured, and a connector that cannot be
 * navigated is the finding.
 *
 * The first version of this fix skipped the test entirely, which deleted coverage from exactly the
 * connectors whose metadata is weakest — the ones that most need testing. What it should never do
 * is INVENT a key: `Allocations.Assignee = Workspaces.Id` is valid SQL meaning the wrong thing,
 * and it would be filed as a driver defect the moment it returned nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });

const cols = [{ name: 'Id', role: 'identifier', important: true }, { name: 'Name', role: 'dimension', important: true },
              { name: 'Status', role: 'status', important: true }, { name: 'DueOn', role: 'date', important: true },
              { name: 'ProjectId', role: 'relationship_key', important: true },
              { name: 'ParentId', role: 'relationship_key', important: true }];
const objs = ['Task', 'Project'].map(n => ({ name: n, type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
  tier_score: n === 'Task' ? 14 : 12, business_meaning: { v: n, confidence: 'FACT', source: 'vendor_docs' }, columns: cols }));

/* REL-001 states its join columns. REL-002 and REL-003 do not — the case under test. */
const rels = [
  { id: 'REL-001', from: 'Task', to: 'Project', from_col: 'ProjectId', to_col: 'Id', confidence: 'FACT', source: 'cdata_metadata' },
  { id: 'REL-002', from: 'Project', to: 'Task', confidence: 'INFERENCE', source: 'ai_inference' },
  { id: 'REL-003', from: 'Task', to: 'Task', confidence: 'INFERENCE', source: 'ai_inference' },
];

const dir = join(mkdtempSync(join(tmpdir(), 'cqa-undecl-')), 'Demo');
mkdirSync(dir, { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), JSON.stringify(o, null, 2));

W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
  run_meta: { run_id: 'r1', started_at: '2026-09-01T00:00:00Z', models: {} },
  connector_meta: { app: 'Demo', workflow_domains: [], personas: [], roles: [] },
  physical: { procedures: [], permissions: { select: true, insert: false, update: false, delete: false } },
  objects: objs, relationships: rels });

W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: 2, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) },
             views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
  relationships: { rows: rels.map(r => ({ id: r.id, from: r.from, to: r.to, state: 'uncovered', confidence: r.confidence, tc_ids: [] })) },
  use_cases: { rows: [] },
  patterns: { rows: ['select_projection', 'join_inner', 'join_left', 'join_self']
    .map(p => ({ pattern: p, applicable: true, state: 'uncovered', tc_ids: [] })) },
  intents: { rows: [] }, behaviors: { rows: [] } });

run('compute-gaps.mjs', ['--knowledge', P('Demo_knowledge.json'), '--coverage', P('Demo_coverage.json'), '--out', P('Demo_gaps.json')]);
const G = JSON.parse(readFileSync(P('Demo_gaps.json'), 'utf8'));
for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 120); g.business_importance = 'HIGH'; }
W('Demo_gaps.json', G);
run('score-gaps.mjs', ['--gaps', P('Demo_gaps.json'), '--knowledge', P('Demo_knowledge.json')]);
run('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo']);

const plan = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));
const relTC = id => plan.tc_list.find(t => (t.relationships || []).includes(id));

test('a relationship with declared keys still gets a reference query', () => {
  const t = relTC('REL-001');
  assert.ok(t, 'REL-001 produced no test at all');
  assert.match(t.expected_sql, /ON\s+a\.\[ProjectId\]\s*=\s*b\.\[Id\]/, 'declared keys should be used verbatim');
  assert.ok(!t.join_key_undeclared);
});

test('a relationship with NO declared keys is still tested — the question is asked', () => {
  const t = relTC('REL-002');
  assert.ok(t, 'an undeclared join key deleted the test instead of the reference query');
  assert.ok(t.prompt && t.prompt.length > 40, 'the test must still carry a real question');
});

test('…but no join key is invented for it', () => {
  const t = relTC('REL-002');
  assert.equal(t.expected_sql, null, 'a reference query was fabricated from a key the metadata never stated');
  assert.equal(t.join_key_undeclared, true, 'the report must be able to show WHY there is no reference');
  assert.match(t.note, /no join columns/i, 'the reason has to be stated, not implied');
});

test('the expectation, not the prompt, says the agent has to discover the link itself', () => {
  /* 2.1 put "work out how they are linked from the connector's own metadata; nothing is prepared
   * for you" in the prompt. No user says that, and it coaches the agent being measured — so since
   * 2.2 the judge is told instead, and the question stays a question. */
  const t = relTC('REL-002');
  assert.doesNotMatch(t.prompt, /work out how|metadata|nothing is prepared/i,
    'harness hints belong in expected_behavior, not in the user\'s question');
  assert.ok((t.expected_behavior || []).some(e => /linking columns|metadata/i.test(e)),
    'the judge must know the link is undocumented, or it cannot score the discovery');
});

test('no generated SQL anywhere references a column that does not exist', () => {
  const known = Object.fromEntries(objs.map(o => [o.name, new Set(o.columns.map(c => c.name))]));
  for (const t of plan.tc_list) {
    const sql = t.expected_sql; if (!sql) continue;
    const alias = {};
    for (const [, tbl, al] of sql.matchAll(/\[(\w+)\]\s+(\w+)\b/g)) alias[al] = tbl;
    for (const [, a, c] of sql.matchAll(/\b(\w+)\.\[(\w+)\]/g)) {
      const tbl = alias[a]; if (!tbl || !known[tbl]) continue;
      assert.ok(known[tbl].has(c), `${t.id} references ${a}.[${c}] but ${tbl} has no such column: ${sql}`);
    }
  }
});
