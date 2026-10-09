#!/usr/bin/env node
/**
 * ingest-results.mjs — Stage 10.2: turn what the agents did into scored, permanent results.
 *
 *   node ingest-results.mjs --dir <connectorDir> [--root <root>] [--run <id>] [--model <name>]
 *
 * Reads, for every planned test and attempt:
 *   _agent_out/<run>/stage9-<TC>-a<N>.json   the agent's raw return (stage9-<TC>.json counts as attempt 1;
 *                                       a run with no <run> folder is read from _agent_out/ itself)
 *   _agent_out/check-<TC>-a<N>.json    the reference query the orchestrator ran: {sql, rows, error}
 *   _agent_out/judge-<TC>-a<N>.json    for a `judge` check: {outcome, reason} from the fixed judge
 * and the checkpoint's verdicts for tests with no raw file (older runs, conformance checks).
 *
 * Writes <root>/_results/<Connector>/<run_id>/{manifest.json, results.jsonl}: one record per use
 * case × variant × attempt with the normalised journey, the outcome of the check, the score and
 * its parts. That store is what the capability report and every eval read; this script is the
 * only thing that writes it, and running it twice gives the same result.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { readJson, readJsonl, loadConfig, fail, EXIT, SKILL_VERSION } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { normalizeJourney } from './lib/journey.mjs';
import { compare, refineOutcome, isYesNo, ID_RULES, asksUser } from './lib/checks.mjs';
import { rescore } from './lib/scoring.mjs';
import { fingerprintFor, writeRun, listRuns, readRun } from './lib/results.mjs';
import { ucHash } from './lib/catalog.mjs';
import { changesExisting } from './lib/capabilities.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'root', 'run', 'model'],
  usage: 'usage: ingest-results.mjs --dir <connectorDir> [--root <root>] [--run <id>] [--model <name>]',
});
if (!a.dir) { console.error('usage: ingest-results.mjs --dir <connectorDir> [--root <root>]'); process.exit(EXIT.USAGE); }
const cfg = loadConfig();
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const root = resolve(a.root || process.env.CONNECTOR_QA_ROOT || cfg.root || dirname(resolve(a.dir)));

const K = readJson(P('knowledge'), { kind: 'knowledge' });
const plan = readJson(P('plan'), { kind: 'plan' });
const cat = existsSync(P('catalog')) ? readJson(P('catalog')) : null;
const capsDoc = existsSync(P('capabilities')) ? readJson(P('capabilities')) : null;
const meta = K.run_meta || {};
const runId = a.run || meta.run_id;
if (!runId) fail('no run id: pass --run, or record run_meta.run_id at Step 0');
const stored = readRun(root, conn, runId);
const previous = stored?.manifest || null;
let model = a.model || previous?.model || meta.models?.under_test || cfg.models?.under_test || 'unknown';
/* Which tests this run executed. A plan prepared for this run: its tc_list. A plan prepared since
 * for another run (an eval's next model, a later area): an existing run is re-ingested from the
 * tests it stored — late judge files are picked up that way — as long as the plan was not
 * regenerated in between (test ids are renumbered on every generation). A first ingest must
 * match the preparation: in an eval, forgetting --model would file one model's journeys under
 * another. */
let tcList = plan.tc_list || [];
if (plan.prepared && plan.prepared.run_id !== runId) {
  if (!previous) fail(`the plan was prepared for run ${plan.prepared.run_id} with ${plan.prepared.model}, not ${runId} — pass --run ${plan.prepared.run_id} --model ${plan.prepared.model}, or prepare-run again`);
  if (previous.plan_generated_at !== plan.generated_at) fail(`run ${runId} was planned from an earlier plan (${previous.plan_generated_at || 'unrecorded'}); the current plan was generated ${plan.generated_at} with new test ids, so the run cannot be re-ingested from it`);
  if (a.model && a.model !== previous.model) fail(`run ${runId} was ${previous.model}'s, not ${a.model}'s`);
  model = previous.model;
  const ran = new Set(stored.records.map(r => r.tc_id));
  tcList = (plan.full_tc_list || plan.tc_list || []).filter(t => ran.has(t.id));
} else if (plan.prepared && plan.prepared.model !== model) {
  fail(`the plan was prepared for ${plan.prepared.model}, not ${model} — pass --model ${plan.prepared.model}, or prepare-run again`);
}
/* Raw files for one run live in _agent_out/<run id>/ (Stage 9 writes them there, so models in an eval
 * cannot overwrite each other); a run without that folder used the flat layout of earlier versions. */
const out = existsSync(join(a.dir, '_agent_out', runId)) ? join(a.dir, '_agent_out', runId) : join(a.dir, '_agent_out');

/* Verdicts the orchestrator already recorded, for tests that left no raw journey (conformance
 * checks, older runs). Only this run's: the checkpoint's meta line carries its run id, and in an
 * eval another model's checkpoint for the same connector must never fill this model's gaps. */
const ckPath = P('checkpoint').replace(/\.json$/, '.jsonl');
const ckLines = existsSync(ckPath) ? readJsonl(ckPath) : [];
const ckRun = ckLines.find(l => l.type === 'meta')?.run_meta?.run_id ?? null;
const ckUsable = ckLines.length && (ckRun ? ckRun === runId : !existsSync(join(a.dir, '_agent_out', runId)));
if (ckLines.length && !ckUsable) console.error(`  ⚠ the checkpoint belongs to run ${ckRun || '(unrecorded)'}, not ${runId} — its verdicts are not used`);
const ck = ckUsable ? ckLines.filter(l => l.type === 'tc' && l.tc).map(l => l.tc) : [];
const verdict = new Map(ck.map(t => [t.id, t]));
const VERDICT_OUTCOME = s => /^pass/.test(s || '') || s === 'boundary' ? 'correct' : s === 'partial' ? 'partial'
  : s === 'fail' ? 'wrong' : s === 'not_exec' ? 'not_run' : s === 'na' ? 'not_applicable' : s === 'nt' ? 'not_checked' : null;

const readMaybe = p => { if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`  ⚠ ${p} is not valid JSON: ${e.message}`); return null; } };
const fileFor = (kind, id, n) => {
  const p = join(out, `${kind}-${id}-a${n}.json`);
  if (existsSync(p) || n !== 1) return p;
  return join(out, `${kind}-${id}.json`);
};
const ROWS_KEPT = Number(cfg.execution?.rows_kept ?? 50);
const KEEP = 1500;                 // per-step result text kept in the store; the template shows no more
const trimSteps = steps => steps.map(s => (s.result && s.result.length > KEEP ? { ...s, result: s.result.slice(0, KEEP) + ' …' } : s));

/* ── pass 1: journeys and outcomes ───────────────────────────────────────── */
/* 3.1: each business record carries its use case's hash and area, so a later run, report or eval
 * can tell — per use case — whether this result still answers the catalog as it is now. */
const ucById = new Map((cat?.use_cases || []).map(u => [u.id, u]));
/* 3.7: where each test's data came from — found in the account, or created for the test */
const TDATA = existsSync(P('test_data')) ? readJson(P('test_data')) : null;
const dataSource = tc => {
  const st = Object.keys(tc.fixtures || {}).map(id => TDATA?.fixtures?.[id]?.status).filter(Boolean);
  return !st.length ? null : st.every(s => s === 'found') ? 'found' : st.every(s => s === 'seeded') ? 'seeded' : 'mixed';
};
/* The hash of what was RUN: stamped on the test when it was planned. A plan from before 3.1 falls
 * back to the catalog, but only when the prompt is still the catalog's wording — otherwise the
 * result answers a question the catalog no longer asks, and gets no hash (stale). */
const hashFor = tc => {
  if (tc.uc_hash) return tc.uc_hash;
  const u = ucById.get(tc.use_case_id);
  if (!u) return null;
  const text = tc.variant ? (u.variants || [])[tc.variant - 1] : u.request;
  return text === tc.prompt ? ucHash(u) : null;
};
/* 3.5: an action whose every writing capability changes an existing record (update, delete, set) —
 * not one that creates — needs that record to exist before the run; without it the change was never
 * tested (lib/capabilities.mjs changesExisting). */
const capById = new Map((capsDoc?.capabilities || []).map(c => [c.id, c]));
const modifiesExisting = caps => changesExisting(caps, capById);
/* Stage 10.5's owner corrections: the reviewer read every journey and re-charged a failure to the
 * right owner ("a plan refusal is the account's, not the driver's"). Until 3.5 they stayed in the
 * review file and the capability report never saw them. */
const reviewFile = [join(a.dir, '_agent_out', runId, 'stage10_5-review.json'), join(a.dir, '_agent_out', 'stage10_5-review.json')].find(existsSync);
const review = (() => {
  const R = reviewFile ? readMaybe(reviewFile) : null;
  if (!R || (R.run_id && R.run_id !== runId)) return new Map();
  return new Map((R.verdict_corrections || R.corrections || []).filter(c => c.tc_id && c.cause).map(c => [c.tc_id, { cause: c.cause, reason: c.reason || null }]));
})();
/* 3.7.2 — what the report needs to explain a check in plain words: the records our check found (up
 * to 20, for names), how many, the AI's query we re-ran and how many rows it gave, and the reads
 * before a change. Taken from the check file; nothing new is run. */
const checkEvidence = ref => !ref ? {} : {
  ...(Array.isArray(ref.rows) ? { reference_rows: ref.rows.slice(0, 20), reference_count: ref.rows.length } : {}),
  ...(Array.isArray(ref.before_rows) ? { before_count: ref.before_rows.length } : {}),
  ...(Array.isArray(ref.data_rows) ? { data_count: ref.data_rows.length } : {}),
  ...(ref.agent_sql ? { agent_sql: String(ref.agent_sql).slice(0, 2000), agent_rows_count: Array.isArray(ref.agent_rows) ? ref.agent_rows.length : null } : {}),
};
const drafts = [];
let missing = 0, expected = 0;
for (const tc of tcList) {
  const attempts = Math.max(1, Number(tc.attempts) || 1);
  for (let n = 1; n <= attempts; n++) {
    const base = {
      run_id: runId, model, tc_id: tc.id, use_case_id: tc.use_case_id || null, variant: tc.variant || 0, attempt: n,
      suite: tc.suite || 'conformance', kind: tc.kind || (tc.mutates ? 'action' : 'question'),
      area: tc.business_process || tc.process_group || null, persona: tc.persona || null,
      area_id: ucById.get(tc.use_case_id)?.area || tc.business_domain || null,
      uc_hash: hashFor(tc),
      request: tc.prompt, capabilities: tc.capabilities || [], source: tc.source || null,
      priority: tc.priority || null, uc: tc.uc || null, group: tc.group || null,
      ...(tc.fixtures ? { fixtures: tc.fixtures, data_source: dataSource(tc) } : {}),
    };
    if (tc.executable === false) {
      const why = tc.nt_reason || '';
      /* 3.7: a test held for missing data, or because the account refused its data, is that result —
       * not "not run", which reads as if nobody tried */
      const outcome = /^Not possible through the connector/.test(why) ? 'not_possible'
        : /^Blocked by the account/.test(why) ? 'blocked_account' : tc.data_hold || /^No test data/.test(why) ? 'no_test_data' : 'not_run';
      drafts.push({ ...base, outcome, reason: why || null, journey: null });
      break;                                         // one record is enough for a test never dispatched
    }
    expected++;
    const raw = readMaybe(fileFor('stage9', tc.id, n));
    if (!raw) {
      const v = verdict.get(tc.id);
      if (n === 1 && v && !tc.check?.rule) { drafts.push({ ...base, outcome: VERDICT_OUTCOME(v.status) || 'not_checked', reason: 'from the checkpoint verdict — no raw journey stored', check: { rule: null, detail: `checkpoint verdict ${v.status}` }, journey: null }); continue; }
      /* every attempt the plan asked for and that left no result counts: a P1 use case with one
       * of three attempts stored is not a complete measurement */
      missing++;
      drafts.push({ ...base, outcome: 'not_run', reason: 'no result recorded for this attempt', journey: null });
      continue;
    }
    const j = normalizeJourney(raw);
    let outcome, detail = null;
    /* 3.6 — a limitation probe: the use case needs a capability ConnectAI MCP does not offer. The
     * business answer is "not possible" whatever the agent did; what is measured is the agent — did it
     * say so plainly, or invent an answer or claim a change? The fixed judge decides. */
    if (tc.probe === 'limitation') {
      const jd = readMaybe(fileFor('judge', tc.id, n));
      const wrote = (j.steps || []).some(s => s.category === 'write' && s.ok);
      const probe = jd?.outcome ? { outcome: wrote && jd.outcome === 'correct' ? 'partial' : jd.outcome, detail: jd.reason || null }
        : { outcome: 'needs_judgement', detail: 'awaiting the answer judge' };
      const pj2 = readMaybe(fileFor('judge2', tc.id, n));
      if (pj2?.outcome && jd?.outcome) probe.second = { outcome: pj2.outcome, agree: pj2.outcome === jd.outcome };
      if (wrote) probe.detail = `${probe.detail || ''} (the agent changed data on the way)`.trim();
      drafts.push({ ...base, outcome: 'not_possible', reason: tc.not_possible_reason || null, probe,
                    check: { rule: 'judge', detail: probe.detail, reference_sql: null }, journey: j,
                    raw_file: fileFor('stage9', tc.id, n).split(/[\\/]/).slice(-2).join('/') });
      continue;
    }
    const ref = tc.check?.rule ? readMaybe(fileFor('check', tc.id, n)) : null;
    let touched = null;
    /* 3.7 — the second judge's verdict on the same attempt, for agreement; the first judge decides */
    const j2v = readMaybe(fileFor('judge2', tc.id, n));
    const firstJudge = readMaybe(fileFor('judge', tc.id, n))?.outcome || null;
    const second = j2v?.outcome && firstJudge ? { outcome: j2v.outcome, reason: j2v.reason || null, agree: j2v.outcome === firstJudge } : null;
    if (tc.check?.rule) {
      if (tc.check.rule === 'judge') {
        const jd = readMaybe(fileFor('judge', tc.id, n));
        outcome = jd?.outcome || 'needs_judgement'; detail = jd?.reason || 'awaiting the answer judge';
      } else {
        const self = j.final_rows || [];
        const r = compare(tc.check, { rows: self, stated_count: raw.stated_count, truncated: self.length >= ROWS_KEPT },
                          ref || { error: 'the orchestrator recorded no reference result' });
        outcome = r.result; detail = r.detail; touched = r.touched || null;
        /* a yes/no question is answered in words: an id comparison that did not confirm it is not a verdict */
        const u0 = ucById.get(tc.use_case_id) || {};
        if (ID_RULES.has(tc.check.rule) && !['correct', 'no_test_data', 'not_checked'].includes(outcome) && base.kind !== 'action'
            && isYesNo(tc.prompt, tc.expected_behavior || u0.expected_behavior)) {
          detail = `a yes/no question — ${r.detail}; decided by the answer judge against the reference rows`;
          outcome = 'needs_judgement';
        }
        /* a check that could not compare the answer row by row hands it to the answer judge */
        if (outcome === 'needs_judgement') {
          const jd = readMaybe(fileFor('judge', tc.id, n));
          if (jd?.outcome) { outcome = jd.outcome; detail = `${r.detail} · judge: ${jd.reason || jd.outcome}`; }
        }
      }
      const u = ucById.get(tc.use_case_id) || {};
      const fine = refineOutcome({ outcome, detail }, j, { kind: base.kind, check: tc.check, tests: u.tests || tc.tests || [],
        modifiesExisting: modifiesExisting(tc.capabilities || u.capabilities) }, ref || {});
      outcome = fine.outcome; detail = fine.detail;
    } else {
      const v = verdict.get(tc.id);
      outcome = (v && VERDICT_OUTCOME(v.status)) || (j.metrics.gave_up ? 'wrong' : 'not_checked');
      detail = v ? `checkpoint verdict ${v.status}` : 'no check defined';
    }
    /* 3.7 — a scripted second turn. When the agent asked a clarifying question, the orchestrator sent
     * the use case's fixed reply to a fresh agent with the conversation so far. Turn 1 is kept as
     * "did it ask the right thing"; the job is finished — or not — in turn 2, so that decides. */
    let clarify = null, journey = j, turn2Second = null;
    if (tc.follow_up) {
      const raw2 = readMaybe(join(out, `stage9-${tc.id}-a${n}-t2.json`));
      const asked = asksUser(j.answer) && !(j.steps || []).some(s => s.category === 'write' && s.ok);
      if (raw2) {
        const j2 = normalizeJourney(raw2);
        const fu = tc.follow_up, ref2 = readMaybe(join(out, `check-${tc.id}-a${n}-t2.json`));
        let o2, d2;
        if (!fu.check?.rule || fu.check.rule === 'judge') { const jd2 = readMaybe(join(out, `judge-${tc.id}-a${n}-t2.json`)); o2 = jd2?.outcome || 'needs_judgement'; d2 = jd2?.reason || 'awaiting the answer judge';
          /* the second judge on turn 2 decides agreement for the finished job */
          const s2 = readMaybe(join(out, `judge2-${tc.id}-a${n}-t2.json`)); if (s2?.outcome && jd2?.outcome) turn2Second = { outcome: s2.outcome, reason: s2.reason || null, agree: s2.outcome === jd2.outcome }; }
        else { const r2 = compare(fu.check, { rows: j2.final_rows || [] }, ref2 || { error: 'the orchestrator recorded no reference result for turn 2' }); o2 = r2.result; d2 = r2.detail; if (r2.touched?.length) touched = r2.touched; }
        const f2 = refineOutcome({ outcome: o2, detail: d2 }, j2, { kind: base.kind, check: fu.check || { rule: 'judge' }, tests: [], modifiesExisting: modifiesExisting(tc.capabilities) }, ref2 || {});
        clarify = { outcome, detail, answer: j.answer, reply: fu.reply };
        outcome = f2.outcome; detail = `after the user's reply ("${fu.reply}"): ${f2.detail}`;
        const off = (j.steps || []).length;
        const sum = k => (Number(j.metrics?.[k]) || 0) + (Number(j2.metrics?.[k]) || 0);
        journey = { ...j2, steps: [...(j.steps || []), ...(j2.steps || []).map(s => ({ ...s, n: s.n + off, turn: 2 }))],
          metrics: { ...j2.metrics, ...Object.fromEntries(['calls', 'acting_calls', 'discovery_calls', 'failed', 'recoveries', 'dead_ends', 'repeated', 'writes', 'time_ms', 'tokens'].map(k => [k, sum(k) || (k === 'time_ms' || k === 'tokens' ? null : 0)])),
                     first_attempt: !!(j.metrics?.first_attempt && j2.metrics?.first_attempt) } };
      } else if (asked) {
        clarify = { outcome, detail, answer: j.answer, reply: tc.follow_up.reply };
        missing++; outcome = 'not_run'; detail = 'the agent asked a clarifying question, but the scripted reply (turn 2) has no result yet';
      }
    }
    drafts.push({ ...base, outcome, check: { rule: tc.check?.rule || null, detail, reference_sql: tc.check?.reference_sql || null, ...checkEvidence(ref) },
                  ...(review.has(tc.id) ? { review: review.get(tc.id) } : {}), ...(touched?.length ? { touched } : {}), ...(clarify ? { clarify } : {}), ...((turn2Second || second) ? { second_judge: turn2Second || second } : {}),
                  journey, raw_file: fileFor('stage9', tc.id, n).split(/[\\/]/).slice(-2).join('/') });
  }
}

/* ── pass 2: scores ──────────────────────────────────────────────────────── */
/* Scored with the shortest path and speed norms known across every stored run of this connector
 * (lib/scoring.mjs rescore). Reports and evals re-score again across exactly the runs they show,
 * so a stored score is never the last word. */
const minCalls = new Map((cat?.use_cases || []).filter(u => u.check?.min_calls).map(u => [u.id, u.check.min_calls]));
const history = listRuns(root, conn).filter(m => m.run_id !== runId).flatMap(m => readRun(root, conn, m.run_id).records);
const flat = drafts.map(d => {
  if (!d.journey) return { ...d, score: null, grade: 'none', parts: {}, metrics: null, steps: [] };
  const { journey, ...rest } = d;
  return { ...rest, metrics: journey.metrics, steps: trimSteps(journey.steps),
           final_sql: journey.final_sql, answer: journey.answer, assumptions: journey.assumptions };
});
const records = rescore(flat, { pool: history, minCalls }, cfg.scoring || {});

/* ── manifest ────────────────────────────────────────────────────────────── */
/* 3.7: the records the fixtures were bound to are part of the environment */
const fp = fingerprintFor(K, cat, existsSync(P('test_data')) ? readJson(P('test_data')) : null);
const planned = tcList.length;
const counts = records.reduce((m, r) => (m[r.outcome] = (m[r.outcome] || 0) + 1, m), {});
const manifest = {
  model, started_at: meta.started_at || null,
  /* when the run happened: from prepare-run, else the first ingest. Re-ingesting keeps it. */
  run_started_at: previous?.run_started_at || (plan.prepared?.run_id === runId ? plan.prepared.at : null) || previous?.finished_at || new Date().toISOString(),
  finished_at: previous?.finished_at || new Date().toISOString(), ingested_at: new Date().toISOString(),
  skill_version: SKILL_VERSION, catalog_version: cat?.version ?? null,
  capability_source: capsDoc?.source || null,
  /* 3.9 — the orchestrator that ran and the one suggested (orchestrator-advice.mjs); absent before 3.9 */
  ...(meta.orchestrator?.actual ? { orchestrator: meta.orchestrator } : {}),
  fingerprint: fp, scope: plan.scope || null, plan_generated_at: plan.generated_at || null,
  prepared: plan.prepared?.run_id === runId ? plan.prepared : previous?.prepared || null, reused: (plan.reused || []).length,
  planned_tests: planned, records: records.length, outcomes: counts,
  attempts_expected: expected, attempts_found: expected - missing,
  complete: missing === 0,
  fixed_models: { research: meta.models?.research_business || cfg.models?.research_business || null, writer: cfg.models?.tc_review || null,
                  judge: cfg.models?.realism_judge || null },
  scoring: { weights: cfg.scoring?.weights || null, grades: cfg.scoring?.grades || null },
};
const dir = writeRun(root, conn, runId, manifest, records);

console.log(`RESULTS — ${conn} · run ${runId} · ${model}`);
console.log(`  ${records.length} record(s) from ${planned} planned test(s) · ${Object.entries(counts).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(' · ')}`);
const sc = records.filter(r => Number.isFinite(r.score));
if (sc.length) console.log(`  average score ${Math.round(sc.reduce((x, r) => x + r.score, 0) / sc.length)} · ${sc.filter(r => r.grade === 'blue').length} blue · ${sc.filter(r => r.grade === 'yellow').length} yellow · ${sc.filter(r => r.grade === 'red').length} red`);
console.log(`  fingerprint ${fp.key}${manifest.complete ? '' : ` · ⚠ ${missing} attempt(s) left no result — the run is marked incomplete and will not be reused by an eval`}`);
console.log(`\n→ ${dir}`);
