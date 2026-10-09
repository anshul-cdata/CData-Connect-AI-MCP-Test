/* checks.mjs — was the agent's answer right? Compared on data, by a fixed set of rules.
 *
 * Every use case in the catalog carries a check: a reference query written once when the catalog
 * was built, and the rule for comparing its rows with the rows the agent's answer rests on. The
 * orchestrator runs everything through the same MCP connection at run time — so the expected
 * answer is whatever the test account holds today — and writes a check file:
 *
 *   { sql, rows, error }        the reference query, after the agent finished
 *   { agent_sql, agent_rows }   the agent's own final query, RE-RUN by the orchestrator in full.
 *                               The agent's self-reported `final_rows` are capped and are its own
 *                               claim; the re-run is neither. Used whenever present.
 *   { before_rows }             for actions: the reference query run BEFORE the agent started,
 *                               so a change can be told apart from a row that was already there
 *
 *   same_ids      the answer covers the same records as the reference, matched on `key`
 *   same_count    as many records as the reference (a COUNT column, or its row count)
 *   contains      every reference record is in the answer (the answer may hold more)
 *   values_within the same records, and `field` agrees within `tolerance` on each
 *   write_visible after an action, the re-read shows `expect`, and it did not before
 *   judge         cannot be decided from rows; the fixed answer judge decides
 *
 * Results: correct · partial · wrong · no_test_data (the reference found nothing to compare — a
 * pass would mean nothing) · needs_judgement · not_checked. refineOutcome() then adds
 * blocked_account and the other journey-aware rules (3.5). Nothing here knows any connector.
 */

export const RULES = ['same_ids', 'same_count', 'contains', 'values_within', 'write_visible', 'judge'];

const lc = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
const pick = (row, key) => { const r = lc(row); return r[String(key).toLowerCase()]; };
const keyset = (rows, key) => new Set((rows || []).map(r => String(pick(r, key) ?? '')).filter(Boolean));
const num = v => (v == null || v === '' ? NaN : Number(v));

/* A one-row, one-column result is a count only when it is named like one — a single matching
 * record whose Id is 1203948 is not "1203948 records". */
/* a prefix counts only with a word break after it (count_tasks, CountTasks), so CountryCode and
 * NumericValue are not counts */
const COUNT_WORD = /^(count|cnt|total|n|num|number|records?|rows?)$|[a-z0-9]_?(count|total)s?$|_cnt$|^(count|total|num)_[a-z0-9]/i;
const COUNT_CAMEL = /^(Count|Total|Num)[A-Z]/;          // case-sensitive: CountTasks yes, Country no
const COUNT_COL = { test: k => COUNT_WORD.test(k) || COUNT_CAMEL.test(k) };
const NOT_COUNT = /^(dis|ac)count|(dis|ac)counts?$/i;   // Discount, AccountId — "count" inside a word
const scalarOf = (rows, force = false) => {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const entries = Object.entries(rows[0] || {});
  if (entries.length !== 1) return null;
  const [k, v] = entries[0];
  return (force || (COUNT_COL.test(k) && !NOT_COUNT.test(k))) && Number.isFinite(num(v)) ? num(v) : null;
};
/* The agent column standing for the reference key: the named one when present, else the column
 * whose values cover the most reference keys (at least half). */
function keyColumn(rows, key, refKeys) {
  if (!rows?.length || rows.some(r => pick(r, key) != null)) return key;
  let best = key, bestHit = 0;
  for (const c of Object.keys(rows[0] || {})) {
    const hit = new Set(rows.map(r => String(r[c] ?? '')).filter(v => refKeys.has(v))).size;
    if (hit > bestHit) { best = c; bestHit = hit; }
  }
  return bestHit >= Math.ceil(refKeys.size / 2) ? best : key;
}
/* The agent column standing for the measured field: the named one, else its only other numeric column. */
function fieldColumn(rows, field, keyCol) {
  if (!rows?.length || !field || rows.some(r => pick(r, field) != null)) return field;
  const numeric = Object.keys(rows[0] || {}).filter(c => c.toLowerCase() !== String(keyCol).toLowerCase() && rows.every(r => r[c] == null || Number.isFinite(num(r[c]))));
  return numeric.length === 1 ? numeric[0] : field;
}
const rowSig = r => JSON.stringify(Object.entries(lc(r)).sort(([a], [b]) => a.localeCompare(b)));

/**
 * @param {{rule: string, key?: string, field?: string, tolerance?: number, expect?: object, scalar?: boolean}} check
 * @param {{rows?: object[], stated_count?: number, truncated?: boolean}} agent  the agent's self-report
 * @param {{rows?: object[], error?: string, agent_rows?: object[], before_rows?: object[]}} reference
 */
export function compare(check, agent, reference) {
  const rule = check?.rule;
  if (!rule || !RULES.includes(rule)) return { result: 'not_checked', detail: `no usable check rule (${rule ?? 'none'})` };
  if (rule === 'judge') return { result: 'needs_judgement', detail: 'decided by the answer judge from the answer text' };
  if (!reference || reference.error) return { result: 'not_checked', detail: `the reference query failed: ${reference?.error || 'no result recorded'}` };

  const ref = reference.rows || [];
  /* Which rows stand for the agent's answer. Its final query re-run in full (agent_rows) proves the
   * rows exist; but an agent often queries broadly and filters in its answer ("all my tasks" → "the
   * 6 overdue ones"), and then the re-run overstates the answer. So the agent's own rows count when
   * every one of them is in the re-run — they came from the query, the agent narrowed them — and the
   * re-run counts when the agent reports rows the query does not return (made up), or capped its sample. */
  const own = Array.isArray(agent?.rows) ? agent.rows : [];
  const reran = Array.isArray(reference.agent_rows) ? reference.agent_rows : null;
  const subsetKey = check.key || 'Id';
  const ownInReran = reran && own.length && !agent?.truncated
    && own.every(r => pick(r, subsetKey) != null) && (() => { const k = keyset(reran, subsetKey); return own.every(r => k.has(String(pick(r, subsetKey)))); })();
  const verified = !!reran;
  const got = !reran ? own : ownInReran ? own : reran;
  /* the agent's own sample is capped; a capped sample cannot prove "the same records" */
  const truncated = !verified && agent?.truncated === true;
  const tag = !verified ? ' (from the agent\'s own report)' : ownInReran ? ' (the agent\'s rows, confirmed by re-running its query)' : '';

  if (rule === 'write_visible') {
    const want = check.expect || {};
    if (!Object.keys(want).length) return { result: 'not_checked', detail: 'write_visible needs `expect` — without it any existing row would pass' };
    if (!ref.length) return { result: 'wrong', detail: 'the re-read found no record carrying the change' };
    const shows = rows => (rows || []).filter(r => Object.entries(want).every(([k, v]) => String(pick(r, k)) === String(v)));
    const after = shows(ref);
    if (!after.length) return { result: 'wrong', detail: `the re-read does not show ${Object.entries(want).map(([k, v]) => `${k} = ${v}`).join(', ')}` };
    if (!Array.isArray(reference.before_rows)) return { result: 'partial', detail: 'the change is visible, but no before-snapshot was taken, so it may have been there already' };
    /* "already there" is decided per record when there is a key — a whole-row signature would
     * call a row fresh just because a volatile column (ModifiedAt, Version) moved */
    const sig = check.key ? r => String(pick(r, check.key) ?? rowSig(r)) : rowSig;
    const before = new Set(shows(reference.before_rows).map(sig));
    const fresh = after.filter(r => !before.has(sig(r)));
    if (!fresh.length) return { result: 'wrong', detail: 'the re-read shows the expected values, but they were already there before the agent ran' };
    const did = `${fresh.length} record(s) now show ${Object.entries(want).map(([k, v]) => `${k} = ${v}`).join(', ')} that did not before`;
    /* the right change is not enough: nothing else may have moved (3.5). Records the reference — or
     * the wider check.scope_sql — saw before the agent ran, and that are now gone or different
     * without being the intended change, are side effects. */
    const side = sideEffects(reference.scope_before ?? reference.before_rows, reference.scope_rows ?? ref, check.key, new Set(fresh.map(sig)));
    /* 3.7: the records the agent created or changed, so the report can list what a run left behind */
    const touched = fresh.map(r => String(pick(r, check.key || 'Id') ?? '')).filter(Boolean);
    return side.length
      ? { result: 'partial', detail: `${did}, but ${side.length} other record(s) also changed or disappeared (${side.slice(0, 3).join(', ')})`, side_effects: side, touched }
      : { result: 'correct', detail: `${did}; nothing else changed`, touched };
  }

  if (rule === 'same_count') {
    const expected = scalarOf(ref, check.scalar === true) ?? ref.length;
    const actual = Number.isFinite(agent?.stated_count) ? agent.stated_count : (scalarOf(got, check.scalar === true) ?? got.length);
    if (!expected && !actual) return { result: 'no_test_data', detail: 'the reference found nothing to count' };
    /* a capped sample with no stated total cannot be counted (review 3.7.1) */
    if (truncated && !Number.isFinite(agent?.stated_count)) return { result: 'needs_judgement', detail: `the agent's rows are a capped sample (${got.length}) with no stated total — decided by the answer judge` };
    if (actual === expected) return { result: 'correct', detail: `${actual} of ${expected}` };
    const near = expected && Math.abs(actual - expected) / expected <= 0.1;
    return { result: near ? 'partial' : 'wrong', detail: `agent ${actual}, reference ${expected}` };
  }

  if (!ref.length) {
    /* the account holds nothing — an agent that reported records OF THE SAME KIND anyway invented them
     * (review 3.7.1). Rows it read on the way (tasks, while looking for time entries) are not answers:
     * they count only when they carry most of the columns the reference selects. */
    const refCols = selectedColumns(check.reference_sql).filter(c => c !== String(check.key || 'id').toLowerCase());
    const own0 = got[0] ? lc(got[0]) : null;
    const sameKind = own0 && refCols.length && refCols.filter(c => c in own0).length >= Math.ceil(refCols.length / 2);
    return sameKind ? { result: 'wrong', detail: `the reference found nothing, but the agent reported ${got.length} such record(s)${tag}` }
                    : { result: 'no_test_data', detail: 'the reference query returned no rows' };
  }
  const key = check.key || 'Id';
  const R = keyset(ref, key);
  if (!R.size) return { result: 'not_checked', detail: `the reference rows carry no "${key}" column` };
  /* The agent names its own columns. When its rows lack the reference's key column, the key is the
   * agent column whose values best cover the reference keys (AssigneeName vs Owner, TagName vs
   * Name) — a correct answer must not fail on a column alias. */
  const agentKey = keyColumn(got, key, R);
  /* An answer that is not keyed like the reference (section names where the reference can only key
   * by section id) cannot be compared row by row. It is not wrong for that — the answer judge decides
   * it with the reference rows beside it. */
  if (got.length && got.every(r => pick(r, agentKey) == null))
    return { result: 'needs_judgement', detail: `the answer is not keyed like the reference ("${key}") — decided by the answer judge against the reference rows` };
  const A = keyset(got, agentKey);
  const inter = [...R].filter(x => A.has(x)).length;
  /* not one record lines up with the reference key: the answer is about something else, or keyed
   * another way (task names vs tag names) — the judge decides, the ids cannot (review 3.7.1) */
  /* values_within only: there the agent's rows carry a key column but often of another entity (task
   * names vs tag names); for same_ids a record set with nothing in common is simply the wrong records */
  if (!inter && A.size && rule === 'values_within') return { result: 'needs_judgement', detail: `no record of the answer lines up with the reference ("${key}") — decided by the answer judge against the reference rows` };
  const extra = [...A].filter(x => !R.has(x)).length;

  /* contains: every expected record present proves it, capped sample or not */
  if (rule === 'contains' && inter === R.size) return { result: 'correct', detail: `all ${R.size} expected records present${tag}` };

  if (truncated && rule !== 'contains') {
    /* a capped sample: every record in it must be right, and the stated total must match */
    const total = Number.isFinite(agent?.stated_count) ? agent.stated_count : null;
    if (!extra && total === R.size) return { result: 'correct', detail: `sample of ${A.size} all correct, stated total ${total} matches${tag}` };
    return { result: !extra && total != null && Math.abs(total - R.size) / R.size <= 0.1 ? 'partial' : 'wrong',
             detail: `sample of ${A.size}: ${extra} not in the reference · stated total ${total ?? 'none'} vs ${R.size}${tag}` };
  }

  if (rule === 'contains') {
    if (inter === R.size) return { result: 'correct', detail: `all ${R.size} expected records present${tag}` };
    return { result: inter / R.size >= 0.5 ? 'partial' : 'wrong', detail: `${inter} of ${R.size} expected records present${tag}` };
  }

  const union = new Set([...R, ...A]).size;
  const jac = union ? inter / union : 0;
  if (rule === 'same_ids') {
    if (inter === R.size && A.size === R.size) return { result: 'correct', detail: `same ${R.size} records${tag}` };
    return { result: jac >= 0.5 ? 'partial' : 'wrong', detail: `${inter} shared · answer ${A.size} · reference ${R.size}${tag}` };
  }

  /* values_within */
  const field = check.field, tol = Number(check.tolerance ?? 0);
  if (!field) return { result: 'not_checked', detail: 'values_within needs a field' };
  /* several agent rows per key (a GROUP BY project, completed) cannot be lined up with one reference row per key */
  if (got.length && !got.some(r => pick(r, field) != null) && new Set(got.map(r => String(pick(r, agentKey)))).size < got.length)
    return { result: 'needs_judgement', detail: `the answer's rows are shaped differently from the reference (several per "${key}", no "${field}") — decided by the answer judge` };
  const byKey = new Map(got.map(r => [String(pick(r, agentKey)), r]));
  const agentField = fieldColumn(got, field, agentKey);
  let off = 0, compared = 0;
  for (const r of ref) {
    const x0 = byKey.get(String(pick(r, key)));
    if (!x0) continue;
    compared++;
    const x = num(pick(x0, agentField)), y = num(pick(r, field));
    if (!(Number.isFinite(x) && Number.isFinite(y)) || Math.abs(x - y) > tol * Math.max(1, Math.abs(y))) off++;
  }
  if (compared === R.size && !off && A.size === R.size) return { result: 'correct', detail: `${compared} records, ${field} within ${tol}${tag}` };
  return { result: compared && off / compared <= 0.2 && jac >= 0.5 ? 'partial' : 'wrong',
           detail: `${compared} of ${R.size} matched · ${off} with ${field} out of tolerance${tag}` };
}

/** Records present before that changed or vanished, other than the intended ones. Needs a key: a
 * whole-row comparison without one cannot tell "changed" from "another row". */
export function sideEffects(beforeRows, afterRows, key, intended = new Set()) {
  if (!key || !Array.isArray(beforeRows) || !Array.isArray(afterRows)) return [];
  const id = r => String(pick(r, key) ?? '');
  const now = new Map(afterRows.map(r => [id(r), r]));
  const out = [];
  for (const b of beforeRows) {
    const k = id(b);
    if (!k || intended.has(k)) continue;
    const a = now.get(k);
    if (!a) { out.push(`${k} removed`); continue; }
    /* compare the columns both snapshots carry; volatile ones (ModifiedAt, Version, Etag) are not changes a user would see */
    const B = lc(b), A = lc(a);
    const diff = Object.keys(B).filter(c => !/modified|updated|version|etag|timestamp|synced/i.test(c) && c in A && String(A[c]) !== String(B[c]));
    if (diff.length) out.push(`${k} ${diff.slice(0, 2).join('/')} changed`);
  }
  return out;
}

/* ── after the check: what the outcome means (3.5) ─────────────────────────────
 * A check compares rows; it does not know why there were none. These rules run after it, on the
 * journey, so an honest report of a refusal or of a missing record is not scored as a wrong answer,
 * and a plausible answer over an empty account is not scored as a right one:
 *
 *   blocked_connector  the connector refused the operation itself (not supported, read-only), and
 *                    the agent said so — a connector finding (3.6).
 *   blocked_account  the source refused the decisive call for the test account's plan or rights,
 *                    and the agent told the user so. Claiming success anyway stays wrong — that IS
 *                    the AI's failure.
 *   no_test_data     the record an action had to change did not exist before the run, or the
 *                    records a judged question is about (check.data_sql) are empty: the answer
 *                    cannot be told apart from a blind "nothing there". A wrong answer stays wrong —
 *                    inventing data over an empty account is a real failure.
 *   partial          the change was made, but the agent told the user it was not: the action and
 *                    the answer must both be right. (The reverse — "done" with nothing changed — is
 *                    already wrong by the write check.)
 */
export const SAYS_NOT_DONE = /\b(could ?n[o']t|can ?n[o']t|can't|cannot|won'?t be able|isn'?t possible|not possible|not able to|unable to|was ?n[o']t able|were ?n[o']t able|did ?n[o']t|(?:do|does) not have (?:access|permission|the rights|premium)|no (?:access|permission)|not (?:permitted|allowed|enabled)|made no changes?|no changes? (was|were) made|nothing (was|has been) (created|changed|logged|updated|written|saved)|n[o']t (created|logged|changed|updated|saved|added|removed|deleted)|rejected|refused|failed|not available|there (is|are|was|were) no|found no|nothing to (change|remove|update|correct|trim|reduce|extend|delete))\b/i;
/* narrower, for an action that DID change the right record: only a plain "it was not done" counts */
/* the failure must be about the change itself: "I could not run a follow-up read to confirm it" after a
 * successful update is not "it was not done" (asn-eval1 re-check: two archives were wrongly downgraded) */
const SAYS_FAILED = /\b(?:(?:could ?n[o']t|unable to|was ?n[o']t able to|were ?n[o']t able to|did ?n[o']t) (?:log|create|change|update|add|save|make|record|remove|delete|archive|mark|complete|move|assign|reassign|set|rename|pin|post|close)|made no changes?|nothing was (?:created|changed|logged|updated|saved)|(?:change|update|insert|request|write) (?:was|were) (?:rejected|refused))\b/i;
/* a clarifying question is not a claim either way */
const ASKS = /\?\s*$|\b(please (tell|confirm|let me know)|which (one|task|project|entry|record) (do|did) you mean|could you (tell|confirm)|(tell|let) me (which|what|whether|if|know which)|which .{0,40}\b(do|did|should) (you|i)\b)\b/i;
/* 3.6 — a yes/no question ("Is the SSO fix still flagged as blocked?") is answered in words. A rule
 * that compares record ids cannot decide it: in asn-eval1 two models answered "Yes, still tagged
 * Blocked" correctly and were marked wrong because they returned the task, not the tag row. Such a
 * result goes to the answer judge with the reference rows beside it. */
const YES_NO = /^\s*(?:(?:hey|hi|ok|okay|quick question|so)[,:]?\s+)?(is|are|was|were|does|do|did|has|have|had|can|could|will|would|should)\b[^?]*\?\s*$/i;
/* "Can you list the overdue tasks?" is a polite request for rows, not a yes/no question */
const POLITE_REQUEST = /^\s*(?:(?:hey|hi|ok|okay|so)[,:]?\s+)?(can|could|would|will)\s+(you|we|i)\s+(please\s+)?(list|show|give|pull|get|find|send|tell me (which|what|who|how)|share|export|summari[sz]e|break down|count)\b|\b(which|what|who|how many|how much)\b/i;
export const isYesNo = (request, expected = []) => (YES_NO.test(String(request || '')) && !POLITE_REQUEST.test(String(request || '')))
  || (expected || []).some(e => /\byes or no\b|\byes\/no\b/i.test(String(e)));
/* rules that decide by comparing record ids */
export const ID_RULES = new Set(['same_ids', 'contains', 'values_within']);

/** Did the answer put a question back to the user? (3.7: a scripted second turn follows if so) */
export const asksUser = answer => ASKS.test(String(answer || '').trim());

/* these use cases are about the request, not the data: an empty account does not empty them */
const NO_DATA_SKILLS = new Set(['ambiguity', 'missing_info']);

/**
 * @param {{outcome: string, detail: string}} r   the check's (or the judge's) result
 * @param {{steps?: object[], answer?: string}} j  the normalised journey
 * @param {{kind?: string, check?: object, tests?: string[], modifiesExisting?: boolean}} uc
 * @param {{before_rows?: object[], data_rows?: object[]}} ref  the check file
 * @returns {{outcome: string, detail: string}}
 */
export function refineOutcome(r, j, uc = {}, ref = {}) {
  const steps = j?.steps || [];
  const answer = String(j?.answer || '');
  const writesDone = steps.some(s => s.category === 'write' && s.ok);
  const notDone = SAYS_NOT_DONE.test(answer);
  const judged = uc.check?.rule === 'judge';

  /* 1 · the account refused, and nothing was written around it */
  const refusal = steps.find(s => !s.ok && s.cause === 'account' && !s.recovered && ['write', 'query', 'procedure'].includes(s.category));
  if (refusal && !writesDone && (r.outcome !== 'correct' || judged)) {
    const why = String(refusal.error || '').replace(/^STMT\s+(HTTP\s+)?/i, '').slice(0, 220);
    if (uc.kind === 'action' && !notDone) return { outcome: 'wrong', detail: `the source refused the change (${why}), but the agent did not tell the user it was not made` };
    return { outcome: 'blocked_account', detail: `the source refused it for the test account's plan or rights — ${why}` };
  }

  /* 1b · the connector refused the operation itself (read-only column, operation not offered) and the
   * agent said so — a connector finding, not an AI mistake (asn-eval1: rename a tag, set a team's
   * description). Timeouts and an unresponsive server are not refusals: an agent can often work round
   * them (narrow the read), so those stay with the AI's result, charged to the connector. */
  const refused = steps.find(s => !s.ok && s.cause === 'connector' && s.error_class === 'unsupported_operation' && !s.recovered);
  if (refused && !writesDone && r.outcome !== 'correct') {
    const why = String(refused.error || '').replace(/^STMT\s+(STMT\s+|DATA_SOURCE\s+)?/i, '').slice(0, 220);
    if (!notDone) return { outcome: 'wrong', detail: `the connector refused it (${why}), but the agent did not tell the user` };
    return { outcome: 'blocked_connector', detail: `the connector refused the operation — ${why}` };
  }

  /* 1c · the connector never answered: every acting call failed on the connector, nothing came back,
   * and the reference is empty too — a connector outage, not missing data (asn-tr1: 15 attempts). */
  const acting = steps.filter(s => ['query', 'write', 'procedure'].includes(s.category));
  if (r.outcome === 'no_test_data' && acting.length && acting.every(s => !s.ok && s.cause === 'connector'))
    return { outcome: 'blocked_connector', detail: `the connector did not answer any query (${acting[0].error_class || 'error'}: ${String(acting[0].error || '').slice(0, 160)})` };

  /* 2 · the record the action changes was not there */
  const target = Array.isArray(ref.data_rows) ? ref.data_rows : uc.modifiesExisting ? ref.before_rows : null;
  if (uc.kind === 'action' && Array.isArray(target) && !target.length && !writesDone && (notDone || ASKS.test(answer)))
    return { outcome: 'no_test_data', detail: 'the record this action changes did not exist before the run, so the change itself was never tested (the agent said so)' };

  /* 3 · a judged question over no data */
  if (uc.kind !== 'action' && judged && Array.isArray(ref.data_rows) && !ref.data_rows.length
      && ['correct', 'partial'].includes(r.outcome) && !(uc.tests || []).some(t => NO_DATA_SKILLS.has(t)))
    return { outcome: 'no_test_data', detail: 'the records this question is about are empty in the test account, so the answer cannot be told apart from a blind "nothing there"' };

  /* 4 · the action was right, the answer said otherwise */
  if (r.outcome === 'correct' && uc.kind === 'action' && writesDone && SAYS_FAILED.test(answer) && uc.check?.rule === 'write_visible')
    return { outcome: 'partial', detail: `${r.detail} — but the agent told the user it was not done` };
  return r;
}

/** The column names a SELECT returns (lower case, aliases honoured); [] for SELECT * or no SQL. */
export function selectedColumns(sql) {
  const list = /^\s*SELECT\s+(?:DISTINCT\s+|TOP\s+\d+\s+)?([\s\S]*?)\s+FROM\b/i.exec(String(sql || ''))?.[1];
  if (!list || /^\s*\*\s*$/.test(list)) return [];
  return list.split(',').map(c => {
    const alias = /\bAS\s+\[?([A-Za-z0-9_]+)\]?\s*$/i.exec(c)?.[1];
    if (alias) return alias.toLowerCase();
    const m = /\[?([A-Za-z0-9_]+)\]?\s*$/.exec(c.trim());
    return m ? m[1].toLowerCase() : '';
  }).filter(Boolean);
}

/* ── run-time SQL ──────────────────────────────────────────────────────────── */
/* Reference, before, locate and cleanup statements are written once, in the catalog, and must
 * stay right on any day and any account: `{{today}}`, `{{today-7}}`, `{{today+30}}`,
 * `{{me}}` (the connection's own user), `{{workspace}}` (the test workspace, 3.7), and `{{located}}` (the ids `locate_sql` returned after
 * the agent ran, quoted and comma-separated) are filled in when the check runs. */
export function fillSql(sql, ctx = {}) {
  if (!sql) return sql;
  const base = ctx.today ? new Date(ctx.today) : new Date();
  const day = n => new Date(base.getTime() + n * 864e5).toISOString().slice(0, 10);
  return String(sql)
    .replace(/\{\{today([+-]\d+)?\}\}/g, (_, d) => day(Number(d || 0)))
    .replace(/\{\{me\}\}/g, String(ctx.me ?? '').replace(/'/g, "''"))
    .replace(/\{\{workspace\}\}/g, String(ctx.workspace ?? '').replace(/'/g, "''"))
    .replace(/\{\{located\}\}/g, () => (ctx.located || []).map(v => `'${String(v).replace(/'/g, "''")}'`).join(',') || "''");
}

/* A cleanup statement runs unattended on every attempt of every model, so it is held to a
 * narrow shape: one UPDATE or DELETE, on a table the use case touches, with a WHERE clause that
 * pins rows by equality or IN. Returns the problems; empty means acceptable. */
export function cleanupProblems(sql, tables = []) {
  const s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) return [];
  const out = [];
  if (/;/.test(s)) out.push('more than one statement');
  const m = /^(UPDATE|DELETE\s+FROM)\s+(?:(?:\[[^\]]+\]|[A-Za-z0-9_]+)\.)*\[?([A-Za-z0-9_]+)\]?/i.exec(s);
  if (!m) { out.push('not a single UPDATE or DELETE'); return out; }
  if (tables.length && !tables.map(t => t.toLowerCase()).includes(m[2].toLowerCase())) out.push(`writes to ${m[2]}, which this use case does not touch`);
  const where = /\bWHERE\b([\s\S]+)$/i.exec(s);
  if (!where) out.push('no WHERE clause — it would change every row');
  else if (!/((?<![<>!=])=(?!=)|\bIN\s*\()/i.test(where[1])) out.push('the WHERE clause does not pin rows by = or IN');
  /* OR, NOT and IS [NOT] NULL are never needed to pin a test's own records, and any of them can
   * widen "this row" into "every row" */
  else if (/(!=|<>|>=|<=|\bNOT\b|\bOR\b|\bIS\s+(NOT\s+)?NULL\b|\bLIKE\b|(?<![<>!=])[<>](?![=>]))/i.test(where[1])) out.push('the WHERE clause uses a range, negation, OR or pattern — pin rows by = or IN, joined by AND');
  else if (/\b(1\s*=\s*1|OR\s+1\s*=)/i.test(where[1])) out.push('the WHERE clause matches everything');
  return out;
}
