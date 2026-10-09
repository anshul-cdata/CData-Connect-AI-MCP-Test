/* 3.9 — a capability list from any API docs website, use case evidence from the vendor's own pages,
 * and evidence ranking in every use case list.
 *
 * QuickBooks Online publishes no OpenAPI: its reference is a JavaScript application (a plain fetch got a
 * 1.27 MB shell, a rendered browser all nine invoice operations), and the list was hand-written with
 * Intuit's real methods normalised away. These tests hold the generic path to account: the reader tells
 * a shell from a page, two different page layouts are extracted, the merge keeps only what the saved
 * page shows word for word, the documented method and path survive into the capability list, and the
 * reports say where the list came from. A local HTTP server stands in for the vendor's site.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assessPage, htmlToText, endpointLines, chunkText, robotsAllows, contains } from '../scripts/lib/page-reader.mjs';
import { mergeOps, kindFromOperation, completenessHint } from '../scripts/lib/api-docs.mjs';
import { nearDuplicateChoice, validateCatalog } from '../scripts/lib/catalog.mjs';
import { evidenceOf } from '../scripts/lib/evidence.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = f => join(SK, 'scripts', f);
/* async: the child fetches from this process's server, so the event loop must keep running */
const cli = (f, args) => new Promise(res => execFile(process.execPath, [script(f), ...args], { encoding: 'utf8' },
  (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) })));
const cliSync = (f, args) => { const r = spawnSync(process.execPath, [script(f), ...args], { encoding: 'utf8' }); return { code: r.status ?? 1, out: String(r.stdout) + String(r.stderr) }; };

/* ── the vendor's site ───────────────────────────────────────────────────── */
const SHELL = `<!doctype html><html><head><title>Invoice</title>${'<script src="/static/chunk.js"></script>'.repeat(6)}</head>
<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>`;
/* layout B: a reference table — method and path in separate cells */
const TABLE = `<!doctype html><html><head><title>Tasks API</title></head><body><nav><a href="/ref/tasks">Tasks</a> <a href="/ref/invoice">Invoices</a></nav>
<h1>Tasks</h1><p>Tasks hold the work of a project. Every call needs a bearer token.</p>
<table><tr><th>Method</th><th>Endpoint</th><th>What it does</th></tr>
<tr><td>GET</td><td>/api/v2/projects/{project_id}/tasks</td><td>List the tasks of a project</td></tr>
<tr><td>POST</td><td>/api/v2/projects/{project_id}/tasks</td><td>Create a task</td></tr>
<tr><td>POST</td><td>/api/v2/tasks/{task_id}/complete</td><td>Mark a task complete</td></tr></table>
${'<p>Each task has a name, an assignee, a due date and a status; a completed task keeps its history. </p>'.repeat(14)}</body></html>`;
const OVERVIEW = `<!doctype html><html><head><title>Authentication</title></head><body><h1>Authentication</h1>
${'<p>Sign in with OAuth 2.0: register an app, send the user to the consent page, exchange the code for a token and refresh it before it expires. </p>'.repeat(14)}</body></html>`;
/* layout A: what a rendered browser returns for the shell page — headings, then "Request URL" lines */
const RENDERED = ['Invoice', 'The Invoice object represents a sales form where the customer pays for a product or service later.',
  'Create an invoice', 'Request URL', 'POST /v3/company/<realmID>/invoice', 'Content type: application/json',
  'Read an invoice', 'Request URL', 'GET /v3/company/<realmID>/invoice/<invoiceId>',
  'Sparse update an invoice', 'Request URL', 'POST /v3/company/<realmID>/invoice', 'Set sparse to true; only the fields given change.',
  'Delete an invoice', 'Request URL', 'POST /v3/company/<realmID>/invoice?operation=delete',
  'Void an invoice', 'Request URL', 'POST /v3/company/<realmID>/invoice?operation=void',
  ...Array.from({ length: 30 }, (_, i) => `Attribute ${i}: a field of the invoice, with its type and whether it is required.`)].join('\n');
const SPEC = JSON.stringify({ openapi: '3.0.0', info: { title: 'Acme API', version: '2' }, paths: { '/widgets': { get: { operationId: 'listWidgets', summary: 'List widgets' } } } });

let server, base;
const PAGES = () => ({
  '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /internal\n'],
  '/sitemap.xml': ['application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/ref/invoice', '/ref/tasks', '/ref/overview', '/internal/admin', '/blog/launch']
    .map(p => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`],
  '/ref/invoice': ['text/html', SHELL], '/ref/tasks': ['text/html', TABLE], '/ref/overview': ['text/html', OVERVIEW],
  '/docs': ['text/html', '<html><body><redoc spec-url="/specs/acme-openapi.json"></redoc></body></html>'],
  '/specs/acme-openapi.json': ['application/json', SPEC],
});
before(async () => {
  server = createServer((req, res) => { const p = PAGES()[req.url.split('?')[0]]; if (!p) { res.writeHead(404); res.end('not found'); return; } res.writeHead(200, { 'content-type': p[0] }); res.end(p[1]); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const root = mkdtempSync(join(tmpdir(), 'cqa-390-'));
const dir = join(root, 'Demo');
mkdirSync(dir, { recursive: true });
const W = (f, o) => writeFileSync(join(dir, f), typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const J = f => JSON.parse(readFileSync(join(dir, f), 'utf8'));
W('Demo_knowledge.json', { connector: 'Demo', objects: ['Invoices', 'InvoiceLineItems', 'Projects', 'Tasks', 'Vendors'].map(name => ({ name })) });
const D = ['--dir', dir, '--delay-ms', '0'];

/* ── the reader ──────────────────────────────────────────────────────────── */
test('JS shell detection: an app shell, a static page, and an API page with only navigation text', () => {
  const shell = assessPage({ text: htmlToText(SHELL), html: SHELL, expect: 'api' });
  assert.equal(shell.verdict, 'js_shell');
  assert.ok(shell.signs.length, 'it says why');
  const table = assessPage({ text: htmlToText(TABLE), html: TABLE, expect: 'api' });
  assert.equal(table.verdict, 'ok');
  assert.equal(table.endpoint_lines, 3, 'method and path in separate cells still read as endpoint lines');
  /* long navigation text, no endpoint, an application bundle: still a shell for an API page */
  const nav = `<html><body><div id="__next"></div><script>window.__NEXT_DATA__={}</script>${'<a href="/x">Menu entry for a product area</a>'.repeat(80)}</body></html>`;
  assert.equal(assessPage({ text: htmlToText(nav), html: nav, expect: 'api' }).verdict, 'js_shell');
  /* the same prose is fine as a use case page, and a long overview without endpoints is not a shell */
  assert.equal(assessPage({ text: htmlToText(OVERVIEW), html: OVERVIEW, expect: 'api' }).verdict, 'ok');
  assert.equal(assessPage({ text: 'Loading…' }).verdict, 'js_shell', 'very short text alone is a shell');
  assert.equal(assessPage({ text: RENDERED, expect: 'api' }).verdict, 'ok', 'the rendered text of the same page is not');
});

test('reader helpers: endpoint lines, chunks with overlap, robots.txt, word-for-word quotes', () => {
  assert.deepEqual(endpointLines('Request URL\nPOST /v3/company/<realmID>/invoice?operation=void\nThe POST body\nGET https://api.acme.com/v1/things/{id}'),
    ['POST /v3/company/<realmID>/invoice?operation=void', 'GET https://api.acme.com/v1/things/{id}']);
  const parts = chunkText(RENDERED, 600, 120);
  assert.ok(parts.length > 2 && parts.every(p => p.length <= 600));
  assert.ok(parts[0].endsWith(parts[1].split('\n').slice(0, 3).join('\n')), 'a part repeats the last lines of the one before');
  assert.equal(robotsAllows('User-agent: *\nDisallow: /internal\nAllow: /internal/public', 'https://a.com/internal/public/x'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /internal', 'https://a.com/internal/x'), false);
  assert.equal(robotsAllows('', 'https://a.com/x'), true);
  assert.ok(contains('a  POST /v3/x\u00a0 here', 'POST /v3/x here'), 'whitespace and non-breaking spaces are uniform');
  assert.ok(!contains('POST /v3/x', 'PUT /v3/x'));
});

/* ── rung 1: a description behind a portal ───────────────────────────────── */
test('ladder: an OpenAPI description behind a Redoc portal is found, and used as published', async () => {
  const d2 = join(root, 'Acme'); mkdirSync(d2, { recursive: true });
  const r = await cli('api-from-docs.mjs', ['ladder', '--dir', d2, '--docs', `${base}/docs`, '--delay-ms', '0']);
  assert.equal(r.code, 0, r.out);
  const ld = JSON.parse(readFileSync(join(d2, '_agent_out', 'api-docs', 'ladder.json'), 'utf8'));
  assert.deepEqual([ld.hit.rung, ld.hit.format], ['spec', 'openapi']);
  assert.match(ld.hit.url, /acme-openapi\.json$/);
  const c = cliSync('api-from-docs.mjs', ['convert', '--dir', d2, '--file', ld.hit.file]);
  assert.equal(c.code, 0, c.out);
  assert.equal(readFileSync(join(d2, 'Acme_api.json'), 'utf8'), SPEC, 'the vendor\'s own description is not rewritten');
  assert.equal(cliSync('capability-list.mjs', ['read', '--dir', d2, '--spec', join(d2, 'Acme_api.json')]).code, 0);
  const caps = JSON.parse(readFileSync(join(d2, 'Acme_capabilities.json'), 'utf8'));
  assert.equal(caps.source.kind, 'spec');
  assert.equal(caps.source.pages, undefined);
  assert.equal(caps.capabilities[0].doc_url, undefined, 'a spec-read capability carries nothing new');
});

/* ── rung 3: two layouts, read, extracted, merged ────────────────────────── */
test('probe: plain HTTP for the static page, a rendered browser for the shell', async () => {
  const shell = await cli('api-from-docs.mjs', ['probe', ...D, '--url', `${base}/ref/invoice`]);
  assert.match(shell.out, /READER rendered/);
  assert.match(shell.out, /Playwright MCP/, 'it names the rendered readers');
  assert.match(shell.out, /ask the user to enable Playwright MCP/);
  const stat = await cli('api-from-docs.mjs', ['probe', ...D, '--url', `${base}/ref/tasks`]);
  assert.match(stat.out, /READER http/);
});

test('inventory from the sitemap: robots.txt and --include exclude pages with a reason', async () => {
  const r = await cli('api-from-docs.mjs', ['inventory', ...D, '--sitemap', `${base}/sitemap.xml`, '--include', '/ref/']);
  assert.equal(r.code, 0, r.out);
  const inv = J('_agent_out/api-docs/inventory.json');
  const st = p => inv.pages.find(x => x.url.endsWith(p));
  assert.equal(st('/ref/tasks').status, 'pending');
  assert.equal(st('/blog/launch').status, 'excluded');
  assert.match(st('/blog/launch').reason, /outside the API reference/);
  assert.equal(st('/internal/admin').status, 'excluded', 'outside --include first');
  assert.equal(cliSync('api-from-docs.mjs', ['status', '--dir', dir]).code, 3, 'pages not read yet');
});

test('snap: plain HTTP saves static pages and refuses the shell; rendered text is saved with its reader', async () => {
  const r = await cli('api-from-docs.mjs', ['snap', ...D, '--pending']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 page\(s\) saved/);
  assert.match(r.out, /\/ref\/invoice: plain HTTP got a js_shell/);
  /* the rendered reader's text — a shell saved from a browser before the page loaded is refused too */
  writeFileSync(join(root, 'loading.txt'), 'Loading…');
  const bad = cliSync('api-from-docs.mjs', ['snap', '--dir', dir, '--url', `${base}/ref/invoice`, '--text-file', join(root, 'loading.txt'), '--fetcher', 'playwright']);
  assert.equal(bad.code, 3);
  assert.match(bad.out, /had not loaded/);
  writeFileSync(join(root, 'invoice.txt'), RENDERED);
  assert.equal(cliSync('api-from-docs.mjs', ['snap', '--dir', dir, '--url', `${base}/ref/invoice`, '--text-file', join(root, 'invoice.txt'), '--fetcher', 'playwright']).code, 0);
  const off = cliSync('api-from-docs.mjs', ['snap', '--dir', dir, '--url', 'https://elsewhere.example/ref/x', '--text-file', join(root, 'invoice.txt'), '--fetcher', 'playwright']);
  assert.match(off.out, /not in the inventory/, 'a page outside the inventory cannot be cited');
  const idx = J('_agent_out/api-docs/index.json');
  assert.equal(Object.values(idx.pages).find(p => p.url.endsWith('/ref/invoice')).fetcher, 'playwright');
  assert.equal(Object.values(idx.pages).find(p => p.url.endsWith('/ref/tasks')).fetcher, 'http');
  const p = cliSync('api-from-docs.mjs', ['prep', '--dir', dir]);
  assert.equal(p.code, 0, p.out);
  const prep = J('_agent_out/api-docs/extract-input.json');
  assert.equal(prep.batches.flatMap(b => b.pages).length, 3);
  assert.ok(prep.instructions.some(i => /as documented/.test(i)) && prep.instructions.some(i => /word for word/.test(i)));
});

test('merge: only what the saved page shows, documented methods kept, duplicates merged, gaps flagged', () => {
  const inv = `${base}/ref/invoice`, tasks = `${base}/ref/tasks`;
  const op = (entity, operation, method, path, doc_url, evidence, extra = {}) => ({ entity, operation, method, path, doc_url, evidence, ...extra });
  W('_agent_out/api-docs/ops-AX-001.json', { model: 'test', ops: [
    op('Invoice', 'create', 'POST', '/v3/company/<realmID>/invoice', inv, 'POST /v3/company/<realmID>/invoice'),
    op('Invoice', 'read', 'GET', '/v3/company/<realmID>/invoice/<invoiceId>', inv, 'GET /v3/company/<realmID>/invoice/<invoiceId>'),
    op('Invoice', 'sparse update', 'POST', '/v3/company/<realmID>/invoice', inv, 'Set sparse to true; only the fields given change.'),
    op('Invoice', 'delete', 'POST', '/v3/company/<realmID>/invoice?operation=delete', inv, 'POST /v3/company/<realmID>/invoice?operation=delete'),
    op('Invoice', 'void', 'POST', '/v3/company/<realmID>/invoice?operation=void', inv, 'POST /v3/company/<realmID>/invoice?operation=void'),
    op('Invoice', 'void', 'POST', '/v3/company/<realmID>/invoice?operation=void', inv, 'Void an invoice'),                       // duplicate
    op('Invoice', 'send', 'POST', '/v3/company/<realmID>/invoice/<id>/send', inv, 'POST /v3/company/<realmID>/invoice/<id>/send'), // not on the page
    op('Payment', 'create', 'POST', '/v3/company/<realmID>/payment', 'https://elsewhere.example/payment', 'POST /v3/company/<realmID>/payment'), // not in the inventory
  ] });
  W('_agent_out/api-docs/ops-AX-002.json', { model: 'test', ops: [
    op('Task', 'list', 'GET', '/api/v2/projects/{project_id}/tasks', tasks, 'GET /api/v2/projects/{project_id}/tasks List the tasks of a project'),
    op('Task', 'create', 'POST', '/api/v2/projects/{project_id}/tasks', tasks, 'POST /api/v2/projects/{project_id}/tasks Create a task'),
    op('Task', 'complete', 'POST', '/api/v2/tasks/{task_id}/complete', tasks, 'POST /api/v2/tasks/{task_id}/complete Mark a task complete', { kind: 'action' }),
  ], pages_without_ops: [{ doc_url: `${base}/ref/overview`, reason: 'an overview of OAuth 2.0 sign-in' }] });
  const r = cliSync('api-from-docs.mjs', ['merge', '--dir', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /8 operation\(s\) from 2 page\(s\) · 1 duplicate\(s\) merged · 2 rejected/);
  assert.match(r.out, /evidence is not on the page word for word/);
  assert.match(r.out, /doc_url is not in the inventory/);
  assert.match(r.out, /table Vendors/, 'a connector table no operation touches is flagged');
  assert.doesNotMatch(r.out, /table InvoiceLineItems/, 'a line-item table belongs to its entity');
  const api = J('Demo_api.json');
  const all = Object.entries(api.paths).flatMap(([k, ms]) => Object.entries(ms).map(([m, o]) => ({ key: k, method: m.toUpperCase(), ...o })));
  assert.equal(all.length, 8);
  assert.ok(!all.some(o => ['PUT', 'DELETE', 'PATCH'].includes(o.method)), 'Intuit updates and deletes by POST — never normalised');
  const del = all.find(o => o.operationId === 'deleteInvoice');
  assert.equal(del.method, 'POST');
  assert.equal(del['x-path'], '/v3/company/<realmID>/invoice?operation=delete');
  assert.equal(del['x-doc-url'], inv);
  assert.equal(del['x-evidence'], 'POST /v3/company/<realmID>/invoice?operation=delete');
  assert.equal(all.filter(o => (o['x-path'] || o.key) === '/v3/company/<realmID>/invoice' && o.method === 'POST').length, 2, 'create and sparse update share a documented path');
  const asm = api.info['x-assembled'];
  assert.equal(asm.rung, 'reference_docs');
  assert.equal(asm.pages, 2);
  assert.match(asm.fetcher, /playwright/); assert.match(asm.fetcher, /http/);
  assert.deepEqual(asm.excluded.map(e => e.url.replace(base, '')).sort(), ['/blog/launch', '/internal/admin', '/ref/overview']);
  assert.ok(asm.review.tables_without_operations.includes('Vendors'));
  const st = cliSync('api-from-docs.mjs', ['status', '--dir', dir]);
  assert.equal(st.code, 0, st.out);
  assert.match(st.out, /every page is extracted or excluded with a reason/);
});

test('capability-list read: the assembled list keeps documented methods, kinds and pages, and says where it came from', () => {
  const r = cliSync('capability-list.mjs', ['read', '--dir', dir, '--spec', join(dir, 'Demo_api.json')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /assembled \(reference docs\) from 2 page\(s\)/);
  const c = J('Demo_capabilities.json');
  assert.equal(c.source.kind, 'reference_docs');
  assert.equal(c.source.pages, 2);
  const by = id => c.capabilities.find(x => x.id === id);
  assert.deepEqual([by('CAP-deleteinvoice').kind, by('CAP-deleteinvoice').method, by('CAP-deleteinvoice').path], ['delete', 'POST', '/v3/company/<realmID>/invoice?operation=delete']);
  assert.equal(by('CAP-sparseupdateinvoice').kind, 'update');
  assert.deepEqual([by('CAP-voidinvoice').kind, by('CAP-voidinvoice').action], ['action', 'void']);
  assert.equal(by('CAP-getinvoice').kind, 'get');
  assert.equal(by('CAP-completetask').kind, 'action');
  assert.equal(by('CAP-createinvoice').noun, 'Invoice');
  assert.equal(by('CAP-createinvoice').doc_url, `${base}/ref/invoice`);
});

test('merge unit: duplicates, unknown kinds and pages; operation words to kinds; completeness', () => {
  const inventory = new Map([['https://d.example/p', { url: 'https://d.example/p', status: 'saved' }], ['https://d.example/x', { url: 'https://d.example/x', status: 'excluded', reason: 'an overview page only' }]]);
  const snapshot = u => u === 'https://d.example/p' ? { text: 'GET /things/{id}\nPOST /things' } : null;
  const m = mergeOps([
    { entity: 'Thing', operation: 'read', method: 'get', path: '/things/{id}', doc_url: 'https://d.example/p#read', evidence: 'GET /things/{id}' },
    { entity: 'thing', operation: 'Read', method: 'GET', path: '/things/{id}', doc_url: 'https://d.example/p', evidence: 'GET /things/{id}' },
    { entity: 'Thing', operation: 'create', method: 'POST', path: '/things', doc_url: 'https://d.example/p', evidence: 'POST /things', kind: 'make' },
    { entity: 'Thing', operation: 'create', method: 'POST', path: '/things', doc_url: 'https://d.example/x', evidence: 'POST /things' },
  ], { inventory, snapshot });
  assert.equal(m.kept.length, 1);
  assert.equal(m.duplicates, 1);
  assert.match(m.rejected[0].why.join(), /kind "make"/);
  assert.match(m.rejected[1].why.join(), /excluded/);
  assert.deepEqual(['query', 'Read an invoice', 'Sparse update', 'Delete', 'void', 'Send'].map(w => kindFromOperation(w)), ['list', 'get', 'update', 'delete', 'action', 'action']);
  assert.deepEqual(completenessHint([{ entity: 'Invoice' }], { tables: ['Invoices', 'Bills'], entities: ['Bill'] }), { tables: ['Bills'], entities: ['Bill'] });
});

/* ── reports: provenance and evidence ────────────────────────────────────── */
function render(file, storage, handlersOut) {
  const html = readFileSync(file, 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const handlers = {};
  const app = { innerHTML: '', addEventListener(ev, fn) { handlers[ev] = fn; }, querySelectorAll: () => [] };
  new Function('document', 'localStorage', 'window', js)({ getElementById: id => id === 'app' ? app : null }, { getItem: k => storage[k] ?? null, setItem() {} }, { scrollTo() {} });
  if (handlersOut) Object.assign(handlersOut, handlers);
  return app;
}
const ids = html => [...html.matchAll(/<span class="uc-id">([^<]+)<\/span>/g)].map(m => m[1]);
const clean = h => assert.doesNotMatch(h, /undefined|NaN|\[object Object\]/);

const an = join(root, 'Rep'); mkdirSync(an, { recursive: true });
const WA = (f, o) => writeFileSync(join(an, f), JSON.stringify(o, null, 2));
const capR = (id, status, extra = {}) => ({ id, label: id, method: 'POST', path: `/v3/${id}`, mapping: { status, exposure: status === 'exposed' ? [{ kind: 'table', name: 'Tasks', op: 'SELECT' }] : [] }, ...extra });
const src = (kind, n) => ({ kind, title: `${kind} page ${n}`, url: `https://vendor.example/${kind}/${n}` });
const ucR = (id, area, source) => ({ id, area, request: `request ${id}`, persona: 'Lead', kind: 'question', capabilities: ['C-ok'], status: 'approved', source });
WA('Rep_catalog.json', { version: 1, use_cases: [ucR('UC-3', 'B', src('inferred', 3)), ucR('UC-1', 'A', src('help_center', 1)), ucR('UC-10', 'A', src('community', 10)),
  ucR('UC-2', 'B', src('vendor_use_case', 2)), ucR('UC-4', 'A', src('customer_dump', 4)), ucR('UC-5', 'B', null)] });

test('analysis report: assembled from N reference pages, capabilities linked to their page', () => {
  WA('Rep_capabilities.json', { source: { title: 'Rep API', version: '1', read_at: '2026-10-08T00:00:00Z', kind: 'reference_docs', pages: 46, assembled: { rung: 'reference_docs', fetcher: 'playwright' } },
    areas: [{ id: 'A', name: 'Alpha', capability_ids: ['C-ok', 'C-gap'] }, { id: 'B', name: 'Beta', capability_ids: [] }],
    capabilities: [capR('C-ok', 'exposed', { doc_url: 'https://vendor.example/ref/ok' }), capR('C-gap', 'not_exposed', { doc_url: 'https://vendor.example/ref/gap' })] });
  const r = cliSync('build-capability-report.mjs', ['--dir', an, '--root', root, '--analysis']);
  assert.equal(r.code, 0, r.out);
  const f = join(an, 'Rep_analysis_report.html');
  const sum = render(f, { 'cap-tab': 'summary' }).innerHTML;
  clean(sum);
  assert.match(sum, /API list assembled from 46 reference pages \(read with playwright\)/);
  const gaps = render(f, { 'cap-tab': 'gaps' }).innerHTML;
  assert.match(gaps, /<a class="mono doc" href="https:\/\/vendor\.example\/ref\/gap"/);
  assert.match(render(f, { 'cap-tab': 'run' }).innerHTML, /assembled from 46 reference pages/);
});

test('a spec-sourced report shows no provenance line and no page links', () => {
  WA('Rep_capabilities.json', { source: { title: 'Rep API', version: '1', read_at: '2026-10-08T00:00:00Z' },
    areas: [{ id: 'A', name: 'Alpha', capability_ids: ['C-ok', 'C-gap'] }, { id: 'B', name: 'Beta', capability_ids: [] }],
    capabilities: [capR('C-ok', 'exposed'), capR('C-gap', 'not_exposed')] });
  assert.equal(cliSync('build-capability-report.mjs', ['--dir', an, '--root', root, '--analysis']).code, 0);
  const f = join(an, 'Rep_analysis_report.html');
  for (const t of ['summary', 'gaps', 'run']) {
    const h = render(f, { 'cap-tab': t }).innerHTML;
    assert.doesNotMatch(h, /assembled from/);
    assert.doesNotMatch(h, /class="mono doc"/);
  }
});

test('use case list: default order unchanged; sort by evidence, area or ID; evidence filter; a pill and link on every card', () => {
  const f = join(an, 'Rep_analysis_report.html');
  const h = {};
  const app = render(f, { 'cap-tab': 'usecases' }, h);
  clean(app.innerHTML);
  const deflt = ids(app.innerHTML);
  assert.deepEqual(deflt, ['UC-1', 'UC-10', 'UC-2', 'UC-3', 'UC-4', 'UC-5'], 'the report\'s own order (outlook, then id) until the reader sorts');
  assert.equal((app.innerHTML.match(/class="pill ev-/g) || []).length, 6, 'every card has its evidence pill');
  assert.equal((app.innerHTML.match(/<a class="pill src" href="https:\/\/vendor\.example\//g) || []).length, 5, 'and its source link (one has no source)');
  assert.match(app.innerHTML, /Evidence: Inferred/);
  const change = (id, value) => h.change({ target: { id, value } });
  change('a-sort', 'evidence');
  assert.deepEqual(ids(app.innerHTML), ['UC-4', 'UC-10', 'UC-1', 'UC-2', 'UC-3', 'UC-5'], 'customer, community, vendor (help, use case page), inferred');
  change('a-sort', 'id');
  assert.deepEqual(ids(app.innerHTML), ['UC-1', 'UC-2', 'UC-3', 'UC-4', 'UC-5', 'UC-10'], 'numeric ID order');
  change('a-sort', 'area');
  assert.deepEqual(ids(app.innerHTML), ['UC-1', 'UC-10', 'UC-4', 'UC-2', 'UC-3', 'UC-5']);
  change('a-ev', 'vendor');
  assert.deepEqual(ids(app.innerHTML), ['UC-1', 'UC-2']);
  change('a-ev', ''); change('a-sort', '');
  assert.deepEqual(ids(app.innerHTML), deflt, 'back to the default order');
  const sum = render(f, { 'cap-tab': 'summary' }).innerHTML;
  assert.match(sum, /By evidence<\/span>: 1 customer queries · 1 real users · 2 vendor guidance · 2 inferred\./);
});

test('evidence levels: a vendor use case page is vendor guidance', () => {
  assert.equal(evidenceOf({ kind: 'vendor_use_case' }), 'vendor');
  assert.equal(evidenceOf(null), 'inferred');
  const v = validateCatalog({ use_cases: [] });
  assert.ok(Array.isArray(v.warnings));
});

/* ── research: the better-evidenced near-duplicate is kept ────────────────── */
test('dedup preference: a draft gives way to stronger evidence; approved and frozen use cases never do', () => {
  const comm = { source: src('community', 1) }, help = { source: src('help_center', 2) }, inf = { source: src('inferred', 3) };
  assert.equal(nearDuplicateChoice(comm, { ...help, status: 'draft' }), 'replace');
  assert.equal(nearDuplicateChoice(help, { ...comm, status: 'draft' }), 'keep_existing');
  assert.equal(nearDuplicateChoice(help, { ...help, status: 'draft' }), 'keep_existing', 'a tie keeps what is there');
  assert.equal(nearDuplicateChoice(comm, { ...inf, status: 'approved' }), 'note_stronger');
  assert.equal(nearDuplicateChoice(comm, { ...inf, status: 'draft' }, { frozen: true }), 'note_stronger');

  const cd = join(root, 'Cat'); mkdirSync(cd, { recursive: true });
  const WC = (f, o) => writeFileSync(join(cd, f), JSON.stringify(o, null, 2));
  WC('Cat_catalog.json', { prefix: 'CAT', use_cases: [
    { id: 'UC-CAT-0001', area: 'A', persona: 'Lead', status: 'draft', request: 'Which of my projects are behind schedule this month?', source: src('help_center', 1) },
    { id: 'UC-CAT-0002', area: 'A', persona: 'Lead', status: 'approved', request: 'Show me every overdue task assigned to my team', source: src('inferred', 2) } ] });
  WC('batch.json', { use_cases: [
    { area: 'A', persona: 'Lead', request: 'Which of my projects are behind schedule this month', source: src('community', 9) },          // beats a help-centre draft
    { area: 'A', persona: 'Lead', request: 'Show me every overdue task assigned to my team!', source: src('community', 8) },           // beats an approved one: noted only
    { area: 'A', persona: 'Lead', request: 'List the invoices we sent last week to Acme', source: src('inferred', 7) },
    { area: 'A', persona: 'Lead', request: 'List the invoices we sent last week to Acme.', source: src('customer_dump', 6) },         // replaces the batch's own weaker one
    { area: 'A', persona: 'Lead', request: 'List the invoices we sent last week to Acme', source: src('docs', 5) } ] });                 // weaker: dropped
  const r = cliSync('manage-catalog.mjs', ['add', '--dir', cd, '--from', join(cd, 'batch.json')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 near-duplicate\(s\) replaced by a better-evidenced one/);
  assert.match(r.out, /stronger evidence found for 1 approved use case/);
  const cat = JSON.parse(readFileSync(join(cd, 'Cat_catalog.json'), 'utf8'));
  const old = cat.use_cases.find(u => u.id === 'UC-CAT-0001');
  assert.equal(old.status, 'retired');
  assert.match(old.retired_why, /community beats vendor/);
  const winner = cat.use_cases.find(u => u.id === old.replaced_by);
  assert.equal(winner.source.kind, 'community');
  const appr = cat.use_cases.find(u => u.id === 'UC-CAT-0002');
  assert.equal(appr.status, 'approved', 'an approved use case is never replaced');
  assert.equal(appr.stronger_evidence[0].kind, 'community');
  const inv = cat.use_cases.filter(u => /invoices we sent/.test(u.request) && u.status !== 'retired');
  assert.equal(inv.length, 1);
  assert.equal(inv[0].source.kind, 'customer_dump');
  assert.equal(cat.use_cases.length, 4, 'the batch\'s own weaker candidate is taken out, not retired');
});
