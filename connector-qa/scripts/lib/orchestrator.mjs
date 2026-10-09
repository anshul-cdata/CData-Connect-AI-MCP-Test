/* orchestrator.mjs — which model should orchestrate this connector's run? (3.9)
 *
 * The orchestrator is the session itself, so it cannot be assigned, only advised: Step 0 reads the
 * session's model (get_session) and compares it with this suggestion. Advice never blocks — the hard
 * gate stays `config.models.required_orchestrator`. The classification reads only what is on disk:
 *
 *   machine-readable API description, or no vendor business API (a database, files, generic REST)   → sonnet
 *   API list assembled from web docs (api-from-docs.mjs), or assembled without evidence and so to be
 *       rebuilt that way first (type assembled_unverified, 3.9.2)                                    → sonnet,
 *       unless judgement is still left to the orchestrator (pages neither extracted nor excluded, or
 *       many connector tables no documented operation acts on)                                       → opus
 *   a large platform: tables, capabilities or business areas above config thresholds                → opus
 *   many business areas researched in one session                                                   → opus
 *
 * Haiku is never suggested: the orchestrator decides what runs next, reviews mappings and talks to the
 * user. Thresholds: config.models.orchestrator_advice.
 */
export const ADVICE_DEFAULTS = { enabled: true, max_tables: 400, max_capabilities: 500, max_areas: 12, max_areas_per_session: 4, max_unmatched_tables: 25 };
const RANK = { haiku: 1, sonnet: 2, opus: 3 };
/** The model family of a model id or alias (claude-opus-5-5 → opus); null when unknown. */
export const familyOf = m => { const s = String(m || '').toLowerCase(); return Object.keys(RANK).find(k => s.includes(k)) || null; };

/**
 * @param {{knowledge?: object|null, capsDoc?: object|null, api?: object|null, inventory?: object|null, scopeAreas?: number|null, apiState?: {status: string}|null}} on  what is on disk (apiState: lib/api-provenance.mjs)
 * @param {object} cfg  config.models.orchestrator_advice
 * @returns {{suggested: 'sonnet'|'opus'|null, type: string, reasons: string[], judgement: string[]}}
 */
export function orchestratorAdvice(on = {}, cfg = {}) {
  const C = { ...ADVICE_DEFAULTS, ...(cfg || {}) };
  const tables = (on.knowledge?.objects || []).length;
  const caps = (on.capsDoc?.capabilities || []).length;
  const areas = (on.capsDoc?.areas || []).length;
  const kind = on.capsDoc?.source?.kind || (on.api?.info?.['x-assembled']?.rung) || (on.capsDoc ? 'spec' : null);
  if (!on.knowledge && !on.capsDoc && !on.api) return { suggested: null, type: 'unknown', reasons: ['nothing discovered yet — ask again after Stage 1.5'], judgement: [] };

  const type = on.apiState?.status === 'unverified' ? 'assembled_unverified'
    : !on.capsDoc && !on.api ? 'no_vendor_api' : kind === 'spec' ? 'spec' : ['postman'].includes(kind) ? 'spec' : 'assembled';
  const reasons = [], judgement = [];
  const opus = [];
  if (tables > C.max_tables) opus.push(`a large platform: ${tables} tables (more than ${C.max_tables})`);
  if (caps > C.max_capabilities) opus.push(`a large platform: ${caps} API capabilities (more than ${C.max_capabilities})`);
  if (areas > C.max_areas) opus.push(`a large platform: ${areas} business areas (more than ${C.max_areas})`);
  if (on.scopeAreas != null && on.scopeAreas > C.max_areas_per_session) opus.push(`${on.scopeAreas} business areas researched in one session (more than ${C.max_areas_per_session})`);
  if (type === 'assembled' || type === 'assembled_unverified') {
    /* the assembly itself is scripted and done by agents; what can remain is judgement on the orchestrator */
    const waiting = (on.inventory?.pages || []).filter(p => ['pending', 'saved'].includes(p.status)).length;
    const unmatched = on.api?.info?.['x-assembled']?.review?.tables_without_operations?.length ?? 0;
    /* reading and excluding pages is light, rule-led work (sonnet); sorting many unmatched tables is not */
    if (waiting) judgement.push(`${waiting} reference page(s) still to read or exclude (light: the rules are in 10a-page-reader.md)`);
    if (unmatched > C.max_unmatched_tables) {
      const j = `${unmatched} connector tables have no documented operation — deciding which are missed pages and which are the connector's own views`;
      judgement.push(j); opus.push(`API list assembled from web docs, with judgement left: ${j}`);
    }
  }
  if (opus.length) return { suggested: 'opus', type: opus.some(r => r.startsWith('a large platform')) ? 'large_platform' : type, reasons: opus, judgement };
  reasons.push(type === 'spec' ? `the API list comes from a machine-readable description (${kind})`
    : type === 'assembled_unverified' ? 'the API list was assembled without evidence; it is rebuilt with api-from-docs.mjs first, and that assembly is scripted and done by agents'
    : type === 'assembled' ? 'the API list is assembled from web docs, and the assembly is scripted and done by agents — nothing left to judge on the orchestrator'
    : 'no vendor business API to read (a database, files or a generic interface): discovery is the connector\'s own metadata');
  return { suggested: 'sonnet', type, reasons, judgement };
}

/** Is the session model below the suggestion? Unknown families are never called below. */
export function belowSuggestion(actual, suggested) {
  const a = RANK[familyOf(actual)], s = RANK[familyOf(suggested)];
  return !!(a && s && a < s);
}

/** The run details line: "Orchestrator: claude-sonnet-5-5 (suggested opus — reason)". */
export function orchestratorLine(o) {
  if (!o?.actual) return null;
  return `${o.actual}${o.suggested ? ` (suggested ${o.suggested}${o.reasons?.length ? ` — ${o.reasons.join('; ')}` : ''})` : ''}`;
}
