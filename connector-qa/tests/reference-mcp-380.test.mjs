/* 3.8 — the vendor's own MCP server beside CData ConnectAI MCP: a three-way gap analysis.
 *
 * The capability list already says, per API operation, whether CData ConnectAI MCP offers it.
 * reference-mcp.mjs records whether the vendor's MCP server does, in its own file, so the reports
 * can show both · only CData · only the vendor MCP · neither — and nothing else changes: no
 * capability list edit, no fingerprint, and a report without a comparison is what it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeTools, toolsHash, bucketOf, mappingProblems, compareView, capsInScope, suggestTools, BUCKET_ORDER } from '../scripts/lib/reference-mcp.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (script, args) => { const r = spawnSync(process.execPath, [join(SK, 'scripts', script), ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: String(r.stdout || '') + String(r.stderr || '') }; };

test('normalizeTools: any list shape, deduplicated, read/write told from hints and verbs', () => {
  const t = normalizeTools({ result: { tools: [
    { name: 'get_task', description: 'Get  one\ntask', inputSchema: { properties: { task_id: {}, opt_fields: {} } } },
    { name: 'create_tasks', description: 'Create tasks' },
    { name: 'asana_delete_task' },
    { name: 'summarize', annotations: { readOnlyHint: true } },
    { name: 'frobnicate' },
    { name: 'get_task', description: 'duplicate' },
  ] } });
  assert.deepEqual(t.map(x => [x.name, x.access]), [['asana_delete_task', 'write'], ['create_tasks', 'write'], ['frobnicate', 'other'], ['get_task', 'read'], ['summarize', 'read']]);
  assert.deepEqual(t.find(x => x.name === 'get_task').params, ['task_id', 'opt_fields']);
  assert.equal(t.find(x => x.name === 'get_task').description, 'Get one task');
  assert.equal(normalizeTools(['a_tool', 'b_tool']).length, 2);
  assert.equal(normalizeTools({}).length, 0);
  assert.equal(toolsHash(t), toolsHash([...t]));
});

test('bucketOf: both · only CData · only the vendor · neither · app only · not compared', () => {
  assert.equal(bucketOf('exposed', 'covered'), 'both');
  assert.equal(bucketOf('partly', 'partly'), 'both');
  assert.equal(bucketOf('exposed', 'not_covered'), 'cdata_only');
  assert.equal(bucketOf('not_exposed', 'covered'), 'vendor_only');
  assert.equal(bucketOf('not_exposed', 'not_covered'), 'neither');
  assert.equal(bucketOf('product_only', 'not_covered'), 'app_only');
  assert.equal(bucketOf('product_only', 'covered'), 'vendor_only');
  assert.equal(bucketOf('exposed', null), 'unmapped');
});

const cap = (id, label, method, path, status) => ({ id, label, method, path, mapping: { status, exposure: status === 'exposed' ? [{ kind: 'table', name: 'Tasks', op: 'SELECT' }] : [] } });
const capsDoc = {
  areas: [{ id: 'TM', name: 'Tasks', capability_ids: ['C1', 'C2', 'C3'] }, { id: 'AD', name: 'Admin', capability_ids: ['C4', 'C5'] }],
  capabilities: [cap('C1', 'Get a task', 'get', '/tasks/{id}', 'exposed'), cap('C2', 'Delete a task', 'delete', '/tasks/{id}', 'not_exposed'),
    cap('C3', 'Get task stories', 'get', '/tasks/{id}/stories', 'exposed'), cap('C4', 'Get a budget', 'get', '/budgets/{id}', 'not_exposed'),
    cap('C5', 'Capacity planning', null, null, 'product_only'), cap('C6', 'Sign in', 'post', '/oauth', 'not_applicable')],
};
const tools = normalizeTools([{ name: 'get_task', description: 'Get a task by id' }, { name: 'delete_task', description: 'Delete a task' }, { name: 'whoami', description: 'The signed-in user' }]);

test('mappingProblems: unknown capability or tool, bad status, missing tools, partly without a note', () => {
  const scope = capsInScope(capsDoc);
  assert.equal(scope.length, 5, 'not_applicable operations are not compared');
  const p = mappingProblems({ mapping: [
    { cap: 'C9', status: 'covered', tools: ['get_task'] }, { cap: 'C1', status: 'yes', tools: ['get_task'] },
    { cap: 'C2', status: 'covered', tools: ['nope'] }, { cap: 'C3', status: 'covered', tools: [] }, { cap: 'C4', status: 'partly', tools: ['get_task'] },
  ], extra: [{ tool: 'ghost' }] }, scope, tools);
  assert.equal(p.length, 6, p.join('\n'));
  assert.deepEqual(mappingProblems({ mapping: [{ cap: 'C1', status: 'covered', tools: ['get_task'] }, { cap: 'C4', status: 'not_covered' }] }, scope, tools), []);
});

test('suggestTools: hints by shared object words, writes matched to writes', () => {
  assert.equal(suggestTools(capsDoc.capabilities[1], tools)[0], 'delete_task');
  assert.deepEqual(suggestTools(capsDoc.capabilities[3], tools), []);
});

const ref = { server: { name: 'Demo MCP' }, source: { kind: 'docs', url: 'https://example.invalid/tools' }, tools,
  mapping: { C1: { status: 'covered', tools: ['get_task'] }, C2: { status: 'covered', tools: ['delete_task'] }, C3: { status: 'not_covered', tools: [] },
    C4: { status: 'not_covered', tools: [] }, C5: { status: 'not_covered', tools: [] } }, extra: [{ tool: 'whoami', note: 'who is signed in' }] };
const catalog = { use_cases: [
  { id: 'U1', area: 'TM', capabilities: ['C1'], tests: ['filters'] }, { id: 'U2', area: 'TM', capabilities: ['C1', 'C3'], tests: ['aggregation', 'relationships'] },
  { id: 'U3', area: 'TM', capabilities: ['C2'], tests: [] }, { id: 'U4', area: 'AD', capabilities: ['C4'] }, { id: 'U5', area: 'AD', capabilities: ['C5'] },
  { id: 'U6', area: 'TM', capabilities: ['C1'], status: 'retired' } ] };

test('compareView: null until something is compared; buckets for capabilities, areas and use cases', () => {
  assert.equal(compareView({ capsDoc, ref: null }), null);
  assert.equal(compareView({ capsDoc, ref: { ...ref, mapping: {} } }), null);
  const v = compareView({ capsDoc, ref, catalog });
  assert.deepEqual(Object.keys(v.caps.buckets), BUCKET_ORDER);
  assert.deepEqual(v.caps.buckets, { both: 1, cdata_only: 1, vendor_only: 1, neither: 1, app_only: 1, unmapped: 0 });
  assert.equal(v.rows.find(r => r.id === 'C2').vendor_tools[0], 'delete_task');
  assert.deepEqual(v.use_cases.buckets, { both: 1, cdata_only: 1, vendor_only: 1, neither: 1, app_only: 1, unmapped: 0 });
  assert.deepEqual([v.query.use_cases, v.query.aggregation, v.query.relationships], [5, 1, 1]);
  assert.deepEqual(v.extra.map(x => x.tool), ['whoami']);
  assert.deepEqual(v.unused, []);
  assert.deepEqual(v.areas.map(a => [a.id, a.total]), [['TM', 3], ['AD', 2]]);
  const onlyAD = compareView({ capsDoc, ref, catalog, areas: ['AD'] });
  assert.equal(onlyAD.caps.total, 2);
  assert.equal(onlyAD.use_cases.total, 2);
  const partial = compareView({ capsDoc, ref: { ...ref, mapping: { C1: ref.mapping.C1 } }, catalog });
  assert.equal(partial.caps.buckets.unmapped, 4);
});

const root = mkdtempSync(join(tmpdir(), 'cqa-ref-'));
const dir = join(root, 'Demo');
mkdirSync(join(dir, '_agent_out'), { recursive: true });
const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o, null, 2));
W('Demo_capabilities.json', capsDoc);
W('Demo_catalog.json', { version: 1, use_cases: catalog.use_cases.map(u => ({ ...u, request: `request ${u.id}`, status: u.status || 'approved' })) });
const toolFile = join(root, 'tools.json');
writeFileSync(toolFile, JSON.stringify({ server: { name: 'Demo MCP', url: 'https://example.invalid/mcp' }, source: { kind: 'docs', url: 'https://example.invalid/tools' },
  tools: [{ name: 'get_task', description: 'Get a task by id' }, { name: 'delete_task', description: 'Delete a task' }, { name: 'whoami', description: 'The signed-in user' }] }));
const R = () => JSON.parse(readFileSync(join(dir, 'Demo_reference_mcp.json'), 'utf8'));
const capsBefore = readFileSync(join(dir, 'Demo_capabilities.json'), 'utf8');

test('CLI: read → prep → apply → status, without touching the capability list', () => {
  let r = node('reference-mcp.mjs', ['prep', '--dir', dir]);
  assert.notEqual(r.code, 0, 'prep needs a tool list first');
  r = node('reference-mcp.mjs', ['read', '--dir', dir, '--tools', toolFile]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Demo MCP · 3 tools \(1 read · 1 write\) from docs/);
  r = node('reference-mcp.mjs', ['prep', '--dir', dir, '--areas', 'TM']);
  assert.equal(r.code, 0, r.out);
  const input = JSON.parse(readFileSync(join(dir, '_agent_out', 'reference-mcp-input.json'), 'utf8'));
  assert.deepEqual(input.capabilities.map(c => c.cap), ['C1', 'C2', 'C3']);
  assert.equal(input.tools.length, 3);

  const bad = join(root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ mapping: [{ cap: 'C1', status: 'covered', tools: ['missing_tool'] }] }));
  r = node('reference-mcp.mjs', ['apply', '--dir', dir, '--mapping', bad]);
  assert.notEqual(r.code, 0);
  assert.deepEqual(R().mapping, {}, 'a rejected mapping stores nothing');

  const good = join(root, 'good.json');
  writeFileSync(good, '```json\n' + JSON.stringify({ mapping: Object.entries(ref.mapping).map(([c, v]) => ({ cap: c, ...v, note: c === 'C3' ? 'no stories tool' : '' })), extra: ref.extra }) + '\n```');
  r = node('reference-mcp.mjs', ['apply', '--dir', dir, '--mapping', good]);
  assert.equal(r.code, 0, r.out);
  assert.equal(Object.keys(R().mapping).length, 5);
  r = node('reference-mcp.mjs', ['status', '--dir', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 both · 1 only CData ConnectAI MCP · 1 only the vendor MCP · 1 neither · 1 only in the source's own app/);
  r = node('reference-mcp.mjs', ['prep', '--dir', dir]);
  assert.match(r.out, /0 capabilities to compare/, 'compared capabilities are not asked again');
  assert.equal(readFileSync(join(dir, 'Demo_capabilities.json'), 'utf8'), capsBefore, 'the capability list is never edited');
});

test('a changed tool list drops the mapping of tools that are gone', () => {
  const smaller = join(root, 'tools2.json');
  writeFileSync(smaller, JSON.stringify({ tools: [{ name: 'get_task', description: 'Get a task by id' }] }));
  const r = node('reference-mcp.mjs', ['read', '--dir', dir, '--tools', smaller]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 mapping\(s\) dropped/);
  assert.equal(R().mapping.C2, undefined);
  assert.equal(R().mapping.C1.status, 'covered');
  assert.deepEqual(R().extra, []);
  node('reference-mcp.mjs', ['read', '--dir', dir, '--tools', toolFile]);
});

test('reports carry the comparison only when one exists', () => {
  const out = join(root, 'an.html');
  let r = node('build-capability-report.mjs', ['--dir', dir, '--root', root, '--analysis', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /vs Demo MCP: 1 both · 1 only CData · 0 only the vendor MCP · 1 neither · 1 source app only · 1 not compared/);
  const D = JSON.parse(readFileSync(out, 'utf8').match(/const DATA = ([\s\S]*?);\s*\n/)[1]);
  assert.equal(D.reference.server.name, 'Demo MCP');
  assert.equal(D.reference.caps.total, 5);

  const bare = join(root, 'Bare');
  mkdirSync(bare);
  writeFileSync(join(bare, 'Bare_capabilities.json'), JSON.stringify(capsDoc));
  const out2 = join(root, 'bare.html');
  r = node('build-capability-report.mjs', ['--dir', bare, '--root', root, '--analysis', '--out', out2]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /vs /);
  const D2 = JSON.parse(readFileSync(out2, 'utf8').match(/const DATA = ([\s\S]*?);\s*\n/)[1]);
  assert.equal('reference' in D2, false);
});

test('on by default: config switch, a vendor with no MCP server recorded once, status and reports say so', () => {
  const cfg = JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8'));
  assert.equal(cfg.capabilities.compare_vendor_mcp, true);
  assert.ok(cfg.capabilities.vendor_mcp_recheck_days > 0);
  const skill = readFileSync(join(SK, 'SKILL.md'), 'utf8');
  assert.match(skill, /\| `--no-compare-mcp` \|.*\| on \|/);
  assert.doesNotMatch(skill, /`--compare-mcp`/, 'the comparison is not opt-in any more');

  const nd = join(root, 'NoVendor');
  mkdirSync(nd);
  writeFileSync(join(nd, 'NoVendor_capabilities.json'), JSON.stringify(capsDoc));
  let r = node('scope.mjs', ['status', '--dir', nd]);
  assert.match(r.out, /Vendor MCP not compared yet — Stage 1\.5e/);
  assert.notEqual(node('reference-mcp.mjs', ['none', '--dir', nd]).code, 0, 'none needs a note');
  r = node('reference-mcp.mjs', ['none', '--dir', nd, '--note', 'developer docs and MCP listings checked']);
  assert.equal(r.code, 0, r.out);
  assert.match(node('reference-mcp.mjs', ['status', '--dir', nd]).out, /no vendor MCP server \(checked \d{4}-\d\d-\d\d: developer docs/);
  assert.notEqual(node('reference-mcp.mjs', ['prep', '--dir', nd]).code, 0, 'nothing to compare against');
  assert.match(node('scope.mjs', ['status', '--dir', nd]).out, /Vendor MCP: none found/);
  const out = join(root, 'none.html');
  r = node('build-capability-report.mjs', ['--dir', nd, '--root', root, '--analysis', '--out', out]);
  assert.equal(r.code, 0, r.out);
  const D = JSON.parse(readFileSync(out, 'utf8').match(/const DATA = ([\s\S]*?);\s*\n/)[1]);
  assert.equal('reference' in D, false);
  assert.match(D.reference_none.note, /developer docs/);
  /* a server found later replaces the "none" record */
  r = node('reference-mcp.mjs', ['read', '--dir', nd, '--tools', toolFile]);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(readFileSync(join(nd, 'NoVendor_reference_mcp.json'), 'utf8')).none, undefined);
  /* and a compared server is never silently replaced by "none" */
  writeFileSync(join(root, 'm.json'), JSON.stringify({ mapping: [{ cap: 'C1', status: 'covered', tools: ['get_task'] }] }));
  node('reference-mcp.mjs', ['apply', '--dir', nd, '--mapping', join(root, 'm.json')]);
  assert.notEqual(node('reference-mcp.mjs', ['none', '--dir', nd, '--note', 'x']).code, 0);
});

test('the template shows the comparison tab and the vendor column only with a comparison', () => {
  const tpl = readFileSync(join(SK, 'assets', 'capability-report-template.html'), 'utf8');
  assert.match(tpl, /function vendorTab\(/);
  assert.match(tpl, /function gapsWithVendor\(/);
  assert.match(tpl, /\.\.\.\(D&&D\.reference\?\[\['vendor','Vendor MCP'\]\]:\[\]\)/);
  assert.match(tpl, /D\.reference\?gapsWithVendor\(\):/);
});
