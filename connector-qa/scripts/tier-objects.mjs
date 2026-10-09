/* Tier every object under the business-model weights of 04-coverage-model.md §5.1.
 *
 * Tiering used to be done by hand in Stage 5, which made it the one number in the pipeline that
 * could not be reproduced: the same connector tiered differently on different runs, and nothing
 * recorded why an object landed where it did. Every signal here is computable from knowledge.json
 * before a single business query runs — the connector's own workflow model, its relationship
 * graph, its role matrix and its personas.
 *
 * Customer usage is deliberately NOT a signal. It enters only as a tiebreak inside Stage 7's gap
 * scoring, so a connector with no dump tiers identically to one with a dump. See the invariant in
 * 04-coverage-model.md §5.4 and tests/dump-parity.test.mjs.
 *
 *   node tier-objects.mjs --dir <connectorDir> [--apply]
 *
 * Without --apply it prints the proposed tiering and changes nothing, so the move can be reviewed
 * before it rewrites the coverage model.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseArgs } from './lib/cli.mjs';
import { loadConfig } from './lib/artifacts.mjs';

const cfg = loadConfig();

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'apply'],
  usage: 'usage: tier-objects.mjs --dir <connectorDir> [--apply]',
});
if (!a.dir) { console.error('usage: tier-objects.mjs --dir <connectorDir> [--apply]'); process.exit(2); }

let conn = a.connector || (a.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop());
/* The connector name came from the directory's basename, so this script alone refused to run in a
 * directory not named after the connector — unlike generate-tests and export-jdbc-suite, which
 * find their artifacts. Same discovery here: fall back to whatever *_knowledge.json is present. */
let kPath = join(a.dir, `${conn}_knowledge.json`);
/* Discovery is a convenience for when the caller did not say which connector. When they DID say,
 * an unmatched name is an error: silently retargeting `--connector Salesforce` at the only
 * Demo_*.json in the directory rewrites the wrong connector's tiering and exits 0. */
if (!existsSync(kPath) && a.connector) {
  console.error(`no knowledge file for connector "${conn}" at ${kPath}`); process.exit(2);
}
if (!existsSync(kPath)) {
  const found = (existsSync(a.dir) ? readdirSync(a.dir) : []).filter(f => /_knowledge\.json$/.test(f));
  if (found.length === 1) { conn = found[0].replace(/_knowledge\.json$/, ''); kPath = join(a.dir, found[0]); }
  else if (found.length > 1) {
    console.error(`${found.length} connectors in ${a.dir} (${found.map(f => f.replace(/_knowledge\.json$/, '')).join(', ')}) — pass --connector to choose`);
    process.exit(2);
  }
}
const cPath = join(a.dir, `${conn}_coverage.json`);
if (!existsSync(kPath)) { console.error(`no knowledge file at ${kPath}`); process.exit(2); }

const K = JSON.parse(readFileSync(kPath, 'utf8'));
const meta = K.connector_meta || {};
const domains = meta.workflow_domains || [];

/* Stage 0.5's output, when the driver source was readable. Optional by design: without it nothing
 * changes and tiering behaves exactly as it did before, so a machine with no driver enlistment
 * still produces a valid run. */
const dsPath = join(a.dir, `${conn}_driver_schema.json`);
let documented = null, FLOOR = 'T2';
if (existsSync(dsPath)) {
  try {
    const ds = JSON.parse(readFileSync(dsPath, 'utf8'));
    if (Array.isArray(ds.documented_objects) && ds.documented_objects.length) {
      documented = new Set(ds.documented_objects.map(n => String(n).toLowerCase()));
      FLOOR = (cfg.defaults && cfg.defaults.documented_tier_floor) || 'T2';
      console.log(`driver schema: ${documented.size} documented object(s) — floored at ${FLOOR}  (${ds.driver_class})\n`);
    }
  } catch (e) { console.error(`  · ignoring unreadable ${basename(dsPath)}: ${e.message}`); }
}

const sing = n => n.replace(/ies$/, 'y').replace(/s$/, '');

/* Workflow prose names objects the way people speak: a workflow about TaskDependencies is written
 * "task dependencies are blocked", and one about TimeTrackingEntries is "log time entries".
 * Matching only the literal CamelCase name missed every one of those, which pushed genuine
 * workflow subjects — dependency chains, time tracking — into T4 alongside junction tables.
 * So the head noun counts too, guarded by length: "Dependencies" and "Entries" identify an
 * object, while "Item", "List" or "Task" are too common to mean anything on their own. */
const headNoun = n => { const w = n.split(/(?=[A-Z])/).filter(Boolean); const last = w[w.length - 1] || '';
  return last.length >= 5 ? last : ''; };

/* A head noun that is itself another object's name identifies nothing: "PremiumWorkspaceTasks"
 * ending in "Tasks" matched every workflow about Tasks and inherited its whole importance, which
 * promoted a premium-gated variant into T1. When the head noun is ambiguous between two objects,
 * only the literal name counts. */
const objNames = new Set((K.objects || []).map(o => o.name.toLowerCase()));
/* Business synonyms from Stage 3 (2.2.0). Persona jobs say "teammate", "owner" and "new hire",
 * never "user" — so Users, the object every assignment points at, scored no persona coupling at
 * all and sat in T2 below Workspaces. A synonym counts exactly like the name. */
const synonymsOf = new Map((K.objects || []).map(o => [o.name.toLowerCase(),
  (o.synonyms || []).map(s => String(s).toLowerCase()).filter(s => s.length > 2)]));
const spaced = n => n.replace(/(?<=[a-z])(?=[A-Z])/g, ' ').toLowerCase();
const named = (text, n) => {
  const t = String(text).toLowerCase();
  if (t.includes(n.toLowerCase()) || t.includes(sing(n).toLowerCase())) return true;
  if (t.includes(spaced(n)) || t.includes(sing(spaced(n)))) return true;
  if ((synonymsOf.get(n.toLowerCase()) || []).some(s => t.includes(s))) return true;
  const h = headNoun(n);
  if (!h || objNames.has(h.toLowerCase())) return false;
  return t.includes(h.toLowerCase()) || t.includes(sing(h).toLowerCase());
};

/* Which object is the SUBJECT of which workflow, and is that workflow a write?
 * A write workflow outranks a read one because a broken write corrupts the source, while a broken
 * read only misinforms — and reads are far more likely to be caught by the person reading them. */
const wfWrite = new Set(), wfRead = new Set();
for (const d of domains) for (const w of d.workflows || []) {
  const t = w.name + ' ' + (w.edge_cases || []).join(' ');
  for (const o of K.objects || []) if (named(t, o.name)) (w.permission === 'write' ? wfWrite : wfRead).add(o.name);
}
const reportText = domains.flatMap(d => d.standard_reports || []).join(' | ');

/* Relationship centrality — the schema's own statement of what everything else depends on. */
const inbound = {};
for (const r of K.relationships || []) inbound[r.to] = (inbound[r.to] || 0) + 1;

/* Role reach — the share of roles holding Full or Edit on the object's domain. An object every
 * role can write is exposed to more ways of being wrong than one only an admin touches. */
const roles = meta.roles || [];
const reachByDomain = {};
/* A business area where EVERY role reads "N" is not a finding about the product — no system
 * ships a feature nobody may use. It is a research defect: asn005's matrix had 7 of 14 Asana
 * domains all-N (Files, Time Tracking, Custom Fields, Forms, Automation, Security, Change
 * Tracking), which silently cost Attachments, TimeTrackingEntries and CustomFields their role
 * reach. Such a domain is scored neutral (null — no signal either way) and reported, never
 * penalised. validate-agent-output.mjs rejects the matrix at Stage 2; this guards older runs. */
const unknownReach = [];
for (const d of domains) {
  const vals = roles.map(r => (r.access || {})[d.id]);
  if (roles.length && vals.every(v => v == null || v === 'N')) { reachByDomain[d.id] = null; unknownReach.push(d.id); continue; }
  const n = roles.filter(r => ['F', 'E'].includes((r.access || {})[d.id])).length;
  reachByDomain[d.id] = roles.length ? n / roles.length : 0;
}
if (unknownReach.length)
  console.error(`⚠ role matrix gives no role any access to ${unknownReach.length} domain(s): ${unknownReach.join(', ')} — `
    + `role reach treated as unknown there. Re-run the role researcher.\n`);

/* How widely the business area is used — the signal tiering never had. Without a customer dump
 * nothing said Tasks matters more than Allocations (an Enterprise add-on), and both came out T1.
 * The domain researcher records `prevalence` per domain from plan availability and how prominent
 * the feature is in the vendor's own documentation; it is a property of the product, not of any
 * customer's usage, so dump parity (§5.4) is preserved. */
const PREVALENCE = { core: 3, common: 1, specialised: 0, specialized: 0, premium: -2 };
const prevalenceByDomain = Object.fromEntries(domains.map(d => [d.id, String(d.prevalence || '').toLowerCase() || null]));
/* Persona coupling — how many distinct personas name this object in a job-to-be-done. */
const personaHits = {};
for (const o of K.objects || []) personaHits[o.name] =
  (meta.personas || []).filter(p => (p.jobs_to_be_done || []).some(j => named(j, o.name))).length;

const rows = [];
for (const o of K.objects || []) {
  let s = 0; const sig = [];
  const add = (w, signal, desc) => { s += w; sig.push({ signal, weight: w, desc }); };

  if (wfWrite.has(o.name))     add(4, 'write workflow subject', 'a defect here corrupts the source system');
  else if (wfRead.has(o.name)) add(3, 'read workflow subject', 'carries a documented end-to-end workflow');
  if (named(reportText, o.name)) add(3, 'vendor standard report', 'the vendor ships a report over this object');

  const fk = inbound[o.name] || 0;
  const cen = Math.min(3, Math.floor(fk / 3));
  if (cen) add(cen, 'relationship centrality', `${fk} inbound relationships`);

  const dom = o.business_domain?.v ?? o.business_domain;
  /* `in`, not `??` — null is the "unknown" answer and must survive the lookup */
  const reach = dom in reachByDomain ? reachByDomain[dom] : 0;
  if (reach === null)    sig.push({ signal: 'role reach', weight: 0, desc: `unknown — the role matrix gives no role access to ${dom}` });
  else if (reach > 0.5)  add(2, 'role reach', `${Math.round(reach * 100)}% of roles hold Full/Edit on ${dom}`);
  else if (reach > 0.25) add(1, 'role reach', `${Math.round(reach * 100)}% of roles hold Full/Edit on ${dom}`);
  /* object-level prevalence wins over the domain's — a premium object inside a core domain
   * (PremiumWorkspaceTasks inside Task Management) is still premium */
  const prev = String(o.prevalence || '').toLowerCase() || prevalenceByDomain[dom];
  if (prev && PREVALENCE[prev] != null && PREVALENCE[prev] !== 0)
    add(PREVALENCE[prev], 'prevalence', `${prev} ${o.prevalence ? 'object' : `business area (${dom})`}`);

  if (o.category === 'core') add(2, 'core category', 'classified core by the semantic pass');

  const pc = Math.min(2, personaHits[o.name] || 0);
  if (pc) add(pc, 'persona coupling', `${personaHits[o.name]} persona job(s) name it`);

  if (['lookup', 'audit', 'reference'].includes(o.category) && !wfWrite.has(o.name) && !wfRead.has(o.name))
    add(-2, 'no workflow of its own', `${o.category} object that no documented workflow acts on`);

  let tier = s >= 10 ? 'T1' : s >= 7 ? 'T2' : s >= 4 ? 'T3' : 'T4';

  /* An object CData chose to document is one the product committed to supporting, and that has to
   * survive a weak business score. A weight could be outvoted — a documented object with no
   * workflow, little role reach and no persona lands T4 and gets shallow coverage — so this is a
   * floor instead: the business model still ranks within the documented set, but cannot rank any
   * of it out. On a connector where getTables() returns thousands, this is what guarantees the
   * ~130 that were actually documented are tested. */
  if (documented && documented.has(o.name.toLowerCase()) && (tier === 'T3' || tier === 'T4')) {
    sig.push({ signal: 'documented by the driver', weight: 0, desc: `floored to ${FLOOR} — shipped as documented surface` });
    tier = FLOOR;
  }
  rows.push({ name: o.name, was: o.tier, tier, score: s, sig, documented: documented ? documented.has(o.name.toLowerCase()) : null });
}

console.log('TIERING — business-model weights (04-coverage-model.md §5.1)\n');
for (const t of ['T1', 'T2', 'T3', 'T4']) {
  const g = rows.filter(r => r.tier === t);
  console.log(`${t}  ${g.length}`);
  for (const r of g.sort((x, y) => y.score - x.score))
    console.log(`   ${String(r.score).padStart(2)}  ${r.name.padEnd(26)}${r.was && r.was !== r.tier ? `was ${r.was}` : ''}`);
}
const moved = rows.filter(r => r.was && r.was !== r.tier);
console.log(`\nmoved tier: ${moved.length}/${rows.length}`);

/* A tiering where everything lands in one tier is not a tiering — it is a signal that the weights
 * found nothing to discriminate on, which in asn004 meant a bug rather than a flat connector. */
const spread = new Set(rows.map(r => r.tier)).size;
if (rows.length > 6 && spread === 1)
  console.error(`\n⚠ every object scored into ${rows[0].tier}. The weights discriminated on nothing — check that workflow_domains, relationships and roles are populated in knowledge.json before trusting this.`);

if (a.apply) {
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  for (const o of K.objects || []) { const r = byName[o.name]; if (!r) continue;
    o.tier = r.tier; o.tier_score = r.score; o.tier_signals = r.sig; }
  writeFileSync(kPath, JSON.stringify(K, null, 2), 'utf8');

  if (existsSync(cPath)) {
    const C = JSON.parse(readFileSync(cPath, 'utf8'));
    const tierOf = Object.fromEntries(rows.map(r => [r.name, r.tier]));
    for (const pop of ['tables', 'views']) {
      const P = C.objects?.[pop]; if (!P) continue;
      /* Re-tiering moves objects between buckets, so the per-tier tallies have to be rebuilt from
       * the rows — including the credited ones. Resetting every counter to zero and refilling only
       * `total` silently discarded covered/failed/na/nt whenever tiering ran after crediting. */
      const STATE_BUCKET = { tested: 'covered', fully_covered: 'covered', covered: 'covered',
        partially_covered: 'covered', failed: 'failed', not_applicable: 'na', not_testable: 'nt' };
      P.by_tier = { T1: {}, T2: {}, T3: {}, T4: {} };
      for (const k of Object.keys(P.by_tier)) P.by_tier[k] = { total: 0, covered: 0, failed: 0, na: 0, nt: 0 };
      for (const r of P.rows || []) {
        r.tier = tierOf[r.name] || r.tier;
        const b = P.by_tier[r.tier]; if (!b) continue;
        b.total++;
        const k = STATE_BUCKET[String(r.state || '')]; if (k) b[k]++;
      }
    }
    for (const r of C.columns?.rows || []) r.tier = tierOf[r.object] || r.tier;
    C.tiering_model = 'business-model weights (04-coverage-model.md §5.1): workflow subject, vendor report, relationship centrality, role reach, category, persona coupling. Customer usage is not a signal.';
    writeFileSync(cPath, JSON.stringify(C, null, 2), 'utf8');
  }
  console.log('\n→ applied to knowledge.json' + (existsSync(cPath) ? ' and coverage.json' : ''));
} else {
  console.log('\n(dry run — pass --apply to write it back)');
}
