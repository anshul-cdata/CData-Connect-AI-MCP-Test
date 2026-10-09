/* A mutating test must not be able to run without naming where it writes.
 *
 * The Asana plan reached Stage 9 with 61 tests flagged `mutates: true`, 47 of them irreversible,
 * and not one naming a workspace id. 47 of them said the word "workspace" in their prompt, which
 * reads like a constraint and is not one — the agent under test would have picked a workspace
 * itself, and that catalog reaches a real organization. The policy meant to prevent this held the
 * sentence "test environment — confirmed by the operator", which no code can evaluate.
 *
 * So the gate is asserted here rather than trusted: refuse with no pin, refuse on an unverifiable
 * pin, refuse on an organization, refuse when the prompts do not carry the pin — and let a
 * read-only plan straight through, because a plan that writes nothing risks nothing.
 *
 * Since 2.2.0 the pin gate is opt-in (connectors are tested against test accounts). The strict
 * cases below set run_meta.require_workspace_pin; the default — no pin, proceed — is asserted too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const SCRIPT = join(SK, 'scripts', 'preflight-writes.mjs');

/* Exit code, not a thrown error: 0 = dispatch allowed, 3 = refused. */
function gate(dir) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const CATALOG = [
  { id: '1126938837961830', name: 'cdata.com', is_organization: true },
  { id: '1208200246477352', name: 'test1', is_organization: false },
];
const SAFE = '1208200246477352';
const ORG = '1126938837961830';

/* One mutating test, and whether its prompt carries the pin. */
const mutating = (pin) => ({
  id: 'TC-001', mutates: true, reversible: false, executable: true,
  prompt: pin ? `In workspace ${pin}, create a task called QA probe.` : 'Create a task called QA probe.',
  expected_sql: 'INSERT INTO [Tasks] ([Name]) VALUES (\'QA probe\')',
});

function scenario(name, { tcs, workspace = null, catalog = CATALOG, strict = true }) {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-wt-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  const run_meta = { run_id: 'r1', started_at: '2026-09-01T00:00:00Z' };
  if (workspace) run_meta.workspace = workspace;
  if (catalog) run_meta.workspace_catalog = catalog;
  if (strict) run_meta.require_workspace_pin = true;
  writeFileSync(join(dir, 'Demo_knowledge.json'), JSON.stringify({ schema_version: '2.0.0', connector: 'Demo', run_meta }));
  writeFileSync(join(dir, 'Demo_plan.json'), JSON.stringify({ schema_version: '2.0.0', connector: 'Demo', tc_list: tcs }));
  return dir;
}

test('a plan that writes nothing needs no pin', () => {
  const dir = scenario('read-only', { tcs: [{ id: 'TC-001', prompt: 'How many tasks are open?' }], workspace: null, catalog: null });
  const r = gate(dir);
  assert.equal(r.code, 0, `read-only plan should pass:\n${r.out}`);
  assert.match(r.out, /nothing in this plan writes/i);
});

test('a mutating test held back by the plan needs no pin', () => {
  /* `executable: false` never reaches the connector, so it places nothing at risk. Forcing a pin
   * for it would make the gate fire on runs that write nothing — and a gate that fires when it
   * need not is one people learn to bypass. */
  const dir = scenario('held-back', {
    tcs: [{ ...mutating(null), executable: false, nt_reason: 'write policy' }], workspace: null, catalog: null,
  });
  assert.equal(gate(dir).code, 0);
});

test('mutating with an unverifiable pin is refused', () => {
  const dir = scenario('no-catalog', { tcs: [mutating(SAFE)], workspace: SAFE, catalog: null });
  const r = gate(dir);
  assert.equal(r.code, 3);
  assert.match(r.out, /no workspace catalog was captured/i);
});

test('a pin that is not in the catalog is refused', () => {
  const dir = scenario('typo', { tcs: [mutating('9999999999999999')], workspace: '9999999999999999' });
  const r = gate(dir);
  assert.equal(r.code, 3);
  assert.match(r.out, /not among the \d+ workspaces/i);
});

test('an organization workspace is refused even when correctly pinned', () => {
  /* The id is real, spelled right, and in the catalog. It is still the wrong answer, and this is
   * the case the whole gate exists for. */
  const dir = scenario('org', { tcs: [mutating(ORG)], workspace: ORG });
  const r = gate(dir);
  assert.equal(r.code, 3);
  assert.match(r.out, /production organization/i);
});

test('a safe pin the prompts do not carry is refused', () => {
  /* The operator named a safe workspace; the agent under test was never told. Passing here would
   * let the run report a pinned workspace while the writes went wherever the agent chose. */
  const dir = scenario('silent', { tcs: [mutating(null)], workspace: SAFE });
  const r = gate(dir);
  assert.equal(r.code, 3);
  assert.match(r.out, /do not name workspace/i);
});

test('a safe pin carried by every mutating prompt passes, and says what it will leave behind', () => {
  const dir = scenario('good', { tcs: [mutating(SAFE)], workspace: SAFE });
  const r = gate(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not an organization/);
  assert.match(r.out, /irreversible/i, 'an irreversible run must say so even when it is allowed');
});

test('a write that forgot to declare itself is refused', () => {
  /* Everything this gate does keys on `mutates`, which made that flag the only thing between an
   * unscoped write and a production workspace. Two tests reached the gate this way — one reading
   * "Change something small on one Allocations record", one a plain DELETE — both with `mutates`
   * undefined, and both invisible to every check that follows. */
  const dir = scenario('unflagged', {
    tcs: [{ id: 'TC-050', prompt: 'Change something small on one Allocations record and tell me whether it took.' }],
    workspace: SAFE,
  });
  const r = gate(dir);
  assert.equal(r.code, 3);
  assert.match(r.out, /not flagged/i);
  assert.match(r.out, /TC-050/);
});

test('prose that merely mentions writing is not mistaken for one', () => {
  /* The counterpart risk: a gate that fires on every prompt containing the word "create" is one
   * people learn to route around, and these exposure probes are the plan's most common shape. */
  const dir = scenario('probes', {
    tcs: [
      { id: 'TC-014', prompt: 'Tell me whether a rule can be created or inspected through this connection, and if not, show me the effects of one firing.' },
      { id: 'TC-015', prompt: 'Show me the tasks in that project that were created without an identifiable creator.' },
      { id: 'TC-016', prompt: 'Before we create anything for the new business unit, tell me which workspaces this connection can reach.' },
    ],
    workspace: null, catalog: null,
  });
  const r = gate(dir);
  assert.equal(r.code, 0, `read-only probes must not be flagged as writes:\n${r.out}`);
});

test('the run-level pin beats the connector-wide default', () => {
  /* config.defaults.write_policy.workspace is a standing default for the connector; a run that
   * names its own workspace is making a decision about today, and that has to win. */
  const dir = scenario('run-wins', { tcs: [mutating(SAFE)], workspace: SAFE });
  assert.equal(gate(dir).code, 0);
});

/* ── the default: no pin required ─────────────────────────────────────────── */

test('by default a mutating plan with no pin proceeds, and says what it will write', () => {
  const dir = scenario('lenient', { tcs: [{ ...mutating(null), target_objects: ['Tasks'] }], workspace: null, catalog: null, strict: false });
  const r = gate(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /pin not required/i);
  assert.match(r.out, /Tasks/, 'the operator still sees which objects will be written');
  assert.match(r.out, /irreversible/i, 'irreversible writes are still announced');
});

test('lenient mode still refuses a write that forgot to declare itself', () => {
  /* This check protects the held-back logic, not the workspace, so it survives strict mode off. */
  const dir = scenario('lenient-unflagged', {
    tcs: [{ id: 'TC-050', prompt: 'Change something small on one Allocations record and tell me whether it took.' }],
    catalog: null, strict: false,
  });
  assert.equal(gate(dir).code, 3);
});

test('--strict turns the gate on without touching config', () => {
  const dir = scenario('flag', { tcs: [mutating(null)], workspace: null, catalog: null, strict: false });
  try {
    execFileSync(process.execPath, [SCRIPT, '--dir', dir, '--strict'], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected a refusal');
  } catch (e) { assert.equal(e.status, 3); }
});

test('strict mode accepts the pin carried in agent_context instead of the question', () => {
  /* A business user's question never contains a workspace id; the operating note beside it does. */
  const dir = scenario('context', { tcs: [{ ...mutating(null), agent_context: `Only work in workspace ${SAFE}.` }], workspace: SAFE });
  const r = gate(dir);
  assert.equal(r.code, 0, r.out);
});
