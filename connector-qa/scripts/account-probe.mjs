#!/usr/bin/env node
/**
 * account-probe.mjs — Stage 1.5d: what the TEST ACCOUNT can show, before research is paid for.
 *
 *   node account-probe.mjs prep  --dir <connectorDir>
 *   node account-probe.mjs merge --dir <connectorDir> --checks <file>
 *
 * Why (3.6): the Asana time-tracking area spent ~300k tokens on research and a full run before it
 * was clear the account's plan has no time tracking or resource management — every read empty,
 * every write refused, 36 of 43 use cases blocked. One read per table shows that in a few thousand.
 *
 * prep   lists one `SELECT * … LIMIT 1` per table the capability list exposes, for the orchestrator
 *        to run through the MCP connection (queryData). Reads only: nothing is written.
 * merge  reads {"probes":[{"table","rows","error"}]} and records, per table, data · empty ·
 *        refused (the account's plan or rights) · needs_filter (the table cannot be read without
 *        one, so its data is unknown) · error, in <Connector>_account.json. It prints each business
 *        area's readiness; `scope.mjs status` shows it beside the areas, so the user knows before
 *        choosing --areas. Research stays allowed — it is reusable on a better account.
 * A write refused by the plan cannot be seen by a read; it shows when test data is seeded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { classifyError } from './lib/journey.mjs';
import { accountReadiness } from './lib/capabilities.mjs';

const CMDS = ['prep', 'merge'];
const a = parseArgs(process.argv.slice(2), { known: ['dir', 'connector', 'checks'], usage: `usage: account-probe.mjs <${CMDS.join('|')}> --dir <connectorDir>` });
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: account-probe.mjs <${CMDS.join('|')}> --dir <connectorDir> [--checks <f>]`); process.exit(EXIT.USAGE); }
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
if (!existsSync(P('capabilities'))) fail(`no ${P('capabilities')} — build the capability list first (Stage 1.5)`);
const capsDoc = readJson(P('capabilities'));
const K = existsSync(P('knowledge')) ? readJson(P('knowledge')) : {};
const catalog = K.run_meta?.catalog, schema = K.run_meta?.schema;
const tables = [...new Set((capsDoc.capabilities || []).flatMap(c => (c.mapping?.exposure || []).filter(e => e.kind === 'table').map(e => e.name)))].sort();

if (cmd === 'prep') {
  if (!catalog || !schema) fail('the knowledge file has no run_meta.catalog / run_meta.schema — finish discovery (Stage 1) first');
  const OUT = join(a.dir, '_agent_out', 'account-probe-input.json');
  writeJson(OUT, { connector: conn, at: new Date().toISOString(),
    instructions: ['Run every sql through the MCP connection (queryData) exactly as written — reads only.',
      'Return {"probes":[{"table","rows":<number of rows returned>,"error":<the error message or null>}]} with one entry per item.'],
    items: tables.map(t => ({ table: t, sql: `SELECT * FROM [${catalog}].[${schema}].[${t}] LIMIT 1` })) });
  console.log(`ACCOUNT PROBE — ${conn} · ${tables.length} table(s) to read once\n→ ${OUT}`);
  process.exit(EXIT.OK);
}

if (!a.checks || !existsSync(a.checks)) fail('--checks must name the orchestrator\'s results', EXIT.USAGE);
const C = JSON.parse(readFileSync(a.checks, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
const out = {};
for (const p of C.probes || []) {
  if (!p.table) continue;
  if (p.error) {
    const k = classifyError(String(p.error));
    out[p.table] = { status: k.cause === 'account' ? 'refused' : k.class === 'required_filter' ? 'needs_filter' : 'error', error: String(p.error).slice(0, 300), class: k.class };
  } else out[p.table] = { status: Number(p.rows) > 0 ? 'data' : 'empty' };
}
const doc = { connector: conn, at: new Date().toISOString(), tables: out };
writeJson(P('account'), doc);
const R = accountReadiness(capsDoc, doc);
console.log(`ACCOUNT PROBE — ${conn} · ${Object.keys(out).length} table(s) read · ${Object.values(out).filter(x => x.status === 'data').length} hold data`);
for (const r of R) console.log(`  ${r.share >= 0.5 ? '✓' : '⚠'} ${r.name}: ${r.data} of ${r.tables} table(s) hold data · ${r.empty} empty · ${r.refused} refused by the account${r.needs_filter ? ` · ${r.needs_filter} need a filter to read` : ''}`);
if (R.some(r => r.share < 0.5)) console.log('\n  Areas marked ⚠ will mostly measure the test account. Tell the user before research: seed data, use an account with these features, or research anyway (research is reusable).');
console.log(`→ ${P('account')}`);
