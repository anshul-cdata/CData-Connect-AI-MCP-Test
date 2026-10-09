/* Two guards that protect what a reader is told about a failure.
 *
 * 1. `boundary` asserts the connector refused the query. asn004 applied it to empty tables, so the
 *    report printed "the driver rejected it" beside a connector that had answered correctly and
 *    found nothing — an accusation, from a row count. credit-coverage now refuses to credit
 *    coverage from a boundary verdict with no refusal anywhere in its steps.
 *
 * 2. `risk_flag` is what the plan knew before the run: premium gating, wrong documented columns,
 *    writes that cannot be undone. It sat in the plan and reached no report, so a BLOCKED verdict
 *    looked like a connector defect when the account tier was the cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const S = f => join(SK, 'scripts', f);
const run = (script, args) => execFileSync(process.execPath, [S(script), ...args], { encoding: 'utf8', stdio: 'pipe' });

const dir = join(mkdtempSync(join(tmpdir(), 'cqa-verdict-')), 'Demo');
mkdirSync(dir, { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), JSON.stringify(o, null, 2));

W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
  run_meta: { run_id: 'r1', models: {} }, connector_meta: { app: 'Demo', workflow_domains: [], personas: [], roles: [] },
  physical: { procedures: [] },
  objects: [{ name: 'Task', type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
    business_meaning: { v: 'Task', confidence: 'FACT', source: 'vendor_docs' },
    columns: [{ name: 'Id', role: 'identifier', important: true }] }],
  relationships: [] });
W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: 1, by_tier: {}, rows: [{ name: 'Task', tier: 'T1', state: 'discovered', tc_ids: [] }] },
             views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: [{ object: 'Task', column: 'Id', role: 'identifier', state: 'uncovered', tc_ids: [] }] },
  relationships: { rows: [] }, use_cases: { rows: [] },
  patterns: { rows: [{ pattern: 'select_projection', applicable: true, state: 'uncovered', tc_ids: [] }] },
  intents: { rows: [] }, behaviors: { rows: [] } });
W('Demo_gaps.json', { schema_version: '2.0.0', connector: 'Demo', prioritized: true, gaps: [] });

const tcLine = tc => JSON.stringify({ type: 'tc', tc }) + '\n';
const creditArgs = extra => ['--checkpoint', P('Demo_checkpoint.jsonl'), '--coverage', P('Demo_coverage.json'),
  '--gaps', P('Demo_gaps.json'), '--knowledge', P('Demo_knowledge.json'), ...extra];

test('a `boundary` verdict with no refusal on any step is refused', () => {
  writeFileSync(P('Demo_checkpoint.jsonl'), '');
  appendFileSync(P('Demo_checkpoint.jsonl'), tcLine({
    id: 'TC-001', status: 'boundary', uc: 'overdue tasks', owner: 'owner-driver',
    target_objects: ['Task'], query_patterns: ['select_projection'],
    steps: [{ t: 'p', q: 'SELECT [Id] FROM [Task] WHERE [Done]=0', r: '0 rows' }],
    observed: { sql: 'SELECT [Id] FROM [Task] WHERE [Done]=0' } }));

  assert.throws(() => run('credit-coverage.mjs', creditArgs([])),
    /boundary/i, 'an empty result labelled boundary must not be credited silently');
});

test('a `boundary` verdict carrying a real refusal is accepted', () => {
  writeFileSync(P('Demo_checkpoint.jsonl'), '');
  appendFileSync(P('Demo_checkpoint.jsonl'), tcLine({
    id: 'TC-001', status: 'boundary', uc: 'premium goals', owner: 'owner-driver',
    target_objects: ['Task'], query_patterns: ['select_projection'],
    steps: [{ t: 'b', q: 'SELECT [Id] FROM [Task]', e: 'HTTP 40002 — user cannot access goals without premium permissions', a: 'API refused on plan' }],
    observed: { sql: 'SELECT [Id] FROM [Task]' } }));

  assert.doesNotThrow(() => run('credit-coverage.mjs', creditArgs([])));
});

test('the escape hatch works, so a run is never wedged by a disputed verdict', () => {
  writeFileSync(P('Demo_checkpoint.jsonl'), '');
  appendFileSync(P('Demo_checkpoint.jsonl'), tcLine({
    id: 'TC-001', status: 'boundary', uc: 'overdue tasks', owner: 'owner-driver',
    target_objects: ['Task'], query_patterns: ['select_projection'],
    steps: [{ t: 'p', q: 'SELECT [Id] FROM [Task]', r: '0 rows' }],
    observed: { sql: 'SELECT [Id] FROM [Task]' } }));

  assert.doesNotThrow(() => run('credit-coverage.mjs', creditArgs(['--allow-mislabelled-boundary'])));
});

test('risk_flag and nt_reason survive the merge and reach the report', () => {
  writeFileSync(P('Demo_checkpoint.jsonl'), '');
  /* the shape execution writes under context pressure: id/status/steps and nothing else */
  appendFileSync(P('Demo_checkpoint.jsonl'), tcLine({ id: 'TC-001', status: 'pass', steps: [], observed: { sql: 'SELECT [Id] FROM [Task]' } }));
  appendFileSync(P('Demo_checkpoint.jsonl'), tcLine({ id: 'TC-002', status: 'not_exec', steps: [] }));

  W('Demo_plan.json', { schema_version: '2.0.0', connector: 'Demo', tc_list: [
    { id: 'TC-001', prompt: 'Which tasks are overdue?', uc: 'overdue', priority: 'P1', group: 'G1', group_type: 'process',
      target_objects: ['Task'], risk_flag: 'premium_required', risk_flag_all: ['premium_required', 'metadata_defect'] },
    { id: 'TC-002', prompt: 'Duplicate the project.', uc: 'duplicate', priority: 'P2', group: 'G1', group_type: 'write',
      target_objects: ['Task'], executable: false, nt_reason: 'DuplicateProject creates a project this connector cannot delete.' },
  ] });

  run('merge-checkpoint.mjs', ['--jsonl', P('Demo_checkpoint.jsonl'), '--out', P('Demo_checkpoint.json'), '--plan', P('Demo_plan.json')]);
  const merged = JSON.parse(readFileSync(P('Demo_checkpoint.json'), 'utf8'));
  const tcs = merged.tcs || (merged.groups || []).flatMap(g => g.tcs || []);
  const t1 = tcs.find(t => t.id === 'TC-001'), t2 = tcs.find(t => t.id === 'TC-002');

  assert.equal(t1.risk_flag, 'premium_required', 'risk_flag was dropped by the merge');
  assert.deepEqual(t1.risk_flag_all, ['premium_required', 'metadata_defect']);
  assert.match(t2.nt_reason, /cannot delete/, 'nt_reason was dropped by the merge');
  assert.equal(t2.executable, false);
});

test('the template renders risk flags and labels a never-run test honestly', () => {
  const tpl = readFileSync(join(SK, 'assets', 'report-template.html'), 'utf8');
  assert.match(tpl, /function riskHtml\(/, 'no risk-flag renderer in the template');
  assert.match(tpl, /riskHtml\(tc\)/, 'riskHtml is defined but never called from the TC row');
  assert.match(tpl, /premium_required:/, 'risk flags have no human-readable labels');
  assert.match(tpl, /Planned, deliberately not executed/, 'a never-dispatched test is still labelled as something the agent learned');
  assert.doesNotMatch(tpl, /getElementById\('gap-rounds'\)/, 'the removed Iteration Rounds section still has live JS writing to it');
});
