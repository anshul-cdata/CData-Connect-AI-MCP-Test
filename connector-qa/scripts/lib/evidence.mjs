/* evidence.mjs — how strong the evidence is that real people want a use case.
 *
 * Observed behaviour first, an AI's inference last, and never presented as equal. Shared by the
 * reports (pill, sort, filter, counts) and by the catalog (near-duplicate candidates: the better
 * evidenced one is kept). A source kind maps to one level:
 *
 *   customer   customer_dump
 *   community  community
 *   vendor     help_center · template · standard_report · integration_template · vendor_use_case
 *   docs       developer_docs · product_docs
 *   inferred   inferred, or no source
 */
export const EVIDENCE_LABEL = { customer: 'Customer queries', community: 'Real users (community)', vendor: 'Vendor guidance (help, templates, reports)',
  docs: 'Documentation', inferred: 'Inferred (no direct evidence)' };
export const EVIDENCE_RANK = { customer: 5, community: 4, vendor: 3, docs: 2, inferred: 1 };
/* 3.9: the vendor's own use case, workflow, tutorial and "how to" pages are vendor guidance */
export const VENDOR_KINDS = ['help_center', 'template', 'standard_report', 'integration_template', 'vendor_use_case'];
export function evidenceOf(src) {
  const k = src?.kind;
  if (k === 'customer_dump') return 'customer';
  if (k === 'community') return 'community';
  if (VENDOR_KINDS.includes(k)) return 'vendor';
  if (['developer_docs', 'product_docs'].includes(k)) return 'docs';
  return 'inferred';
}
/** 1 (inferred, or no source) … 5 (customer queries) for a use case. */
export const evidenceRank = u => EVIDENCE_RANK[evidenceOf(u?.source)];
