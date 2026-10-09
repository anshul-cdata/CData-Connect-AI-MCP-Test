#!/usr/bin/env node
/**
 * status-gallery.mjs — renders one test case per verdict code into a real report.
 *
 *   node tests/status-gallery.mjs [--out <dir>]
 *
 * Every status in 00-contracts.md §3 appears exactly once, with the journey shape that earns it.
 * Two uses: it shows a reader what each verdict looks like on the page, and it exercises every
 * badge, owner tag and empty-state branch of the template, so a rendering regression in a rarely
 * used status shows up here instead of in a customer run.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, '..');
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => {
  if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return acc; }, []));

const C = 'StatusGallery';
const dir = a.out ? join(a.out, C) : join(mkdtempSync(join(tmpdir(), 'cqa-gallery-')), C);
mkdirSync(dir, { recursive: true });

const sql = 'SELECT [Id],[Name],[Status],[DueOn] FROM [Demo].[Orders] WHERE [Status] = \'open\' ORDER BY [DueOn] DESC LIMIT 20';
const ran = { sql, objects: ['Orders'], columns: ['Id', 'Name', 'Status', 'DueOn'],
              patterns: ['select_projection', 'filter_equality', 'order_by', 'limit'], joins: [], divergence: [] };

/* id, status, what the verdict means, the journey that produces it */
const CASES = [
  ['pass', 'The agent wrote a correct query first try and it returned rows. The only verdict that needs no explanation.',
    [{ t: 'p', q: sql, r: '20 rows returned' }], ran, null],

  ['pass_sql', 'The first SQL was malformed; the agent rewrote the syntax itself and the retry worked.',
    [{ t: 'f', q: 'SELECT Id, Name FROM Orders WHERE Status = open', e: 'STMT CORE Unquoted literal \'open\'.', r: 'Literal not quoted — driver reads it as a column', a: 'AI slip: CData needs every literal single-quoted (06 §8.2a)' },
     { t: 'd', q: sql, r: '20 rows returned', a: 'Agent quoted the literal and retried without being told' }], ran, 'owner-ok'],

  ['pass_col', 'A column name the agent assumed did not exist; it called getColumns and corrected it.',
    [{ t: 'f', q: 'SELECT [Id],[CreatedDate] FROM [Demo].[Orders] LIMIT 20', e: 'STMT CORE Invalid column name \'CreatedDate\'.', r: 'Orders uses CreatedAt, not CreatedDate', a: 'AI slip: reached for a name from another product' },
     { t: 'p', r: 'getColumns(Orders) — CreatedAt confirmed' },
     { t: 'd', q: sql, r: '20 rows returned', a: 'Corrected CreatedDate → CreatedAt' }], ran, 'owner-ok'],

  ['pass_tbl', 'The agent asked for a business term that is not the object name, discovered the real table and re-routed.',
    [{ t: 'f', q: 'SELECT [Id] FROM [Demo].[Comments] LIMIT 20', e: 'Comments table does not exist.', r: 'The business term "Comments" maps to Stories', a: 'Naming divergence between vendor vocabulary and connector schema' },
     { t: 'p', r: 'getTables() — Comments absent, Stories present' },
     { t: 'd', q: sql, r: '8 rows returned', a: 'Re-routed Comments → Stories' }], ran, 'owner-ok'],

  ['pass_schema', 'The query was right but pointed at the wrong catalog/schema qualifier.',
    [{ t: 'f', q: 'SELECT [Id] FROM [Orders] LIMIT 20', e: 'STMT CORE Object \'Orders\' not found in default schema.', r: 'Needs the catalog.schema prefix', a: 'AI slip: omitted the [Demo] qualifier' },
     { t: 'd', q: sql, r: '20 rows returned', a: 'Added the catalog and schema qualifier' }], ran, 'owner-ok'],

  ['pass_dtype', 'A value was sent as the wrong type; the agent noticed and re-sent it correctly.',
    [{ t: 'f', q: 'SELECT [Id] FROM [Demo].[Orders] WHERE [Completed] = \'false\' LIMIT 20', e: 'STMT CORE Cannot convert \'false\' to BOOLEAN.', r: 'Completed is BOOLEAN — a quoted literal is a string', a: 'AI slip: quoted a boolean' },
     { t: 'd', q: sql, r: '20 rows returned', a: 'Re-sent the boolean unquoted' }], ran, 'owner-ok'],

  ['pass_query', 'The shape of the query had to change — not one token — before the connector would answer it.',
    [{ t: 'b', q: 'SELECT [Status], COUNT(*) FROM [Demo].[Orders] GROUP BY [Status]', e: 'STMT DATA_SOURCE Aggregate push-down unsupported.', r: 'Driver cannot push GROUP BY to this API', a: 'Driver limitation, not an AI mistake' },
     { t: 'd', q: sql, r: '20 rows returned; counted client-side', a: 'Agent restructured to a projection and aggregated itself' }], ran, 'owner-driver'],

  ['partial', 'Something real was learned, but no query the run can credit ever succeeded. Coverage stays uncredited.',
    [{ t: 'b', q: 'SELECT [Id],[DueOn] FROM [Demo].[Orders] WHERE [DueOn] < \'2026-09-01\' LIMIT 20',
       e: 'STMT DATA_SOURCE [60002] Request timed out.', r: 'API does not support date-range push-down; connector fetches all rows and times out',
       a: 'Genuine driver limitation — will fail identically on retry, so it is not worth another round' }], null, 'owner-driver'],

  ['fail', 'The agent could not answer the question and did not recover. Every fail carries an owner.',
    [{ t: 'f', q: 'SELECT [Id],[OwnerEmail] FROM [Demo].[Orders] LIMIT 20', e: 'STMT CORE Invalid column name \'OwnerEmail\'.', r: 'No such column, and the agent never called getColumns', a: 'AI fault: guessed a column name twice instead of discovering the schema' },
     { t: 'f', q: 'SELECT [Id],[Owner_Email] FROM [Demo].[Orders] LIMIT 20', e: 'STMT CORE Invalid column name \'Owner_Email\'.', r: 'Second guess, same class of error', a: 'Gave up without discovery' }], null, 'owner-ai'],

  ['boundary', 'The agent hit a real permission or capability wall and handled it correctly. This is a pass for behaviour.',
    [{ t: 'b', q: 'DELETE FROM [Demo].[Orders] WHERE [Id] = \'1001\'', e: 'STMT CORE DELETE not permitted on catalog Demo.', r: 'Connector exposes Select/Insert/Update/Execute only',
       a: 'Correct behaviour: the agent reported the limit instead of inventing a workaround' }], null, 'owner-ok'],

  ['not_exec', 'Dispatched but nothing ran — no SQL, no tool call. Never record this as a pass.',
    [], null, 'owner-ai'],

  ['na', 'Out of scope for this connector. Leaves the denominator entirely.',
    [{ t: 'p', r: 'DELETE not in getCatalogs permissions — no delete test is applicable' }], null, null],

  ['nt', 'In scope and genuinely untestable here. Stays counted as uncovered — this is the honest option.',
    [{ t: 'p', r: 'Requires a paid subscription tier this tenant does not have; no realistic parameter value exists' }], null, null],

  ['ne', 'Planned but never reached — the run stopped first. Distinct from not_exec, which was dispatched.',
    [], null, null],
];

const tcs = CASES.map(([status, why, steps, observed, owner], i) => ({
  id: `TC-${String(i + 1).padStart(3, '0')}`,
  gap_ids: [`GAP-${String(i + 1).padStart(3, '0')}`],
  uc: status, business_domain: 'Demo', business_intent: null,
  prompt: `Show me the open orders with the nearest due dates so I can chase them today. (verdict shown: ${status})`,
  expected_sql: sql, target_objects: ['Orders'], target_columns: ['Id', 'Name', 'Status', 'DueOn'],
  relationships: [], query_patterns: ['select_projection', 'filter_equality', 'order_by', 'limit'],
  priority: 'P2', group: 'Verdict Gallery', group_type: 'process', process_group: 'Verdict Gallery',
  roles: ['Analyst'], access_level: 'V',
  steps, status, owner, time: '~3s', est_in: 1200, est_out: 300, tool_calls: steps.length || 0,
  observed, _why: why,
}));

const col = (name, role, important = true) => ({ name, type: name === 'DueOn' ? 'DATE' : 'VARCHAR', role, important, pk: name === 'Id', readonly: false,
  meaning: { v: `${name} of the order`, confidence: 'FACT', source: 'cdata_metadata' } });

const K = {
  schema_version: '2.0.0', connector: C, generated_at: new Date().toISOString(), run_state: 'complete', semantic_complete: true,
  run_meta: { run_id: 'run_gallery', skill_version: '2.0.0', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
              models: { orchestrator: 'demo', under_test: 'demo' }, rounds_done: 1 },
  connector_meta: { app: C, subtitle: 'One test case per verdict code — a rendering gallery, not a real connector run.',
    roles: [{ name: 'Analyst', group: 'Workspace', source: 'doc', access: { DEMO: 'V' } }],
    workflow_domains: [{ id: 'DEMO', name: 'Demo', table_refs: ['Orders'], standard_reports: ['Open orders'], workflows: [{ id: 'D1', name: 'Chase open orders', permission: 'read', edge_cases: [] }] }],
    personas: [{ id: 'PERSONA_AN', name: 'Analyst', description: 'Reviews open work', primary_domains: ['DEMO'], jobs_to_be_done: ['Chase open orders before end of day'] }],
    role_complexity: 'low', recommendation: '', sources: [] },
  instructions_raw: 'Demo fixture — no driver instructions.',
  source_overview: 'A fixture connector that exists only to render one test case per verdict code.',
  capabilities: ['SELECT on Orders'], limitations: ['No DELETE'],
  physical: { catalogs: [{ name: 'Demo', data_source: 'Demo', driver: 'Demo', permissions: ['Select'] }], schemas: ['Demo'],
              tables: [{ name: 'Orders', type: 'TABLE', remarks: 'Demo orders' }], views: [], procedures: [] },
  objects: [{ name: 'Orders', type: 'TABLE', category: 'core', columns_loaded: true,
    columns: [col('Id', 'identifier'), col('Name', 'dimension'), col('Status', 'status'), col('DueOn', 'date')],
    business_meaning: { v: 'A customer order', confidence: 'FACT', source: 'vendor_docs' },
    business_domain: { v: 'DEMO', confidence: 'FACT', source: 'cdata_metadata' },
    personas: ['PERSONA_AN'], business_questions: ['Which orders are still open?'], limitations: [],
    tier: 'T1', tier_score: 9, tier_signals: [{ signal: 'workflow_ref', weight: 3, desc: 'Referenced by a workflow' }] }],
  relationships: [],
};

const row = (extra = {}) => ({ state: 'not_covered', tc_ids: [], ...extra });
const COV = {
  schema_version: '2.0.0', connector: C, updated_at: new Date().toISOString(), round: 1, objectives_met: false,
  objectives: [], dq_observations: [{ type: 'FIXTURE', object: 'Orders', action: 'none', result: 'This row exists so the Data Quality panel renders with content.' }],
  objects: { tables: { total: 1, by_tier: { T1: { total: 1, covered: 1, failed: 0, na: 0, nt: 0 } },
              rows: [{ name: 'Orders', tier: 'T1', tier_score: 9, state: 'tested', tc_ids: ['TC-001'], columns_important: 4, columns_covered: 4 }] },
             views: { total: 0, by_tier: {}, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { total_important: 4, covered: 4, by_role: {}, rows: ['Id', 'Name', 'Status', 'DueOn'].map(c => ({ object: 'Orders', column: c, role: 'dimension', tier: 'T1', state: 'covered', tc_ids: ['TC-001'] })) },
  relationships: { total: 0, tested: 0, rows: [] },
  use_cases: { total: 1, covered: 1, rows: [row({ id: 'UC-001', name: 'Open orders', domain: 'DEMO', persona: 'PERSONA_AN', objects: ['Orders'], source: 'vendor_report', state: 'covered', tc_ids: ['TC-001'] })] },
  patterns: { rows: [{ pattern: 'select_projection', applicable: true, applicability_reason: 'Band 1', customer_frequency: null, state: 'covered', tc_ids: ['TC-001'] }] },
  intents: { rows: [] }, behaviors: { rows: [] },
  funnel: { vendor_domains: 1, vendor_workflows: 1, vendor_standard_reports: 1, domains_without_connector_object: 0,
            connector_objects: 1, tables: 1, views: 0, procedures: 0, meaning_fact: 1, meaning_inference: 0, meaning_unknown: 0,
            tier_counts: { T1: 1, T2: 0, T3: 0, T4: 0 }, objects_t1_t2: 1, objects_tested: 1, objects_failed: 0,
            computed_at: new Date().toISOString(), assessment_confidence: 100 },
};

const GAPS = { schema_version: '2.0.0', connector: C, prioritized: true,
  gaps: CASES.map(([status], i) => ({ id: `GAP-${String(i + 1).padStart(3, '0')}`, category: 'QUERY',
    description: `Gap illustrating the ${status} verdict`, business_importance: 'MEDIUM',
    impacted: { objects: ['Orders'], columns: [], relationships: [], patterns: ['select_projection'] },
    tier: 'T1', evidence: 'fixture', evidence_strength: 'MEDIUM', detected_round: 0, priority: 'P2', priority_score: 8,
    planned_tests: [`TC-${String(i + 1).padStart(3, '0')}`], final_status: 'CLOSED', key: `pattern:fixture_${status}` })) };

const CK = { schema_version: '2.0.0', connector: C, run_meta: K.run_meta, round: 1, rounds_done: 1,
  tcs_completed: tcs.map(t => t.id),
  groups: [{ id: 'grp-01', title: 'Verdict Gallery', desc: 'One test case per verdict code in 00-contracts.md §3 — the journey shown is what earns that verdict.', tcs }],
  exec_summary: { total: tcs.length, top_issues: [
      { rank: 1, type: 'fixture', description: 'This report is a rendering gallery. Every row is synthetic and exists to show what one verdict looks like on the page.' }],
    not_exec_reason: 'Fixture — nothing was dispatched.', execution_mode: 'fixture' },
  fault_table: [], dq_observations: [], caps: [], instr_eval: {}, coverage_matrix: {}, schema_coverage: {}, personas: [] };

const S10 = { schema_version: '2.0.0', tcs: tcs.length, counts: {}, pass_health: 71, gap_health: 100,
  verdict: 'needs_attention', verdictLabel: 'Needs Attention',
  verdict_reasons: ['Fixture report — verdict fixed so the badge renders.'], gaps: { CLOSED: CASES.length } };

const w = (n, o) => writeFileSync(join(dir, `${C}_${n}.json`), JSON.stringify(o, null, 1));
w('knowledge', K); w('coverage', COV); w('gaps', GAPS); w('checkpoint', CK);
writeFileSync(join(dir, `${C}_coverage.stage10-summary.json`), JSON.stringify(S10, null, 1));

execFileSync(process.execPath, [join(skill, 'scripts', 'build-report.mjs'), '--dir', dir, '--template', join(skill, 'assets', 'report-template.html')], { stdio: 'inherit' });

console.log(`\nVERDICT GALLERY — ${CASES.length} statuses rendered`);
for (const [status, why] of CASES) console.log(`  ${status.padEnd(12)} ${why}`);
console.log(`\n→ ${join(dir, `${C}_dynamic_test_report.html`)}`);
