/**
 * validate-model.mjs — check a model-authored artifact before the next stage consumes it.
 *
 *   node validate-model.mjs --dir <connectorDir> [--connector Name] [--stage 3|5|all]
 *
 * Stages 3 and 5 are written by a language model and read by scripts. Nothing sat between them, so
 * a name the model invented became a silent behaviour change rather than an error:
 *
 *   - Stage 5 named ten behaviours; the generator recognised three of them. The other seven
 *     produced tests whose prompt was the literal word "undefined".
 *   - Stage 3's reference doc shows numeric `tier: 1` in one example while every consumer filters
 *     `=== 'T1'`. A numeric tier yields zero T1 objects and no error anywhere.
 *   - `not_applicable` meant "done" to one script and "outstanding" to another, producing gaps no
 *     test could ever close.
 *
 * Each of those was valid JSON with a valid schema_version. Structure is not the problem —
 * vocabulary is. This checks the names against lib/vocabulary.mjs, which is the single place the
 * stages are supposed to agree.
 */
import { readArtifacts, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { BEHAVIORS, STATES, TIERS, unknown } from './lib/vocabulary.mjs';
import { SYNTACTIC, BANDS, ROLE_REFINED } from './lib/sql-patterns.mjs';
import { join } from 'node:path';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'stage'],
  required: ['dir'],
  usage: 'usage: validate-model.mjs --dir <connectorDir> [--connector Name] [--stage 3|5|all]',
});
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const stage = String(a.stage || 'all');

const problems = [], notes = [];
const bad = (where, msg) => problems.push(`${where}: ${msg}`);

const { K, C } = readArtifacts({
  K: { path: P('knowledge'), kind: 'knowledge' },
  C: { path: P('coverage'), kind: 'coverage', required: stage !== '3' },
});

/* ── Stage 3 · the semantic schema ─────────────────────────────────────────── */
if (stage === '3' || stage === 'all') {
  const objs = K.objects || [];
  if (!objs.length) bad('knowledge.objects', 'empty — Stage 3 produced no semantic schema');

  for (const o of objs) {
    if (o.tier !== undefined) {
      const u = unknown(o.tier, TIERS, 'tier');
      /* the numeric-tier trap: `1` is not `'T1'`, and every consumer compares strings */
      if (u) bad(`objects.${o.name}.tier`, typeof o.tier === 'number'
        ? `${o.tier} is a number; tiers are strings ("T${o.tier}"). Every consumer filters === 'T1', so a numeric tier silently yields zero T1 objects.`
        : u);
    }
    for (const c of o.columns || []) {
      if (!c.name) bad(`objects.${o.name}.columns`, 'a column has no name');
    }
    /* datatypes are not captured at all — flagged as a note, since it is a known design gap that
     * makes filter_boolean unreachable and pass_dtype uncheckable */
    if ((o.columns || []).some(c => c.type)) notes.push(`${o.name} carries column datatypes`);
  }
  const withTypes = objs.filter(o => (o.columns || []).some(c => c.type)).length;
  if (objs.length && !withTypes)
    notes.push('no object records column datatypes — filter_boolean falls back to name heuristics and pass_dtype has nothing to check against (02-semantic-schema.md)');

  for (const r of K.relationships || []) {
    if (!r.id) bad('relationships', 'a relationship has no id');
    if (!r.from || !r.to) bad(`relationships.${r.id}`, 'missing from/to');
    if (r.from_col && !r.to_col) bad(`relationships.${r.id}`, 'declares from_col but not to_col — treated as undeclared, so it gets no reference query');
  }

  const meta = K.connector_meta || {};
  for (const p of meta.personas || []) if (!p.name) bad('connector_meta.personas', 'a persona has no name');
  /* use cases reference personas by NAME; the generator resolves by id or name, but only because
   * that mismatch was found the hard way */
  if ((meta.personas || []).length && !(meta.personas || []).every(p => p.id))
    notes.push('some personas have no id — resolution falls back to name matching');
}

/* ── Stage 5 · the coverage model ──────────────────────────────────────────── */
if ((stage === '5' || stage === 'all') && C) {
  for (const b of C.behaviors?.rows || []) {
    const u = unknown(b.behavior, BEHAVIORS, 'behavior');
    if (u) bad('coverage.behaviors', `${u}\n      The generator writes a prompt per behaviour name. An unrecognised one produces a test whose question is the literal word "undefined".`);
  }
  /* The catalogue is SYNTACTIC (regex-detectable) plus BANDS (the full list, including the ones
   * detected by composition) plus ROLE_REFINED. Checking SYNTACTIC alone rejected seven patterns
   * that are perfectly real — the validator's own vocabulary was the narrower one. */
  const known = new Set([...Object.keys(SYNTACTIC || {}),
    ...Object.values(BANDS || {}).flat(), ...Object.keys(ROLE_REFINED || {})]);
  for (const p of C.patterns?.rows || []) {
    if (known.size && !known.has(p.pattern))
      bad('coverage.patterns', `unknown pattern: "${p.pattern}" — not in lib/sql-patterns.mjs, so nothing can detect or credit it`);
  }
  const rows = [
    ['objects.tables', C.objects?.tables?.rows], ['objects.views', C.objects?.views?.rows],
    ['objects.procedures', C.objects?.procedures?.rows], ['relationships', C.relationships?.rows],
    ['use_cases', C.use_cases?.rows], ['patterns', C.patterns?.rows],
    ['intents', C.intents?.rows], ['behaviors', C.behaviors?.rows],
  ];
  for (const [name, rs] of rows) {
    if (!rs) { bad(`coverage.${name}`, 'missing — every dimension must exist, even if empty'); continue; }
    for (const r of rs) {
      if (r.state !== undefined) { const u = unknown(r.state, STATES, 'state'); if (u) bad(`coverage.${name}`, u); }
      if (r.tier !== undefined) { const u = unknown(r.tier, TIERS, 'tier'); if (u) bad(`coverage.${name}`, u); }
    }
  }
  /* a use case naming a persona nothing defines cannot be attributed in any report lens */
  const personaNames = new Set((K.connector_meta?.personas || []).flatMap(p => [p.name, p.id].filter(Boolean)));
  for (const u of C.use_cases?.rows || [])
    if (u.persona && personaNames.size && !personaNames.has(u.persona))
      bad('coverage.use_cases', `use case "${u.id}" names persona "${u.persona}", which connector_meta.personas does not define`);
}

console.log(`validate-model · ${conn} · stage ${stage}`);
for (const n of notes) console.log('  · ' + n);
if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s) in a model-authored artifact:`);
  for (const p of problems) console.error('  ' + p);
  console.error('\n  These are valid JSON. The names are what the next stage cannot use.');
  process.exit(EXIT.DATA);
}
console.log('  ✓ vocabulary agrees with lib/vocabulary.mjs — the next stage can consume this\n');
