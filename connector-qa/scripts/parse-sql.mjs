#!/usr/bin/env node
/**
 * parse-sql.mjs — turn observed SQL into the structure Stage 10 credits coverage from.
 *
 *   node parse-sql.mjs "SELECT [a],[b] FROM [t] WHERE [a]='x' ORDER BY [b] LIMIT 20"
 *   node parse-sql.mjs --file queries.json [--roles roles.json]
 *
 * --file  : JSON array of {id, sql} → array of {id, observed}
 * --roles : JSON object {columnName: role} from knowledge.json; refines filter_enum /
 *           filter_boolean / filter_date_range / filter_numeric_threshold
 *
 * Uses the same regexes as mine-dump.mjs (scripts/lib/sql-patterns.mjs), so the patterns
 * credited from execution can never disagree with the patterns measured from customer dumps.
 */
import { readFileSync } from 'node:fs';
import { parseSql } from './lib/sql-patterns.mjs';

const args = process.argv.slice(2);
let file = null, rolesPath = null, inline = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--roles') rolesPath = args[++i];
  else inline.push(args[i]);
}

const roles = rolesPath ? JSON.parse(readFileSync(rolesPath, 'utf8')) : undefined;

if (file) {
  const items = JSON.parse(readFileSync(file, 'utf8'));
  const out = items.map(it => ({ id: it.id, observed: { sql: it.sql, ...parseSql(it.sql, roles) } }));
  console.log(JSON.stringify(out, null, 2));
} else if (inline.length) {
  console.log(JSON.stringify({ sql: inline.join(' '), ...parseSql(inline.join(' '), roles) }, null, 2));
} else {
  console.error('usage: parse-sql.mjs "<sql>" | --file items.json [--roles roles.json]');
  process.exit(2);
}
