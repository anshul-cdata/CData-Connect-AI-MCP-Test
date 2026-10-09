/* 3.9 — the human rating sample is off by default (config.catalog.human_review: false).
 *
 * An area is frozen without the rating sheet, the run never pauses for it, and the freeze is recorded
 * as human_skipped (by config) so the reports can say plainly that nobody reviewed the use cases.
 * With the setting true, the freeze blocks until the sample exists, exactly as before.
 * `freeze --skip-human` still skips it for one freeze. A catalog a person reviewed keeps its figure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliAt = (skill, f, args) => { const r = spawnSync(process.execPath, [join(skill, 'scripts', f), ...args], { encoding: 'utf8' }); return { code: r.status ?? 1, out: String(r.stdout) + String(r.stderr) }; };
const cli = (f, args) => cliAt(SK, f, args);

/* the same skill with human_review switched on, to show the gate still holds */
const ON = join(mkdtempSync(join(tmpdir(), 'cqa-hr-skill-')), 'skill');
mkdirSync(ON, { recursive: true });
cpSync(join(SK, 'scripts'), join(ON, 'scripts'), { recursive: true });
{ const c = JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8')); c.catalog.human_review = true; writeFileSync(join(ON, 'config.json'), JSON.stringify(c, null, 2)); }

const root = mkdtempSync(join(tmpdir(), 'cqa-hr-'));
function connector(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, '_agent_out'), { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  const col = (n, role) => ({ name: n, role, important: true });
  W(`${name}_knowledge.json`, { connector: name, run_meta: { run_id: 'r1' }, connector_meta: { personas: [{ id: 'L', name: 'Lead' }] },
    objects: [{ name: 'Tasks', columns: [col('Id', 'identifier'), col('Name', 'descriptive'), col('Completed', 'status'), col('DueOn', 'date')] }] });
  W(`${name}_capabilities.json`, { source: { title: 'Demo API', version: '1' },
    areas: [{ id: 'TM', name: 'Task management', personas: ['Lead'], capability_ids: ['CAP-gettasks'] }],
    capabilities: [{ id: 'CAP-gettasks', label: 'Get tasks', method: 'GET', path: '/tasks', kind: 'list', mapping: { status: 'exposed', exposure: [{ kind: 'table', name: 'Tasks', op: 'SELECT' }], confidence: 'high' } }] });
  const keys = ['simple', 'medium', 'complex', 'dates', 'aggregation', 'relationships', 'write', 'ambiguity', 'missing_info', 'limitation', 'persona:Lead'];
  W(`${name}_catalog.json`, { prefix: 'HR', mix_explained: keys.map(need => ({ area: 'TM', need, reason: 'a one use case test fixture' })), use_cases: [
    { area: 'TM', persona: 'Lead', goal: 'see what is late', frequency: 'weekly', kind: 'question', difficulty: 'simple', tests: ['filters'],
      source: { kind: 'help_center', title: 'Overdue tasks', url: 'https://help.example.com/overdue' }, capabilities: ['CAP-gettasks'],
      request: 'Which of my tasks are overdue?', check: { rule: 'same_ids', key: 'Id', reference_sql: "SELECT [Id] FROM [Tasks] WHERE [Completed] = false AND [DueOn] < '{{today}}'" } }] });
  const D = ['--dir', dir];
  for (const [args, file, body] of [
    [['ids'], null, null],
    [['judge-merge', '--scores'], 'scores.json', { model: 'opus', scores: [{ id: 'UC-HR-0001', score: 5 }] }],
    [['sources-prep'], null, null],
    [['sources-merge', '--checks'], 'checks.json', { model: 'sonnet', checks: [{ url: 'https://help.example.com/overdue', status: 'found', title_seen: 'Overdue tasks' }] }],
    [['review-prep'], null, null],
    [['review-merge', '--review'], 'review.json', { model: 'opus', areas: [{ area: 'TM', verdict: 'complete', findings: [] }] }],
  ]) {
    if (file) W(file, body);
    const r = cli('manage-catalog.mjs', [args[0], ...D, ...(file ? [args[1], join(dir, file)] : [])]);
    assert.equal(r.code, 0, `${args[0]}: ${r.out}`);
  }
  return { dir, D, J: f => JSON.parse(readFileSync(join(dir, f), 'utf8')) };
}
function renderTab(file, tab) {
  const html = readFileSync(file, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const app = { innerHTML: '', addEventListener() {}, querySelectorAll: () => [] };
  new Function('document', 'localStorage', 'window', js)({ getElementById: id => id === 'app' ? app : null }, { getItem: k => k === 'cap-tab' ? tab : null, setItem() {} }, { scrollTo() {} });
  return app.innerHTML;
}

test('config default: human_review is false', () => {
  assert.equal(JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8')).catalog.human_review, false);
});

test('human_review true: freeze still blocks without the human sample (and --skip-human still skips it)', () => {
  const { D, J } = connector('Gate');
  const r = cliAt(ON, 'manage-catalog.mjs', ['freeze', ...D]);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /human/i);
  const s = cliAt(ON, 'manage-catalog.mjs', ['freeze', ...D, '--skip-human']);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /human review SKIPPED/);
  assert.doesNotMatch(s.out, /config\.catalog\.human_review/);
  const h = J('Gate_catalog.json').history.slice(-1)[0];
  assert.deepEqual([h.human_skipped, h.human_skipped_by], [true, 'flag']);
});

test('human_review false (default): freeze without ratings succeeds, recorded as skipped by config; the report says so', () => {
  const { dir, D, J } = connector('Off');
  const r = cli('manage-catalog.mjs', ['freeze', ...D]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /human review SKIPPED \(off: config\.catalog\.human_review\)/);
  const cat = J('Off_catalog.json');
  assert.deepEqual([cat.history.slice(-1)[0].human_skipped, cat.history.slice(-1)[0].human_skipped_by], [true, 'config']);
  assert.deepEqual([cat.areas.TM.history[0].human_skipped, cat.areas.TM.history[0].human_skipped_by], [true, 'config']);
  assert.equal(J('Off_knowledge.json').run_meta.human_review, 'skipped (config)');
  assert.equal(J('Off_knowledge.json').run_meta.run_id, 'r1', 'the rest of run_meta is kept');
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  const q = renderTab(join(dir, 'Off_analysis_report.html'), 'quality');
  assert.match(q, /Not reviewed — human review is off \(config\.catalog\.human_review\)\./);
});

test('a reviewed catalog keeps its figure; one never frozen says nothing new', () => {
  const { dir, J } = connector('Seen');
  const cat = J('Seen_catalog.json');
  cat.human_review = { n: 5, agree: 4 };
  cat.history = [{ version: 1, human_skipped: false }];
  writeFileSync(join(dir, 'Seen_catalog.json'), JSON.stringify(cat));
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  const q = renderTab(join(dir, 'Seen_analysis_report.html'), 'quality');
  assert.match(q, /A human reviewed 5 at random and agreed with the judge on 4\./);
  assert.doesNotMatch(q, /human review is off|was skipped/);
  delete cat.human_review; cat.history = [];
  writeFileSync(join(dir, 'Seen_catalog.json'), JSON.stringify(cat));
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  assert.match(renderTab(join(dir, 'Seen_analysis_report.html'), 'quality'), /No human review recorded for this catalog version\./);
  /* a catalog frozen with --skip-human before 3.9 (no human_skipped_by) */
  cat.history = [{ version: 1, human_skipped: true }];
  writeFileSync(join(dir, 'Seen_catalog.json'), JSON.stringify(cat));
  assert.equal(cli('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis']).code, 0);
  assert.match(renderTab(join(dir, 'Seen_analysis_report.html'), 'quality'), /Not reviewed — human review was skipped when the catalog was frozen\./);
});
