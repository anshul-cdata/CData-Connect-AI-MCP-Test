/* scoring.mjs — one number per journey, computed the same way for every connector and model.
 *
 *   correctness  (default 50) correct 1 · partial ½ · wrong 0
 *   efficiency   (default 20) the shortest known path ÷ the calls this journey made, capped at 1
 *   robustness   (default 15) 1 − ¼ per dead end − ⅛ per recovered failure − 1/10 per repeated call
 *   speed & cost (default 15) the run's norm for this kind of task ÷ this journey's time and tokens
 *
 * The business outcome comes first (3.2). Efficiency, robustness and speed are earned only in
 * proportion to the answer: in full for a correct one, half for a partial one, nothing for a wrong
 * one — so a wrong answer scores 0 and a cheap wrong answer can never outrank a slow right one.
 *
 * Absolute and relative parts: correctness is absolute (the answer is checked against a reference
 * or by the judge). Efficiency and speed are relative — the shortest path any compared model found
 * and the median time and tokens of the correct journeys being compared — so adding a model to an
 * eval can move another model's score by a few points. The headline the reports lead with is the
 * correct rate, which no other model can move.
 *
 * A part with no data (no timing, no token count) is left out and the rest are rescaled, so a
 * missing measurement never reads as a bad one. Grades follow the outcome: a wrong answer is red,
 * a partial one yellow, a correct one blue at 85 or more and yellow (worked, with friction) below.
 *
 * Scores are recomputed from stored journeys, so changing the weights needs no new run.
 */

export const DEFAULT_WEIGHTS = { correctness: 50, efficiency: 20, robustness: 15, speed: 15 };
export const DEFAULT_GRADES = { blue: 85, yellow: 60 };

const CORRECT = { correct: 1, partial: 0.5, wrong: 0 };
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

/**
 * @param {object} j        normalised journey (lib/journey.mjs)
 * @param {string} outcome  correct | partial | wrong | no_test_data | blocked_account | needs_judgement | not_checked | not_possible
 * @param {{shortest?: number, norm_ms?: number, norm_tokens?: number}} ctx
 */
export function scoreJourney(j, outcome, ctx = {}, cfg = {}) {
  const W = { ...DEFAULT_WEIGHTS, ...(cfg.weights || {}) };
  const Gr = { ...DEFAULT_GRADES, ...(cfg.grades || {}) };
  if (!(outcome in CORRECT)) return { score: null, grade: 'none', parts: {}, reason: outcome };

  const m = j.metrics;
  const parts = {};
  parts.correctness = CORRECT[outcome];
  /* Efficiency is measured on query, procedure and write calls: looking up a table's columns is
   * part of doing the job, not waste. Failed discovery still costs, through robustness. */
  const acting = Number.isFinite(m.acting_calls) ? m.acting_calls : m.calls;
  const shortest = Math.max(1, Number(ctx.shortest) || 1);
  /* a right answer with no query at all — asking which project was meant, or saying the source cannot
   * do it — is as short as a path gets */
  parts.efficiency = acting ? clamp(shortest / acting) : (CORRECT[outcome] > 0 ? 1 : 0);
  parts.robustness = clamp(1 - 0.25 * m.dead_ends - 0.125 * m.recoveries - 0.1 * m.repeated - (m.gave_up ? 0.5 : 0));
  /* the answer gates everything else: a wrong answer earns no efficiency, robustness or speed */
  const gate = CORRECT[outcome];
  const sp = [];
  if (m.time_ms && ctx.norm_ms) sp.push(clamp(ctx.norm_ms / m.time_ms));
  if (m.tokens && ctx.norm_tokens) sp.push(clamp(ctx.norm_tokens / m.tokens));
  parts.speed = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : null;

  let got = 0, max = 0;
  for (const k of ['efficiency', 'robustness', 'speed']) if (parts[k] != null) parts[k] *= gate;
  for (const [k, w] of Object.entries(W)) {
    if (parts[k] == null) continue;
    got += parts[k] * w; max += w;
  }
  const score = Math.round(max ? (got / max) * 100 : 0);
  const grade = outcome === 'wrong' ? 'red' : outcome === 'partial' ? 'yellow' : score >= Gr.blue ? 'blue' : 'yellow';
  return { score, grade, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v == null ? null : Math.round(v * W[k] * 10) / 10])) };
}

/** Median of the finite values, for the run's per-kind norms. */
export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Re-score stored records against a shared context, so that scores from different runs — and
 * different models — measure the same thing. Ingest scores a run against what was known then;
 * a report or an eval re-scores every record it shows here, with the shortest known path and
 * the speed norms computed across ALL the records being compared (and any extra history), so a
 * later, faster model cannot leave an earlier run's scores inflated by run-local baselines.
 *
 * @param {object[]} records   the records to re-score (mutated copies are returned)
 * @param {{pool?: object[], minCalls?: Map<string, number>}} ctx  pool = every record to learn from
 */
export function rescore(records, ctx = {}, cfg = {}) {
  /* deduplicated: a caller may pass a pool that already holds these records (an eval passes every
   * compared run, its own included), and a duplicate would pull the medians toward this run */
  const id = r => `${r.run_id}|${r.tc_id}|${r.variant || 0}|${r.attempt || 1}`;
  const seen = new Set();
  const pool = [...records, ...(ctx.pool || [])].filter(r => r.metrics && !seen.has(id(r)) && seen.add(id(r)));
  const keyOf = r => r.use_case_id || r.tc_id;
  const acting = r => Number.isFinite(r.metrics?.acting_calls) ? r.metrics.acting_calls : r.metrics?.calls;
  const best = new Map();
  /* an attempt that only asked a question (no acting call) is not a path to the answer */
  for (const r of pool) if (r.outcome === 'correct' && Number.isFinite(acting(r)) && acting(r) > 0) {
    const k = keyOf(r); best.set(k, Math.min(best.get(k) ?? Infinity, acting(r)));
  }
  const norms = {};
  for (const kind of new Set(pool.map(r => r.kind))) {
    const ok = pool.filter(r => r.kind === kind && r.outcome === 'correct');
    norms[kind] = { ms: median(ok.map(r => r.metrics.time_ms)), tokens: median(ok.map(r => r.metrics.tokens)) };
  }
  return records.map(r => {
    if (!r.metrics) return r;
    const k = keyOf(r);
    const s = Math.min(ctx.minCalls?.get(r.use_case_id) ?? Infinity, best.get(k) ?? Infinity);
    const sc = scoreJourney({ metrics: r.metrics }, r.outcome, {
      shortest: Number.isFinite(s) ? s : undefined, norm_ms: norms[r.kind]?.ms, norm_tokens: norms[r.kind]?.tokens,
    }, cfg);
    return { ...r, score: sc.score, grade: sc.grade, parts: sc.parts };
  });
}
