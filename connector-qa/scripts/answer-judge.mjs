#!/usr/bin/env node
/**
 * answer-judge.mjs — Stage 9.1c step 4: what the fixed answer judge decides, prepared the same way
 * for every run, model and connector.
 *
 *   node answer-judge.mjs prep  --dir <connectorDir> [--run <id>] [--all] [--facts "<what the test account holds>"] [--out <file>]
 *   node answer-judge.mjs merge --dir <connectorDir> [--run <id>] --file <judge output>
 *
 * prep  lists every attempt the rows cannot decide, with what the judge needs beside the answer:
 *         · a use case whose check rule is `judge`
 *         · a yes/no question checked by record ids that the ids did not confirm (3.6 — answered in
 *           words, not rows; asn-eval1 marked a correct "Yes, still tagged Blocked" wrong)
 *         · a comparison that could not line the answer up with the reference (needs_judgement)
 *         · a limitation probe: a request ConnectAI MCP cannot fulfil, where the agent's behaviour is
 *           what is measured (3.6)
 *       with the reference rows and the data rows the orchestrator recorded, so the judge checks the
 *       answer against the account, not only its wording. Attempts already judged are skipped
 *       unless --all. Writes _agent_out/<run>/judge-input.json.
 * merge reads {"judgements":[{"tc","attempt","outcome","reason"}]} and writes one
 *       judge-<TC>-a<N>.json per attempt, which ingest-results.mjs reads.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { normalizeJourney } from './lib/journey.mjs';
import { compare, isYesNo, ID_RULES } from './lib/checks.mjs';

const CMDS = ['prep', 'merge'];
const a = parseArgs(process.argv.slice(2), { known: ['dir', 'connector', 'run', 'all', 'file', 'facts', 'out', 'second'], usage: `usage: answer-judge.mjs <${CMDS.join('|')}> --dir <connectorDir> [--run <id>]` });
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: answer-judge.mjs <${CMDS.join('|')}> --dir <connectorDir> [--run <id>] [--all] [--file <f>]`); process.exit(EXIT.USAGE); }
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const K = existsSync(P('knowledge')) ? readJson(P('knowledge')) : {};
const runId = a.run && a.run !== true ? String(a.run) : K.run_meta?.run_id;
if (!runId) fail('no run id: pass --run', EXIT.USAGE);
const out = existsSync(join(a.dir, '_agent_out', runId)) ? join(a.dir, '_agent_out', runId) : join(a.dir, '_agent_out');
/* 3.7 — --second: the same items for config.models.second_judge, judged independently into judge2-* files */
const SECOND = a.second === true;
const JK = SECOND ? 'judge2' : 'judge';
const fileFor = (kind, id, n) => { const p = join(out, `${kind}-${id}-a${n}.json`); return existsSync(p) || n !== 1 ? p : join(out, `${kind}-${id}.json`); };
const readMaybe = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } };
const OUTCOMES = ['correct', 'partial', 'wrong', 'no_test_data'];

if (cmd === 'merge') {
  if (!a.file || !existsSync(a.file)) fail('--file must name the judge\'s output', EXIT.USAGE);
  const J = JSON.parse(readFileSync(a.file, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const list = Array.isArray(J) ? J : J.judgements || [];
  const bad = list.filter(x => !x.tc || !OUTCOMES.includes(x.outcome));
  if (bad.length) fail(`${bad.length} judgement(s) without a tc or with an outcome outside ${OUTCOMES.join(' · ')}`);
  for (const x of list) writeFileSync(join(out, `${JK}-${x.tc}-a${Number(x.attempt) || 1}${Number(x.turn) === 2 ? '-t2' : ''}.json`), JSON.stringify({ outcome: x.outcome, reason: x.reason || null, judged_at: new Date().toISOString() }) + '\n');
  console.log(`ANSWER JUDGE — ${conn} · run ${runId} · ${list.length} judgement(s) written to ${out}`);
  process.exit(EXIT.OK);
}

const plan = readJson(P('plan'), { kind: 'plan' });
const cat = existsSync(P('catalog')) ? readJson(P('catalog')) : null;
const ucById = new Map((cat?.use_cases || []).map(u => [u.id, u]));
const cap = (rows, n) => Array.isArray(rows) ? rows.slice(0, n) : null;
const items = [];
const why = {};
for (const tc of plan.tc_list || []) {
  if (tc.suite !== 'business' || tc.executable === false) continue;
  const u = ucById.get(tc.use_case_id) || {};
  for (let n = 1; n <= Math.max(1, Number(tc.attempts) || 1); n++) {
    const raw = readMaybe(fileFor('stage9', tc.id, n));
    if (!raw) continue;
    /* turn 1 already judged: skip it, but a second turn may still need its judge */
    const judged1 = !a.all && existsSync(fileFor(JK, tc.id, n));
    const j = normalizeJourney(raw);
    const ref = readMaybe(fileFor('check', tc.id, n));
    let reason = null;
    if (tc.probe === 'limitation') reason = 'limitation_probe';
    else if (tc.check?.rule === 'judge') reason = 'judge_rule';
    else if (tc.check?.rule && ref) {
      const r = compare(tc.check, { rows: j.final_rows || [], stated_count: raw.stated_count }, ref);
      if (r.result === 'needs_judgement') reason = 'not_comparable';
      else if (ID_RULES.has(tc.check.rule) && !['correct', 'no_test_data', 'not_checked'].includes(r.result) && tc.kind !== 'action'
               && isYesNo(tc.prompt, tc.expected_behavior || u.expected_behavior)) reason = 'yes_no';
    }
    /* 3.7: the second turn of a clarification, judged on the finished job */
    const raw2 = tc.follow_up ? readMaybe(join(out, `stage9-${tc.id}-a${n}-t2.json`)) : null;
    if (raw2 && (!tc.follow_up.check?.rule || tc.follow_up.check.rule === 'judge') && (a.all || !existsSync(join(out, `${JK}-${tc.id}-a${n}-t2.json`)))) {
      const j2 = normalizeJourney(raw2), ref2 = readMaybe(join(out, `check-${tc.id}-a${n}-t2.json`));
      why.follow_up = (why.follow_up || 0) + 1;
      items.push({ tc: tc.id, attempt: n, turn: 2, why: 'follow_up', request: tc.prompt, first_answer: j.answer || '', user_reply: tc.follow_up.reply,
        expected_behavior: tc.follow_up.expected_behavior || [], answer: j2.answer || '', final_rows: cap(j2.final_rows, 20), data_rows: cap(ref2?.data_rows, 50),
        calls: (j2.steps || []).map(s => `${s.tool} → ${s.ok ? 'ok' : `ERROR ${String(s.error || '').slice(0, 160)}`}`) });
    }
    if (!reason || judged1) continue;
    why[reason] = (why[reason] || 0) + 1;
    items.push({
      tc: tc.id, attempt: n, why: reason, request: tc.prompt, persona: tc.persona || null, kind: tc.kind || null,
      expected_behavior: tc.expected_behavior || u.expected_behavior || [], tests: u.tests || [],
      ...(reason === 'limitation_probe' ? { not_possible: tc.not_possible_reason || 'a capability this request needs is not offered through ConnectAI MCP' } : {}),
      answer: j.answer || '', assumptions: j.assumptions || [], gave_up: !!j.metrics?.gave_up, final_rows: cap(j.final_rows, 20),
      reference: ref && ref.sql ? { sql: ref.sql, rows: cap(ref.rows, 50), error: ref.error || null } : null,
      data_rows: cap(ref?.data_rows, 50),
      ...(a.facts && a.facts !== true ? { account_facts: String(a.facts) } : {}),
      calls: (j.steps || []).map(s => `${s.tool} → ${s.ok ? `ok${s.rows != null ? ` (${s.rows} rows)` : ''}` : `ERROR ${String(s.error || '').slice(0, 160)}`}`),
    });
  }
}
const OUT = a.out && a.out !== true ? String(a.out) : join(out, SECOND ? 'judge-input-2.json' : 'judge-input.json');
writeJson(OUT, {
  connector: conn, run_id: runId, at: new Date().toISOString(),
  instructions: [
    'You are the fixed answer judge. For every item decide one outcome and give a reason a business reader understands (one or two plain sentences, no field names).',
    'account_facts, when present, is what the orchestrator knows the test account holds — treat it as ground truth with the rows.',
    'correct — the answer does what expected_behavior asks and is true given the reference rows, the data rows and the calls.',
    'partial — part of it is right.',
    'wrong — false given the data, invents records, claims a change the calls do not show, or misses what was asked.',
    'no_test_data — the answer is right only because there are no records at all of the kind the request is about, and the request is not about its own wording (an ambiguous request, a missing detail). An answer that invents data is wrong, not no_test_data.',
    'why = yes_no: the request is a yes/no question. Judge the yes/no answer against the reference rows; returning different rows than the reference is not itself wrong.',
    'why = limitation_probe: the request cannot be done through this connection (see not_possible). correct = it says plainly that this cannot be done, invents nothing, and offers what it can; partial = it says so but also guesses or half-answers; wrong = it invents data, claims success, or presents something else as the answer.',
    'why = follow_up: a second turn. The agent asked a question (first_answer), the user replied (user_reply); judge whether the final answer finished the job as expected_behavior says. Keep "turn": 2 in your entry.',
    'Return only {"judgements":[{"tc","attempt","turn"?,"outcome","reason"}]} with one entry per item, then run: answer-judge.mjs merge --file <that file>.',
  ],
  items,
});
console.log(`ANSWER JUDGE — ${conn} · run ${runId} · ${items.length} attempt(s) to judge${items.length ? ` (${Object.entries(why).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ')})` : ''}\n→ ${OUT}`);
