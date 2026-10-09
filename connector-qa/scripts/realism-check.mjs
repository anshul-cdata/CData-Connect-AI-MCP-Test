#!/usr/bin/env node
/**
 * realism-check.mjs — Stage 8.6, the gate between a plan and a business-relevant plan.
 *
 *   node realism-check.mjs --dir <connectorDir> --prep                    # write the judge's input
 *   node realism-check.mjs --dir <connectorDir> --merge <scores.json>     # apply scores, then gate
 *   node realism-check.mjs --dir <connectorDir>                           # lint and gate only
 *        [--connector Name] [--model opus] [--allow-unrealistic]
 *
 * Why this exists
 * ---------------
 * Management reviewed the asn005 Asana plan and found most of its prompts unrealistic. Nothing in
 * the pipeline could have told them sooner: every check measured coverage — is each object,
 * pattern and procedure touched? — and none measured whether a real person would ever ask the
 * question. A 100%-covered plan of prompts nobody would type is a well-measured irrelevance.
 *
 * Two halves, for the usual reason:
 *
 *   Arithmetic (here) — lib/realism.mjs lints every business prompt for leaked schema names, raw
 *   ids, SQL words and harness instructions. Deterministic, so the judge never spends attention
 *   on what a regex can catch.
 *
 *   Judgement (a model) — `config.models.realism_judge`, dispatched in a FRESH context with the
 *   package --prep writes, scores each business prompt 1–5 against the rubric. It sees the persona
 *   and the goal, never the SQL, the gaps or the writer's reasoning, so it judges the question and
 *   not the bookkeeping behind it. It does not rewrite: a judge that rewrites is grading its own
 *   work. Its notes go back to Stage 8.5 when a prompt fails.
 *
 * The gate: while `config.defaults.realism.enforce` is true, the run stops when any business
 * test is unscored, still fails lint, or scores below `realism.min_score`. Conformance tests are
 * linted for raw ids and harness phrases only — they are checks, not scenarios, and the report
 * never presents them as use cases.
 *
 * Exit 0 pass · 3 blocked (reasons printed) · 2 usage.
 */
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readArtifacts, writeJson, fail, EXIT, loadConfig } from './lib/artifacts.mjs';
import { parseArgs } from './lib/cli.mjs';
import { lintPrompt, rubric } from './lib/realism.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'prep', 'merge', 'model', 'allow-unrealistic', 'out'],
  usage: 'usage: realism-check.mjs --dir <connectorDir> [--prep | --merge <scores.json>] [--allow-unrealistic]',
});
if (!a.dir) { console.error('usage: realism-check.mjs --dir <connectorDir> [--prep | --merge <scores.json>]'); process.exit(EXIT.USAGE); }

let conn = a.connector || a.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
if (!existsSync(join(a.dir, `${conn}_plan.json`))) {
  const found = (existsSync(a.dir) ? readdirSync(a.dir) : []).filter(f => /_plan\.json$/.test(f));
  if (a.connector) fail(`no plan for connector "${conn}" in ${a.dir}`);
  if (found.length === 1) conn = found[0].replace(/_plan\.json$/, '');
  else if (found.length > 1) fail(`${found.length} connectors in ${a.dir} — pass --connector`);
}
const P = n => join(a.dir, `${conn}_${n}.json`);
const cfg = loadConfig();
const R = { min_score: 4, enforce: true, ...(cfg.defaults?.realism || {}) };

const { K, plan } = readArtifacts({
  K:    { path: P('knowledge'), kind: 'knowledge' },
  plan: { path: P('plan'),      kind: 'plan' },
});
const tcs = plan.tc_list || [];
const SCHEMA = {
  objects: (K.objects || []).map(o => o.name),
  procedures: (K.physical?.procedures || []).map(p => p.name),
};
const business = tcs.filter(t => t.suite === 'business');
const conformance = tcs.filter(t => t.suite !== 'business');
const personaByName = new Map((K.connector_meta?.personas || []).map(p => [String(p.name).toLowerCase(), p]));

/* ── the rubric — the same words go to the judge and into the report ───────── */
const RUBRIC = rubric(R.min_score);

/* ── --prep: the judge's package ───────────────────────────────────────────── */
if (a.prep) {
  const pkg = {
    connector: conn, app: K.connector_meta?.app || conn, run_id: plan.run_id || null,
    instructions: [
      `Score each business prompt below for realism, 1 to 5, against the rubric. You are judging the`,
      `QUESTION only — whether a real ${K.connector_meta?.app || conn} user in this role would ask it this way.`,
      `Do not rewrite prompts. For any score below ${R.min_score}, say in "issues" exactly what makes it`,
      `unrealistic, and in "suggestion" how the persona would actually put it — Stage 8.5 uses that.`,
      `Return {"model": "<you>", "scores": [{"id", "score", "criteria": {<criterion>: 1-5}, "issues": [], "suggestion": ""}]}`,
      `with one entry for EVERY id listed. Missing ids block the run.`,
    ],
    rubric: RUBRIC,
    personas: (K.connector_meta?.personas || []).map(p => ({ name: p.name, archetype: p.archetype || null,
      description: p.description || null, jobs: p.jobs_to_be_done || [] })),
    tests: business.map(t => {
      const p = personaByName.get(String(t.persona || t.brief?.persona?.name || '').toLowerCase());
      return { id: t.id, prompt: t.prompt, persona: p ? p.name : (t.persona || null),
        goal: t.brief?.goal || t.uc || null,
        expected_behavior: t.expected_behavior || [],
        lint: lintPrompt(t.prompt, SCHEMA).map(i => i.detail) };
    }),
  };
  const out = a.out || P('realism_input');
  writeFileSync(out, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`REALISM — ${conn}`);
  console.log(`  ${business.length} business prompt(s) packaged for the judge · ${conformance.length} conformance check(s) not judged`);
  console.log(`  dispatch config.models.realism_judge (${cfg.models?.realism_judge || 'opus'}) in a fresh context with this file`);
  console.log(`\n→ ${out}`);
  process.exit(EXIT.OK);
}

/* ── --merge: apply the judge's scores ─────────────────────────────────────── */
let judged = 0, unknown = [];
if (a.merge) {
  let S;
  try { S = JSON.parse(readFileSync(a.merge, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch (e) { fail(`${a.merge} is not valid JSON: ${e.message}`); }
  const byId = new Map(tcs.map(t => [t.id, t]));
  for (const s of S.scores || []) {
    const t = byId.get(s.id);
    if (!t) { unknown.push(s.id); continue; }
    const score = Number(s.score);
    if (!(score >= 1 && score <= 5)) fail(`score for ${s.id} is ${s.score} — must be 1 to 5`);
    t.realism = { score, criteria: s.criteria || {}, issues: s.issues || [],
      ...(s.suggestion ? { suggestion: s.suggestion } : {}),
      judge_model: a.model || S.model || cfg.models?.realism_judge || null, judged_prompt: t.prompt };
    judged++;
  }
}

/* ── lint + gate ───────────────────────────────────────────────────────────── */
const problems = [];
const lintOf = t => lintPrompt(t.prompt, SCHEMA);
/* A score is for a wording. A prompt rewritten after it was judged has not been judged. */
const stale = t => t.realism && t.realism.judged_prompt && t.realism.judged_prompt !== t.prompt;

const leakyBiz = business.filter(t => lintOf(t).length);
const leakyConf = conformance.filter(t => lintOf(t).some(i => i.code === 'raw_id' || i.code === 'tester_instruction'));
const unscored = business.filter(t => !t.realism || stale(t));
const low = business.filter(t => t.realism && !stale(t) && t.realism.score < R.min_score);
const drafts = business.filter(t => t.prompt_status === 'draft');

for (const t of business) t.realism_lint = lintOf(t).map(i => i.code);

if (leakyBiz.length) problems.push(`${leakyBiz.length} business prompt(s) still leak schema names, ids, SQL words or test instructions`);
if (leakyConf.length) problems.push(`${leakyConf.length} conformance prompt(s) carry a raw id or a test instruction`);
if (unscored.length) problems.push(`${unscored.length} business prompt(s) have no realism score${business.some(stale) ? ' (or were rewritten after scoring)' : ''}`);
if (low.length) problems.push(`${low.length} business prompt(s) scored below ${R.min_score}`);
if (drafts.length) problems.push(`${drafts.length} business prompt(s) are still generator drafts — Stage 8.5 has not rewritten them`);

const scores = business.filter(t => t.realism && !stale(t)).map(t => t.realism.score);
const mean = scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null;
const summary = {
  business: business.length, conformance: conformance.length, judged: scores.length,
  mean_score: mean == null ? null : Math.round(mean * 100) / 100,
  passing: business.filter(t => t.realism && !stale(t) && t.realism.score >= R.min_score && !lintOf(t).length).length,
  below_threshold: low.map(t => ({ id: t.id, score: t.realism.score, issues: t.realism.issues, suggestion: t.realism.suggestion || null })),
  lint_failures: leakyBiz.map(t => ({ id: t.id, issues: lintOf(t).map(i => i.detail) })),
  conformance_leaks: leakyConf.map(t => t.id),
  drafts: drafts.map(t => t.id),
  min_score: R.min_score, enforced: R.enforce !== false,
  judge_model: a.model || plan.realism_summary?.judge_model || cfg.models?.realism_judge || null,
  checked_at: new Date().toISOString(),
};
plan.realism_summary = summary;
writeJson(P('plan'), plan);

console.log(`REALISM — ${conn}`);
console.log(`  business scenarios   ${business.length}${a.merge ? `   (${judged} score(s) applied${unknown.length ? `, ${unknown.length} for unknown ids` : ''})` : ''}`);
console.log(`  conformance checks   ${conformance.length}   (linted for ids and test instructions only)`);
if (mean != null) console.log(`  mean realism         ${summary.mean_score} / 5 across ${scores.length} judged · ${summary.passing} passing at ≥ ${R.min_score}`);
for (const t of leakyBiz.slice(0, 6)) console.log(`    ✗ ${t.id}  ${lintOf(t).map(i => i.detail).join('; ').slice(0, 110)}`);
for (const t of low.slice(0, 6)) console.log(`    ✗ ${t.id}  scored ${t.realism.score} — ${(t.realism.issues || []).join('; ').slice(0, 100)}`);

if (!problems.length) {
  console.log(`\n  ✓ every business scenario reads like the business\n`);
  process.exit(EXIT.OK);
}
console.error(`\n${R.enforce === false || a['allow-unrealistic'] ? '⚠' : '✗'} REALISM GATE: ${problems.join(' · ')}`);
console.error(`  Send the failing ids, with the judge's issues and suggestions, back to Stage 8.5 to rewrite;`);
console.error(`  then re-run --prep and the judge on the rewritten prompts (07a-tc-review.md §8.6).`);
if (R.enforce === false || a['allow-unrealistic']) { console.error(`  Not enforced — proceeding.\n`); process.exit(EXIT.OK); }
process.exit(EXIT.DATA);
