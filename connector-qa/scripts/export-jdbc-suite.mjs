#!/usr/bin/env node
/**
 * export-jdbc-suite.mjs — optional, additive. Emits a runnable, parameterised query suite.
 *
 *   node export-jdbc-suite.mjs --dir <connectorDir> [--connector Name]
 *
 * Writes `<C>_jdbc_suite.json`: every planned test as SQL a JDBC client can execute directly,
 * with named bindings instead of baked ids.
 *
 * WHY THIS IS SEPARATE FROM THE PLAN
 * `plan.tc_list[].expected_sql` is a *reference* string. Stage 10 compares observed SQL against
 * it; the agent under test never sees it, so it was never held to a runnable standard — it is
 * unqualified (`[Tasks]`, not `[Cat].[Schema].[Tasks]`) and frequently omits a filter the driver
 * requires, because watching the agent discover that filter is the measurement. Rewriting it in
 * place would corrupt that comparison, so this reads the plan and writes a new artifact instead.
 * Nothing in the run flow changes.
 *
 * WHAT IT IS FOR
 * Separating two questions the main report deliberately fuses:
 *   - does the DRIVER work?            → run this suite directly
 *   - can an AGENT figure out the driver? → Stage 9
 * A query that fails here is a driver defect. A query that works here but fails in Stage 9 is a
 * discoverability problem — different owner, different fix.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveConnector } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'out'],
  usage: 'usage: export-jdbc-suite.mjs --dir <connectorDir> [--connector Name]',
});
if (!a.dir) { console.error('usage: export-jdbc-suite.mjs --dir <connectorDir> [--connector Name]'); process.exit(2); }

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
for (const n of ['knowledge', 'plan']) if (!existsSync(P(n))) { console.error(`✗ missing ${P(n)}`); process.exit(2); }

const K = JSON.parse(readFileSync(P('knowledge'), 'utf8'));
const plan = JSON.parse(readFileSync(P('plan'), 'utf8'));
const CAT = K.physical?.catalog || 'Catalog', SCH = K.run_meta?.schema || 'Schema';

const objByLower = new Map(K.objects.map(o => [o.name.toLowerCase(), o]));
const colsOf = o => new Set((o.columns || []).map(c => c.name.toLowerCase()));

/* ── bindings: one named parameter per id a query needs ──────────────────
 * Baking a live id into an exported file makes it stale the moment the workspace changes.
 * Named bindings keep the suite portable; `discovery` says how to fill each one. */
const bindings = {};
const bindFor = col => {
  const n = col.replace(/Id$/i, '');
  const key = n.charAt(0).toLowerCase() + n.slice(1) + 'Id';
  if (!bindings[key]) {
    const target = objByLower.get(n.toLowerCase()) || objByLower.get((n + 's').toLowerCase());
    bindings[key] = { description: `Id of a ${n} that exists in the target workspace`, value: null,
      discovery: target ? `SELECT [Id] FROM [${CAT}].[${SCH}].[${target.name}] LIMIT 1` : null };
  }
  return key;
};

/* ── rewrite one statement into something executable ─────────────────── */
const qualify = sql => sql.replace(/\b(FROM|JOIN)\s+\[([A-Za-z_]\w*)\]/gi,
  (m, kw, obj) => objByLower.has(obj.toLowerCase()) ? `${kw} [${CAT}].[${SCH}].[${obj}]` : m);

const tablesIn = sql => [...sql.matchAll(/\b(?:FROM|JOIN)\s+\[(?:[^\]]+\]\.\[){0,2}([A-Za-z_]\w*)\]/gi)]
  .map(m => objByLower.get(m[1].toLowerCase())).filter(Boolean);

/* a filter the object's own metadata says is mandatory — the driver rejects the query without it */
const REQ = /Requires?(?: a| an)? \[?([A-Za-z]+Id)\]?|filter by ([A-Za-z]+Id)/i;
function addRequiredFilters(sql, objs) {
  const added = [];
  for (const o of objs) {
    const m = REQ.exec((o.limitations || []).join(' '));
    if (!m) continue;
    const col = m[1] || m[2];
    if (!colsOf(o).has(col.toLowerCase())) continue;
    if (new RegExp(`\\[${col}\\]`, 'i').test(sql)) continue;        // already filtered
    const key = bindFor(col);
    const clause = `[${col}] = :${key}`;
    const tail = /\b(ORDER\s+BY|GROUP\s+BY|LIMIT)\b/i.exec(sql);
    const at = tail ? tail.index : sql.length;
    const head = sql.slice(0, at), rest = sql.slice(at);
    sql = /\bWHERE\b/i.test(head) ? `${head.trimEnd()} AND ${clause} ${rest}` : `${head.trimEnd()} WHERE ${clause} ${rest}`;
    added.push(clause);
  }
  return { sql: sql.replace(/\s+/g, ' ').trim(), added };
}

/* a bare long digit run is an Asana gid someone pasted; make it a binding so the file travels */
function literalsToBindings(sql) {
  const swapped = [];
  sql = sql.replace(/\[([A-Za-z]+Id)\]\s*=\s*'(\d{6,})'/gi, (m, col, val) => {
    const key = bindFor(col); swapped.push({ column: col, was: val, now: ':' + key });
    return `[${col}] = :${key}`;
  });
  return { sql, swapped };
}

/* ── build ───────────────────────────────────────────────────────────── */
const queries = [], templates = [], skipped = [], mutations = [];
for (const tc of plan.tc_list || []) {
  const base = { id: tc.id, use_case: tc.uc || null, prompt: tc.prompt || null,
    domain: tc.business_domain || null, group: tc.group || null, priority: tc.priority || null,
    gap_ids: tc.gap_ids || [], target_objects: tc.target_objects || [],
    query_patterns: tc.query_patterns || [] };

  if (tc.executable === false) {
    skipped.push({ ...base, sql: tc.expected_sql || null, reason: tc.nt_reason,
      note: 'planned and reported, deliberately not executed — a batch runner must not fire this' });
    continue;
  }
  /* null and '' mean different things: null is "the reference query was deliberately withheld
   * because the metadata does not state this join key", '' is "this test has no query at all".
   * Collapsing them filed every undeclared-join test under "measures agent behaviour". */
  const raw = String(tc.expected_sql ?? '');
  if (tc.expected_sql === null) {
    skipped.push({ ...base, sql: null,
      reason: "no reference query — the metadata does not state this relationship's join columns",
      note: 'the agent discovers the join key at run time; there is nothing for a SQL runner to replay' });
    continue;
  }
  if (!raw) {
    /* Behaviour tests measure how the agent conducts itself, not a query — there is nothing for a
     * SQL runner to fire. Recorded rather than dropped, so plan count and export count reconcile. */
    skipped.push({ ...base, sql: null, reason: 'no SQL — this test measures agent behaviour, not a query',
      note: 'nothing for a batch runner to execute' });
    continue;
  }

  if (/^\s*EXEC\b/i.test(raw)) {
    const sp = (K.physical?.procedures || []).find(p => p.name === tc.sp_name);
    templates.push({ ...base, procedure: tc.sp_name,
      call_template: raw,
      required_params: sp?.required_params || [],
      params: (sp?.params || []).map(p => ({ name: p.name, type: p.type, required: p.required })),
      mutates: !!tc.mutates, reversible: !!tc.reversible, undo_procedure: tc.undo_procedure || null,
      note: 'parameter values are discovered at run time; supply real ids before executing' });
    continue;
  }

  let sql = qualify(raw);
  const objs = tablesIn(sql);
  const lit = literalsToBindings(sql); sql = lit.sql;
  const req = addRequiredFilters(sql, objs); sql = req.sql;

  /* A write is not a query. The moment write_policy allowed irreversible writes, INSERT and UPDATE
   * statements landed in `queries` — the array this file documents as "independent and read-only" —
   * so anyone replaying the suite would have written to their own source. LIMIT was appended to them
   * too, which is not valid on either. Writes get their own array, and the reader is told plainly
   * that firing one changes data. */
  if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) {
    mutations.push({ ...base, sql,
      objects: objs.map(o => o.name),
      bindings_used: [...sql.matchAll(/:(\w+)/g)].map(m => m[1]),
      placeholders: [...sql.matchAll(/'(<[^>]+>)'/g)].map(m => m[1]),
      reversible: !!tc.reversible, undo_procedure: tc.undo_procedure || null,
      warning: 'THIS STATEMENT CHANGES DATA. Supply a real value for every <placeholder> and run it only against a disposable environment.' });
    continue;
  }
  if (!/\bLIMIT\s+\d+/i.test(sql)) sql += ' LIMIT 20';

  queries.push({ ...base, sql,
    objects: objs.map(o => o.name),
    bindings_used: [...sql.matchAll(/:(\w+)/g)].map(m => m[1]),
    rewritten: { qualified: sql !== raw, required_filters_added: req.added, literals_parameterised: lit.swapped },
    expects: 'a result set; zero rows is a valid outcome and is not a driver failure' });
}

const out = {
  schema_version: '1.0.0', connector: conn,
  run_id: K.run_meta?.run_id || null, generated_at: new Date().toISOString(),
  catalog: CAT, schema: SCH,
  purpose: 'Run these directly against the driver (JDBC/ODBC/any SQL client) to separate "does the driver work" from "can an agent figure the driver out". A failure here is a driver defect; a query that passes here but fails in Stage 9 is a discoverability problem.',
  how_to_use: [
    'Resolve every entry in `bindings` once — each carries a `discovery` query that fetches a usable id.',
    'Substitute :name placeholders with those values, or bind them as named parameters.',
    'Execute `queries` in any order; they are independent and read-only. Nothing in `queries` writes.',
    '`templates` are stored procedures — supply required_params yourself. Several mutate data.',
    '`mutations` CHANGE DATA — INSERT/UPDATE statements with <placeholder> values you must fill in. Never run these against a source you care about, and never as part of a read-only sweep.',
    '`skipped` must never be executed by a batch runner; each says why.',
  ],
  source_note: 'Derived from plan.tc_list[].expected_sql, which is a reference string the report compares observed SQL against — it is unqualified and omits driver-required filters by design. This export qualifies names, adds those filters and parameterises ids. The plan itself is untouched.',
  bindings, queries, mutations, templates, skipped,
  counts: { queries: queries.length, mutations: mutations.length, templates: templates.length, skipped: skipped.length, bindings: Object.keys(bindings).length,
            plan_tcs: (plan.tc_list || []).length, accounted: queries.length + mutations.length + templates.length + skipped.length },
};
const outPath = join(a.dir, `${conn}_jdbc_suite.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

console.log(`JDBC SUITE — ${conn}`);
console.log(`  runnable queries   ${queries.length}`);
console.log(`  procedure templates ${templates.length}  (${templates.filter(t => t.mutates).length} mutate)`);
console.log(`  data-changing statements ${mutations.length}  ${mutations.length ? '← NOT in `queries`; these write' : ''}`);
console.log(`  skipped, not runnable ${skipped.length}`);
console.log(`  bindings to resolve ${Object.keys(bindings).length}: ${Object.keys(bindings).join(', ')}`);
console.log(`  filters injected    ${queries.reduce((s, q) => s + q.rewritten.required_filters_added.length, 0)}`);
console.log(`→ ${outPath}`);
