#!/usr/bin/env node
/**
 * write-policy.mjs — Step 0.0b: ask once, at the very start, whether this run may write.
 *
 *   node write-policy.mjs status  --dir <connectorDir>
 *   node write-policy.mjs confirm --dir <connectorDir> --answer test|readonly
 *
 * Connectors are tested on test accounts, so write safety is off by default (3.7): use cases that
 * create, change or remove records run, including creates the connector cannot delete. Because the
 * skill is shared, every run starts with one question — "writes are on, into <workspace>; is this a
 * test account?" — asked before anything else, so the user answers and leaves it running.
 *
 * status   prints the policy in force and, when `write_policy.confirm_at_start` is on and writes are
 *          allowed, the line ASK with the question to put to the user (AskUserQuestion).
 * confirm  records the answer for this connector folder: `test` → writes run; `readonly` → this
 *          connector folder runs in safe mode (no irreversible writes, a pinned workspace) until
 *          answered again. Exit 0 always; the answer lives in <dir>/_write_choice.json.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, loadConfig, fail, EXIT, writePolicy } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';

const CMDS = ['status', 'confirm'];
const a = parseArgs(process.argv.slice(2), { known: ['dir', 'connector', 'answer'], usage: `usage: write-policy.mjs <${CMDS.join('|')}> --dir <connectorDir>` });
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: write-policy.mjs <${CMDS.join('|')}> --dir <connectorDir> [--answer test|readonly]`); process.exit(EXIT.USAGE); }
const cfg = loadConfig();

if (cmd === 'confirm') {
  if (!['test', 'readonly'].includes(a.answer)) fail('--answer must be test or readonly', EXIT.USAGE);
  writeJson(join(a.dir, '_write_choice.json'), { safe_mode: a.answer === 'readonly', answer: a.answer, at: new Date().toISOString() });
  const p = writePolicy(cfg, a.dir);
  console.log(`WRITES — ${a.answer === 'test' ? 'on: use cases that change data will run' : 'read only for this connector: no use case that changes data runs; they are reported as held'} (read_only ${p.read_only})`);
  process.exit(EXIT.OK);
}

/* status: the workspace the run will write into, when it is known */
let conn = null, K = null;
try { conn = resolveConnector(a.dir, a.connector); } catch { conn = null; }
if (conn && existsSync(join(a.dir, `${conn}_knowledge.json`))) K = readJson(join(a.dir, `${conn}_knowledge.json`));
const ws = K?.run_meta?.workspace;
const where = ws ? (typeof ws === 'object' ? `${ws.name || ''}${ws.id ? ` (${ws.id})` : ''}`.trim() : String(ws)) : (cfg.defaults?.write_policy?.workspace || 'the account the connection points at');
const p = writePolicy(cfg, a.dir);
const writes = p.execute_reversible || p.execute_irreversible;
console.log(`WRITES — ${p.read_only ? 'read only: nothing that changes data runs' : p.safe_mode ? 'safe mode: irreversible writes held, workspace pin required' : writes ? `on${p.execute_irreversible ? ', including creates the connector cannot delete' : ' (reversible only)'}` : 'off'} · workspace: ${where}`);
if (p.choice) console.log(`  last answer: ${p.choice.answer} (${String(p.choice.at || '').slice(0, 16).replace('T', ' ')})`);
/* asked at every run start while the config allows writes — a "read only" answer last time does not silence it */
const configured = writePolicy(cfg);
if (p.confirm_at_start && (configured.execute_reversible || configured.execute_irreversible))
  console.log(`ASK — "This run can create and change records in ${where}, and some records it creates cannot be deleted through the connector. Is this a test account?" Options: "Yes, a test account — run writes" → confirm --answer test · "No, read only this time" → confirm --answer readonly`);
