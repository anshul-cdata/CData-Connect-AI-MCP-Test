/* eval-analysis.mjs — what an eval means, computed from the stored journeys of every model.
 *
 * The eval report used to lead with one blended score. A score hides why models differ, rewards a
 * cheap wrong answer, and crowns a winner on a one-use-case margin. This module answers, in order:
 *   1. who gets the business task right (correct rate — absolute, no other model can move it),
 *   2. whether the difference is real (paired test on the same use cases),
 *   3. where each model is strong and weak (by difficulty, skill, pattern, area, persona),
 *   4. how they behave over MCP (discovery, wrong guesses, recovery, efficiency),
 *   5. what is the connector's, the metadata's, the account's or the harness's — and what is the model's.
 * Everything is arithmetic over stored records: no model writes any of it, so it cannot flatter one.
 */
import { CLASS_LABEL, CAUSE_LABEL, PATTERN_LABEL, firstTry } from './report-data.mjs';

const DECIDED = new Set(['correct', 'partial', 'wrong', 'not_possible']);
/* A use case the planner marked "not possible" before any agent ran — a capability it needs is not
 * exposed by the connector — measures the connector, not the models: every model gets the same
 * non-answer. It leaves the model comparison and is reported as a connector limitation. */
/* 3.6: a limitation probe ran, but measured the agent's honesty, not the task — it stays out of task
 * success and is reported as limitation handling */
export const notAttempted = u => !!u && u.outcome === 'not_possible' && (!(u.steps || []).length || !!u.probe);
const r0 = x => x == null || !Number.isFinite(x) ? null : Math.round(x);
const r1 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
const avg = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pctOf = (k, n) => n ? r0(100 * k / n) : null;
/* below this many use cases a rate is shown but never used to call a winner */
export const MIN_N = 5;

export const DIFFICULTY_LABEL = { simple: 'Simple', medium: 'Medium', complex: 'Complex' };
export const SKILL_LABEL = { filters: 'Filters and conditions', dates: 'Dates and relative dates', aggregation: 'Sorting, grouping, totals',
  relationships: 'Links between objects', multi_step: 'Several dependent steps', write: 'Changes data', ambiguity: 'Ambiguous request',
  missing_info: 'Missing information', limitation: 'Not possible — must say so' };
export const KIND_LABEL = { question: 'Questions (read)', action: 'Actions (write)', job: 'Jobs (read, decide, act)' };
const INTERACTION = { table_not_found: 'wrong_object', column_not_found: 'wrong_field', required_filter: 'missing_filter',
  syntax_error: 'bad_sql', unsupported_function: 'bad_sql', catalog_not_found: 'wrong_object', schema_not_found: 'wrong_object' };

/* ── statistics ────────────────────────────────────────────────────────────── */
function binomTwoSided(k, n) {
  if (!n) return 1;
  const lo = Math.min(k, n - k);
  let p = 0, c = 1;                                            // C(n,0)
  for (let i = 0; i <= lo; i++) { if (i > 0) c = c * (n - i + 1) / i; p += c; }
  return Math.min(1, 2 * p / 2 ** n);
}
/**
 * Is model A really more often right than B on the same use cases? McNemar's exact test on the
 * use cases where exactly one of them was right, with a 95% interval on the difference in correct
 * rate. Paired, because both answered the same requests: the use cases both get right or both get
 * wrong say nothing about which is better.
 */
export function pairedTest(aOk, bOk) {
  const n = aOk.length;
  let aOnly = 0, bOnly = 0;
  for (let i = 0; i < n; i++) { if (aOk[i] && !bOk[i]) aOnly++; else if (bOk[i] && !aOk[i]) bOnly++; }
  const d = n ? (aOnly - bOnly) / n : 0;
  const se = n ? Math.sqrt(Math.max(0, aOnly + bOnly - (aOnly - bOnly) ** 2 / n)) / n : 0;
  const p = binomTwoSided(Math.min(aOnly, bOnly), aOnly + bOnly);
  return { n, a_only: aOnly, b_only: bOnly, diff_pts: r1(100 * d), ci: [r1(100 * (d - 1.96 * se)), r1(100 * (d + 1.96 * se))], p: Math.round(p * 1000) / 1000 };
}

/* ── per use case ──────────────────────────────────────────────────────────── */
/** Agreement across models on one use case, from the models whose result was decided. */
export function agreementOf(cells, names) {
  if (names.every(m => cells[m]?.verdict === 'not_applicable')) return { kind: 'not_applicable', who: null };
  if (names.every(m => cells[m]?.outcome === 'blocked')) return { kind: 'connector_blocked', who: null };
  const dec = names.filter(m => cells[m] && DECIDED.has(cells[m].outcome));
  if (dec.length < names.length) return { kind: 'not_measured', who: null };
  const ok = dec.filter(m => cells[m].outcome === 'correct');
  if (ok.length === dec.length) {
    const sc = dec.map(m => cells[m].score).filter(Number.isFinite);
    return { kind: sc.length && Math.max(...sc) - Math.min(...sc) >= 25 ? 'all_correct_friction' : 'all_correct', who: null };
  }
  if (!ok.length) return { kind: 'all_failed', who: null };
  if (ok.length === 1) return { kind: 'unique_win', who: ok[0] };
  if (ok.length === dec.length - 1) return { kind: 'unique_failure', who: dec.find(m => cells[m].outcome !== 'correct') };
  return { kind: 'split', who: null };
}
export const AGREEMENT_LABEL = { all_correct: 'All models correct', all_correct_friction: 'All correct, very different effort',
  unique_win: 'Only one model correct', unique_failure: 'Only one model incorrect', split: 'Models split', all_failed: 'Incorrect on every model', connector_blocked: 'Not supported through ConnectAI MCP — no model was asked',
  not_applicable: 'Not applicable: it exists only in the source app, so no model was asked',
  not_measured: 'Not measured on every model' };

/**
 * How well a use case tells models apart — measured, not predicted. High: models reach different
 * outcomes. Medium: same outcome, but very different effort, or a model that is right on one
 * attempt and wrong on another. Low: every model ends the same way at much the same cost.
 */
export function discriminationOf(cells, names) {
  const dec = names.filter(m => cells[m] && DECIDED.has(cells[m].outcome));
  if (dec.length < 2) return null;
  if (new Set(dec.map(m => cells[m].outcome === 'correct')).size > 1) return 'high';
  const sc = dec.map(m => cells[m].score).filter(Number.isFinite);
  const flaky = dec.some(m => cells[m].pass_rate != null && cells[m].pass_rate > 0 && cells[m].pass_rate < 1);
  return (sc.length > 1 && Math.max(...sc) - Math.min(...sc) >= 25) || flaky ? 'medium' : 'low';
}

/** Why one model's journey ended the way it did, in behavioural terms — from its calls, not its score. */
export function behaviourOf(u) {
  if (!u) return [];
  const m = u.metrics || {};
  const out = [];
  const fails = (u.steps || []).filter(s => !s.ok);
  const byClass = new Map();
  for (const s of fails) byClass.set(s.error_class || 'unclassified', (byClass.get(s.error_class || 'unclassified') || 0) + 1);
  if (u.outcome === 'wrong' && !fails.length) out.push('every call worked, but it answered a different question than the one asked');
  for (const [k, n] of byClass) {
    const rec = fails.filter(s => (s.error_class || 'unclassified') === k && s.recovered).length;
    out.push(`${(CLASS_LABEL[k] || k).toLowerCase()}${n > 1 ? ` ×${n}` : ''}${rec === n ? ' — recovered' : rec ? ` — ${rec} recovered` : ' — not recovered'}`);
  }
  if (m.acting_calls === 0) out.push(u.outcome === 'correct' ? 'answered without querying (asked, or explained a limit)' : 'never queried the data');
  if (m.gave_up) out.push('gave up');
  if (Number.isFinite(m.discovery_calls) && m.discovery_calls >= 6) out.push(`${m.discovery_calls} discovery calls`);
  if (Number.isFinite(m.repeated) && m.repeated >= 2) out.push(`${m.repeated} repeated calls`);
  if (u.outcome !== 'correct' && u.check?.detail) out.push(`check: ${u.check.detail}`);
  return out;
}

/* ── per model ─────────────────────────────────────────────────────────────── */
function modelStats(model, ucs) {
  const dec = ucs.filter(u => DECIDED.has(u.outcome));
  const n = dec.length;
  const cnt = o => dec.filter(u => u.outcome === o).length;
  const correct = dec.filter(u => u.outcome === 'correct');
  const wrong = dec.filter(u => u.outcome === 'wrong');
  const steps = ucs.flatMap(u => u.steps || []);
  const failedCalls = steps.filter(s => !s.ok && s.cause !== 'harness');
  const inter = { wrong_object: 0, wrong_field: 0, missing_filter: 0, bad_sql: 0 };
  for (const s of failedCalls) { const k = INTERACTION[s.error_class]; if (k) inter[k]++; }
  const per100 = x => n ? r1(100 * x / n) : null;
  const tok = correct.map(u => u.metrics?.tokens).filter(Number.isFinite);
  const allTok = dec.reduce((a, u) => a + (u.metrics?.tokens || 0), 0);
  return {
    model, n, correct: cnt('correct'), partial: cnt('partial'), wrong: cnt('wrong'), not_possible: cnt('not_possible'),
    not_measured: ucs.filter(u => !DECIDED.has(u.outcome) && u.outcome !== 'blocked').length, blocked: ucs.filter(u => u.outcome === 'blocked').length,
    /* the same verdicts the capability report counts, so the two reports agree */
    verdicts: ucs.reduce((v, u) => { const k = u.verdict || 'not_measured'; v[k] = (v[k] || 0) + 1; return v; }, {}), correct_pct: pctOf(cnt('correct'), n),
    first_try_pct: pctOf(dec.filter(firstTry).length, n),
    silent_wrong_pct: pctOf(wrong.filter(u => !(u.steps || []).some(s => !s.ok)).length, wrong.length),
    interaction: { ...Object.fromEntries(Object.entries(inter).map(([k, v]) => [k, per100(v)])),
      discovery: r1(avg(dec.map(u => u.metrics?.discovery_calls))), acting: r1(avg(dec.map(u => u.metrics?.acting_calls))),
      repeated: r1(avg(dec.map(u => u.metrics?.repeated))),
      instructions_first: pctOf(dec.filter(u => (u.steps || [])[0]?.tool === 'getInstructions').length, n) },
    recovery: { failed_calls: failedCalls.length, recovered_pct: pctOf(failedCalls.filter(s => s.recovered).length, failedCalls.length),
      dead_ends: r1(avg(dec.map(u => u.metrics?.dead_ends))), gave_up: dec.filter(u => u.metrics?.gave_up).length },
    efficiency: { calls: r1(avg(dec.map(u => u.metrics?.calls))), calls_correct: r1(avg(correct.map(u => u.metrics?.calls))),
      time_s: r0(avg(dec.map(u => (u.metrics?.time_ms ?? NaN) / 1000))), tokens: r0(avg(dec.map(u => u.metrics?.tokens))),
      tokens_per_correct: correct.length && allTok ? r0(allTok / correct.length) : null, tokens_correct: r0(avg(tok)) },
    score: r0(avg(dec.map(u => u.score))),
    /* 3.7 — the second judge on this model's judged answers */
    judges: (() => { const j = ucs.map(u => u.second_judge).filter(Boolean); return { n: j.length, agree: j.filter(x => x.agree).length }; })(),
    /* 3.7 — an unclear request with a scripted reply: asked, then finished the job */
    clarify: (() => { const c = ucs.filter(u => u.clarify);
      return { n: c.length, finished: c.filter(u => u.outcome === 'correct').length, finished_pct: pctOf(c.filter(u => u.outcome === 'correct').length, c.length) }; })(),
    /* 3.6 — asked for something ConnectAI MCP cannot do: said so plainly, or invented an answer */
    limitation: (() => { const p = ucs.filter(u => ['correct', 'partial', 'wrong'].includes(u.probe?.outcome));
      return { n: p.length, correct: p.filter(u => u.probe.outcome === 'correct').length, wrong: p.filter(u => u.probe.outcome === 'wrong').length,
               correct_pct: pctOf(p.filter(u => u.probe.outcome === 'correct').length, p.length) }; })(),
  };
}

/* ── the eval ──────────────────────────────────────────────────────────────── */
const DIMS = {
  difficulty: { label: 'Difficulty', of: u => u.difficulty ? [u.difficulty] : [], name: k => DIFFICULTY_LABEL[k] || k, order: ['simple', 'medium', 'complex'] },
  skill: { label: 'Skill tested', of: u => u.tests || [], name: k => SKILL_LABEL[k] || k, order: Object.keys(SKILL_LABEL) },
  pattern: { label: 'Interaction pattern', of: u => u.pattern ? [u.pattern] : [], name: k => PATTERN_LABEL[k] || k, order: ['retrieve', 'filter', 'cross_object', 'aggregate', 'multi_step', 'act', 'read_decide_act', 'clarify', 'limitation', 'bulk_read'] },
  area: { label: 'Business area', of: u => u.area ? [u.area] : [], name: k => k },
  persona: { label: 'Persona', of: u => u.persona ? [u.persona] : [], name: k => k },
  kind: { label: 'Task type', of: u => u.kind ? [u.kind] : [], name: k => KIND_LABEL[k] || k, order: ['question', 'action', 'job'] },
};

/**
 * @param {{model: string, data: object}[]} models  one capability-report dataset per model
 * @param {{fixed?: object, fixList?: object[]}} ctx
 */
export function analyseEval(models, ctx = {}) {
  const names = models.map(m => m.model);
  const byModel = new Map(models.map(m => [m.model, new Map(m.data.use_cases.map(u => [u.id, notAttempted(u) ? { ...u, outcome: 'blocked', result: 'Not supported — not run' } : u]))]));
  const ids = [...new Set(models.flatMap(m => m.data.use_cases.map(u => u.id)))];
  const meta = id => models.map(m => byModel.get(m.model).get(id)).find(Boolean);
  const cell = (m, id) => byModel.get(m).get(id) || null;

  /* per use case: agreement, measured discrimination, behaviour */
  const cases = ids.map(id => {
    const u = meta(id);
    const cells = Object.fromEntries(names.map(m => [m, cell(m, id)]));
    const ag = agreementOf(cells, names);
    return { id, request: u.request, area: u.area, persona: u.persona, kind: u.kind, difficulty: u.difficulty, tests: u.tests, pattern: u.pattern,
      /* 3.9 — the evidence pill, sort and filter of the use case grid */
      evidence: u.evidence || null, source: u.source ? { kind: u.source.kind || null, title: u.source.title || null, url: u.source.url || null } : null,
      agreement: ag.kind, who: ag.who, discrimination: discriminationOf(cells, names), ...bestWorst(cells, names),
      behaviour: Object.fromEntries(names.map(m => [m, behaviourOf(cells[m])])),
      cells: Object.fromEntries(names.map(m => { const c = cells[m]; return [m, c ? { outcome: c.outcome, verdict: c.verdict ?? null, result: c.result, score: c.score, grade: c.grade, first_try: c.first_try,
        calls: c.metrics?.calls ?? null, failed: c.metrics?.failed ?? null, pass_rate: c.pass_rate ?? null } : null]; })) };
  });

  const stats = names.map(m => modelStats(m, [...byModel.get(m).values()]));
  const S = new Map(stats.map(s => [s.model, s]));

  /* pairwise: on the use cases both models decided */
  const pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const [A, B] = [names[i], names[j]];
    const both = ids.filter(id => DECIDED.has(cell(A, id)?.outcome) && DECIDED.has(cell(B, id)?.outcome));
    const t = pairedTest(both.map(id => cell(A, id).outcome === 'correct'), both.map(id => cell(B, id).outcome === 'correct'));
    const lead = t.a_only === t.b_only ? null : t.a_only > t.b_only ? A : B;
    pairs.push({ a: A, b: B, ...t, lead, significant: t.p < 0.05,
      verdict: !lead ? `${A} and ${B} are level` : t.p < 0.05 ? `${lead} is more often right (${Math.abs(t.diff_pts)} points, p = ${t.p})`
        : `${A} and ${B} cannot be told apart on these use cases (p = ${t.p})` });
  }

  /* matrices: correct rate and average score per model, for every value of every dimension */
  const matrices = Object.fromEntries(Object.entries(DIMS).map(([key, D]) => {
    const vals = [...new Set(cases.flatMap(c => D.of(c)))];
    const ordered = D.order ? [...D.order.filter(v => vals.includes(v)), ...vals.filter(v => !D.order.includes(v))] : vals.sort();
    const rows = ordered.map(v => {
      const mine = cases.filter(c => D.of(c).includes(v));
      const cellsBy = Object.fromEntries(names.map(m => {
        const dec = mine.map(c => cell(m, c.id)).filter(u => u && DECIDED.has(u.outcome));
        const ok = dec.filter(u => u.outcome === 'correct').length;
        return [m, { n: dec.length, correct: ok, correct_pct: pctOf(ok, dec.length), score: r0(avg(dec.map(u => u.score))) }];
      }));
      const rates = names.map(m => cellsBy[m].correct_pct).filter(x => x != null);
      return { key: v, label: D.name(v), n: mine.length, cells: cellsBy, spread: rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : 0,
        /* a winner only where every model was asked enough of these use cases */
        asked: Math.min(...names.map(m => cellsBy[m].n)),
        best: rates.length && Math.min(...names.map(m => cellsBy[m].n)) >= MIN_N ? names.filter(m => cellsBy[m].correct_pct === Math.max(...rates)) : [] };
    });
    return [key, { label: D.label, rows, tagged: cases.filter(c => D.of(c).length).length }];
  }));

  const agreement = Object.fromEntries(Object.keys(AGREEMENT_LABEL).map(k => [k, cases.filter(c => c.agreement === k).length]));
  const unique = Object.fromEntries(names.map(m => [m, {
    wins: cases.filter(c => c.agreement === 'unique_win' && c.who === m).map(c => ({ id: c.id, request: c.request, others: names.filter(x => x !== m).map(x => `${x}: ${c.cells[x]?.result || '—'}`).join(' · '), behaviour: names.filter(x => x !== m).map(x => `${x}: ${(c.behaviour[x] || []).slice(0, 2).join('; ') || '—'}`).join(' · ') })),
    failures: cases.filter(c => c.agreement === 'unique_failure' && c.who === m).map(c => ({ id: c.id, request: c.request, result: c.cells[m]?.result, behaviour: (c.behaviour[m] || []).join('; ') || '—' })),
  }]));
  /* cases where the models differ, most telling first: different outcomes before different effort,
   * harder work before easier, then the widest score gap */
  const DIFF_RANK = { complex: 3, medium: 2, simple: 1 };
  const differ = cases.filter(c => c.discrimination === 'high' || c.discrimination === 'medium')
    .sort((a, b) => (a.discrimination === 'high' ? 0 : 1) - (b.discrimination === 'high' ? 0 : 1)
      || (DIFF_RANK[b.difficulty] || 0) - (DIFF_RANK[a.difficulty] || 0) || (b.gap || 0) - (a.gap || 0))
    .map(c => c.id);

  /* what the benchmark is made of, so a reader can weigh every rate */
  const has = t => cases.filter(c => (c.tests || []).includes(t)).length;
  const coverage = {
    total: cases.length,
    comparable: cases.filter(c => names.every(m => DECIDED.has(c.cells[m]?.outcome))).length,
    blocked: cases.filter(c => c.agreement === 'connector_blocked').length,
    not_applicable: cases.filter(c => c.agreement === 'not_applicable').length,
    not_measured: cases.filter(c => c.agreement === 'not_measured').length,
    simple: cases.filter(c => c.difficulty === 'simple').length, medium: cases.filter(c => c.difficulty === 'medium').length,
    complex: cases.filter(c => c.difficulty === 'complex').length, untagged: cases.filter(c => !c.difficulty).length,
    writes: has('write'), reads: cases.filter(c => Array.isArray(c.tests) && !c.tests.includes('write')).length,
    ambiguity: has('ambiguity'), missing_info: has('missing_info'), limitation: has('limitation'),
    high_discrimination: cases.filter(c => c.discrimination === 'high').length,
  };

  /* recovery is a behaviour, not a tag: failed calls each model recovered from */
  const recovery = Object.fromEntries(names.map(m => { const r = S.get(m).recovery;
    return [m, { failed: r.failed_calls, recovered: Math.round((r.recovered_pct ?? 0) * r.failed_calls / 100), pct: r.recovered_pct }]; }));

  const discrimination = { high: cases.filter(c => c.discrimination === 'high').length, medium: cases.filter(c => c.discrimination === 'medium').length,
    low: cases.filter(c => c.discrimination === 'low').length, unknown: cases.filter(c => !c.discrimination).length };

  /* where every model fails: whose problem, by the causes each model's failure was charged to */
  const failAll = cases.filter(c => c.agreement === 'all_failed').map(c => {
    const causes = names.map(m => cell(m, c.id)?.cause).filter(Boolean);
    const uniq = [...new Set(causes)];
    let owner;
    if (uniq.length === 1 && causes.length === names.length) owner = uniq[0];
    else if (causes.length === names.length && causes.every(x => ['connector', 'instructions', 'metadata'].includes(x))) owner = causes.includes('instructions') ? 'instructions' : 'metadata';
    else owner = causes.every(x => x === 'ai') ? 'ai' : 'mixed';
    return { id: c.id, request: c.request, owner, causes: Object.fromEntries(names.map(m => [m, cell(m, c.id)?.cause || null])) };
  });
  const failOwners = failAll.reduce((a, f) => (a[f.owner] = (a[f.owner] || 0) + 1, a), {});

  /* connector vs model: problems that vary by model are the models'; the rest by evidence */
  const notMeasured = cases.filter(c => c.agreement === 'not_measured').map(c => ({ id: c.id, request: c.request,
    why: names.map(m => `${m}: ${c.cells[m]?.result || 'no result'}`).join(' · ') }));
  const separation = {
    model: { label: 'Model limitations', note: 'Problems that vary by model: the same request, the same connector, a different result.',
      items: cases.filter(c => ['unique_win', 'unique_failure', 'split'].includes(c.agreement)).map(c => ({ id: c.id, request: c.request, detail: names.map(m => `${m}: ${c.cells[m]?.result || '—'}`).join(' · ') })) },
    instructions: { label: 'Usage instructions', note: 'Every model fails, and the failures trace to what the usage instructions did not say: the catalog or schema to use, or a filter the source requires.',
      items: failAll.filter(f => f.owner === 'instructions').map(f => ({ id: f.id, request: f.request, detail: 'charged to the usage instructions on every model' })) },
    metadata: { label: 'Metadata', note: 'Every model fails, and the failures trace to the schema contradicting itself: a table or column the connector listed is then rejected.',
      items: failAll.filter(f => f.owner === 'metadata').map(f => ({ id: f.id, request: f.request, detail: 'charged to metadata on every model' })) },
    connector: { label: 'Connector limitations', note: 'A capability the use case needs is not offered through CData ConnectAI MCP (so no model was asked), or every model failed and each failure traces to the connector: an operation refused, the server not responding.',
      items: [...cases.filter(c => c.agreement === 'connector_blocked').map(c => ({ id: c.id, request: c.request, detail: 'a capability it needs is not offered through ConnectAI MCP — not run on any model' })),
        ...failAll.filter(f => f.owner === 'connector').map(f => ({ id: f.id, request: f.request, detail: 'run on every model; each failure charged to the connector' }))] },
    environment: { label: 'Test, account and source limits', note: 'Problems of this test environment or of the source itself — not the models\', not CData\'s.',
      items: [...failAll.filter(f => ['account', 'source', 'harness', 'test_data'].includes(f.owner)).map(f => ({ id: f.id, request: f.request, detail: CAUSE_LABEL[f.owner] })),
        ...notMeasured.map(x => ({ id: x.id, request: x.request, detail: `not measured — ${x.why}` }))] },
    unclear: { label: 'Every model fails, cause unclear', note: 'Every model fails but for different reasons, or all through their own mistakes — a hard task, not proof of a connector gap.',
      items: failAll.filter(f => ['ai', 'mixed', 'unknown'].includes(f.owner)).map(f => ({ id: f.id, request: f.request, detail: names.map(m => `${m}: ${CAUSE_LABEL[f.causes[m]] || '—'}`).join(' · ') })) },
  };

  /* model behaviour profiles — every sentence from a number above */
  const profiles = names.map(m => profileOf(m, S, matrices, names, unique[m]));

  /* executive answers */
  const executive = executiveOf({ names, S, pairs, matrices, failOwners, failAll, notMeasured, agreement, ctx });

  /* 3.6 — a use case every model got wrong is first a question about its check: in asn-eval1 at
   * least 3 of 11 were check defects (a yes/no question checked on ids, a reference narrower than the
   * request). Listed with each model's check detail, for the catalog reviewer before any blame. */
  const checkSuspects = cases.filter(c => c.agreement === 'all_failed').map(c => {
    const u = meta(c.id) || {};
    return { id: c.id, request: c.request, rule: u.check?.rule || null,
      details: names.map(m => { const x = cell(m, c.id); return { model: m, result: x?.result || x?.outcome || '—', detail: x?.check?.detail || x?.reason || '' }; }) };
  });

  return { cases, stats, pairs, matrices, agreement, unique, discrimination, differ, coverage, recovery, takeaways: takeawaysOf(names, matrices, S, recovery), fail_all: { total: failAll.length, owners: failOwners }, separation, profiles, executive,
    check_suspects: checkSuspects, min_n: MIN_N, agreement_labels: AGREEMENT_LABEL };
}

const OUT_RANK = { correct: 3, partial: 2, not_possible: 1, wrong: 0 };
/** The model that did best and worst on one use case: outcome first, then score. */
function bestWorst(cells, names) {
  const dec = names.filter(m => cells[m] && DECIDED.has(cells[m].outcome));
  if (dec.length < 2) return { best: null, worst: null, gap: 0 };
  const key = m => (OUT_RANK[cells[m].outcome] ?? -1) * 1000 + (cells[m].score ?? 0);
  const order = [...dec].sort((a, b) => key(b) - key(a));
  const sc = dec.map(m => cells[m].score).filter(Number.isFinite);
  const same = key(order[0]) === key(order[order.length - 1]);
  return { best: same ? null : order[0], worst: same ? null : order[order.length - 1], gap: sc.length > 1 ? Math.max(...sc) - Math.min(...sc) : 0 };
}

/** One-line readings for the capability, difficulty and comparison views — only from rows with enough use cases. */
function takeawaysOf(names, matrices, S, recovery) {
  const pct = (r, m) => r.cells[m]?.correct_pct;
  const big = (key) => (matrices[key]?.rows || []).filter(r => names.every(m => pct(r, m) != null && (r.cells[m]?.n || 0) >= MIN_N));
  const lead = r => [...names].sort((a, b) => pct(r, b) - pct(r, a));
  const pc = (r, m) => `${pct(r, m)}% (${r.cells[m].correct}/${r.cells[m].n}${r.cells[m].n < 10 ? ', small sample' : ''})`;
  const out = {};
  const skills = big('skill').sort((a, b) => b.spread - a.spread);
  out.capability = skills.length
    ? `Largest differences: ${skills.slice(0, 3).map(r => { const o = lead(r); return `${r.label.toLowerCase()} (${o[0]} ${pc(r, o[0])} vs ${o[o.length - 1]} ${pc(r, o[o.length - 1])})`; }).join('; ')}.`
      + ((() => { const hard = skills.filter(r => Math.max(...names.map(m => pct(r, m))) < 40); return hard.length ? ` Every model struggles with ${hard.map(r => r.label.toLowerCase()).join(', ')}.` : ''; })())
    : 'Too few tagged use cases per skill to compare.';
  const diffs = big('difficulty');
  if (diffs.length) {
    const tops = diffs.map(r => ({ d: r.label.toLowerCase(), o: lead(r), r }));
    const same = tops.every(t => t.o[0] === tops[0].o[0]);
    out.difficulty = same ? `${tops[0].o[0]} leads at every level of difficulty it was tested on.`
      : `The lead changes with difficulty: ${tops.map(t => `${t.d}: ${t.o[0]} ${pc(t.r, t.o[0])}`).join(', ')}.`;
    const drop = names.map(m => { const p = diffs.map(r => pct(r, m)); return { m, from: p[0], to: p[p.length - 1] }; });
    out.difficulty += ' ' + drop.map(d => `${d.m} ${d.from}% → ${d.to}%`).join(' · ') + ` from ${diffs[0].label.toLowerCase()} to ${diffs[diffs.length - 1].label.toLowerCase()}.`;
  } else out.difficulty = 'Too few tagged use cases per difficulty level to compare.';
  const byRec = names.filter(m => recovery[m].failed >= 5).sort((a, b) => recovery[b].pct - recovery[a].pct);
  const tied = byRec.filter(m => recovery[m].pct === recovery[byRec[0]]?.pct);
  out.recovery = !byRec.length ? null : tied.length > 1
    ? `${tied.join(' and ')} recover equally well (${recovery[byRec[0]].pct}% of failed calls)${byRec.length > tied.length ? `; ${byRec.filter(m => !tied.includes(m)).map(m => `${m} ${recovery[m].pct}%`).join(', ')}` : ''}.`
    : `${byRec[0]} recovers best: ${recovery[byRec[0]].recovered} of ${recovery[byRec[0]].failed} failed calls (${recovery[byRec[0]].pct}%).`;
  return out;
}

function rank(names, f, dir = -1) { return [...names].filter(m => f(m) != null).sort((a, b) => dir * (f(a) - f(b))); }

function profileOf(m, S, matrices, names, uq) {
  const s = S.get(m);
  const others = names.filter(x => x !== m);
  const strengths = [], weaknesses = [];
  for (const key of ['difficulty', 'pattern', 'skill']) for (const row of matrices[key].rows) {
    /* the pattern already says it: "explain a limitation" would repeat as a skill */
    if (key === 'skill' && row.key === 'limitation') continue;
    const c = row.cells[m]; if (!c || c.n < MIN_N || c.correct_pct == null) continue;
    const rest = others.map(x => row.cells[x]?.correct_pct).filter(x => x != null);
    if (!rest.length) continue;
    const best = Math.max(...rest), worst = Math.min(...rest);
    if (c.correct_pct >= best + 10) strengths.push({ text: `${row.label}: ${c.correct_pct}% correct vs ${best}% for the next best`, gap: c.correct_pct - best });
    if (c.correct_pct <= worst - 10) weaknesses.push({ text: `${row.label}: ${c.correct_pct}% correct vs ${worst}% for the next weakest`, gap: worst - c.correct_pct });
  }
  strengths.sort((a, b) => b.gap - a.gap); weaknesses.sort((a, b) => b.gap - a.gap);
  const areas = matrices.area.rows.filter(r => (r.cells[m]?.n || 0) >= MIN_N).sort((a, b) => (b.cells[m].correct_pct ?? -1) - (a.cells[m].correct_pct ?? -1));
  const avgOf = f => avg(names.map(x => f(S.get(x))));
  const rel = (v, ref, more, less) => v == null || ref == null ? null : v > ref * 1.15 ? more : v < ref * 0.85 ? less : 'about average';
  const it = s.interaction, rc = s.recovery, ef = s.efficiency;
  const failures = [];
  if (s.silent_wrong_pct != null && s.wrong) failures.push(`${s.silent_wrong_pct}% of its wrong answers came from journeys where every call worked — it queried confidently and answered a different question`);
  const topErr = Object.entries({ 'wrong object or name guessed': it.wrong_object, 'wrong column guessed': it.wrong_field, 'required filter missed': it.missing_filter, 'SQL rejected': it.bad_sql })
    .filter(([, v]) => v).sort((a, b) => b[1] - a[1])[0];
  if (topErr) failures.push(`most frequent failed call: ${topErr[0]} (${topErr[1]} per 100 use cases)`);
  if (rc.gave_up) failures.push(`gave up on ${rc.gave_up} use case${(rc.gave_up) === 1 ? '' : 's'}`);
  return {
    model: m,
    headline: `${s.correct_pct ?? '—'}% of use cases correct · correct first time ${s.first_try_pct ?? '—'}% · ${ef.calls ?? '—'} calls and ${ef.tokens?.toLocaleString() ?? '—'} tokens per use case`,
    strengths: strengths.slice(0, 4).map(x => x.text),
    weaknesses: weaknesses.slice(0, 4).map(x => x.text),
    failures,
    mcp: [`${it.discovery ?? '—'} discovery calls and ${it.acting ?? '—'} queries or writes per use case (${rel(it.discovery, avgOf(x => x.interaction.discovery), 'explores more than the average of the compared models', 'explores less than the average of the compared models') || '—'})`,
      it.instructions_first != null ? `reads the connector's usage instructions first in ${it.instructions_first}% of use cases` : null,
      it.repeated ? `${it.repeated} repeated call(s) per use case on average` : null].filter(Boolean),
    recovery: rc.failed_calls ? `${rc.failed_calls} failed calls in all; recovered from ${rc.recovered_pct}% of them` : 'no failed calls',
    efficiency: `${ef.tokens_per_correct != null ? `${ef.tokens_per_correct.toLocaleString()} tokens per correct answer` : 'no correct answers'} · ${ef.time_s ?? '—'} s per use case (${rel(ef.time_s, avgOf(x => x.efficiency.time_s), 'slower than the average of the compared models', 'faster than the average of the compared models') || '—'})`,
    suited: areas.slice(0, 2).filter(r => (r.cells[m].correct_pct ?? 0) >= 40).map(r => `${r.label} (${r.cells[m].correct_pct}% correct)`),
    unsuited: areas.slice(-2).reverse().filter(r => (r.cells[m].correct_pct ?? 100) < 40).map(r => `${r.label} (${r.cells[m].correct_pct}% correct)`),
    unique_wins: uq.wins.length, unique_failures: uq.failures.length,
  };
}

function bestIn(matrix, key, names) {
  const row = matrix.rows.find(r => r.key === key);
  if (!row) return null;
  const n = Math.min(...names.map(m => row.cells[m]?.n ?? 0));
  if (n < MIN_N) return { answer: null, n, note: `too few use cases to call (${n})` };
  const order = rank(names, m => row.cells[m]?.correct_pct);
  const [a, b] = order;
  const gap = (row.cells[a]?.correct_pct ?? 0) - (row.cells[b]?.correct_pct ?? 0);
  return { answer: gap < 5 ? null : a, n, gap, note: gap < 5 ? `level — ${order.map(m => `${m} ${row.cells[m].correct_pct}%`).join(', ')}` : `${order.map(m => `${m} ${row.cells[m].correct_pct}%`).join(' · ')} (${n} use cases)` };
}
function executiveOf({ names, S, pairs, matrices, failOwners, failAll, notMeasured, agreement, ctx }) {
  const byCorrect = rank(names, m => S.get(m).correct_pct);
  const [top, second] = byCorrect;
  const pair = pairs.find(p => (p.a === top && p.b === second) || (p.a === second && p.b === top));
  const sig = pair?.significant && pair.lead === top;
  const qa = [];
  /* `key` names the question for the report, which words some answers itself; `n` is how many use cases decided it */
  const add = (q, a, detail, confidence, key = null, n = null) => qa.push({ q, a, detail, confidence, key, n });
  add('Which model performed best?', sig ? top : `${top} leads, but not decisively`,
    `${byCorrect.map(m => `${m} ${S.get(m).correct_pct}% correct`).join(' · ')}`, sig ? 'clear' : 'close', 'best');
  if (second) add('By how much — and is it real?', `${Math.abs(pair?.diff_pts ?? 0)} points over ${second}`,
    `${pair?.verdict}. 95% range of the difference: ${pair?.ci?.[0]} to ${pair?.ci?.[1]} points. Decided on the ${pair?.a_only + pair?.b_only} use cases only one of the two got correct.`, sig ? 'clear' : 'close', 'gap');
  const eff = rank(names, m => S.get(m).efficiency.tokens_per_correct, 1).filter(m => (S.get(m).correct_pct ?? 0) >= (S.get(top).correct_pct ?? 0) - 10);
  if (eff.length) add('Which model is most efficient?', eff[0], `Among models within 10 points of the best: ${eff.map(m => `${m} ${S.get(m).efficiency.tokens_per_correct?.toLocaleString() ?? '—'} tokens per correct answer`).join(' · ')}. Cheap but incorrect does not count.`, 'clear', 'efficiency');
  for (const [q, key, dim] of [['Which handles complex tasks best?', 'complex', 'difficulty'], ['Which is best for write and action workflows?', 'write', 'skill'],
    ['Which handles ambiguity best?', 'ambiguity', 'skill'], ['Which handles relative dates best?', 'dates', 'skill']]) {
    const b = bestIn(matrices[dim], key, names);
    if (!b) { add(q, 'Not tested', `No use case in this eval is tagged "${key}" — tag the catalog to answer this.`, 'n/a', key, 0); continue; }
    /* under ten use cases a gap can be one or two answers: shown, labelled indicative, never called clear */
    add(q, b.answer || (b.n < MIN_N ? 'Too few use cases' : 'No clear winner'), b.note, b.answer ? (b.n < 10 ? 'indicative' : 'clear') : b.n < MIN_N ? 'n/a' : 'close', key, b.n);
  }
  const rec = rank(names, m => S.get(m).recovery.failed_calls >= 5 ? S.get(m).recovery.recovered_pct : null);
  /* a tie is a tie: two models recovering from the same share are named together */
  const recTie = rec.filter(m => S.get(m).recovery.recovered_pct === S.get(rec[0])?.recovery.recovered_pct);
  if (rec.length) add('Which recovers best from errors?', recTie.length > 1 ? `${recTie.join(' and ')}, level` : rec[0],
    rec.map(m => `${m} recovered from ${S.get(m).recovery.recovered_pct}% of ${S.get(m).recovery.failed_calls} failed calls`).join(' · '), recTie.length > 1 ? 'close' : 'clear', 'recovery');
  const hard = ['pattern', 'area'].flatMap(k => matrices[k].rows.filter(r => r.n >= 3 && Math.max(...names.map(m => r.cells[m]?.correct_pct ?? 0)) < 40).map(r => r.label));
  add('Where do all models struggle?', hard.length ? hard.slice(0, 5).join(' · ') : 'Nowhere in particular',
    `${agreement.all_failed || 0} use case${(agreement.all_failed || 0) === 1 ? '' : 's'} that every model attempted fail on every model: ${Object.entries(failOwners).map(([k, v]) => `${v} ${k === 'mixed' ? 'with mixed causes' : k === 'ai' ? 'through each model\'s own mistakes' : `charged to the ${(CAUSE_LABEL[k] || k).toLowerCase()}`}`).join(', ') || 'none'}.`, 'clear', 'struggle');
  const blocked = agreement.connector_blocked || 0;
  const gaps = blocked + (failOwners.connector || 0) + (failOwners.instructions || 0) + (failOwners.metadata || 0);
  add('What are the connector and MCP gaps?', gaps ? `${gaps} use case${(gaps) === 1 ? '' : 's'} the connector or its metadata stops` : 'None proven by this eval',
    `${blocked} need a capability CData ConnectAI MCP does not offer (no model was asked); ${failOwners.connector || 0} failed on every model through the connector, ${failOwners.instructions || 0} through its usage instructions and ${failOwners.metadata || 0} through its metadata.${(ctx.fixList || []).length ? ` Suggested fix: ${ctx.fixList[0].fix}${/[.!?]$/.test(ctx.fixList[0].fix) ? '' : '.'}` : ''}`, 'clear', 'gaps');
  const next = [];
  if (notMeasured.length) next.push(`measure the ${notMeasured.length} use case${(notMeasured.length) === 1 ? '' : 's'} not run on every model: add the missing test data, and run the use cases that create records once writes are allowed`);
  if ((failOwners.harness || 0) || ctx.harnessWarn) next.push('allow every connector tool in the test harness so no call is refused at random');
  if (ctx.judgeConflict?.length) next.push(`judge with a model that is not a contestant (${ctx.judgeConflict.join(', ')} is both)`);
  if ((ctx.fixList || []).length) next.push(`fix first: ${ctx.fixList[0].fix}`);
  if (!sig && second) next.push('run more attempts per use case before choosing between the top models');
  add('What should be improved next?', next.length ? next[0] : '—', next.slice(1).join(' · '), 'clear', 'next');
  return { top, decisive: !!sig, qa };
}
