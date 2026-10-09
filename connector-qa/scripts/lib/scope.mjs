/* scope.mjs — research, test, run and evaluate a connector area by area, without losing work (3.1).
 *
 * A large connector cannot be researched well in one pass: one researcher spread over nine areas
 * skims all of them. So the expensive, generative work — research — is done per business area, in
 * batches small enough to stay focused, and everything after it is cumulative:
 *
 *   research   batches per area (≤ max_areas_per_batch areas, ≤ max_capabilities_per_batch)
 *   catalog    frozen per area (lib/catalog.mjs) — finance can be frozen months after sales
 *   results    reused per USE CASE: a stored result stands while its use case's hash and the
 *              environment (connector build, instructions, workspace) are unchanged
 *   reports    built from the newest valid result of every use case, across every stored run
 *
 * Nothing here calls a model. It decides what exists, what is still valid and what is left to do.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { liveUseCases, areaUseCases, areaFreezeState, ucHash, ucKeys, areaCompleteness } from './catalog.mjs';
import { listRuns, readRun, envKeyOf } from './results.mjs';
import { boundValues, recordId } from './fixtures.mjs';

export const SCOPE_DEFAULTS = { max_areas_per_batch: 3, max_capabilities_per_batch: 60, max_areas_per_run: 6 };

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Turn what a person typed (`sales,Task management,tm`) into area ids. Matches an id, a name or a
 * slug of either, case-insensitively. Unknown names are returned, never guessed.
 * @returns {{ids: string[], unknown: string[]}}
 */
export function resolveAreas(capsDoc, list) {
  const areas = capsDoc?.areas || [];
  const ids = [], unknown = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split(',')).map(s => String(s).trim()).filter(Boolean)) {
    const k = slug(raw);
    const exact = areas.find(a => slug(a.id) === k || slug(a.name) === k);
    /* a prefix only when it names exactly one area — "pro" with Projects and Procurement is refused */
    const pre = k.length >= 3 ? areas.filter(a => slug(a.name).startsWith(k)) : [];
    const hit = exact || (pre.length === 1 ? pre[0] : null);
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else unknown.push(pre.length > 1 ? `${raw} (matches ${pre.map(a => a.name).join(', ')})` : raw);
  }
  return { ids, unknown };
}

/** The applicable capabilities of an area, flows included. */
export function areaCapabilities(capsDoc, areaId) {
  const area = (capsDoc?.areas || []).find(a => a.id === areaId);
  if (!area) return [];
  const byId = new Map((capsDoc.capabilities || []).map(c => [c.id, c]));
  return [...new Set([...(area.capability_ids || []), ...(area.flows || []).flatMap(f => f.capability_ids || [])])]
    .filter(id => byId.get(id) && byId.get(id).mapping?.status !== 'not_applicable');
}

const personasOf = area => (area?.personas || []).map(p => typeof p === 'string' ? p : p?.name).filter(Boolean);

/**
 * Split areas into research batches a single researcher can do well. Whole areas are grouped
 * while the batch stays within both limits; an area bigger than the capability limit is split
 * along its flows (and a flowless one along its capability list), so no researcher is ever handed
 * more than it can cover properly.
 */
export function researchBatches(capsDoc, areaIds, limits = {}) {
  const L = { ...SCOPE_DEFAULTS, ...limits };
  const maxA = Math.max(1, Number(L.max_areas_per_batch)), maxC = Math.max(1, Number(L.max_capabilities_per_batch));
  const areas = areaIds.map(id => (capsDoc?.areas || []).find(a => a.id === id)).filter(Boolean);
  const batches = [];
  let cur = null;
  const flush = () => { if (cur && cur.areas.length) batches.push(cur); cur = null; };
  for (const ar of areas) {
    const caps = areaCapabilities(capsDoc, ar.id);
    if (caps.length > maxC) {
      flush();
      /* each capability is researched once: a capability two flows share goes with the first, and a
       * flow bigger than the limit is itself split */
      const seen = new Set();
      const flows = [];
      for (const f of ar.flows || []) {
        const own = (f.capability_ids || []).filter(c => caps.includes(c) && !seen.has(c));
        own.forEach(c => seen.add(c));
        chunk(own, maxC).forEach((cs, i, all) => flows.push({ id: all.length > 1 ? `${f.id}.${i + 1}` : f.id, caps: cs }));
      }
      const loose = caps.filter(c => !seen.has(c));
      const units = [...flows, ...chunk(loose, maxC).map((cs, i) => ({ id: `${ar.id}-rest${i + 1}`, caps: cs }))];
      let part = null;
      for (const u of units) {
        if (part && part.capability_ids.length + u.caps.length > maxC) { batches.push(part); part = null; }
        if (!part) part = { areas: [ar.id], flows: [], capability_ids: [], personas: personasOf(ar), split: true };
        part.flows.push(u.id); part.capability_ids.push(...u.caps);
      }
      if (part) batches.push(part);
      continue;
    }
    if (cur && (cur.areas.length >= maxA || cur.capability_ids.length + caps.length > maxC)) flush();
    if (!cur) cur = { areas: [], flows: null, capability_ids: [], personas: [] };
    cur.areas.push(ar.id); cur.capability_ids.push(...caps);
    for (const p of personasOf(ar)) if (!cur.personas.includes(p)) cur.personas.push(p);
  }
  flush();
  return batches;
}
const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Pairs of related areas that are both frozen and have had no cross-area pass yet. */
export function crossDue(capsDoc, cat, researchPlan) {
  const done = new Set((researchPlan?.batches || []).filter(b => b.cross && b.status === 'done').map(b => [...b.areas].sort().join('+')));
  const out = [];
  for (const a of capsDoc?.areas || []) for (const r of a.related || []) {
    const key = [a.id, r].sort().join('+');
    if (out.includes(key) || done.has(key)) continue;
    if (areaFreezeState(cat, a.id) === 'frozen' && areaFreezeState(cat, r) === 'frozen') out.push(key);
  }
  return out;
}

/* ── stored results, per use case ─────────────────────────────────────────── */

const keyOf = r => `${r.use_case_id || r.tc_id}#${r.variant || 0}`;
/* An outcome that is a measurement. "Not run" (writes were off, or no file), "awaiting judgement"
 * and "not checked" are not: reusing them would freeze an undecided result into every later run. */
export const DECIDED = new Set(['correct', 'partial', 'wrong', 'not_possible', 'no_test_data', 'blocked_account', 'blocked_connector']);
export const runEnvKey = m => envKeyOf(m?.fingerprint);

/**
 * The newest valid stored result of every use case in scope, for one model.
 *
 * A key (use case × variant) is valid from a run when that run was measured in this environment,
 * its records carry the use case's CURRENT hash, and every attempt the run planned for it left a
 * result. Older runs fill in keys newer ones did not cover, which is what makes partial runs
 * cumulative. A key whose newest result fails a test is reported as stale or incomplete, never
 * silently dropped.
 *
 * "Not possible" is a measurement of the capability mapping, so with `capsDoc` it is valid only
 * while one of the use case's capabilities is still not exposed.
 * @param {{model: string, cat: object, env: string, areas?: string[]|null, capsDoc?: object}} q
 */
export function latestResults(root, conn, { model, cat, env, areas = null, capsDoc = null, testData = null }) {
  /* 3.7.1: a result that ran on fixtures stays valid while those fixtures are bound to the same records */
  const bound = boundValues(testData);
  const sameData = rs => rs.every(r => !r.fixtures || Object.entries(r.fixtures).every(([id, v]) => bound[id] && String(recordId(bound[id])) === String(v)));
  const capStatus = new Map((capsDoc?.capabilities || []).map(c => [c.id, c.mapping?.status]));
  const ucCaps = new Map(liveUseCases(cat).map(u => [u.id, u.capabilities || []]));
  const stillBlocked = id => !capsDoc || (ucCaps.get(id) || []).some(c => ['not_exposed', 'product_only'].includes(capStatus.get(c)));
  const want = new Map();                                   // key → current use case hash
  for (const u of liveUseCases(cat)) {
    if (areas && !areas.includes(u.area)) continue;
    const h = ucHash(u);
    for (const k of ucKeys(u)) want.set(k, h);
  }
  const chosen = new Map(), stale = new Map(), incomplete = new Map(), runsUsed = new Map();
  let conformance = null, conformanceRun = null;
  for (const m of listRuns(root, conn)) {                   // newest first
    if (m.model !== model) continue;
    const sameEnv = runEnvKey(m) === env;
    const run = readRun(root, conn, m.run_id);
    const groups = new Map();
    for (const r of run.records) {
      if (r.suite !== 'business' || !r.use_case_id) continue;
      const k = keyOf(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const [k, rs] of groups) {
      if (!want.has(k) || chosen.has(k)) continue;
      const fresh = sameEnv && rs.every(r => r.uc_hash && r.uc_hash === want.get(k)) && sameData(rs);
      /* a test held for data and never dispatched (3.7) decided nothing: once data is seeded it must run */
      const undecided = rs.find(r => !DECIDED.has(r.outcome) || (['no_test_data', 'blocked_account'].includes(r.outcome) && !(r.steps || []).length));
      const unblocked = rs.some(r => r.outcome === 'not_possible') && !stillBlocked(rs[0].use_case_id);
      /* A call the test harness refused never reached the connector. If the attempt still ended
       * right, the agent worked round it and the result stands; otherwise the harness, not the
       * model or the connector, may have decided it — it is measured again. */
      const harnessHit = rs.find(r => r.outcome !== 'correct' && (r.steps || []).some(s => !s.ok && s.cause === 'harness'));
      if (fresh && !undecided && !unblocked && !harnessHit) { chosen.set(k, rs); runsUsed.set(m.run_id, m); stale.delete(k); incomplete.delete(k); }
      else if (stale.has(k) || incomplete.has(k)) continue;
      else if (!fresh) stale.set(k, { run_id: m.run_id, why: !sameEnv ? 'measured on a different connector build, instructions or workspace' : !sameData(rs) ? 'its test data is now bound to other records' : 'the use case changed since this result' });
      else if (unblocked) stale.set(k, { run_id: m.run_id, why: 'was not possible, but its capabilities are exposed now' });
      else if (harnessHit && !undecided) incomplete.set(k, { run_id: m.run_id, why: `attempt ${harnessHit.attempt || 1} was blocked by the test harness and did not end correct — re-run it` });
      else incomplete.set(k, { run_id: m.run_id, why: `${String(undecided.outcome).replace(/_/g, ' ')}${undecided.reason ? ': ' + undecided.reason : ''}` });
    }
    /* driver conformance checks have no stable id across plans: the newest run of this environment that has them */
    if (!conformance && sameEnv) {
      const conf = run.records.filter(r => r.suite !== 'business');
      if (conf.length) { conformance = conf; conformanceRun = m.run_id; runsUsed.set(m.run_id, m); }
    }
  }
  const missing = [...want.keys()].filter(k => !chosen.has(k) && !stale.has(k) && !incomplete.has(k));
  return {
    records: [...chosen.values()].flat(), conformance: conformance || [], conformance_run: conformanceRun,
    valid: new Set(chosen.keys()), stale, incomplete, missing, wanted: want,
    runs: [...runsUsed.values()].map(m => ({ run_id: m.run_id, finished_at: m.finished_at || null, model: m.model })),
    chosen_from: new Map([...chosen].map(([k, rs]) => [k, rs[0].run_id])),
  };
}

/* ── per-area status ──────────────────────────────────────────────────────── */

export function readEvals(root, conn) {
  const d = join(root, '_results', conn, 'evals');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

/**
 * Where every area stands, from what is on disk. Research: not_started · researching (a batch is
 * pending) · needs_review (researched, not frozen) · frozen · changed (edited since its freeze).
 * Then whether its use cases are in the current plan, how many have a valid result for the model,
 * how many are stale, and which evals covered it.
 */
export function areaStatus({ capsDoc, cat, researchPlan, plan, results, evals = [], cfgCatalog = {} }) {
  const planned = new Set((plan?.full_tc_list || plan?.tc_list || []).filter(t => t.use_case_id).map(t => t.use_case_id));
  return (capsDoc?.areas || []).map(ar => {
    const ucs = areaUseCases(cat, ar.id);
    const batches = (researchPlan?.batches || []).filter(b => b.areas.includes(ar.id) && b.status !== 'superseded');
    const pending = batches.filter(b => b.status !== 'done');
    const freeze = areaFreezeState(cat, ar.id);
    let research;
    if (freeze === 'frozen') research = 'frozen';
    else if (freeze === 'changed') research = 'changed';
    else if (pending.length) research = 'researching';
    else if (ucs.length) research = 'needs_review';
    else research = 'not_started';
    const keys = ucs.flatMap(ucKeys);
    const ex = results ? {
      total: keys.length, valid: keys.filter(k => results.valid.has(k)).length,
      stale: keys.filter(k => results.stale.has(k)).length, incomplete: keys.filter(k => results.incomplete.has(k)).length,
    } : null;
    const comp = cat ? areaCompleteness(cat, capsDoc, ar.id) : null;
    const ids = new Set(ucs.map(u => u.id));
    return {
      id: ar.id, name: ar.name, capabilities: areaCapabilities(capsDoc, ar.id).length, personas: personasOf(ar),
      research, version: cat?.areas?.[ar.id]?.version ?? null, use_cases: ucs.length,
      batches: { total: batches.length, pending: pending.length },
      completeness: comp ? { covered: comp.caps_covered, total: comp.caps_total, personas_missing: comp.personas_missing.length, ok: comp.ok } : null,
      planned: ucs.filter(u => planned.has(u.id)).length,
      executed: ex,
      evaluated: evals.filter(e => (e.areas || []).includes(ar.id) || Object.keys(e.models?.[0]?.scores || {}).some(k => ids.has(k.split('#')[0]))).map(e => e.eval_id),
    };
  });
}

/** One short next step for an area, in the order the work has to happen. */
export function nextStep(s) {
  if (s.research === 'not_started') return 'research';
  if (s.research === 'researching') return `finish research (${s.batches.pending} batch${s.batches.pending === 1 ? '' : 'es'} pending)`;
  if (s.research === 'needs_review' || s.research === 'changed') return s.completeness && !s.completeness.ok ? 'fill research gaps, then review and freeze' : 'review and freeze';
  if (s.executed && s.executed.valid < s.executed.total) return s.executed.stale ? `re-run ${s.executed.stale} stale` : 'execute';
  return 'done';
}
