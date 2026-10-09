/* catalog.mjs — the approved set of real business use cases for a connector.
 *
 * The catalog is built once (Stage 5.5), reviewed, frozen as a version, and then reused by every
 * run and every eval. That is what makes results comparable: the same use cases, worded the same
 * way, checked by the same rule, run after run and model after model. Use case ids are permanent
 * (UC-<PREFIX>-0001) and never renumbered — plan ids (TC-001) change every generation and cannot
 * be compared across runs.
 *
 * A use case is only admitted with evidence (a source), a structure (who, when, goal, how often,
 * which capabilities), wording that passes the realism lint, and a check that can decide whether
 * an answer was right. This module validates all of that mechanically; the wording and the
 * realism judgement are a model's, the human sample is a person's.
 */
import { createHash } from 'node:crypto';
import { lintPrompt, adviseRequest } from './realism.mjs';
import { RULES, cleanupProblems, isYesNo, ID_RULES } from './checks.mjs';
import { changesExisting, cleanupPathFor } from './capabilities.mjs';
import { fixtureProblems, fixtureRefs, withExamples, HARDCODED_ID } from './fixtures.mjs';
import { evidenceOf, evidenceRank, EVIDENCE_LABEL } from './evidence.mjs';

/**
 * 3.9 — two candidates ask nearly the same thing: keep the better evidenced one (lib/evidence.mjs:
 * customer queries > real users > vendor guidance > documentation > inferred).
 *   keep_existing   the one already there is as well or better evidenced: the newcomer is dropped
 *   replace         the newcomer is better evidenced and the other is still a draft: it takes its place
 *   note_stronger   the newcomer is better evidenced but the other is approved or in a frozen area:
 *                   nothing changes; the stronger page is recorded beside it for the next review
 * @param {object} incoming  the new candidate
 * @param {object} existing  the near-duplicate already in the catalog (or earlier in the same batch)
 * @param {{frozen?: boolean}} ctx  whether the existing one's area is frozen
 */
export function nearDuplicateChoice(incoming, existing, { frozen = false } = {}) {
  if (evidenceRank(incoming) <= evidenceRank(existing)) return 'keep_existing';
  return !frozen && (!existing.status || existing.status === 'draft') ? 'replace' : 'note_stronger';
}

export const KINDS = ['question', 'action', 'job'];
/* 3.9: vendor_use_case — the vendor's own use case, workflow, tutorial or "how to" page (vendor guidance) */
export const SOURCE_KINDS = ['help_center', 'template', 'standard_report', 'community', 'developer_docs',
  'integration_template', 'customer_dump', 'product_docs', 'vendor_use_case', 'inferred'];
/* An inferred use case has no written evidence: not every real request is posted publicly. When the
 * research finds a real workflow but no written example of the request, the writer may infer one. Only
 * the wording is inferred, never the work: it cites evidence that people really do the workflow
 * (source.url, opened and checked like any other source), names it (source.title) and says why a real
 * person asks it (source.reason). A workflow with no evidence of real use gets no use case. It
 * is reported as inferred — never as equal to observed behaviour — and is sampled first for the human
 * review. An area may hold at most catalog.max_inferred_share of them, so evidence stays the backbone. */
export const INFERRED_DEFAULT_SHARE = 0.3;
export const FREQUENCY = ['daily', 'weekly', 'monthly', 'periodic', 'occasional'];

/* What a use case asks of the AI, beyond reading the request and finding the data (which every use
 * case tests). Tagged by the writer; counted per area so a missing kind of request is a listed gap. */
export const DIFFICULTY = ['simple', 'medium', 'complex'];
export const SKILLS = ['filters', 'dates', 'aggregation', 'relationships', 'multi_step', 'write', 'ambiguity', 'missing_info', 'limitation'];
export const SKILL_LABEL = {
  simple: 'simple', medium: 'medium', complex: 'complex',
  filters: 'filters and conditions', dates: 'dates and relative dates', aggregation: 'sorting, grouping, totals',
  relationships: 'links between objects', multi_step: 'several dependent steps', write: 'changes data',
  ambiguity: 'ambiguous request', missing_info: 'missing information', limitation: 'not possible — must say so',
};
/* The fewest use cases of each kind an area needs before it can be frozen, unless the writer
 * explains why the area has no realistic request of that kind (`mix_explained`). A floor, never a
 * quota: the area still holds every real workflow, however many that is. */
export const MIX_DEFAULTS = { simple: 1, medium: 1, complex: 2, dates: 2, aggregation: 2, relationships: 2, write: 1, ambiguity: 1, missing_info: 1, limitation: 1 };
export const PERSONA_DEFAULTS = { min_per_persona: 2, max_persona_share: 0.5, persona_overlap: 0.5 };
/* the judge decides these: asking, or stating an assumption and answering, are both right */
const JUDGED_SKILLS = ['ambiguity', 'missing_info'];
const isDraft = u => u.status !== 'approved';

const STOP = new Set(('a an the of to in on for and or with my our me i we is are be this that what which who '
  + 'how do does show give list find all any each every from by at as it its your their there here '
  + 'mine ours yours theirs please right now currently just me us can could would you').split(' '));
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));

/** Token Jaccard similarity of two requests, 0..1. */
export function similarity(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / new Set([...A, ...B]).size;
}

/** Give every use case without an id the next permanent one; never touch an existing id. */
export function assignIds(cat, prefix) {
  const pfx = String(prefix || cat.prefix || 'XXX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'XXX';
  const re = new RegExp(`^UC-${pfx}-(\\d+)$`);
  let max = 0;
  for (const u of cat.use_cases || []) { const m = re.exec(u.id || ''); if (m) max = Math.max(max, Number(m[1])); }
  let added = 0;
  for (const u of cat.use_cases || []) if (!u.id) { u.id = `UC-${pfx}-${String(++max).padStart(4, '0')}`; added++; }
  cat.prefix = pfx;
  return added;
}

/* key order must not change a hash: a catalog re-serialised by another tool is the same catalog */
export const canon = v => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const h12 = x => createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 12);

/* What a result depends on, per use case: its id, wording (variants included — each is
 * dispatched), kind, writes and check. Notes, scores, sources and reviews do not count. */
const ucCore = u => [u.id, u.request, u.variants || [], u.kind, u.writes ?? null, canon(u.check || null), ...(u.follow_up ? [canon(u.follow_up)] : [])];

/** One use case's hash. A stored result stays valid for exactly as long as this does — adding
 * other use cases, or other areas, never invalidates it (3.1, references/13-scope.md). */
export const ucHash = u => h12(ucCore(u));

/** A stable hash over every live use case — the whole catalog. */
export function catalogHash(cat) {
  const core = (cat.use_cases || []).filter(u => u.status !== 'retired').map(ucCore)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return h12(core);
}

/* ── business areas (3.1) ──────────────────────────────────────────────────────
 * The catalog is researched, reviewed and frozen area by area. A use case belongs to one area
 * (`area`); a cross-area flow also lists the others it touches (`also_areas`). Each area keeps its
 * own version and hash in `cat.areas[<id>]`, so finance can be frozen months after sales without
 * reopening it. */
export const liveUseCases = cat => (cat?.use_cases || []).filter(u => u.status !== 'retired');
export const areaUseCases = (cat, areaId) => liveUseCases(cat).filter(u => u.area === areaId);
/* 3.7: an area's fixtures are part of what was frozen — changing how a record is found or seeded
 * changes what the tests run on. An area without fixtures hashes exactly as before. */
export const areaHash = (cat, areaId) => {
  const core = areaUseCases(cat, areaId).map(ucCore).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  /* only what decides the test data — not when or by which batch it was added */
  const FX_KEYS = ['id', 'table', 'describe', 'find_sql', 'seed', 'example', 'depends_on'];
  const fx = (cat?.fixtures || []).filter(f => f.area === areaId).map(f => canon(Object.fromEntries(FX_KEYS.filter(k => f[k] !== undefined).map(k => [k, f[k]])))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return h12(fx.length ? [core, fx] : core);
};

/** 'frozen' · 'changed' (edited since its freeze) · 'unfrozen' (use cases, never frozen) · 'empty' */
export function areaFreezeState(cat, areaId) {
  const st = cat?.areas?.[areaId];
  const n = areaUseCases(cat, areaId).length;
  if (st?.frozen) return st.hash === areaHash(cat, areaId) ? 'frozen' : 'changed';
  return n ? 'unfrozen' : 'empty';
}
export const isAreaFrozen = (cat, areaId) => areaFreezeState(cat, areaId) === 'frozen';

/** The catalog is frozen as a whole when every business area — of the capability list when given,
 * else every area with use cases — is frozen and unchanged. */
export function wholeFrozen(cat, areaIds = null) {
  const areas = areaIds?.length ? areaIds : [...new Set(liveUseCases(cat).map(u => u.area).filter(Boolean))];
  return areas.length > 0 && areas.every(a => isAreaFrozen(cat, a));
}

/** Every key a run produces for a use case: the request and each variant. */
export const ucKeys = u => [0, ...(u.variants || []).map((_, i) => i + 1)].map(v => `${u.id}#${v}`);

/**
 * Is the area's research complete? Every applicable capability in the area is used by at least one
 * use case of the area (or a cross-area one that lists it), or is explained under
 * `cat.no_business_use`; and every persona the area names has at least one use case. The vendor's
 * own API is the denominator, so "did we miss anything?" is a count, not a matter of trust.
 */
export function areaCompleteness(cat, capsDoc, areaId) {
  const area = (capsDoc?.areas || []).find(a => a.id === areaId);
  if (!area) return { ok: false, missing_caps: [], explained: [], personas_missing: [], caps_total: 0, caps_covered: 0, note: `no area ${areaId} in the capability list` };
  const capById = new Map((capsDoc.capabilities || []).map(c => [c.id, c]));
  const ids = [...new Set([...(area.capability_ids || []), ...(area.flows || []).flatMap(f => f.capability_ids || [])])]
    .filter(id => capById.get(id) && capById.get(id).mapping?.status !== 'not_applicable');
  const mine = liveUseCases(cat).filter(u => u.area === areaId || (u.also_areas || []).includes(areaId));
  const used = new Set(mine.flatMap(u => u.capabilities || []));
  const why = new Map((cat?.no_business_use || []).filter(n => String(n.reason || '').trim().split(/\s+/).length >= 3).map(n => [n.capability_id, n.reason]));
  const missing = ids.filter(id => !used.has(id) && !why.has(id));
  const personas = (area.personas || []).map(p => typeof p === 'string' ? p : p?.name).filter(Boolean);
  const personasMissing = personas.filter(p => !mine.some(u => u.area === areaId && u.persona === p));
  return {
    caps_total: ids.length, caps_covered: ids.length - missing.length,
    missing_caps: missing.map(id => ({ id, label: capById.get(id)?.label || id })),
    explained: ids.filter(id => !used.has(id) && why.has(id)).map(id => ({ id, reason: why.get(id) })),
    personas_missing: personasMissing,
    ok: !missing.length && !personasMissing.length,
  };
}

/** A reason counts when it says something: three words or more. */
const reasoned = r => String(r || '').trim().split(/\s+/).length >= 3;
/** The writer's reasons an area has no realistic request of some kind: `need` is a mix key
 * (`ambiguity`, `complex`…) or `persona:<name>`. */
export const mixExplained = (cat, areaId) => new Map((cat?.mix_explained || [])
  .filter(x => x.area === areaId && reasoned(x.reason)).map(x => [x.need, x.reason]));

/**
 * The kinds of request an area holds — difficulty and the skills each use case tests — against the
 * floors in `MIX_DEFAULTS` (or `catalog.mix`). A kind below its floor is `missing` unless the writer
 * explained it. Untagged use cases are counted as such, never guessed.
 */
export function areaMix(cat, areaId, floors = {}) {
  const F = { ...MIX_DEFAULTS, ...floors };
  const ucs = areaUseCases(cat, areaId);
  const counts = Object.fromEntries([...DIFFICULTY, ...SKILLS].map(k => [k, 0]));
  for (const u of ucs) {
    if (DIFFICULTY.includes(u.difficulty)) counts[u.difficulty]++;
    for (const t of new Set(Array.isArray(u.tests) ? u.tests : [])) if (t in counts) counts[t]++;
  }
  const why = mixExplained(cat, areaId);
  const short = Object.entries(F).filter(([k, min]) => Number(min) > 0 && (counts[k] ?? 0) < Number(min));
  return {
    counts, floors: F, total: ucs.length,
    untagged: ucs.filter(u => !DIFFICULTY.includes(u.difficulty) || !Array.isArray(u.tests)).length,
    missing: short.filter(([k]) => !why.has(k)).map(([k, min]) => ({ need: k, have: counts[k] ?? 0, min: Number(min), label: SKILL_LABEL[k] || k })),
    explained: short.filter(([k]) => why.has(k)).map(([k]) => ({ need: k, reason: why.get(k) })),
  };
}

/**
 * Is the area's work spread across its personas, and does each persona ask its own questions?
 * `thin`: a persona with fewer than `min_per_persona` use cases (unless explained as
 * `persona:<name>`). `dominant`: one persona holding more than `max_persona_share` of the area.
 * `overlaps`: two personas asking much the same thing — a generic question copied across roles.
 */
export function personaBalance(cat, capsDoc, areaId, cfg = {}) {
  const C = { ...PERSONA_DEFAULTS, ...cfg };
  const area = (capsDoc?.areas || []).find(a => a.id === areaId);
  const ucs = areaUseCases(cat, areaId);
  const named = (area?.personas || []).map(p => typeof p === 'string' ? p : p?.name).filter(Boolean);
  const counts = {};
  for (const p of named) counts[p] = 0;
  for (const u of ucs) if (u.persona) counts[u.persona] = (counts[u.persona] || 0) + 1;
  const why = mixExplained(cat, areaId);
  const thin = named.filter(p => counts[p] < Number(C.min_per_persona) && !why.has(`persona:${p}`))
    .map(p => ({ persona: p, have: counts[p], min: Number(C.min_per_persona) }));
  const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  const dominant = top && ucs.length >= 6 && top[1] / ucs.length > Number(C.max_persona_share)
    ? { persona: top[0], count: top[1], share: Math.round(100 * top[1] / ucs.length) / 100 } : null;
  const overlaps = [];
  for (let i = 0; i < ucs.length; i++) for (let j = i + 1; j < ucs.length; j++) {
    if (ucs[i].persona === ucs[j].persona) continue;
    const s = similarity(ucs[i].request, ucs[j].request);
    if (s >= Number(C.persona_overlap)) overlaps.push({ ids: [ucs[i].id, ucs[j].id], personas: [ucs[i].persona, ucs[j].persona], similarity: Math.round(s * 100) / 100 });
  }
  return { counts, thin, dominant, overlaps };
}

/* ── coverage review (whole area) ─────────────────────────────────────────────
 * The per-use-case checks cannot see what is absent. Before an area is frozen, a fresh reviewer
 * reads the area's whole set and lists what is missing, redundant or low value; the writer answers
 * every finding (added, retired, reworded, or kept with a reason). The review is tied to the set of
 * use cases, not their wording, so the realism judge's rewording does not void it — but adding or
 * retiring use cases after the answers does. */
export const FINDING_TYPES = ['missing_workflow', 'missing_persona', 'missing_cross_object', 'missing_action',
  'missing_ambiguity', 'missing_negative', 'missing_limitation', 'missing_complex', 'redundant', 'low_value', 'off_persona', 'off_area'];
export const ANSWER_ACTIONS = ['added', 'retired', 'reworded', 'kept'];
/** Which use cases an area holds, not how they are worded. */
export const areaSetHash = (cat, areaId) => h12(areaUseCases(cat, areaId).map(u => u.id).sort());

/** Where an area's coverage review stands: ok, or the reason it does not yet count. */
export function coverageReviewState(cat, areaId) {
  const rv = cat?.areas?.[areaId]?.coverage_review;
  if (!rv) return { ok: false, reason: 'no coverage review yet (manage-catalog.mjs review-prep, then agents/catalog-reviewer.md, then review-merge)' };
  const open = (rv.findings || []).filter(f => !rv.answers?.[f.n]);
  if (open.length) return { ok: false, open: open.length, reason: `${open.length} coverage-review finding(s) not answered (${open.slice(0, 4).map(f => f.n).join(', ')}) — manage-catalog.mjs review-answer` };
  const settled = rv.set_after || rv.set_hash;
  if (settled !== areaSetHash(cat, areaId)) return { ok: false, reason: 'use cases were added or retired since the coverage review was answered — review the area again' };
  return { ok: true, findings: (rv.findings || []).length };
}

/**
 * Check a writer's answers to coverage-review findings against the catalog. An answer must name a
 * known finding and a known action; `added` and `reworded` name live use cases of the area,
 * `retired` names retired ones, and `kept` gives a reason.
 */
export function answerProblems(cat, areaId, answers) {
  const rv = cat?.areas?.[areaId]?.coverage_review;
  if (!rv) return [`${areaId}: no coverage review to answer`];
  const known = new Set((rv.findings || []).map(f => f.n));
  const byId = new Map((cat.use_cases || []).map(u => [u.id, u]));
  const out = [];
  for (const x of answers) {
    const at = `${areaId} ${x.finding}`;
    if (!known.has(x.finding)) { out.push(`${at}: no such finding`); continue; }
    if (!ANSWER_ACTIONS.includes(x.action)) { out.push(`${at}: action must be ${ANSWER_ACTIONS.join(' | ')}`); continue; }
    const ids = x.ids || [];
    if (x.action === 'kept') { if (!reasoned(x.reason)) out.push(`${at}: kept needs a reason`); continue; }
    if (!ids.length) { out.push(`${at}: ${x.action} must name the use case(s)`); continue; }
    for (const id of ids) {
      const u = byId.get(id);
      if (!u) out.push(`${at}: ${id} is not in the catalog`);
      else if (x.action === 'retired' && u.status !== 'retired') out.push(`${at}: ${id} is not retired (manage-catalog.mjs retire)`);
      else if (x.action !== 'retired' && (u.status === 'retired' || u.area !== areaId)) out.push(`${at}: ${id} is not a live use case of ${areaId}`);
    }
  }
  return out;
}

/** Why a use case's evidence does not yet count. Empty when it does. */
export function sourceProblems(u, { verify = true } = {}) {
  const s = u.source || {};
  if (s.kind === 'customer_dump') return [];
  if (s.kind === 'inferred' && String(s.reason || '').trim().split(/\s+/).length < 5) return ['an inferred use case must say in source.reason why a real person would ask it'];
  /* only the wording may be inferred, never the work: an inferred use case cites evidence that people
   * really do this workflow, and that page is checked like any other source */
  if (!s.url) return [s.kind === 'inferred' ? 'an inferred use case needs a source URL showing the workflow is really used' : 'no source URL — a cited page must be checkable'];
  if (!verify) return [];
  const v = s.verified;
  if (!v || v.url !== s.url) return ['source not checked yet (manage-catalog.mjs sources-prep)'];
  if (v.status !== 'found') return [`source ${v.status.replace('_', ' ')}: ${s.url}`];
  return [];
}

/** Names a reference query pins (an IN list of names, or a Name/Title equality) that the request
 * never mentions — the reference then answers a narrower question than the one asked (asn-eval1
 * "Which projects are at risk or off track?" checked against three seeded projects by name). */
export function referenceNarrows(sql, request) {
  const s = String(sql || ''), req = String(request || '').toLowerCase();
  const where = /\bWHERE\b([\s\S]*)$/i.exec(s)?.[1] || '';
  const names = new Set();
  for (const m of where.matchAll(/\[?([A-Za-z_]*(?:name|title|label)[A-Za-z_]*)\]?\s*(?:=|IN\s*\()\s*((?:'[^']*'\s*,?\s*)+)/gi))
    for (const lit of m[2].matchAll(/'([^']*)'/g)) names.add(lit[1]);
  const mentioned = n => { const w = n.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 3); return !w.length || w.some(x => req.includes(x)); };
  const out = [...names].filter(n => n && !/^\{\{.*\}\}$/.test(n) && !/%/.test(n) && !mentioned(n));
  /* several records pinned by raw id: nobody names a record by its id, so the request never covers them */
  for (const m of where.matchAll(/\bIN\s*\(\s*((?:'\d{6,}'\s*,?\s*){2,})\)/gi)) out.push(`${(m[1].match(/'/g) || []).length / 2} records by id`);
  return out;
}

/**
 * Everything mechanical about a catalog. `problems` block a freeze; `warnings` are for review.
 * @param {object} cat
 * @param {{capabilities?: object[], schema?: {objects: string[], procedures: string[]}, dedup?: number}} ctx
 */
export function validateCatalog(cat, ctx = {}) {
  const problems = [], warnings = [];
  const caps = new Map((ctx.capabilities || []).map(c => [c.id, c]));
  const ucs = (cat.use_cases || []).filter(u => u.status !== 'retired');
  if (!ucs.length) problems.push('the catalog has no use cases');
  const ids = new Set();
  let untagged = 0;
  for (const u of ucs) {
    const at = u.id || `"${String(u.request || '').slice(0, 40)}"`;
    if (u.id) { if (ids.has(u.id)) problems.push(`${u.id} is used twice`); ids.add(u.id); }
    if (!u.request || String(u.request).trim().split(/\s+/).length < 3) problems.push(`${at}: no request, or too short to be one`);
    if (!u.persona) problems.push(`${at}: no persona — who asks this?`);
    if (!u.goal) problems.push(`${at}: no goal — why do they ask?`);
    if (!u.area) problems.push(`${at}: no business area`);
    else if (ctx.areas?.length && !ctx.areas.includes(u.area)) problems.push(`${at}: area ${u.area} is not a business area of the capability list (${ctx.areas.join(', ')})`);
    if (u.also_areas != null && (!Array.isArray(u.also_areas) || u.also_areas.some(x => x === u.area || (ctx.areas?.length && !ctx.areas.includes(x)))))
      problems.push(`${at}: also_areas must list other business areas of the capability list`);
    if (!KINDS.includes(u.kind)) problems.push(`${at}: kind must be ${KINDS.join(' | ')}`);
    /* Difficulty and skill tags. Use cases approved before the tags existed keep their freeze (the
     * tags are not part of a use case's hash, so adding them later invalidates no result). */
    if (u.difficulty == null) { if (isDraft(u)) problems.push(`${at}: no difficulty — ${DIFFICULTY.join(' | ')}`); else untagged++; }
    else if (!DIFFICULTY.includes(u.difficulty)) problems.push(`${at}: difficulty must be ${DIFFICULTY.join(' | ')}`);
    if (u.tests == null) { if (isDraft(u)) problems.push(`${at}: no tests — which of ${SKILLS.join(', ')} does it ask of the AI? ([] when none)`); }
    else if (!Array.isArray(u.tests)) problems.push(`${at}: tests must be a list`);
    else {
      const bad = u.tests.filter(t => !SKILLS.includes(t));
      if (bad.length) problems.push(`${at}: tests has ${bad.join(', ')} — use ${SKILLS.join(', ')}`);
      const writes = u.kind === 'action' || u.writes === true;
      if (writes && !u.tests.includes('write')) warnings.push(`${at}: changes data but tests does not list write`);
      if (!writes && u.tests.includes('write')) warnings.push(`${at}: tests lists write but the use case does not change data`);
      /* whether asking was the right move is not something a query can decide */
      if (u.tests.some(t => JUDGED_SKILLS.includes(t)) && u.check?.rule && u.check.rule !== 'judge')
        (isDraft(u) ? problems : warnings).push(`${at}: an ambiguity or missing_info use case is decided by the judge (check.rule: judge), with every acceptable response in expected_behavior`);
    }
    if (u.frequency && !FREQUENCY.includes(u.frequency)) warnings.push(`${at}: frequency "${u.frequency}" is not one of ${FREQUENCY.join(', ')}`);
    const src = u.source || {};
    if (!src.kind || !src.title) problems.push(`${at}: no source — a use case must cite the evidence that people do this`);
    else if (!SOURCE_KINDS.includes(src.kind)) warnings.push(`${at}: source kind "${src.kind}" is not a known kind`);
    if (!Array.isArray(u.capabilities) || !u.capabilities.length) problems.push(`${at}: names no capability — what must the source be able to do?`);
    else if (caps.size) for (const c of u.capabilities) if (!caps.has(c)) problems.push(`${at}: capability ${c} is not in the capability list`);
    const ch = u.check || {};
    if (!RULES.includes(ch.rule)) problems.push(`${at}: check.rule must be one of ${RULES.join(', ')}`);
    else if (ch.rule !== 'judge' && !ch.reference_sql) problems.push(`${at}: a ${ch.rule} check needs reference_sql`);
    if (['same_ids', 'contains', 'values_within'].includes(ch.rule) && !ch.key) problems.push(`${at}: a ${ch.rule} check needs a key column`);
    if (u.kind === 'action' && ch.rule && !['write_visible', 'judge'].includes(ch.rule)) warnings.push(`${at}: an action is usually checked with write_visible`);
    /* 3.5: data_sql — the records the use case is about. Checked before the run (an empty account is
     * caught before an agent is paid for), and given to the answer judge, so "nobody is
     * over-allocated" over an empty account is no test, not a pass. */
    const aboutRequest = (u.tests || []).some(t => ['ambiguity', 'missing_info', 'limitation'].includes(t));
    if (ch.rule === 'judge' && u.kind !== 'action' && !ch.data_sql && !aboutRequest) warnings.push(`${at}: a judged question should give check.data_sql — the records it is about — so an empty account is caught before the run and the judge sees the real data`);
    if (u.kind === 'action' && !ch.data_sql && caps.size && changesExisting(u.capabilities, caps)) warnings.push(`${at}: changes an existing record — give check.data_sql (the record to change) so a missing record is caught before the run`);
    /* without expected values, any row that already existed would pass */
    if (ch.rule === 'write_visible' && !(ch.expect && Object.keys(ch.expect).length)) problems.push(`${at}: a write_visible check needs expect — the values the change must show`);
    /* a job reads, decides and acts; whether it writes decides the write policy, batching and cleanup */
    if (u.kind === 'job' && typeof u.writes !== 'boolean') problems.push(`${at}: a job must say whether it changes data (writes: true | false)`);
    if (u.kind === 'action' && u.writes === false) warnings.push(`${at}: an action with writes: false — is it really an action?`);
    if (ch.cleanup_sql) {
      const tablesOf = (u.capabilities || []).flatMap(id => (caps.get(id)?.mapping?.exposure || []).filter(e => e.kind === 'table').map(e => e.name));
      for (const p of cleanupProblems(ch.cleanup_sql, tablesOf)) problems.push(`${at}: cleanup_sql ${p}`);
      if (/\{\{located\}\}/.test(ch.cleanup_sql) && !ch.locate_sql) problems.push(`${at}: cleanup_sql uses {{located}} but there is no locate_sql to find those records`);
    }
    if ((u.kind === 'action' || u.writes === true) && ch.cleanup_sql && /\bIN\s*\(\s*(…|\.\.\.)\s*\)/.test(ch.cleanup_sql)) problems.push(`${at}: cleanup_sql has a placeholder list — use {{located}} with a locate_sql`);
    /* 3.6 — checks that cannot decide the request (asn-eval1: 11 use cases every model "failed", at
     * least 3 of them check defects). A problem for a new draft, a warning on an approved one: a
     * frozen area is never reopened by a new rule. */
    const flag = (msg) => (isDraft(u) ? problems : warnings).push(`${at}: ${msg}`);
    if (u.kind !== 'action' && ID_RULES.has(ch.rule) && isYesNo(u.request, u.expected_behavior))
      flag(`a yes/no question checked by ${ch.rule} on record ids — the answer is a yes or a no, not rows. Use judge with data_sql (the records it is about), or same_count`);
    /* only a question decided on rows: an action's reference legitimately locates its target, and a
     * judged answer is read against the request by the judge */
    const narrow = u.kind !== 'action' && ch.rule !== 'judge' && ch.rule !== 'write_visible' ? referenceNarrows(ch.reference_sql, [u.request, ...(u.variants || [])].join(' ')) : [];
    if (narrow.length) flag(`the reference limits itself to ${narrow.slice(0, 3).map(x => `"${x}"`).join(', ')}, which the request never names — a correct answer covering everything the request asks would be marked wrong. Name the scope in the request, or widen the reference`);
    /* 3.6 — evidence strength: the checker grades each page; priority should not outrun it */
    const v = u.source?.verified;
    if (v?.status === 'found' && v.support === 'weak') warnings.push(`${at}: the source only weakly supports this use case (${v.note || 'the checker rated it weak'}) — find a stronger one, or keep it knowing that`);
    if ((u.priority === 'P1' || u.frequency === 'daily') && (v?.support === 'weak' || ['third_party', 'vendor_page', 'api_doc'].includes(v?.page_kind) || u.source?.kind === 'inferred'))
      warnings.push(`${at}: marked daily (P1, three attempts) on ${v?.support === 'weak' ? 'weak' : u.source?.kind === 'inferred' ? 'inferred' : String(v?.page_kind).replace('_', ' ')} evidence — does real use show it is daily?`);
    for (const adv of adviseRequest(u.request)) warnings.push(`${at}: ${adv}`);
    /* 3.7 — cleanup that can actually run through ConnectAI MCP: an UPDATE that restores the record,
     * or a delete procedure. Its tools reject DELETE, so a DELETE cleanup would fail every attempt. */
    if (ch.cleanup_sql && /^\s*DELETE\b/i.test(ch.cleanup_sql))
      warnings.push(`${at}: ` + 'cleanup_sql is a DELETE, which ConnectAI MCP cannot run — use cleanup_procedure (a delete procedure), an UPDATE that restores the record, or leave it (the report lists records left behind)');
    if (ch.cleanup_procedure) {
      const cp = ch.cleanup_procedure;
      if (!cp.name) problems.push(`${at}: cleanup_procedure needs a name`);
      else if ((ctx.schema?.procedures || []).length && !ctx.schema.procedures.map(p => String(p).toLowerCase()).includes(String(cp.name).toLowerCase()))
        warnings.push(`${at}: cleanup_procedure ${cp.name} is not a procedure of this connector`);
      if (JSON.stringify(cp.parameters || {}).includes('{{located}}') && !ch.locate_sql) problems.push(`${at}: cleanup_procedure uses {{located}} but there is no locate_sql to find those records`);
    }
    if ((u.kind === 'action' || u.writes === true) && !ch.cleanup_sql && !ch.cleanup_procedure && caps.size) {
      const path = (u.capabilities || []).map(id => caps.get(id)).filter(c => c && /^POST$/i.test(c.method || '')).map(c => cleanupPathFor(c, [...caps.values()])).find(Boolean);
      if (path) warnings.push(`${at}: what it creates can be removed with the procedure ${path.procedure} — add locate_sql and cleanup_procedure, so the record does not stay in the account`);
    }
    /* a read → decide → act job should say which records to watch, so a change it should not make is seen */
    if (u.kind === 'job' && u.writes === true && !ch.scope_sql) warnings.push(`${at}: a job that writes should give check.scope_sql — the records around its change — so a side effect is caught`);
    /* 3.7 — a hard or ambiguous request is worth a second wording: whether the outcome holds across
     * phrasings is a robustness signal, and with one wording a single attempt is close to a coin toss */
    if ((u.difficulty === 'complex' || (u.tests || []).includes('ambiguity')) && !(u.variants || []).length)
      warnings.push(`${at}: a ${u.difficulty === 'complex' ? 'complex' : 'ambiguous'} request with one wording — add a variant, so the report can tell skill from luck`);
    /* 3.7 — a scripted second turn: the user's fixed reply to a clarifying question, and how the
     * finished job is checked */
    if (u.follow_up) {
      const f = u.follow_up;
      if (!f.reply || String(f.reply).trim().split(/\s+/).length < 2) problems.push(`${at}: follow_up.reply must be what the user answers — a short phrase, the same for every model`);
      if (f.check && !RULES.includes(f.check.rule)) problems.push(`${at}: follow_up.check.rule must be one of ${RULES.join(', ')}`);
      if (f.check?.rule === 'write_visible' && !(f.check.expect && Object.keys(f.check.expect).length)) problems.push(`${at}: a write_visible follow_up check needs expect`);
      if (!(u.tests || []).some(t => ['ambiguity', 'missing_info'].includes(t))) warnings.push(`${at}: has a follow_up but is not tagged ambiguity or missing_info — a second turn answers a clarifying question`);
    }
    /* 3.7: a check names records by fixture, never by one account's ids */
    const idIn = ['reference_sql', 'data_sql', 'locate_sql', 'cleanup_sql', 'scope_sql'].filter(k => ch[k] && HARDCODED_ID.test(ch[k]));
    if (idIn.length) flag(`${idIn.join(', ')} name${idIn.length === 1 ? 's' : ''} records by an account's ids — define a fixture and use {{fixture:<name>.Id}}, so the check works on any account`);
    /* a request is linted as a reader sees it: fixture names replaced by their examples */
    const lint = lintPrompt(withExamples(u.request, cat), ctx.schema || {});
    if (lint.length) problems.push(`${at}: ${lint.map(i => i.detail).join('; ')}`);
    for (const v of u.variants || []) { const l = lintPrompt(withExamples(v, cat), ctx.schema || {}); if (l.length) problems.push(`${at} variant: ${l[0].detail}`); }
  }
  const th = Number(ctx.dedup ?? 0.8);
  const dupes = [];
  for (let i = 0; i < ucs.length; i++) for (let j = i + 1; j < ucs.length; j++) {
    const s = similarity(ucs[i].request, ucs[j].request);
    if (s >= th) dupes.push([ucs[i].id || i, ucs[j].id || j, Math.round(s * 100) / 100]);
  }
  const byKey = new Map(ucs.map((u, i) => [u.id || i, u]));
  for (const [a, b, s] of dupes) {
    const ra = evidenceRank(byKey.get(a)), rb = evidenceRank(byKey.get(b));
    const keep = ra === rb ? '' : ` — keep ${ra > rb ? a : b} (${EVIDENCE_LABEL[evidenceOf((ra > rb ? byKey.get(a) : byKey.get(b)).source)].toLowerCase()} beats ${EVIDENCE_LABEL[evidenceOf((ra > rb ? byKey.get(b) : byKey.get(a)).source)].toLowerCase()})`;
    warnings.push(`${a} and ${b} ask nearly the same thing (similarity ${s}) — merge or make them differ${keep}`);
  }
  problems.push(...fixtureProblems(cat));
  if (untagged) warnings.push(`${untagged} approved use case(s) have no difficulty or tests tags — the area mix cannot count them (adding tags changes no result)`);
  /* per use case, so one area can be frozen while another still has problems */
  const problemsById = {};
  for (const u of ucs) if (u.id) problemsById[u.id] = problems.filter(p => p.startsWith(`${u.id}:`) || p.startsWith(`${u.id} variant`));
  /* fixture problems belong to the fixture's area, so a freeze cannot ignore them */
  const problemsByArea = {};
  for (const f of cat.fixtures || []) { const ps = problems.filter(p => p.startsWith(`fixture ${f.id}`)); if (ps.length) (problemsByArea[f.area] = problemsByArea[f.area] || []).push(...ps); }
  return { problems, warnings, duplicates: dupes, count: ucs.length, problemsById, problemsByArea };
}

/**
 * A deterministic sample for the human review, spread across areas and personas. With `areas`,
 * only those areas; use cases no person has rated yet come first, so a later sample for an area
 * that grew reviews what is new rather than what was already seen.
 */
export function sampleForReview(cat, n = 20, { areas = null } = {}) {
  const ucs = (cat.use_cases || []).filter(u => u.status !== 'retired' && (!areas || areas.includes(u.area)));
  /* rated = rated as it is worded now; a reworded use case lost its rating and comes first again */
  const wording = new Map(ucs.map(u => [u.id, u.request]));
  const rated = new Set(Object.values(cat.areas || {}).flatMap(a => (a.human_review?.ratings || []).filter(r => wording.get(r.id) === r.request).map(r => r.id)));
  const h = s => createHash('sha1').update(String(s)).digest('hex');
  const groups = new Map();
    /* unrated first, and among them the inferred ones: a person should look hardest at what has no written evidence */
  const inf = u => u.source?.kind === 'inferred' ? 1 : 0;
  /* 3.7: where the two realism judges disagree, a person decides first */
  const split = u => u.realism && u.realism_second && u.realism_second.judged_request === u.request && Math.abs(u.realism.score - u.realism_second.score) >= 2 ? 1 : 0;
  for (const u of [...ucs].sort((a, b) => (rated.has(a.id) - rated.has(b.id)) || (split(b) - split(a)) || (inf(b) - inf(a)) || h(a.id).localeCompare(h(b.id)))) {
    const k = `${u.area}|${u.persona}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  const out = [];
  const queues = [...groups.values()];
  while (out.length < Math.min(n, ucs.length)) {
    let took = false;
    for (const q of queues) { if (q.length && out.length < n) { out.push(q.shift()); took = true; } }
    if (!took) break;
  }
  return out;
}

/** Agreement between the human ratings and the judge's scores: both above, or both below, the bar. */
export function agreement(ucs, ratings, bar = 4) {
  const byId = new Map(ucs.map(u => [u.id, u]));
  let agree = 0, n = 0;
  const disagreements = [];
  for (const r of ratings) {
    const u = byId.get(r.id); const judge = u?.realism?.score;
    if (!u || !Number.isFinite(judge) || !Number.isFinite(Number(r.rating))) continue;
    n++;
    if ((judge >= bar) === (Number(r.rating) >= bar)) agree++;
    else disagreements.push({ id: r.id, judge, human: Number(r.rating), comment: r.comment || '' });
  }
  return { n, agree, rate: n ? agree / n : null, disagreements };
}

/**
 * Does an area's human review still stand? Ratings count only for use cases still worded as the
 * person saw them. The review survives a few additions (a cross-area pass adds some) but not an
 * area that has grown by more than `human_regrow` since — then the new use cases are sampled.
 * @param {{min_score?: number, min_agreement?: number, human_min_per_area?: number, human_regrow?: number}} C
 */
export function areaHumanCheck(cat, areaId, C = {}) {
  const rev = cat?.areas?.[areaId]?.human_review;
  const ucs = areaUseCases(cat, areaId);
  if (!rev) return { ok: false, reason: 'no human review yet (manage-catalog.mjs sample --areas ' + areaId + ')' };
  const byId = new Map(ucs.map(u => [u.id, u]));
  const valid = (rev.ratings || []).filter(r => byId.get(r.id)?.request === r.request);
  const ratedIds = new Set(valid.map(r => r.id));
  /* added after the review: within the allowance they do not count against it */
  const since = ucs.filter(u => !ratedIds.has(u.id) && u.added_at && rev.at && u.added_at > rev.at).length;
  const need = Math.min(Number(C.human_min_per_area ?? 5), ucs.length - since);
  if (valid.length < need) return { ok: false, reason: `${valid.length} of the ${need} human ratings needed are for use cases as they are worded now` };
  const ag = agreement(ucs, valid, Number(C.min_score ?? 4));
  if (ag.rate == null || ag.rate < Number(C.min_agreement ?? 0.8))
    return { ok: false, reason: `human agreement ${ag.rate == null ? '—' : Math.round(ag.rate * 100) + '%'} is below ${Math.round(Number(C.min_agreement ?? 0.8) * 100)}%` };
  const allowance = Math.max(3, Math.ceil(Number(C.human_regrow ?? 0.25) * (ucs.length - since)));
  if (since > allowance) return { ok: false, reason: `${since} use cases were added since the human review — sample the new ones` };
  return { ok: true, n: valid.length, agree: ag.agree, rate: ag.rate, since };
}
