/* 3.8 — the analysis report: research done, nothing run.
 *
 * A user who only researched a connector had no report: build-capability-report.mjs refused without
 * stored results. `--analysis` builds <Connector>_analysis_report.html from the capability list, the
 * catalog and the account probe, with an outlook per use case — a forecast, never a result — and must
 * never touch the capability report or read the results store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { outlookOf, analysisView, OUTLOOK_ORDER } from '../scripts/lib/report-data.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = args => { const r = spawnSync(process.execPath, [join(SK, 'scripts', 'build-capability-report.mjs'), ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: String(r.stdout || '') + String(r.stderr || '') }; };

const cap = (id, status, table, extra = {}) => ({ id, label: id, method: 'get', path: `/${id}`,
  mapping: { status, exposure: table ? [{ kind: 'table', name: table, op: 'SELECT' }] : [] }, ...extra });
const capsDoc = {
  source: { title: 'Demo API', version: '1', read_at: '2026-09-01T00:00:00Z' },
  areas: [{ id: 'A', name: 'Area A', capability_ids: ['C-ok', 'C-part', 'C-gap', 'C-app'] }, { id: 'B', name: 'Area B', capability_ids: ['C-refused', 'C-empty'] }],
  capabilities: [cap('C-ok', 'exposed', 'Tasks'), cap('C-part', 'partly', 'Tasks'), cap('C-gap', 'not_exposed'), cap('C-app', 'product_only'),
    cap('C-refused', 'exposed', 'Goals'), cap('C-empty', 'exposed', 'Events'), cap('C-auth', 'not_applicable')],
};
const uc = (id, area, caps, extra = {}) => ({ id, area, request: `request ${id}`, persona: 'Lead', kind: 'question', capabilities: caps, status: 'approved', ...extra });
const catalog = { version: 2, updated_at: '2026-09-02T00:00:00Z', use_cases: [
  uc('UC-1', 'A', ['C-ok']), uc('UC-2', 'A', ['C-ok', 'C-part']), uc('UC-3', 'A', ['C-ok', 'C-gap']), uc('UC-4', 'A', ['C-app']),
  uc('UC-5', 'B', ['C-refused']), uc('UC-6', 'B', ['C-empty']), uc('UC-7', 'B', ['C-missing']), uc('UC-8', 'A', ['C-ok'], { status: 'retired' }) ] };
const account = { at: '2026-09-03T00:00:00Z', tables: { Tasks: { status: 'data' }, Goals: { status: 'refused' }, Events: { status: 'empty' } } };
const capById = new Map(capsDoc.capabilities.map(c => [c.id, c]));

test('outlookOf: a CData gap first, then source-app-only, then the account, then partly, else ready', () => {
  const o = id => outlookOf(catalog.use_cases.find(u => u.id === id), capById, account);
  assert.equal(o('UC-1'), 'ready');
  assert.equal(o('UC-2'), 'partly');
  assert.equal(o('UC-3'), 'unsupported');
  assert.equal(o('UC-4'), 'not_applicable');
  assert.equal(o('UC-5'), 'account_refused');
  assert.equal(o('UC-6'), 'account_empty');
  assert.equal(o('UC-7'), 'unknown');
  /* without a probe nothing is charged to the account */
  assert.equal(outlookOf(catalog.use_cases[4], capById, null), 'ready');
  /* a gap stays a gap whatever the account holds */
  assert.equal(outlookOf(uc('X', 'A', ['C-gap', 'C-refused']), capById, account), 'unsupported');
});

test('analysisView: retired use cases left out, counts add up, needs and readiness per area', () => {
  const v = analysisView({ capsDoc, catalog, account });
  assert.equal(v.use_cases.length, 7);
  assert.equal(Object.values(v.outlook).reduce((a, b) => a + b, 0), 7);
  assert.deepEqual(Object.keys(v.outlook), OUTLOOK_ORDER);
  assert.equal(v.needs['C-ok'], 3);
  assert.equal(v.needs['C-gap'], 1);
  const B = v.readiness.find(r => r.id === 'B');
  assert.deepEqual([B.tables, B.data, B.refused, B.empty], [2, 0, 1, 1]);
  assert.deepEqual(B.refused_tables, ['Goals']);
  assert.equal(v.account_probed, true);
  const onlyA = analysisView({ capsDoc, catalog, account, areas: ['A'] });
  assert.deepEqual(onlyA.use_cases.map(u => u.area_id).filter(a => a !== 'A'), []);
  assert.deepEqual(onlyA.readiness.map(r => r.id), ['A']);
  assert.equal(analysisView({ capsDoc, catalog: null }).use_cases.length, 0);
});

const root = mkdtempSync(join(tmpdir(), 'cqa-an-'));
const dir = join(root, 'Demo');
mkdirSync(dir, { recursive: true });
const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
W('Demo_capabilities.json', capsDoc);
W('Demo_catalog.json', catalog);
W('Demo_account.json', account);
const dataOf = f => JSON.parse(readFileSync(f, 'utf8').match(/const DATA = ([\s\S]*?);\s*\n/)[1]);

test('--analysis builds its own file from research alone, with no stored result', () => {
  const r = cli(['--dir', dir, '--root', root, '--analysis']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ANALYSIS REPORT — Demo/);
  assert.match(r.out, /7 planned · 1 ready · 1 need a partly supported capability · 1 not supported · 1 source app only · 2 blocked by the test account · 1 need a capability not in the list/);
  const f = join(dir, 'Demo_analysis_report.html');
  assert.ok(existsSync(f));
  assert.ok(!existsSync(join(dir, 'Demo_capability_report.html')), 'the capability report is never written by --analysis');
  assert.ok(!existsSync(join(root, '_results')), 'the results store is not created');
  const html = readFileSync(f, 'utf8');
  assert.match(html, /<title>[^<]*Demo Analysis Report/);
  const D = dataOf(f);
  assert.equal(D.run.id, 'analysis');
  assert.equal(D.run.model, null);
  assert.equal(D.use_cases.length, 0, 'no result is invented');
  assert.equal(D.analysis.use_cases.length, 7);
  /* gaps are weighed by the planned use cases that need them */
  assert.equal(D.gaps.find(g => g.id === 'C-gap').blocked, 1);
  assert.equal(D.caps.total, 6);
  assert.equal(D.caps.not_applicable, 1);
  assert.equal(D.areas.find(a => a.id === 'A').capabilities.find(c => c.id === 'C-ok').needed, 3);
});

test('--analysis --areas keeps only those areas; --run or --model with it is a usage error', () => {
  const out = join(root, 'onlyB.html');
  const r = cli(['--dir', dir, '--root', root, '--analysis', '--areas', 'B', '--out', out]);
  assert.equal(r.code, 0, r.out);
  const D = dataOf(out);
  assert.deepEqual(D.areas.map(a => a.id), ['B']);
  assert.deepEqual([...new Set(D.analysis.use_cases.map(u => u.area_id))], ['B']);
  assert.notEqual(cli(['--dir', dir, '--root', root, '--analysis', '--run', 'x']).code, 0);
  assert.notEqual(cli(['--dir', dir, '--root', root, '--analysis', '--model', 'opus']).code, 0);
});

test('--analysis without a capability list fails plainly; without a probe it says so', () => {
  rmSync(join(dir, 'Demo_account.json'));
  const r = cli(['--dir', dir, '--root', root, '--analysis', '--out', join(root, 'noprobe.html')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /account not probed/);
  assert.equal(dataOf(join(root, 'noprobe.html')).analysis.outlook.account_refused, 0);
  rmSync(join(dir, 'Demo_capabilities.json'));
  const bad = cli(['--dir', dir, '--root', root, '--analysis']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /capability list/);
});

test('the template renders the analysis views and keeps the full report path for results', () => {
  const tpl = readFileSync(join(SK, 'assets', 'capability-report-template.html'), 'utf8');
  for (const fn of ['aSummary', 'aUseCases', 'aAreas', 'aAreaDetail', 'aRun']) assert.match(tpl, new RegExp(`function ${fn}\\(`));
  assert.match(tpl, /const TABS = D && D\.analysis \?/);
  /* a remembered tab the analysis does not have must not be restored */
  assert.match(tpl, /TABS\.some\(x=>x\[0\]===s\)/);
});
