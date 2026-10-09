#!/usr/bin/env node
/**
 * test-data.mjs — the records each use case needs: use what the account has, create only what is
 * missing (3.7). See lib/fixtures.mjs for what a fixture is.
 *
 *   node test-data.mjs survey-prep --dir <d> --areas TM          sample what the account holds, for the writer
 *   node test-data.mjs survey-merge --dir <d> --checks <f>
 *   node test-data.mjs find-prep  --dir <d> [--areas a,b] --me <user id> [--all]
 *   node test-data.mjs find-merge --dir <d> --checks <f>
 *   node test-data.mjs seed-prep  --dir <d> --me <user id>       the INSERTs for what is still missing
 *   node test-data.mjs seed-merge --dir <d> --checks <f>
 *   node test-data.mjs status     --dir <d> [--areas a,b]
 *
 * survey  Before use cases are written (Stage 5.5a′): a few real rows of every table the area uses,
 *         so the writer builds use cases and fixtures around records that exist — real project
 *         names, real people — instead of inventing them. Reads only.
 * find    After the area is frozen: each fixture's find_sql, in dependency order; the first row
 *         returned is bound ("found"). Run prep/merge again until nothing new can be found.
 * seed    For fixtures still missing: their INSERT statements, placeholders filled. SHOW THEM TO THE
 *         USER and run them only after a yes. merge records success, or a refusal (the account's plan
 *         or rights → "refused"; the use cases that need it are then blocked by the account, not
 *         run). After seeding, run find again: it binds what was created ("seeded").
 * status  per area: fixtures found · seeded · missing · refused, and use cases ready.
 *
 * Bindings: <Connector>_test_data.json. generate-tests.mjs renders requests and checks from it; a
 * use case whose fixture is not bound is held with the reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { fillSql } from './lib/checks.mjs';
import { classifyError } from './lib/journey.mjs';
import { bindOrder, renderFixtures, boundValues, fixtureRefs, fixtureProblems } from './lib/fixtures.mjs';
import { resolveAreas } from './lib/scope.mjs';

const CMDS = ['survey-prep', 'survey-merge', 'find-prep', 'find-merge', 'seed-prep', 'seed-merge', 'status'];
const a = parseArgs(process.argv.slice(2), { known: ['dir', 'connector', 'areas', 'me', 'today', 'checks', 'all'], usage: `usage: test-data.mjs <${CMDS.join('|')}> --dir <connectorDir>` });
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: test-data.mjs <${CMDS.join('|')}> --dir <connectorDir> [--areas a,b] [--me <id>] [--checks <f>]`); process.exit(EXIT.USAGE); }
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const OUT = n => join(a.dir, '_agent_out', `test-data-${n}.json`);
const maybe = n => existsSync(P(n)) ? readJson(P(n)) : null;
const K = maybe('knowledge') || {};
const capsDoc = maybe('capabilities');
const cat = maybe('catalog');
const ws = K.run_meta?.workspace;
const ctx = () => ({ me: a.me && a.me !== true ? String(a.me) : undefined, today: a.today && a.today !== true ? String(a.today) : undefined,
                     workspace: typeof ws === 'object' ? ws?.id : ws });
const readChecks = () => {
  if (!a.checks || !existsSync(a.checks)) fail('--checks must name the orchestrator\'s results', EXIT.USAGE);
  return JSON.parse(readFileSync(a.checks, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
};
const areasWanted = () => {
  if (!a.areas || a.areas === true) return null;
  const { ids, unknown } = resolveAreas(capsDoc, a.areas);
  if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')}`, EXIT.USAGE);
  return ids;
};
const TD = () => maybe('test_data') || { connector: conn, fixtures: {} };
const saveTD = td => { td.at = new Date().toISOString(); td.workspace = ctx().workspace ?? null; writeJson(P('test_data'), td); };
const fixturesIn = areas => (cat?.fixtures || []).filter(f => !areas || areas.includes(f.area));
const fill = (sql, values) => {
  /* a statement naming the workspace when none is known would run with '' — refuse instead */
  if (/\{\{workspace\}\}/.test(sql) && !ctx().workspace) fail('a find or seed statement uses {{workspace}}, but run_meta.workspace is not recorded — record it at discovery (references/01-discovery.md §1.0a)');
  return fillSql(renderFixtures(sql, values, { sql: true }).text, ctx());
};
const needsMe = () => { if (!a.me || a.me === true) fail('--me must name the connection\'s own user id — it fills {{me}}', EXIT.USAGE); };

/* ── survey: what the account holds, for the writer ──────────────────────── */
if (cmd === 'survey-prep') {
  const areas = areasWanted();
  if (!capsDoc) fail('no capability list yet (Stage 1.5)');
  const catalog = K.run_meta?.catalog, schema = K.run_meta?.schema;
  if (!catalog || !schema) fail('the knowledge file has no run_meta.catalog / schema — finish discovery first');
  const ids = new Set((capsDoc.areas || []).filter(ar => !areas || areas.includes(ar.id)).flatMap(ar => [...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])]));
  const tables = [...new Set((capsDoc.capabilities || []).filter(c => ids.has(c.id)).flatMap(c => (c.mapping?.exposure || []).filter(e => e.kind === 'table').map(e => e.name)))].sort();
  writeJson(OUT('survey'), { connector: conn, at: new Date().toISOString(),
    instructions: ['Run every sql through queryData (reads only). Return {"tables":[{"table","rows":[…up to 5 rows…],"error"}]}.',
      'A table that needs a filter to be read: say so in error; do not guess ids.'],
    items: tables.map(t => ({ table: t, sql: `SELECT * FROM [${catalog}].[${schema}].[${t}] LIMIT 5` })) });
  console.log(`DATA SURVEY — ${conn} · ${tables.length} table(s) to sample${areas ? ` for ${areas.join(', ')}` : ''}\n→ ${OUT('survey')}`);
  process.exit(EXIT.OK);
}
if (cmd === 'survey-merge') {
  const S = readChecks();
  const doc = maybe('data_survey') || { connector: conn, tables: {} };
  /* keep it small: the writer needs names and shapes, not the data */
  const slim = row => Object.fromEntries(Object.entries(row || {}).filter(([, v]) => v !== null && v !== '' && String(v).length <= 120).slice(0, 12));
  for (const t of S.tables || []) if (t.table) doc.tables[t.table] = t.error ? { error: String(t.error).slice(0, 300), class: classifyError(String(t.error)).class } : { rows: (t.rows || []).slice(0, 5).map(slim), empty: !(t.rows || []).length };
  doc.at = new Date().toISOString();
  writeJson(P('data_survey'), doc);
  const T = Object.values(doc.tables);
  console.log(`DATA SURVEY — ${conn} · ${T.length} table(s): ${T.filter(t => t.rows?.length).length} with records · ${T.filter(t => t.empty).length} empty · ${T.filter(t => t.error).length} not readable as is\n→ ${P('data_survey')}`);
  console.log('  Give this file to the catalog writer: use cases and fixtures are built around records that exist.');
  process.exit(EXIT.OK);
}

if (!cat) fail(`no ${P('catalog')} — research and freeze an area first`);
const probs = fixtureProblems(cat);
if (probs.length && cmd !== 'status') fail(`the catalog's fixtures have problems — fix them first (manage-catalog.mjs validate):\n  ${probs.slice(0, 8).join('\n  ')}`);

/* ── find: bind each fixture to a real record ────────────────────────────── */
if (cmd === 'find-prep') {
  needsMe();
  const td = TD(), values = boundValues(td), areas = areasWanted();
  const { order } = bindOrder(cat.fixtures || []);
  const want = new Set(fixturesIn(areas).map(f => f.id));
  const items = [];
  for (const f of order) {
    if (!want.has(f.id)) continue;
    const st = td.fixtures[f.id]?.status;
    if (!a.all && ['found', 'seeded'].includes(st)) continue;
    if ((f.depends_on || []).some(d => !values[d])) continue;          // its parent is not bound yet
    items.push({ fixture: f.id, describe: f.describe, sql: fill(f.find_sql, values) });
  }
  writeJson(OUT('find'), { connector: conn, at: new Date().toISOString(),
    instructions: ['Run every sql through queryData exactly as written (reads only).',
      'Return {"finds":[{"fixture","rows":[…the first 3 rows…],"error"}]}, one entry per item. Then run find-merge, and find-prep again until it lists nothing.'],
    items });
  const waiting = order.filter(f => want.has(f.id) && !items.some(i => i.fixture === f.id) && !['found', 'seeded'].includes(td.fixtures[f.id]?.status));
  console.log(`FIND — ${conn} · ${items.length} fixture(s) to look for${waiting.length ? ` · ${waiting.length} wait for a parent to be bound` : ''}\n→ ${OUT('find')}`);
  process.exit(EXIT.OK);
}
if (cmd === 'find-merge') {
  const C = readChecks(), td = TD();
  let found = 0, missing = 0, errors = 0;
  for (const x of C.finds || []) {
    if (!x.fixture) continue;
    const prev = td.fixtures[x.fixture] || {};
    if (x.error) {
      const k = classifyError(String(x.error));
      td.fixtures[x.fixture] = { ...prev, status: k.cause === 'account' ? 'refused' : 'error', error: String(x.error).slice(0, 300), at: new Date().toISOString() }; errors++;
    } else if ((x.rows || []).length) {
      const row = x.rows[0];
      td.fixtures[x.fixture] = { status: prev.status === 'seed_sent' ? 'seeded' : 'found', values: Object.fromEntries(Object.entries(row).slice(0, 20)), at: new Date().toISOString() }; found++;
    } else { td.fixtures[x.fixture] = { ...prev, status: prev.status === 'seed_sent' ? 'seed_not_found' : 'missing', at: new Date().toISOString() }; missing++; }
  }
  saveTD(td);
  console.log(`FIND — ${conn} · ${found} bound · ${missing} not in the account · ${errors} error(s)`);
  if (missing) console.log('  Run find-prep again for fixtures that depend on these, then seed-prep for what is still missing.');
  process.exit(EXIT.OK);
}

/* ── seed: create only what is missing, after the user agrees ────────────── */
if (cmd === 'seed-prep') {
  needsMe();
  const td = TD(), values = boundValues(td), areas = areasWanted();
  const items = [], noSeed = [];
  for (const f of bindOrder(fixturesIn(areas)).order) {
    if (td.fixtures[f.id]?.status !== 'missing') continue;
    if ((f.depends_on || []).some(d => !values[d])) continue;
    const seed = [].concat(f.seed || []);
    if (!seed.length) { noSeed.push(f.id); continue; }
    items.push({ fixture: f.id, describe: f.describe, statements: seed.map(s => fill(s, values)) });
  }
  writeJson(OUT('seed'), { connector: conn, at: new Date().toISOString(),
    instructions: ['SHOW EVERY STATEMENT TO THE USER FIRST and run them only after a yes — they create records.',
      'Run each through execute_insert. Return {"seeds":[{"fixture","ok":true|false,"error"}]}, then seed-merge, then find-prep/find-merge to bind what was created.'],
    items });
  console.log(`SEED — ${conn} · ${items.length} fixture(s) to create (${items.reduce((n, i) => n + i.statements.length, 0)} statement(s))${noSeed.length ? ` · ${noSeed.length} missing with no seed: ${noSeed.join(', ')}` : ''}\n→ ${OUT('seed')}`);
  for (const i of items.slice(0, 20)) console.log(`  + ${i.fixture} — ${i.describe}`);
  process.exit(EXIT.OK);
}
if (cmd === 'seed-merge') {
  const C = readChecks(), td = TD();
  let ok = 0, refused = 0, failed = 0;
  for (const x of C.seeds || []) {
    if (!x.fixture) continue;
    const prev = td.fixtures[x.fixture] || {};
    if (x.ok) { td.fixtures[x.fixture] = { ...prev, status: 'seed_sent', seeded_at: new Date().toISOString() }; ok++; }
    else {
      const k = classifyError(String(x.error || ''));
      td.fixtures[x.fixture] = { ...prev, status: k.cause === 'account' ? 'refused' : 'seed_failed', error: String(x.error || '').slice(0, 300) };
      if (k.cause === 'account') refused++; else failed++;
    }
  }
  saveTD(td);
  console.log(`SEED — ${conn} · ${ok} created · ${refused} refused by the account · ${failed} failed`);
  if (ok) console.log('  Now run find-prep / find-merge to bind the created records.');
  if (refused) console.log('  The use cases that need a refused fixture will be planned as blocked by the account.');
  process.exit(EXIT.OK);
}

/* ── status ──────────────────────────────────────────────────────────────── */
const td = TD(), areas = areasWanted();
const values = boundValues(td);
if (probs.length) console.log(`⚠ fixture problems:\n  ${probs.slice(0, 8).join('\n  ')}`);
const byArea = new Map();
for (const f of fixturesIn(areas)) { if (!byArea.has(f.area)) byArea.set(f.area, []); byArea.get(f.area).push(f); }
console.log(`TEST DATA — ${conn}${td.at ? ` · bound ${String(td.at).slice(0, 16).replace('T', ' ')}` : ''}`);
for (const [ar, fs] of byArea) {
  const st = s => fs.filter(f => (td.fixtures[f.id]?.status || 'not looked for') === s).length;
  const ucs = (cat.use_cases || []).filter(u => u.status !== 'retired' && u.area === ar);
  const ready = ucs.filter(u => [...fixtureRefs(u)].every(id => values[id])).length;
  console.log(`  ${ar}: ${fs.length} fixture(s) · ${st('found')} found · ${st('seeded')} seeded · ${st('missing') + st('seed_not_found')} missing · ${st('refused')} refused · ${st('not looked for')} not looked for — ${ready} of ${ucs.length} use cases have their data`);
}
if (!byArea.size) console.log('  no fixtures in scope — this catalog predates 3.7, or the area uses none');
