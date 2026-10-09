#!/usr/bin/env node
/**
 * validate-report.mjs — headless render check for a generated report.
 *
 *   node validate-report.mjs "<path to report.html>"
 *
 * Extracts the page's <script>, runs it against a minimal DOM shim, and reports which
 * elements received content plus any error thrown. Also exercises every interactive handler.
 *
 * Exit 0 = every panel rendered and every handler ran clean.
 * Exit 1 = something threw, or a panel that should have content is empty.
 * Exit 2 = bad usage.
 *
 * Catches the two failure modes that a visual glance misses: a constant left at its
 * placeholder default (panel silently empty) and a template-literal typo in a rarely
 * opened tab. No dependencies. Node 18+.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import vm from 'node:vm';

const file = process.argv[2];
if (!file) { console.error('usage: node validate-report.mjs <report.html>'); process.exit(2); }
const path = resolve(file);
if (!existsSync(path)) { console.error(`not found: ${path}`); process.exit(2); }

const html = readFileSync(path, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: no <script> block found — is this a generated report?'); process.exit(1); }

/* unfilled placeholders are a silent-empty-panel bug, so surface them up front */
const leftover = [...html.matchAll(/const\s+(\w+)\s*=\s*\/\* FILL/g)].map(x => x[1]);   // declarations only — the banner text is not a placeholder

/* ───────────────────────── DOM shim ───────────────────────── */

const written = Object.create(null);
const content = Object.create(null);
const lookedUp = new Set();

function makeEl(id) {
  const el = {
    id,
    // mirror the form-control defaults declared in the template markup
    value: id === 'model-sel' ? 'sonnet' : id === 'in-price' ? '3' : id === 'out-price' ? '15' : '',
    dataset: {}, style: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _html: '', _text: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v ?? ''); written[id] = this._html.length; content[id] = this._html; },
    get outerHTML() { return this._html; },
    set outerHTML(v) { this._html = String(v ?? ''); written[id] = this._html.length; content[id] = this._html; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v ?? ''); written[id] = this._text.length; content[id] = this._text; },
    appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, focus() {}, scrollIntoView() {},
  };
  el.parentElement = { querySelectorAll: () => [] };
  return el;
}

const els = Object.create(null);
const document = {
  getElementById(id) { lookedUp.add(id); return (els[id] ||= makeEl(id)); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(`<${tag}>`); },
  addEventListener() {},
  body: makeEl('body'),
  documentElement: makeEl('html'),
};

const sandbox = {
  document, console,
  navigator: { clipboard: { writeText: async () => {} } },
  location: { hash: '', href: '' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, Object, Array, String, Number, Boolean,
  Set, Map, RegExp, Intl, Error, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

/* ───────────────────────── run ───────────────────────── */

let thrown = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: basename(path), timeout: 20_000 });
} catch (e) { thrown = e; }

console.log(`\n${basename(path)}`);

if (thrown) {
  console.error(`\n  ✗ SCRIPT THREW: ${thrown.message}`);
  if (thrown.stack) console.error(thrown.stack.split('\n').slice(0, 5).map(l => '    ' + l.trim()).join('\n'));
  process.exit(1);
}

/* exercise the interactive handlers — a broken tab is invisible until someone clicks it */
const handlers = [
  ['showTab',   ['coverage', makeEl('btn')]],
  ['showTab',   ['customer', makeEl('btn')]],
  ['showTab',   ['semantic', makeEl('btn')]],
  ['regroup',   ['process', makeEl('btn')]],
  ['regroup',   ['role',    makeEl('btn')]],
  ['regroup',   ['persona', makeEl('btn')]],
  ['regroup',   ['object',  makeEl('btn')]],
  ['regroup',   ['gap',     makeEl('btn')]],
  ['gapFilter', ['unresolved', makeEl('btn')]],
  ['gapFilter', ['P1', makeEl('btn')]],
  ['semFilter', ['T1', makeEl('btn')]],
  ['schFilter', ['gap', makeEl('btn')]],
  ['renderCost', []],
];
const hErrors = [];
for (const [name, argv] of handlers) {
  if (typeof sandbox[name] !== 'function') { hErrors.push(`${name}: NOT DEFINED`); continue; }
  try { sandbox[name](...argv); } catch (e) { hErrors.push(`${name}(${argv[0] ?? ''}): ${e.message}`); }
}

const ids = Object.keys(written);
const filled = ids.filter(i => written[i] > 0);
const empty = ids.filter(i => written[i] === 0);
const untouched = [...lookedUp].filter(i => !(i in written)).sort();

console.log(`  ✓ script executed clean`);
console.log(`  ✓ ${filled.length} elements populated  (${filled.reduce((s, i) => s + written[i], 0).toLocaleString()} chars rendered)`);

if (leftover.length) {
  console.log(`\n  ✗ ${leftover.length} constant(s) still hold a /* FILL */ placeholder — those panels render empty:`);
  leftover.forEach(c => console.log(`      ${c}`));
}
if (empty.length) {
  console.log(`\n  ⚠ ${empty.length} element(s) written with an empty string:`);
  empty.forEach(i => console.log(`      ${i}`));
}
if (untouched.length) {
  console.log(`\n  · ${untouched.length} looked up but never given innerHTML (usually style/class-only — expected):`);
  console.log(`      ${untouched.join(', ')}`);
}
if (hErrors.length) {
  console.log(`\n  ✗ handler errors:`);
  hErrors.forEach(e => console.log(`      ${e}`));
} else {
  console.log(`\n  ✓ all ${handlers.length} handler invocations ran clean`);
}

/* A panel that renders the string "undefined" or "[object Object]" is a broken panel that the
 * old checks scored as populated — the Asana report shipped `undefined` as its headline score
 * and four "[object Object]" issues, and still passed. */
const GARBAGE = [
  ['[object Object]', /\[object Object\]/],
  /* An interpolation leak sits where a VALUE belongs: alone in a tag, straight after "label:",
   * at the start or end of a cell. The bare English word can appear legitimately mid-sentence —
   * one Asana workflow's researched edge case reads "section in the newly added project undefined
   * until placed", which is prose. Matching the word anywhere failed every real run, and a check
   * that always fails is a check everyone learns to ignore. */
  ['undefined',       /(^|>\s*|:\s*|,\s*)undefined\s*($|<|[,.])/],
  ['NaN',             /(^|[>\s:])NaN([<%\s.,]|$)/],
];
const dirty = [];
for (const [id, html] of Object.entries(content)) {
  for (const [label, re] of GARBAGE) if (re.test(html)) dirty.push(`${id} renders "${label}"`);
}
if (dirty.length) {
  console.log(`\n  ✗ ${dirty.length} element(s) rendered placeholder garbage:`);
  dirty.forEach(d => console.log(`      ${d}`));
}

const ok = !hErrors.length && !leftover.length && !dirty.length;
console.log(ok ? '\n  PASS\n' : '\n  FAIL\n');
process.exit(ok ? 0 : 1);
