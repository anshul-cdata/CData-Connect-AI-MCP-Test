#!/usr/bin/env node
/**
 * capability-list.mjs — Stage 1.5: what the source can do, and how the connector exposes it.
 *
 *   node capability-list.mjs read   --dir <connectorDir> --spec <openapi.json|yaml>
 *   node capability-list.mjs map    --dir <connectorDir>
 *   node capability-list.mjs apply  --dir <connectorDir> --review <review.json>
 *   node capability-list.mjs status --dir <connectorDir>
 *
 * read    parses the source's OpenAPI description into {C}_capabilities.json. Re-reading keeps
 *         every reviewed mapping and the business-area grouping for capabilities that still exist.
 * map     maps every unreviewed capability onto the connector's tables, writes and procedures
 *         (from {C}_knowledge.json, so Stage 1 must have run). Prints the low-confidence ones —
 *         those go to the model for review (references/10-capabilities.md §1.5c).
 * apply   applies the model's review: corrected mappings, product-only capabilities the API does
 *         not describe, and the business areas and flows that group them.
 * status  prints the counts the report headline uses, and exits 3 while anything is unmapped,
 *         low-confidence and unreviewed, or ungrouped — so Stage 5.5 cannot start on a guess — or
 *         while the API list was assembled without evidence (3.9.2, lib/api-provenance.mjs): rebuild
 *         it with api-from-docs.mjs, or keep it knowingly with --keep-unverified "<why>".
 *
 * A re-read after a rebuild lists what changed (added · removed · moved) in `rebuild`, so 1.5c reviews
 * only those, and names the frozen catalog areas whose use cases need a removed or moved capability —
 * flagged, never unfrozen.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, loadConfig, fail, EXIT, SCHEMA_VERSION } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { parseSpec, toCapabilities, mapToConnector, summarize, STATUSES, readerNote, enforceMcpReach } from './lib/capabilities.mjs';
import { apiListState, capabilityDiff, frozenAreasReferencing, UNVERIFIED_NOTE } from './lib/api-provenance.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'spec', 'review', 'keep-unverified'],
  usage: 'usage: capability-list.mjs <read|map|apply|status> --dir <connectorDir> [--spec file] [--review file] [--keep-unverified "<why>"]',
});
const cmd = a._[0];
if (!a.dir || !['read', 'map', 'apply', 'status'].includes(cmd)) {
  console.error('usage: capability-list.mjs <read|map|apply|status> --dir <connectorDir> [--spec file] [--review file]');
  process.exit(EXIT.USAGE);
}
const cfg = loadConfig();
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const CAPS = P('capabilities');
const optJson = f => existsSync(f) ? readJson(f) : null;
const ids = l => `${l.slice(0, 8).join(', ')}${l.length > 8 ? ' …' : ''}`;

if (cmd === 'read') {
  if (!a.spec || !existsSync(a.spec)) fail(`--spec must name the source's OpenAPI description (JSON or YAML): ${a.spec || '(none)'}`, EXIT.USAGE);
  let spec;
  try { spec = parseSpec(readFileSync(a.spec, 'utf8')); } catch (e) { fail(`could not read ${a.spec}: ${e.message}`); }
  if (!spec.operations.length) fail(`${a.spec} has no operations under "paths" — is it an OpenAPI description?`);
  const fresh = toCapabilities(spec);
  const prev = existsSync(CAPS) ? readJson(CAPS) : null;
  const keep = new Map((prev?.capabilities || []).map(c => [c.id, c]));
  /* reviewed mappings survive a re-read; product-only entries (added by review) are not in the
   * spec and are kept as they are */
  const caps = fresh.map(c => keep.get(c.id)?.review ? { ...c, mapping: keep.get(c.id).mapping, review: keep.get(c.id).review } : c);
  for (const c of prev?.capabilities || []) if (c.mapping?.status === 'product_only') caps.push(c);
  /* 3.9 — where the list came from: the vendor's own description (spec), or assembled by
   * api-from-docs.mjs from a Postman collection, an SDK or the reference pages (info.x-assembled) */
  const asm = spec.assembled || null;
  const kind = asm?.rung && asm.rung !== 'spec' ? asm.rung : 'spec';
  /* 3.9.2 — a re-read (after a rebuild) says what changed. Removed ids leave the areas they were
   * grouped in; the rest of the grouping stays. Frozen catalog areas are only named, never unfrozen. */
  const diff = prev ? capabilityDiff(prev.capabilities, fresh) : null;
  const areas = prev?.areas || [];
  if (diff?.removed.length) {
    const gone = new Set(diff.removed);
    for (const ar of areas) {
      if (Array.isArray(ar.capability_ids)) ar.capability_ids = ar.capability_ids.filter(id => !gone.has(id));
      for (const f of ar.flows || []) if (Array.isArray(f.capability_ids)) f.capability_ids = f.capability_ids.filter(id => !gone.has(id));
    }
  }
  const changed = diff && (diff.added.length || diff.removed.length || diff.moved.length);
  writeJson(CAPS, {
    schema_version: SCHEMA_VERSION, connector: conn,
    source: { path: a.spec.replace(/\\/g, '/').split('/').pop(), title: spec.title, version: spec.version, read_at: new Date().toISOString(), kind,
      ...(asm ? { assembled: { rung: asm.rung, ...(asm.format ? { format: asm.format } : {}), ...(asm.fetcher ? { fetcher: asm.fetcher } : {}),
        excluded: Array.isArray(asm.excluded) ? asm.excluded.length : (asm.excluded || 0), ...(asm.source_url ? { source_url: asm.source_url } : {}), at: asm.at || null } } : {}),
      ...(asm?.pages != null ? { pages: asm.pages } : {}) },
    areas,
    capabilities: caps,
    ...(changed ? { rebuild: { at: new Date().toISOString(), previous: { path: prev.source?.path || null, title: prev.source?.title || null, kind: prev.source?.kind || 'spec' },
      added: diff.added, removed: diff.removed, moved: diff.moved, kept_reviewed: diff.kept_reviewed } } : {}),
  });
  const dep = caps.filter(c => c.deprecated).length;
  console.log(`CAPABILITIES — ${conn}`);
  console.log(`  ${spec.title || 'API'} ${spec.version || ''} · ${caps.length} operation(s)${dep ? ` · ${dep} deprecated` : ''}`);
  if (kind !== 'spec') console.log(`  assembled (${kind.replace('_', ' ')})${asm.pages != null ? ` from ${asm.pages} page(s)` : ''}${asm.fetcher ? ` · read with ${asm.fetcher}` : ''} — the reports say the list was assembled, not read`);
  const byKind = caps.reduce((m, c) => (m[c.kind] = (m[c.kind] || 0) + 1, m), {});
  console.log('  ' + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · '));
  if (changed) {
    console.log(`  changed since the previous list: ${diff.kept_reviewed} reviewed mapping(s) kept · ${diff.added.length} added · ${diff.removed.length} removed · ${diff.moved.length} moved (same id, other method/path/kind)`);
    if (diff.added.length) console.log(`    added — map, then review only these in 1.5c: ${ids(diff.added)}`);
    if (diff.removed.length) console.log(`    removed — taken out of their areas: ${ids(diff.removed)}`);
    if (diff.moved.length) console.log(`    moved — reviewed mapping kept, look at it again in 1.5c: ${ids(diff.moved)}`);
    for (const f of frozenAreasReferencing(optJson(P('catalog')), [...diff.removed, ...diff.moved]))
      console.log(`    ⚠ frozen area ${f.area}: ${f.use_cases} use case(s) need a removed or moved capability (${ids(f.capabilities)}) — flagged, not unfrozen`);
  }
  console.log(`\n→ ${CAPS}\n  next: capability-list.mjs map --dir "${a.dir}"`);
  process.exit(EXIT.OK);
}

if (!existsSync(CAPS)) fail(`no ${CAPS} — run "capability-list.mjs read --spec …" first`);
const doc = readJson(CAPS);

if (cmd === 'map') {
  const K = readJson(P('knowledge'), { kind: 'knowledge' });
  const C = cfg.capabilities || {};
  doc.capabilities = mapToConnector(doc.capabilities, K, C);
  doc.mapped_at = new Date().toISOString();
  writeJson(CAPS, doc);
}

if (cmd === 'apply') {
  if (!a.review || !existsSync(a.review)) fail(`--review must name the model's review file`, EXIT.USAGE);
  const R = readJson(a.review);
  const byId = new Map(doc.capabilities.map(c => [c.id, c]));
  /* A review is model output: check it before it becomes the denominator of every number. A
   * status outside the vocabulary would be counted under a stray key and shown as no gap at all;
   * an exposure naming a table the connector does not have would be credited as supported. */
  const Kn = existsSync(P('knowledge')) ? readJson(P('knowledge')) : {};
  const realNames = new Set([...(Kn.objects || []).map(o => o.name), ...(Kn.physical?.procedures || []).map(p => p.name)].map(s => String(s).toLowerCase()));
  const bad = [];
  for (const m of R.mappings || []) {
    if (!STATUSES.includes(m.status)) bad.push(`${m.id}: status "${m.status}" is not one of ${STATUSES.join(', ')}`);
    for (const e of m.exposure || []) if (realNames.size && !realNames.has(String(e.name).toLowerCase())) bad.push(`${m.id}: exposure "${e.name}" is not a table or procedure of this connector`);
  }
  for (const ar of R.areas || []) if (!ar.id || !ar.name) bad.push(`an area is missing its id or name: ${JSON.stringify(ar).slice(0, 80)}`);
  if (bad.length) fail(`the review was not applied — ${bad.length} problem(s):\n    ${bad.slice(0, 15).join('\n    ')}`);
  let changed = 0, added = 0;
  for (const m of R.mappings || []) {
    const c = byId.get(m.id);
    if (!c) { console.error(`  ⚠ review names ${m.id}, which is not in the capability list — skipped`); continue; }
    /* the note is for report readers; the reviewer's own wording is kept beside it when they differ */
    const note = readerNote(m.note);
    c.mapping = { status: m.status, exposure: m.exposure || c.mapping?.exposure || [], confidence: 'reviewed', note,
                  ...(m.note && m.note !== note ? { review_note: m.note } : {}) };
    c.review = { by: R.model || 'model', at: new Date().toISOString() };
    changed++;
  }
  /* things the product does that its API does not describe — never a CData gap */
  for (const p of R.product_only || []) {
    const id = p.id || 'CAP-product_' + String(p.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    if (byId.has(id)) continue;
    doc.capabilities.push({ id, label: p.label, method: null, path: null, resource: p.resource || null, kind: p.kind || 'product',
      mapping: { status: 'product_only', exposure: [], confidence: 'reviewed', note: readerNote(p.note) || 'Only in the product, not in its API' },
      review: { by: R.model || 'model', at: new Date().toISOString() }, source: p.source || null });
    added++;
  }
  if (Array.isArray(R.areas) && R.areas.length) doc.areas = R.areas;
  enforceMcpReach(doc.capabilities, cfg.capabilities?.mcp_table_ops);
  writeJson(CAPS, doc);
  console.log(`  applied ${changed} reviewed mapping(s) · ${added} product-only capabilit${added === 1 ? 'y' : 'ies'} · ${doc.areas.length} area(s)`);
}

/* 3.9.2 — keep an unverified list knowingly (no machine-readable source and the pages cannot be read):
 * the reason is recorded, the reports still say the list is unverified */
if (cmd === 'status' && a['keep-unverified'] !== undefined) {
  const why = String(a['keep-unverified'] === true ? '' : a['keep-unverified']).trim();
  if (why.split(/\s+/).length < 3) fail('--keep-unverified needs the reason in a few words', EXIT.USAGE);
  doc.source = { ...(doc.source || {}), unverified_kept: { why, at: new Date().toISOString() } };
  writeJson(CAPS, doc);
}

/* ── status (also printed after map and apply) ─────────────────────────────── */
/* 3.7: a list mapped before the MCP reach check is corrected here, once, and saved */
{ const fixed = enforceMcpReach(doc.capabilities, cfg.capabilities?.mcp_table_ops);
  if (fixed.length) { writeJson(CAPS, doc); console.log(`  ⚠ ${fixed.length} capabilit${fixed.length === 1 ? 'y' : 'ies'} relied on an operation ConnectAI MCP cannot run (e.g. DELETE) — now partly or not supported: ${fixed.slice(0, 8).join(', ')}${fixed.length > 8 ? ' …' : ''}`); } }
const sum = summarize(doc.capabilities);
const grouped = new Set((doc.areas || []).flatMap(ar => (ar.flows || []).flatMap(f => f.capability_ids || []).concat(ar.capability_ids || [])));
const ungrouped = doc.capabilities.filter(c => c.mapping?.status !== 'not_applicable' && !grouped.has(c.id)).map(c => c.id);
const unmapped = doc.capabilities.filter(c => !c.mapping).map(c => c.id);
console.log(`\nCAPABILITY STATUS — ${conn}`);
console.log(`  ${sum.total} capabilities · ${sum.applicable} applicable to a data connector`);
console.log('  ' + Object.entries(sum.by_status).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(' · '));
console.log(`  ${(doc.areas || []).length} business area(s) · ${ungrouped.length} capabilit${ungrouped.length === 1 ? 'y' : 'ies'} not yet in any area`);
const blockers = [];
/* 3.9.2 — a list assembled without evidence is a guess at the denominator */
const prov = apiListState(a.dir, conn, doc, optJson(P('knowledge'))?.run_meta);
if (prov.status === 'unverified') {
  console.log(`  ⚠ ${UNVERIFIED_NOTE} (references/10-capabilities.md §1.5a): ${prov.reasons.join('; ')}`);
  if (prov.kept) console.log(`    kept knowingly ${String(prov.kept.at).slice(0, 10)}: ${prov.kept.why}`);
  else blockers.push(`the API list was assembled without evidence — rebuild it with api-from-docs.mjs, or keep it with --keep-unverified "<why>"`);
}
if (doc.rebuild) {
  const r = doc.rebuild;
  console.log(`  rebuilt ${String(r.at).slice(0, 10)} from "${r.previous?.title || r.previous?.path || 'the previous list'}": ${r.added.length} added · ${r.removed.length} removed · ${r.moved.length} moved`);
  const look = r.moved.filter(id => doc.capabilities.some(c => c.id === id));
  if (look.length) console.log(`    moved (reviewed mapping kept — look again in 1.5c): ${ids(look)}`);
  for (const f of frozenAreasReferencing(optJson(P('catalog')), [...r.removed, ...r.moved]))
    console.log(`    ⚠ frozen area ${f.area}: ${f.use_cases} use case(s) need a removed or moved capability (${ids(f.capabilities)}) — flagged, not unfrozen`);
}
if (unmapped.length) blockers.push(`${unmapped.length} unmapped (run map)`);
if (sum.low_confidence.length) blockers.push(`${sum.low_confidence.length} low-confidence mapping(s) awaiting review: ${sum.low_confidence.slice(0, 6).join(', ')}${sum.low_confidence.length > 6 ? ' …' : ''}`);
if (!(doc.areas || []).length) blockers.push('no business areas yet (the review groups capabilities into areas and flows)');
else if (ungrouped.length) blockers.push(`${ungrouped.length} not in any area: ${ungrouped.slice(0, 6).join(', ')}${ungrouped.length > 6 ? ' …' : ''}`);
if (blockers.length) {
  console.error(`\n✗ not ready for the use case catalog: ${blockers.join(' · ')}`);
  console.error('  Review per references/10-capabilities.md §1.5c, then: capability-list.mjs apply --review <file>');
  process.exit(EXIT.DATA);
}
console.log('\n  ✓ every capability is mapped, reviewed where uncertain, and grouped into a business area');
process.exit(EXIT.OK);
