#!/usr/bin/env node
/**
 * check-harness.mjs — before Stage 9: will the test harness let the agents use the connector?
 *
 *   node check-harness.mjs --server <MCP server id> [--project <dir>] [--strict]
 *
 * In Claude Code's auto permission mode a classifier decides, call by call, whether a tool that is
 * not on the allow list may run. In asn-eval1 it refused connector calls at random — a write here,
 * a read of the Users table there — so some attempts failed because of the harness, not the model
 * or the connector. An eval is only fair when every model meets the same harness: every connector
 * tool the agents use is allowed up front.
 *
 * Reads permissions.allow from the user's and the project's settings (settings.json and
 * settings.local.json) and lists the connector tools that are not allowed. It never edits a
 * settings file: permissions are the user's to grant. Exit 0 = all allowed (or warnings only);
 * exit 3 with --strict when any is missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from './lib/cli.mjs';
import { EXIT } from './lib/artifacts.mjs';

const CONNECTOR_TOOLS = ['getInstructions', 'getCatalogs', 'getSchemas', 'getTables', 'getColumns', 'getProcedures',
  'getProcedureParameters', 'queryData', 'search_context', 'executeProcedure', 'execute_insert', 'execute_update'];

const a = parseArgs(process.argv.slice(2), { known: ['server', 'project', 'strict', 'home'], usage: 'usage: check-harness.mjs --server <MCP server id> [--project <dir>]' });
if (!a.server || a.server === true) { console.error('usage: check-harness.mjs --server <MCP server id> [--project <dir>] [--strict]'); process.exit(EXIT.USAGE); }
const server = String(a.server).replace(/^mcp__/, '').replace(/__.*$/, '');
const home = a.home && a.home !== true ? String(a.home) : homedir();
const project = resolve(a.project && a.project !== true ? String(a.project) : process.cwd());
const files = [join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json'),
  join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json')];

const allow = [], read = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  try { const j = JSON.parse(readFileSync(f, 'utf8')); allow.push(...(j.permissions?.allow || [])); read.push(f); }
  catch (e) { console.error(`  ⚠ ${f} is not valid JSON: ${e.message}`); }
}
const prefix = `mcp__${server}`;
/* a rule allows a tool when it names it, names the whole server, or ends in a wildcard over the server */
const allowed = tool => allow.some(r => r === `${prefix}__${tool}` || r === prefix || r === `${prefix}__*` || r === `${prefix}*`);
const missing = CONNECTOR_TOOLS.filter(t => !allowed(t));

console.log(`HARNESS — MCP server ${server} · ${read.length} settings file(s) read`);
for (const f of read) console.log(`  · ${f}`);
if (!missing.length) { console.log('  ✓ every connector tool is allowed — no call can be refused by the permission classifier'); process.exit(EXIT.OK); }
console.log(`  ⚠ ${missing.length} of ${CONNECTOR_TOOLS.length} connector tool(s) are not on the allow list: ${missing.join(', ')}`);
console.log('    In auto mode these can be refused at random, which makes an attempt fail for reasons that are neither');
console.log('    the model\'s nor the connector\'s. Ask the user to add them (one rule covers all):');
console.log(`      "permissions": { "allow": ["${prefix}"] }`);
console.log('    Never edit the settings yourself.');
process.exit(a.strict === true ? EXIT.DATA : EXIT.OK);
