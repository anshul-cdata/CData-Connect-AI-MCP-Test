#!/usr/bin/env node
/**
 * mine-dump.mjs — deterministic customer query-dump miner.
 *
 * Parses CData Connect AI MCP query dumps and emits customer_evidence.json.
 * Never send dump rows through an LLM: a single dump is routinely 10k+ queries / 4MB.
 *
 *   node mine-dump.mjs --connector NetSuite \
 *                      --catalogs "NetSuite1.SuiteQL,PROD_NS.SuiteQL" \
 *                      --out "C:\\...\\ConnectAIMCPTest\\NetSuite" \
 *                      dump1.csv dump2.csv
 *
 * --catalogs is optional. When given, a row is kept only if its query text references one of
 * those "Catalog.Schema" pairs — dumps legitimately mix many connectors, and filtering must
 * happen row by row, never by filename.
 *
 * Expected columns: Query, UserAgent, ErrorMessage, Duration, TimeToFirstRow, RowsReturned
 * Only `Query` is required; extra or reordered columns are tolerated.
 *
 * No dependencies. Node 18+.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { SYNTACTIC as PATTERNS, LITERAL_DEPENDENT, stripLiterals } from './lib/sql-patterns.mjs';

const SLOW_MS = 10_000;
const NEAR_ZERO = 0.01;       // frequency below which a pattern is a NOT_APPLICABLE candidate

const pc = n => `${(n * 100).toFixed(n < NEAR_ZERO && n > 0 ? 1 : 0)}%`;

/* ─────────────────────────── args ─────────────────────────── */

function parseArgs(argv) {
  const out = { connector: null, catalogs: [], outDir: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--connector') out.connector = argv[++i];
    else if (a === '--catalogs') out.catalogs = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else out.files.push(a);
  }
  return out;
}

function usage() {
  console.log(`mine-dump.mjs --connector <name> [--catalogs "Cat.Schema,..."] --out <dir> <csv|dir>...`);
}

/* ─────────────────────── CSV (RFC 4180) ───────────────────────
   Hand-rolled because queries contain commas, quotes AND embedded
   newlines — a line-based split silently corrupts them.            */

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);       // strip BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }           // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  if (!rows.length) return { records: [], header: [] };
  const header = rows[0].map(h => h.trim());
  const idx = {};
  header.forEach((h, i) => { idx[h.toLowerCase()] = i; });
  const pick = (r, name) => { const i = idx[name]; return i == null ? '' : (r[i] ?? ''); };

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0].trim() === '') continue;           // trailing blank line
    const q = pick(r, 'query');
    if (!q || !q.trim()) continue;
    records.push({
      query: q,
      agent: pick(r, 'useragent'),
      error: pick(r, 'errormessage'),
      duration: Number(pick(r, 'duration')) || 0,
      ttfr: Number(pick(r, 'timetofirstrow')) || 0,
      rows: pick(r, 'rowsreturned') === '' ? null : Number(pick(r, 'rowsreturned')),
    });
  }
  return { records, header };
}

/* ─────────────────────── extraction ─────────────────────── */

const RE_OBJ = /(?:FROM|JOIN)\s+\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]/gi;
const RE_OBJ_BARE = /(?:FROM|JOIN)\s+\[([^\]]+)\](?!\s*\.)/gi;
const RE_IDENT = /\[([A-Za-z_][^\]]{0,80})\]/g;
const RE_JOIN_ON = /JOIN\s+(?:\[[^\]]+\]\.)*\[([^\]]+)\]\s*(?:AS\s+)?(\w+)?\s+ON\s+([^\s]+)\s*=\s*([^\s)]+)/gi;

/** Cluster error text by shape, not by exact string. */
function normalizeError(e) {
  return e
    .replace(/\s+/g, ' ')
    .replace(/'[^']*'/g, "'X'")
    .replace(/"[^"]*"/g, '"X"')
    .replace(/\b\d+\b/g, 'N')
    .trim()
    .slice(0, 120);
}

/** Guess the fault owner for a production error cluster — see references/00-contracts.md §4. */
function guessOwner(pattern) {
  const p = pattern.toLowerCase();
  if (/invalid column name|column .* was not found|table could not be found|no such column/.test(p)) return 'owner-schema';
  if (/permission|unauthor|forbidden|access denied/.test(p)) return 'owner-driver';
  if (/too many requests|rate limit|timed out|timeout|broken pipe|connection|http \d|too_large|invalid_parameter|malformed/.test(p)) return 'owner-driver';
  return 'owner-ai';
}

function expandInputs(paths) {
  const files = [];
  for (const p of paths) {
    const r = resolve(p);
    if (!existsSync(r)) { console.error(`  ! not found, skipping: ${p}`); continue; }
    if (statSync(r).isDirectory()) {
      for (const f of readdirSync(r)) if (extname(f).toLowerCase() === '.csv') files.push(join(r, f));
    } else files.push(r);
  }
  return files;
}

/* ─────────────────────────── main ─────────────────────────── */

const args = parseArgs(process.argv.slice(2));
if (!args.files.length || !args.outDir) { usage(); process.exit(2); }

const catalogKeys = args.catalogs.map(c => c.toLowerCase());
const files = expandInputs(args.files);

const objectFreq = new Map(), columnFreq = new Map(), joinPairs = new Map();
const errorClusters = new Map(), catalogsSeen = new Map();
const patternHits = Object.fromEntries(Object.keys(PATTERNS).map(k => [k, 0]));
const unusual = [];
let kept = 0, scanned = 0, zeroRows = 0, slow = 0, errored = 0, filesUsed = 0;

const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { console.error(`  ! unreadable, skipping: ${basename(file)} (${e.message})`); continue; }

  const { records, header } = toObjects(parseCsv(text));
  if (!header.some(h => h.toLowerCase() === 'query')) {
    console.error(`  ! no "Query" column, skipping: ${basename(file)}`);
    continue;
  }
  filesUsed++;
  scanned += records.length;

  for (const rec of records) {
    const q = rec.query;

    // --- which catalogs does this row touch? ---
    const rowCatalogs = new Set();
    const objs = [];
    RE_OBJ.lastIndex = 0;
    for (let m; (m = RE_OBJ.exec(q));) {
      rowCatalogs.add(`${m[1]}.${m[2]}`.toLowerCase());
      objs.push({ catalog: `${m[1]}.${m[2]}`, name: m[3] });
    }
    if (!objs.length) {
      RE_OBJ_BARE.lastIndex = 0;
      for (let m; (m = RE_OBJ_BARE.exec(q));) objs.push({ catalog: '(unqualified)', name: m[1] });
    }

    // --- row-level connector filter ---
    if (catalogKeys.length) {
      const hit = [...rowCatalogs].some(c => catalogKeys.some(k => c === k || c.includes(k) || k.includes(c)));
      if (!hit) continue;
    }
    kept++;

    for (const o of objs) { bump(objectFreq, o.name); bump(catalogsSeen, o.catalog); }

    RE_IDENT.lastIndex = 0;
    const seenIdent = new Set();
    for (let m; (m = RE_IDENT.exec(q));) {
      const id = m[1];
      if (objs.some(o => o.name === id)) continue;          // it's an object, not a column
      if (seenIdent.has(id)) continue;
      seenIdent.add(id);
      bump(columnFreq, id);
    }

    RE_JOIN_ON.lastIndex = 0;
    for (let m; (m = RE_JOIN_ON.exec(q));) {
      const to = m[1];
      const from = objs.length ? objs[0].name : '(unknown)';
      if (to === from) continue;
      const on = `${m[3]} = ${m[4]}`.replace(/\[|\]/g, '');
      bump(joinPairs, `${from}\u0000${to}\u0000${on}`);
    }

    for (const [name, re] of Object.entries(PATTERNS)) if (re.test(q)) patternHits[name]++;

    if (rec.rows === 0) zeroRows++;
    if (rec.duration > SLOW_MS) slow++;
    if (rec.error && rec.error.trim()) { errored++; bump(errorClusters, normalizeError(rec.error)); }

    // complex real queries are worth reproducing verbatim as test cases
    const complexity =
      (/\bJOIN\b/i.test(q) ? 1 : 0) + (/\bGROUP\s+BY\b/i.test(q) ? 1 : 0) +
      (/\bCASE\s+WHEN\b/i.test(q) ? 1 : 0) + (/\(\s*SELECT\b/i.test(q) ? 2 : 0) +
      (/\bHAVING\b/i.test(q) ? 1 : 0) + (/\bUNION\b/i.test(q) ? 1 : 0);
    // H7: never persist a customer's literal values — keep the structure, drop the data
    if (complexity >= 3) unusual.push({ complexity, query: stripLiterals(q).slice(0, 500) });
  }
}

if (!kept) {
  console.error(`\nNo rows matched${catalogKeys.length ? ` catalogs [${args.catalogs.join(', ')}]` : ''}.`);
  console.error(`Scanned ${scanned} rows across ${filesUsed} file(s). Check --catalogs against getCatalogs()/getSchemas().`);
}

const sortDesc = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
const toObj = (pairs, n) => Object.fromEntries(pairs.slice(0, n));
const freq = n => kept ? Number((n / kept).toFixed(4)) : 0;

const evidence = {
  available: kept > 0,
  connector: args.connector || null,
  query_count: kept,
  rows_scanned: scanned,
  file_count: filesUsed,
  connector_match: sortDesc(catalogsSeen).slice(0, 3).map(([c]) => c).join(', ') || null,
  catalogs_seen: toObj(sortDesc(catalogsSeen), 12),

  object_frequency: toObj(sortDesc(objectFreq), 100),
  column_frequency: toObj(sortDesc(columnFreq), 120),

  join_pairs: sortDesc(joinPairs).slice(0, 40).map(([k, count]) => {
    const [from, to, on] = k.split('\u0000');
    return { from, to, on, count, covered: false };
  }),

  pattern_frequency: Object.fromEntries(
    Object.entries(patternHits).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, freq(v)])
  ),

  // patterns real users essentially never issue — NOT_APPLICABLE candidates (§5.4)
  // LITERAL_DEPENDENT patterns can only be detected when values are inlined. When most real
  // traffic binds values as @params, their absence proves nothing — flag the caveat rather
  // than let it become a false NOT_APPLICABLE.
  near_zero_patterns: Object.entries(patternHits)
    .filter(([, v]) => freq(v) < NEAR_ZERO)
    .map(([k, v]) => {
      const masked = LITERAL_DEPENDENT.has(k) && freq(patternHits.parameterized) > 0.5;
      return {
        pattern: k, frequency: freq(v), hits: v,
        reliable: !masked,
        ...(masked && { caveat: `${pc(freq(patternHits.parameterized))} of queries bind values as @params, which hides literal values — absence here is NOT evidence of non-use. Verify before marking NOT_APPLICABLE.` })
      };
    }),

  error_clusters: sortDesc(errorClusters).slice(0, 25).map(([pattern, count]) => ({
    pattern, count, likely_owner: guessOwner(pattern), reproduced: false, tc_ids: []
  })),

  zero_row_rate: freq(zeroRows),
  slow_query_rate: freq(slow),
  error_rate: freq(errored),

  unusual_queries: unusual.sort((a, b) => b.complexity - a.complexity).slice(0, 8).map(u => u.query),

  reconciliation: []          // you fill this — references/03-customer-evidence.md §4.5
};

const outPath = join(resolve(args.outDir), 'customer_evidence.json');
writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');

/* ─────────────────────── summary ─────────────────────── */

const reliableNearZero = evidence.near_zero_patterns.filter(p => p.reliable);
const maskedNearZero   = evidence.near_zero_patterns.filter(p => !p.reliable);

console.log(`
Customer evidence — ${args.connector || '(unnamed)'}
  files used        ${filesUsed} of ${files.length}
  rows scanned      ${scanned.toLocaleString()}
  rows matched      ${kept.toLocaleString()}${catalogKeys.length ? `  (catalogs: ${args.catalogs.join(', ')})` : '  (no catalog filter)'}
  distinct objects  ${objectFreq.size}
  distinct columns  ${columnFreq.size}
  join pairs        ${joinPairs.size}
  zero-row rate     ${pc(evidence.zero_row_rate)}
  error rate        ${pc(evidence.error_rate)}   clusters: ${errorClusters.size}
  slow (>${SLOW_MS / 1000}s)      ${pc(evidence.slow_query_rate)}

  top objects       ${sortDesc(objectFreq).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(' ') || '—'}
  parameterized     ${pc(evidence.pattern_frequency.parameterized || 0)} of queries bind values as @params

  near-zero         ${reliableNearZero.map(p => p.pattern).join(' ') || '—'}
                    ^ NOT_APPLICABLE candidates — do not spend tests here${maskedNearZero.length ? `

  near-zero, BUT    ${maskedNearZero.map(p => p.pattern).join(' ')}
                    ^ masked by @param binding — absence is NOT evidence. Verify first.` : ''}
  top error         ${evidence.error_clusters[0] ? `[${evidence.error_clusters[0].count}] ${evidence.error_clusters[0].pattern.slice(0, 70)}` : '—'}

  → ${outPath}
`);

/* Rows that matched but yielded no objects mean the SQL shape was not recognised — not that the
 * customer queries nothing. CData emits bracketed, qualified names ([Cat].[Schema].[Table]); a dump
 * of hand-written or third-party SQL parses as rows and extracts nothing, and the run would go on
 * to report "no customer evidence" when what it really has is evidence it could not read. */
if (kept && objectFreq.size === 0) {
  console.error(`
  ⚠ ${kept} row(s) parsed but no object was recognised in any query.
    Object names are read from bracketed identifiers — [Catalog].[Schema].[Table] — which is what
    CData Connect AI emits. A dump of unbracketed SQL parses fine and yields nothing.
    Treat this as "evidence not readable", not as "no evidence".`);
}

process.exit(kept ? 0 : 1);

