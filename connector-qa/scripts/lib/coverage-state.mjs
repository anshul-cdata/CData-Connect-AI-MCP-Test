/* What counts as "already covered", for every dimension and every script.
 *
 * This lived as six separate inline predicates in compute-gaps.mjs and a seventh in
 * generate-tests.mjs. They disagreed about `not_applicable`: compute-gaps opened a gap for a
 * relationship or behaviour in that state, and generate-tests refused to write a test for one —
 * so the gap could never be closed by anything. A single definition removes the class of bug.
 *
 * `not_testable` is deliberately NOT here. It means "we could not test it", the gap stays open
 * and visible, and the run reports it (00-contracts.md §4).
 */
export const COVERED_STATES = new Set([
  'covered',            // the coverage model's generic done state
  'tested',             // objects and procedures
  'fully_covered',      // an object with every objective met
  'not_applicable',     // correctly not supported — no gap, no defect
]);

export const isCovered = state => COVERED_STATES.has(String(state || ''));
