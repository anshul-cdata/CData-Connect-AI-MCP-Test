/* api-docs.mjs — a capability list from whatever the vendor publishes (3.9, Stage 1.5a).
 *
 * capability-list.mjs reads an OpenAPI description. Many vendors publish none; some publish another
 * machine-readable form; some only web pages. The ladder, first hit wins, the rung recorded:
 *
 *   1 spec            OpenAPI / Swagger (also behind ReadMe, Redoc, Stoplight, Swagger UI portals),
 *                     OData $metadata, WSDL, RAML, GraphQL schema — converted mechanically
 *   2 postman · sdk   a Postman collection v2.1 (converted) · an official SDK's entity/service list
 *   3 reference_docs  the vendor's API reference pages, read and extracted by a model
 *
 * Rungs 2 (sdk) and 3 go through the same check: a model extracts operations from saved page text
 * (lib/page-reader.mjs snapshots), and `mergeOps` keeps only those whose page is in the inventory
 * and whose evidence is that page's own words. The output is always the OpenAPI shape
 * capability-list.mjs reads, with the documented method and path kept (`x-path`), the page
 * (`x-doc-url`), the quoted line (`x-evidence`) and `info.x-assembled` saying how it was built.
 */
import { contains, normalizeUrl } from './page-reader.mjs';

export const RUNGS = ['spec', 'postman', 'sdk', 'reference_docs'];
export const OP_KINDS = ['list', 'get', 'create', 'update', 'delete', 'action'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/* ── rung 1 · find a machine-readable description ────────────────────────── */
export const WELL_KNOWN = ['/openapi.json', '/openapi.yaml', '/swagger.json', '/swagger.yaml', '/api-docs', '/v2/api-docs', '/v3/api-docs',
  '/swagger/v1/swagger.json', '/openapi/v3/api-docs', '/.well-known/openapi.json', '/.well-known/openapi.yaml', '/api/openapi.json', '/docs/openapi.json'];

/** What a downloaded file is, from its content. */
export function sniffFormat(text) {
  const t = String(text || '').replace(/^\ufeff/, '').trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) {
    let j; try { j = JSON.parse(t); } catch { return null; }
    if (j && (j.openapi || j.swagger) && j.paths) return 'openapi';
    if (j?.info && (j.info._postman_id || /postman/i.test(String(j.info.schema || ''))) && Array.isArray(j.item)) return 'postman';
    if (j?.__schema || j?.data?.__schema) return 'graphql';
    return null;
  }
  if (/^#%RAML\b/.test(t)) return 'raml';
  if (/^(openapi|swagger)\s*:/m.test(t) && /^paths\s*:/m.test(t)) return 'openapi';
  if (/<(edmx:)?Edmx\b/i.test(t) || /<EntityContainer\b/.test(t)) return 'odata';
  if (/<([\w-]+:)?definitions\b[^>]*wsdl|<wsdl:definitions\b|<definitions\b[^>]*schemas\.xmlsoap\.org\/wsdl/i.test(t)) return 'wsdl';
  if (/\b(type|extend type)\s+(Query|Mutation)\s*\{/.test(t) || /\bschema\s*\{\s*query\s*:/.test(t)) return 'graphql';
  return null;
}

/** Links on a docs page that may lead to a machine-readable description: portal configs (Redoc
 * `spec-url`, Swagger UI `url:`, Stoplight `apiDescriptionUrl`, ReadMe's OpenAPI download), files named
 * like specs, Postman collections, OData $metadata and WSDL endpoints. Absolute and unique. */
export function specLinksIn(html, base) {
  const s = String(html || ''), out = new Set();
  const add = u => { try { const x = new URL(u.replace(/&amp;/g, '&'), base); if (/^https?:$/.test(x.protocol)) out.add(x.toString()); } catch { /* not a URL */ } };
  for (const m of s.matchAll(/\b(?:spec-url|specUrl|apiDescriptionUrl|api-description-url|data-spec-url|openapi-url)\s*[=:]\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of s.matchAll(/\burl\s*:\s*["']([^"']+\.(?:json|ya?ml)(?:\?[^"']*)?)["']/gi)) add(m[1]);
  for (const m of s.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const u = m[1];
    if (/\.(json|ya?ml|raml|wsdl)(\?|$)/i.test(u) && /(openapi|swagger|api-?docs|spec|definition|schema|postman|collection|raml|wsdl)/i.test(u)) add(u);
    else if (/\$metadata(\?|$)|\?wsdl$|postman\.com\/[^"']*collection|run\.pstmn\.io|\/openapi(\/|$)/i.test(u)) add(u);
  }
  return [...out];
}

/** Well-known places to try on an origin. */
export const wellKnownUrls = origins => [...new Set(origins.flatMap(o => WELL_KNOWN.map(p => { try { return new URL(p, o).toString(); } catch { return null; } })).filter(Boolean))];

/* ── operation words → kind ──────────────────────────────────────────────── */
const KIND_WORDS = [
  ['list', /^(query|list|search|find|browse|report|reports|export|filter|count|enumerate|get all|read all|retrieve all)\b/],
  ['get', /^(read|get|retrieve|fetch|show|view|describe|download|lookup|look up)\b/],
  ['create', /^(create|add|insert|post|new|upload|register)\b/],
  ['update', /^(update|sparse update|full update|modify|edit|patch|replace|put|change|rename)\b/],
  ['delete', /^(delete|remove|destroy|purge|erase)\b/],
];
/** The kind of an operation from its documented name ("Create an invoice", "sparse update", "void"). */
export function kindFromOperation(operation, method = null) {
  const w = String(operation || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(an?|the)\s+/, '');
  for (const [k, re] of KIND_WORDS) if (re.test(w)) return k;
  if (!w && method) return { GET: 'get', DELETE: 'delete', PUT: 'update', PATCH: 'update' }[method] || 'create';
  return 'action';
}
const words = s => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = s => words(s).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const camel = s => { const p = pascal(s); return p ? p[0].toLowerCase() + p.slice(1) : ''; };
/** `<verb><Entity>` — createInvoice, getInvoice (read), queryInvoice, voidInvoice. */
export function operationIdFor(entity, operation) {
  const w = words(operation).map(x => x.toLowerCase()).filter(x => !['a', 'an', 'the'].includes(x));
  const sg = x => x.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
  const ent = pascal(entity), entW = new Set(words(entity).map(x => sg(x.toLowerCase())));
  const verb = w.filter(x => !entW.has(sg(x))).map((x, i) => i === 0 && x === 'read' ? 'get' : x);
  return camel(verb.join(' ') || 'call') + ent;
}

/* documented placeholders (<realmID>, :id, {{id}}) as OpenAPI braces; the origin dropped */
export function pathKey(documented) {
  let p = String(documented || '').trim();
  try { if (/^https?:\/\//i.test(p)) { const u = new URL(p.replace(/[<>]/g, m => (m === '<' ? '%3C' : '%3E'))); p = decodeURIComponent(u.pathname) + decodeURIComponent(u.search); } } catch { /* keep as written */ }
  p = p.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{$1}').replace(/<([\w.-]+)>/g, '{$1}').replace(/(^|\/):([A-Za-z_]\w*)/g, '$1{$2}');
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

/* ── the OpenAPI-shaped output ───────────────────────────────────────────── */
/**
 * @param {object[]} ops  {entity, operation, method, path, summary?, kind?, doc_url?, evidence?, operation_id?}
 * @param {object} meta   {title, version, rung, format?, fetcher?, pages?, excluded?, source_url?}
 */
export function toOpenApi(ops, meta = {}) {
  const paths = {};
  const used = new Set();
  for (const o of ops) {
    const method = String(o.method).toLowerCase();
    const documented = String(o.path);
    let key = pathKey(documented);
    /* two operations on one documented method and path (Intuit's POST /invoice creates, and with
     * ?operation=update updates; GraphQL serves everything from one URL) — keyed apart, the
     * documented path kept in x-path */
    if (paths[key]?.[method]) { let n = `${key} #${camel(o.operation)}${pascal(o.entity)}`; while (paths[n]?.[method]) n += '_'; key = n; }
    let id = o.operation_id || operationIdFor(o.entity, o.operation);
    while (used.has(id)) id += '_';
    used.add(id);
    const params = [...pathKey(documented).matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true }));
    (paths[key] ||= {})[method] = {
      operationId: id, summary: o.summary || `${o.operation} ${o.entity}`.trim(), tags: [o.entity],
      ...(params.length ? { parameters: params } : {}),
      'x-entity': o.entity, 'x-operation': o.operation, 'x-kind': OP_KINDS.includes(o.kind) ? o.kind : kindFromOperation(o.operation, o.method),
      ...(key !== documented ? { 'x-path': documented } : {}),
      ...(o.doc_url ? { 'x-doc-url': o.doc_url } : {}), ...(o.evidence ? { 'x-evidence': o.evidence } : {}),
    };
  }
  return { openapi: '3.0.3',
    info: { title: meta.title || 'API', version: meta.version || null,
      'x-assembled': { rung: meta.rung, ...(meta.format ? { format: meta.format } : {}), ...(meta.source_url ? { source_url: meta.source_url } : {}),
        ...(meta.fetcher ? { fetcher: meta.fetcher } : {}), ...(meta.pages != null ? { pages: meta.pages } : {}),
        ...(meta.excluded ? { excluded: meta.excluded } : {}), operations: ops.length, at: meta.at || new Date().toISOString() } },
    paths };
}

/* ── converters: machine-readable forms that are not OpenAPI ─────────────── */
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1] ?? null;

/** Postman collection v2.1: every request, its folder as the entity. */
export function fromPostman(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const ops = [];
  const walk = (items, folder) => {
    for (const it of items || []) {
      if (Array.isArray(it.item)) { walk(it.item, it.name || folder); continue; }
      const r = it.request; if (!r) continue;
      const method = String(typeof r === 'string' ? 'GET' : r.method || 'GET').toUpperCase();
      if (!METHODS.includes(method)) continue;
      const url = typeof r === 'string' ? r : r.url;
      let path = typeof url === 'string' ? url : Array.isArray(url?.path) ? '/' + url.path.join('/') : url?.raw || '';
      path = String(path).replace(/^\{\{[^}]+\}\}/, '');
      ops.push({ entity: folder || 'API', operation: it.name || method, method, path, summary: it.name || null, kind: kindFromOperation(it.name, method) });
    }
  };
  walk(j.item, null);
  return { ops, title: j.info?.name || null, version: j.info?.version || null };
}

/** OData CSDL ($metadata): each entity set read, created, updated and deleted unless its Capabilities
 * annotations say otherwise; function imports read, action imports act. */
export function fromOData(xml) {
  const s = String(xml || ''), ops = [];
  for (const m of s.matchAll(/<EntitySet\b([^>]*?)(\/>|>([\s\S]*?)<\/EntitySet>)/g)) {
    const name = attr(m[1], 'Name'); if (!name) continue;
    const body = m[3] || '';
    const no = term => new RegExp(`Capabilities\\.V1\\.${term}[\\s\\S]*?(Insertable|Updatable|Deletable)"?\\s*Bool="false"`).test(body)
      || new RegExp(`Capabilities\\.V1\\.${term}"[^>]*>\\s*<Record>\\s*<PropertyValue[^>]*Bool="false"`).test(body);
    ops.push({ entity: name, operation: 'list', method: 'GET', path: `/${name}`, kind: 'list' },
             { entity: name, operation: 'get', method: 'GET', path: `/${name}({key})`, kind: 'get' });
    if (!no('InsertRestrictions')) ops.push({ entity: name, operation: 'create', method: 'POST', path: `/${name}`, kind: 'create' });
    if (!no('UpdateRestrictions')) ops.push({ entity: name, operation: 'update', method: 'PATCH', path: `/${name}({key})`, kind: 'update' });
    if (!no('DeleteRestrictions')) ops.push({ entity: name, operation: 'delete', method: 'DELETE', path: `/${name}({key})`, kind: 'delete' });
  }
  for (const m of s.matchAll(/<(FunctionImport|ActionImport)\b([^>]*?)\/?>/g)) {
    const name = attr(m[2], 'Name'); if (!name) continue;
    const fn = m[1] === 'FunctionImport';
    ops.push({ entity: attr(m[2], 'EntitySet') || name, operation: name, method: fn ? 'GET' : 'POST', path: `/${name}`, kind: fn ? 'list' : 'action' });
  }
  const ns = /<Schema\b[^>]*Namespace="([^"]+)"/.exec(s)?.[1] || null;
  return { ops, title: ns, version: /<edmx:Edmx\b[^>]*Version="([^"]+)"/.exec(s)?.[1] || null };
}

/* a SOAP or GraphQL operation name split into its verb and the thing it acts on */
const VERB = /^(get|list|find|search|query|read|retrieve|fetch|create|add|insert|update|modify|set|delete|remove|void|send|cancel|approve|reject|submit|upsert|merge)/i;
const splitName = n => { const m = VERB.exec(n); return m ? { verb: m[1], entity: n.slice(m[1].length).replace(/^[_-]/, '') || n } : { verb: n, entity: n }; };

/** WSDL: every portType operation, POSTed to its service. */
export function fromWsdl(xml) {
  const s = String(xml || ''), ops = [], seen = new Set();
  const service = /<([\w-]+:)?service\b[^>]*name="([^"]+)"/.exec(s)?.[2] || 'Service';
  for (const pt of s.matchAll(/<([\w-]+:)?portType\b[^>]*>([\s\S]*?)<\/([\w-]+:)?portType>/g))
    for (const m of pt[2].matchAll(/<([\w-]+:)?operation\b[^>]*name="([^"]+)"/g)) {
      const name = m[2]; if (seen.has(name)) continue; seen.add(name);
      const { verb, entity } = splitName(name);
      ops.push({ entity, operation: verb === name ? name : verb, operation_id: name, method: 'POST', path: `/${service}/${name}`, kind: kindFromOperation(verb === name ? name : verb) });
    }
  return { ops, title: service, version: null };
}

/** RAML 1.0 / 0.8: resources by indentation, their methods. */
export function fromRaml(text) {
  const lines = String(text || '').split(/\r?\n/), ops = [], stack = [];
  const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() || null, version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim() || null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.length - l.trimStart().length, t = l.trim();
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    const r = /^(\/[^:]*):\s*$/.exec(t);
    if (r) { stack.push({ ind, seg: r[1] }); continue; }
    const mm = /^(get|post|put|patch|delete)\??:\s*$/.exec(t);
    if (mm && stack.length) {
      const path = stack.map(x => x.seg).join('');
      const segs = path.split('/').filter(x => x && !/^\{/.test(x));
      let summary = null;
      for (let j = i + 1; j < lines.length && (lines[j].length - lines[j].trimStart().length > ind || !lines[j].trim()); j++) {
        const d = /^\s*(displayName|description):\s*(.+)$/.exec(lines[j]); if (d) { summary = d[2].replace(/^["'|>-]+\s*/, '').trim() || summary; if (d[1] === 'displayName') break; }
      }
      const method = mm[1].toUpperCase();
      const kind = method === 'GET' ? (/\}$/.test(path) ? 'get' : 'list') : method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
      ops.push({ entity: pascal(segs[segs.length - 1] || 'api'), operation: summary || `${method.toLowerCase()} ${segs[segs.length - 1] || ''}`.trim(), method, path, summary, kind });
    }
  }
  return { ops, title, version };
}

/** GraphQL SDL or an introspection result: Query fields read, Mutation fields write or act. */
export function fromGraphQL(text) {
  const t = String(text || '').trim(), ops = [];
  const add = (root, name, isList, returns) => {
    const { verb, entity } = splitName(name);
    const kind = root === 'query' ? (isList ? 'list' : 'get') : kindFromOperation(verb === name ? name : verb);
    ops.push({ entity: pascal(String(returns || entity).replace(/(Connection|Edge|Payload|Result|Response)$/, '') || entity), operation: name, operation_id: `${root}_${name}`, method: 'POST', path: `${root} ${name}`, kind });
  };
  if (t.startsWith('{')) {
    const j = JSON.parse(t), sc = j.__schema || j.data?.__schema;
    const byName = new Map((sc?.types || []).map(x => [x.name, x]));
    const unwrap = ty => { let list = false; while (ty && (ty.kind === 'NON_NULL' || ty.kind === 'LIST')) { if (ty.kind === 'LIST') list = true; ty = ty.ofType; } return { list, name: ty?.name || null }; };
    for (const [root, key] of [['query', 'queryType'], ['mutation', 'mutationType']]) {
      const ty = byName.get(sc?.[key]?.name);
      for (const f of ty?.fields || []) { const u = unwrap(f.type); add(root, f.name, u.list || /Connection$/.test(u.name || ''), u.name); }
    }
    return { ops, title: null, version: null };
  }
  for (const m of t.matchAll(/\b(?:extend\s+)?type\s+(Query|Mutation)\s*\{([\s\S]*?)\n\}/g)) {
    const root = m[1].toLowerCase();
    let body = m[2].replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
    /* arguments may span lines: drop them before reading one field per line */
    let prev; do { prev = body; body = body.replace(/\([^()]*\)/g, ''); } while (body !== prev);
    for (const f of body.matchAll(/^\s*(\w+)\s*:\s*([^\n]+)$/gm)) {
      const ret = f[2].trim(); const named = /(\w+)/.exec(ret.replace(/[[\]!]/g, ' '))?.[1] || null;
      add(root, f[1], /^\[/.test(ret) || /Connection\b/.test(ret), named);
    }
  }
  return { ops, title: null, version: null };
}

export const CONVERTERS = { postman: fromPostman, odata: fromOData, wsdl: fromWsdl, raml: fromRaml, graphql: fromGraphQL };

/* ── rungs 2 (sdk) and 3 · a model's extraction, checked ─────────────────── */
/**
 * Keep the extracted operations a reader can check: the page is in the inventory and saved, and the
 * evidence is that page's own words. Duplicates (same entity, operation and method) are merged,
 * the first page kept.
 * @param {object[]} ops
 * @param {{inventory: Map<string, object>, snapshot: (url: string) => ({text: string}|null)}} ctx
 */
export function mergeOps(ops, ctx) {
  const kept = [], rejected = [], seen = new Map();
  let duplicates = 0;
  for (const o of ops || []) {
    const why = [];
    const method = String(o?.method || '').toUpperCase();
    if (!o?.entity) why.push('no entity');
    if (!o?.operation) why.push('no operation');
    if (!METHODS.includes(method)) why.push(`method "${o?.method ?? ''}" is not one of ${METHODS.join(', ')}`);
    if (!o?.path) why.push('no path');
    const url = normalizeUrl(o?.doc_url || '');
    const page = url ? ctx.inventory.get(url) : null;
    if (!url) why.push('no doc_url');
    else if (!page) why.push(`doc_url is not in the inventory: ${o.doc_url}`);
    else if (page.status === 'excluded') why.push(`doc_url was excluded from the inventory (${page.reason || 'no reason'})`);
    const snap = page ? ctx.snapshot(url) : null;
    if (page && !snap) why.push(`no saved text for ${o.doc_url} — snap it before extracting`);
    if (!o?.evidence) why.push('no evidence');
    else if (snap && !contains(snap.text, o.evidence)) why.push('evidence is not on the page word for word');
    if (o?.kind && !OP_KINDS.includes(o.kind)) why.push(`kind "${o.kind}" is not one of ${OP_KINDS.join(', ')}`);
    if (why.length) { rejected.push({ op: o, why }); continue; }
    const key = `${String(o.entity).toLowerCase()}|${String(o.operation).toLowerCase().replace(/\s+/g, ' ').trim()}|${method}`;
    if (seen.has(key)) { duplicates++; const k = seen.get(key); if (url !== k.doc_url && !(k.also || []).includes(url)) (k.also ||= []).push(url); continue; }
    const rec = { entity: String(o.entity).trim(), operation: String(o.operation).trim(), method, path: String(o.path).trim(),
      summary: o.summary ? String(o.summary).trim() : null, doc_url: url, evidence: String(o.evidence).trim(),
      ...(o.kind ? { kind: o.kind } : {}), ...(o.operation_id ? { operation_id: String(o.operation_id) } : {}) };
    seen.set(key, rec); kept.push(rec);
  }
  return { kept, rejected, duplicates };
}

/* ── is anything missing? ────────────────────────────────────────────────── */
const nrm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sing = s => s.replace(/ies$/, 'y').replace(/sses$/, 'ss').replace(/([^s])s$/, '$1');
/**
 * The connector's tables and an SDK's entities that no extracted operation acts on — for a person to
 * review (a page missed, a layout the extraction did not read), never added automatically. A table
 * counts as covered when its name starts with an entity's (InvoiceLineItems → Invoice).
 */
export function completenessHint(ops, { tables = [], entities = [] } = {}) {
  const ents = [...new Set(ops.map(o => sing(nrm(o.entity))).filter(Boolean))];
  const covered = n => { const x = sing(nrm(n)); return !!x && ents.some(e => x === e || x.startsWith(e) || e.startsWith(x)); };
  return { tables: [...new Set(tables)].filter(t => !covered(t)).sort(), entities: [...new Set(entities)].filter(e => !covered(e)).sort() };
}
