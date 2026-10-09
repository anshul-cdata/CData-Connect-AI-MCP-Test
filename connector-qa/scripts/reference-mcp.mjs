#!/usr/bin/env node
/**
 * reference-mcp.mjs — Stage 1.5e: compare with the source vendor's own MCP server (3.8, on by default;
 * config.capabilities.compare_vendor_mcp, --no-compare-mcp skips it for one run).
 *
 *   node reference-mcp.mjs read   --dir <connectorDir> --tools <file> [--name <server>] [--url <endpoint>]
 *                                 [--source session|docs] [--doc-url <page>]
 *   node reference-mcp.mjs prep   --dir <connectorDir> [--areas a,b] [--redo]
 *   node reference-mcp.mjs apply  --dir <connectorDir> --mapping <file>
 *   node reference-mcp.mjs status --dir <connectorDir> [--areas a,b]
 *   node reference-mcp.mjs none   --dir <connectorDir> --note "<what was checked>" [--doc-url <page>]
 *
 * read    stores the vendor server's tool list in <Connector>_reference_mcp.json. The list comes
 *         from the server itself when it is connected in the session (its tools/list: name,
 *         description, input schema) or from the vendor's published tool reference. A changed list
 *         drops the mapping of every tool that is gone.
 * prep    writes _agent_out/reference-mcp-input.json: the capabilities in scope not yet compared,
 *         each with the tools whose names suggest it, for one mapping agent to judge.
 * apply   checks the agent's {"mapping":[{"cap","status","tools","note"}],"extra":[{"tool","note"}]}
 *         (covered · partly · not_covered; tools must exist; partly says what is missing) and stores it.
 * status  prints the three-way comparison: both · only CData · only the vendor MCP · neither.
 * none    records that the vendor has no MCP server (what was checked, and when), so the stage is
 *         not repeated on every run; reports say so. A later `read` replaces it.
 *
 * Nothing here touches the capability list, the catalog or the results store, so a comparison
 * changes no fingerprint and no stored result; the reports show it beside what they already show.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, fail, EXIT, nowIso, SCHEMA_VERSION, loadConfig } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { resolveAreas } from './lib/scope.mjs';
import { normalizeTools, toolsHash, suggestTools, capsInScope, mappingProblems, compareView, REF_STATUSES, BUCKET_LABEL, BUCKET_ORDER } from './lib/reference-mcp.mjs';

const CMDS = ['read', 'prep', 'apply', 'status', 'none'];
const a = parseArgs(process.argv.slice(2), { known: ['dir', 'connector', 'tools', 'name', 'url', 'source', 'doc-url', 'areas', 'redo', 'mapping', 'note'],
  usage: `usage: reference-mcp.mjs <${CMDS.join('|')}> --dir <connectorDir>` });
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: reference-mcp.mjs <${CMDS.join('|')}> --dir <connectorDir> [--tools f | --mapping f] [--areas a,b]`); process.exit(EXIT.USAGE); }
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
if (!existsSync(P('capabilities'))) fail(`no ${P('capabilities')} — build the capability list first (Stage 1.5)`);
const capsDoc = readJson(P('capabilities'));
const REF = P('reference_mcp');
const ref = existsSync(REF) ? readJson(REF) : null;
const parse = f => JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/^```(?:json)?\s*|\s*```\s*$/g, ''));
const areas = (() => {
  if (!a.areas || a.areas === true) return null;
  const { ids, unknown } = resolveAreas(capsDoc, a.areas);
  if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')}`, EXIT.USAGE);
  return ids;
})();
const str = v => (v && v !== true ? String(v) : null);

if (cmd === 'read') {
  if (!a.tools || !existsSync(a.tools)) fail('--tools must name the tool list (a tools/list reply, {"tools":[…]} or an array)', EXIT.USAGE);
  const raw = parse(a.tools);
  const tools = normalizeTools(raw);
  if (!tools.length) fail(`${a.tools} lists no tools`);
  const source = str(a.source) || raw?.source?.kind || 'docs';
  if (!['session', 'docs'].includes(source)) fail('--source is session (the server connected here) or docs (the vendor\'s published list)', EXIT.USAGE);
  const hash = toolsHash(tools), names = new Set(tools.map(t => t.name));
  /* a tool that is gone takes its mapping with it; a capability it alone covered must be compared again */
  const mapping = {}, dropped = [];
  for (const [id, v] of Object.entries(ref?.mapping || {})) {
    if ((v.tools || []).every(t => names.has(t))) mapping[id] = v; else dropped.push(id);
  }
  const doc = {
    schema_version: SCHEMA_VERSION, connector: conn,
    server: { name: str(a.name) || raw?.server?.name || `${conn} MCP server`, url: str(a.url) || raw?.server?.url || null, version: raw?.server?.version || null },
    source: { kind: source, url: str(a['doc-url']) || raw?.source?.url || null, title: raw?.source?.title || null, notes: raw?.source?.notes || null },
    read_at: raw?.source?.read_at || nowIso(), tools_hash: hash, tools,
    mapping, mapped_at: ref?.mapped_at || null, extra: (ref?.extra || []).filter(x => names.has(x.tool)),
  };
  writeJson(REF, doc);
  console.log(`REFERENCE MCP — ${conn} · ${doc.server.name} · ${tools.length} tools (${tools.filter(t => t.access === 'read').length} read · ${tools.filter(t => t.access === 'write').length} write) from ${source}`);
  if (ref && ref.tools_hash !== hash) console.log(`  tool list changed since ${String(ref.read_at || '').slice(0, 10)}${dropped.length ? ` — ${dropped.length} mapping(s) dropped, compare them again (prep)` : ''}`);
  console.log(`→ ${REF}`);
  process.exit(EXIT.OK);
}

if (cmd === 'none') {
  const note = str(a.note);
  if (!note) fail('--note must say what was checked (the vendor\'s developer docs, its MCP directory listing…)', EXIT.USAGE);
  if (ref?.tools?.length && Object.keys(ref.mapping || {}).length) fail(`${REF} already holds a compared server (${ref.server?.name}) — remove it first if the vendor withdrew it`);
  writeJson(REF, { schema_version: SCHEMA_VERSION, connector: conn, none: true, server: null, checked_at: nowIso(), note,
    source: { kind: 'docs', url: str(a['doc-url']) } , tools: [], mapping: {}, extra: [] });
  console.log(`REFERENCE MCP — ${conn} · no vendor MCP server (recorded; checked again after ${loadConfig().capabilities?.vendor_mcp_recheck_days ?? 90} days)\n→ ${REF}`);
  process.exit(EXIT.OK);
}

if (ref?.none && cmd !== 'status') fail(`${REF} records that ${conn} has no MCP server (${String(ref.checked_at || '').slice(0, 10)}) — run read --tools <file> if one exists now`);
if (!ref?.tools?.length && !ref?.none) fail(`no ${REF} — read the vendor server's tool list first (reference-mcp.mjs read --tools <file>)`);

if (cmd === 'prep') {
  const scope = capsInScope(capsDoc, areas).filter(c => a.redo || !ref.mapping?.[c.id]);
  const OUT = join(a.dir, '_agent_out', 'reference-mcp-input.json');
  writeJson(OUT, {
    connector: conn, server: ref.server, at: nowIso(),
    instructions: [
      `For each capability (an operation of ${conn}'s own API), decide whether the vendor's MCP server "${ref.server?.name}" can do it with its tools, from the tool names, descriptions and parameters below — not from what the API can do.`,
      `status: covered (a tool does it fully) · partly (some of it: fewer fields or filters, one record where the API takes many, read but not write…) · not_covered. ${REF_STATUSES.join(' / ')} only.`,
      'tools: the exact tool name(s) that do it (required unless not_covered). note: one plain sentence; for partly, say what is missing.',
      '"suggested" lists tools whose names share words with the capability — a hint only; check each.',
      'Then list under "extra" every tool that does something no capability below covers, with a note on what it does.',
      'Return {"mapping":[{"cap","status","tools":[…],"note"}],"extra":[{"tool","note"}]} with one mapping entry per capability.',
    ],
    tools: ref.tools,
    capabilities: scope.map(c => ({ cap: c.id, label: c.label, api: c.method ? `${String(c.method).toUpperCase()} ${c.path}` : null,
      cdata: c.mapping?.status, suggested: suggestTools(c, ref.tools) })),
  });
  console.log(`REFERENCE MCP PREP — ${conn} · ${scope.length} capabilit${scope.length === 1 ? 'y' : 'ies'} to compare with ${ref.tools.length} vendor tools${areas ? ` (areas ${areas.join(', ')})` : ''}\n→ ${OUT}`);
  process.exit(EXIT.OK);
}

if (cmd === 'apply') {
  if (!a.mapping || !existsSync(a.mapping)) fail('--mapping must name the mapping agent\'s result', EXIT.USAGE);
  const m = parse(a.mapping);
  const scope = capsInScope(capsDoc, null);
  const problems = mappingProblems(m, scope, ref.tools);
  if (problems.length) { console.error(`REFERENCE MCP — ${problems.length} problem(s), nothing stored:\n  ${problems.slice(0, 40).join('\n  ')}`); process.exit(EXIT.DATA); }
  const at = nowIso();
  const mapping = { ...(ref.mapping || {}) };
  for (const e of m.mapping || []) mapping[e.cap] = { status: e.status, tools: e.tools || [], note: String(e.note || '').trim() || null, at };
  const extra = new Map((ref.extra || []).map(x => [x.tool, x]));
  for (const x of m.extra || []) extra.set(x.tool, { tool: x.tool, note: String(x.note || '').trim() || null });
  writeJson(REF, { ...ref, mapping, extra: [...extra.values()], mapped_at: at });
  console.log(`REFERENCE MCP — ${conn} · ${(m.mapping || []).length} capabilit${(m.mapping || []).length === 1 ? 'y' : 'ies'} compared · ${Object.keys(mapping).length} in total · ${extra.size} vendor-only tool(s)\n→ ${REF}`);
  process.exit(EXIT.OK);
}

/* status */
const age = d => d ? Math.floor((Date.now() - Date.parse(d)) / 864e5) : null;
const recheck = loadConfig().capabilities?.vendor_mcp_recheck_days ?? 90;
if (ref.none) {
  const old = age(ref.checked_at) > recheck;
  console.log(`REFERENCE MCP — ${conn} · no vendor MCP server (checked ${String(ref.checked_at || '').slice(0, 10)}: ${ref.note})${old ? ` — older than ${recheck} days, check again` : ''}`);
  process.exit(EXIT.OK);
}
const v = compareView({ capsDoc, ref, catalog: existsSync(P('catalog')) ? readJson(P('catalog')) : null, areas });
const scopeN = capsInScope(capsDoc, areas).length;
console.log(`REFERENCE MCP — ${conn} · ${ref.server?.name} · ${ref.tools.length} tools · source ${ref.source?.kind}${ref.source?.url ? ` (${ref.source.url})` : ''}${age(ref.read_at) > recheck ? ` — tool list older than ${recheck} days, read it again` : ''}`);
if (!v) { console.log(`  nothing compared yet — ${scopeN} capabilities in scope: run prep, dispatch the mapping agent, then apply`); process.exit(EXIT.OK); }
const line = b => BUCKET_ORDER.filter(k => b[k]).map(k => `${b[k]} ${BUCKET_LABEL[k].replace(/^./, c => c.toLowerCase())}`).join(' · ');
console.log(`  capabilities (${v.caps.total}): ${line(v.caps.buckets)}`);
for (const ar of v.areas) console.log(`    ${ar.name}: ${line(ar.buckets)}`);
if (v.use_cases.total) console.log(`  use cases (${v.use_cases.total}), everything each needs: ${line(v.use_cases.buckets)}`);
if (v.extra.length) console.log(`  vendor tools outside the API's capabilities: ${v.extra.map(x => x.tool).join(', ')}`);
if (v.caps.buckets.unmapped) console.log(`  ${v.caps.buckets.unmapped} not compared yet — run prep${areas ? ` --areas ${areas.join(',')}` : ''}`);
