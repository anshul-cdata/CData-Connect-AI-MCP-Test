/**
 * vocabulary.mjs — the shared names every stage must agree on.
 *
 * Stage 5 writes the coverage model; Stage 8 generates tests from it. They each carried their own
 * list of behaviour names, and only THREE of ten strings matched. The seven that did not fell
 * through to a fallback that interpolated a field Stage 5 never writes, so seven tests shipped
 * with the literal word "undefined" as the question the agent was asked. Nothing failed: the
 * coverage model was valid, the plan was valid, and the tests were nonsense.
 *
 * The same class of drift has appeared three times in this pipeline — `covered` state names,
 * `not_applicable` handling, and this. A name used by two stages belongs in one place, and a
 * validator that reads that place is the only thing that keeps them honest.
 */

/** Behaviours the generator can write a real prompt for. Stage 5 must not invent others. */
export const BEHAVIORS = [
  /* the agent's handling of a result that is empty, wrong, or ambiguous */
  'empty_result_handling',
  'empty_result_interpretation',
  'error_recovery',
  'wrong_column_recovery',
  'wrong_table_recovery',
  'ambiguity_clarification',
  'ambiguity_handling',
  /* what it does at a boundary */
  'permission_boundary',
  'required_filter_handling',
  'unsupported_request_handling',
  'invalid_input_handling',
  'large_result_guarding',
  'pagination_handling',
  /* what it works out for itself */
  'schema_discovery',
  'join_key_discovery',
  'date_function_correctness',
  'write_confirmation',
];

/** Coverage states. Must match lib/coverage-state.mjs, which decides which of them mean "done".
 *  `semantically_understood` is what Stage 3 writes once an object has meaning but no test yet —
 *  it was missing from the first draft of this list, which would have rejected every real run. */
export const STATES = [
  'discovered', 'semantically_understood', 'uncovered', 'not_covered', 'partially_covered',
  'covered', 'tested', 'fully_covered', 'not_applicable', 'not_testable', 'failed',
];

/** Tiers are strings. Stage 3's reference doc once showed numeric `tier: 1`, which credit-coverage
 *  filters as `=== 'T1'` — a numeric tier silently yields zero T1 objects and no error. */
export const TIERS = ['T1', 'T2', 'T3', 'T4'];

/** Fault owners (00-contracts.md §4). */
export const OWNERS = ['owner-ai', 'owner-driver', 'owner-schema', 'owner-ok'];

/** Verdict codes (00-contracts.md §3). */
export const VERDICTS = [
  'pass', 'pass_sql', 'pass_col', 'pass_tbl', 'pass_schema', 'pass_dtype', 'pass_query',
  'partial', 'fail', 'boundary', 'not_exec', 'na', 'nt', 'ne',
];

/** Gap categories (00-contracts.md §6). */
export const GAP_CATEGORIES = [
  'EXPOSURE', 'OBJECT', 'SCHEMA', 'BUSINESS', 'WORKFLOW', 'QUERY',
  'INTENT', 'PROCEDURE', 'RELATIONSHIP', 'BEHAVIOR', 'CUSTOMER',
];

/* Levenshtein, small and iterative. The common failure here is a typo — a dropped letter in
 * "empty_result_interpretation" — and containment matching finds nothing for those, which turns a
 * one-character slip into an unexplained rejection. */
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Report an unknown value against a known set, naming the near miss when there is one. */
export function unknown(value, known, what) {
  if (known.includes(value)) return null;
  const v = String(value || '').toLowerCase();
  /* exact-but-for-case, then punctuation, then containment, then closest by edit distance —
   * capped at a quarter of the word so an unrelated name is not suggested as a correction */
  let near = known.find(k => k.toLowerCase() === v)
    || known.find(k => k.toLowerCase().replace(/_/g, '') === v.replace(/_/g, ''))
    || known.find(k => k.toLowerCase().includes(v) || v.includes(k.toLowerCase()));
  if (!near && v) {
    const limit = Math.max(1, Math.ceil(v.length / 4));
    let best = null, bestD = Infinity;
    for (const k of known) { const d = editDistance(v, k.toLowerCase()); if (d < bestD) { bestD = d; best = k; } }
    if (bestD <= limit) near = best;
  }
  return `unknown ${what}: "${value}"` + (near ? ` — did you mean "${near}"?` : '');
}
