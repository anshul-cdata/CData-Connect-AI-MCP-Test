/* 3.9.3 — page capture without a model in the loop.
 *
 * QuickBooks Online's API reference is a JavaScript application. Reading it meant a model driving a browser
 * tool and carrying each page's text to disk through its own context (about 12k tokens a page, a typo risk on
 * every copy, a tab that froze under long scripts), and the first attempt kept only the endpoint lines — an
 * excerpt the evidence check would have accepted as if it were the page. `api-from-docs.mjs render` renders the
 * page in a headless browser already on the machine and writes its text straight to the snapshot store;
 * `ingest` files text a person downloaded from their own browser. These tests hold both to account against a
 * local site: a page drawn by script, a page robots.txt disallows, a page that never finishes drawing, and the
 * file-name matching that decides which inventory page a downloaded file belongs to.
 *
 * The browser-driven tests are skipped where there is no Chrome/Edge or Node is older than 22 (renderBlocker).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findBrowser, renderBlocker, settled } from '../scripts/lib/headless-capture.mjs';
import { robotsGate, FETCHERS, RENDERED } from '../scripts/lib/page-reader.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = args => new Promise(res => execFile(process.execPath, [join(SK, 'scripts', 'api-from-docs.mjs'), ...args], { encoding: 'utf8' },
  (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) })));

/* a reference page drawn by script: the shell has no text; 600 ms later the script writes the whole page */
const FILLER = Array.from({ length: 60 }, (_, i) => `Attribute ${i}: a field of the invoice, with its type and whether it is required.`).join('\\n');
const DRAWN = `<!doctype html><html><head><title>Invoice reference</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript>
<div id="root"></div><script>setTimeout(function(){document.getElementById('root').innerText='Invoice\\nCreate an invoice\\nPOST /v3/company/<realmID>/invoice\\nRead an invoice\\nGET /v3/company/<realmID>/invoice/<invoiceId>\\n${FILLER}';},600);</script></body></html>`;
/* a page that never draws more than a loading line */
const STUCK = `<!doctype html><html><head><title>Loading</title></head><body><div id="root">Loading…</div></body></html>`;

let server, base;
const PAGES = () => ({
  '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /private\n'],
  '/ref/invoice': ['text/html', DRAWN], '/ref/stuck': ['text/html', STUCK], '/private/secret': ['text/html', DRAWN],
});
before(async () => {
  server = createServer((req, res) => { const p = PAGES()[req.url.split('?')[0]]; if (!p) { res.writeHead(404); res.end('not found'); return; } res.writeHead(200, { 'content-type': p[0] }); res.end(p[1]); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const mkdir = urls => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-393-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'urls.txt'), urls.join('\n'));
  return dir;
};
const D = dir => ['--dir', dir, '--delay-ms', '0'];
const index = dir => JSON.parse(readFileSync(join(dir, '_agent_out', 'api-docs', 'index.json'), 'utf8'));
const inventory = dir => JSON.parse(readFileSync(join(dir, '_agent_out', 'api-docs', 'inventory.json'), 'utf8'));

/* ── the parts that need no browser ──────────────────────────────────────── */
test('settled(): a page is done when it has text and the text held still long enough', () => {
  assert.equal(settled([], 300, 1500), false, 'no samples yet');
  assert.equal(settled([0, 0, 0, 0, 0, 0], 300, 1500), false, 'a blank page is not a finished page');
  assert.equal(settled([10, 4000, 4000, 4000], 300, 1500), false, 'still inside the settle window');
  assert.equal(settled([0, 10, 4000, 4000, 4000, 4000, 4000, 4000], 300, 1500), true);
  assert.equal(settled([4000, 4000, 4000, 4000, 4000, 4300], 300, 1500), false, 'it grew at the last sample');
  assert.equal(settled([5, 5], 300, 0), true, 'with no settle window two equal samples are enough');
});

test('findBrowser / renderBlocker: an explicit path wins, a missing one is null, and the reason is a sentence', () => {
  const exists = p => p === 'C:\\fake\\chrome.exe' || p === '/opt/edge';
  assert.equal(findBrowser({ browser: 'C:\\fake\\chrome.exe', exists, env: {} }), 'C:\\fake\\chrome.exe');
  assert.equal(findBrowser({ browser: '/nope', exists, env: {} }), null, 'an explicit path that does not exist is not silently replaced');
  assert.equal(findBrowser({ env: { CONNECTOR_QA_BROWSER: '/opt/edge' }, exists }), '/opt/edge', 'the environment variable is honoured');
  assert.equal(findBrowser({ platform: 'linux', env: {}, exists: () => false }), null);
  assert.match(renderBlocker({ hasWebSocket: false }), /Node 22/);
  assert.match(renderBlocker({ hasWebSocket: true, platform: 'linux', env: {}, exists: () => false }), /no Chrome, Edge, Chromium or Brave/);
  assert.equal(renderBlocker({ hasWebSocket: true, browser: '/opt/edge', exists }), null);
});

test('the headless reader is a registered fetcher, so snapshots and the extraction brief accept it', () => {
  assert.ok(FETCHERS.includes('headless') && RENDERED.includes('headless'));
});

test('robotsGate answers from robots.txt alone, once per origin', async () => {
  const allowed = robotsGate({ delay_ms: 0 });
  assert.equal((await allowed(`${base}/ref/invoice`)).allowed, true);
  assert.equal((await allowed(`${base}/private/secret`)).allowed, false);
  assert.equal((await allowed('not a url')).allowed, false);
});

/* ── ingest: files a person read in their own browser ─────────────────────── */
test('ingest --snippet prints a console snippet that names files by the last path segment and honours --prefix', async () => {
  const r = await cli(['ingest', '--dir', mkdir([]), '--snippet', '--prefix', 'intuit-']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /a\.download="intuit-"\+s\+'\.txt'/);
  assert.match(r.out, /pathname\.split\('\/'\)/);
});

test('ingest: matches downloads to inventory pages by slug, refuses ambiguity and thin text, never guesses', async () => {
  const dir = mkdir(['https://docs.example.com/api/invoice', 'https://docs.example.com/api/estimate', 'https://docs.example.com/a/dup', 'https://docs.example.com/b/dup']);
  assert.equal((await cli(['inventory', ...D(dir), '--urls', join(dir, 'urls.txt')])).code, 0);
  const dl = join(mkdtempSync(join(tmpdir(), 'cqa-dl-')), 'Downloads'); mkdirSync(dl, { recursive: true });
  const page = (title, n = 40) => `${title}\nCreate\nPOST /v3/company/<realmID>/${title.toLowerCase()}\n` + Array.from({ length: n }, (_, i) => `Attribute ${i}: a field with its type and whether it is required.`).join('\n');
  writeFileSync(join(dl, 'intuit-invoice.txt'), page('Invoice'));
  writeFileSync(join(dl, 'intuit-estimate.txt'), 'Loading…');                    // had not finished drawing
  writeFileSync(join(dl, 'intuit-dup.txt'), page('Dup'));                         // two inventory pages end in "dup"
  writeFileSync(join(dl, 'intuit-nothing.txt'), page('Nothing'));                 // no inventory page ends in "nothing"
  writeFileSync(join(dl, 'unrelated.txt'), page('Unrelated'));                    // does not carry the prefix
  const r = await cli(['ingest', ...D(dir), '--from', dl, '--prefix', 'intuit-', '--fetcher', 'chrome', '--move']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 of 4 file\(s\) saved/);
  assert.match(r.out, /intuit-estimate\.txt: the text reads as js_shell/);
  assert.match(r.out, /intuit-dup\.txt: 2 inventory pages end in "dup"/);
  assert.match(r.out, /intuit-nothing\.txt: no inventory page ends in "nothing"/);
  const idx = index(dir);
  assert.equal(Object.keys(idx.pages).length, 1);
  const saved = idx.pages['https://docs.example.com/api/invoice'];
  assert.equal(saved.fetcher, 'chrome');
  assert.ok(saved.chars > 1500, 'the strict whole-page length bar applied, not the lenient one for excerpts');
  assert.ok(readFileSync(join(dir, '_agent_out', 'api-docs', saved.file), 'utf8').includes('POST /v3/company/<realmID>/invoice'));
  assert.equal(existsSync(join(dl, 'intuit-invoice.txt')), false, '--move took the original away');
  assert.ok(existsSync(join(dl, 'intuit-dup.txt')) && existsSync(join(dl, 'unrelated.txt')), 'files that were not filed stay where they were');
  assert.equal(inventory(dir).pages.find(p => /\/invoice$/.test(p.url)).status, 'saved');
  assert.equal((await cli(['ingest', ...D(dir), '--from', dl, '--fetcher', 'headless'])).code, 2, 'a person-read page cannot claim to be headless');
});

test('render refuses cleanly when there is nothing to render', async () => {
  const dir = mkdir(['https://docs.example.com/api/invoice']);
  assert.equal((await cli(['inventory', ...D(dir), '--urls', join(dir, 'urls.txt')])).code, 0);
  assert.equal((await cli(['render', ...D(dir)])).code, 2, 'no --url and no --pending');
});

/* ── render: the headless browser, end to end ─────────────────────────────── */
const blocker = renderBlocker();
test('render: a page drawn by script is saved whole, straight to disk, as a headless snapshot', { skip: blocker || false }, async () => {
  const dir = mkdir([`${base}/ref/invoice`]);
  assert.equal((await cli(['inventory', ...D(dir), '--urls', join(dir, 'urls.txt')])).code, 0);
  /* the plain-HTTP reader sees an empty shell… */
  const snap = await cli(['snap', ...D(dir), '--pending']);
  assert.match(snap.out, /js_shell/, 'a plain fetch of the same page is refused as a shell');
  /* …the headless reader sees the page */
  const r = await cli(['render', ...D(dir), '--pending']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 page\(s\) saved/);
  const rec = index(dir).pages[`${base}/ref/invoice`];
  assert.equal(rec.fetcher, 'headless');
  assert.ok(rec.chars >= 1500, `the whole page, not an excerpt (${rec.chars} characters)`);
  const text = readFileSync(join(dir, '_agent_out', 'api-docs', rec.file), 'utf8');
  assert.ok(text.includes('POST /v3/company/<realmID>/invoice') && text.includes('Attribute 59'), 'text that script drew after load is in the file, to the last line');
  assert.equal(inventory(dir).pages[0].status, 'saved');
  /* and it feeds the rest of the pipeline unchanged */
  assert.equal((await cli(['prep', ...D(dir)])).code, 0);
});

test('render: a page robots.txt disallows is excluded with that reason and never loaded', { skip: blocker || false }, async () => {
  const dir = mkdir([`${base}/private/secret`, `${base}/ref/invoice`]);
  assert.equal((await cli(['inventory', ...D(dir), '--urls', join(dir, 'urls.txt')])).code, 0);
  const r = await cli(['render', ...D(dir), '--url', `${base}/private/secret,${base}/ref/invoice`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /robots\.txt disallows it — excluded/);
  assert.match(r.out, /ingest/, 'it says what to do instead');
  const inv = inventory(dir);
  assert.equal(inv.pages.find(p => /private/.test(p.url)).status, 'excluded');
  assert.equal(inv.pages.find(p => /private/.test(p.url)).reason, 'robots.txt disallows it');
  assert.equal(inv.pages.find(p => /invoice/.test(p.url)).status, 'saved', 'the allowed page was still read');
  assert.ok(!index(dir).pages[`${base}/private/secret`], 'nothing of the disallowed page was stored');
});

test('render: a page that never finishes drawing is refused, not saved as if it were the page', { skip: blocker || false }, async () => {
  const dir = mkdir([`${base}/ref/stuck`]);
  assert.equal((await cli(['inventory', ...D(dir), '--urls', join(dir, 'urls.txt')])).code, 0);
  const r = await cli(['render', ...D(dir), '--pending']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /reads as js_shell/);
  assert.ok(!existsSync(join(dir, '_agent_out', 'api-docs', 'index.json')) || Object.keys(index(dir).pages).length === 0, 'nothing was stored');
  assert.equal(inventory(dir).pages[0].status, 'pending', 'the page is still waiting to be read');
});
