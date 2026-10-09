/* The 3.0 pipeline end to end: capability list → catalog → plan → journeys → store → reports → eval.
 *
 * "Can I do through CData what the source can do?" is only answerable if every link holds: the
 * source's own API is the denominator, use cases come from an approved catalog, each journey is
 * captured in full and checked against data, results are stored so an eval can reuse them, and
 * both reports render from the store alone. This drives all of it on a small Asana-shaped
 * fixture, with simulated agent returns standing in for Stage 9, and executes the reports' own
 * page scripts to prove every tab renders without "undefined" or "NaN".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });
const exitOf = (s, args) => { try { run(s, args); return 0; } catch (e) { return e.status; } };

const ROOT = process.env.CQA_KEEP || mkdtempSync(join(tmpdir(), 'cqa-v3-'));
const dir = join(ROOT, 'Demo');
mkdirSync(join(dir, '_agent_out'), { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
/* Stage 9 files go under _agent_out/<run id>/, so one model's journeys never overwrite another's */
const A = (runId, f, o) => { mkdirSync(join(dir, '_agent_out', runId), { recursive: true }); writeFileSync(join(dir, '_agent_out', runId, f), JSON.stringify(o, null, 2)); };
const R = f => JSON.parse(readFileSync(P(f), 'utf8'));

/* ── fixture connector ─────────────────────────────────────────────────── */
const col = (name, role) => ({ name, role, important: true });
const objs = [
  { name: 'Tasks', remarks: 'Tasks assigned in the workspace. To Create, Update and Query', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('AssigneeName', 'descriptive'), col('Completed', 'status'), col('DueOn', 'date'), col('ProjectId', 'relationship_key')] },
  { name: 'Projects', remarks: 'Projects in the workspace. To Query', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('Archived', 'status'), col('DueOn', 'date')] },
  { name: 'Users', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('Email', 'descriptive')] },
].map(o => ({ type: 'TABLE', tier: 'T1', category: 'core', columns_loaded: true, business_meaning: { v: o.name, confidence: 'FACT', source: 'vendor_docs' }, ...o }));
W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
  instructions_raw: 'Catalog is Demo1. Schema is Demo.',
  run_meta: { run_id: 'r-sonnet', started_at: '2026-10-01T00:00:00Z', models: { under_test: 'sonnet' }, connector_build: '24.0.1', mcp_server: 'mcp_demo', workspace: '9001' },
  connector_meta: { app: 'Demo', workflow_domains: [], personas: [{ id: 'IC', name: 'Individual Contributor', archetype: 'doer' }], roles: [] },
  physical: { procedures: [{ name: 'AddFollowers', required_params: ['TaskId', 'Followers'] }], permissions: { select: true, insert: true, update: true, delete: false } },
  objects: objs, relationships: [] });
W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: 3, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) }, views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: [] }, relationships: { rows: [] }, use_cases: { rows: [] },
  patterns: { rows: [{ pattern: 'select_projection', applicable: true, state: 'uncovered', tc_ids: [] }] }, intents: { rows: [] }, behaviors: { rows: [] } });
run('compute-gaps.mjs', ['--knowledge', P('Demo_knowledge.json'), '--coverage', P('Demo_coverage.json'), '--out', P('Demo_gaps.json')]);
{ const G = R('Demo_gaps.json'); for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 100); g.business_importance = 'HIGH'; } W('Demo_gaps.json', G); }
run('score-gaps.mjs', ['--gaps', P('Demo_gaps.json'), '--knowledge', P('Demo_knowledge.json')]);

const SPEC = { openapi: '3.0.0', info: { title: 'Demo API', version: '1.0' }, paths: {
  '/tasks': { get: { operationId: 'getTasks', summary: 'Get multiple tasks', tags: ['Tasks'] }, post: { operationId: 'createTask', summary: 'Create a task', tags: ['Tasks'], requestBody: {} } },
  '/tasks/{task_gid}': { get: { operationId: 'getTask', summary: 'Get a task', tags: ['Tasks'] }, delete: { operationId: 'deleteTask', summary: 'Delete a task', tags: ['Tasks'] } },
  '/tasks/{task_gid}/addFollowers': { post: { operationId: 'addFollowersForTask', summary: 'Add followers to a task', tags: ['Tasks'] } },
  '/projects': { get: { operationId: 'getProjects', summary: 'Get multiple projects', tags: ['Projects'] } },
  '/project_briefs/{project_brief_gid}': { get: { operationId: 'getProjectBrief', summary: 'Get a project brief', tags: ['Project briefs'] } },
  '/webhooks': { post: { operationId: 'createWebhook', summary: 'Establish a webhook', tags: ['Webhooks'] } },
} };
W('spec.json', SPEC);

/* ── Stage 1.5 ─────────────────────────────────────────────────────────── */
test('the capability list comes from the source API, and gaps are found without running anything', () => {
  run('capability-list.mjs', ['read', '--dir', dir, '--spec', P('spec.json')]);
  assert.equal(exitOf('capability-list.mjs', ['map', '--dir', dir]), 3, 'unreviewed low-confidence mappings and no areas must block the catalog');
  const caps = R('Demo_capabilities.json').capabilities;
  const st = id => caps.find(c => c.id === id).mapping.status;
  assert.equal(st('CAP-gettasks'), 'exposed');
  assert.equal(st('CAP-createtask'), 'exposed');
  assert.equal(st('CAP-deletetask'), 'not_exposed', 'the connector does not advertise DELETE');
  assert.equal(st('CAP-addfollowersfortask'), 'exposed');
  assert.equal(st('CAP-getprojectbrief'), 'not_exposed');
  assert.equal(st('CAP-createwebhook'), 'not_applicable');
  W('review.json', { model: 'opus',
    mappings: [{ id: 'CAP-getprojectbrief', status: 'not_exposed', note: 'no table for project briefs' }],
    product_only: [{ id: 'CAP-product_forms', label: 'Read form questions and branching', note: 'forms exist only in the web app' }],
    areas: [{ id: 'TM', name: 'Task management', personas: ['Individual Contributor'], related: ['PP'],
              capability_ids: ['CAP-gettasks', 'CAP-createtask', 'CAP-gettask', 'CAP-deletetask', 'CAP-addfollowersfortask'] },
            { id: 'PP', name: 'Projects', personas: ['Individual Contributor'], related: ['TM'],
              capability_ids: ['CAP-getprojects', 'CAP-getprojectbrief', 'CAP-product_forms'] }] });
  assert.equal(exitOf('capability-list.mjs', ['apply', '--dir', dir, '--review', P('review.json')]), 0);
});

/* ── Stage 2.5 ─────────────────────────────────────────────────────────── */
const UC = (o) => ({ persona: 'Individual Contributor', goal: 'get through the day', area: 'TM', frequency: 'daily',
  difficulty: 'simple', tests: o.kind === 'action' ? ['write'] : ['filters'],
  source: { kind: 'help_center', title: 'Using My Tasks', url: 'https://help.example.com/my-tasks' }, ...o });
/* a three-use-case fixture cannot reach the mix floors — the writer says why, which is what counts */
const MIX_KEYS = ['simple', 'medium', 'complex', 'dates', 'aggregation', 'relationships', 'write', 'ambiguity', 'missing_info', 'limitation', 'persona:Individual Contributor'];
const EXPLAIN = ['TM', 'PP'].flatMap(area => MIX_KEYS.map(need => ({ area, need, reason: 'a tiny test fixture with one flow' })));
/* what the research says has no business use on its own, with the reason — counted as explained */
const NO_USE = [
  { capability_id: 'CAP-gettask', reason: 'reading one task by id is a step inside other flows, never asked for alone' },
  { capability_id: 'CAP-deletetask', reason: 'people complete tasks rather than delete them in normal work' },
  { capability_id: 'CAP-addfollowersfortask', reason: 'adding followers happens inside the handoff flow already covered' },
  { capability_id: 'CAP-getprojects', reason: 'listing projects is a navigation step inside the brief use case' },
  { capability_id: 'CAP-product_forms', reason: 'forms are only used inside the web app by requesters' },
];
test('a catalog cannot be frozen until it is valid, judged and human-reviewed', () => {
  W('Demo_catalog.json', { prefix: 'DMO', no_business_use: NO_USE, mix_explained: EXPLAIN, use_cases: [
    UC({ request: 'Which of my tasks are overdue?', kind: 'question', capabilities: ['CAP-gettasks'],
         check: { rule: 'same_ids', key: 'Id', reference_sql: "SELECT [Id] FROM [Tasks] WHERE [Completed] = false AND [DueOn] < '2026-10-01'" } }),
    UC({ request: 'Create a task for Priya to send the launch checklist, due this Friday.', kind: 'action', capabilities: ['CAP-createtask'],
         check: { rule: 'write_visible', expect: { Name: 'Send the launch checklist' }, reference_sql: "SELECT [Name] FROM [Tasks] WHERE [Name] = 'Send the launch checklist'",
                  cleanup_sql: "DELETE FROM [Tasks] WHERE [Name] = 'Send the launch checklist'" } }),
    UC({ request: 'Show me the brief for the Website Relaunch project.', kind: 'question', area: 'PP', capabilities: ['CAP-getprojectbrief'], frequency: 'weekly',
         check: { rule: 'judge' } }),
    UC({ request: 'Show me each Tasks record together with its Projects.', kind: 'question', capabilities: ['CAP-gettasks'], check: { rule: 'judge' } }),
  ] });
  assert.equal(exitOf('manage-catalog.mjs', ['validate', '--dir', dir]), 3, 'a schema-leaking request must be refused');
  const cat = R('Demo_catalog.json'); cat.use_cases.pop(); W('Demo_catalog.json', cat);
  assert.equal(exitOf('manage-catalog.mjs', ['validate', '--dir', dir]), 0);
  run('manage-catalog.mjs', ['ids', '--dir', dir]);
  const ids = R('Demo_catalog.json').use_cases.map(u => u.id);
  assert.deepEqual(ids, ['UC-DMO-0001', 'UC-DMO-0002', 'UC-DMO-0003']);
  assert.equal(exitOf('manage-catalog.mjs', ['freeze', '--dir', dir]), 3, 'unjudged');
  W('scores.json', { model: 'opus', scores: ids.map(id => ({ id, score: 5 })) });
  run('manage-catalog.mjs', ['judge-merge', '--dir', dir, '--scores', P('scores.json')]);
  assert.equal(exitOf('manage-catalog.mjs', ['freeze', '--dir', dir]), 3, 'no human review, and no source checked');
  /* every cited page is opened before it counts as evidence */
  run('manage-catalog.mjs', ['sources-prep', '--dir', dir]);
  const toCheck = R('Demo_sources_to_check.json');
  assert.equal(toCheck.items.length, 1, 'one page, cited by three use cases');
  W('checks.json', { model: 'sonnet', checks: toCheck.items.map(i => ({ url: i.url, status: 'found', title_seen: 'Using My Tasks' })) });
  run('manage-catalog.mjs', ['sources-merge', '--dir', dir, '--checks', P('checks.json')]);
  run('manage-catalog.mjs', ['sample', '--dir', dir, '--n', '3']);
  const csv = readFileSync(P('Demo_catalog_review.csv'), 'utf8').trim().split('\n');
  W('ratings.csv', [csv[0], ...csv.slice(1).map(l => l.replace(/,5,,$/, ',5,4,"looks real"'))].join('\n'));
  run('manage-catalog.mjs', ['human-merge', '--dir', dir, '--ratings', P('ratings.csv')]);
  assert.equal(exitOf('manage-catalog.mjs', ['freeze', '--dir', dir]), 3, 'no coverage review of the whole area yet');
  run('manage-catalog.mjs', ['review-prep', '--dir', dir]);
  assert.equal(R('Demo_catalog_coverage_input.json').areas.length, 2);
  W('review.json', { model: 'opus', areas: [{ area: 'TM', verdict: 'complete', findings: [] }, { area: 'PP', verdict: 'complete', findings: [] }] });
  run('manage-catalog.mjs', ['review-merge', '--dir', dir, '--review', P('review.json')]);
  assert.equal(exitOf('manage-catalog.mjs', ['freeze', '--dir', dir]), 0);
  const frozen = R('Demo_catalog.json');
  assert.equal(frozen.version, 1);
  assert.ok(frozen.frozen && frozen.hash);
  assert.equal(frozen.areas.TM.version, 1);
  assert.equal(frozen.areas.PP.version, 1);
});

/* ── Stage 8 ───────────────────────────────────────────────────────────── */
let plan;
test('the plan takes its business suite from the frozen catalog', () => {
  try { run('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo', '--allow-thin']); } catch { /* the thin gate may fire on a tiny fixture */ }
  plan = R('Demo_plan.json');
  const biz = plan.tc_list.filter(t => t.suite === 'business');
  assert.equal(biz.length, 3);
  assert.ok(biz.every(t => t.use_case_id && t.prompt_status === 'approved' && t.realism?.judged_prompt === t.prompt));
  /* 3.6: a use case the connector cannot do is put to the agent once, as a limitation probe */
  const brief = biz.find(t => t.use_case_id === 'UC-DMO-0003');
  assert.equal(brief.executable, true);
  assert.equal(brief.probe, 'limitation');
  assert.equal(brief.attempts, 1);
  assert.equal(brief.check.rule, 'judge');
  assert.match(brief.not_possible_reason, /Not possible through the connector/);
  const overdue = biz.find(t => t.use_case_id === 'UC-DMO-0001');
  assert.equal(overdue.attempts, 3, 'a daily use case is P1 and runs three attempts');
  const act = biz.find(t => t.use_case_id === 'UC-DMO-0002');
  assert.equal(act.mutates, true);
  /* 3.7: ConnectAI MCP runs no DELETE, so a DELETE cleanup does not make an action reversible —
   * only an UPDATE that restores the record, or a delete procedure, does */
  assert.equal(act.reversible, false, 'a DELETE cleanup cannot run through ConnectAI MCP');
  assert.equal(JSON.parse(run('detect-stage.mjs', ['--dir', dir, '--connector', 'Demo'])).stage, 9, 'approved catalog prompts need no rewrite or re-judging');
});

test('the write gate prints every cleanup statement, and stops one that could touch other records', () => {
  const out = run('preflight-writes.mjs', ['--dir', dir, '--connector', 'Demo']);
  assert.match(out, /cleanup after each attempt \(1\)/);
  assert.match(out, /DELETE FROM \[Tasks\] WHERE \[Name\] = 'Send the launch checklist'/);
  const bad = JSON.parse(JSON.stringify(plan));
  bad.tc_list.find(t => t.use_case_id === 'UC-DMO-0002').check.cleanup_sql = 'DELETE FROM [Tasks]';
  W('bad_plan.json', bad);
  assert.equal(exitOf('preflight-writes.mjs', ['--dir', dir, '--connector', 'Demo', '--plan', P('bad_plan.json')]), 3);
});

/* ── Stage 9 (simulated) ───────────────────────────────────────────────── */
const tcOf = id => plan.tc_list.find(t => t.use_case_id === id).id;
function simulate(kind, runId) {
  const ov = tcOf('UC-DMO-0001'), cr = tcOf('UC-DMO-0002');
  const good = { calls: [
    { tool: 'getTables', input: { catalog: 'Demo1' }, result: 'Tasks, Projects, Users' },
    { tool: 'queryData', input: { query: "SELECT [Id],[Name] FROM [Demo1].[Demo].[Tasks] WHERE [Completed] = false AND [DueOn] < '2026-10-01'", llmContext: '{"reason":"my overdue tasks"}' }, result: '2 rows', rows: 2, ms: 1200 },
  ], final_rows: [{ Id: '11', Name: 'A' }, { Id: '12', Name: 'B' }], answer: 'You have 2 overdue tasks.', wall_ms: 2000, tokens: 6000 };
  const rough = { calls: [
    { tool: 'queryData', input: { query: 'SELECT * FROM [Demo].[Demo].[Tasks]' }, error: "STMT The catalog 'Demo' either does not exist or is inaccessible." },
    { tool: 'getCatalogs', input: {}, result: 'Demo1' },
    { tool: 'queryData', input: { query: 'SELECT * FROM [Demo1].[Demo].[Tasks]' }, error: 'Query timed out after 30 seconds' },
    { tool: 'queryData', input: { query: "SELECT [Id] FROM [Demo1].[Demo].[Tasks] WHERE [Completed] = false" }, result: '3 rows', rows: 3 },
  ], final_rows: [{ Id: '11' }, { Id: '12' }, { Id: '13' }], answer: 'You have 3 overdue tasks.', wall_ms: 38000, tokens: 14000 };
  const j = kind === 'opus' ? good : rough;
  for (const n of [1, 2, 3]) {
    A(runId, `stage9-${ov}-a${n}.json`, n === 2 && kind !== 'opus' ? good : j);
    A(runId, `check-${ov}-a${n}.json`, { sql: 'ref', rows: [{ Id: '11' }, { Id: '12' }] });
  }
  /* a P1 action runs three times too, cleaned up between attempts; the orchestrator snapshots the
   * reference query before each attempt starts, and re-reads after */
  for (const n of [1, 2, 3]) {
    A(runId, `stage9-${cr}-a${n}.json`, { calls: [{ tool: 'queryData', input: { query: "INSERT INTO [Demo1].[Demo].[Tasks] ([Name]) VALUES ('Send the launch checklist')" }, result: '1 row inserted', rows: 1 }],
      final_rows: [], answer: 'Created.', wall_ms: 3000, tokens: 4000 });
    A(runId, `check-${cr}-a${n}.json`, { sql: 'reread', before_rows: [], rows: [{ Name: 'Send the launch checklist' }] });
  }
  /* the limitation probe: one honest attempt, judged */
  const lp = tcOf('UC-DMO-0003');
  A(runId, `stage9-${lp}-a1.json`, { calls: [{ tool: 'getTables', input: {}, result: 'Tasks, Projects, Users' }], final_rows: [],
    answer: 'I cannot do that through this connection: briefs are not available. I can list the tasks of the project instead.', wall_ms: 1500, tokens: 3000 });
  A(runId, `judge-${lp}-a1.json`, { outcome: 'correct', reason: 'It said plainly that this cannot be done and offered what it could.' });
  /* conformance checks report through the checkpoint, as before */
  writeFileSync(P('Demo_checkpoint.jsonl'), JSON.stringify({ type: 'meta', run_meta: { run_id: runId } }) + '\n' + plan.tc_list.filter(t => t.suite !== 'business').map(t => JSON.stringify({ type: 'tc', tc: { id: t.id, status: 'pass' } })).join('\n') + '\n');
}

test('journeys are scored and stored, attempts and all', () => {
  simulate('sonnet', 'r-sonnet');
  const warned = () => JSON.parse(run('detect-stage.mjs', ['--dir', dir, '--connector', 'Demo'])).warnings.join('\n');
  process.env.CONNECTOR_QA_ROOT = ROOT;
  assert.match(warned(), /run r-sonnet .* not in the results store/);
  assert.doesNotMatch(warned(), /unmerged agent result/, 'stage 1.5/5.5 evidence and journeys are not unmerged results');
  run('ingest-results.mjs', ['--dir', dir, '--root', ROOT, '--run', 'r-sonnet', '--model', 'sonnet']);
  assert.doesNotMatch(warned(), /r-sonnet/, 'ingested — no warning');
  delete process.env.CONNECTOR_QA_ROOT;
  const d = join(ROOT, '_results', 'Demo', 'r-sonnet');
  const man = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
  assert.equal(man.complete, true, JSON.stringify(man.outcomes));
  const recs = readFileSync(join(d, 'results.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const ov = recs.filter(r => r.use_case_id === 'UC-DMO-0001');
  assert.equal(ov.length, 3, 'three attempts stored');
  const a1 = ov.find(r => r.attempt === 1);
  assert.equal(a1.outcome, 'partial', 'returned one extra record');
  assert.deepEqual(a1.steps.filter(s => !s.ok).map(s => s.error_class), ['catalog_not_found', 'timeout']);
  assert.equal(a1.steps[1].recovery_of, 1, 'getCatalogs recovered from the catalog error');
  assert.ok(ov.find(r => r.attempt === 2).outcome === 'correct' && ov.find(r => r.attempt === 2).grade === 'blue');
  assert.equal(recs.find(r => r.use_case_id === 'UC-DMO-0002').outcome, 'correct', 'the write is visible on re-read');
  const lim = recs.find(r => r.use_case_id === 'UC-DMO-0003');
  assert.equal(lim.outcome, 'not_possible', 'still not possible for the business');
  assert.equal(lim.probe.outcome, 'correct', 'and the agent said so plainly');
  assert.equal(lim.score, null, 'a probe is not scored as a task');
});

/* run the report's own page script against a stub DOM and return what it rendered */
function renderTabs(file, storageKey, tabs) {
  const html = readFileSync(file, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const out = {};
  for (const t of tabs) {
    const app = { innerHTML: '', addEventListener() {}, querySelectorAll: () => [] };
    const doc = { getElementById: id => id === 'app' ? app : null };
    new Function('document', 'localStorage', 'window', js)(doc, { getItem: k => k === storageKey ? t : null, setItem() {} }, { scrollTo() {} });
    out[t] = app.innerHTML;
  }
  return out;
}
const clean = (html, where) => { assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, `${where} rendered a broken value`); };

test('the capability report renders every tab from the store alone', () => {
  run('build-capability-report.mjs', ['--dir', dir, '--root', ROOT, '--run', 'r-sonnet']);
  const f = P('Demo_capability_report.html');
  assert.ok(existsSync(f));
  const tabs = renderTabs(f, 'cap-tab', ['summary', 'usecases', 'gaps', 'areas', 'friction', 'fix', 'personas', 'driver', 'quality', 'run']);
  for (const [t, h] of Object.entries(tabs)) clean(h, `capability report · ${t}`);
  assert.match(tabs.summary, /things Demo's API can do/);
  assert.match(tabs.gaps, /Delete a task/);
  assert.match(tabs.gaps, /Not a CData gap/, 'product-only capabilities are not charged to the connector');
  assert.match(tabs.friction, /Catalog name not discoverable/);
  assert.match(tabs.usecases, /UC-DMO-0001/);
  /* 3.9: evidence pill and cited page on every card; sort and evidence filter; counts on the summary */
  const cards = (tabs.usecases.match(/<div class="uc">/g) || []).length;
  assert.equal((tabs.usecases.match(/class="pill ev-/g) || []).length, cards);
  assert.match(tabs.usecases, /<a class="pill src" href="https:\/\/help\.example\.com\/my-tasks"/);
  assert.match(tabs.usecases, /<select id="uc-ev">/);
  assert.match(tabs.usecases, /<select id="uc-sort"><option value="" selected>As listed<\/option>/);
  assert.match(tabs.summary, /By evidence<\/span>: \d+ vendor guidance\./);
});

test('a use case opens to its full detail: why it exists, the score, and every call the agent made', () => {
  const f = P('Demo_capability_report.html');
  const html = readFileSync(f, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const handlers = {};
  const app = { innerHTML: '', addEventListener(ev, fn) { handlers[ev] = fn; }, querySelectorAll: () => [] };
  new Function('document', 'localStorage', 'window', js)({ getElementById: id => id === 'app' ? app : null }, { getItem: () => null, setItem() {} }, { scrollTo() {} });
  const btn = { getAttribute: () => null, dataset: { uc: 'UC-DMO-0001' } };
  handlers.click({ target: { closest: () => btn } });
  clean(app.innerHTML, 'use case detail');
  assert.match(app.innerHTML, /Why this use case exists/);
  /* 3.7.2: the page answers the reader's questions in plain words */
  assert.match(app.innerHTML, /Every call the AI made/);
  assert.match(app.innerHTML, /All of these were made by the AI itself/);
  assert.match(app.innerHTML, /How do we know the answer is correct\?/);
  assert.match(app.innerHTML, /How many times did we ask\?/);
  assert.match(app.innerHTML, /Why is the score/);
  assert.doesNotMatch(app.innerHTML, /Rule <b>same_ids/, 'no rule codes');
  assert.match(app.innerHTML, /getCatalogs/, 'the recovery call is shown');
  assert.match(app.innerHTML, /SELECT \[Id\] FROM \[Tasks\]/, 'the reference query is shown');
  assert.match(app.innerHTML, /Correct in 1 of 3/);
});

test('a review with a status outside the vocabulary is refused, and nothing is applied', () => {
  const before = readFileSync(P('Demo_capabilities.json'), 'utf8');
  W('bad-review.json', { model: 'opus', mappings: [{ id: 'CAP-gettasks', status: 'maybe' }], areas: [] });
  assert.notEqual(exitOf('capability-list.mjs', ['apply', '--dir', dir, '--review', P('bad-review.json')]), 0);
  assert.equal(readFileSync(P('Demo_capabilities.json'), 'utf8'), before);
});

test('a catalog edited after freezing is refused for planning and for an eval', () => {
  const good = readFileSync(P('Demo_catalog.json'), 'utf8'), planBefore = readFileSync(P('Demo_plan.json'), 'utf8');
  const cat = JSON.parse(good); cat.use_cases[0].request = 'Which of my tasks are late?'; W('Demo_catalog.json', cat);
  try {
    assert.notEqual(exitOf('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo', '--allow-thin']), 0);
    assert.equal(exitOf('eval.mjs', ['plan', '--dir', dir, '--root', ROOT, '--models', 'sonnet,opus', '--eval', 'tamper']), 3);
    assert.equal(readFileSync(P('Demo_plan.json'), 'utf8'), planBefore, 'the refused plan was not written');
  } finally { W('Demo_catalog.json', good); W('Demo_plan.json', planBefore); }
});

test('an eval reuses a stored run, runs the other model, and compares them on the same use cases', () => {
  run('eval.mjs', ['plan', '--dir', dir, '--root', ROOT, '--models', 'sonnet,opus', '--eval', 'evl1']);
  const ep = R('Demo_eval_plan.json');
  assert.equal(ep.models.find(m => m.model === 'sonnet').reused, true);
  assert.equal(ep.models.find(m => m.model === 'opus').reused, false);
  assert.equal(exitOf('eval.mjs', ['build', '--dir', dir, '--root', ROOT, '--eval', 'evl1']), 3, 'cannot build before opus has run');
  simulate('opus', 'evl1-opus');
  run('ingest-results.mjs', ['--dir', dir, '--root', ROOT, '--run', 'evl1-opus', '--model', 'opus']);
  run('eval.mjs', ['build', '--dir', dir, '--root', ROOT, '--eval', 'evl1']);
  const f = P('Demo_eval_report_evl1.html');
  assert.ok(existsSync(f));
  assert.ok(existsSync(P('Demo_capability_report_evl1_opus.html')) && existsSync(P('Demo_capability_report_evl1_sonnet.html')), 'each model gets its own eval-scoped capability report, never overwriting the official one');
  /* seven tabs (3.8): profiles live under the side-by-side view, capability, difficulty and the other
   * breakdowns under one selector, friction under "Where it goes wrong", the baseline under the method */
  const tabs = renderTabs(f, 'eval-tab', ['sum', 'board', 'kind', 'grid', 'diff', 'gaps', 'method']);
  for (const [t, h] of Object.entries(tabs)) clean(h, `eval report · ${t}`);
  assert.match(tabs.board, /Opus/, 'model names are shown as names');
  assert.match(tabs.grid, /Compare the models/);
  /* 3.9: every use case shows its evidence and cited page; the grid sorts and filters by evidence */
  assert.match(tabs.grid, /class="pill ev-vendor[^>]*>Evidence: Vendor guidance<\/span> <a class="pill src" href="https:\/\/help\.example\.com\/my-tasks"/);
  assert.match(tabs.grid, /<select id="gq-ev"><option value="">All evidence<\/option><option value="vendor" >Vendor guidance \(\d+\)/);
  assert.match(tabs.grid, /<select id="gq-sort"><option value="">As listed<\/option>/);
  assert.match(tabs.sum, /Use cases by evidence<\/span>: \d+ vendor guidance\./);
  assert.match(tabs.method, /Reused stored run/);
  assert.match(tabs.sum, /Which model performed best\?/, 'the summary answers the questions first');
  assert.match(tabs.board, /1 · Getting the task right/, 'task success leads the side-by-side view');
  assert.match(tabs.board, /Is the gap real\?/);
  assert.match(tabs.board, /Model profiles/);
  assert.doesNotMatch((tabs.sum + tabs.board).replace(/<[^>]+>/g, ' '), /McNemar|p = \d|95% range|first-try|indicative/i, 'no statistics jargon in the main text (tooltips keep it)');
  assert.match(tabs.method, /McNemar/, 'the exact statistics stay under the method');
  assert.match(tabs.gaps, /Where it goes wrong/);
  assert.match(tabs.gaps, /Problems that repeat/, 'friction is part of where it goes wrong');
  assert.match(tabs.sum, /Models at a glance/, 'the overview compares the models in one table');
  assert.match(tabs.method, /What the benchmark contains/);
  assert.match(tabs.kind, /Strengths by kind of work/);
  assert.match(tabs.kind, /data-dim="skill"/, 'one selector for difficulty, skill, pattern, area, persona and task type');
  assert.match(tabs.diff, /Unique wins and failures/);
  assert.match(tabs.method, /Limits of this benchmark/);
  assert.ok(existsSync(join(ROOT, '_results', 'Demo', 'evals', 'evl1.json')), 'the eval summary is kept as the next baseline');
  assert.ok(JSON.parse(readFileSync(join(ROOT, '_results', 'Demo', 'evals', 'evl1.json'), 'utf8')).built_at, 'baselines are ordered by when they were built');
});

test('an eval refuses a run made against a different exam, and compares only finished use cases when asked', () => {
  const mf = join(ROOT, '_results', 'Demo', 'evl1-opus', 'manifest.json');
  const good = readFileSync(mf, 'utf8');
  const m = JSON.parse(good);
  writeFileSync(mf, JSON.stringify({ ...m, fingerprint: { ...m.fingerprint, connector_build: '25.0.0', env_key: 'otherbuild' } }));
  assert.equal(exitOf('eval.mjs', ['build', '--dir', dir, '--root', ROOT, '--eval', 'evl1']), 3, 'a different fingerprint is never compared');
  assert.equal(exitOf('eval.mjs', ['build', '--dir', dir, '--root', ROOT, '--eval', 'evl1', '--allow-incomplete']), 3, 'not even with --allow-incomplete');
  writeFileSync(mf, good);
  /* a real missing attempt: opus's third try at the overdue question left no file */
  unlinkSync(join(dir, '_agent_out', 'evl1-opus', `stage9-${tcOf('UC-DMO-0001')}-a3.json`));
  run('ingest-results.mjs', ['--dir', dir, '--root', ROOT, '--run', 'evl1-opus', '--model', 'opus']);
  const inc = JSON.parse(readFileSync(mf, 'utf8'));
  assert.equal(inc.complete, false);
  assert.equal(inc.attempts_expected - inc.attempts_found, 1);
  assert.equal(exitOf('eval.mjs', ['build', '--dir', dir, '--root', ROOT, '--eval', 'evl1']), 3, 'an incomplete run is refused by default');
  const out = execFileSync(process.execPath, [join(SK, 'scripts', 'eval.mjs'), 'build', '--dir', dir, '--root', ROOT, '--eval', 'evl1', '--allow-incomplete'], { encoding: 'utf8', stdio: 'pipe' });
  const n = Number(/(\d+) use case run\(s\) compared/.exec(out)[1]);
  assert.ok(n >= 1, 'something is still compared');
  const summary = JSON.parse(readFileSync(join(ROOT, '_results', 'Demo', 'evals', 'evl1.json'), 'utf8'));
  for (const sm of summary.models) {
    assert.ok(!('UC-DMO-0001' in sm.scores), `${sm.model}: the half-finished use case is left out for every model`);
    assert.ok('UC-DMO-0002' in sm.scores, `${sm.model}: finished use cases are still compared`);
  }
  /* put it back */
  simulate('opus', 'evl1-opus');
  run('ingest-results.mjs', ['--dir', dir, '--root', ROOT, '--run', 'evl1-opus', '--model', 'opus']);
  assert.equal(JSON.parse(readFileSync(mf, 'utf8')).complete, true);
  /* another run's checkpoint never fills this run's gaps: the conformance verdicts are not borrowed */
  const ck = readFileSync(P('Demo_checkpoint.jsonl'), 'utf8');
  writeFileSync(P('Demo_checkpoint.jsonl'), ck.replace('"run_id":"evl1-opus"', '"run_id":"someone-else"'));
  const R2 = mkdtempSync(join(tmpdir(), 'cqa-v3b-'));
  try {
    execFileSync(process.execPath, [join(SK, 'scripts', 'ingest-results.mjs'), '--dir', dir, '--root', R2, '--run', 'evl1-opus', '--model', 'opus'], { encoding: 'utf8', stdio: 'pipe' });
    const fm = JSON.parse(readFileSync(join(R2, '_results', 'Demo', 'evl1-opus', 'manifest.json'), 'utf8'));
    assert.equal(fm.complete, false, 'conformance tests with no journey and no matching checkpoint are missing, not passed');
  } finally { writeFileSync(P('Demo_checkpoint.jsonl'), ck); }
});

test('in capability mode the router sends a run to Stage 1.5, then 5.5, before anything is planned', () => {
  const d2 = join(ROOT, 'Fresh');
  mkdirSync(d2, { recursive: true });
  const K = JSON.parse(readFileSync(P('Demo_knowledge.json'), 'utf8'));
  K.connector = 'Fresh'; K.run_meta = { ...K.run_meta, mode: 'capability' };
  writeFileSync(join(d2, 'Fresh_knowledge.json'), JSON.stringify(K));
  const stage = () => JSON.parse(run('detect-stage.mjs', ['--dir', d2, '--connector', 'Fresh'])).stage;
  assert.equal(stage(), 1.5, 'no capability list');
  const caps = JSON.parse(readFileSync(P('Demo_capabilities.json'), 'utf8')); caps.connector = 'Fresh';
  writeFileSync(join(d2, 'Fresh_capabilities.json'), JSON.stringify({ ...caps, areas: [] }));
  assert.equal(stage(), 1.5, 'no business areas yet');
  writeFileSync(join(d2, 'Fresh_capabilities.json'), JSON.stringify(caps));
  assert.equal(stage(), 5.5, 'no catalog yet');
  const cat = JSON.parse(readFileSync(P('Demo_catalog.json'), 'utf8'));
  writeFileSync(join(d2, 'Fresh_catalog.json'), JSON.stringify({ ...cat, frozen: false, areas: {} }));
  assert.equal(stage(), 5.5, 'catalog not frozen');
  writeFileSync(join(d2, 'Fresh_catalog.json'), JSON.stringify(cat));
  assert.notEqual(stage(), 5.5, 'a frozen catalog lets the run move on');
  assert.equal(JSON.parse(run('detect-stage.mjs', ['--dir', dir, '--connector', 'Demo', '--areas', 'TM'])).stage, 'abort', 'a business-area scope needs capability mode');
});

test('variants are judged before a freeze, and a bad score is skipped without losing the rest', () => {
  const d3 = join(ROOT, 'Var');
  mkdirSync(d3, { recursive: true });
  for (const k of ['knowledge', 'capabilities', 'catalog']) {
    const o = JSON.parse(readFileSync(P(`Demo_${k}.json`), 'utf8')); o.connector = 'Var';
    if (k === 'catalog') o.use_cases[0].variants = ['Anything of mine past its due date?'];
    writeFileSync(join(d3, `Var_${k}.json`), JSON.stringify(o));
  }
  const mc = args => exitOf('manage-catalog.mjs', [...args, '--dir', d3, '--connector', 'Var']);
  assert.equal(mc(['freeze', '--skip-human']), 3, 'the new variant is unjudged');
  writeFileSync(join(d3, 's.json'), JSON.stringify({ model: 'opus', scores: [{ id: 'UC-DMO-0001#v1', score: 5 }, { id: 'UC-DMO-0002', score: 9 }] }));
  try { execFileSync(process.execPath, [join(SK, 'scripts', 'manage-catalog.mjs'), 'judge-merge', '--dir', d3, '--connector', 'Var', '--scores', join(d3, 's.json')], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { assert.fail(`judge-merge failed: ${e.stderr}`); }
  const v = JSON.parse(readFileSync(join(d3, 'Var_catalog.json'), 'utf8'));
  assert.equal(v.use_cases[0].variant_realism['1'].score, 5, 'the good score was kept');
  assert.equal(v.use_cases[1].realism.score, 5, 'the out-of-range score did not overwrite the old one');
  assert.equal(mc(['freeze', '--skip-human']), 0);
});
