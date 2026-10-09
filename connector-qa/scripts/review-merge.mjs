/**
 * review-merge.mjs — apply the Stage 8.5 reviewer's patch to the plan.
 *
 *   node review-merge.mjs --dir <connectorDir> --patch <file|glob-dir> [--connector Name]
 *                         [--model opus] [--allow-unreviewed]
 *
 * The reviewer used to return the whole plan and the orchestrator did `tc_list = updated_tc_list`.
 * A replace. If the reviewer ran short — 180 tests returned of 237 — the plan silently became 180
 * tests. Nothing errored, the file stayed valid, and the run proceeded against a plan that had
 * quietly lost a quarter of its coverage. That is the failure this entire stage exists to catch,
 * reachable *through* the stage.
 *
 * So the reviewer returns a PATCH and this applies it. The original plan is never replaced, only
 * amended, which changes the worst case from "tests disappear" to "some prompts went unpolished".
 *
 * A short patch is still valid JSON, so three things are verified rather than trusted:
 *
 *   1. every shard came back — 1..N, none missing;
 *   2. every test was reviewed exactly once, across all shards;
 *   3. each shard's own declared counts match what its patch actually contains.
 *
 * Without (3) a truncated patch is indistinguishable from a light-touch review.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { readArtifacts, writeJson, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'patch', 'connector', 'model', 'allow-unreviewed', 'batch-size'],
  usage: 'usage: review-merge.mjs --dir <connectorDir> --patch <file or directory> [--connector Name] [--model M]',
});
if (!a.dir || !a.patch) {
  console.error('usage: review-merge.mjs --dir <connectorDir> --patch <file or directory> [--connector Name] [--model M]');
  process.exit(EXIT.USAGE);
}

let conn = a.connector || a.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
if (!existsSync(join(a.dir, `${conn}_plan.json`))) {
  const found = (existsSync(a.dir) ? readdirSync(a.dir) : []).filter(f => /_plan\.json$/.test(f));
  if (a.connector) fail(`no plan for connector "${conn}" in ${a.dir}`);
  if (found.length === 1) conn = found[0].replace(/_plan\.json$/, '');
  else if (found.length > 1) fail(`${found.length} connectors in ${a.dir} — pass --connector`);
}
const P = n => join(a.dir, `${conn}_${n}.json`);

const { plan, G, K } = readArtifacts({
  plan: { path: P('plan'), kind: 'plan' },
  G:    { path: P('gaps'), kind: 'gaps' },
  K:    { path: P('knowledge'), kind: 'knowledge' },
});
/* the names the reviewer is allowed to have used */
const knownObjects = new Set((K.objects || []).map(o => String(o.name).toLowerCase()));
const knownProcs   = new Set((K.physical?.procedures || []).map(p => String(p.name).toLowerCase()));

/* ── collect the patches ───────────────────────────────────────────────────── */
const patchFiles = statSync(a.patch).isDirectory()
  ? readdirSync(a.patch).filter(f => /review_patch.*\.json$/i.test(f)).sort().map(f => join(a.patch, f))
  : [a.patch];
if (!patchFiles.length) fail(`no review patch found at ${a.patch}`);

const patches = patchFiles.map(f => {
  try { return { file: f, ...JSON.parse(readFileSync(f, 'utf8')) }; }
  catch (e) { fail(`${f} is not valid JSON: ${e.message}`); }
});

/* ── 1 · every shard came back ─────────────────────────────────────────────── */
const of = patches[0]?.shard?.of ?? 1;
if (patches.some(p => (p.shard?.of ?? 1) !== of))
  fail(`patches disagree about how many shards there were: ${[...new Set(patches.map(p => p.shard?.of ?? 1))].join(', ')}`);
const seenShards = new Set(patches.map(p => p.shard?.index ?? 1));
const absent = Array.from({ length: of }, (_, i) => i + 1).filter(i => !seenShards.has(i));
if (absent.length)
  fail(`shard(s) ${absent.join(', ')} of ${of} did not return. Re-dispatch just those — the tests in them are unreviewed.`);

/* ── 2 · every test reviewed exactly once ──────────────────────────────────── */
const planIds = (plan.tc_list || []).map(t => t.id);
const reviewCount = new Map();
for (const p of patches) for (const id of p.reviewed_ids || []) reviewCount.set(id, (reviewCount.get(id) || 0) + 1);
const unreviewed = planIds.filter(id => !reviewCount.has(id));
const twice = [...reviewCount.entries()].filter(([, n]) => n > 1).map(([id]) => id);
if (twice.length) fail(`${twice.length} test(s) were reviewed by more than one shard: ${twice.slice(0, 5).join(', ')}`);
if (unreviewed.length && !a['allow-unreviewed'])
  fail(`${unreviewed.length} of ${planIds.length} test(s) were never reviewed: ${unreviewed.slice(0, 8).join(', ')}` +
       `${unreviewed.length > 8 ? ' …' : ''}\n  Re-dispatch the shard that owned them, or pass --allow-unreviewed to accept a partial review.`);

/* ── 3 · declared counts match the patch contents ──────────────────────────── */
/* A truncated patch is still valid JSON. Without this it is indistinguishable from a reviewer that
 * simply had little to say. */
for (const p of patches) {
  const c = p.counts || {};
  const actual = { modified: (p.modified || []).length, added: (p.added || []).length, merges: (p.merges || []).length };
  for (const k of ['modified', 'added', 'merges']) {
    if (c[k] !== undefined && c[k] !== actual[k])
      fail(`shard ${p.shard?.index ?? 1} declared ${c[k]} ${k} but its patch contains ${actual[k]}. ` +
           `The response was truncated — re-dispatch this shard.`);
  }
  if (c.reviewed !== undefined && c.reviewed !== (p.reviewed_ids || []).length)
    fail(`shard ${p.shard?.index ?? 1} declared ${c.reviewed} reviewed but listed ${(p.reviewed_ids || []).length} ids.`);
}

/* ── apply ─────────────────────────────────────────────────────────────────── */
const byId = new Map((plan.tc_list || []).map(t => [t.id, t]));
/* `expected_behavior` is mutable because the writer moves test mechanics out of a prompt and into
 * it (07a-tc-review.md §8.5.4a). `agent_context` and `suite` are not: the operating note carries
 * the write rules and workspace, and which suite a test belongs to is decided by what it covers. */
const MUTABLE = new Set(['prompt', 'uc', 'risk_flag', 'risk_flag_all', 'target_objects', 'target_columns',
  'query_patterns', 'roles', 'persona', 'business_domain', 'priority', 'nt_reason', 'note', 'expected_behavior']);
let modified = 0, skippedMods = [], rewritten = 0;
for (const p of patches) for (const m of p.modified || []) {
  const t = byId.get(m.id);
  if (!t) { skippedMods.push(m.id); continue; }
  /* Only fields the reviewer is allowed to change. `id`, `gap_ids` and `expected_sql` are not
   * among them: a reviewer that never saw expected_sql must not be able to rewrite it. */
  let touched = false;
  const before = t.prompt;
  for (const [k, v] of Object.entries(m)) {
    if (k === 'id' || k === 'reason' || !MUTABLE.has(k)) continue;
    if (JSON.stringify(t[k]) !== JSON.stringify(v)) { t[k] = v; touched = true; }
  }
  /* a business prompt the writer has put in the persona's words is no longer a draft — and a
   * realism score given to the old wording no longer applies */
  if (t.suite === 'business' && t.prompt !== before) { t.prompt_status = 'rewritten'; rewritten++; }
  if (touched) { t.reviewed = true; if (m.reason) t.review_note = m.reason; modified++; }
}
/* A business draft the writer left alone is still a draft, so the realism gate will stop it. That
 * is deliberate: "the reviewer saw it and changed nothing" is indistinguishable from "the reviewer
 * ran short", so a draft must be rewritten or explicitly accepted (`prompt_status: "accepted"`). */
for (const p of patches) for (const id of p.accepted_business || []) {
  const t = byId.get(id);
  if (t && t.suite === 'business' && t.prompt_status === 'draft') t.prompt_status = 'accepted';
}

/* additions get ids after the highest existing one, so no id is ever reused */
const maxN = planIds.reduce((m, id) => Math.max(m, Number(String(id).replace(/\D/g, '')) || 0), 0);
let n = maxN, added = [], rejected = [];
for (const p of patches) for (const t of p.added || []) {
  /* Every object and procedure it names must exist. A hallucinated name produces a test that can
   * only fail, and it would be reported as a connector defect rather than a review error.
   *
   * `target_objects` carries whatever the test acts on, and for a procedure test that is the
   * procedure. Checking it against tables and views alone rejected three valid additions naming
   * `DuplicateProject`, `DuplicateTask` and `AddFollowers` — all three genuinely exposed — and the
   * rejection reads identically to a hallucination, so the tests are simply lost. A guard against
   * invented names must know every name the connector actually has. */
  const known = o => { const k = String(o).toLowerCase(); return knownObjects.has(k) || knownProcs.has(k); };
  const badObjs = (t.target_objects || []).filter(o => !known(o));
  const badProc = t.sp_name && !knownProcs.has(String(t.sp_name).toLowerCase()) ? t.sp_name : null;
  if (badObjs.length || badProc) {
    rejected.push({ uc: t.uc, dimension: t.dimension || null,
      why: badProc ? `procedure "${badProc}" is not exposed by this connector`
                   : `object(s) not exposed by this connector: ${badObjs.join(', ')}` });
    continue;
  }
  const tc = { id: `TC-${String(++n).padStart(3, '0')}`, ...t,
    gap_ids: t.gap_ids || [], added_by: 'stage_8.5', steps: [], status: 'ne', time: '0s',
    est_in: 0, est_out: 0, tool_calls: 0, observed: null, owner: null,
    /* the reviewer writes additions in final form; unsuited additions are connector checks */
    suite: t.suite === 'business' ? 'business' : 'conformance',
    ...(t.suite === 'business' ? { prompt_status: 'rewritten' } : {}) };
  delete tc.reason;
  plan.tc_list.push(tc); byId.set(tc.id, tc); added.push({ tc, reason: t.reason || null, dimension: t.dimension || null });
}

/* ── merges are proposed, never silently performed ─────────────────────────── */
/* A wrong merge is a lost test. Additions and edits are safe to apply on sight; removals are the
 * one thing the run surfaces rather than trusts. */
const merges = patches.flatMap(p => (p.merges || []).map(m => ({ ...m, shard: p.shard?.index ?? 1 })));
const applied = [], refused = [];
const CAP = Math.max(3, Math.ceil(planIds.length * 0.05));
for (const m of merges) {
  if (!byId.has(m.keep) || !byId.has(m.drop)) { refused.push({ ...m, why: 'names a test that does not exist' }); continue; }
  if (applied.length >= CAP) { refused.push({ ...m, why: `merge cap of ${CAP} reached — review these by hand` }); continue; }
  if (!m.reason) { refused.push({ ...m, why: 'no reason given' }); continue; }
  const keep = byId.get(m.keep), drop = byId.get(m.drop);
  keep.gap_ids = [...new Set([...(keep.gap_ids || []), ...(drop.gap_ids || [])])];
  keep.use_case_ids = [...new Set([...(keep.use_case_ids || []), ...(drop.use_case_ids || [])])];
  plan.tc_list = plan.tc_list.filter(t => t.id !== m.drop);
  byId.delete(m.drop);
  applied.push(m);
}

/* ── map new tests back to gaps ────────────────────────────────────────────── */
/* The reviewer is deliberately not given the gap ledger, so it cannot cite gap ids. Mapping
 * happens here — and a new test matching NO gap is itself a finding: the gap analysis missed
 * something the reviewer found by reading the connector and the research directly. */
const gapsByObject = new Map(), gapsByPattern = new Map(), gapsByUc = new Map();
for (const g of G.gaps || []) {
  for (const o of g.impacted?.objects || []) {
    const k = String(o).toLowerCase(); if (!gapsByObject.has(k)) gapsByObject.set(k, []); gapsByObject.get(k).push(g.id);
  }
  for (const p of g.impacted?.patterns || []) { if (!gapsByPattern.has(p)) gapsByPattern.set(p, []); gapsByPattern.get(p).push(g.id); }
  if (g.use_case) { if (!gapsByUc.has(g.use_case)) gapsByUc.set(g.use_case, []); gapsByUc.get(g.use_case).push(g.id); }
}
const unmapped = [];
for (const { tc, dimension } of added) {
  const ids = new Set(tc.gap_ids);
  for (const o of tc.target_objects || []) (gapsByObject.get(String(o).toLowerCase()) || []).forEach(id => ids.add(id));
  for (const p of tc.query_patterns || []) (gapsByPattern.get(p) || []).forEach(id => ids.add(id));
  for (const u of tc.use_case_ids || []) (gapsByUc.get(u) || []).forEach(id => ids.add(id));
  tc.gap_ids = [...ids];
  if (!tc.gap_ids.length) { tc.surface = true; unmapped.push({ id: tc.id, uc: tc.uc, dimension }); }
}

/* ── batch assignment — arithmetic, not judgement ──────────────────────────── */
/* This was a job the reviewer did. Grouping tests so a parallel batch does not fight over the same
 * object is a deterministic partition, and it was in a model call for no reason. */
const SIZE = Number(a['batch-size'] || 5);
{
  const byObject = new Map();
  for (const t of plan.tc_list) {
    const k = (t.target_objects || [])[0] || t.sp_name || 'misc';
    if (!byObject.has(k)) byObject.set(k, []); byObject.get(k).push(t);
  }
  let b = 0;
  for (const group of byObject.values())
    for (let i = 0; i < group.length; i += SIZE) {
      b++; for (const t of group.slice(i, i + SIZE)) t.batch_id = `B${String(b).padStart(3, '0')}`;
    }
}

/* ── write ─────────────────────────────────────────────────────────────────── */
const dims = patches[0]?.completeness_input || null;
const summary = {
  tcs_reviewed: reviewCount.size,
  tcs_modified: modified,
  business_prompts_rewritten: rewritten,
  business_drafts_left: (plan.tc_list || []).filter(t => t.suite === 'business' && t.prompt_status === 'draft').length,
  tcs_added: added.length,
  tcs_merged: applied.length,
  merges_refused: refused.length,
  unreviewed: unreviewed.length,
  shards: of,
  model: a.model || null,
  completeness: patches.flatMap(p => p.completeness_response || []),
  web_findings: patches.flatMap(p => p.web_findings || []),
  added_detail: added.map(x => ({ id: x.tc.id, uc: x.tc.uc, dimension: x.dimension, reason: x.reason })),
  unmapped_additions: unmapped,
  rejected_additions: rejected,
  refused_merges: refused,
};

plan.reviewed_at = new Date().toISOString();
plan.review_model = a.model || plan.review_model || null;
plan.review_summary = summary;
writeJson(P('plan'), plan);
writeJson(P('tc_review'), { connector: conn, run_id: plan.run_id || null, ...summary,
  reviewed_ids: [...reviewCount.keys()] });

const jsonl = P('checkpoint').replace(/\.json$/, '.jsonl');
appendFileSync(jsonl, JSON.stringify({ type: 'summary', key: 'tc_review_summary', value: summary,
  at: new Date().toISOString() }) + '\n', 'utf8');

/* ── report ────────────────────────────────────────────────────────────────── */
console.log(`STAGE 8.5 MERGE — ${conn}`);
console.log(`  shards returned   ${of}/${of}`);
console.log(`  tests reviewed    ${reviewCount.size}/${planIds.length}${unreviewed.length ? `  ⚠ ${unreviewed.length} unreviewed` : ''}`);
console.log(`  modified          ${modified}`);
console.log(`  business rewrites ${rewritten}${summary.business_drafts_left ? `   ⚠ ${summary.business_drafts_left} business draft(s) left unrewritten — the realism gate (8.6) will stop them` : ''}`);
console.log(`  added             ${added.length}${rejected.length ? `   (${rejected.length} rejected)` : ''}`);
console.log(`  merged            ${applied.length}${refused.length ? `   (${refused.length} refused)` : ''}`);
console.log(`  plan now          ${plan.tc_list.length} tests`);
if (skippedMods.length) console.error(`\n  ⚠ ${skippedMods.length} edit(s) named a test that does not exist: ${skippedMods.slice(0, 5).join(', ')}`);
if (rejected.length) {
  console.error(`\n  ✗ ${rejected.length} proposed test(s) rejected — they name things this connector does not expose:`);
  for (const r of rejected.slice(0, 5)) console.error(`      ${String(r.uc).slice(0, 52)} — ${r.why}`);
}
if (unmapped.length) {
  console.log(`\n  ⚠ ${unmapped.length} new test(s) match no existing gap — the gap analysis missed these:`);
  for (const u of unmapped.slice(0, 6)) console.log(`      ${u.id}  ${u.dimension ? `[${u.dimension}] ` : ''}${String(u.uc).slice(0, 62)}`);
}
if (refused.length) {
  console.log(`\n  merges refused (a wrong merge is a lost test):`);
  for (const r of refused.slice(0, 5)) console.log(`      keep ${r.keep} / drop ${r.drop} — ${r.why}`);
}
console.log(`\n→ ${P('plan')}\n→ ${P('tc_review')}`);
