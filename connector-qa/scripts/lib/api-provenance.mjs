/* api-provenance.mjs — was this API list published by the vendor, assembled with evidence, or
 * assembled without it? (3.9.2)
 *
 * 3.9 made api-from-docs.mjs assemble a list from reference pages, keeping only what the saved page
 * shows word for word (x-doc-url, x-evidence, info.x-assembled). A list built by hand before that —
 * or by a model that wrote OpenAPI from the docs on its own — looks like a spec to every reader, so a
 * run carried on with it and every later number rested on an unchecked list. This tells them apart:
 *
 *   published    a vendor's own description (no x-assembled, nothing says otherwise) — never flagged
 *   assembled    built by api-from-docs.mjs: converted from a machine-readable form, or from pages with
 *                every operation's page and quoted line
 *   unverified   assembled without evidence — rebuild it with api-from-docs.mjs (10-capabilities §1.5a)
 *   none         no API description on disk
 *
 * A published description is recognised as today (sniffFormat: openapi/swagger + paths). It is only
 * called unverified on a positive sign that it was not published: the run recorded reference pages as
 * its source, the capability list says it was assembled, or the file's own title or description says
 * so. Shape alone never decides — a vendor spec slimmed to its paths (two specs combined, responses
 * dropped) is still the vendor's — but when a sign is there, a missing shape (no operation declares
 * its responses, no schemas) is named beside it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { areaUseCases } from './catalog.mjs';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
/* the rungs read from pages: each operation must carry its page and the line quoted from it */
const FROM_PAGES = new Set(['reference_docs', 'sdk']);
const SAYS_ASSEMBLED = /\bassembled (from|by)\b[^.]{0,40}\b(reference|docs?\b|documentation|pages?\b|web ?site|hand)|\bhand[- ]?(built|made|written|crafted)\b|\bno (openapi|swagger|api description|machine-readable)[\w\s-]{0,30}\bpublished\b|\bnot published by the vendor\b/i;
export const UNVERIFIED_NOTE = 'API list assembled without evidence — rebuild with api-from-docs';

/**
 * @param {string|object|null} api  the description's text (JSON or YAML) or its parsed JSON
 * @param {{capsSource?: object|null, capabilitySpec?: object|string|null}} ctx  capsDoc.source and run_meta.capability_spec
 * @returns {{status: 'published'|'assembled'|'unverified'|'none', reasons: string[], rung?: string}}
 */
export function apiProvenance(api, ctx = {}) {
  const spec = typeof ctx.capabilitySpec === 'object' ? ctx.capabilitySpec : null;
  const src = ctx.capsSource || null;
  const recorded = [];
  if (spec?.source === 'reference_docs') recorded.push('the run recorded reference pages as the source (run_meta.capability_spec.source "reference_docs") without an evidence-checked assembly');
  if (src?.kind && src.kind !== 'spec' && !src.assembled) recorded.push(`the capability list says "${src.kind}" but records no assembly`);
  if (api == null || api === '') return recorded.length ? { status: 'unverified', reasons: [...recorded, 'its API description is not on disk'] } : { status: 'none', reasons: [] };

  let doc = typeof api === 'object' ? api : null;
  const text = typeof api === 'string' ? api.replace(/^﻿/, '').trim() : null;
  if (text && /^[{[]/.test(text)) { try { doc = JSON.parse(text); } catch { doc = null; } }

  if (doc) {
    const asm = doc.info?.['x-assembled'];
    const ops = Object.values(doc.paths || {}).flatMap(item => METHODS.map(m => item?.[m]).filter(Boolean));
    if (asm) {
      const rung = asm.rung || 'reference_docs';
      if (FROM_PAGES.has(rung)) {
        const bare = ops.filter(o => !o['x-doc-url'] || !o['x-evidence']).length;
        if (bare) return { status: 'unverified', rung, reasons: [`${bare} of ${ops.length} operation(s) carry no page or quoted line (x-doc-url / x-evidence)`] };
      }
      return { status: 'assembled', rung, reasons: [] };
    }
    const reasons = [...recorded];
    const said = [doc.info?.title, doc.info?.description].map(s => String(s || '')).find(s => SAYS_ASSEMBLED.test(s));
    if (said) reasons.push(`its own title or description says it was not published by the vendor ("${said.slice(0, 90)}${said.length > 90 ? '…' : ''}")`);
    if (!reasons.length) return { status: 'published', reasons: [] };
    const schemas = doc.components?.schemas || doc.definitions;
    if (ops.length && ops.every(o => !o.responses) && !(schemas && Object.keys(schemas).length))
      reasons.push(`none of its ${ops.length} operations declares its responses and it has no schemas`);
    return { status: 'unverified', reasons };
  }

  /* YAML (or unreadable JSON): read as text — x-assembled is only ever written as JSON */
  const reasons = [...recorded];
  const info = /^info:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(text)?.[1] || '';
  const said = [...info.matchAll(/^\s+(?:title|description):\s*(.+)$/gm)].map(m => m[1]).find(s => SAYS_ASSEMBLED.test(s));
  if (said) reasons.push(`its own title or description says it was not published by the vendor ("${said.trim().slice(0, 90)}")`);
  if (!reasons.length) return { status: 'published', reasons: [] };
  if (/^paths\s*:/m.test(text) && !/^\s+responses\s*:/m.test(text) && !/^(components|definitions)\s*:/m.test(text))
    reasons.push('no operation declares its responses and it has no schemas');
  return { status: 'unverified', reasons };
}

/** The API description beside a capability list: the file it was read from, else <C>_api.json|yaml. */
export function readApiList(dir, conn, capsSource = null) {
  const names = [capsSource?.path, `${conn}_api.json`, `${conn}_api.yaml`, `${conn}_api.yml`].filter(Boolean);
  for (const n of names) { const p = join(dir, n); if (existsSync(p)) return { path: p, text: readFileSync(p, 'utf8') }; }
  return { path: null, text: null };
}

/** apiProvenance for a connector folder, from what is on disk. `kept` — the user chose to keep an
 * unverified list (capability-list.mjs status --keep-unverified "<why>"); it is still reported. */
export function apiListState(dir, conn, capsDoc = null, runMeta = null) {
  const { path, text } = readApiList(dir, conn, capsDoc?.source);
  const p = apiProvenance(text, { capsSource: capsDoc?.source, capabilitySpec: runMeta?.capability_spec });
  return { ...p, path, ...(p.status === 'unverified' && capsDoc?.source?.unverified_kept ? { kept: capsDoc.source.unverified_kept } : {}) };
}

/**
 * What a re-read changed, against the previous capability list.
 *   added    new ids — unmapped, so 1.5c reviews them
 *   removed  ids no longer in the API list (product-only entries are never removed)
 *   moved    same id, different documented method, path or kind — the reviewed mapping is kept; look at it again
 */
export function capabilityDiff(prevCaps = [], freshCaps = []) {
  const before = new Map(prevCaps.filter(c => c.mapping?.status !== 'product_only').map(c => [c.id, c]));
  const now = new Map(freshCaps.map(c => [c.id, c]));
  const added = [...now.keys()].filter(id => !before.has(id));
  const removed = [...before.keys()].filter(id => !now.has(id));
  const moved = [...now.values()].filter(c => { const b = before.get(c.id); return b && (b.method !== c.method || b.path !== c.path || b.kind !== c.kind); }).map(c => c.id);
  const kept = [...now.keys()].filter(id => before.get(id)?.review).length;
  return { added, removed, moved, kept_reviewed: kept };
}

/** Frozen catalog areas whose use cases need one of `ids` — flagged for a look, never unfrozen. */
export function frozenAreasReferencing(cat, ids) {
  const want = new Set(ids || []);
  if (!cat || !want.size) return [];
  return Object.entries(cat.areas || {}).filter(([, st]) => st?.frozen).map(([area]) => {
    const ucs = areaUseCases(cat, area).filter(u => (u.capabilities || []).some(id => want.has(id)));
    return { area, use_cases: ucs.length, capabilities: [...new Set(ucs.flatMap(u => (u.capabilities || []).filter(id => want.has(id))))] };
  }).filter(x => x.use_cases);
}
