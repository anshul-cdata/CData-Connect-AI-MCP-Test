/**
 * review-prep.mjs — assemble the Stage 8.5 reviewer's input package.
 *
 *   node review-prep.mjs --dir <connectorDir> [--connector Name] [--out <path>]
 *
 * Stage 8.5 is the only stage that checks the plan against the CONNECTOR rather than against the
 * gap ledger the pipeline built. Everything upstream reasons from that ledger; if it is wrong,
 * every downstream stage inherits the error and nothing notices. asn004 is what that looks like:
 * the ledger claimed the procedures were covered, the plan matched it, the review returned
 * tcs_added: 0, and a read-only assessment of a read-write connector shipped as 96% healthy.
 *
 * Two deliberate omissions, for the same reason `expected_sql` is already withheld — never hand a
 * reviewer the answer key that produced the thing it is checking:
 *
 *   - `gaps.json` is NOT included. It is the pipeline's own reasoning about what to test. Given
 *     it, the reviewer validates the plan against the ledger; withheld, it has to judge the tests
 *     against the connector and the business directly.
 *   - `expected_sql` is NOT included. The reviewer judges whether the natural-language prompt is
 *     strong enough to elicit the right query, not whether it matches a known answer.
 *
 * What IS included, and was not before: the research. Workflow domains, personas, roles and the
 * access matrix. Without them the reviewer cannot check the four dimensions that matter most, and
 * asn005 passed its completeness audit with 64 workflows and 0 workflow tests.
 *
 * The denominator table below is computed here rather than by the model: counting is arithmetic,
 * and only the judgement — why something is untested, and what test to write — needs a model.
 */
import { writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArtifacts, fail, EXIT } from './lib/artifacts.mjs';
import { isCovered } from './lib/coverage-state.mjs';
import { fingerprint } from './lib/sql-patterns.mjs';
import { parseArgs } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'out', 'max-tokens'],
  usage: 'usage: review-prep.mjs --dir <connectorDir> [--connector Name] [--out path]',
});
if (!a.dir) { console.error('usage: review-prep.mjs --dir <connectorDir> [--connector Name] [--out path]'); process.exit(EXIT.USAGE); }

let conn = a.connector || a.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
if (!existsSync(join(a.dir, `${conn}_knowledge.json`))) {
  const found = (existsSync(a.dir) ? readdirSync(a.dir) : []).filter(f => /_knowledge\.json$/.test(f));
  if (a.connector) fail(`no knowledge file for connector "${conn}" in ${a.dir}`);
  if (found.length === 1) conn = found[0].replace(/_knowledge\.json$/, '');
  else if (found.length > 1) fail(`${found.length} connectors in ${a.dir} — pass --connector`);
}
const P = n => join(a.dir, `${conn}_${n}.json`);

const { K, C, plan } = readArtifacts({
  K:    { path: P('knowledge'), kind: 'knowledge' },
  C:    { path: P('coverage'),  kind: 'coverage'  },
  plan: { path: P('plan'),      kind: 'plan'      },
});

const meta    = K.connector_meta || {};
const tcs     = plan.tc_list || [];
const objRows = [...(C.objects?.tables?.rows || []), ...(C.objects?.views?.rows || [])];
const spRows  = C.objects?.procedures?.rows || [];
const relRows = C.relationships?.rows || [];
const ucRows  = C.use_cases?.rows || [];
const behRows = C.behaviors?.rows || [];
const patRows = C.patterns?.rows || [];
const perms   = K.physical?.permissions || {};
const workflows = (meta.workflow_domains || []).flatMap(d =>
  (d.workflows || []).map(w => ({ ...w, domain: d.id, domain_name: d.name })));

/* ── what each test touches, so the denominators can be computed ────────────── */
const touched = {
  objects: new Set(), procedures: new Set(), patterns: new Set(),
  relationships: new Set(), use_cases: new Set(), behaviors: new Set(), capabilities: new Set(),
};
for (const t of tcs) {
  for (const o of t.target_objects || []) touched.objects.add(String(o).toLowerCase());
  for (const p of t.query_patterns || []) touched.patterns.add(p);
  for (const r of t.relationships || []) touched.relationships.add(typeof r === 'string' ? r : r?.id);
  for (const u of t.use_case_ids || []) touched.use_cases.add(u);
  if (t.sp_name)  { touched.procedures.add(t.sp_name); touched.capabilities.add('execute'); }
  if (t.behavior) touched.behaviors.add(t.behavior);
  const sql = String(t.expected_sql || '');
  if (/^\s*select/i.test(sql)) touched.capabilities.add('select');
  if (/^\s*insert/i.test(sql)) touched.capabilities.add('insert');
  if (/^\s*update/i.test(sql)) touched.capabilities.add('update');
  if (/^\s*delete/i.test(sql)) touched.capabilities.add('delete');
}

/* Workflow, persona and role coverage has no id to match on — the plan carries no workflow_id —
 * so it is matched by name, the same way the tiering does. Approximate on purpose: the reviewer
 * is told this is a heuristic and asked to confirm, rather than being handed a false precision. */
const sing = n => n.replace(/ies$/, 'y').replace(/s$/, '');
const mentions = (haystack, needle) => {
  const h = String(haystack).toLowerCase(), n = String(needle).toLowerCase();
  return h.includes(n) || h.includes(sing(n));
};
const tcText = tcs.map(t => `${t.uc || ''} ${t.prompt || ''} ${(t.target_objects || []).join(' ')}`.toLowerCase());
const anyTestMentions = phrase => tcText.some(t => mentions(t, phrase));

/* ── the ten denominators ───────────────────────────────────────────────────── */
const dim = (name, items, isTested, note) => {
  const untested = items.filter(i => !isTested(i));
  return { dimension: name, surface: items.length, covered: items.length - untested.length,
    untested: untested.map(i => i.label ?? i.name ?? i.id ?? String(i)), ...(note ? { note } : {}) };
};

const dimensions = [
  /* Every object, not just T1. The old audit checked T1 only, so everything below it was outside
   * the audit entirely — and with accurate tiering that is most of the connector. */
  dim('objects', objRows.filter(r => !isCovered(r.state)),
      r => touched.objects.has(String(r.name).toLowerCase())),
  dim('procedures', spRows.filter(r => !isCovered(r.state)), r => touched.procedures.has(r.name)),
  dim('capabilities', Object.entries(perms).filter(([, v]) => v === true).map(([k]) => ({ name: k })),
      r => touched.capabilities.has(r.name)),
  dim('relationships', relRows.filter(r => !isCovered(r.state)), r => touched.relationships.has(r.id)),
  dim('query patterns', patRows.filter(r => r.applicable !== false && !isCovered(r.state)),
      r => touched.patterns.has(r.pattern)),
  dim('use cases', ucRows.filter(r => !isCovered(r.state)), r => touched.use_cases.has(r.id)),
  dim('agent behaviors', behRows.filter(r => r.applicable !== false && !isCovered(r.state)),
      r => touched.behaviors.has(r.behavior)),
  /* The three the audit never had.
   *
   * Personas and roles are matched EXACTLY, on the fields the plan carries — not by looking for
   * the text in a prompt. The first version of this searched for a whole jobs-to-be-done sentence
   * ("Clear every overdue item off My Tasks before logging off for the day") inside test prompts,
   * which can never match, and duly reported 0 of 47 personas covered. A measurement that cannot
   * succeed is worse than no measurement: it looks like a finding. */
  dim('workflows', workflows.map(w => ({ name: w.name, label: `${w.domain}/${w.name}` })),
      w => anyTestMentions(w.name),
      'matched by name — a heuristic; confirm against the prompts rather than trusting it'),

  dim('personas', (meta.personas || []).map(p => ({ name: p.name, label: p.name })),
      p => tcs.some(t => t.persona === p.name),
      'a persona is covered when at least one test is written from its point of view'),

  dim('roles', (meta.roles || []).map(r => ({ name: r.name, label: r.name })),
      r => tcs.some(t => (t.roles || []).includes(r.name)),
      'a role is covered when a test exercises a domain that role can reach'),
];

/* Jobs-to-be-done are reported separately and NOT as a pass/fail dimension. Whether a prompt
 * expresses a particular job is a judgement about meaning, and no string match can make it — so
 * the list goes to the reviewer to assess rather than being scored here. */
const persona_jobs = (meta.personas || []).map(p => ({
  persona: p.name,
  tests: tcs.filter(t => t.persona === p.name).length,
  jobs_to_be_done: p.jobs_to_be_done || [],
}));

/* ── use cases that share a query shape ─────────────────────────────────────── */
/* "Every use case has a test" was satisfied by a test that merely carried the use case's name.
 * Twelve different use cases resolving to one generic SELECT all counted as covered. A use case is
 * only covered when a test could fail if THAT use case were broken — so the shapes are clustered
 * here and the reviewer is asked to judge which are genuinely distinct business questions. */
const byShape = new Map();
for (const t of tcs) {
  if (!(t.use_case_ids || []).length || !t.expected_sql) continue;
  const k = fingerprint(t.expected_sql);
  if (!byShape.has(k)) byShape.set(k, []);
  byShape.get(k).push({ id: t.id, uc: t.uc, use_case_ids: t.use_case_ids });
}
const shared_query_shapes = [...byShape.entries()]
  .filter(([, v]) => v.length > 1)
  .sort((x, y) => y[1].length - x[1].length)
  .map(([shape, members]) => ({ tests: members.length, shape: shape.slice(0, 150), members }));

/* ── the package ────────────────────────────────────────────────────────────── */
const pkg = {
  schema_version: '2.0.0',
  connector: conn,
  run_id: K.run_meta?.run_id || null,
  generated_at: new Date().toISOString(),
  generated_by: 'review-prep.mjs',

  purpose:
    'Stage 8.5 input package. You are reviewing whether the test plan is COMPLETE against this ' +
    'connector and the business it serves — not against the pipeline that produced it. The gap ' +
    'ledger and expected_sql are deliberately withheld so you judge the tests on their own merits.',

  surface: {
    objects: (K.objects || []).map(o => ({
      name: o.name, tier: o.tier, category: o.category,
      meaning: o.business_meaning?.v || null,
      columns: (o.columns || []).map(c => ({ name: c.name, role: c.role || null, important: !!c.important })),
    })),
    procedures: (K.physical?.procedures || []).map(p => ({
      name: p.name, required_params: p.required_params || [],
      params: (p.params || []).map(x => ({ name: x.name, type: x.type, required: x.required })),
    })),
    relationships: (K.relationships || []).map(r => ({
      id: r.id, from: r.from, to: r.to, from_col: r.from_col || null, to_col: r.to_col || null,
      confidence: r.confidence, meaning: r.meaning || null,
    })),
    capabilities: perms,
    instructions_raw: K.instructions_raw || null,
  },

  research: {
    workflow_domains: meta.workflow_domains || [],
    personas: meta.personas || [],
    roles: meta.roles || [],
    sources: meta.sources || [],
  },

  use_cases: ucRows.map(u => ({ id: u.id, name: u.name, domain: u.domain, persona: u.persona,
    objects: u.objects || [], source: u.source, state: u.state })),

  /* prompts yes, expected_sql no */
  test_cases: tcs.map(({ expected_sql, steps, observed, est_in, est_out, tool_calls, ...t }) => t),

  /* The writing job (2.2.0, 07a-tc-review.md §8.5.4a). Every business test arrives as a DRAFT
   * with a brief; rewriting each one in its persona's words is the first thing this review does,
   * before it looks for missing tests. Counted here so the reviewer cannot miss the scale of it. */
  business_writing: {
    drafts: tcs.filter(t => t.suite === 'business' && t.prompt_status === 'draft').map(t => t.id),
    from_research: tcs.filter(t => t.suite === 'business' && t.prompt_status === 'research').map(t => t.id),
    conformance: tcs.filter(t => t.suite !== 'business').length,
    rules: [
      'Write each business prompt as the persona in its brief would actually ask it, on an ordinary day.',
      'Use the words people use for things (brief.things[].words) — never a table, column or procedure name.',
      'No ids, no SQL words, no instructions to an AI ("read it back", "say plainly", "do not invent").',
      'Keep the scope the draft states (dates, open/closed) so the reference query still matches it.',
      'Anything the test must check goes in expected_behavior, not in the prompt.',
      'Return the rewrite in `modified` with the same id. A draft you judge already right goes in `accepted_business`.',
    ],
  },

  completeness: {
    note: 'Counted mechanically. Your job is to close these, not restate them: write the missing ' +
          'tests. Reporting a dimension as untestable requires naming the blocker.',
    dimensions,
  },

  persona_jobs: {
    note: 'Not scored — judge whether the tests for each persona actually express these jobs. ' +
          'A persona with tests that never do what it needs is covered on paper only.',
    personas: persona_jobs,
  },

  shared_query_shapes: {
    note: 'Use cases whose tests send the same query. A use case is covered only when a test ' +
          'could fail if THAT use case were broken. Judge which of these are genuinely distinct ' +
          'business questions and which are one test wearing several names.',
    clusters: shared_query_shapes,
  },
};

/* ── one package, or several ────────────────────────────────────────────────
 * A medium connector (a few hundred objects) still fits one call; a large one does not. The split
 * is decided here on measured size rather than a test count, because packages differ: a connector
 * with long prompts and a rich schema hits the ceiling sooner than one with the same test count
 * and a thin schema.
 *
 * Only `test_cases` splits. Surface, research, use cases and the completeness table are global and
 * go in every shard, so each reviewer judges its slice against the WHOLE connector and the whole
 * plan's holes — never against its own slice, which would invent gaps that are covered elsewhere. */
const BUDGET = Number(a['max-tokens'] || 120000);   // input budget per call, in tokens
const estTok = o => Math.ceil(JSON.stringify(o).length / 4);

const shared = { ...pkg, test_cases: [] };
const sharedTok = estTok(shared);
const tcTok = pkg.test_cases.map(t => estTok(t));
const totalTok = sharedTok + tcTok.reduce((x, y) => x + y, 0);

let packages;
if (totalTok <= BUDGET || pkg.test_cases.length <= 1) {
  packages = [{ ...pkg, shard: { index: 1, of: 1, tc_ids: pkg.test_cases.map(t => t.id) } }];
} else {
  if (sharedTok >= BUDGET) fail(
    `the shared context alone is ~${Math.round(sharedTok / 1000)}k tokens, over the ${Math.round(BUDGET / 1000)}k budget. ` +
    `Raise --max-tokens, or the connector's schema needs trimming before it can be reviewed.`);
  const room = BUDGET - sharedTok;
  const groups = [[]]; let used = 0;
  pkg.test_cases.forEach((t, i) => {
    if (used + tcTok[i] > room && groups[groups.length - 1].length) { groups.push([]); used = 0; }
    groups[groups.length - 1].push(t); used += tcTok[i];
  });
  packages = groups.map((g, i) => ({ ...pkg, test_cases: g,
    shard: { index: i + 1, of: groups.length, tc_ids: g.map(t => t.id) } }));
}

/* Every test must land in exactly one shard. A test reviewed twice wastes a call; a test reviewed
 * zero times is the silent hole this whole stage exists to prevent, so it is asserted, not hoped. */
{
  const seen = new Map();
  for (const pk of packages) for (const id of pk.shard.tc_ids) seen.set(id, (seen.get(id) || 0) + 1);
  const missing = pkg.test_cases.filter(t => !seen.has(t.id)).map(t => t.id);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (missing.length || dupes.length) fail(
    `shard assignment is not a partition — ${missing.length} test(s) in no shard, ${dupes.length} in more than one`);
}

const base = a.out || join(a.dir, `${conn}_review_input`);
const outPaths = packages.map((pk, i) => {
  const path = packages.length === 1
    ? (a.out || `${base}.json`)
    : `${String(base).replace(/\.json$/, '')}_${i + 1}of${packages.length}.json`;
  writeFileSync(path, JSON.stringify(pk, null, 2), 'utf8');
  return path;
});
const outPath = outPaths[0];

console.log(`REVIEW PACKAGE — ${conn}`);
console.log(`  test cases           ${tcs.length}`);
console.log(`  research             ${(meta.workflow_domains || []).length} domain(s) · ${workflows.length} workflow(s) · ${(meta.personas || []).length} persona(s) · ${(meta.roles || []).length} role(s)`);
console.log('\n  COMPLETENESS — plan vs the connector and the business');
for (const d of dimensions) {
  const pct = d.surface ? Math.round(d.covered / d.surface * 100) : 100;
  const flag = d.surface && pct < 100 ? (pct < 80 ? '  ✗' : '  ⚠') : '';
  console.log(`    ${d.dimension.padEnd(16)}${String(d.covered).padStart(4)}/${String(d.surface).padEnd(5)} ${String(pct).padStart(3)}%${flag}`);
}
const holes = dimensions.filter(d => d.untested.length);
if (holes.length) {
  console.log('\n  untested (first 5 each):');
  for (const d of holes) console.log(`    ${d.dimension}: ${d.untested.slice(0, 5).join(', ')}${d.untested.length > 5 ? ` …+${d.untested.length - 5}` : ''}`);
}
if (shared_query_shapes.length) {
  const n = shared_query_shapes.reduce((s, c) => s + c.tests, 0);
  console.log(`\n  ⚠ ${n} use-case test(s) share only ${shared_query_shapes.length} distinct quer${shared_query_shapes.length === 1 ? 'y' : 'ies'} — the reviewer must judge which are real`);
}
if (outPaths.length === 1) {
  console.log(`\n  one review call  ~${Math.round(totalTok / 1000)}k tokens`);
  console.log(`\n→ ${outPath}`);
} else {
  console.log(`\n  ~${Math.round(totalTok / 1000)}k tokens exceeds the ${Math.round(BUDGET / 1000)}k budget — split into ${outPaths.length} shards`);
  console.log(`  shared context ~${Math.round(sharedTok / 1000)}k goes to every shard; only the test bodies split`);
  console.log(`  dispatch all ${outPaths.length} in parallel, then merge with review-merge.mjs`);
  for (const path of outPaths) console.log(`\n→ ${path}`);
}
