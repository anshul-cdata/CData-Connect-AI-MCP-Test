/* Test cases must read like the business — asserted, not hoped for.
 *
 * Management reviewed the asn005 Asana plan and found most of its 329 prompts unrealistic. Each
 * defect they found is pinned here against a fixture shaped like Asana:
 *
 *   - schema names in the question   "Show me each ProjectFollowers record together with…"
 *   - harness instructions           "…then set it back exactly as you found it"
 *   - raw ids                        "Work only in workspace 1209868780107533"
 *   - the wrong columns              22 Tasks queries, none selecting the task's Name
 *   - the wrong priorities           Allocations (an Enterprise add-on) tiered beside Tasks
 *   - research nobody checked        a role matrix in which no role could use Files or Time Tracking
 *   - no realism gate at all         nothing in the pipeline asked "would a person say this?"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { lintPrompt, headlineColumns, naturalize, humanize } from '../scripts/lib/realism.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args) => execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe' });
const exitOf = (s, args) => {
  try { run(s, args); return 0; } catch (e) { return e.status; }
};

/* ── the prompt checker, on prompts asn005 actually shipped ───────────────── */
const ASANA = { objects: ['Tasks', 'Projects', 'ProjectFollowers', 'Workspaces', 'Allocations', 'TaskDependencies'],
                procedures: ['AddTagsToTask', 'RemoveTagsFromTask'] };

test('the checker catches every kind of leak management found', () => {
  const codes = p => lintPrompt(p, ASANA).map(i => i.code);
  assert.ok(codes('Show me each ProjectFollowers record together with the Workspaces it belongs to.').includes('schema_name'));
  assert.ok(codes('Change the Archived on one Projects record, then set it back exactly as you found it.').includes('tester_instruction'));
  assert.ok(codes('Create a task. Work only in workspace 1209868780107533 — do not touch any other workspace.').includes('raw_id'));
  assert.ok(codes('Group the Allocations records and show me the HAVING count above one.').includes('sql_jargon'));
  assert.ok(codes('Carry this out end to end: comment on a task. Work out the steps yourself from the connector\'s own tools.').includes('tester_instruction'));
  assert.ok(codes('Find a suitable Task first, then carry it out using the TagId you look up rather than guessing.').includes('tester_instruction'));
});

test('the checker leaves a real person\'s question alone', () => {
  for (const p of ['Which of my tasks are overdue, and which project is each one in?',
                   'Give me a portfolio-level health picture: each project\'s latest status and colour.',
                   'Who is following each project and will therefore receive its status updates?'])
    assert.deepEqual(lintPrompt(p, ASANA), [], p);
});

test('schema names become the words people use', () => {
  assert.equal(humanize('ProjectFollowers'), 'project followers');
  assert.equal(humanize('SubTasks'), 'subtasks');
  assert.equal(naturalize('Change the status on one Tasks record.', ASANA.objects), 'Change the status on one task.');
  assert.equal(naturalize('Which Allocations records have no matching Workspaces at all?', ASANA.objects),
    'Which allocations have no matching workspaces at all?');
});

/* ── headline columns ─────────────────────────────────────────────────────── */
const TASK_COLS = [
  { name: 'Id', role: 'identifier', important: true },
  { name: 'ResourceSubType', role: 'dimension', important: true },
  { name: 'RecurrenceType', role: 'dimension', important: true },
  { name: 'ModifiedAt', role: 'date', important: true },
  { name: 'startOn', role: 'date', important: true },
  { name: 'Name', role: 'descriptive', important: true },
  { name: 'AssigneeName', role: 'descriptive', important: true },
  { name: 'AssigneeSectionName', role: 'descriptive', important: false },
  { name: 'Completed', role: 'status', important: true },
  { name: 'Liked', role: 'status', important: false },
  { name: 'DueOn', role: 'date', important: true },
  { name: 'ProjectId', role: 'relationship_key', important: true },
  { name: 'HtmlNotes', role: 'technical', important: false },
];

test('a task is shown by its name, owner, state and due date — not its API type', () => {
  const h = headlineColumns({ columns: TASK_COLS });
  assert.equal(h.label, 'Name');
  assert.equal(h.owner, 'AssigneeName');
  assert.equal(h.state, 'Completed', 'a social flag like Liked is not where the work stands');
  assert.equal(h.key_date, 'DueOn');
  assert.equal(h.parent, 'ProjectId', "the assignee's My Tasks section is not what a task belongs to");
  assert.ok(!h.list.includes('ResourceSubType'));
});

test('a headline set recorded by Stage 3 wins over the name heuristics', () => {
  const h = headlineColumns({ columns: TASK_COLS, headline_columns: ['Name', 'DueOn'] });
  assert.deepEqual(h.list, ['Name', 'DueOn']);
});

/* ── an Asana-shaped fixture through the real pipeline ───────────────────── */
const PIN = '1208200246477352';
const dir = join(mkdtempSync(join(tmpdir(), 'cqa-realism-')), 'Demo');
mkdirSync(dir, { recursive: true });
const P = f => join(dir, f);
const W = (f, o) => writeFileSync(P(f), JSON.stringify(o, null, 2));

const objs = [
  { name: 'Tasks', category: 'core', business_domain: { v: 'TM' }, columns: TASK_COLS },
  { name: 'Projects', category: 'core', business_domain: { v: 'TM' }, columns: [
    { name: 'Id', role: 'identifier', important: true }, { name: 'Name', role: 'descriptive', important: true },
    { name: 'Archived', role: 'status', important: true }, { name: 'DueOn', role: 'date', important: true },
    { name: 'TeamId', role: 'relationship_key', important: true }] },
  { name: 'Allocations', category: 'core', business_domain: { v: 'RC' }, columns: [
    { name: 'Id', role: 'identifier', important: true }, { name: 'AssigneeName', role: 'dimension', important: true },
    { name: 'EffortValue', role: 'measure', important: true }, { name: 'StartDate', role: 'date', important: true },
    { name: 'EndDate', role: 'date', important: true }, { name: 'ResourceSubType', role: 'dimension', important: true }] },
  { name: 'Users', category: 'core', business_domain: { v: 'TM' }, synonyms: ['teammate'], columns: [
    { name: 'Id', role: 'identifier', important: true }, { name: 'Name', role: 'descriptive', important: true },
    { name: 'Email', role: 'descriptive', important: true }] },
].map(o => ({ type: 'TABLE', tier: 'T1', columns_loaded: true, business_meaning: { v: o.name, confidence: 'FACT', source: 'vendor_docs' }, ...o }));

const rels = [{ id: 'REL-001', from: 'Tasks', to: 'Projects', from_col: 'ProjectId', to_col: 'Id', confidence: 'FACT', source: 'cdata_metadata', tested: false }];

const personas = [
  { id: 'IC', name: 'Individual Contributor', archetype: 'doer', primary_domains: ['TM'],
    jobs_to_be_done: ['Clear every overdue item off My Tasks before logging off', 'Hand a blocked task to a teammate before standup'],
    daily_questions: ['Which of my tasks are overdue?', 'What is due this week on my plate?'] },
  { id: 'PM', name: 'Project Manager', archetype: 'coordinator', primary_domains: ['TM'],
    jobs_to_be_done: ['Post a project status update before the Friday review'],
    daily_questions: ['Which projects are slipping this week?', 'Move my overdue tasks to the next sprint'] },
  { id: 'RM', name: 'Resource Manager', archetype: 'analyst', primary_domains: ['RC'],
    jobs_to_be_done: ['Rebalance allocations before the planning freeze'],
    daily_questions: ['Who is over-allocated next month?', 'How much effort is booked against each project?'] },
];

W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
  run_meta: { run_id: 'r1', started_at: '2026-09-01T00:00:00Z', models: {}, workspace: PIN },
  connector_meta: { app: 'Demo', personas,
    workflow_domains: [
      { id: 'TM', name: 'Task Management', prevalence: 'core', table_refs: ['Tasks', 'Projects'], standard_reports: ['Tasks report'],
        workflows: [{ id: 'TM01', name: 'Create and assign a task with a due date', permission: 'write', edge_cases: ['Task with no assignee'] },
                    { id: 'TM02', name: 'Review overdue tasks by project', permission: 'read' }] },
      { id: 'RC', name: 'Resource Management', prevalence: 'premium', table_refs: ['Allocations'], standard_reports: ['Allocations report'],
        workflows: [{ id: 'RC01', name: 'Adjust allocations when a project slips', permission: 'write' }] },
    ],
    /* the asn005 defect: well-formed, and no role can touch Resource Management */
    roles: [{ name: 'Admin', access: { TM: 'F', RC: 'N' } }, { name: 'Member', access: { TM: 'E', RC: 'N' } }] },
  physical: { procedures: [], permissions: { select: true, insert: true, update: true, delete: false } },
  objects: objs, relationships: rels });

W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo', objectives: {},
  objects: { tables: { total: objs.length, by_tier: {}, rows: objs.map(o => ({ name: o.name, tier: 'T1', state: 'discovered', tc_ids: [] })) },
             views: { total: 0, rows: [] }, procedures: { total: 0, rows: [] } },
  columns: { rows: objs.flatMap(o => o.columns.map(c => ({ object: o.name, column: c.name, role: c.role, state: 'uncovered', tc_ids: [] }))) },
  relationships: { rows: rels.map(r => ({ id: r.id, from: r.from, to: r.to, on: 'ProjectId = Id', state: 'uncovered', confidence: 'FACT', tc_ids: [] })) },
  use_cases: { rows: [] },
  patterns: { rows: ['select_projection', 'filter_equality', 'insert', 'update', 'group_by', 'aggregate_count', 'filter_like']
    .map(p => ({ pattern: p, applicable: true, state: 'uncovered', tc_ids: [] })) },
  intents: { rows: [] }, behaviors: { rows: [] } });

run('compute-gaps.mjs', ['--knowledge', P('Demo_knowledge.json'), '--coverage', P('Demo_coverage.json'), '--out', P('Demo_gaps.json')]);
const G = JSON.parse(readFileSync(P('Demo_gaps.json'), 'utf8'));
for (const g of G.gaps) { g.description = String(g.evidence).slice(0, 120); g.business_importance = 'HIGH'; }
W('Demo_gaps.json', G);
run('score-gaps.mjs', ['--gaps', P('Demo_gaps.json'), '--knowledge', P('Demo_knowledge.json')]);
const tierOut = run('tier-objects.mjs', ['--dir', dir, '--connector', 'Demo', '--apply']);
const K = JSON.parse(readFileSync(P('Demo_knowledge.json'), 'utf8'));
exitOf('generate-tests.mjs', ['--dir', dir, '--connector', 'Demo', '--allow-thin']);
const plan = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));
const tcs = plan.tc_list;
const obj = n => K.objects.find(o => o.name === n);

/* ── tiering ──────────────────────────────────────────────────────────────── */
test('a core business area outranks a premium add-on', () => {
  assert.ok(obj('Tasks').tier_score > obj('Allocations').tier_score,
    `Tasks ${obj('Tasks').tier_score} vs Allocations ${obj('Allocations').tier_score}`);
  const prev = obj('Allocations').tier_signals.find(s => s.signal === 'prevalence');
  assert.ok(prev && prev.weight < 0, 'a premium area must cost an object score');
});

test('a role matrix that gives no role access is treated as unknown, never as a penalty', () => {
  const reach = obj('Allocations').tier_signals.find(s => s.signal === 'role reach');
  assert.ok(reach && reach.weight === 0 && /unknown/.test(reach.desc), JSON.stringify(obj('Allocations').tier_signals));
  assert.match(tierOut, /Allocations\s+was T1/, 'the premium add-on should leave T1');
});

test('a business synonym counts like the name — persona jobs say "teammate", never "user"', () => {
  assert.ok(obj('Users').tier_signals.some(s => s.signal === 'persona coupling'), JSON.stringify(obj('Users').tier_signals));
});

/* ── the plan ─────────────────────────────────────────────────────────────── */
test('every test says which suite it belongs to', () => {
  assert.ok(tcs.length > 5);
  for (const t of tcs) assert.ok(['business', 'conformance'].includes(t.suite), `${t.id} has no suite`);
  assert.ok(tcs.some(t => t.suite === 'business') && tcs.some(t => t.suite === 'conformance'));
});

test('everyday questions come first, verbatim from the persona research, as business scenarios', () => {
  const ev = tcs.filter(t => t.group === 'Everyday Questions');
  assert.ok(ev.some(t => t.prompt === 'Which of my tasks are overdue?'), ev.map(t => t.prompt).join(' | '));
  for (const t of ev) {
    assert.equal(t.suite, 'business');
    assert.equal(t.priority, 'P1');
    assert.ok(t.persona, `${t.id} lost its persona`);
  }
  const tasksQ = ev.find(t => /overdue/.test(t.prompt));
  assert.ok(tasksQ.target_objects.includes('Tasks'), 'the question is matched to the object it is about');
});

test('an everyday question that changes data is flagged as a write', () => {
  const w = tcs.find(t => /^Move my overdue tasks/.test(t.prompt));
  assert.ok(w, 'the write question was dropped');
  assert.equal(w.mutates, true);
});

test('no prompt carries a workspace id — the operating note does', () => {
  for (const t of tcs) assert.ok(!String(t.prompt).includes(PIN), `${t.id}: ${t.prompt}`);
  const writes = tcs.filter(t => t.mutates && t.executable !== false);
  assert.ok(writes.length, 'fixture should produce executable writes');
  for (const t of writes) assert.ok(String(t.agent_context || '').includes(PIN), `${t.id} lost the workspace`);
});

test('no conformance prompt carries a raw id or an instruction to the agent', () => {
  for (const t of tcs.filter(t => t.suite === 'conformance')) {
    const bad = lintPrompt(t.prompt, { objects: K.objects.map(o => o.name) }).filter(i => i.code === 'raw_id' || i.code === 'tester_instruction');
    assert.deepEqual(bad, [], `${t.id}: ${t.prompt}`);
  }
});

test('a workflow is asked as the job, with the checks moved to the expectation', () => {
  const w = tcs.find(t => t.group_type === 'workflow' && /create and assign/i.test(t.prompt));
  assert.ok(w);
  assert.doesNotMatch(w.prompt, /carry this out|work out the steps|reading it back|say plainly/i);
  assert.ok((w.expected_behavior || []).some(e => /read back/.test(e)), 'the read-back check must survive, in the expectation');
  assert.ok((w.expected_behavior || []).some(e => /no assignee/i.test(e)), 'the edge case must survive, in the expectation');
  assert.equal(w.suite, 'business');
  assert.ok(w.brief && w.brief.goal, 'a business draft carries a brief for the writer');
});

test('a write test asks for the change and leaves the restore to the expectation and the note', () => {
  const up = tcs.find(t => t.group_type === 'write' && t.query_patterns.includes('update'));
  assert.ok(up);
  assert.doesNotMatch(up.prompt, /set it back|as you found it|read its current value/i);
  assert.ok(up.expected_behavior.some(e => /restored/.test(e)));
  assert.match(up.agent_context, /put it back/);
});

test('queries select the columns a person means', () => {
  const sqls = tcs.map(t => t.expected_sql || '').filter(s => /FROM \[Tasks\](?!\w)/.test(s) && /^SELECT/.test(s));
  assert.ok(sqls.length, 'fixture should produce Tasks queries');
  assert.ok(sqls.some(s => /\[Name\]/.test(s)), `no Tasks query selects Name:\n${sqls.join('\n')}`);
  for (const s of sqls) assert.doesNotMatch(s, /ResourceSubType|HtmlNotes/, s);
});

/* ── the realism gate ─────────────────────────────────────────────────────── */
const stage = () => JSON.parse(run('detect-stage.mjs', ['--dir', dir, '--connector', 'Demo'])).stage;

test('the realism gate blocks an unscored plan of drafts, and the router sends drafts to 8.5', () => {
  assert.equal(exitOf('realism-check.mjs', ['--dir', dir, '--connector', 'Demo']), 3);
  assert.equal(stage(), 8.5, 'unrewritten business drafts must not route to execution');
});

test('rewritten, well-scored business prompts pass; a rewrite after scoring needs scoring again', () => {
  run('realism-check.mjs', ['--dir', dir, '--connector', 'Demo', '--prep']);
  const pkg = JSON.parse(readFileSync(P('Demo_realism_input.json'), 'utf8'));
  assert.ok(pkg.tests.length && pkg.tests.every(t => !('expected_sql' in t)), 'the judge never sees the SQL');

  /* stand in for Stage 8.5 (rewrite) and the judge (score) */
  const p = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));
  for (const t of p.tc_list) if (t.suite === 'business') t.prompt_status = 'rewritten';
  W('Demo_plan.json', p);
  W('scores.json', { model: 'opus', scores: pkg.tests.map(t => ({ id: t.id, score: 5 })) });
  assert.equal(exitOf('realism-check.mjs', ['--dir', dir, '--connector', 'Demo', '--merge', P('scores.json')]), 0);
  assert.equal(stage(), 9, 'a judged, passing plan routes to execution');

  const q = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));
  const first = q.tc_list.find(t => t.suite === 'business');
  first.prompt = first.prompt + ' Thanks.';
  W('Demo_plan.json', q);
  assert.equal(exitOf('realism-check.mjs', ['--dir', dir, '--connector', 'Demo']), 3, 'a score is for a wording');
  assert.equal(stage(), 8.6, 'a rewritten prompt goes back to the judge');
});

test('a low score blocks, and the judge\'s reasons are kept for the rewrite', () => {
  const pkg = JSON.parse(readFileSync(P('Demo_realism_input.json'), 'utf8'));
  W('scores.json', { model: 'opus', scores: pkg.tests.map((t, i) => ({ id: t.id, score: i === 0 ? 2 : 5,
    ...(i === 0 ? { issues: ['no persona would ask this'], suggestion: 'What is overdue for me today?' } : {}) })) });
  assert.equal(exitOf('realism-check.mjs', ['--dir', dir, '--connector', 'Demo', '--merge', P('scores.json')]), 3);
  const p = JSON.parse(readFileSync(P('Demo_plan.json'), 'utf8'));
  const low = p.realism_summary.below_threshold[0];
  assert.equal(low.suggestion, 'What is overdue for me today?');
  assert.equal(exitOf('realism-check.mjs', ['--dir', dir, '--connector', 'Demo', '--allow-unrealistic']), 0);
});
