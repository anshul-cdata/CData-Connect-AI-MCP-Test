/* capabilities.mjs — what the source system can do, read from its own API description, and how
 * the connector exposes each of it.
 *
 * The question this runtime answers since 3.0 is "can I do through CData what <source> can do?".
 * That needs a denominator that does not come from us: not from the connector's table list (which
 * cannot show what is missing) and not from a model's research (which varies by run and by model).
 * The source's API description is that denominator. Reading it is mechanical, so it is code.
 *
 *   parseSpec(text)          → { title, version, operations: [...] }   OpenAPI 3 JSON or YAML
 *   toCapabilities(spec)     → capability records with a stable id, kind and noun
 *   mapToConnector(caps, K)  → each capability's exposure through the connector, with confidence
 *
 * The YAML reader is a targeted line scanner, not a YAML implementation: it reads the `paths`
 * block of an OpenAPI file — path keys, method keys, and the summary / operationId / tags /
 * parameters / requestBody / deprecated fields under each method. That is all a capability list
 * needs, and it keeps the toolkit free of dependencies. Anything it cannot read is left out and
 * counted, never guessed.
 */

import { applyFileTransfer } from './file-transfer.mjs';

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/* ── parsing ─────────────────────────────────────────────────────────────── */

export function parseSpec(text) {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw new Error('the API description is empty');
  if (t.startsWith('{')) return fromJson(JSON.parse(t));
  return fromYaml(t);
}

function fromJson(spec) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const m of METHODS) {
      const op = item && item[m];
      if (!op) continue;
      /* 3.9 — an assembled list (api-from-docs.mjs) carries the documented path, the entity and kind
       * the reference pages name, and the page and line each operation was read from. A vendor's own
       * OpenAPI has none of these, so what it yields is unchanged. */
      const asm = {
        ...(op['x-entity'] ? { entity: op['x-entity'] } : {}), ...(op['x-operation'] ? { operation: op['x-operation'] } : {}),
        ...(op['x-kind'] ? { kind_hint: op['x-kind'] } : {}),
        ...(op['x-doc-url'] ? { doc_url: op['x-doc-url'] } : {}), ...(op['x-evidence'] ? { evidence: op['x-evidence'] } : {}),
      };
      ops.push({
        method: m.toUpperCase(), path: op['x-path'] || path,
        operationId: op.operationId || null,
        summary: String(op.summary || op.description || '').split('\n')[0].trim(),
        tags: Array.isArray(op.tags) ? op.tags : [],
        params: (op.parameters || []).map(p => p.name || (p.$ref ? String(p.$ref).split('/').pop() : null)).filter(Boolean),
        has_body: !!op.requestBody || (!!op['x-kind'] && ['post', 'put', 'patch'].includes(m)),
        deprecated: op.deprecated === true,
        ...asm,
      });
    }
  }
  return { title: spec.info?.title || null, version: spec.info?.version || null, operations: ops,
           ...(spec.info?.['x-assembled'] ? { assembled: spec.info['x-assembled'] } : {}) };
}

const unquote = v => String(v ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
const indentOf = l => l.length - l.trimStart().length;

function fromYaml(text) {
  const lines = text.split(/\r?\n/);
  let title = null, version = null;
  /* info.title / info.version — first occurrence under a top-level `info:` */
  const infoAt = lines.findIndex(l => /^info:\s*$/.test(l));
  if (infoAt >= 0) for (let i = infoAt + 1; i < lines.length && (lines[i] === '' || /^\s/.test(lines[i])); i++) {
    const m = /^\s+(title|version):\s*(.+)$/.exec(lines[i]);
    if (m && indentOf(lines[i]) <= 4) { if (m[1] === 'title' && !title) title = unquote(m[2]); if (m[1] === 'version' && !version) version = unquote(m[2]); }
  }
  const pathsAt = lines.findIndex(l => /^paths:\s*$/.test(l));
  const ops = [];
  if (pathsAt < 0) return { title, version, operations: ops };

  /* State. Only keys at exactly one indent below the method (`fieldIndent`) belong to the
   * operation: a `description` inside `responses`, or a `deprecated: true` on a request-body
   * property, is deeper and is never read as the operation's. Path-level `parameters` (before or
   * after the methods) apply to every operation of that path. */
  let pathIndent = null, path = null, pathParams = [], pathOps = [];
  let op = null, methodIndent = null, fieldIndent = null, list = null, listIndent = null;
  const flushOp = () => { if (op) { pathOps.push(op); ops.push(op); } op = null; list = null; fieldIndent = null; };
  const flushPath = () => {
    flushOp();
    for (const o of pathOps) o.params = [...new Set([...pathParams, ...o.params])];
    pathParams = []; pathOps = [];
  };
  const paramName = item => {
    const n = /^(name|\$ref):\s*(.+)$/.exec(item);
    return n ? (n[1] === 'name' ? unquote(n[2]) : unquote(n[2]).split('/').pop()) : null;
  };
  /* the first non-empty line of a block scalar (`summary: >-`) */
  const blockText = (from, ind) => {
    for (let j = from + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= ind) return '';
      return lines[j].trim();
    }
    return '';
  };
  let pathList = null, pathListIndent = null;

  for (let i = pathsAt + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = indentOf(raw);
    if (ind === 0) break;                                   // next top-level key: paths block ended
    const line = raw.trim();

    const pm = /^(['"]?)(\/[^'"]*?)\1:\s*$/.exec(line);
    if (pm && (pathIndent === null || ind === pathIndent)) { flushPath(); pathIndent = ind; path = pm[2]; pathList = null; continue; }
    if (path === null) continue;

    const mm = /^(get|post|put|patch|delete):\s*$/.exec(line);
    if (mm && ind > pathIndent && (methodIndent === null || ind === methodIndent)) {
      flushOp(); methodIndent = ind; pathList = null;
      op = { method: mm[1].toUpperCase(), path, operationId: null, summary: '', tags: [], params: [], has_body: false, deprecated: false };
      continue;
    }

    /* path-level keys (siblings of the methods) */
    if (ind <= (methodIndent ?? pathIndent + 2) && ind > pathIndent) {
      flushOp();
      if (/^parameters:\s*$/.test(line)) { pathList = 'parameters'; pathListIndent = ind; } else pathList = null;
      continue;
    }
    if (!op) {
      if (pathList === 'parameters' && ind > pathListIndent) {
        const nm = paramName(line.replace(/^-\s*/, ''));
        if (nm && !pathParams.includes(nm)) pathParams.push(nm);
      }
      continue;
    }

    /* inside a method block */
    if (fieldIndent === null) fieldIndent = ind;
    if (list && ind > listIndent) {
      if (list === 'tags' && /^-\s*/.test(line)) op.tags.push(unquote(line.replace(/^-\s*/, '')));
      else if (list === 'parameters') {
        const nm = paramName(line.replace(/^-\s*/, ''));
        if (nm && !op.params.includes(nm)) op.params.push(nm);
      }
      continue;
    }
    if (ind !== fieldIndent) continue;                       // deeper than the operation's own keys
    list = null;

    const kv = /^([A-Za-z$][\w$-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, val] = kv;
    const scalar = /^[|>][-+]?\s*$/.test(val.trim()) ? blockText(i, ind) : unquote(val);
    if (key === 'summary' && !op.summary) op.summary = scalar;
    else if (key === 'description' && !op.summary) op.summary = scalar;
    else if (key === 'operationId') op.operationId = unquote(val);
    else if (key === 'deprecated') op.deprecated = /^true$/i.test(val.trim());
    else if (key === 'requestBody') op.has_body = true;
    else if (key === 'tags') {
      if (/^\[.*\]$/.test(val.trim())) op.tags = val.trim().slice(1, -1).split(',').map(unquote).filter(Boolean);
      else if (val.trim() && !val.trim().startsWith('*')) op.tags = [unquote(val)];
      else { list = 'tags'; listIndent = ind; }
    } else if (key === 'parameters') { list = 'parameters'; listIndent = ind; }
  }
  flushPath();
  return { title, version, operations: ops };
}

/* ── capabilities ────────────────────────────────────────────────────────── */

const isParam = s => /^\{.*\}$/.test(s);
/* An action segment is a verb in lowerCamelCase with a capital after it (addFollowers, setParent,
 * instantiateTask) or one of a few bare verbs (duplicate). Plain plural nouns — attachments,
 * settings, runs, updates, approvals — are resources, never actions, even when they start like a
 * verb. */
const ACTION_CAMEL = /^(add|remove|set|insert|move|reorder|attach|detach|update|clear|duplicate|instantiate|approve|reject|archive|unarchive|restore|complete|reset|send|trigger|run|create|delete)[A-Z][A-Za-z]*$/;
const ACTION_BARE = new Set(['duplicate', 'instantiate', 'approve', 'reject', 'archive', 'unarchive', 'restore', 'reset', 'trigger']);
export const isAction = s => ACTION_CAMEL.test(s) || ACTION_BARE.has(s);

export function classify(op) {
  const segs = op.path.split('/').filter(Boolean);
  const last = segs[segs.length - 1] || '';
  const nouns = segs.filter(s => !isParam(s) && !isAction(s));
  const noun = nouns[nouns.length - 1] || segs[0] || '';
  let kind;
  if (op.method === 'GET') kind = isParam(last) ? 'get' : 'list';
  else if (op.method === 'DELETE') kind = 'delete';
  else if (op.method === 'PUT' || op.method === 'PATCH') kind = 'update';
  else kind = (!isParam(last) && isAction(last)) ? 'action' : 'create';
  return { kind, noun, parent: nouns.length > 1 ? nouns[nouns.length - 2] : null, action: kind === 'action' ? last : null };
}

const slug = s => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
const humanLabel = (op, c) => op.summary || `${c.kind} ${c.noun.replace(/_/g, ' ')}`;

const KIND_SET = new Set(['list', 'get', 'create', 'update', 'delete', 'action']);
const camelOf = s => String(s || '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase()).join('');
export function toCapabilities(spec) {
  const seen = new Set();
  return spec.operations.map(op => {
    const c = classify(op);
    /* an assembled operation names its entity and kind: a documented path such as
     * POST /v3/company/{realmId}/invoice?operation=void says neither in a form classify() reads */
    if (op.entity) { c.noun = op.entity; c.parent = null; }
    if (KIND_SET.has(op.kind_hint)) { c.kind = op.kind_hint; c.action = c.kind === 'action' ? camelOf(op.operation) || c.action : null; }
    let id = 'CAP-' + slug(op.operationId || `${op.method}_${op.path}`);
    while (seen.has(id)) id += '_x';
    seen.add(id);
    return {
      id, label: humanLabel(op, c), method: op.method, path: op.path, operation_id: op.operationId,
      resource: op.tags[0] || c.noun, noun: c.noun, parent: c.parent, kind: c.kind, action: c.action,
      params: op.params, has_body: op.has_body, deprecated: op.deprecated,
      ...(op.doc_url ? { doc_url: op.doc_url } : {}), ...(op.evidence ? { evidence: op.evidence } : {}),
    };
  });
}

/* ── mapping to the connector ────────────────────────────────────────────── */

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sing = s => s.replace(/ies$/, 'y').replace(/sses$/, 'ss').replace(/([^s])s$/, '$1');
const variants = s => { const n = norm(s); return [...new Set([n, sing(n), n + 's', sing(n) + 's'])]; };

/** The connector table that carries a source noun, or null. Exact (singular/plural) beats suffix;
 * a suffix match is only ever `medium`, so the review sees it. */
export function tableFor(noun, tables) {
  const v = variants(noun);
  const exact = tables.find(t => v.includes(norm(t)) || v.includes(sing(norm(t))));
  if (exact) return { name: exact, confidence: 'high' };
  const suffix = tables.filter(t => v.some(x => x.length > 3 && (norm(t).endsWith(x) || sing(norm(t)).endsWith(sing(x)))))
    .sort((a, b) => a.length - b.length)[0];
  return suffix ? { name: suffix, confidence: 'medium' } : null;
}

/**
 * The connector procedure that performs a source action, or null.
 * @param {object} cap
 * @param {({name: string, required_params?: string[], params?: (string|object)[]}|string)[]} procs
 */
export function procedureFor(cap, procs) {
  const op = norm(cap.operation_id || '');
  const act = norm(cap.action || '');
  const nounN = sing(norm(cap.parent || cap.noun));
  const list = procs.map(p => typeof p === 'string' ? { name: p } : p);
  const scored = list.map(p => {
    const n = norm(p.name);
    let score = 0;
    if (op && (op === n || op.startsWith(n) || n.startsWith(op))) score = 3;
    else if (act && (n === act || n.startsWith(act) || act.startsWith(n))) score = 2;
    else if (act && n.includes(act.replace(/s$/, ''))) score = 1;
    /* The noun must agree. AddFollowersForTask is not AddFollowersForProject; and a procedure that
     * names no noun (AddFollowers) only counts for projects when its parameters say so — Asana's
     * AddFollowers takes a TaskId, so addFollowersForProject must go to review. */
    const params = [...(p.required_params || []), ...(p.params || []).map(x => typeof x === 'string' ? x : x?.name)].filter(Boolean).map(norm);
    const namesNoun = !!nounN && (n.endsWith(nounN) || n.endsWith(nounN + 's') || n.includes('for' + nounN));
    const paramNoun = !!nounN && params.some(x => x.startsWith(nounN));
    const otherNounParam = params.some(x => /(id|gid)$/.test(x) && !['id', 'gid'].includes(x) && !x.startsWith(nounN));
    if (score && /for[a-z]+$/.test(n) && nounN && !namesNoun) score -= 2;
    let conf = score >= 3 ? 'high' : score === 2 ? 'medium' : 'low';
    /* a generic procedure (AddFollowers with a TableName parameter) may well serve this noun, but
     * nothing in its name or parameters says so — the review confirms it */
    if (score > 0 && nounN && !namesNoun && !paramNoun) conf = otherNounParam ? 'low' : (conf === 'high' ? 'medium' : conf);
    return { p: p.name, score, conf };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.p.length - b.p.length);
  if (!scored.length) return null;
  return { name: scored[0].p, confidence: scored[0].conf };
}

const WRITE_OP = { create: 'insert', update: 'update', delete: 'delete' };
/* What a table's own remarks say it supports. CData drivers describe each table's operations
 * ("To Create, Update, Delete and Query the Projects table"); one connector-wide permission flag
 * cannot tell Projects (writable) from Stories (read-only). Returns null when the remarks are
 * silent about operations, so the caller asks for a review instead of guessing. */
const OP_WORDS = { insert: /\b(create|insert|add)\b/i, update: /\b(update|modify|edit)\b/i, delete: /\b(delete|remove)\b/i, select: /\b(query|read|select|retrieve|list|get)\b/i };
export function tableOps(obj) {
  const r = String(obj?.remarks || obj?.description || '');
  if (!/\b(to|can|supports?|allows?)\b[^.]*\b(create|insert|update|delete|query|read|select)\b/i.test(r)) return null;
  /* "you cannot delete them", "Delete is not supported" — a negation the word list would read as a
   * yes. Rather than parse it, send the table to review. */
  if (/\b(not|cannot|can't|never|unsupported|read-only|readonly)\b/i.test(r)) return null;
  return Object.fromEntries(Object.entries(OP_WORDS).map(([k, re]) => [k, re.test(r)]));
}

/**
 * Each capability's exposure. Status vocabulary:
 *   exposed        — the connector offers it (a table read, an INSERT/UPDATE/DELETE, a procedure)
 *   partly         — reachable but incomplete (set by review)
 *   not_exposed    — in the source's API, not offered by the connector: a CData gap
 *   not_applicable — not something a data connector should offer (auth flows, webhooks, …)
 *   product_only   — the source's product does it but its API does not (added by review, never here)
 *
 * Confidence decides what the model reviews: everything not `high`. A write is `high` only when
 * the table's own remarks and the connector's permissions agree.
 */
export function mapToConnector(caps, K, opts = {}) {
  const objects = K.objects || [];
  const tables = objects.map(o => o.name);
  const byName = new Map(objects.map(o => [o.name, o]));
  const procs = (K.physical?.procedures || []).map(p => typeof p === 'string' ? { name: p } : p);
  const perms = K.physical?.permissions || K.permissions || {};
  const naTags = new Set((opts.not_applicable_tags || []).map(norm));
  const naPath = opts.not_applicable_path ? new RegExp(opts.not_applicable_path, 'i') : null;

  const mapped = caps.map(c => {
    if (c.review) return c;                                   // a reviewed mapping is never recomputed
    if (c.mapping?.status === 'product_only') return c;
    let m;
    if (naTags.has(norm(c.resource)) || (naPath && c.path && naPath.test(c.path))) {
      m = { status: 'not_applicable', exposure: [], confidence: 'high', note: `${c.resource} is not a data capability` };
    } else if (c.kind === 'action') {
      const p = procedureFor(c, procs);
      m = p ? { status: 'exposed', exposure: [{ kind: 'procedure', name: p.name }], confidence: p.confidence }
            : { status: 'not_exposed', exposure: [], confidence: 'low', note: 'no procedure found for this action' };
    } else {
      const t = tableFor(c.noun, tables);
      if (!t) {
        m = { status: 'not_exposed', exposure: [], confidence: 'low', note: `no table found for "${c.noun}"` };
      } else if (c.kind === 'list' || c.kind === 'get') {
        m = { status: 'exposed', exposure: [{ kind: 'table', name: t.name, op: 'SELECT' }], confidence: t.confidence };
      } else {
        const perm = WRITE_OP[c.kind];
        const ops = tableOps(byName.get(t.name));
        const global = perms[perm] === true;
        /* a sub-resource create (POST /tasks/{gid}/subtasks) may be a procedure rather than an INSERT */
        const p = procedureFor({ ...c, action: c.kind + c.noun }, procs);
        /* a write MCP cannot run on the table (DELETE) goes to its procedure when there is one */
        if (p && !MCP_TABLE_OPS_DEFAULT.concat(opts.mcp_table_ops || []).map(s => s.toUpperCase()).includes(perm.toUpperCase())) {
          m = { status: 'exposed', exposure: [{ kind: 'procedure', name: p.name }], confidence: p.confidence === 'high' ? 'medium' : p.confidence };
        } else if (ops && ops[perm] && global) {
          m = { status: 'exposed', exposure: [{ kind: 'table', name: t.name, op: perm.toUpperCase() }], confidence: t.confidence };
        } else if (ops && ops[perm]) {
          m = { status: 'exposed', exposure: [{ kind: 'table', name: t.name, op: perm.toUpperCase() }], confidence: 'low',
                note: `${t.name}'s table description lists ${perm}, but ConnectAI MCP's permissions do not advertise it` };
        } else if (p) {
          m = { status: 'exposed', exposure: [{ kind: 'procedure', name: p.name }], confidence: p.confidence === 'high' ? 'medium' : p.confidence };
        } else if (ops) {
          m = { status: 'not_exposed', exposure: [{ kind: 'table', name: t.name, op: 'SELECT' }], confidence: t.confidence,
                note: `${t.name} does not support ${perm} — its table description lists ${Object.entries(ops).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no operations'}` };
        } else {
          /* remarks silent: the connector-wide flag is a guess either way, so it goes to review */
          m = global
            ? { status: 'exposed', exposure: [{ kind: 'table', name: t.name, op: perm.toUpperCase() }], confidence: 'low',
                note: `ConnectAI MCP advertises ${perm} in general; ${t.name}'s table description does not say` }
            : { status: 'not_exposed', exposure: [{ kind: 'table', name: t.name, op: 'SELECT' }], confidence: 'low',
                note: `${t.name} can be read, but ConnectAI MCP does not advertise ${perm.toUpperCase()}` };
        }
      }
    }
    /* 3.9.4: a procedure that needs a local file or stream cannot be called through the cloud MCP tools,
     * whatever its name matched — the parameters say so (lib/file-transfer.mjs) */
    return { ...c, mapping: applyFileTransfer(m, procs) };
  });
  enforceMcpReach(mapped, opts.mcp_table_ops);
  return mapped;
}

export const STATUSES = ['exposed', 'partly', 'not_exposed', 'not_applicable', 'product_only'];

/* 3.7 — what ConnectAI MCP can actually run. Its tools are queryData (SELECT only), execute_insert
 * (INSERT only), execute_update (UPDATE only) and executeProcedure; each rejects every other
 * statement. So a DELETE the driver supports on a table cannot be issued through MCP at all — Asana
 * listed 11 delete capabilities as supported this way. A table exposure whose operation MCP cannot
 * run is moved aside, and a capability left with nothing that can do the job is not supported
 * through ConnectAI MCP. config.capabilities.mcp_table_ops overrides the list if the server adds a
 * tool. Applied after mapping and after review, so a reviewed list is corrected too. */
export const MCP_TABLE_OPS_DEFAULT = ['SELECT', 'INSERT', 'UPDATE'];
export function enforceMcpReach(caps, ops = MCP_TABLE_OPS_DEFAULT) {
  const ok = new Set((ops || MCP_TABLE_OPS_DEFAULT).map(s => String(s).toUpperCase()));
  const changed = [];
  for (const c of caps || []) {
    const m = c.mapping;
    if (!m || !['exposed', 'partly'].includes(m.status)) continue;
    const ex = m.exposure || [];
    /* an exposure without an op takes it from the capability's method (a review may omit it) */
    const opOf = e => e.op || ({ DELETE: 'DELETE', PUT: 'UPDATE', PATCH: 'UPDATE' })[String(c.method || '').toUpperCase()] || null;
    const dead = ex.filter(e => e.kind === 'table' && opOf(e) && !ok.has(String(opOf(e)).toUpperCase()));
    if (!dead.length) continue;
    const live = ex.filter(e => !dead.includes(e));
    /* what is left must be able to do the job: a procedure, or a table operation other than a read */
    const doer = live.some(e => e.kind === 'procedure' || (e.kind === 'table' && String(e.op || '').toUpperCase() !== 'SELECT'));
    const opsTxt = [...new Set(dead.map(e => String(e.op).toUpperCase()))].join(', ');
    const why = `The connector supports ${opsTxt} on ${[...new Set(dead.map(e => e.name))].join(', ')}, but ConnectAI MCP has no tool that runs ${opsTxt}.`;
    c.mapping = { ...m, status: doer ? 'partly' : 'not_exposed', exposure: live, mcp_unreachable: dead,
                  note: doer ? `${m.note ? m.note + ' ' : ''}${why}` : why, ...(m.note ? { note_before_mcp_check: m.note } : {}) };
    changed.push(c.id);
  }
  return changed;
}

/** For a capability that creates records: a way to remove them again through ConnectAI MCP — a
 * delete procedure on the same resource — or null. A DELETE statement is not one (see above). */
export function cleanupPathFor(createCap, caps) {
  const base = p => String(p || '').replace(/\/\{[^}]+\}$/, '');
  const target = base(createCap?.path);
  if (!target) return null;
  const del = (caps || []).find(c => /^DELETE$/i.test(c.method || '') && base(c.path) === target
    && ['exposed', 'partly'].includes(c.mapping?.status) && (c.mapping.exposure || []).some(e => e.kind === 'procedure'));
  return del ? { capability: del.id, procedure: del.mapping.exposure.find(e => e.kind === 'procedure').name } : null;
}

/* 3.5 — does a use case only CHANGE existing records (update, delete, set), never create one? Such a
 * use case needs its record to exist before the run, or the change is never tested (Asana asn-tr1:
 * "the 90 minutes logged last Thursday should have been 60" on a task with no time entries). Read
 * from the capability list — method first, the name when there is no method. */
/* a POST to /things/{id}/addFollowers changes an existing record; a POST to /things creates one */
const onExisting = c => /\{[^}]+\}\/[^/{}]+\/?$/.test(String(c.path || '')) && /^POST$/i.test(c.method || '');
const CHANGES = c => /^(PUT|PATCH|DELETE)$/i.test(c.method || '') || onExisting(c) || (!c.method && /^(update|delete|remove|set|change|edit)\b/i.test(String(c.label || '')));
const CREATES = c => (/^POST$/i.test(c.method || '') && !onExisting(c)) || (!c.method && /^(create|add|insert|log|submit|upload)\b/i.test(String(c.label || '')));
/** Per business area, what the test account shows for the tables its capabilities use (3.6,
 * account-probe.mjs). `share` = tables holding data ÷ tables probed. */
export function accountReadiness(capsDoc, account) {
  const t = account?.tables || {};
  return (capsDoc?.areas || []).map(ar => {
    const ids = new Set([...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])]);
    const names = [...new Set((capsDoc.capabilities || []).filter(c => ids.has(c.id)).flatMap(c => (c.mapping?.exposure || []).filter(e => e.kind === 'table').map(e => e.name)))].filter(n => t[n]);
    const n = s => names.filter(x => t[x].status === s).length;
    return { id: ar.id, name: ar.name, tables: names.length, data: n('data'), empty: n('empty'), refused: n('refused'), needs_filter: n('needs_filter'),
             error: n('error'), share: names.length ? Math.round(100 * n('data') / names.length) / 100 : 0, empty_tables: names.filter(x => t[x].status === 'empty') };
  });
}

export function changesExisting(capIds, capById) {
  const w = (capIds || []).map(id => capById.get(typeof id === 'string' ? id : id?.id)).filter(c => c && (CHANGES(c) || CREATES(c)));
  return w.length > 0 && w.every(CHANGES);
}

/* A capability note is read by people deciding what to fix, so it says what works and what does not
 * through CData ConnectAI MCP — never how the mapping was arrived at. Review history ("Was wrongly
 * not_exposed: …", "Name match to DuplicateTask was wrong; …") is removed, and internal status names
 * are put in words. Applied when a review is stored and again when a report is built, so notes stored
 * before this rule read cleanly too. */
const HISTORY_PREFIX = /^\s*(?:was|were|is)\s+(?:wrongly|incorrectly|mistakenly)\s+[\w ]+?:\s*/i;
const HISTORY_CLAUSE = /\b(?:was|were)\s+(?:wrong(?:ly)?|incorrect(?:ly)?|mistaken(?:ly)?)\b|\bthe script\b|\bpreviously\b|\b(?:re|mis)-?mapped\b|\bname match\b|\bmatcher\b|\bheuristic\b/i;
const STATUS_WORDS = { not_exposed: 'not supported', product_only: 'not applicable', not_applicable: 'not applicable' };
export function readerNote(note) {
  if (note == null) return null;
  let s = String(note).trim().replace(HISTORY_PREFIX, '');
  s = s.split(/(?<=[.;])\s+/).filter(p => !HISTORY_CLAUSE.test(p)).join(' ').trim().replace(/;$/, '.');
  s = s.replace(/\b(not_exposed|product_only|not_applicable)\b/g, m => STATUS_WORDS[m]);
  return s ? s[0].toUpperCase() + s.slice(1) : null;
}

/** Counts by status, for summaries and the report's headline. Anything not `high` and not yet
 * reviewed is listed for review. */
export function summarize(caps) {
  const by = {};
  for (const c of caps) { const s = c.mapping?.status || 'unmapped'; by[s] = (by[s] || 0) + 1; }
  const applicable = caps.filter(c => !['not_applicable'].includes(c.mapping?.status)).length;
  return { total: caps.length, applicable, by_status: by,
           low_confidence: caps.filter(c => c.mapping && !['high', 'reviewed'].includes(c.mapping.confidence) && !c.review).map(c => c.id) };
}
