/* 3.7.1 — fixes from a four-part independent review of the whole project (instructions, research to
 * tests, checking and scoring, reports and packaging). Each test pins one confirmed defect. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writePolicy } from '../scripts/lib/artifacts.mjs';
import { SAYS_NOT_DONE, isYesNo, asksUser, compare, refineOutcome } from '../scripts/lib/checks.mjs';
import { classifyError } from '../scripts/lib/journey.mjs';
import { verdictOf, causeOf, useCaseRows, capabilityReport } from '../scripts/lib/report-data.mjs';
import { byUseCase, writeRun, fingerprint } from '../scripts/lib/results.mjs';
import { rescore } from '../scripts/lib/scoring.mjs';
import { latestResults } from '../scripts/lib/scope.mjs';
import { ucHash, validateCatalog } from '../scripts/lib/catalog.mjs';
import { changesExisting, enforceMcpReach } from '../scripts/lib/capabilities.mjs';
import { fixtureRefs, renderUseCase, recordId } from '../scripts/lib/fixtures.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (script, args, opts = {}) => execFileSync(process.execPath, [join(SK, 'scripts', script), ...args], { encoding: 'utf8', ...opts });
const exitOf = (script, args) => { try { node(script, args, { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };

test('"read only" means nothing that changes data runs, and the question is asked again next run', () => {
  const cfg = JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'cqa-ro-'));
  node('write-policy.mjs', ['confirm', '--dir', dir, '--answer', 'readonly']);
  const p = writePolicy(cfg, dir);
  assert.deepEqual([p.read_only, p.execute_reversible, p.execute_irreversible], [true, false, false]);
  assert.match(node('write-policy.mjs', ['status', '--dir', dir]), /ASK —/, 'asked again at the next run start');
  /* safe mode alone holds only what cannot be undone */
  const safe = writePolicy({ defaults: { write_policy: { safe_mode: true } } });
  assert.deepEqual([safe.execute_reversible, safe.execute_irreversible], [true, false]);
});

test('the strict write gate reads the run\'s own pin, whatever an id looks like', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-pin-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  W('Demo_knowledge.json', { connector: 'Demo', objects: [], run_meta: { workspace: { id: '00D5g000001AbCd', name: 'test org', source: 'Organization' },
    workspace_catalog: [{ id: '00D5g000001AbCd', name: 'test org', is_organization: false }] } });
  W('Demo_plan.json', { tc_list: [{ id: 'TC-1', suite: 'business', kind: 'action', mutates: true, reversible: true, executable: true, prompt: 'Close the deal.', write_workspace: '00D5g000001AbCd',
    agent_context: 'Only work in workspace 00D5g000001AbCd.' }] });
  assert.equal(exitOf('preflight-writes.mjs', ['--dir', dir, '--strict']), 0);
});

test('wording rules catch everyday refusals and requests', () => {
  for (const t of ["I can't update that task.", "That isn't possible through this connector.", 'I am not able to log time here.', "I won't be able to change it.",
    'The workspace does not have premium permissions to access Goals.']) assert.ok(SAYS_NOT_DONE.test(t), t);
  for (const t of ['Can you list the overdue tasks in Website Relaunch?', 'Could you show me which projects are off track?', 'Would you pull together the tasks assigned to Sam?'])
    assert.equal(isYesNo(t), false, t);
  assert.equal(isYesNo('Is the SSO fix still flagged as blocked?'), true);
  assert.equal(asksUser("Tell me which task to log the 2 hours against and I'll add it for today."), true);
});

test('checks: invented rows, unmatched keys and capped counts are not decided blindly', () => {
  const ref0 = { rule: 'same_ids', key: 'Id', reference_sql: 'SELECT [Id],[TaskId],[DurationMinutes] FROM [C].[S].[Entries]' };
  assert.equal(compare(ref0, { rows: [{ Id: '1', TaskId: '7', DurationMinutes: 30 }] }, { rows: [] }).result, 'wrong', 'entries over an empty account are invented');
  /* asn-tr1 TC-005: the agent read 28 tasks on the way and said, correctly, that no time was logged */
  assert.equal(compare(ref0, { rows: [{ Id: '11', Name: 'Fix links', ActualTimeMinutes: null }] }, { rows: [] }).result, 'no_test_data', 'rows read on the way are not answers');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [] }, { rows: [] }).result, 'no_test_data');
  assert.equal(compare({ rule: 'values_within', key: 'Name', field: 'Open', tolerance: 0 }, { rows: [{ Name: 'Fix login', Open: 2 }] }, { rows: [{ Name: 'Blocked', Open: 3 }] }).result, 'needs_judgement');
  assert.equal(compare({ rule: 'same_ids', key: 'Id' }, { rows: [{ Id: '9' }] }, { rows: [{ Id: '1' }] }).result, 'wrong', 'wrong records stay wrong');
  const rows50 = Array.from({ length: 50 }, (_, i) => ({ Id: String(i) }));
  assert.equal(compare({ rule: 'same_count' }, { rows: rows50, truncated: true }, { rows: Array.from({ length: 120 }, (_, i) => ({ Id: String(i) })) }).result, 'needs_judgement');
});

test('a connector that never answered is the connector\'s, not missing data', () => {
  const dead = { tool: 'queryData', category: 'query', ok: false, cause: 'connector', error_class: 'server_unavailable', error: "The connector's server isn't responding." };
  const r = refineOutcome({ outcome: 'no_test_data', detail: 'the reference query returned no rows' }, { steps: [dead, dead], answer: 'I could not retrieve the entries.' }, { kind: 'question', check: { rule: 'same_ids' } }, {});
  assert.equal(r.outcome, 'blocked_connector');
  assert.equal(classifyError("Cannot obtain connection for 'Asana1': I/O error").class, 'server_unavailable');
  assert.equal(classifyError('STMT DATA_SOURCE [40002] The resource you tried was not found').class, 'record_not_found');
});

test('owners and verdicts: a recovered error never hides an AI mistake; refused by the connector is a finished result', () => {
  const u = { outcome: 'partial', capabilities: [], steps: [
    { ok: false, tool: 'getColumns', category: 'discovery', cause: 'account', error_class: 'auth_required' },
    { ok: false, tool: 'queryData', category: 'query', cause: 'instructions', error_class: 'required_filter', recovered: true }] };
  assert.equal(verdictOf(u), 'partly');
  assert.equal(causeOf(u), 'ai');
  assert.equal(verdictOf({ ...u, review: { cause: 'account' } }), 'blocked_account', 'a reviewer may still re-charge it');
  const root = mkdtempSync(join(tmpdir(), 'cqa-bc-'));
  const uc = { id: 'U1', area: 'A', request: 'Rename the tag', kind: 'action' };
  const fp = fingerprint({ connector_build: '1', instructions: 'x', workspace: 'w' });
  writeRun(root, 'X', 'r', { model: 'm', fingerprint: fp }, [{ run_id: 'r', suite: 'business', use_case_id: 'U1', variant: 0, attempt: 1, outcome: 'blocked_connector', uc_hash: ucHash(uc), steps: [{ ok: false }] }]);
  assert.ok(latestResults(root, 'X', { model: 'm', cat: { use_cases: [uc] }, env: fp.env_key }).valid.has('U1#0'));
});

test('the representative attempt is the majority outcome; wording agreement ignores attempt noise', () => {
  const r = (o, s, extra = {}) => ({ suite: 'business', use_case_id: 'U', outcome: o, score: s, ...extra });
  assert.equal(byUseCase([r('blocked_account', null), r('blocked_account', null), r('blocked_account', null), r('correct', 90)])[0].outcome, 'blocked_account');
  const rows = useCaseRows([r('correct', 90, { variant: 0 }), r('partial', 40, { variant: 0 }), r('correct', 95, { variant: 0 }), r('correct', 90, { variant: 1 }), r('correct', 92, { variant: 1 })]);
  assert.equal(rows[0].phrasings_agree, true);
});

test('an attempt that only asked does not set the shortest path', () => {
  const m = a => ({ calls: a + 1, acting_calls: a, discovery_calls: 1, failed: 0, recoveries: 0, dead_ends: 0, repeated: 0 });
  const out = rescore([{ run_id: 'r', tc_id: 'T', use_case_id: 'U', kind: 'action', attempt: 1, outcome: 'correct', metrics: m(0) },
                       { run_id: 'r', tc_id: 'T', use_case_id: 'U', kind: 'action', attempt: 2, outcome: 'correct', metrics: m(2) }]);
  assert.equal(out[1].parts.efficiency, 20, 'the two-query attempt is the shortest real path');
});

test('a gap blocks a use case only when its verdict is the gap\'s', () => {
  const caps = [{ id: 'C1', label: 'Search projects', method: 'GET', path: '/projects/search', mapping: { status: 'partly', exposure: [{ kind: 'table', name: 'Projects', op: 'SELECT' }] } },
                { id: 'C2', label: 'Budgets', method: 'GET', path: '/budgets', mapping: { status: 'not_exposed', exposure: [] } }];
  const rec = (id, o, capsU) => ({ run_id: 'r', suite: 'business', use_case_id: id, tc_id: id, variant: 0, attempt: 1, outcome: o, capabilities: capsU, steps: o === 'not_possible' ? [] : [{ ok: true }], metrics: { calls: 1 } });
  const d = capabilityReport({ manifest: { connector: 'X', run_id: 'r', model: 'm' }, records: [rec('U1', 'wrong', ['C1']), rec('U2', 'not_possible', ['C2'])],
    capsDoc: { capabilities: caps, areas: [] }, catalog: { use_cases: [] }, knowledge: {} });
  assert.equal(d.gaps.find(g => g.id === 'C1').blocked, 0, 'an AI mistake is not a connector gap');
  assert.equal(d.gaps.find(g => g.id === 'C2').blocked, 1);
  assert.ok(d.personas.every(p => p.verdicts), 'personas carry their verdicts');
});

test('research to tests: actions on an existing record, MCP reach, fixtures in expect', () => {
  const caps = new Map([['add-f', { id: 'add-f', method: 'POST', path: '/tasks/{task_gid}/addFollowers' }], ['new', { id: 'new', method: 'POST', path: '/tasks' }]]);
  assert.equal(changesExisting(['add-f'], caps), true, 'adding followers changes an existing task');
  assert.equal(changesExisting(['new'], caps), false);
  const reviewed = [{ id: 'd', method: 'DELETE', path: '/x/{id}', mapping: { status: 'exposed', exposure: [{ kind: 'table', name: 'X' }] } }];
  enforceMcpReach(reviewed);
  assert.equal(reviewed[0].mapping.status, 'not_exposed', 'an exposure without op takes it from the method');
  const u = { request: 'Rename it', check: { rule: 'write_visible', expect: { Name: '{{fixture:p.Name}} (old)' } },
    follow_up: { reply: 'that one', check: { rule: 'write_visible', expect: { Name: '{{fixture:p.Name}}' } } } };
  assert.deepEqual([...fixtureRefs(u)], ['p']);
  const r = renderUseCase(u, { p: { sys_id: 'a1', Name: 'Launch' } });
  assert.deepEqual([r.check.expect.Name, r.follow_up.check.expect.Name], ['Launch (old)', 'Launch']);
  assert.equal(recordId({ sys_id: 'a1', Name: 'x' }), 'a1');
});

test('broken fixtures block their area\'s freeze; a held fixture test is never released unrendered', () => {
  const v = validateCatalog({ fixtures: [{ id: 'f', area: 'TM', describe: 'x', find_sql: 'DELETE FROM T' }], use_cases: [] });
  assert.ok((v.problemsByArea.TM || []).some(p => /find_sql must be a SELECT/.test(p)));
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-rel-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Demo_plan.json'), JSON.stringify({ tc_list: [{ id: 'TC-1', suite: 'business', executable: false, data_hold: true, prompt: 'Log time on {{fixture:t.Name}}', check: { rule: 'judge' } }] }));
  assert.match(node('preflight-data.mjs', ['release', '--dir', dir, '--all']), /1 test\(s\) kept/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'Demo_plan.json'), 'utf8')).tc_list[0].executable, false);
});

test('the version check notices an edited source with the same version', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-hash-'));
  const src = join(root, 'source'), inst = join(root, 'installed');
  for (const d of [src, inst]) { mkdirSync(join(d, 'scripts'), { recursive: true }); cpSync(join(SK, 'scripts', 'check-version.mjs'), join(d, 'scripts', 'check-version.mjs'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ version: '3.7.1', root: d === inst ? 'C:/x' : '' })); writeFileSync(join(d, 'SKILL.md'), '---\nname: x\n---\n'); }
  writeFileSync(join(inst, 'install-info.json'), JSON.stringify({ source: src, version: '3.7.1' }));
  execFileSync(process.execPath, [join(inst, 'scripts', 'check-version.mjs'), '--stamp', src]);
  const run = () => { try { execFileSync(process.execPath, [join(inst, 'scripts', 'check-version.mjs')], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 0, 'just installed');
  writeFileSync(join(src, 'SKILL.md'), '---\nname: x\n---\nedited\n');
  assert.equal(run(), 3, 'edited without a version bump');
});
