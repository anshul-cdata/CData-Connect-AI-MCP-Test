/* 3.9 — orchestrator advice at the start of a run.
 *
 * The orchestrator is the session, so it can only be advised: orchestrator-advice.mjs classifies the
 * connector from what is on disk and suggests sonnet or opus; Step 0 compares the session's real model
 * and asks the user once when it is below. It never blocks, never suggests haiku, and a report built
 * without the new run_meta field is exactly what it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { orchestratorAdvice, belowSuggestion, familyOf, orchestratorLine, ADVICE_DEFAULTS } from '../scripts/lib/orchestrator.mjs';
import { capabilityReport } from '../scripts/lib/report-data.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (f, args) => { const r = spawnSync(process.execPath, [join(SK, 'scripts', f), ...args], { encoding: 'utf8' }); return { code: r.status ?? 1, out: String(r.stdout) + String(r.stderr) }; };
const K = n => ({ objects: Array.from({ length: n }, (_, i) => ({ name: `T${i}` })) });
const caps = (n, kind = undefined, areas = 3) => ({ source: { title: 'X', ...(kind ? { kind } : {}) }, areas: Array.from({ length: areas }, (_, i) => ({ id: `A${i}`, name: `Area ${i}` })),
  capabilities: Array.from({ length: n }, (_, i) => ({ id: `C${i}` })) });

test('classification: spec, no vendor API and assembled lists → sonnet; large platforms and wide sessions → opus', () => {
  const adv = x => orchestratorAdvice(x, {});
  assert.equal(adv({}).suggested, null, 'nothing on disk yet');
  assert.deepEqual([adv({ knowledge: K(50), capsDoc: caps(120) }).suggested, adv({ knowledge: K(50), capsDoc: caps(120) }).type], ['sonnet', 'spec']);
  assert.deepEqual([adv({ knowledge: K(80) }).suggested, adv({ knowledge: K(80) }).type], ['sonnet', 'no_vendor_api'], 'a database or files: the connector\'s own metadata');
  assert.equal(adv({ knowledge: K(80), capsDoc: caps(200, 'reference_docs') }).suggested, 'sonnet', 'the assembly is scripted and done by agents');
  /* thresholds: strictly more than */
  assert.equal(adv({ knowledge: K(ADVICE_DEFAULTS.max_tables), capsDoc: caps(10) }).suggested, 'sonnet');
  assert.equal(adv({ knowledge: K(ADVICE_DEFAULTS.max_tables + 1), capsDoc: caps(10) }).suggested, 'opus');
  assert.equal(adv({ knowledge: K(ADVICE_DEFAULTS.max_tables + 1) }).type, 'large_platform', 'a large database is still a large platform');
  assert.equal(adv({ knowledge: K(10), capsDoc: caps(ADVICE_DEFAULTS.max_capabilities + 1) }).suggested, 'opus');
  assert.equal(adv({ knowledge: K(10), capsDoc: caps(10, 'spec', ADVICE_DEFAULTS.max_areas + 1) }).suggested, 'opus');
  assert.equal(adv({ knowledge: K(10), capsDoc: caps(10), scopeAreas: ADVICE_DEFAULTS.max_areas_per_session }).suggested, 'sonnet');
  const wide = adv({ knowledge: K(10), capsDoc: caps(10), scopeAreas: ADVICE_DEFAULTS.max_areas_per_session + 1 });
  assert.equal(wide.suggested, 'opus');
  assert.match(wide.reasons[0], /5 business areas researched in one session/);
  /* thresholds come from config */
  assert.equal(orchestratorAdvice({ knowledge: K(150), capsDoc: caps(10) }, { max_tables: 100 }).suggested, 'opus');
  /* never haiku, whatever the input */
  for (const x of [{}, { knowledge: K(1) }, { knowledge: K(5000), capsDoc: caps(5000, 'sdk', 40), scopeAreas: 40 }]) assert.ok([null, 'sonnet', 'opus'].includes(adv(x).suggested));
});

test('an assembled list: opus only when judgement is left on the orchestrator, and it says which', () => {
  const api = n => ({ info: { 'x-assembled': { rung: 'reference_docs', review: { tables_without_operations: Array.from({ length: n }, (_, i) => `T${i}`) } } } });
  const many = orchestratorAdvice({ knowledge: K(100), capsDoc: caps(150, 'reference_docs'), api: api(ADVICE_DEFAULTS.max_unmatched_tables + 5) });
  assert.equal(many.suggested, 'opus');
  assert.match(many.reasons[0], /30 connector tables have no documented operation/);
  const few = orchestratorAdvice({ knowledge: K(100), capsDoc: caps(150, 'reference_docs'), api: api(3),
    inventory: { pages: [{ status: 'pending' }, { status: 'saved' }, { status: 'extracted' }] } });
  assert.equal(few.suggested, 'sonnet');
  assert.match(few.judgement[0], /2 reference page\(s\) still to read or exclude \(light/, 'light judgement is named, not escalated');
});

test('session model against the suggestion: families, never below on an unknown family', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('claude-sonnet-5-5'), 'sonnet');
  assert.equal(belowSuggestion('claude-sonnet-5-5', 'opus'), true);
  assert.equal(belowSuggestion('claude-haiku-5-5', 'sonnet'), true);
  assert.equal(belowSuggestion('claude-opus-5-5', 'sonnet'), false);
  assert.equal(belowSuggestion('claude-fable-5-1', 'opus'), false, 'an unknown family is not called below');
  assert.equal(belowSuggestion('claude-sonnet-5-5', null), false);
  assert.equal(orchestratorLine({ actual: 'claude-sonnet-5-5', suggested: 'opus', reasons: ['a large platform: 1880 tables'] }), 'claude-sonnet-5-5 (suggested opus — a large platform: 1880 tables)');
  assert.equal(orchestratorLine(null), null);
});

const root = mkdtempSync(join(tmpdir(), 'cqa-orch-'));
const dir = join(root, 'Erp');
mkdirSync(dir, { recursive: true });
const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
const J = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));

test('CLI: advise once, record in run_meta (or pending before Stage 1), never block', () => {
  /* before Stage 1: nothing to classify, a pending record */
  let r = cli('orchestrator-advice.mjs', ['--dir', dir, '--model', 'claude-sonnet-5-5', '--record']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing discovered yet/);
  assert.ok(existsSync(join(dir, '_agent_out', 'orchestrator.json')));
  /* after Stage 1.5: a large platform */
  W('Erp_knowledge.json', { connector: 'Erp', run_meta: { run_id: 'r1' }, ...K(450) });
  W('Erp_capabilities.json', caps(300));
  r = cli('orchestrator-advice.mjs', ['--dir', dir, '--model', 'claude-sonnet-5-5']);
  assert.equal(r.code, 0, 'advice never blocks');
  assert.match(r.out, /ADVISE {2}This connector looks like a large platform .*; Opus is suggested as orchestrator \(a large platform: 450 tables \(more than 400\)\); you are on Sonnet\. Continue or switch\?/);
  r = cli('orchestrator-advice.mjs', ['--dir', dir, '--model', 'claude-sonnet-5-5', '--record']);
  const o = J('Erp_knowledge.json').run_meta.orchestrator;
  assert.deepEqual([o.actual, o.family, o.suggested, o.type, o.below, o.told], ['claude-sonnet-5-5', 'sonnet', 'opus', 'large_platform', true, true]);
  assert.equal(J('Erp_knowledge.json').run_meta.run_id, 'r1', 'the rest of run_meta is kept');
  r = cli('orchestrator-advice.mjs', ['--dir', dir, '--model', 'claude-sonnet-5-5']);
  assert.match(r.out, /OK {2}already told the user/, 'the user is told once');
  r = cli('orchestrator-advice.mjs', ['--dir', dir, '--model', 'claude-opus-5-5']);
  assert.match(r.out, /OK {2}the session model meets the suggestion/);
  assert.match(cli('orchestrator-advice.mjs', ['--dir', dir, '--model', 'claude-sonnet-5-5', '--areas', 'A0,A1']).out, /suggested: opus/);
  assert.equal(cli('orchestrator-advice.mjs', ['--dir', dir, '--record']).code, 2, '--record needs the session model');
});

/* reports: the run details line, only when run_meta has it */
function renderRun(file) {
  const html = readFileSync(file, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const app = { innerHTML: '', addEventListener() {}, querySelectorAll: () => [] };
  new Function('document', 'localStorage', 'window', js)({ getElementById: id => id === 'app' ? app : null }, { getItem: k => k === 'cap-tab' ? 'run' : null, setItem() {} }, { scrollTo() {} });
  return app.innerHTML;
}
test('reports: "Orchestrator: <actual> (suggested <x>, reason)" in run details; absent field → no row', () => {
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  const h = renderRun(join(dir, 'Erp_analysis_report.html'));
  assert.match(h, /<dt>Orchestrator<\/dt><dd>claude-sonnet-5-5 <span class="muted">\(suggested opus, a large platform: 450 tables \(more than 400\)\)<\/span><\/dd>/);
  const kn = J('Erp_knowledge.json'); delete kn.run_meta.orchestrator; W('Erp_knowledge.json', kn);
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  assert.doesNotMatch(renderRun(join(dir, 'Erp_analysis_report.html')), /Orchestrator/);
  /* a stored run's manifest carries it to the capability report's data; one without it adds nothing */
  const base = { connector: 'Erp', run_id: 'r1', model: 'sonnet', finished_at: '2026-10-08T00:00:00Z', fingerprint: {} };
  const withO = capabilityReport({ manifest: { ...base, orchestrator: { actual: 'claude-opus-5-5', suggested: 'opus' } }, records: [], capsDoc: caps(3), catalog: null, knowledge: null });
  assert.equal(withO.run.orchestrator.actual, 'claude-opus-5-5');
  const without = capabilityReport({ manifest: base, records: [], capsDoc: caps(3), catalog: null, knowledge: null });
  assert.ok(!('orchestrator' in without.run), 'no new key in a report without the field');
});
