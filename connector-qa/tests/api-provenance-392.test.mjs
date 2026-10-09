/* 3.9.2 — an API list assembled without evidence is found, rebuilt, and said.
 *
 * QuickBooks Online ran on 3.9.0 with a hand-built <C>_api.json from before 3.9: no info.x-assembled,
 * no page or quoted line per operation. A capability list existed, so the router moved on, the
 * orchestrator advice called it a spec, and the analysis report rested on it. Now: a published spec is
 * never flagged; a hand-built one routes to 1.5a; the rebuild keeps reviewed mappings and frozen areas,
 * lists what changed and flags (never unfreezes) the frozen areas it touches; the advice says
 * "assembled (unverified)"; the reports say so in their header note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { apiProvenance, capabilityDiff, frozenAreasReferencing, UNVERIFIED_NOTE } from '../scripts/lib/api-provenance.mjs';
import { toOpenApi } from '../scripts/lib/api-docs.mjs';
import { orchestratorAdvice } from '../scripts/lib/orchestrator.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (f, args) => { const r = spawnSync(process.execPath, [join(SK, 'scripts', f), ...args], { encoding: 'utf8' }); return { code: r.status ?? 1, out: String(r.stdout) + String(r.stderr) }; };
const route = dir => JSON.parse(cli('detect-stage.mjs', ['--dir', dir]).out.trim().split('\n').pop());

/* a vendor OpenAPI as published: responses and schemas */
const published = { openapi: '3.0.0', info: { title: 'Demo API', version: '1' },
  paths: { '/tasks': { get: { operationId: 'getTasks', responses: { 200: { description: 'ok' } } }, post: { operationId: 'createTask', responses: { 201: { description: 'ok' } } } } },
  components: { schemas: { Task: { type: 'object' } } } };
/* hand-built before 3.9: OpenAPI-shaped, no responses, no evidence, and it says how it was made */
const handBuilt = { openapi: '3.0.0', info: { title: 'Demo API v1 (assembled from reference docs)', version: '1', description: 'No OpenAPI published by the vendor.' },
  paths: { '/tasks': { get: { operationId: 'getTasks', summary: 'Query Task', tags: ['Task'] }, post: { operationId: 'createTask', summary: 'Create Task', tags: ['Task'] } } } };
const yamlPublished = `openapi: 3.0.0
info:
  title: Asana-like
  version: '1.0'
paths:
  /tasks:
    get:
      operationId: getTasks
      responses:
        '200':
          description: ok
components:
  schemas:
    Task:
      type: object
`;
const evidenced = (ops, rung = 'reference_docs') => toOpenApi(ops.map(([operation, method, path]) => ({ entity: 'Task', operation, method, path,
  doc_url: 'https://docs.example.com/task', evidence: `${method} ${path}` })), { title: 'Demo API (assembled from reference pages)', rung, pages: 1 });

test('detection: a published spec is never flagged — JSON, YAML, or slimmed to its paths', () => {
  assert.equal(apiProvenance(JSON.stringify(published)).status, 'published');
  assert.equal(apiProvenance(published).status, 'published', 'parsed or text');
  assert.equal(apiProvenance(yamlPublished).status, 'published');
  /* two vendor specs combined with their responses dropped (MailChimp): shape alone never decides */
  const slim = { openapi: '3.0.0', info: { title: 'Marketing API + Transactional API (combined)', version: '1' }, paths: { '/lists': { get: { operationId: 'getLists' } } } };
  assert.equal(apiProvenance(slim).status, 'published');
  /* a vendor description that merely uses the word */
  assert.equal(apiProvenance({ ...published, info: { title: 'Orders API', description: 'Orders are assembled by the warehouse before shipping.' } }).status, 'published');
  assert.equal(apiProvenance(published, { capabilitySpec: { source: 'vendor_openapi' } }).status, 'published');
  assert.equal(apiProvenance(null).status, 'none');
});

test('detection: hand-built lists are unverified, each sign named; x-assembled with evidence is clean', () => {
  const h = apiProvenance(JSON.stringify(handBuilt));
  assert.equal(h.status, 'unverified');
  assert.match(h.reasons[0], /its own title or description says it was not published by the vendor \("Demo API v1 \(assembled from reference docs\)"\)/);
  assert.match(h.reasons.at(-1), /none of its 2 operations declares its responses and it has no schemas/, 'the missing shape is named beside a sign');
  /* the run recorded reference pages, the file says nothing */
  const quiet = { ...handBuilt, info: { title: 'Demo API', version: '1' } };
  const r = apiProvenance(quiet, { capabilitySpec: { url: 'https://docs.example.com', source: 'reference_docs' } });
  assert.equal(r.status, 'unverified');
  assert.match(r.reasons[0], /run_meta\.capability_spec\.source "reference_docs"/);
  assert.equal(apiProvenance(quiet, { capsSource: { kind: 'reference_docs' } }).status, 'unverified', 'the list says assembled but records no assembly');
  assert.equal(apiProvenance(`openapi: 3.0.0\ninfo:\n  title: Demo (hand-built from the docs)\n  version: '1'\npaths:\n  /tasks:\n    get:\n      operationId: getTasks\n`).status, 'unverified', 'YAML too');
  /* 3.9 assembly: every operation has its page and line */
  const ok = evidenced([['Create', 'POST', '/v3/task'], ['Read', 'GET', '/v3/task/<id>']]);
  assert.deepEqual([apiProvenance(ok).status, apiProvenance(ok).rung], ['assembled', 'reference_docs']);
  assert.equal(apiProvenance(ok, { capabilitySpec: { source: 'reference_docs' } }).status, 'assembled', 'reference_docs WITH x-assembled is clean');
  delete Object.values(ok.paths)[0].post['x-evidence'];
  const bare = apiProvenance(ok);
  assert.equal(bare.status, 'unverified');
  assert.match(bare.reasons[0], /1 of 2 operation\(s\) carry no page or quoted line/);
  /* converted from a machine-readable form (Postman): no per-page evidence needed */
  const pm = toOpenApi([{ entity: 'Task', operation: 'Create', method: 'POST', path: '/tasks' }], { title: 'Demo', rung: 'postman', format: 'postman' });
  assert.equal(apiProvenance(pm).status, 'assembled');
});

test('rebuild diff: added, removed, moved; frozen areas referencing them are named', () => {
  const prev = [{ id: 'CAP-a', method: 'GET', path: '/a', kind: 'list', review: { by: 'm' } }, { id: 'CAP-b', method: 'POST', path: '/b', kind: 'create', review: { by: 'm' } },
    { id: 'CAP-c', method: 'GET', path: '/c', kind: 'list' }, { id: 'CAP-product_x', mapping: { status: 'product_only' } }];
  const fresh = [{ id: 'CAP-a', method: 'GET', path: '/a', kind: 'list' }, { id: 'CAP-b', method: 'POST', path: '/b?operation=update', kind: 'update' }, { id: 'CAP-d', method: 'GET', path: '/d', kind: 'get' }];
  assert.deepEqual(capabilityDiff(prev, fresh), { added: ['CAP-d'], removed: ['CAP-c'], moved: ['CAP-b'], kept_reviewed: 2 });
  const cat = { areas: { A1: { frozen: true }, A2: { frozen: false } }, use_cases: [
    { id: 'UC-1', area: 'A1', capabilities: ['CAP-a', 'CAP-c'] }, { id: 'UC-2', area: 'A1', capabilities: ['CAP-a'] }, { id: 'UC-3', area: 'A2', capabilities: ['CAP-c'] }] };
  assert.deepEqual(frozenAreasReferencing(cat, ['CAP-c', 'CAP-b']), [{ area: 'A1', use_cases: 1, capabilities: ['CAP-c'] }], 'only frozen areas, only the use cases that need them');
});

/* ── a connector in capability mode, with one frozen area ─────────────────── */
const root = mkdtempSync(join(tmpdir(), 'cqa-prov-'));
function connector(name, api, { spec = { url: 'https://docs.example.com/api', source: 'reference_docs' } } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, '_agent_out'), { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  const col = (n, role) => ({ name: n, role, important: true });
  W(`${name}_knowledge.json`, { connector: name, semantic_complete: true, run_meta: { run_id: 'r1', mode: 'capability', capability_spec: spec },
    connector_meta: { personas: [{ id: 'L', name: 'Lead' }] },
    objects: [{ name: 'Tasks', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('Completed', 'status'), col('DueOn', 'date')] }] });
  W(`${name}_api.json`, api);
  const reviewed = { status: 'exposed', exposure: [{ kind: 'table', name: 'Tasks', op: 'SELECT' }], confidence: 'reviewed', note: 'SELECT from Tasks' };
  W(`${name}_capabilities.json`, { source: { path: `${name}_api.json`, title: api.info.title, version: '1' },
    areas: [{ id: 'TM', name: 'Task management', personas: ['Lead'], flows: [{ id: 'TM1', name: 'Plan', capability_ids: ['CAP-gettasks', 'CAP-createtask'] }] }],
    capabilities: [
      { id: 'CAP-gettasks', label: 'Query Task', method: 'GET', path: '/tasks', kind: 'list', noun: 'tasks', mapping: reviewed, review: { by: 'opus' } },
      { id: 'CAP-createtask', label: 'Create Task', method: 'POST', path: '/tasks', kind: 'create', noun: 'tasks', mapping: { ...reviewed, exposure: [{ kind: 'table', name: 'Tasks', op: 'INSERT' }] }, review: { by: 'opus' } }] });
  const keys = ['simple', 'medium', 'complex', 'dates', 'aggregation', 'relationships', 'write', 'ambiguity', 'missing_info', 'limitation', 'persona:Lead'];
  W(`${name}_catalog.json`, { prefix: 'PV', mix_explained: keys.map(need => ({ area: 'TM', need, reason: 'a one use case test fixture' })), use_cases: [
    { area: 'TM', persona: 'Lead', goal: 'see what is late', frequency: 'weekly', kind: 'question', difficulty: 'simple', tests: ['filters'],
      source: { kind: 'help_center', title: 'Overdue tasks', url: 'https://help.example.com/overdue' }, capabilities: ['CAP-gettasks', 'CAP-createtask'],
      request: 'Which of my tasks are overdue?', check: { rule: 'same_ids', key: 'Id', reference_sql: "SELECT [Id] FROM [Tasks] WHERE [Completed] = false AND [DueOn] < '{{today}}'" } }] });
  const D = ['--dir', dir];
  for (const [args, file, body] of [
    [['ids'], null, null],
    [['judge-merge', '--scores'], 'scores.json', { model: 'opus', scores: [{ id: 'UC-PV-0001', score: 5 }] }],
    [['sources-prep'], null, null],
    [['sources-merge', '--checks'], 'checks.json', { model: 'sonnet', checks: [{ url: 'https://help.example.com/overdue', status: 'found', title_seen: 'Overdue tasks' }] }],
    [['review-prep'], null, null],
    [['review-merge', '--review'], 'review.json', { model: 'opus', areas: [{ area: 'TM', verdict: 'complete', findings: [] }] }],
    [['freeze'], null, null],
  ]) {
    if (file) W(file, body);
    const r = cli('manage-catalog.mjs', [args[0], ...D, ...(file ? [args[1], join(dir, file)] : [])]);
    assert.equal(r.code, 0, `${args[0]}: ${r.out}`);
  }
  return { dir, W, J: f => JSON.parse(readFileSync(join(dir, f), 'utf8')) };
}
function renderTab(file, tab) {
  const html = readFileSync(file, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const app = { innerHTML: '', addEventListener() {}, querySelectorAll: () => [] };
  new Function('document', 'localStorage', 'window', js)({ getElementById: id => id === 'app' ? app : null }, { getItem: k => k === 'cap-tab' ? tab : null, setItem() {} }, { scrollTo() {} });
  return app.innerHTML;
}

test('routing: a published spec moves on; a hand-built list routes to 1.5a with one reason and the frozen areas kept', () => {
  const pub = connector('Pub', published, { spec: { url: 'https://example.com/openapi.json', source: 'openapi' } });
  const p = route(pub.dir);
  assert.notEqual(p.stage, '1.5a', JSON.stringify(p));
  assert.equal(cli('capability-list.mjs', ['status', '--dir', pub.dir]).out.includes(UNVERIFIED_NOTE), false);

  const hb = connector('Hand', handBuilt);
  const r = route(hb.dir);
  assert.equal(r.stage, '1.5a');
  assert.match(r.reason, /^capability mode: API list assembled without evidence — rebuild with api-from-docs \(references\/10-capabilities\.md §1\.5a\)\. Why: /);
  assert.equal(r.reason.includes('\n'), false, 'one line');
  assert.deepEqual(r.frozen_areas, ['TM']);
  assert.match(r.next, /frozen areas stay frozen \(TM\)/);
  const st = cli('capability-list.mjs', ['status', '--dir', hb.dir]);
  assert.equal(st.code, 3, st.out);
  assert.match(st.out, /rebuild it with api-from-docs\.mjs, or keep it with --keep-unverified/);
});

test('rebuild: reviewed mappings kept for matching ids, changes listed for 1.5c, the frozen area flagged — never unfrozen', () => {
  const { dir, W, J } = connector('Rb', handBuilt);
  const catBefore = readFileSync(join(dir, 'Rb_catalog.json'), 'utf8');
  /* rebuilt with api-from-docs: getTasks keeps its id, createTask now documented as POST …?operation=create, a new delete, and no more … */
  const rebuilt = toOpenApi([
    { entity: 'Task', operation: 'Get', method: 'GET', path: '/tasks', operation_id: 'getTasks', kind: 'list', doc_url: 'https://docs.example.com/task', evidence: 'GET /tasks' },
    { entity: 'Task', operation: 'Delete', method: 'POST', path: '/tasks?operation=delete', kind: 'delete', doc_url: 'https://docs.example.com/task', evidence: 'POST /tasks?operation=delete' },
  ], { title: 'Demo API (assembled from reference pages)', rung: 'reference_docs', pages: 1 });
  W('Rb_api.json', rebuilt);
  const rd = cli('capability-list.mjs', ['read', '--dir', dir, '--spec', join(dir, 'Rb_api.json')]);
  assert.equal(rd.code, 0, rd.out);
  assert.match(rd.out, /1 reviewed mapping\(s\) kept · 1 added · 1 removed · 0 moved/);
  assert.match(rd.out, /added — map, then review only these in 1\.5c: CAP-deletetask/);
  assert.match(rd.out, /⚠ frozen area TM: 1 use case\(s\) need a removed or moved capability \(CAP-createtask\) — flagged, not unfrozen/);
  const caps = J('Rb_capabilities.json');
  assert.equal(caps.capabilities.find(c => c.id === 'CAP-gettasks').review.by, 'opus', 'reviewed mapping kept');
  assert.deepEqual(caps.areas[0].flows[0].capability_ids, ['CAP-gettasks'], 'removed id leaves its flow; the rest of the grouping stays');
  assert.deepEqual([caps.rebuild.added, caps.rebuild.removed, caps.rebuild.moved], [['CAP-deletetask'], ['CAP-createtask'], []]);
  assert.equal(caps.source.kind, 'reference_docs');
  assert.equal(readFileSync(join(dir, 'Rb_catalog.json'), 'utf8'), catBefore, 'the catalog is not touched: TM stays frozen');
  /* the router: no longer 1.5a; 1.5 names only the changed ones, the frozen area is a warning */
  const r = route(dir);
  assert.equal(r.stage, 1.5);
  assert.match(r.reason, /the API list rebuild added 1 and moved 0 — review only those/);
  assert.ok(r.warnings.some(w => /^frozen area TM: 1 use case\(s\) need a capability the API list rebuild removed or moved \(CAP-createtask\) — check them; the area stays frozen/.test(w)), JSON.stringify(r.warnings));
  const st = cli('capability-list.mjs', ['status', '--dir', dir]);
  assert.doesNotMatch(st.out, /assembled without evidence/);
  assert.match(st.out, /rebuilt \d{4}-\d\d-\d\d from "Demo API v1 \(assembled from reference docs\)": 1 added · 1 removed · 0 moved/);
});

test('keep-unverified: recorded with its reason, the router moves on, the report still says it', () => {
  const { dir, J } = connector('Kept', handBuilt);
  assert.equal(cli('capability-list.mjs', ['status', '--dir', dir, '--keep-unverified', 'x']).code, 2, 'a reason in a few words');
  const st = cli('capability-list.mjs', ['status', '--dir', dir, '--keep-unverified', 'no reference pages can be read']);
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /kept knowingly \d{4}-\d\d-\d\d: no reference pages can be read/);
  assert.equal(J('Kept_capabilities.json').source.unverified_kept.why, 'no reference pages can be read');
  assert.notEqual(route(dir).stage, '1.5a');
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  assert.match(renderTab(join(dir, 'Kept_analysis_report.html'), 'summary'), /API list assembled without evidence — rebuild with api-from-docs\..*Kept knowingly: no reference pages can be read\./s);
});

test('orchestrator advice: an unverified list is "assembled (unverified)", not "spec"', () => {
  const capsDoc = { source: { title: 'X' }, areas: [{ id: 'A' }], capabilities: [{ id: 'C1' }] };
  assert.equal(orchestratorAdvice({ knowledge: { objects: [] }, capsDoc }).type, 'spec', 'unchanged without the state');
  const adv = orchestratorAdvice({ knowledge: { objects: [] }, capsDoc, apiState: { status: 'unverified' } });
  assert.deepEqual([adv.type, adv.suggested], ['assembled_unverified', 'sonnet']);
  assert.match(adv.reasons[0], /assembled without evidence; it is rebuilt with api-from-docs\.mjs first/);
  const { dir } = connector('Adv', handBuilt);
  const out = cli('orchestrator-advice.mjs', ['--dir', dir]).out;
  assert.match(out, /suggested: sonnet · a source whose API list is assembled \(unverified\)/);
  assert.match(out, /API list assembled \(unverified\): .* — detect-stage routes to 1\.5a/);
  const pub = connector('AdvPub', published, { spec: { source: 'openapi' } });
  assert.match(cli('orchestrator-advice.mjs', ['--dir', pub.dir]).out, /a source with a machine-readable API description/);
});

test('reports: built on an unverified list, the header note says so; on a published spec, nothing changes', () => {
  const { dir } = connector('Rep', handBuilt);
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  const html = readFileSync(join(dir, 'Rep_analysis_report.html'), 'utf8');
  assert.match(html, /"unverified":\{"reasons":\[/);
  const s = renderTab(join(dir, 'Rep_analysis_report.html'), 'summary');
  assert.match(s, /API list unverified/, 'header chip');
  assert.match(s, /<b>API list assembled without evidence — rebuild with api-from-docs\.<\/b>/, 'header note');
  assert.match(renderTab(join(dir, 'Rep_analysis_report.html'), 'run'), /API list assembled without evidence — rebuild with api-from-docs\./, 'run details');
  const pub = connector('RepPub', published, { spec: { source: 'openapi' } });
  assert.equal(cli('build-capability-report.mjs', ['--dir', pub.dir, '--root', root, '--analysis']).code, 0);
  const ph = readFileSync(join(pub.dir, 'RepPub_analysis_report.html'), 'utf8');
  assert.doesNotMatch(ph, /"unverified":/);
  assert.doesNotMatch(renderTab(join(pub.dir, 'RepPub_analysis_report.html'), 'summary'), /API list unverified|assembled without evidence/);
});
