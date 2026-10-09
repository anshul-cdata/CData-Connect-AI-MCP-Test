/* page-reader.mjs — read public web pages the same way for every stage that needs them (3.9).
 *
 * Stage 1.5a assembles a capability list from a vendor's API reference pages when no machine-readable
 * description exists; Stage 5.5a reads the vendor's use case, help and community pages. Many of those
 * sites are JavaScript applications: a plain fetch (or WebFetch) returns an empty shell, and only a
 * rendered browser shows the text. This module is the part that does not need a model:
 *
 *   htmlToText(html)            readable text from static HTML (scripts, styles and tags out)
 *   assessPage({text, html})    'ok' · 'js_shell' · 'empty' — does a rendered browser have to read it?
 *   endpointLines(text)         lines that document an endpoint ("POST /v3/company/{realmId}/invoice")
 *   chunkText(text, size)       long pages split on line boundaries for extraction
 *   robotsAllows(robots, url)   robots.txt, longest-match, for the generic agent and ours
 *   parseSitemap(xml) · linksFrom(html, base)   the pages a site lists
 *   snapshotStore(dir, sub)     saved page text: _agent_out/<sub>/<hash>.txt + index.json, one per URL
 *   fetchPage(url) · politeGet  plain HTTP: sequential, public pages, robots.txt respected
 *
 * A snapshot is the page's text exactly as the reader got it, so a model's extraction can be checked
 * against it word for word (contains()). WebFetch is fine for a quick look, but it returns a model's
 * summary, never the page's own text, so it never makes a snapshot. The rendered readers are the
 * Claude desktop browser pane (get_page_text), Playwright MCP and Claude in Chrome (references/10a-page-reader.md).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FETCHERS = ['http', 'browser_pane', 'playwright', 'chrome'];
export const RENDERED = ['browser_pane', 'playwright', 'chrome'];
export const READER_DEFAULTS = { shell_min_chars: 1500, chunk_chars: 40000, chunk_overlap_chars: 600, delay_ms: 1000, timeout_ms: 30000,
  user_agent: 'connector-qa-page-reader (public documentation; respects robots.txt)' };

/* ── HTML → text ─────────────────────────────────────────────────────────── */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const BLOCK = /<\/?(p|div|br|li|ul|ol|tr|table|thead|tbody|h[1-6]|pre|section|article|header|footer|nav|aside|main|dt|dd|dl|blockquote|hr|figure|figcaption|summary|details|form|fieldset|legend|option)\b[^>]*>/gi;
export function htmlToText(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(td|th)\b[^>]*>/gi, ' \t')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ── is it a JavaScript shell? ───────────────────────────────────────────── */
const METHOD = '(GET|POST|PUT|PATCH|DELETE)';
const ENDPOINT = new RegExp(`(^|[^A-Za-z])${METHOD}\\b\\s*[:\\-–]?\\s*(https?:\\/\\/[^\\s"'<>]+|\\/[^\\s"'<>]*[A-Za-z{<:][^\\s"'<>]*)`);
/** Lines that document an endpoint: a method next to a path or URL. */
export const endpointLines = text => String(text || '').split('\n').filter(l => ENDPOINT.test(l));
export const endpointOf = line => { const m = ENDPOINT.exec(line); return m ? { method: m[2].toUpperCase(), path: m[3] } : null; };

const SHELL_SIGNS = [
  [/(enable|requires?|turn on)\s+javascript|javascript (is )?(disabled|required)/i, 'asks for JavaScript'],
  [/<div[^>]+id=["'](root|app|__next|__nuxt|___gatsby|main-app)["'][^>]*>\s*<\/div>/i, 'an empty application root element'],
  [/__NEXT_DATA__|window\.__INITIAL_STATE__|ng-version=|data-reactroot|webpackJsonp|<app-root/i, 'a client-side application bundle'],
];
/**
 * Does this page need a rendered browser? `text` is what a reader got; `html` (when known) the raw
 * response. `expect: 'api'` for an API reference page, where a page with no endpoint-like line and the
 * signs of a client-side app is a shell too, however long its navigation text.
 * @param {{text?: string, html?: string, expect?: 'api'|'prose', minChars?: number}} p
 */
export function assessPage({ text = '', html = '', expect = 'prose', minChars = READER_DEFAULTS.shell_min_chars } = {}) {
  const t = String(text || '').trim();
  const chars = t.length;
  const endpoints = expect === 'api' ? endpointLines(t).length : null;
  const signs = SHELL_SIGNS.filter(([re]) => re.test(html || '') || re.test(t)).map(([, w]) => w);
  const scripts = (String(html || '').match(/<script\b/gi) || []).length;
  if (scripts >= 5 && html.length > 50 * Math.max(chars, 1)) signs.push(`${scripts} scripts and almost no text`);
  let verdict = 'ok', reason = '';
  if (!chars && !html) { verdict = 'empty'; reason = 'nothing came back'; }
  else if (chars < minChars) { verdict = 'js_shell'; reason = `only ${chars} characters of text${signs.length ? ` — ${signs.join(', ')}` : ''}`; }
  else if (expect === 'api' && !endpoints && signs.length) { verdict = 'js_shell'; reason = `no endpoint-like line — ${signs.join(', ')}`; }
  else if (expect === 'api' && !endpoints) reason = 'no endpoint-like line: an overview or index page, or a layout that writes methods apart from paths';
  return { verdict, chars, endpoint_lines: endpoints, signs, reason };
}

/* ── chunks ──────────────────────────────────────────────────────────────── */
const NL = String.fromCharCode(10);
/** Split on line boundaries into pieces of at most `size` characters; each piece after the first
 * repeats the last lines of the one before (up to `overlap` characters) so nothing loses its heading. */
export function chunkText(text, size = READER_DEFAULTS.chunk_chars, overlap = READER_DEFAULTS.chunk_overlap_chars) {
  const s = String(text || '');
  if (s.length <= size) return [s];
  const out = [];
  let cur = [], len = 0, fresh = 0;
  const flush = () => {
    if (!fresh) return;
    out.push(cur.join(NL));
    const keep = []; let k = 0;
    for (let i = cur.length - 1; i >= 0 && k + cur[i].length + 1 <= overlap; i--) { keep.unshift(cur[i]); k += cur[i].length + 1; }
    cur = keep; len = k; fresh = 0;
  };
  for (let l of s.split(NL)) {
    while (l.length > size) { flush(); out.push(l.slice(0, size)); l = l.slice(size); cur = []; len = 0; }
    if (len + l.length + 1 > size) flush();
    cur.push(l); len += l.length + 1; fresh++;
  }
  flush();
  return out;
}

/* ── word-for-word checks ────────────────────────────────────────────────── */
/** Whitespace, non-breaking spaces, zero-width characters and curly quotes made uniform — a quote is
 * checked against the page as a reader sees it, not byte for byte. */
export const normWs = s => String(s ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[\u00a0\s]+/g, ' ')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
export const contains = (page, quote) => { const q = normWs(quote); return q.length >= 8 && normWs(page).includes(q); };

/* ── URLs ────────────────────────────────────────────────────────────────── */
export function normalizeUrl(u) {
  try { const x = new URL(String(u).trim()); x.hash = ''; x.hostname = x.hostname.toLowerCase();
    let s = x.toString(); if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1); return s; }
  catch { return null; }
}
export const pageHash = u => createHash('sha1').update(normalizeUrl(u) || String(u)).digest('hex').slice(0, 16);
const ASSET = /\.(css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|zip|gz|mp4|mp3)(\?|$)/i;
/** Same-site links of a static page, absolute, without fragments or assets. */
export function linksFrom(html, base) {
  const origin = (() => { try { return new URL(base).origin; } catch { return null; } })();
  const out = new Set();
  for (const m of String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*|#[^"']+)["']/gi)) {
    const h = decodeEntities(m[1]).trim();
    if (/^(mailto|javascript|tel):/i.test(h) || h.startsWith('#')) continue;
    let abs; try { abs = new URL(h, base); } catch { continue; }
    if (origin && abs.origin !== origin) continue;
    if (ASSET.test(abs.pathname)) continue;
    const n = normalizeUrl(abs.toString()); if (n) out.add(n);
  }
  return [...out];
}
/** <urlset> → urls; <sitemapindex> → further sitemaps. */
export function parseSitemap(xml) {
  const s = String(xml || '');
  const locs = [...s.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => decodeEntities(m[1]));
  return /<sitemapindex\b/i.test(s) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

/* ── robots.txt ──────────────────────────────────────────────────────────── */
export function parseRobots(txt) {
  const groups = []; let g = null, lastAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastAgent) { g = { agents: [], rules: [] }; groups.push(g); } g.agents.push(v.toLowerCase()); lastAgent = true; continue; }
    lastAgent = false;
    if (!g) continue;
    if (k === 'allow' || k === 'disallow') g.rules.push({ allow: k === 'allow', path: v });
  }
  return groups;
}
const ruleRe = p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, m => m === '$' ? m : '\\' + m).replace(/\*/g, '.*').replace(/\\\$$/, '$'));
/** May `ua` fetch `url`? The most specific group for the agent (else `*`); the longest matching rule
 * wins, Allow on a tie; an empty Disallow allows everything. */
export function robotsAllows(txt, url, ua = 'connector-qa') {
  const groups = parseRobots(txt);
  const me = String(ua).toLowerCase();
  const g = groups.find(x => x.agents.some(a => a !== '*' && me.includes(a))) || groups.find(x => x.agents.includes('*'));
  if (!g) return true;
  let path; try { const u = new URL(url); path = u.pathname + u.search; } catch { return true; }
  let best = null;
  for (const r of g.rules) {
    if (!r.path) continue;
    if (ruleRe(r.path).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

/* ── snapshots ───────────────────────────────────────────────────────────── */
/**
 * Saved page text under <dir>/_agent_out/<sub>/: <hash>.txt (the whole text), <hash>.c<N>.txt (chunks,
 * when long) and index.json { pages: { <normalized url>: {url, hash, file, chunks, fetcher, chars, title, at} } }.
 */
export function snapshotStore(dir, sub, opts = {}) {
  const root = join(dir, '_agent_out', sub);
  const indexFile = join(root, 'index.json');
  const size = opts.chunk_chars || READER_DEFAULTS.chunk_chars, overlap = opts.chunk_overlap_chars ?? READER_DEFAULTS.chunk_overlap_chars;
  const load = () => existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { pages: {} };
  const save = idx => { mkdirSync(root, { recursive: true }); writeFileSync(indexFile, JSON.stringify(idx, null, 2)); };
  return {
    root, indexFile, load, save,
    /** @param {{url: string, text: string, fetcher: string, title?: string|null}} p */
    put({ url, text, fetcher, title = null }) {
      const key = normalizeUrl(url); if (!key) throw new Error(`not a URL: ${url}`);
      if (!FETCHERS.includes(fetcher)) throw new Error(`fetcher must be one of ${FETCHERS.join(', ')}`);
      mkdirSync(root, { recursive: true });
      const hash = pageHash(key), file = `${hash}.txt`;
      writeFileSync(join(root, file), String(text));
      const parts = chunkText(String(text), size, overlap);
      const chunks = parts.length > 1 ? parts.map((p, i) => { const f = `${hash}.c${i + 1}.txt`; writeFileSync(join(root, f), p); return f; }) : [file];
      const idx = load();
      idx.pages[key] = { url: key, hash, file, chunks, fetcher, chars: String(text).length, title, at: new Date().toISOString() };
      save(idx);
      return idx.pages[key];
    },
    get(url) { const key = normalizeUrl(url); const m = key && load().pages[key]; return m ? { ...m, text: readFileSync(join(root, m.file), 'utf8') } : null; },
  };
}

/* ── plain HTTP, politely ────────────────────────────────────────────────── */
/** One GET. Never throws: {ok, status, url, type, body, error}. */
export async function fetchPage(url, { ua = READER_DEFAULTS.user_agent, timeoutMs = READER_DEFAULTS.timeout_ms } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,application/xml,application/json,text/yaml,text/plain;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: ctl.signal });
    const body = await r.text();
    return { ok: r.ok, status: r.status, url: r.url || url, type: r.headers.get('content-type') || '', body };
  } catch (e) { return { ok: false, status: 0, url, type: '', body: '', error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}
/** Sequential GETs that honour robots.txt (read once per origin) and wait between requests. */
export function politeGet(opts = {}) {
  const o = { ...READER_DEFAULTS, ...opts };
  const robots = new Map(); let last = 0;
  const wait = async () => { const d = last + o.delay_ms - Date.now(); if (d > 0) await new Promise(r => setTimeout(r, d)); last = Date.now(); };
  return async function get(url) {
    let origin; try { origin = new URL(url).origin; } catch { return { ok: false, status: 0, url, body: '', error: 'not a URL' }; }
    if (!robots.has(origin)) { await wait(); const r = await fetchPage(origin + '/robots.txt', { ua: o.user_agent, timeoutMs: o.timeout_ms }); robots.set(origin, r.ok ? r.body : ''); }
    if (!robotsAllows(robots.get(origin), url, o.user_agent)) return { ok: false, status: 0, url, body: '', error: 'robots.txt disallows it', robots: true };
    await wait();
    return fetchPage(url, { ua: o.user_agent, timeoutMs: o.timeout_ms });
  };
}
