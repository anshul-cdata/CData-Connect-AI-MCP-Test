/* report-data.mjs — the numbers the capability and eval reports show, from stored results only.
 *
 * Both reports are built from the results store (lib/results.mjs), the capability list and the
 * catalog — never from a model's memory of the run. Everything here is arithmetic over those
 * records, so a report can be rebuilt at any time and two builds of the same run are identical.
 */
import { byUseCase } from './results.mjs';
import { attributeCauses } from './journey.mjs';
import { readerNote } from './capabilities.mjs';
import { analyseEval } from './eval-analysis.mjs';
import { isBulkExport } from './realism.mjs';
import { areaFreezeState } from './catalog.mjs';

export const OUTCOME_LABEL = {
  correct: 'Worked', partial: 'Partly', wrong: 'Wrong result', not_possible: 'Not possible', not_run: 'Not run',
  no_test_data: 'No test data', needs_judgement: 'Awaiting judgement', not_checked: 'Not checked', not_applicable: 'Not applicable',
  blocked_account: 'Blocked by the account', blocked_connector: 'Refused by the connector',
};

/* 3.5 — one verdict per use case, so a connector limitation, an empty test account and an AI
 * mistake are never added up as "failed". The AI's quality is measured only on use cases it could
 * actually attempt with data (correct, partly, incorrect); the rest are findings about the
 * connector, the source or the test account, each shown under its own name. */
export const VERDICT_LABEL = {
  correct: 'Correct', partly: 'Partly correct', incorrect: 'Incorrect', unsupported: 'Not supported', not_applicable: 'Not applicable',
  blocked_connector: 'Refused by the connector', blocked_account: 'Blocked by the account', blocked_data: 'Blocked by test data', not_measured: 'Not measured',
};
export const VERDICT_ORDER = Object.keys(VERDICT_LABEL);
/* the verdicts that measure the AI */
export const AI_TESTED = new Set(['correct', 'partly', 'incorrect']);
export const FIX_TEXT = {
  catalog_not_found: "Name the catalog in the connector's usage instructions",
  schema_not_found: 'Name the schema in the usage instructions',
  table_not_found: 'Describe what each table holds in the usage instructions',
  column_not_found: 'Describe how columns are named in the usage instructions',
  unsupported_function: 'List the supported SQL functions in the usage instructions',
  timeout: 'Fail fast on unfiltered reads with "add a filter", or page by default',
  rate_limit: 'Back off and retry inside the connector instead of failing the call',
  permission: "Check the test account's rights for this object",
  required_filter: 'Say which filters are required in the usage instructions',
  unsupported_operation: 'Expose the operation, or state plainly that it is not supported',
  syntax_error: 'Document the supported SQL dialect in the usage instructions',
  record_not_found: 'Check how records are identified in the usage instructions',
  server_unavailable: 'Keep the MCP server responsive under parallel load, or return a retryable error',
  plan_limit: 'Say in the usage instructions which objects need a paid plan of the source',
  auth_required: 'Re-authenticate the connection for this object',
  harness_blocked: "Allow the connector's tools in the test harness's permissions, then re-run the attempt",
  result_too_large: 'Steer agents to filter or page large reads; return a row-count hint',
  unclassified: 'Classify this error in lib/journey.mjs so it can be tracked',
};
export const CLASS_LABEL = {
  catalog_not_found: 'Catalog name not discoverable', schema_not_found: 'Schema name not discoverable',
  table_not_found: 'Table name guessed wrong', column_not_found: 'Column name guessed wrong',
  unsupported_function: 'Unsupported SQL function', timeout: 'Query timed out', rate_limit: 'Rate limited',
  permission: 'Permission denied', required_filter: 'Required filter missing', unsupported_operation: 'Operation not supported',
  syntax_error: 'SQL syntax rejected', record_not_found: 'Record not found',
  server_unavailable: 'Connector not responding', plan_limit: "Not on the source's plan", auth_required: 'Connection needs re-authentication',
  harness_blocked: 'Blocked by the test harness', result_too_large: 'Result too large for the agent', unclassified: 'Unclassified error',
};
export const CAUSE_LABEL = { connector: 'Connector', instructions: 'Usage instructions', metadata: 'Metadata', ai: 'AI agent', account: 'Test account', source: 'Source system',
  test_data: 'Test data', harness: 'Test harness', unknown: 'Unknown' };

/* The dominant way a use case asks the AI to work, derived from its tags (no second vocabulary to
 * label): the strongest demand wins. Untagged use cases fall back to what the kind implies. */
export const PATTERN_LABEL = { bulk_read: 'Bulk export', limitation: 'Explain a limitation', clarify: 'Clarify', read_decide_act: 'Read → decide → act', act: 'Act (write)',
  multi_step: 'Multi-step reasoning', aggregate: 'Aggregate', cross_object: 'Cross-object', filter: 'Filter', retrieve: 'Retrieve' };
export function patternOf(u) {
  const t = new Set(Array.isArray(u?.tests) ? u.tests : []);
  const writes = t.has('write') || u?.kind === 'action' || u?.writes === true;
  if (t.has('limitation')) return 'limitation';
  /* 3.7: "pull every time entry for the billing export" is a bulk read, not a conversation — kept,
   * and reported apart so it does not weigh on the conversational patterns */
  if (isBulkExport(u?.request)) return 'bulk_read';
  if (t.has('ambiguity') || t.has('missing_info')) return 'clarify';
  if (writes && (t.has('multi_step') || u?.kind === 'job')) return 'read_decide_act';
  if (writes) return 'act';
  if (t.has('multi_step') || u?.kind === 'job') return 'multi_step';
  if (t.has('aggregation')) return 'aggregate';
  if (t.has('relationships')) return 'cross_object';
  if (t.has('filters') || t.has('dates')) return 'filter';
  return Array.isArray(u?.tests) ? 'retrieve' : null;
}

/* How strong the evidence is that real people want this — lib/evidence.mjs (3.9: shared with the catalog). */
import { EVIDENCE_LABEL, EVIDENCE_RANK, evidenceOf } from './evidence.mjs';
export { EVIDENCE_LABEL, EVIDENCE_RANK, evidenceOf };
/* 3.9 — a capability assembled from reference pages links its page; one read from a spec has none,
 * and its rows are exactly what they were */
const docOf = c => c?.doc_url ? { doc_url: c.doc_url } : {};

/* Explanations written by a judge or a checker are read in the report by people who never saw the
 * catalog's field names: put the few that leak into words. */
const FIELD_WORDS = [[/\bexpected[_ ]behaviou?r\b/gi, 'the expected behaviour'], [/\breference[_ ]sql\b/gi, 'the reference query'],
  [/\bfinal[_ ]sql\b/gi, "the agent's final query"], [/\bfinal[_ ]rows\b/gi, "the agent's rows"], [/\bno_test_data\b/g, 'no test data'],
  [/\bwrite_visible\b/g, 'write check'], [/\bsame_ids\b/g, 'same records'], [/\bsame_count\b/g, 'same count'], [/\bvalues_within\b/g, 'values within range'],
  [/\bnot_exposed\b/g, 'not supported'], [/\bproduct_only\b/g, 'not applicable']];
export const readable = t => t == null ? t : FIELD_WORDS.reduce((s, [re, w]) => s.replace(re, w), String(t)).replace(/\bthe the\b/gi, 'the');

/** First-try success: the answer was right AND no call failed on the way. A clean journey that
 * ends in a wrong answer is not a success — it is the most misleading kind of failure. */
export const firstTry = u => u?.outcome === 'correct' && (u.metrics?.failed ?? 1) === 0;

/* What counts as not working. A use case that was not run, awaits judgement, or found no test
 * data is not a failure of anyone — charging it to the AI or the connector would be invented. */
export const FAILED = new Set(['wrong', 'partial', 'not_possible']);
const failed = u => FAILED.has(u.outcome);

const avg = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
const r0 = x => x == null ? null : Math.round(x);
/* Supported · Partly · Not supported (in the source API, not offered through ConnectAI MCP — a CData gap)
 * · Not applicable (only in the source's own app, no API — no connector could offer it). */
const statusBucket = s => s === 'exposed' ? 'y' : s === 'partly' ? 'p' : s === 'not_exposed' ? 'n' : s === 'product_only' ? 'na' : null;
export const CDATA_GAP = 'CData — not offered through ConnectAI MCP';

/** Representative result per business use case, attempts and phrasings collapsed. A rephrased
 * variant (`#v1`) is the same business need asked another way: until 3.5 it was a use case of its
 * own, which counted one need twice. It now adds evidence to its use case — whether every phrasing
 * got the same outcome is reported as `phrasings_agree`, a robustness signal. */
export function useCaseRows(records) {
  const biz = records.filter(r => r.suite === 'business');
  const rows = byUseCase(biz);
  for (const u of rows) {
    const mine = biz.filter(r => (r.use_case_id || r.tc_id) === u.id);
    const byV = new Map();
    for (const r of mine) { const v = r.variant || 0; if (!byV.has(v)) byV.set(v, []); byV.get(v).push(r.outcome); }
    u.phrasings = byV.size;
    /* each wording's majority outcome; attempts that differ within one wording are flakiness, not wording */
    const majority = os => [...os.reduce((m, o) => m.set(o, (m.get(o) || 0) + 1), new Map()).entries()].sort((x, y) => y[1] - x[1])[0][0];
    u.phrasings_agree = byV.size > 1 ? new Set([...byV.values()].map(majority)).size === 1 : null;
    u.attempts = (u.attempts || []).map((a, i) => ({ ...a, variant: mine[i]?.variant || 0 }));
    /* a review correction on any of its tests applies to the use case */
    u.review = mine.find(r => r.review)?.review || null;
  }
  return rows;
}

/**
 * The cause a failed or partial use case is charged to. "Not possible" is the connector's only when
 * the evidence says so: a plan or rights error is the test account's, and a capability the
 * source's own API does not offer is the source system's. A wrong answer with no failed call is the
 * AI's — every call worked, the agent asked the wrong question.
 * @param {object} r
 * @param {Map<string,string>} [capStatus] capability id → mapping status
 */
export function causeOf(r, capStatus = null) {
  if (r.outcome === 'blocked_account') return 'account';
  if (r.outcome === 'blocked_connector') return 'connector';
  if (r.outcome === 'no_test_data') return 'test_data';
  if (!FAILED.has(r.outcome)) return null;
  /* the post-execution reviewer read the journey and re-charged it (Stage 10.5) */
  if (r.review?.cause && r.review.cause in CAUSE_LABEL) return r.review.cause;
  /* 3.7.1: what decided the outcome is a failure the agent did not get past, on a call that acts —
   * a recovered error or a failed table lookup on the way is friction, not the owner (review: a
   * judged wrong answer was relabelled "blocked by the account" by one recovered discovery error) */
  const errs = (r.steps || []).filter(s => !s.ok && s.cause && !s.recovered && (!s.category || ['query', 'write', 'procedure'].includes(s.category)));
  if (r.outcome === 'not_possible') {
    if (errs.some(s => s.cause === 'account')) return 'account';
    /* what blocks it is what is not exposed: when every blocking capability exists only in the
     * source's own app (a capacity setting, a workload view) no connector could offer it */
    const st = (r.capabilities || []).map(id => typeof id === 'string' ? capStatus?.get(id) : id?.status_raw).filter(Boolean);
    const blocking = st.filter(x => x !== 'exposed');
    if (blocking.length && blocking.every(x => x === 'product_only')) return 'source';
    return 'connector';
  }
  if (!errs.length) return r.outcome === 'correct' ? null : 'ai';
  const n = errs.reduce((m, s) => (m[s.cause] = (m[s.cause] || 0) + 1, m), {});
  return Object.entries(n).sort((x, y) => y[1] - x[1])[0][0];
}

/** The one verdict a use case gets in every summary (see VERDICT_LABEL). */
export function verdictOf(u, capStatus = null) {
  switch (u.outcome) {
    case 'correct': return 'correct';
    case 'blocked_account': return 'blocked_account';
    case 'blocked_connector': return 'blocked_connector';
    case 'no_test_data': return 'blocked_data';
    case 'not_possible': { const c = causeOf(u, capStatus); return c === 'source' ? 'not_applicable' : c === 'account' ? 'blocked_account' : 'unsupported'; }
    case 'partial': case 'wrong': {
      /* only a reviewer charging it to the account or the data takes it out of the AI's hands; the
       * automatic owner is shown beside an incorrect answer, never used to hide it */
      const c = u.review?.cause || null;
      if (c === 'account') return 'blocked_account';
      if (c === 'test_data') return 'blocked_data';
      if (c === 'harness') return 'not_measured';
      return u.outcome === 'partial' ? 'partly' : 'incorrect';
    }
    default: return 'not_measured';
  }
}
const verdictCounts = (us, capStatus) => {
  const v = Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]));
  for (const u of us) v[verdictOf(u, capStatus)]++;
  return v;
};

/** Failed calls grouped by what went wrong, across every journey. */
export function friction(records) {
  const g = new Map();
  for (const r of records) {
    const failed = (r.steps || []).filter(s => !s.ok);
    const seen = new Set();
    for (const s of failed) {
      const k = s.error_class || 'unclassified';
      if (!g.has(k)) g.set(k, { class: k, cause: s.cause || 'unknown', tests: new Set(), extra: [], ms: [], recovered: 0, total: 0 });
      const e = g.get(k);
      e.total++; if (s.recovered) e.recovered++;
      if (!seen.has(k)) { seen.add(k); e.tests.add(r.use_case_id || r.tc_id); }
    }
    for (const k of seen) {
      const e = g.get(k);
      const mine = failed.filter(s => (s.error_class || 'unclassified') === k);
      const fixes = (r.steps || []).filter(s => s.ok && mine.some(m => s.recovery_of === m.n) && s.category === 'discovery');
      e.extra.push(mine.length + fixes.length);
      e.ms.push(mine.reduce((a, s) => a + (s.ms || 0), 0) || null);
    }
  }
  return [...g.values()].map(e => ({
    class: e.class, label: CLASS_LABEL[e.class] || e.class, cause: CAUSE_LABEL[e.cause] || e.cause,
    tests: e.tests.size, extra_calls: r1(avg(e.extra)), extra_s: r1(avg(e.ms.map(x => x == null ? null : x / 1000))),
    recovered_pct: e.total ? r0((e.recovered / e.total) * 100) : null, fix: FIX_TEXT[e.class] || FIX_TEXT.unclassified,
  })).sort((a, b) => b.tests - a.tests);
}

/**
 * Every call the driver answered with an error, across every attempt of every test — the evidence
 * behind the friction counts. Identical failures (same tool, same input, same error) are folded into
 * one row with the tests that hit it, so a query that failed on every attempt is one row, not three.
 */
export function failedCalls(records) {
  const rows = new Map();
  for (const r of records) {
    /* a call the harness refused never reached the driver */
    for (const s of (r.steps || []).filter(x => !x.ok && x.cause !== 'harness')) {
      const input = typeof s.input === 'string' ? s.input : s.input == null ? '' : JSON.stringify(s.input);
      const error = String(s.error ?? '').slice(0, 800);
      const key = `${s.tool}\u0000${input}\u0000${error}`;
      if (!rows.has(key)) rows.set(key, {
        tool: s.tool || '—', category: s.category || null, input: input.slice(0, 2000), error,
        class: s.error_class || 'unclassified', label: CLASS_LABEL[s.error_class] || s.error_class || 'Unclassified error',
        cause: s.cause || 'unknown', owner: CAUSE_LABEL[s.cause] || CAUSE_LABEL.unknown,
        recovered: false, count: 0, tests: [], suite: r.suite || null,
      });
      const row = rows.get(key);
      row.count++; if (s.recovered) row.recovered = true;
      const t = `${r.use_case_id || r.tc_id}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}`;
      if (!row.tests.includes(t)) row.tests.push(t);
    }
  }
  const order = { connector: 0, instructions: 1, metadata: 2, account: 3, unknown: 4, ai: 5 };
  return [...rows.values()].sort((a, b) => (order[a.cause] ?? 9) - (order[b.cause] ?? 9) || b.count - a.count || a.label.localeCompare(b.label));
}

/* Generic guidance the server returns when no connector-specific instructions are configured. */
const GENERIC_INSTRUCTIONS = /generic|fallback|no (connector|source)[- ]specific|use (the )?metadata tools/i;
/**
 * The usage instructions an agent reads through getInstructions: did agents read them, were they
 * specific to this source, and how many failed calls did they fail to prevent (catalog or schema not
 * named, required filters not stated)?
 */
export function instructionsOf(records, knowledge = null) {
  const biz = records.filter(r => r.suite === 'business' && Array.isArray(r.steps) && r.steps.length);
  const reads = biz.flatMap(r => r.steps.filter(s => s.tool === 'getInstructions' && s.ok && s.result));
  const failed = biz.flatMap(r => r.steps.filter(s => !s.ok && s.cause === 'instructions'));
  const byClass = {};
  for (const s of failed) byClass[s.error_class] = (byClass[s.error_class] || 0) + 1;
  const raw = knowledge?.instructions_raw || null;
  /* What better instructions could prevent, by topic. Some topics are charged to the instructions
   * (the agent could not have known); for the rest another owner is charged — the AI guessed a name,
   * the connector refused a write — but one line in the instructions would still have saved the call. */
  const all = biz.flatMap(r => r.steps.map(s => ({ ...s, uc: r.use_case_id || r.tc_id })));
  const topic = (key, label, line, test, charged) => {
    const hit = all.filter(s => !s.ok && s.cause !== 'harness' && test(s));
    return { key, label, line, charged, calls: hit.length, tests: new Set(hit.map(s => s.uc)).size };
  };
  const cls = (...k) => s => k.includes(s.error_class);
  const topics = [
    topic('naming', 'Catalog and schema names', 'Say which catalog and schema to use, with a full table reference', cls('catalog_not_found', 'schema_not_found'), true),
    topic('filters', 'Required filters', 'List, per table, the filters the source requires (for example a project or workspace id)', cls('required_filter'), true),
    topic('functions', 'SQL functions', 'List the SQL functions that work, and how to do dates and counts', cls('unsupported_function'), true),
    topic('vocabulary', 'Business words to tables', 'Map the words users say to tables and columns (for example "comments" are in Stories)', s => ['table_not_found', 'column_not_found'].includes(s.error_class) && s.cause === 'ai', false),
    topic('dialect', 'SQL dialect', 'Show one example query in the supported dialect (quoting, LIMIT, joins)', cls('syntax_error'), false),
    topic('writes', 'What can be changed', 'Say which tables accept insert or update, the required fields, and what is read-only', cls('unsupported_operation'), false),
    topic('paging', 'Large results', 'Advise a filter or LIMIT on large tables, and how to page', cls('result_too_large'), false),
    topic('records', 'Finding a record', 'Explain how records are identified (ids vs names) and how to look one up', cls('record_not_found'), false),
  ].filter(t => t.calls);
  const disc = biz.map(r => { const i = r.steps.findIndex(s => ['query', 'procedure', 'write'].includes(s.category)); return i < 0 ? null : r.steps.slice(0, i).filter(s => s.category === 'discovery').length; }).filter(Number.isFinite);
  return {
    topics,
    discovery_before_first_query: r1(avg(disc)),
    heavy_discovery_pct: disc.length ? r0(100 * disc.filter(n => n >= 5).length / disc.length) : null,
    journeys: biz.length,
    read_any_pct: biz.length ? r0(100 * biz.filter(r => r.steps.some(s => s.tool === 'getInstructions')).length / biz.length) : null,
    read_first_pct: biz.length ? r0(100 * biz.filter(r => r.steps[0]?.tool === 'getInstructions').length / biz.length) : null,
    generic: reads.length ? reads.filter(s => GENERIC_INSTRUCTIONS.test(s.result)).length / reads.length >= 0.5 : null,
    sample: reads[0]?.result ? String(reads[0].result).slice(0, 400) : null,
    configured: raw ? String(raw).slice(0, 400) : null,
    failed_calls: failed.length,
    tests_hit: new Set(biz.filter(r => r.steps.some(s => !s.ok && s.cause === 'instructions')).map(r => r.use_case_id || r.tc_id)).size,
    by_class: Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ class: k, label: CLASS_LABEL[k] || k, n, fix: FIX_TEXT[k] || '' })),
  };
}

/**
 * Everything the capability report shows.
 * @param {{manifest, records, capsDoc, catalog, knowledge, history?: Map<string, object[]>}} x
 */
export function capabilityReport({ manifest, records, capsDoc, catalog, knowledge, history = new Map(), plan = null, testData = null }) {
  /* stored journeys take the current attribution (instructions vs metadata vs AI) without a re-run */
  for (const r of records) if (Array.isArray(r.steps)) attributeCauses(r.steps);
  const caps = capsDoc?.capabilities || [];
  const applicable = caps.filter(c => c.mapping?.status !== 'not_applicable');
  const capCount = s => applicable.filter(c => c.mapping?.status === s).length;
  const ucs = useCaseRows(records);
  const capStatus = new Map(caps.map(c => [c.id, c.mapping?.status]));
  /* a gap blocks a use case only when the use case's verdict is the gap's — an AI mistake on a use case
   * that also needs a partly-supported capability is the AI's (review 3.7.1) */
  const blockedByGap = u => ['unsupported', 'not_applicable', 'blocked_connector'].includes(verdictOf(u, capStatus));
  const ucByCap = new Map();
  for (const u of ucs) for (const c of u.capabilities || []) { if (!ucByCap.has(c)) ucByCap.set(c, []); ucByCap.get(c).push(u); }
  const ucMeta = new Map((catalog?.use_cases || []).map(u => [u.id, u]));
  /* A use case can move between areas, and an area can be renamed, after a result was stored. The
   * catalog decides where it belongs now; the id and name recorded at run time are the fallback. */
  const areaNames = new Map((capsDoc?.areas || []).map(a => [a.id, a.name]));
  const areaIdOf = r => ucMeta.get(String(r.use_case_id || r.id || '').split('#')[0])?.area || r.area_id || null;
  const inArea = (r, ar) => { const id = areaIdOf(r); return id ? id === ar.id : (r.area === ar.name || r.area === ar.id); };
  const tcById = new Map((plan?.tc_list || []).map(t => [t.id, t]));
  const personaMeta = new Map((knowledge?.connector_meta?.personas || []).map(p => [p.name, p]));
  const scored = ucs.filter(u => Number.isFinite(u.score));
  const fr = friction(records);
  /* gaps: capabilities the connector does not fully support, with the use cases they block */
  const gaps = applicable.filter(c => ['partly', 'not_exposed', 'product_only'].includes(c.mapping?.status)).map(c => ({
    id: c.id, label: c.label, api: c.method ? `${c.method} ${c.path}` : '—', ...docOf(c),
    status: c.mapping.status, bucket: c.mapping.status === 'partly' ? 'p' : c.mapping.status === 'product_only' ? 'na' : 'n',
    whose: c.mapping.status === 'product_only' ? "Not applicable — only in the source's own app. Not a CData gap" : CDATA_GAP,
    note: readerNote(c.mapping.note) || '', blocked: (ucByCap.get(c.id) || []).filter(blockedByGap).length,
  })).sort((a, b) => b.blocked - a.blocked || a.label.localeCompare(b.label));

  /* areas */
  const areas = (capsDoc?.areas || []).map(ar => {
    const ids = new Set([...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])]);
    const ac = applicable.filter(c => ids.has(c.id));
    const au = ucs.filter(u => inArea(u, ar));
    const counts = { y: 0, p: 0, n: 0, na: 0 };
    for (const c of ac) { const b = statusBucket(c.mapping?.status); if (b) counts[b]++; }
    const areaFr = friction(records.filter(r => inArea(r, ar))).slice(0, 4);
    const areaGaps = gaps.filter(g => ids.has(g.id));
    const pers = {};
    for (const u of au) if (u.persona) pers[u.persona] = (pers[u.persona] || 0) + 1;
    return {
      id: ar.id, name: ar.name, caps: counts,
      ucs: { total: au.length, worked: au.filter(u => u.outcome === 'correct').length, partly: au.filter(u => u.outcome === 'partial').length,
             failed: au.filter(u => ['wrong', 'not_possible'].includes(u.outcome)).length, verdicts: verdictCounts(au, capStatus) },
      avg: r0(avg(au.map(u => u.score))),
      issue: areaGaps[0]?.label || areaFr[0]?.label || '—',
      capabilities: ac.map(c => { const us = ucByCap.get(c.id) || [];
        return { id: c.id, label: c.label, api: c.method ? `${c.method} ${c.path}` : '—', ...docOf(c),
                 exposure: (c.mapping?.exposure || []).map(e => e.kind === 'procedure' ? `${e.name} · procedure` : `${e.name} · ${e.op}`).join(', ') || '— not exposed',
                 status: statusBucket(c.mapping?.status), total: us.length, ok: us.filter(u => u.outcome === 'correct').length, avg: r0(avg(us.map(u => u.score))) }; }),
      use_cases: au.map(u => u.id), gaps: areaGaps.slice(0, 5), friction: areaFr,
      personas: Object.entries(pers).sort((x, y) => y[1] - x[1]),
    };
  });

  const personas = [...new Set(ucs.map(u => u.persona).filter(Boolean))].map(p => {
    const mine = ucs.filter(u => u.persona === p);
    return { name: p, archetype: personaMeta.get(p)?.archetype || null, ok: mine.filter(u => u.outcome === 'correct').length, total: mine.length,
             verdicts: verdictCounts(mine, capStatus), ai_tested: mine.filter(u => AI_TESTED.has(verdictOf(u, capStatus))).length };
  }).sort((a, b) => b.total - a.total);

  const conformance = byUseCase(records.filter(r => r.suite !== 'business'));
  /* every use case that did not end correct, by who owns it — an empty account and a plan refusal
   * included, so "failures by owner" adds up to everything that is not a success */
  const causes = { connector: 0, instructions: 0, metadata: 0, ai: 0, account: 0, source: 0, test_data: 0, harness: 0, unknown: 0 };
  for (const u of ucs) if (!['correct', 'not_measured'].includes(verdictOf(u, capStatus))) { const c = causeOf(u, capStatus) || 'unknown'; causes[c in causes ? c : 'unknown']++; }
  const verdicts = verdictCounts(ucs, capStatus);
  const aiTested = ucs.filter(u => AI_TESTED.has(verdictOf(u, capStatus)));
  const incorrectBy = {};
  for (const u of aiTested) if (verdictOf(u, capStatus) !== 'correct') { const c = causeOf(u, capStatus) || 'unknown'; incorrectBy[c] = (incorrectBy[c] || 0) + 1; }
  const evidence = {};
  for (const u of catalog?.use_cases || []) if (u.status !== 'retired') { const k = evidenceOf(u.source); evidence[k] = (evidence[k] || 0) + 1; }
  const tagged = (catalog?.use_cases || []).filter(u => u.status !== 'retired' && u.difficulty);

  const src = {};
  for (const u of catalog?.use_cases || []) if (u.status !== 'retired') { const k = u.source?.kind || 'unknown'; src[k] = (src[k] || 0) + 1; }
  const real = (catalog?.use_cases || []).filter(u => u.realism);

  const fixList = [
    ...gaps.filter(g => g.whose === CDATA_GAP && g.blocked).map(g => ({ fix: g.status === 'partly' ? `Complete: ${g.label}` : `Expose: ${g.label}`, owner: 'Connector', evidence: `${g.blocked} use case${(g.blocked) === 1 ? '' : 's'} blocked`, weight: g.blocked * 3, note: g.note, example: (ucByCap.get(g.id) || [])[0]?.id || null })),
    ...fr.filter(f => ['Connector', 'Usage instructions', 'Metadata'].includes(f.cause)).map(f => ({ fix: f.fix, owner: f.cause, evidence: `${f.tests} test(s) · +${f.extra_calls ?? '?'} calls each`, weight: f.tests, note: f.label, example: null })),
  ].sort((a, b) => b.weight - a.weight).map((f, i) => ({ rank: i + 1, ...f }));

  return {
    connector: manifest.connector, run: {
      id: manifest.run_id, model: manifest.model, date: (manifest.finished_at || '').slice(0, 10), catalog_version: manifest.catalog_version,
      fingerprint: manifest.fingerprint, complete: manifest.complete, skill_version: manifest.skill_version,
      weights: manifest.scoring?.weights || null, attempts_expected: manifest.attempts_expected ?? null, attempts_found: manifest.attempts_found ?? null,
      capability_source: manifest.capability_source, fixed_models: manifest.fixed_models,
      ...(manifest.orchestrator?.actual ? { orchestrator: manifest.orchestrator } : {}),
      calls: records.reduce((a, r) => a + (r.metrics?.calls || 0), 0),
      tokens: records.reduce((a, r) => a + (r.metrics?.tokens || 0), 0) || null,
      time_s: r0(records.reduce((a, r) => a + (r.metrics?.time_ms || 0), 0) / 1000) || null,
    },
    caps: { total: applicable.length, supported: capCount('exposed'), partly: capCount('partly'),
            not_exposed: capCount('not_exposed'), product_only: capCount('product_only'), not_applicable: caps.length - applicable.length },
    ucs: { total: ucs.length, worked: ucs.filter(u => u.outcome === 'correct').length, partly: ucs.filter(u => u.outcome === 'partial').length,
           failed: ucs.filter(u => ['wrong', 'not_possible'].includes(u.outcome)).length,
           other: ucs.filter(u => !['correct', 'partial', 'wrong', 'not_possible'].includes(u.outcome)).length,
           blue: scored.filter(u => u.grade === 'blue').length, yellow: scored.filter(u => u.grade === 'yellow').length,
           /* red is an AI result; a capability the connector does not offer is counted under verdicts */
           red: scored.filter(u => u.grade === 'red').length,
           avg_score: r0(avg(scored.map(u => u.score))),
           first_attempt_pct: scored.length ? r0(100 * scored.filter(firstTry).length / scored.length) : null,
           clean_pct: scored.length ? r0(100 * scored.filter(u => (u.metrics?.failed ?? 1) === 0).length / scored.length) : null,
           avg_calls: r1(avg(scored.map(u => u.metrics?.calls))), causes,
           /* 3.5: the verdict breakdown leads; the AI's numbers count only what it could attempt */
           verdicts, ai_tested: aiTested.length, ai_correct_pct: aiTested.length ? r0(100 * verdicts.correct / aiTested.length) : null,
           ai_score: r0(avg(aiTested.map(u => u.score))), incorrect_by: Object.entries(incorrectBy).sort((x, y) => y[1] - x[1]).map(([k, n]) => [CAUSE_LABEL[k] || k, n]),
           phrased: ucs.filter(u => u.phrasings > 1).length, phrasings_disagree: ucs.filter(u => u.phrasings_agree === false).length,
           /* 3.6 — limitation probes: asked for what ConnectAI MCP cannot do, did the agent say so? */
           limitation: (() => { const p = ucs.filter(u => ['correct', 'partial', 'wrong'].includes(u.probe?.outcome));
             return { n: p.length, honest: p.filter(u => u.probe.outcome === 'correct').length, partly: p.filter(u => u.probe.outcome === 'partial').length,
                      invented: p.filter(u => u.probe.outcome === 'wrong').length, pending: ucs.filter(u => u.probe?.outcome === 'needs_judgement').length }; })() },
    /* capabilities the list calls supported that the connector refused at run time (3.6) — a finding
     * the API reading could not see. Shown beside the gaps; the capability list itself is unchanged. */
    refused_at_run: ucs.filter(u => u.outcome === 'blocked_connector').flatMap(u => (u.capabilities || [])
      .map(id => caps.find(c => c.id === id)).filter(c => c && c.mapping?.status === 'exposed')
      .map(c => ({ id: c.id, label: c.label, api: c.method ? `${c.method} ${c.path}` : '—', use_case: u.id, why: readable(u.check?.detail || '') }))),
    gaps, areas, friction: fr, fix_list: fixList, personas, failed_calls: failedCalls(records), instructions: instructionsOf(records, knowledge),
    /* 3.7 — two judges: how often the second agreed with the first, over every attempt both judged */
    judges: (() => { const j = records.flatMap(r => [r.second_judge, r.probe?.second].filter(Boolean));
      return j.length ? { n: j.length, agree: j.filter(x => x.agree).length, disagree_use_cases: [...new Set(records.filter(r => r.second_judge?.agree === false || r.probe?.second?.agree === false).map(r => r.use_case_id))] } : null; })(),
    /* 3.7 — where the test data came from, and what the run left in the test account */
    test_data: (() => {
      const fx = catalog?.fixtures || [], st = testData?.fixtures || {};
      const n = s => fx.filter(f => st[f.id]?.status === s).length;
      const seeded = fx.filter(f => st[f.id]?.status === 'seeded').map(f => ({ fixture: f.id, table: f.table || null, describe: f.describe, id: st[f.id].values?.Id ?? null, name: st[f.id].values?.Name ?? st[f.id].values?.Title ?? null }));
      const touched = records.filter(r => (r.touched || []).length).map(r => ({ use_case: r.use_case_id, attempt: r.attempt, ids: r.touched }));
      const src = ucs.reduce((m, u) => { if (u.data_source) m[u.data_source] = (m[u.data_source] || 0) + 1; return m; }, {});
      return fx.length || touched.length ? { fixtures: fx.length, found: n('found'), seeded: n('seeded'), missing: n('missing') + n('seed_not_found'), refused: n('refused'), by_source: src, left: { seeded, touched } } : null;
    })(),
    driver: conformance.map(c => ({ label: c.uc || c.request, result: OUTCOME_LABEL[c.outcome] || c.outcome, ok: c.outcome === 'correct', detail: c.check?.detail || c.reason || '' })),
    quality: { sources: Object.entries(src).sort((x, y) => y[1] - x[1]),
               realism: { five: real.filter(u => u.realism.score >= 5).length, four: real.filter(u => u.realism.score >= 4 && u.realism.score < 5).length, low: real.filter(u => u.realism.score < 4).length },
               human: catalog?.human_review ? { n: catalog.human_review.n, agree: catalog.human_review.agree } : null,
               /* 3.9 — no human figure because the review was skipped when the catalog was frozen: say why */
               ...(!catalog?.human_review && (catalog?.history || []).slice(-1)[0]?.human_skipped ? { human_skipped: { by: catalog.history.slice(-1)[0].human_skipped_by || null } } : {}),
               evidence: Object.entries(evidence).sort((x, y) => (EVIDENCE_RANK[y[0]] || 0) - (EVIDENCE_RANK[x[0]] || 0)).map(([k, n]) => [EVIDENCE_LABEL[k] || k, n, k]),
               tagged: tagged.length,
               difficulty: ['simple', 'medium', 'complex'].map(d => [d, tagged.filter(u => u.difficulty === d).length]),
               patterns: Object.entries(tagged.reduce((m, u) => { const p = patternOf(u); if (p) m[p] = (m[p] || 0) + 1; return m; }, {})).sort((x, y) => y[1] - x[1]).map(([k, n]) => [PATTERN_LABEL[k] || k, n]),
               sourced_pct: catalog?.use_cases?.length ? r0(100 * catalog.use_cases.filter(u => u.source?.title).length / catalog.use_cases.length) : null },
    use_cases: ucs.map(u => {
      const baseId = String(u.id).split('#')[0];
      const m = ucMeta.get(baseId) || {};
      const tc = tcById.get(u.tc_id) || {};
      return {
        id: u.id, request: u.request, persona: u.persona, area: areaNames.get(areaIdOf(u)) || u.area, area_id: areaIdOf(u), kind: u.kind, priority: u.priority,
        source: u.source || m.source || null, goal: m.goal || null, moment: m.moment || null, frequency: m.frequency || null,
        realism: m.realism?.score ?? null, human: m.human || null,
        difficulty: m.difficulty || null, tests: Array.isArray(m.tests) ? m.tests : null, pattern: patternOf(m.tests ? m : { kind: u.kind }),
        evidence: evidenceOf(u.source || m.source), first_try: firstTry(u),
        outcome: u.outcome, result: OUTCOME_LABEL[u.outcome] || u.outcome, score: u.score, grade: u.grade, parts: u.parts,
        verdict: verdictOf(u, capStatus), verdict_label: VERDICT_LABEL[verdictOf(u, capStatus)],
        phrasings: u.phrasings || 1, phrasings_agree: u.phrasings_agree ?? null, variants: m.variants || [], review: u.review ? { ...u.review, reason: readable(u.review.reason) } : null,
        probe: u.probe ? { ...u.probe, detail: readable(u.probe.detail) } : null, data_source: u.data_source || null,
        clarify: u.clarify ? { ...u.clarify, detail: readable(u.clarify.detail) } : null,
        second_judge: u.second_judge || u.probe?.second || null,
        cause: causeOf(u, capStatus), reason: readable(u.reason) || null,
        metrics: u.metrics, steps: u.steps, answer: u.answer, final_sql: u.final_sql,
        check: u.check ? { ...u.check, detail: readable(u.check.detail) } : null, pass_rate: u.pass_rate,
        attempts: (u.attempts || []).map(a => ({ ...a, failed_steps: (a.failed_steps || []).map(f => ({ ...f, label: CLASS_LABEL[f.class] || f.class })) })),
        capabilities: (u.capabilities || []).map(id => { const c = caps.find(x => x.id === id); return c ? { id, label: c.label, api: c.method ? `${c.method} ${c.path}` : '—', ...docOf(c), status: statusBucket(c.mapping?.status) } : { id, label: id, api: '—', status: null }; }),
        expected: tc.expected_behavior || m.expected_behavior || [],
        fixes: [...new Set((u.steps || []).filter(s => !s.ok).map(s => s.error_class || 'unclassified'))].map(k => ({ label: CLASS_LABEL[k] || k, fix: FIX_TEXT[k] || FIX_TEXT.unclassified })),
        history: (history.get(baseId) || []).slice(0, 6),
      };
    }),
  };
}

/* 3.8 — the analysis report: research done, nothing run. Each use case gets an outlook read from
 * the capabilities it needs and the account probe — a forecast of what a run will meet, never a
 * result, and never counted as one. The first match wins: a CData gap is a finding whatever the
 * account holds; an account without the area's data or features would block a run that could work. */
export const OUTLOOK_LABEL = {
  ready: 'Ready to test', partly: 'Needs a partly supported capability', unsupported: 'Not supported by CData ConnectAI MCP',
  not_applicable: "Only in the source's own app", account_refused: 'Test account refuses it', account_empty: 'Test account has no data for it',
  unknown: 'Capability not in the list',
};
export const OUTLOOK_ORDER = Object.keys(OUTLOOK_LABEL);
const capTables = c => (c?.mapping?.exposure || []).filter(e => e.kind === 'table').map(e => e.name);
export function outlookOf(u, capById, account = null) {
  const caps = (u.capabilities || []).map(id => capById.get(id));
  if (!caps.length || caps.some(c => !c)) return 'unknown';
  const st = caps.map(c => c.mapping?.status);
  if (st.includes('not_exposed')) return 'unsupported';
  const blocking = st.filter(s => s !== 'exposed' && s !== 'partly');
  if (blocking.length && blocking.every(s => s === 'product_only' || s === 'not_applicable')) return 'not_applicable';
  const t = account?.tables || {};
  const states = [...new Set(caps.flatMap(capTables))].map(n => t[n]?.status).filter(Boolean);
  if (states.includes('refused')) return 'account_refused';
  /* every table it reads is empty — one table with data can be enough (a write adds the rest) */
  if (states.length && states.every(s => s === 'empty')) return 'account_empty';
  return st.includes('partly') ? 'partly' : 'ready';
}
/**
 * What the analysis report adds to a capability report built with no records.
 * @param {{capsDoc, catalog, account?: object|null, areas?: string[]|null}} x
 */
export function analysisView({ capsDoc, catalog, account = null, areas = null, knowledge = null }) {
  const caps = capsDoc?.capabilities || [];
  const capById = new Map(caps.map(c => [c.id, c]));
  const areaNames = new Map((capsDoc?.areas || []).map(a => [a.id, a.name]));
  const live = (catalog?.use_cases || []).filter(u => u.status !== 'retired' && (!areas || areas.includes(u.area)));
  const counts = o => { const v = Object.fromEntries(OUTLOOK_ORDER.map(k => [k, 0])); for (const x of o) v[x.outlook]++; return v; };
  const use_cases = live.map(u => {
    const outlook = outlookOf(u, capById, account);
    return { id: u.id, request: u.request, persona: u.persona || null, area: areaNames.get(u.area) || u.area || null, area_id: u.area || null,
      kind: u.kind || null, priority: u.priority || null, difficulty: u.difficulty || null, pattern: patternOf(u), writes: !!u.writes,
      source: u.source ? { kind: u.source.kind, title: u.source.title || null, url: u.source.url || null } : null, evidence: evidenceOf(u.source),
      goal: u.goal || null, expected: u.expected_behavior || [], variants: (u.variants || []).length,
      /* the same provenance the capability report shows per use case: without these the analysis card
       * says what a use case needs but not who asks it, when, how often, or how well it was judged —
       * which is what a reviewer uses to decide whether to trust it before anything is run */
      moment: u.moment || null, frequency: u.frequency || null, tests: u.tests || [],
      realism: u.realism?.score ?? null, human: u.human || null,
      outlook, outlook_label: OUTLOOK_LABEL[outlook],
      capabilities: (u.capabilities || []).map(id => { const c = capById.get(id);
        return c ? { id, label: c.label, api: c.method ? `${c.method} ${c.path}` : '—', ...docOf(c), status: statusBucket(c.mapping?.status) } : { id, label: id, api: '—', status: null }; }) };
  }).sort((a, b) => OUTLOOK_ORDER.indexOf(a.outlook) - OUTLOOK_ORDER.indexOf(b.outlook) || String(a.id).localeCompare(String(b.id)));
  /* how many planned use cases need each capability — the gaps table's weight before any run */
  const needs = {};
  for (const u of live) for (const id of u.capabilities || []) needs[id] = (needs[id] || 0) + 1;
  const t = account?.tables || {};
  const readiness = (capsDoc?.areas || []).filter(ar => !areas || areas.includes(ar.id)).map(ar => {
    const ids = new Set([...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])]);
    const names = [...new Set(caps.filter(c => ids.has(c.id)).flatMap(capTables))].filter(n => t[n]);
    const n = s => names.filter(x => t[x].status === s).length;
    const mine = use_cases.filter(u => u.area_id === ar.id);
    return { id: ar.id, name: ar.name, research: areaFreezeState(catalog, ar.id), use_cases: mine.length, outlook: counts(mine),
      tables: names.length, data: n('data'), empty: n('empty'), refused: n('refused'), needs_filter: n('needs_filter'), error: n('error'),
      empty_tables: names.filter(x => t[x].status === 'empty'), refused_tables: names.filter(x => t[x].status === 'refused') };
  });
  /* Personas, before anything is run. The results report builds D.personas from execution records,
   * so an analysis report left it empty and the whole persona dimension was invisible — even though
   * every use case names one and the Stage 2 research describes them. Build it from the catalog
   * instead, and enrich with the research where it is on disk. */
  const research = new Map((knowledge?.connector_meta?.personas || []).map(p => [String(p.name || '').toLowerCase(), p]));
  const personas = [...new Set(use_cases.map(u => u.persona).filter(Boolean))].sort().map(name => {
    const mine = use_cases.filter(u => u.persona === name);
    const r = research.get(name.toLowerCase()) || null;
    const by = k => Object.fromEntries(Object.entries(mine.reduce((m, u) => { const v = u[k] || 'unknown'; m[v] = (m[v] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]));
    const scored = mine.map(u => u.realism).filter(Number.isFinite);
    return { name, archetype: r?.archetype || null, description: r?.description || null,
      jobs: r?.jobs_to_be_done || [], use_cases: mine.length, outlook: counts(mine),
      areas: [...new Set(mine.map(u => u.area).filter(Boolean))].sort(),
      difficulty: by('difficulty'), writes: mine.filter(u => u.writes).length,
      realism: scored.length ? r1(avg(scored)) : null };
  }).sort((a, b) => b.use_cases - a.use_cases);
  /* a persona the research names but no use case serves is a real research gap, not a rounding error */
  const personas_without_use_case = [...research.values()].map(p => p.name)
    .filter(n => !personas.some(p => p.name.toLowerCase() === String(n).toLowerCase()));
  return { use_cases, outlook: counts(use_cases), needs, readiness, personas, personas_without_use_case,
    account_probed: !!account, account_at: account?.at || null,
    researched_at: catalog?.updated_at || null, catalog_version: catalog?.version ?? null };
}
/** Everything the eval report shows, from one capability-report dataset per model. */
export function evalReport({ evalId, models, baseline = null, harnessWarn = false }) {
  const names = models.map(m => m.model);
  const per = models.map(m => {
    const d = m.data;
    const sc = d.use_cases.filter(u => Number.isFinite(u.score));
    const tok = avg(sc.map(u => u.metrics?.tokens));
    const dec = d.use_cases.filter(u => FAILED.has(u.outcome) || u.outcome === 'correct');
    return { model: m.model, run_id: m.run_id, reused: !!m.reused, score: d.ucs.avg_score, correct: d.ucs.worked, total: d.ucs.total,
      decided: dec.length, correct_pct: dec.length ? r0(100 * d.ucs.worked / dec.length) : null,
      first: d.ucs.first_attempt_pct, blue: d.ucs.blue, yellow: d.ucs.yellow, red: d.ucs.red, calls: d.ucs.avg_calls,
      time_s: r0(avg(sc.map(u => (u.metrics?.time_ms || null) && u.metrics.time_ms / 1000))), tokens: tok ? r0(tok) : null,
      cost_per_100: m.cost_per_100_correct ?? null };
  /* the business outcome ranks first; the blended score only breaks ties */
  }).sort((a, b) => (b.correct_pct ?? -1) - (a.correct_pct ?? -1) || (b.score ?? -1) - (a.score ?? -1));

  const ids = [...new Set(models.flatMap(m => m.data.use_cases.map(u => u.id)))];
  const find = (m, id) => m.data.use_cases.find(u => u.id === id);
  const grid = ids.map(id => {
    const cells = Object.fromEntries(models.map(m => { const u = find(m, id); return [m.model, u ? { score: u.score, grade: u.grade, outcome: u.outcome, result: u.result } : null]; }));
    const any = models.map(m => find(m, id)).find(Boolean);
    const sc = Object.values(cells).filter(c => c && Number.isFinite(c.score)).map(c => c.score);
    const why = models.map(m => { const u = find(m, id); if (!u) return null;
      const errs = [...new Set((u.steps || []).filter(s => !s.ok).map(s => CLASS_LABEL[s.error_class] || s.error_class))];
      return u.outcome === 'correct' && !errs.length ? null : `${m.model}: ${u.result}${errs.length ? ' · ' + errs.join(', ') : ''}`; }).filter(Boolean).join(' · ');
    return { id, request: any.request, kind: any.kind, area: any.area, persona: any.persona, difficulty: any.difficulty, pattern: any.pattern, tests: any.tests, expected: any.expected || [], cells, spread: sc.length ? Math.max(...sc) - Math.min(...sc) : 0,
             /* every model was asked and got it wrong — "not possible" use cases were asked of none (review 3.7.1) */
             all_fail: models.every(m => { const u = find(m, id); return u && ['wrong', 'partial'].includes(u.outcome); }), why: why || '—' };
  });

  const kinds = [...new Set(grid.map(g => g.kind))];
  const byKind = kinds.map(k => ({ kind: k, n: grid.filter(g => g.kind === k).length,
    scores: Object.fromEntries(models.map(m => [m.model, r0(avg(m.data.use_cases.filter(u => u.kind === k).map(u => u.score)))])) }));
  const areaNames = [...new Set(grid.map(g => g.area).filter(Boolean))];
  const byArea = areaNames.map(a => ({ area: a, n: grid.filter(g => g.area === a).length,
    scores: Object.fromEntries(models.map(m => [m.model, r0(avg(m.data.use_cases.filter(u => u.area === a).map(u => u.score)))])) }));

  const classes = [...new Set(models.flatMap(m => m.data.friction.map(f => f.class)))];
  const frictionByModel = classes.map(c => {
    const row = { class: c, label: CLASS_LABEL[c] || c, cause: null, cells: {} };
    for (const m of models) { const f = m.data.friction.find(x => x.class === c); if (f) row.cause = row.cause || f.cause; row.cells[m.model] = f ? { tests: f.tests, recovered: f.recovered_pct } : { tests: 0, recovered: null }; }
    return row;
  }).sort((a, b) => Object.values(b.cells).reduce((x, c) => x + c.tests, 0) - Object.values(a.cells).reduce((x, c) => x + c.tests, 0));

  /* a problem every model has is ours to fix; one only some models have is a model limit */
  const allFail = grid.filter(g => g.all_fail);
  const fixList = [
    ...frictionByModel.filter(f => ['Connector', 'Usage instructions', 'Metadata'].includes(f.cause) && models.every(m => f.cells[m.model].tests > 0))
      .map(f => ({ fix: FIX_TEXT[f.class] || f.label, owner: f.cause, evidence: `${Object.values(f.cells).reduce((x, c) => x + c.tests, 0)} tests across ${models.length} models`, weight: Object.values(f.cells).reduce((x, c) => x + c.tests, 0), example: null })),
    ...(models[0]?.data.gaps || []).filter(g => g.whose === CDATA_GAP).map(g => {
      const blocked = Math.min(...models.map(m => m.data.gaps.find(x => x.id === g.id)?.blocked ?? 0));
      return blocked ? { fix: `${g.status === 'partly' ? 'Complete' : 'Expose'}: ${g.label}`, owner: 'Connector', evidence: `${blocked} use case${(blocked) === 1 ? '' : 's'} blocked on every model`, weight: blocked * 3, example: null } : null;
    }).filter(Boolean),
  ].sort((a, b) => b.weight - a.weight).map((f, i) => ({ rank: i + 1, ...f }));

  let base = null;
  if (baseline) {
    base = { eval_id: baseline.eval_id, date: baseline.date, rows: [], regressions: [] };
    for (const m of models) {
      const before = baseline.models?.find(x => x.model === m.model);
      if (!before) continue;
      let up = 0, same = 0, down = 0;
      for (const u of m.data.use_cases) {
        const b = before.scores?.[u.id]; if (!Number.isFinite(b) || !Number.isFinite(u.score)) continue;
        const d = u.score - b;
        if (d >= 5) up++; else if (d <= -5) { down++; base.regressions.push({ id: u.id, request: u.request, model: m.model, before: b, now: u.score }); } else same++;
      }
      base.rows.push({ model: m.model, before: before.score, now: per.find(p => p.model === m.model)?.score, up, same, down });
    }
    base.regressions.sort((a, b) => (a.now - a.before) - (b.now - b.before));
    base.regressions = base.regressions.slice(0, 15);
  }

  const fixed = models[0]?.data.run.fixed_models || {};
  const judgeConflict = [...new Set(Object.entries(fixed).filter(([k, v]) => /judge/.test(k) && names.includes(v)).map(([, v]) => v))];
  const analysis = analyseEval(models, { fixList, judgeConflict, harnessWarn });
  /* correct rate over the use cases a model was actually asked — the comparison the leaderboard ranks on */
  for (const p of per) { const s = analysis.stats.find(x => x.model === p.model); Object.assign(p, { correct_pct: s.correct_pct, decided: s.n, partial: s.partial, wrong: s.wrong, not_possible: s.not_possible, blocked: s.blocked, not_measured: s.not_measured }); }
  per.sort((a, b) => (b.correct_pct ?? -1) - (a.correct_pct ?? -1) || (b.score ?? -1) - (a.score ?? -1));
  for (const g of grid) { const c = analysis.cases.find(x => x.id === g.id); if (c) Object.assign(g, { agreement: c.agreement, discrimination: c.discrimination, behaviour: c.behaviour }); }
  const best = per[0];
  const jobs = byKind.find(k => k.kind === 'job');
  const weakJobs = jobs ? names.filter(n => Number.isFinite(jobs.scores[n]) && jobs.scores[n] < 60) : [];
  const priced = per.filter(p => Number.isFinite(p.cost_per_100));
  const value = priced.length && best ? priced.filter(p => (best.score - p.score) <= 10).sort((a, b) => a.cost_per_100 - b.cost_per_100)[0] : null;
  const findings = [
    best && { title: analysis.executive.decisive ? `${best.model} is most often right` : `${best.model} leads, but not decisively`,
      text: `${best.correct} of ${best.decided} decided use cases correct (${best.correct_pct}%). ${analysis.pairs.find(p => p.a === best.model || p.b === best.model)?.verdict || ''}.` },
    value && value.model !== best.model && Number.isFinite(best.cost_per_100) && best.cost_per_100 > 0 && { title: `${value.model} is the best value`, text: `Within ${best.score - value.score} points of ${best.model} at ${Math.round(100 * value.cost_per_100 / best.cost_per_100)}% of its cost per correct answer.` },
    allFail.length && { title: `${allFail.length} use case${(allFail.length) === 1 ? '' : 's'} fail on every model`, text: `Not all are connector gaps: ${Object.entries(analysis.fail_all.owners).map(([k, v]) => `${v} ${k === 'mixed' ? 'mixed causes' : k === 'ai' ? "the models' own mistakes" : (CAUSE_LABEL[k] || k).toLowerCase()}`).join(', ')}. See Connector vs model.` },
    weakJobs.length && { title: `${weakJobs.join(', ')} struggle${weakJobs.length === 1 ? 's' : ''} with multi-step jobs`, text: `Average below 60 on jobs (read, decide, act).` },
  ].filter(Boolean);

  const journeys = Object.fromEntries(ids.map(id => [id, Object.fromEntries(models.map(m => { const u = find(m, id);
    /* how the answer was checked, so the side-by-side view can say it in words (the capability report has the full detail) */
    return [m.model, u ? { score: u.score, grade: u.grade, result: u.result, verdict: u.verdict || null, steps: u.steps || [], metrics: u.metrics || null, answer: u.answer,
      check: u.check ? { rule: u.check.rule || null, detail: u.check.detail || '' } : null, reason: u.reason || null, cause: u.cause || null,
      probe: u.probe ? { outcome: u.probe.outcome, detail: u.probe.detail || '' } : null,
      second_judge: u.second_judge ? { agree: !!u.second_judge.agree, outcome: u.second_judge.outcome || null } : null,
      clarify: u.clarify ? { answer: u.clarify.answer || '', reply: u.clarify.reply || '' } : null } : null]; }))]));

  return { eval_id: evalId, connector: models[0]?.data.connector, date: new Date().toISOString().slice(0, 10),
    catalog_version: models[0]?.data.run.catalog_version, fingerprint: models[0]?.data.run.fingerprint,
    models: names, leaderboard: per, findings, grid, by_kind: byKind, by_area: byArea, friction: frictionByModel,
    fix_list: fixList, baseline: base, journeys, analysis,
    method: { runs: models.map(m => ({ model: m.model, run_id: m.run_id, reused: !!m.reused })), fixed, judge_conflict: judgeConflict, harness_warn: !!harnessWarn,
      attempts: Object.fromEntries(models.map(m => { const a = m.data.use_cases.map(u => u.attempts?.length || 1); return [m.model, { one: a.filter(x => x === 1).length, several: a.filter(x => x > 1).length }]; })) } };
}
