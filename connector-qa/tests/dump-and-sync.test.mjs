/* The last two scripts with no behavioural cover.
 *
 * `mine-dump.mjs` carries a hand-rolled RFC-4180 CSV parser — quoted fields, embedded commas,
 * embedded newlines, doubled quotes, a BOM — 323 lines of it, running in no test. Its output is
 * customer_evidence.json, which decides which CUSTOMER gaps exist, so a parsing slip becomes a
 * coverage decision.
 *
 * The fixtures use bracketed, qualified identifiers because that is what CData Connect AI emits.
 * An earlier version of this file used bare `FROM Tasks`, every object assertion failed, and the
 * code was right — the test was wrong about what a real dump looks like.
 *
 * `sync-skill.mjs` has one job it must not get wrong: never propagate the machine-local
 * `config.root` between the repo and the deployed copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const run = (s, args, opts = {}) =>
  execFileSync(process.execPath, [join(SK, 'scripts', s), ...args], { encoding: 'utf8', stdio: 'pipe', ...opts });
const runCode = (s, args, opts = {}) => {
  try { run(s, args, opts); return 0; } catch (e) { return e.status ?? 1; }
};
const tmp = () => mkdtempSync(join(tmpdir(), 'cqa-dmp-'));

const T = '[Demo1].[Demo].[Tasks]';
const P = '[Demo1].[Demo].[Projects]';

function mine(csv, name = 'dump.csv') {
  const dir = tmp();
  writeFileSync(join(dir, name), csv, 'utf8');
  /* spawnSync rather than execFileSync: stderr on a SUCCESSFUL run is only reachable this way, and
     one of these cases is a warning printed alongside exit 0. */
  const r = spawnSync(process.execPath,
    [join(SK, 'scripts', 'mine-dump.mjs'), join(dir, name), '--connector', 'Demo', '--out', dir],
    { encoding: 'utf8' });
  const out = join(dir, 'customer_evidence.json');
  return { code: r.status ?? 1, stderr: String(r.stderr || ''), dir,
    ev: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
}
const sawTasks = ev => Object.keys((ev && ev.object_frequency) || {}).some(k => /tasks/i.test(k));

/* ── mine-dump · the CSV parser ────────────────────────────────────────────── */

test('mine-dump: a plain dump yields object frequencies', () => {
  const { ev } = mine([
    'Query,RowsReturned',
    `"SELECT [Id] FROM ${T} WHERE [Status] = 'open'",10`,
    `"SELECT [Id] FROM ${T}",4`,
    `"SELECT [Id] FROM ${P}",2`,
  ].join('\n'));
  assert.ok(ev, 'customer_evidence.json must be written');
  assert.equal(ev.available, true);
  const tasks = Object.entries(ev.object_frequency || {}).find(([k]) => /tasks/i.test(k));
  assert.ok(tasks, 'Tasks should appear in the frequency table');
  assert.equal(tasks[1], 2, 'Tasks was queried twice');
});

test('mine-dump: a quoted field containing a comma is one field, not two', () => {
  /* Splitting on commas would turn one query into two malformed ones, and the object frequencies
     — which drive CUSTOMER gap priority — would silently shift. */
  const { ev } = mine(['Query,RowsReturned',
    `"SELECT [Id], [Name], [Status] FROM ${T}",7`].join('\n'));
  assert.ok(sawTasks(ev), 'a quoted comma must not break the row');
});

test('mine-dump: an embedded newline inside quotes stays one row', () => {
  const { ev } = mine(`Query,RowsReturned\n"SELECT [Id]\n  FROM ${T}\n  WHERE [Status] = 'x'",3\n`);
  assert.ok(sawTasks(ev), 'a multi-line query is one record — splitting on newlines makes three broken ones');
});

test('mine-dump: a doubled quote is an escaped quote', () => {
  const { ev } = mine(`Query,RowsReturned\n"SELECT [Id] FROM ${T} WHERE [Name] = ""x""",1\n`);
  assert.ok(sawTasks(ev), 'doubled quotes are the RFC-4180 escape and must not terminate the field');
});

test('mine-dump: a UTF-8 BOM does not hide the Query column', () => {
  /* Excel writes one. Attached to the first header the column is named "\uFEFFQuery", the file is
     skipped as having no Query column, and the run reports that nothing matched. */
  const { ev, code } = mine(`\uFEFFQuery,RowsReturned\n"SELECT [Id] FROM ${T}",1\n`);
  assert.equal(code, 0, 'a BOM must not make the dump unreadable');
  assert.ok(sawTasks(ev), 'the Query column must still be found');
});

test('mine-dump: a file with no Query column is refused, not silently empty', () => {
  const { code } = mine('Something,Else\n1,2\n');
  assert.notEqual(code, 0, 'nothing matched — a non-zero exit, not an empty success');
});

test('mine-dump: rows that parse but yield no object are flagged as unreadable, not absent', () => {
  /* Unbracketed SQL parses as rows and extracts nothing. Reporting that as "no customer evidence"
     is wrong in a way that silently weakens every downstream priority. */
  const { stderr } = mine('Query\n"SELECT Id FROM Tasks"\n');
  assert.match(stderr, /no object was recognised/i, 'an unreadable dump must say so');
});

/* ── sync-skill · the one thing it must not get wrong ──────────────────────── */

test('sync-skill: config.root is never propagated between copies', () => {
  /* The repo is the shared copy and must carry no home directory; the deployed skill lives outside
     the project and genuinely needs an absolute path. Copying config.json wholesale put one
     machine's path into the other, and a username into the shared copy. */
  const fake = join(tmp(), 'skill');
  mkdirSync(join(fake, 'scripts'), { recursive: true });
  writeFileSync(join(fake, 'config.json'),
    JSON.stringify({ version: '2.1.0', root: 'C:/Users/SomeoneElse/deployed', defaults: {} }, null, 2));
  writeFileSync(join(fake, 'SKILL.md'), '# fake\n');

  const repo = tmp();
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'config.json'),
    JSON.stringify({ version: '2.0.0', root: '', defaults: {} }, null, 2));
  writeFileSync(join(repo, 'SKILL.md'), '# repo\n');
  writeFileSync(join(repo, 'scripts', 'sync-skill.mjs'),
    readFileSync(join(SK, 'scripts', 'sync-skill.mjs'), 'utf8'));

  runCode('sync-skill.mjs', ['--pull'], { cwd: repo, env: { ...process.env, CONNECTOR_QA_SKILL: fake } });

  const after = JSON.parse(readFileSync(join(repo, 'config.json'), 'utf8'));
  assert.equal(after.root, '', 'the repo must keep its empty root — never inherit a home directory');
  assert.equal(after.version, '2.1.0', 'everything else must still sync');
  const deployed = JSON.parse(readFileSync(join(fake, 'config.json'), 'utf8'));
  assert.equal(deployed.root, 'C:/Users/SomeoneElse/deployed', 'the deployed copy keeps its own root');
});

test('sync-skill: a report-only run changes nothing', () => {
  const before = readFileSync(join(SK, 'config.json'), 'utf8');
  runCode('sync-skill.mjs', [], { cwd: SK });
  assert.equal(readFileSync(join(SK, 'config.json'), 'utf8'), before,
    'without --pull or --push it must only report drift');
});
