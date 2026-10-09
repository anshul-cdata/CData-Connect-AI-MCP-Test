#!/usr/bin/env node
/**
 * preflight-data.mjs — make sure every test has data to work on, before any agent is paid for.
 *
 *   node preflight-data.mjs prep    --dir <connectorDir> --me <connection user id> [--today YYYY-MM-DD]
 *   node preflight-data.mjs merge   --dir <connectorDir> --checks <file>
 *   node preflight-data.mjs release --dir <connectorDir> [--tcs TC-001,TC-002 | --all]
 *
 * Why: a read test is checked by re-running its reference query after the agent answers. When the
 * test account holds nothing that query can find, every model "finds nothing", the check can only
 * say "no test data", and the attempts were paid for and measured nothing (Asana asn-eval1:
 * "Which files have been attached to tasks in Website Relaunch?" — no attachments were seeded).
 *
 * prep    lists, for the orchestrator to run through the MCP connection (queryData) before Stage 9,
 *         the query that shows each test's data, placeholders filled:
 *           a read test          its reference query
 *           any test with check.data_sql  that query — the records the use case is about (3.5:
 *                                a judged question, or an action on an existing record)
 *           an action that only changes existing records (update, delete — from the capability
 *                                list) and has no data_sql   its reference query, as the record to change
 *         A judged question with no data_sql cannot be checked here — the catalog should give one.
 * merge   reads {"checks":[{"tc","rows":<count>,"error"}]}. A test whose reference finds no rows is
 *         held (executable: false, data_hold: true) with the reason, so it is not dispatched:
 *         seed the data and run prep again, or release it to run anyway.
 * release puts held tests back in the plan.
 *
 * merge also prints each business area's readiness: how many of its use cases can actually test the
 * AI on this account. Below `execution.area_ready_min` (default 0.5) it prints AREA NOT READY — the
 * orchestrator stops and asks the user to seed data, switch to an account with the features, or run
 * anyway knowing the AI figures will be thin (asn-tr1: 3 of 43 use cases tested the AI).
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readJson, writeJson, fail, EXIT, loadConfig } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { fillSql } from './lib/checks.mjs';
import { changesExisting } from './lib/capabilities.mjs';

const CMDS = ['prep', 'merge', 'release'];
const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'me', 'today', 'checks', 'tcs', 'all'],
  usage: `usage: preflight-data.mjs <${CMDS.join('|')}> --dir <connectorDir>`,
});
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: preflight-data.mjs <${CMDS.join('|')}> --dir <connectorDir>`); process.exit(EXIT.USAGE); }
const conn = resolveConnector(a.dir, a.connector);
const PLAN = join(a.dir, `${conn}_plan.json`);
if (!existsSync(PLAN)) fail(`no ${PLAN} — generate the plan first (generate-tests.mjs)`);
const plan = readJson(PLAN);
const tcs = plan.tc_list || [];
const OUT = join(a.dir, '_agent_out', 'data-check-input.json');
const HOLD = 'No test data: the reference query finds no rows in the test account, so any answer would be unverifiable. Seed the data, or release the test to run it anyway.';
const HOLD_TARGET = 'No test data: the record this action changes does not exist in the test account, so the change could not be tested. Seed it, or release the test to run it anyway.';
const CAPS = join(a.dir, `${conn}_capabilities.json`);
const capById = new Map((existsSync(CAPS) ? readJson(CAPS).capabilities || [] : []).map(c => [c.id, c]));

/** A test still carrying {{fixture:…}} was held because its records are not bound; releasing it
 * would send the agent the placeholder itself (review 3.7.1). */
const unrendered = t => /\{\{fixture:/.test(JSON.stringify([t.prompt, t.check, t.expected_behavior]));
/** A test that only reads, and whose answer is decided by re-running a reference query. */
const isReadCheck = t => t.suite === 'business' && t.check?.reference_sql && t.kind !== 'action'
  && t.writes !== true && t.mutates !== true && t.check.rule !== 'write_visible';
/** The query whose rows this test needs, and what an empty result means — or null. */
const dataQuery = t => {
  if (t.suite !== 'business') return null;
  if (t.check?.data_sql) return { sql: t.check.data_sql, hold: t.kind === 'action' ? HOLD_TARGET : HOLD };
  if (isReadCheck(t)) return { sql: t.check.reference_sql, hold: HOLD };
  if (t.kind === 'action' && t.check?.reference_sql && changesExisting(t.capabilities, capById)) return { sql: t.check.reference_sql, hold: HOLD_TARGET };
  return null;
};

if (cmd === 'prep') {
  if (!a.me || a.me === true) fail('--me must name the connection\'s own user id — it fills {{me}} in the reference queries', EXIT.USAGE);
  const K = existsSync(join(a.dir, `${conn}_knowledge.json`)) ? readJson(join(a.dir, `${conn}_knowledge.json`)) : {};
  const ws = K.run_meta?.workspace;
  const ctx = { me: String(a.me), today: a.today && a.today !== true ? String(a.today) : undefined, workspace: typeof ws === 'object' ? ws?.id : ws };
  const items = tcs.filter(t => dataQuery(t) && (t.executable !== false || t.data_hold))
    .map(t => ({ tc: t.id, use_case_id: t.use_case_id || null, sql: fillSql(dataQuery(t).sql, ctx) }));
  const unchecked = tcs.filter(t => t.suite === 'business' && t.executable !== false && !t.probe && !dataQuery(t) && t.check?.rule === 'judge' && t.kind !== 'action');
  writeJson(OUT, { connector: conn, at: new Date().toISOString(),
    instructions: ['Run every sql through the MCP connection (queryData) exactly as written. Return',
      '{"checks":[{"tc","rows":<number of rows returned>,"error":<message or null>}]} with one entry per item.'],
    items });
  console.log(`DATA CHECK — ${conn} · ${items.length} test(s) to check before dispatch\n→ ${OUT}`);
  if (unchecked.length) console.log(`  ⚠ ${unchecked.length} judged question(s) have no check.data_sql, so their data cannot be checked: ${unchecked.slice(0, 8).map(t => t.use_case_id || t.id).join(', ')}${unchecked.length > 8 ? ' …' : ''}`);
  process.exit(EXIT.OK);
}

if (cmd === 'merge') {
  if (!a.checks || !existsSync(a.checks)) fail('--checks must name the orchestrator\'s results', EXIT.USAGE);
  const C = JSON.parse(readFileSync(a.checks, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const byTc = new Map((C.checks || []).map(c => [c.tc, c]));
  const held = [], errors = [], released = [];
  for (const t of tcs) {
    const c = byTc.get(t.id);
    if (!c) continue;
    if (c.error) { errors.push(`${t.id}: ${String(c.error).slice(0, 120)}`); continue; }
    if (Number(c.rows) === 0) {
      if (t.executable !== false || t.data_hold) { Object.assign(t, { executable: false, data_hold: true, nt_reason: dataQuery(t)?.hold || HOLD }); held.push(t); }
    } else if (t.data_hold && !unrendered(t)) { t.executable = true; delete t.data_hold; delete t.nt_reason; released.push(t.id); }
  }
  plan.data_check = { at: new Date().toISOString(), checked: byTc.size, held: held.map(t => t.id), errors: errors.length };
  writeJson(PLAN, plan);
  console.log(`DATA CHECK — ${conn} · ${byTc.size} checked · ${held.length} held for lack of data · ${errors.length} reference query error(s)${released.length ? ` · ${released.length} released (data found now)` : ''}`);
  for (const t of held.slice(0, 25)) console.log(`  ⏸ ${t.id} ${t.use_case_id || ''} — "${String(t.prompt || t.uc || '').slice(0, 80)}"`);
  for (const e of errors.slice(0, 10)) console.log(`  ✗ ${e}`);
  if (errors.length) console.log('  A reference query that errors cannot check any answer — fix it in the catalog before running these tests.');
  if (held.length) console.log('\n  Seed the data in the test account and run prep again, or: preflight-data.mjs release --tcs <ids>');
  /* per area: how many use cases can test the AI here (dispatched, with data). One use case counts
   * once however many tests (wordings) it has. */
  const MIN = Number(loadConfig().execution?.area_ready_min ?? 0.5);
  const areas = new Map();
  for (const t of tcs.filter(x => x.suite === 'business')) {
    const k = t.business_domain || t.business_process || '—';
    if (!areas.has(k)) areas.set(k, { name: t.business_process || k, ucs: new Map() });
    const ucs = areas.get(k).ucs, id = t.use_case_id || t.id;
    const st = t.executable !== false ? 'ready' : t.data_hold ? 'no_data' : /^Not possible/.test(t.nt_reason || '') ? 'not_possible' : 'other';
    if (!ucs.has(id) || st === 'ready') ucs.set(id, st);
  }
  const ready = [];
  console.log('\n  READINESS — use cases that can test the AI on this account');
  for (const [k, ar] of areas) {
    const v = [...ar.ucs.values()], n = v.length, ok = v.filter(x => x === 'ready').length;
    const share = n ? ok / n : 0;
    ready.push({ area: k, name: ar.name, use_cases: n, ready: ok, no_data: v.filter(x => x === 'no_data').length, not_possible: v.filter(x => x === 'not_possible').length, share: Math.round(share * 100) / 100 });
    console.log(`  ${share >= MIN ? '✓' : '⚠ AREA NOT READY'} ${ar.name}: ${ok} of ${n} ready · ${v.filter(x => x === 'no_data').length} held for data · ${v.filter(x => x === 'not_possible').length} not possible through the connector`);
  }
  plan.data_check.readiness = ready;
  writeJson(PLAN, plan);
  if (ready.some(r => r.share < MIN)) console.log(`\n  An area below ${Math.round(MIN * 100)}% ready will mostly measure the test account, not the AI. Ask the user: seed data, switch to an account with these features, or run anyway.`);
  process.exit(EXIT.OK);
}

if (cmd === 'release') {
  const want = a.all === true ? null : new Set(String(a.tcs || '').split(',').map(s => s.trim()).filter(Boolean));
  if (want && !want.size) fail('--tcs TC-001,TC-002 or --all', EXIT.USAGE);
  let n = 0;
  const kept = [];
  for (const t of tcs) if (t.data_hold && (!want || want.has(t.id))) {
    if (unrendered(t)) { kept.push(t.id); continue; }
    t.executable = true; delete t.data_hold; delete t.nt_reason; n++;
  }
  if (kept.length) console.log(`  ${kept.length} test(s) kept: their records are not bound yet (test-data.mjs find/seed, then generate-tests.mjs) — ${kept.slice(0, 8).join(', ')}`);
  writeJson(PLAN, plan);
  console.log(`  ${n} test(s) released — they will run, and may end as "no test data"`);
  process.exit(EXIT.OK);
}
