/* The guardrail between a model-authored artifact and the script that consumes it.
 *
 * Stages 3 and 5 are written by a language model. Nothing sat between them and the scripts that
 * read them, so a name the model invented became a silent behaviour change rather than an error.
 * Three times now:
 *
 *   - Stage 5 named ten behaviours and generate-tests recognised three. The other seven produced
 *     tests whose prompt was the literal word "undefined" — valid JSON, valid schema_version,
 *     nonsense question.
 *   - `not_applicable` meant "done" to one script and "outstanding" to another, producing gaps no
 *     test could close.
 *   - A numeric `tier: 1` passes every structural check and yields zero T1 objects, because every
 *     consumer compares against the string 'T1'.
 *
 * Structure was never the problem. These assert the vocabulary check fails on each of those.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BEHAVIORS, STATES, TIERS, unknown } from '../scripts/lib/vocabulary.mjs';
import { isCovered } from '../scripts/lib/coverage-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = args => {
  const r = spawnSync(process.execPath, [join(SK, 'scripts', 'validate-model.mjs'), ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: String(r.stdout || '') + String(r.stderr || '') };
};

/* a minimal, valid pair of artifacts */
function build() {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-vocab-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
  const cols = [{ name: 'Id', role: 'identifier', important: true },
                { name: 'Status', role: 'status', important: true }];
  W('Demo_knowledge.json', {
    schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
    run_meta: { run_id: 'r1', started_at: '2026-09-01T00:00:00Z', models: {} },
    connector_meta: { app: 'Demo', workflow_domains: [],
      personas: [{ id: 'P1', name: 'Contributor', jobs_to_be_done: ['do a thing'] }], roles: [] },
    physical: { procedures: [], permissions: { select: true } },
    objects: [{ name: 'Task', type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true,
      business_meaning: { v: 'Task', confidence: 'FACT', source: 'vendor_docs' }, columns: cols }],
    relationships: [],
  });
  W('Demo_coverage.json', {
    schema_version: '2.0.0', connector: 'Demo', objectives: {},
    objects: { tables: { total: 1, by_tier: {}, rows: [{ name: 'Task', tier: 'T1', state: 'discovered', tc_ids: [] }] },
               views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
    columns: { rows: cols.map(c => ({ object: 'Task', column: c.name, role: c.role, state: 'uncovered', tc_ids: [] })) },
    relationships: { rows: [] },
    use_cases: { rows: [{ id: 'UC-1', name: 'do a thing', domain: 'X', persona: 'Contributor',
                          objects: ['Task'], source: 'vendor_report', state: 'uncovered', tc_ids: [] }] },
    patterns: { rows: [{ pattern: 'select_projection', applicable: true, state: 'uncovered', tc_ids: [] }] },
    intents: { rows: [] },
    behaviors: { rows: [{ behavior: 'empty_result_handling', applicable: true, state: 'uncovered', tc_ids: [] }] },
  });
  return dir;
}
const base = build();
const fresh = () => { const d = join(mkdtempSync(join(tmpdir(), 'cqa-vb-')), 'Demo');
  cpSync(base, d, { recursive: true }); return d; };
const edit = (dir, file, f) => {
  const p = join(dir, file); const o = JSON.parse(readFileSync(p, 'utf8'));
  f(o); writeFileSync(p, JSON.stringify(o, null, 2));
};

test('a consistent pair of artifacts passes', () => {
  const { code, out } = run(['--dir', base, '--connector', 'Demo']);
  assert.equal(code, 0, `a valid model output must pass:\n${out}`);
});

test('a behaviour name the generator cannot write a prompt for is rejected', () => {
  /* The exact asn005 bug: ten behaviours named, three recognised, seven tests asking "undefined". */
  const d = fresh();
  edit(d, 'Demo_coverage.json', c => { c.behaviors.rows[0].behavior = 'empty_result_interpretaton'; });
  const { code, out } = run(['--dir', d, '--connector', 'Demo']);
  assert.notEqual(code, 0, 'an unrecognised behaviour must fail before it reaches the generator');
  assert.match(out, /unknown behavior/i);
  assert.match(out, /did you mean/i, 'a near miss should be named — this is a typo, not a new concept');
});

test('a numeric tier is rejected with the reason it matters', () => {
  const d = fresh();
  edit(d, 'Demo_knowledge.json', k => { k.objects[0].tier = 1; });
  const { code, out } = run(['--dir', d, '--connector', 'Demo']);
  assert.notEqual(code, 0);
  assert.match(out, /is a number/i);
  assert.match(out, /zero T1 objects/i, 'the message must say what silently breaks, not just that it is wrong');
});

test('an unknown coverage state is rejected', () => {
  const d = fresh();
  edit(d, 'Demo_coverage.json', c => { c.objects.tables.rows[0].state = 'mostly_fine'; });
  const { code, out } = run(['--dir', d, '--connector', 'Demo']);
  assert.notEqual(code, 0);
  assert.match(out, /unknown state/i);
});

test('a use case naming a persona nothing defines is rejected', () => {
  const d = fresh();
  edit(d, 'Demo_coverage.json', c => { c.use_cases.rows[0].persona = 'Chief Vibes Officer'; });
  const { code, out } = run(['--dir', d, '--connector', 'Demo']);
  assert.notEqual(code, 0);
  assert.match(out, /does not define/i);
});

test('a half-declared relationship is reported, because it silently loses its reference query', () => {
  const d = fresh();
  edit(d, 'Demo_knowledge.json', k => {
    k.relationships = [{ id: 'R1', from: 'Task', to: 'Task', from_col: 'ParentId', confidence: 'FACT' }];
  });
  const { code, out } = run(['--dir', d, '--connector', 'Demo']);
  assert.notEqual(code, 0);
  assert.match(out, /from_col but not to_col/i);
});

/* ── the vocabulary itself ─────────────────────────────────────────────────── */

test('every behaviour the vocabulary lists has a prompt in the generator', () => {
  /* A name with no prompt is a test with no question — the failure this whole file exists for.
     Asserted against the source rather than a copy, so the two cannot drift again. */
  const gen = readFileSync(join(SK, 'scripts', 'generate-tests.mjs'), 'utf8');
  const missing = BEHAVIORS.filter(b => !new RegExp(`\\b${b}\\s*:`).test(gen));
  assert.deepEqual(missing, [], 'these behaviours are in the vocabulary but have no prompt generator');
});

test('the covered-state predicate only accepts states the vocabulary knows', () => {
  const covered = STATES.filter(isCovered);
  assert.ok(covered.length, 'something must count as covered');
  assert.ok(!isCovered('not_testable'), 'not_testable means the gap stays open and visible');
  assert.ok(isCovered('not_applicable'), 'correctly-not-supported is settled, not outstanding');
});

test('unknown() suggests the near miss rather than just refusing', () => {
  assert.match(unknown('T5', TIERS, 'tier') || '', /unknown tier/);
  assert.match(unknown('coveed', STATES, 'state') || '', /did you mean "covered"/);
  assert.equal(unknown('T1', TIERS, 'tier'), null);
});
