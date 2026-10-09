/* reference-mcp.mjs — the source vendor's own MCP server, beside CData ConnectAI MCP (3.8).
 *
 * The capability list says, for every operation in the source's API, whether CData ConnectAI MCP
 * offers it. When the vendor runs an MCP server of its own, the same list can say whether THAT server
 * offers it, which turns the gap analysis three-way: what both can do, what only CData can do, what
 * only the vendor's server can do, and what neither can.
 *
 * Kept in <Connector>_reference_mcp.json, never in the capability list, so a comparison added or
 * redone later changes no fingerprint, no stored result and no existing report figure. Pure
 * functions only; scripts/reference-mcp.mjs reads and writes the file.
 */
import { createHash } from 'node:crypto';

/* Does the vendor's server offer this capability? covered · partly (some of it — fewer fields,
 * fewer filters, one record where the API takes many) · not_covered. */
export const REF_STATUSES = ['covered', 'partly', 'not_covered'];
export const BUCKET_LABEL = {
  both: 'Both', cdata_only: 'Only CData ConnectAI MCP', vendor_only: 'Only the vendor MCP', neither: 'Neither',
  app_only: "Only in the source's own app", unmapped: 'Not compared yet',
};
export const BUCKET_ORDER = Object.keys(BUCKET_LABEL);

const READ_VERB = /^(get|list|search|find|read|fetch|query|lookup|describe|show|view|count|export|download)/i;
const WRITE_VERB = /^(create|add|update|edit|set|delete|remove|post|put|patch|assign|move|archive|complete|close|upload|duplicate|attach|detach|invite|share|mark)/i;
const bare = n => String(n || '').replace(/^[a-z0-9]+_(?=[a-z])/i, m => (/^(get|list|create|update|delete|search|add|remove|set)_$/i.test(m) ? m : ''));

/** One tool list, whatever shape it came in: an MCP `tools/list` reply, `{tools:[…]}` or a bare array. */
export function normalizeTools(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tools) ? raw.tools : Array.isArray(raw?.result?.tools) ? raw.result.tools : [];
  const seen = new Set(), out = [];
  for (const t of list) {
    const name = String(typeof t === 'string' ? t : t?.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const props = t?.inputSchema?.properties || t?.input_schema?.properties || null;
    const verb = bare(name);
    const access = ['read', 'write'].includes(t?.access) ? t.access
      : t?.annotations?.readOnlyHint === true ? 'read' : WRITE_VERB.test(verb) ? 'write' : READ_VERB.test(verb) ? 'read' : 'other';
    out.push({ name, description: String(t?.description || '').replace(/\s+/g, ' ').trim().slice(0, 400), access,
      params: props ? Object.keys(props) : Array.isArray(t?.params) ? t.params.map(String) : [] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export const toolsHash = tools => createHash('sha256').update(JSON.stringify(tools.map(t => [t.name, t.access, t.params]))).digest('hex').slice(0, 12);

/* words that say nothing about which object a call works on */
const STOP = new Set(['get', 'list', 'create', 'update', 'delete', 'add', 'remove', 'set', 'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'by', 'from', 'with',
  'and', 'or', 'multiple', 'single', 'record', 'records', 'gid', 'id', 'ids', 'all', 'new', 'existing', 'search', 'find', 'read', 'api', 'v1', 'v2']);
const words = s => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
  .map(w => w.replace(/ies$/, 'y').replace(/(?<!s)s$/, '')).filter(w => w.length > 1 && !STOP.has(w));
const capWrites = c => ['post', 'put', 'patch', 'delete'].includes(String(c?.method || '').toLowerCase());

/** Tools whose name or description share the most object words with the capability — a starting
 * point for the person or agent who maps it, never the mapping itself. */
export function suggestTools(cap, tools, n = 3) {
  const want = new Set(words(`${cap.label} ${cap.path || ''}`));
  if (!want.size) return [];
  return tools.map(t => {
    const nameW = words(t.name), descW = words(t.description);
    let s = nameW.filter(w => want.has(w)).length * 2 + new Set(descW.filter(w => want.has(w))).size * 0.5;
    if (s && (t.access === 'write') === capWrites(cap)) s += 1;
    return [t.name, s];
  }).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([nm]) => nm);
}

/** The capabilities a comparison covers: every applicable one, or those of the given areas. */
export function capsInScope(capsDoc, areas = null) {
  const caps = (capsDoc?.capabilities || []).filter(c => c.mapping?.status !== 'not_applicable');
  if (!areas) return caps;
  const ids = new Set((capsDoc?.areas || []).filter(a => areas.includes(a.id))
    .flatMap(ar => [...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])]));
  return caps.filter(c => ids.has(c.id));
}

/** What a mapping agent returned, checked before anything is stored. */
export function mappingProblems(m, scopeCaps, tools) {
  const problems = [], names = new Set(tools.map(t => t.name)), ids = new Set(scopeCaps.map(c => c.id));
  for (const e of m?.mapping || []) {
    if (!ids.has(e?.cap)) { problems.push(`${e?.cap}: not a capability in scope`); continue; }
    if (!REF_STATUSES.includes(e.status)) problems.push(`${e.cap}: status "${e.status}" is not one of ${REF_STATUSES.join(', ')}`);
    const ts = Array.isArray(e.tools) ? e.tools : [];
    for (const t of ts) if (!names.has(t)) problems.push(`${e.cap}: tool "${t}" is not in the vendor's tool list`);
    if (e.status !== 'not_covered' && !ts.length) problems.push(`${e.cap}: ${e.status} must name the tool(s) that do it`);
    if (e.status === 'partly' && !String(e.note || '').trim()) problems.push(`${e.cap}: partly must say what is missing (note)`);
  }
  for (const x of m?.extra || []) if (!names.has(x?.tool)) problems.push(`extra: tool "${x?.tool}" is not in the vendor's tool list`);
  return problems;
}

const cdataCan = s => s === 'exposed' || s === 'partly';
const vendorCan = s => s === 'covered' || s === 'partly';
/** Where one capability falls in the three-way comparison. */
export function bucketOf(cdataStatus, vendorStatus) {
  if (!vendorStatus) return 'unmapped';
  const c = cdataCan(cdataStatus), v = vendorCan(vendorStatus);
  if (c && v) return 'both';
  if (c) return 'cdata_only';
  if (v) return 'vendor_only';
  return cdataStatus === 'product_only' ? 'app_only' : 'neither';
}

const statusWord = s => s === 'exposed' ? 'y' : s === 'partly' ? 'p' : s === 'not_exposed' ? 'n' : s === 'product_only' ? 'na' : null;
const counts = rows => { const v = Object.fromEntries(BUCKET_ORDER.map(k => [k, 0])); for (const r of rows) v[r.bucket]++; return v; };

/**
 * The comparison the reports show. Null when nothing has been compared yet, so a report without a
 * reference server is exactly what it was before 3.8.
 * @param {{capsDoc, ref, catalog?, areas?: string[]|null}} x
 */
export function compareView({ capsDoc, ref, catalog = null, areas = null }) {
  const map = ref?.mapping || {};
  if (!ref || !Object.keys(map).length) return null;
  const areaOf = new Map();
  for (const ar of capsDoc?.areas || []) for (const id of [...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])]) if (!areaOf.has(id)) areaOf.set(id, ar);
  const scope = capsInScope(capsDoc, areas);
  const rows = scope.map(c => {
    const v = map[c.id] || null;
    return { id: c.id, label: c.label, api: c.method ? `${c.method} ${c.path}` : '—', ...(c.doc_url ? { doc_url: c.doc_url } : {}), area: areaOf.get(c.id)?.name || null, area_id: areaOf.get(c.id)?.id || null,
      cdata: statusWord(c.mapping?.status), cdata_via: (c.mapping?.exposure || []).map(e => e.kind === 'procedure' ? `${e.name} · procedure` : `${e.name} · ${e.op}`).join(', ') || null,
      vendor: v?.status || null, vendor_tools: v?.tools || [], note: v?.note || null, bucket: bucketOf(c.mapping?.status, v?.status) };
  }).sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) || String(a.area || '').localeCompare(String(b.area || '')) || a.label.localeCompare(b.label));
  const byArea = (capsDoc?.areas || []).filter(ar => !areas || areas.includes(ar.id)).map(ar => {
    const mine = rows.filter(r => r.area_id === ar.id);
    return { id: ar.id, name: ar.name, total: mine.length, buckets: counts(mine) };
  }).filter(a => a.total);
  /* use cases: can each server do everything the use case needs? */
  const capById = new Map((capsDoc?.capabilities || []).map(c => [c.id, c]));
  const live = (catalog?.use_cases || []).filter(u => u.status !== 'retired' && (!areas || areas.includes(u.area)) && (u.capabilities || []).length);
  const ucRows = live.map(u => {
    const cs = u.capabilities.map(id => capById.get(id));
    if (cs.some(c => !c)) return { id: u.id, bucket: 'unmapped' };
    const vs = u.capabilities.map(id => map[id]?.status);
    if (vs.some(s => !s)) return { id: u.id, bucket: 'unmapped' };
    const c = cs.every(x => cdataCan(x.mapping?.status)), v = vs.every(vendorCan);
    const appOnly = cs.some(x => x.mapping?.status === 'product_only');
    return { id: u.id, bucket: c && v ? 'both' : c ? 'cdata_only' : v ? 'vendor_only' : appOnly && !v ? 'app_only' : 'neither' };
  });
  /* what a SQL interface answers in one query and a tool-per-endpoint server leaves to the agent:
   * totals and links between objects. Counted from the catalog's own tags, never measured here. */
  const tagged = t => live.filter(u => Array.isArray(u.tests) && u.tests.includes(t)).length;
  const used = new Set(Object.values(map).flatMap(v => v.tools || []));
  const tools = ref.tools || [];
  return {
    server: ref.server || null, source: ref.source || null, read_at: ref.read_at || null, mapped_at: ref.mapped_at || null,
    tools: { total: tools.length, read: tools.filter(t => t.access === 'read').length, write: tools.filter(t => t.access === 'write').length },
    caps: { total: rows.length, buckets: counts(rows) }, rows, areas: byArea,
    use_cases: { total: ucRows.length, buckets: counts(ucRows) },
    query: { use_cases: live.length, aggregation: tagged('aggregation'), relationships: tagged('relationships') },
    extra: (ref.extra || []).map(x => ({ tool: x.tool, note: x.note || null, description: tools.find(t => t.name === x.tool)?.description || '' })),
    unused: tools.filter(t => !used.has(t.name) && !(ref.extra || []).some(x => x.tool === t.name)).map(t => ({ tool: t.name, description: t.description })),
  };
}
