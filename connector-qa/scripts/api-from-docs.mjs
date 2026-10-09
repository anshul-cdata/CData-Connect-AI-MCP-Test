#!/usr/bin/env node
/**
 * api-from-docs.mjs — Stage 1.5a when the vendor publishes no OpenAPI description (3.9).
 *
 *   node api-from-docs.mjs ladder    --dir <d> --docs <url> [--github owner[/repo]] [--try u1,u2]
 *   node api-from-docs.mjs convert   --dir <d> --file <downloaded> [--url <where from>]
 *   node api-from-docs.mjs probe     --dir <d> --url u1[,u2] [--expect api|prose] [--text-file f --fetcher F]
 *   node api-from-docs.mjs inventory --dir <d> [--sitemap url|file] [--index url|file] [--urls file] [--include re] [--exclude re] [--robots file]
 *   node api-from-docs.mjs exclude   --dir <d> (--url u | --match re) --why "<reason>"
 *   node api-from-docs.mjs snap      --dir <d> (--url u [--text-file f --fetcher F] | --from list.json | --pending)
 *   node api-from-docs.mjs render    --dir <d> (--url u1[,u2] | --pending) [--browser <exe>] [--expect api|prose]   (3.9.3: headless browser, text straight to disk)
 *   node api-from-docs.mjs ingest    --dir <d> --from <folder> [--prefix p] [--fetcher chrome|browser_pane|playwright] [--move] | --snippet [--prefix p]
 *   node api-from-docs.mjs prep      --dir <d> [--per-agent N]
 *   node api-from-docs.mjs merge     --dir <d> [--ops f1,f2] [--rung reference_docs|sdk] [--title t] [--version v] [--entities file]
 *   node api-from-docs.mjs status    --dir <d>
 *   (any command that fetches: --delay-ms <n> overrides config.capabilities.api_docs.delay_ms for this call)
 *
 * The ladder, first hit wins (references/10-capabilities.md §1.5a): a machine-readable description
 * (OpenAPI/Swagger, also behind ReadMe, Redoc, Stoplight and Swagger UI portals; OData $metadata;
 * WSDL; RAML; GraphQL) → a Postman collection or an official SDK's entity list → the reference pages.
 * `ladder` looks for the first two mechanically; `convert` turns what it found into the OpenAPI shape.
 * Without one, the pages are read (references/10a-page-reader.md): `probe` decides plain HTTP or a
 * rendered browser, `inventory` lists every page, `snap` saves each page's text, a model extracts
 * the operations from the saved text (`prep` writes its brief), and `merge` keeps only what the
 * saved text shows word for word and writes <Connector>_api.json for capability-list.mjs read.
 * `status` exits 3 while a page is neither extracted nor excluded with a reason.
 *
 * `render` (3.9.3) is the way past a JavaScript shell that needs no model: it starts the Chrome or Edge
 * already on the machine, headless, reads each page once it has stopped changing and writes the text
 * straight to the snapshot store — page text never passes through a model's context. It refuses any page
 * robots.txt disallows. For those, and where no browser is installed, a person reads the page in their own
 * browser and `ingest` files the downloaded text (`ingest --snippet` prints the console snippet).
 *
 * Polite by construction: one request at a time, config.capabilities.api_docs.delay_ms apart, public
 * pages only, robots.txt read first. No paid crawler, no sign-in.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, loadConfig, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { READER_DEFAULTS, RENDERED, FETCHERS, htmlToText, assessPage, snapshotStore, normalizeUrl, linksFrom, parseSitemap,
         robotsAllows, politeGet, robotsGate } from './lib/page-reader.mjs';
import { openBrowser, renderBlocker } from './lib/headless-capture.mjs';
import { sniffFormat, specLinksIn, wellKnownUrls, CONVERTERS, toOpenApi, mergeOps, completenessHint, RUNGS, OP_KINDS } from './lib/api-docs.mjs';

const CMDS = ['ladder', 'convert', 'probe', 'inventory', 'exclude', 'snap', 'render', 'ingest', 'prep', 'merge', 'status'];
const USAGE = `usage: api-from-docs.mjs <${CMDS.join('|')}> --dir <connectorDir> …  (see the header of this script)`;
const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'docs', 'github', 'try', 'file', 'url', 'expect', 'text-file', 'fetcher', 'title', 'sitemap', 'index', 'urls',
          'include', 'exclude', 'robots', 'match', 'why', 'from', 'pending', 'per-agent', 'ops', 'rung', 'version', 'entities', 'delay-ms',
          'browser', 'prefix', 'move', 'snippet'],
  usage: USAGE,
});
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(USAGE); process.exit(EXIT.USAGE); }
const cfg = loadConfig();
const R = { ...READER_DEFAULTS, ...(cfg.capabilities?.api_docs || {}) };
/* a stricter site may ask for a longer pause; never shorter than the site allows */
if (a['delay-ms'] !== undefined && Number.isFinite(Number(a['delay-ms']))) R.delay_ms = Math.max(0, Number(a['delay-ms']));
const conn = resolveConnector(a.dir, a.connector);
const OUT = join(a.dir, '_agent_out', 'api-docs');
const F = n => join(OUT, n);
const store = snapshotStore(a.dir, 'api-docs', R);
const get = politeGet(R);
const list = v => (v && v !== true ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
const now = () => new Date().toISOString();
const say = s => console.log(s);

/* the inventory: every page found, each extracted or excluded with a reason */
const INV = F('inventory.json');
const loadInv = () => existsSync(INV) ? readJson(INV) : { connector: conn, pages: [] };
const saveInv = inv => { inv.updated_at = now(); writeJson(INV, inv); };
const invMap = inv => new Map(inv.pages.map(p => [p.url, p]));
const readerOf = () => existsSync(F('reader.json')) ? readJson(F('reader.json')) : null;
const RENDER_HELP = [
  'Read it with a rendered browser. Easiest, with no model in the loop (needs a Chrome/Edge/Chromium on this machine and Node 22+):',
  '  · api-from-docs.mjs render --dir <d> --url <u>   (or --pending) — headless, straight to disk; it refuses robots.txt-disallowed pages',
  'Otherwise read it with whichever browser the session has and save the text to a file:',
  '  · Claude desktop browser pane — navigate, then get_page_text',
  '  · Playwright MCP — browser_navigate, then browser_evaluate "() => document.body.innerText"',
  '  · Claude in Chrome — navigate, then get_page_text',
  '  then: api-from-docs.mjs snap --dir <d> --url <u> --text-file <file> --fetcher browser_pane|playwright|chrome',
  'Pages you read yourself in your own browser (also ones robots.txt disallows): api-from-docs.mjs ingest --snippet, run it on each page, then ingest --from <Downloads folder>.',
  'None available? Stop and ask the user to enable Playwright MCP (free, runs locally). Never use a paid crawler.',
].join('\n');
/** keep the previous file when a new one replaces it */
function writeApi(doc) {
  const out = join(a.dir, `${conn}_api.json`);
  if (existsSync(out)) { const prev = readFileSync(out, 'utf8'); if (prev !== JSON.stringify(doc, null, 2)) copyFileSync(out, `${out}.bak-${Date.now()}`); }
  writeJson(out, doc);
  return out;
}

/* ── ladder ─────────────────────────────────────────────────────────────── */
if (cmd === 'ladder') {
  if (!a.docs || a.docs === true) fail('--docs must name the vendor\'s API documentation page', EXIT.USAGE);
  const tried = [];
  const page = await get(a.docs);
  tried.push({ url: a.docs, status: page.status, note: page.error || 'the docs page' });
  const origins = new Set();
  try { origins.add(new URL(page.url || a.docs).origin); } catch { /* not a URL */ }
  for (const m of String(page.body || '').matchAll(/https:\/\/(api|developer|developers|docs)\.[a-z0-9.-]+/gi)) origins.add(m[0].toLowerCase());
  const cands = [...list(a.try), ...specLinksIn(page.body, page.url || a.docs), ...wellKnownUrls([...origins].slice(0, 4))];
  if (a.github && a.github !== true) {
    const [owner, repo] = String(a.github).split('/');
    const repos = repo ? [repo] : ((await get(`https://api.github.com/orgs/${owner}/repos?per_page=100`)).body || '[]').match(/"name":\s*"([^"]+)"/g)?.map(x => x.split('"')[3])
      .filter(n => /openapi|swagger|api-?spec|api-?def|api-?description|postman|raml|wsdl|graphql/i.test(n)) || [];
    for (const r of repos.slice(0, 5)) {
      const ls = await get(`https://api.github.com/repos/${owner}/${r}/contents`);
      for (const m of String(ls.body || '').matchAll(/"download_url":\s*"([^"]+\.(?:json|ya?ml|raml|wsdl|graphql|xml))"/g)) cands.push(m[1]);
      tried.push({ url: `github ${owner}/${r}`, status: ls.status, note: 'repository listing' });
    }
  }
  let hit = null;
  for (const u of [...new Set(cands)].slice(0, 40)) {
    const r = await get(u);
    const format = r.ok ? sniffFormat(r.body) : null;
    tried.push({ url: u, status: r.status, ...(format ? { format } : {}), ...(r.error ? { note: r.error } : {}) });
    if (format) {
      const ext = format === 'openapi' && !/^\s*[{[]/.test(r.body) ? 'yaml' : { odata: 'xml', wsdl: 'xml', raml: 'raml', graphql: /^\s*\{/.test(r.body) ? 'json' : 'graphql' }[format] || 'json';
      const file = F(`source.${ext}`);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(file, r.body);
      hit = { rung: format === 'postman' ? 'postman' : 'spec', format, url: r.url || u, file };
      break;
    }
  }
  writeJson(F('ladder.json'), { connector: conn, docs: a.docs, at: now(), tried, hit });
  say(`LADDER — ${conn}`);
  for (const t of tried) say(`  ${t.format ? '✓' : '·'} ${t.status || '—'} ${t.url}${t.format ? ` · ${t.format}` : t.note ? ` · ${t.note}` : ''}`);
  if (hit) { say(`\n  found a ${hit.format} description (rung: ${hit.rung}) at ${hit.url}\n  next: api-from-docs.mjs convert --dir "${a.dir}" --file "${hit.file}" --url "${hit.url}"`); process.exit(EXIT.OK); }
  say('\n  no machine-readable description found. Before reading pages, check by hand: a "Download OpenAPI" or "Run in Postman" button,');
  say('  the vendor\'s GitHub organisation, an official SDK. If there is none: api-from-docs.mjs probe --dir … --url <a reference page>');
  process.exit(EXIT.DATA);
}

/* ── convert ─────────────────────────────────────────────────────────────── */
if (cmd === 'convert') {
  if (!a.file || !existsSync(a.file)) fail('--file must name the downloaded description', EXIT.USAGE);
  const text = readFileSync(a.file, 'utf8');
  const format = sniffFormat(text);
  if (!format) fail(`${a.file} is not a description this script reads (OpenAPI/Swagger, Postman v2.1, OData $metadata, WSDL, RAML, GraphQL)`);
  if (format === 'openapi') {
    /* the vendor's own OpenAPI is used as published */
    const out = join(a.dir, `${conn}_api.${/^\s*[{[]/.test(text) ? 'json' : 'yaml'}`);
    if (out !== a.file) { if (existsSync(out)) copyFileSync(out, `${out}.bak-${Date.now()}`); copyFileSync(a.file, out); }
    say(`CONVERT — ${conn} · OpenAPI, used as published\n→ ${out}\n  next: capability-list.mjs read --dir "${a.dir}" --spec "${out}"`);
    process.exit(EXIT.OK);
  }
  const { ops, title, version } = CONVERTERS[format](text);
  if (!ops.length) fail(`${a.file} reads as ${format} but lists no operation`);
  const doc = toOpenApi(ops, { title: title || `${conn} API`, version, rung: format === 'postman' ? 'postman' : 'spec', format,
    source_url: a.url && a.url !== true ? a.url : null });
  const out = writeApi(doc);
  say(`CONVERT — ${conn} · ${format} → ${ops.length} operation(s)\n→ ${out}\n  next: capability-list.mjs read --dir "${a.dir}" --spec "${out}"`);
  process.exit(EXIT.OK);
}

/* ── probe: plain HTTP, or a rendered browser? ───────────────────────────── */
if (cmd === 'probe') {
  const urls = list(a.url);
  if (!urls.length) fail('--url must name one or two reference pages', EXIT.USAGE);
  const expect = a.expect === 'prose' ? 'prose' : 'api';
  const probes = [];
  for (const u of urls.slice(0, 2)) {
    if (a['text-file']) {
      if (!FETCHERS.includes(a.fetcher)) fail(`--fetcher must be one of ${FETCHERS.join(', ')}`, EXIT.USAGE);
      const t = readFileSync(a['text-file'], 'utf8');
      probes.push({ url: u, fetcher: a.fetcher, ...assessPage({ text: t, expect, minChars: R.shell_min_chars }) });
      continue;
    }
    const r = await get(u);
    if (r.robots) { probes.push({ url: u, fetcher: 'http', verdict: 'disallowed', reason: 'robots.txt disallows it' }); continue; }
    const type = String(r.type || '');
    const text = /html|xml/i.test(type) || /^\s*</.test(r.body) ? htmlToText(r.body) : r.body;
    probes.push({ url: u, fetcher: 'http', status: r.status, ...assessPage({ text, html: r.body, expect, minChars: R.shell_min_chars }), ...(r.error ? { error: r.error } : {}) });
  }
  const shell = probes.some(p => p.verdict !== 'ok');
  const decision = a['text-file'] ? (shell ? 'rendered' : a.fetcher) : shell ? 'rendered' : 'http';
  const prev = readerOf();
  writeJson(F('reader.json'), { connector: conn, at: now(), expect, decision, probes: [...(prev?.probes || []), ...probes].slice(-10) });
  say(`PROBE — ${conn}`);
  for (const p of probes) say(`  ${p.verdict === 'ok' ? '✓' : '✗'} ${p.url} · ${p.fetcher} · ${p.verdict}${p.chars != null ? ` · ${p.chars} chars` : ''}${p.endpoint_lines != null ? ` · ${p.endpoint_lines} endpoint line(s)` : ''}${p.reason ? ` · ${p.reason}` : ''}`);
  say(`\nREADER ${decision}`);
  if (decision === 'rendered') say(RENDER_HELP.replace('<d>', a.dir));
  else say('  plain HTTP reads these pages: api-from-docs.mjs snap --dir … --pending saves every page in the inventory');
  process.exit(EXIT.OK);
}

/* ── inventory ───────────────────────────────────────────────────────────── */
if (cmd === 'inventory') {
  const inv = loadInv();
  const found = [];   // {url, from}
  const readSrc = async (v, kind) => {
    if (/^https?:\/\//i.test(v)) { const r = await get(v); if (!r.ok) fail(`${kind} ${v}: ${r.error || 'HTTP ' + r.status}`); return { body: r.body, base: r.url || v }; }
    if (!existsSync(v)) fail(`${kind} ${v} not found`, EXIT.USAGE);
    return { body: readFileSync(v, 'utf8'), base: a.docs && a.docs !== true ? a.docs : null };
  };
  if (a.sitemap && a.sitemap !== true) {
    const queue = [a.sitemap], seen = new Set();
    while (queue.length && seen.size < 20) {
      const s = queue.shift(); if (seen.has(s)) continue; seen.add(s);
      const { body } = await readSrc(s, '--sitemap');
      const sm = parseSitemap(body);
      sm.urls.forEach(u => found.push({ url: u, from: 'sitemap' }));
      queue.push(...sm.sitemaps.filter(x => !a.include || new RegExp(a.include, 'i').test(x) || /sitemap/i.test(x)));
    }
  }
  if (a.index && a.index !== true) {
    const { body, base } = await readSrc(a.index, '--index');
    const as = assessPage({ text: htmlToText(body), html: body, minChars: 200 });
    if (as.verdict !== 'ok' && /^https?:/i.test(a.index)) say(`  ⚠ the index page reads as ${as.verdict} (${as.reason}). Its links are drawn by JavaScript: in the rendered browser run\n    () => [...document.querySelectorAll('a[href]')].map(a => a.href).join('\\n')\n    save the result and pass it as --urls <file>`);
    linksFrom(body, base || a.index).forEach(u => found.push({ url: u, from: 'index' }));
  }
  if (a.urls && a.urls !== true) {
    const t = readFileSync(a.urls, 'utf8').trim();
    const arr = t.startsWith('[') ? JSON.parse(t) : t.split(/\r?\n/);
    arr.map(x => (typeof x === 'string' ? x : x?.url || '').trim()).filter(Boolean).forEach(u => found.push({ url: u, from: 'list' }));
  }
  if (!found.length && !inv.pages.length) fail('nothing to inventory — give --sitemap, --index or --urls', EXIT.USAGE);
  const robotsTxt = a.robots && a.robots !== true ? readFileSync(a.robots, 'utf8') : null;
  const robotsCache = new Map();
  const robotsFor = async u => {
    if (robotsTxt != null) return robotsTxt;
    if (!/^https?:\/\//i.test(String(a.sitemap || a.index || ''))) return '';      // offline lists: robots is checked when each page is fetched
    const o = new URL(u).origin;
    if (!robotsCache.has(o)) { const r = await get(o + '/robots.txt'); robotsCache.set(o, r.ok ? r.body : ''); }
    return robotsCache.get(o);
  };
  const have = invMap(inv);
  const inc = a.include && a.include !== true ? new RegExp(a.include, 'i') : null;
  const exc = a.exclude && a.exclude !== true ? new RegExp(a.exclude, 'i') : null;
  let added = 0, excluded = 0;
  for (const f of found) {
    const url = normalizeUrl(f.url); if (!url || have.has(url)) continue;
    let status = 'pending', reason = null;
    if (inc && !inc.test(url)) { status = 'excluded'; reason = `outside the API reference (does not match --include ${a.include})`; }
    else if (exc && exc.test(url)) { status = 'excluded'; reason = `matches --exclude ${a.exclude}`; }
    else if (!robotsAllows(await robotsFor(url), url, R.user_agent)) { status = 'excluded'; reason = 'robots.txt disallows it'; }
    const p = { url, status, from: f.from, ...(reason ? { reason } : {}) };
    inv.pages.push(p); have.set(url, p); added++; if (status === 'excluded') excluded++;
  }
  if (a.docs && a.docs !== true) inv.docs = a.docs;
  saveInv(inv);
  const n = s => inv.pages.filter(p => p.status === s).length;
  say(`INVENTORY — ${conn} · ${added} page(s) added (${excluded} excluded with a reason) · ${inv.pages.length} in all: ${n('pending')} to read · ${n('saved')} saved · ${n('extracted')} extracted · ${n('excluded')} excluded`);
  say(`→ ${INV}`);
  process.exit(EXIT.OK);
}

/* ── exclude ─────────────────────────────────────────────────────────────── */
if (cmd === 'exclude') {
  const why = a.why && a.why !== true ? String(a.why).trim() : '';
  if (why.split(/\s+/).length < 3) fail('--why must say, in a few words, why the page holds no operation ("an overview of authentication")', EXIT.USAGE);
  const inv = loadInv();
  const re = a.match && a.match !== true ? new RegExp(a.match, 'i') : null;
  const target = re ? inv.pages.filter(p => re.test(p.url)) : inv.pages.filter(p => p.url === normalizeUrl(a.url || ''));
  if (!target.length) fail(`no page in the inventory matches ${a.match || a.url}`);
  for (const p of target) { p.status = 'excluded'; p.reason = why; }
  saveInv(inv);
  say(`  ${target.length} page(s) excluded: ${why}`);
  process.exit(EXIT.OK);
}

/* ── snap: save a page's text ────────────────────────────────────────────── */
if (cmd === 'snap') {
  const inv = loadInv(), have = invMap(inv);
  const items = [];
  if (a.from && a.from !== true) for (const x of JSON.parse(readFileSync(a.from, 'utf8'))) items.push({ url: x.url, file: x.file || x.text_file, fetcher: x.fetcher, title: x.title || null });
  else if (a.pending) inv.pages.filter(p => p.status === 'pending').forEach(p => items.push({ url: p.url }));
  else if (a.url && a.url !== true) list(a.url).forEach(u => items.push({ url: u, file: a['text-file'] && a['text-file'] !== true ? a['text-file'] : null, fetcher: a.fetcher, title: a.title && a.title !== true ? a.title : null }));
  if (!items.length) fail('nothing to save — give --url, --from or --pending', EXIT.USAGE);
  let saved = 0; const problems = [];
  for (const it of items) {
    const url = normalizeUrl(it.url);
    const page = url && have.get(url);
    if (!page) { problems.push(`${it.url}: not in the inventory — add it first (inventory --urls), or it cannot be cited`); continue; }
    if (it.file) {
      if (!RENDERED.includes(it.fetcher) && it.fetcher !== 'http') { problems.push(`${it.url}: --fetcher must be one of ${FETCHERS.join(', ')}`); continue; }
      const text = readFileSync(it.file, 'utf8');
      const as = assessPage({ text, expect: 'api', minChars: Math.min(R.shell_min_chars, 400) });
      if (as.verdict !== 'ok') { problems.push(`${it.url}: the saved text reads as ${as.verdict} (${as.reason}) — the page had not loaded; read it again`); continue; }
      store.put({ url, text, fetcher: it.fetcher, title: it.title });
      page.status = 'saved'; page.fetcher = it.fetcher; delete page.reason; saved++;
      continue;
    }
    const r = await get(url);
    if (r.robots) { page.status = 'excluded'; page.reason = 'robots.txt disallows it'; problems.push(`${url}: robots.txt disallows it — excluded`); continue; }
    if (!r.ok) { problems.push(`${url}: ${r.error || 'HTTP ' + r.status}`); continue; }
    const text = /^\s*</.test(r.body) ? htmlToText(r.body) : r.body;
    const as = assessPage({ text, html: r.body, expect: 'api', minChars: R.shell_min_chars });
    if (as.verdict !== 'ok') { problems.push(`${url}: plain HTTP got a ${as.verdict} (${as.reason}) — read it with a rendered browser`); continue; }
    store.put({ url, text, fetcher: 'http', title: /<title>([^<]*)<\/title>/i.exec(r.body)?.[1]?.trim() || null });
    page.status = 'saved'; page.fetcher = 'http'; delete page.reason; saved++;
  }
  saveInv(inv);
  say(`SNAP — ${conn} · ${saved} page(s) saved under ${store.root}`);
  for (const p of problems.slice(0, 20)) say(`  ✗ ${p}`);
  if (problems.some(p => /rendered browser|had not loaded/.test(p))) say('\n' + RENDER_HELP.replace('<d>', a.dir));
  process.exit(problems.length && !saved ? EXIT.DATA : EXIT.OK);
}

/* ── render: read pages in a headless browser, text straight to disk (3.9.3) ─────────────── */
if (cmd === 'render') {
  const inv = loadInv(), have = invMap(inv);
  const urls = a.pending ? inv.pages.filter(p => p.status === 'pending').map(p => p.url) : list(a.url);
  if (!urls.length) fail('nothing to render — give --url or --pending (inventory first)', EXIT.USAGE);
  const exe = a.browser && a.browser !== true ? a.browser : undefined;
  const why = renderBlocker({ browser: exe });
  if (why) fail(`${why}\n\n${RENDER_HELP}`, EXIT.DATA);
  const expect = a.expect === 'prose' ? 'prose' : 'api';
  const allowed = robotsGate(R);
  let br;
  try { br = await openBrowser({ browser: exe, userAgent: R.user_agent }); }
  catch (e) { fail(`could not start a browser: ${e.message}`, EXIT.DATA); }
  let saved = 0, last = 0; const problems = [];
  try {
    for (const raw of urls) {
      const url = normalizeUrl(raw);
      const page = url && have.get(url);
      if (!page) { problems.push(`${raw}: not in the inventory — add it first (inventory --urls), or it cannot be cited`); continue; }
      const g = await allowed(url);
      if (!g.allowed) { page.status = 'excluded'; page.reason = 'robots.txt disallows it'; problems.push(`${url}: robots.txt disallows it — excluded. A page you read yourself in your own browser can be filed with ingest (references/10a-page-reader.md §3)`); continue; }
      const gap = last + R.delay_ms - Date.now(); if (gap > 0) await new Promise(r => setTimeout(r, gap));
      const r = await br.capture(url, { settleMs: R.render_settle_ms, timeoutMs: R.render_timeout_ms });
      last = Date.now();
      if (r.error) { problems.push(`${url}: ${r.error}`); continue; }
      const as = assessPage({ text: r.text, expect, minChars: R.shell_min_chars });
      if (as.verdict !== 'ok') { problems.push(`${url}: the rendered text reads as ${as.verdict} (${as.reason})${r.timedOut ? ' — it was still changing at the time limit; raise capabilities.api_docs.render_timeout_ms' : ''}`); continue; }
      store.put({ url, text: r.text, fetcher: 'headless', title: r.title || null });
      page.status = 'saved'; page.fetcher = 'headless'; delete page.reason; saved++;
    }
  } finally { await br.close(); saveInv(inv); }
  say(`RENDER — ${conn} · ${saved} page(s) saved under ${store.root} · headless ${br.browser}`);
  for (const p of problems.slice(0, 20)) say(`  ✗ ${p}`);
  /* Node 24 on Windows aborts inside libuv (0xC0000409) when process.exit() runs while the robots.txt fetch's connection is still closing */
  await new Promise(r => setTimeout(r, 250));
  process.exit(problems.length && !saved ? EXIT.DATA : EXIT.OK);
}

/* ── ingest: file pages a person read in their own browser (3.9.3) ───────────────────────── */
/* One console snippet for any browser: waits for the page to draw, downloads its text as <prefix><last path segment>.txt */
const snippetFor = prefix => `(async()=>{let k=0;while(document.body.innerText.length<3000&&k++<30)await new Promise(r=>setTimeout(r,500));const t=document.body.innerText;const s=decodeURIComponent(location.pathname.split('/').filter(Boolean).pop()||'index').toLowerCase();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t]));a.download=${JSON.stringify(prefix)}+s+'.txt';document.body.appendChild(a);a.click();a.remove();return s+' '+t.length})()`;
const slugOf = u => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || 'index').toLowerCase(); } catch { return null; } };
if (cmd === 'ingest') {
  const prefix = a.prefix && a.prefix !== true ? String(a.prefix) : '';
  if (a.snippet) { say(`Run this in the browser console on each reference page (the browser may ask to allow downloads); the files land in the Downloads folder:\n\n${snippetFor(prefix)}\n\nThen: api-from-docs.mjs ingest --dir <d> --from <Downloads folder>${prefix ? ` --prefix ${prefix}` : ''} [--move]`); process.exit(EXIT.OK); }
  if (!a.from || a.from === true || !existsSync(a.from)) fail('--from must name the folder the browser downloaded the page text to (or use --snippet)', EXIT.USAGE);
  const fetcher = a.fetcher && a.fetcher !== true ? String(a.fetcher) : 'chrome';
  if (!RENDERED.includes(fetcher) || fetcher === 'headless') fail(`--fetcher must be one of ${RENDERED.filter(f => f !== 'headless').join(', ')} (the browser that drew the page)`, EXIT.USAGE);
  const inv = loadInv();
  const bySlug = new Map();
  for (const p of inv.pages) { const s = slugOf(p.url); if (s) bySlug.set(s, [...(bySlug.get(s) || []), p]); }
  const files = readdirSync(a.from).filter(f => f.toLowerCase().endsWith('.txt') && f.startsWith(prefix));
  let saved = 0; const problems = [];
  for (const f of files) {
    const stem = f.slice(prefix.length, -4).toLowerCase();
    const cands = bySlug.get(stem) || [];
    if (cands.length === 0) { problems.push(`${f}: no inventory page ends in "${stem}" — add the page (inventory --urls) or rename the file`); continue; }
    if (cands.length > 1) { problems.push(`${f}: ${cands.length} inventory pages end in "${stem}" (${cands.map(c => c.url).join(' · ')}) — save it with snap --url <u> --text-file ${f} instead of guessing`); continue; }
    const page = cands[0];
    const text = readFileSync(join(a.from, f), 'utf8');
    /* a person-read page is a whole page: the strict length bar applies, not the lenient one for short browser excerpts */
    const as = assessPage({ text, expect: 'api', minChars: R.shell_min_chars });
    if (as.verdict !== 'ok') { problems.push(`${f}: the text reads as ${as.verdict} (${as.reason}) — the page had not finished drawing; read it again`); continue; }
    store.put({ url: page.url, text, fetcher, title: null });
    page.status = 'saved'; page.fetcher = fetcher; delete page.reason; saved++;
    if (a.move) { const dst = F('src'); mkdirSync(dst, { recursive: true }); renameSync(join(a.from, f), join(dst, f)); }
  }
  saveInv(inv);
  say(`INGEST — ${conn} · ${saved} of ${files.length} file(s) saved under ${store.root}${a.move ? ' · originals moved to _agent_out/api-docs/src' : ''}`);
  for (const p of problems.slice(0, 20)) say(`  ✗ ${p}`);
  process.exit(problems.length && !saved ? EXIT.DATA : EXIT.OK);
}

/* ── prep: the extraction brief ──────────────────────────────────────────── */
if (cmd === 'prep') {
  const inv = loadInv(), idx = store.load();
  const todo = inv.pages.filter(p => p.status === 'saved' && idx.pages[p.url]);
  if (!todo.length) fail('no saved page waits for extraction — snap pages first (or every page is already extracted)');
  const per = Number(a['per-agent']) || 12;
  const batches = [];
  let cur = null;
  for (const p of todo) {
    const m = idx.pages[p.url];
    if (!cur || cur.files.length + m.chunks.length > per) { cur = { id: `AX-${String(batches.length + 1).padStart(3, '0')}`, pages: [], files: [] }; batches.push(cur); }
    cur.pages.push({ url: p.url, title: m.title, files: m.chunks.map(f => join(store.root, f)) });
    cur.files.push(...m.chunks);
  }
  const out = F('extract-input.json');
  writeJson(out, { connector: conn, at: now(),
    instructions: [
      'Read every file of your batch: each is the saved text of one API reference page (a long page is split into overlapping parts).',
      'List every API operation the page documents: {"entity","operation","method","path","summary","doc_url","evidence"}.',
      'entity: the object as the page names it ("Invoice"). operation: the verb as documented ("create", "read", "query", "sparse update", "delete", "void", "send", "get as PDF").',
      'method and path exactly as documented — keep the vendor\'s real method (an update by POST stays POST) and its placeholders and query (?operation=delete). Never normalise.',
      `Optional kind: one of ${OP_KINDS.join(', ')} when the operation word does not say it.`,
      'doc_url: the page\'s URL as given. evidence: one line copied word for word from that page that shows the operation (usually the line with the method and path). The merge rejects any operation whose evidence is not on its page.',
      'Invent nothing: an operation the page does not show is not listed. A page that documents no operation goes in pages_without_ops with the reason ("an overview of OAuth 2.0 sign-in").',
      'Return {"model":"<you>","batch":"<id>","ops":[...],"pages_without_ops":[{"doc_url","reason"}]} and write it to the batch\'s output file before returning.'],
    batches: batches.map(b => ({ id: b.id, output: F(`ops-${b.id}.json`), pages: b.pages })) });
  say(`PREP — ${conn} · ${todo.length} page(s) in ${batches.length} extraction batch(es) of ≤ ${per} file(s)\n→ ${out}`);
  say('  dispatch one general-purpose agent per batch (model: config.models.research), then: api-from-docs.mjs merge --dir …');
  process.exit(EXIT.OK);
}

/* ── merge: keep what the pages show, write <C>_api.json ─────────────────── */
if (cmd === 'merge') {
  const inv = loadInv(), have = invMap(inv);
  const files = list(a.ops).length ? list(a.ops) : (existsSync(OUT) ? readdirSync(OUT).filter(f => /^ops-.*\.json$/.test(f)).map(f => F(f)) : []);
  if (!files.length) fail('no extraction output — give --ops or put ops-<batch>.json under _agent_out/api-docs/', EXIT.USAGE);
  const rung = a.rung && a.rung !== true ? a.rung : 'reference_docs';
  if (!RUNGS.includes(rung) || rung === 'spec') fail(`--rung must be reference_docs or sdk (a description is converted with convert)`, EXIT.USAGE);
  const ops = [], noOps = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    ops.push(...(j.ops || j.operations || []));
    noOps.push(...(j.pages_without_ops || []));
  }
  const { kept, rejected, duplicates } = mergeOps(ops, { inventory: have, snapshot: u => store.get(u) });
  /* page statuses: a page with an operation is extracted; one the extraction says holds none is
   * excluded with that reason; a saved page neither mentions stays waiting */
  const withOps = new Set(kept.flatMap(o => [o.doc_url, ...(o.also || [])]));
  for (const p of inv.pages) if (withOps.has(p.url)) { p.status = 'extracted'; delete p.reason; }
  for (const n of noOps) { const p = have.get(normalizeUrl(n.doc_url || '')); if (p && !withOps.has(p.url) && String(n.reason || '').trim().split(/\s+/).length >= 3) { p.status = 'excluded'; p.reason = String(n.reason).trim(); } }
  saveInv(inv);
  if (!kept.length) { for (const r of rejected.slice(0, 15)) say(`  ✗ ${r.op?.entity || '?'} ${r.op?.operation || '?'}: ${r.why.join('; ')}`); fail(`no operation survived the check (${rejected.length} rejected)`); }
  const fetchers = [...new Set(inv.pages.filter(p => p.status === 'extracted').map(p => p.fetcher).filter(Boolean))];
  const excluded = inv.pages.filter(p => p.status === 'excluded').map(p => ({ url: p.url, reason: p.reason || '' }));
  const K = existsSync(join(a.dir, `${conn}_knowledge.json`)) ? readJson(join(a.dir, `${conn}_knowledge.json`)) : null;
  const entities = a.entities && a.entities !== true ? (t => t.startsWith('[') ? JSON.parse(t) : t.split(/\r?\n/))(readFileSync(a.entities, 'utf8').trim()).map(s => String(s).trim()).filter(Boolean) : [];
  const hint = completenessHint(kept, { tables: (K?.objects || []).map(o => o.name), entities });
  const doc = toOpenApi(kept.map(o => ({ ...o, doc_url: o.doc_url })), {
    title: a.title && a.title !== true ? a.title : `${conn} API (assembled from ${rung === 'sdk' ? 'the SDK' : 'reference pages'})`,
    version: a.version && a.version !== true ? a.version : null, rung, fetcher: fetchers.join('+') || null,
    pages: inv.pages.filter(p => p.status === 'extracted').length, excluded });
  doc.info['x-assembled'].review = { tables_without_operations: hint.tables, sdk_entities_without_operations: hint.entities };
  const out = writeApi(doc);
  writeJson(F('merge-report.json'), { connector: conn, at: now(), kept: kept.length, duplicates, rejected: rejected.map(r => ({ entity: r.op?.entity, operation: r.op?.operation, doc_url: r.op?.doc_url, why: r.why })), completeness: hint });
  const waiting = inv.pages.filter(p => ['pending', 'saved'].includes(p.status));
  say(`MERGE — ${conn} · ${kept.length} operation(s) from ${doc.info['x-assembled'].pages} page(s) · ${duplicates} duplicate(s) merged · ${rejected.length} rejected`);
  for (const r of rejected.slice(0, 12)) say(`  ✗ ${r.op?.entity || '?'} · ${r.op?.operation || '?'} — ${r.why.join('; ')}`);
  if (hint.tables.length || hint.entities.length) say(`  for review, never added automatically — no operation found for: ${[...hint.tables.map(t => `table ${t}`), ...hint.entities.map(e => `SDK entity ${e}`)].slice(0, 20).join(', ')}${hint.tables.length + hint.entities.length > 20 ? ' …' : ''}`);
  if (waiting.length) say(`  ⚠ ${waiting.length} page(s) neither extracted nor excluded — api-from-docs.mjs status lists them`);
  say(`→ ${out}\n  next: capability-list.mjs read --dir "${a.dir}" --spec "${out}"`);
  process.exit(EXIT.OK);
}

/* ── status ──────────────────────────────────────────────────────────────── */
if (cmd === 'status') {
  const inv = loadInv(), rd = readerOf();
  const ld = existsSync(F('ladder.json')) ? readJson(F('ladder.json')) : null;
  const n = s => inv.pages.filter(p => p.status === s).length;
  say(`API FROM DOCS — ${conn}`);
  if (ld) say(`  ladder: ${ld.hit ? `${ld.hit.format} found (${ld.hit.rung}) at ${ld.hit.url}` : `no machine-readable description in ${ld.tried.length} place(s) tried`}`);
  if (rd) say(`  reader: ${rd.decision}`);
  say(`  inventory: ${inv.pages.length} page(s) · ${n('extracted')} extracted · ${n('excluded')} excluded · ${n('saved')} saved, not extracted · ${n('pending')} not read`);
  const api = join(a.dir, `${conn}_api.json`);
  const asm = existsSync(api) ? readJson(api).info?.['x-assembled'] : null;
  if (asm) say(`  ${conn}_api.json: ${asm.operations} operation(s) · ${asm.rung}${asm.pages != null ? ` · ${asm.pages} page(s)` : ''}${asm.fetcher ? ` · ${asm.fetcher}` : ''}`);
  const waiting = inv.pages.filter(p => ['pending', 'saved'].includes(p.status));
  if (waiting.length) {
    for (const p of waiting.slice(0, 10)) say(`    · ${p.status === 'saved' ? 'saved, not extracted' : 'not read'}: ${p.url}`);
    console.error(`\n✗ ${waiting.length} page(s) neither extracted nor excluded with a reason`);
    process.exit(EXIT.DATA);
  }
  if (inv.pages.length && !asm) { console.error('\n✗ every page is accounted for, but no assembled list yet — run merge'); process.exit(EXIT.DATA); }
  say('  ✓ every page is extracted or excluded with a reason');
  process.exit(EXIT.OK);
}
