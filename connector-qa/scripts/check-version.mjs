#!/usr/bin/env node
/**
 * check-version.mjs — Step 0: is this the skill version you think it is?
 *
 *   node check-version.mjs [--quiet]
 *
 * Claude Code runs the INSTALLED copy (~/.claude/skills/connector-qa), but the skill is developed in
 * its source folder and reaches the installed copy only when install.ps1 / install.sh is re-run.
 * On 2026-10-05 a NetSuite run used an installed 2.1.0 while the source was at 3.4.2 — none of the
 * catalog, scoring or report work applied, and nothing said so. install.ps1/sh now records where a
 * copy came from (install-info.json beside config.json); this compares the two.
 *
 * Exit 0 = up to date, running from the source, or the source is no longer on this machine.
 * Exit 3 = the source is at a different version: re-run the installer before going on.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/* 3.7.1 — the runtime files' content, so an edit without a version bump is caught too. Line endings
 * and the machine-specific config.root are left out: they differ between source and installed copy. */
const RUNTIME = ['SKILL.md', 'config.json', 'LICENSE.txt', 'agents', 'assets', 'references', 'schemas', 'scripts'];
export function runtimeHash(dir) {
  const files = [];
  const walk = p => { if (!existsSync(p)) return; if (statSync(p).isDirectory()) { for (const e of readdirSync(p).sort()) if (!e.startsWith('.') && !e.startsWith('_')) walk(join(p, e)); } else files.push(p); };
  for (const r of RUNTIME) walk(join(dir, r));
  const h = createHash('sha1');
  for (const f of files.filter(f => !/sync-skill\.mjs$/.test(f)).sort()) {
    let t = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (/config\.json$/.test(f) && relative(dir, f) === 'config.json') t = t.replace(/"root":\s*"[^"]*"/, '"root": ""');
    h.update(relative(dir, f).replace(/\\/g, '/') + '\0' + t + '\0');
  }
  return h.digest('hex').slice(0, 16);
}

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
/* the installers call --stamp <source> after copying: record what was installed */
const si = process.argv.indexOf('--stamp');
if (si > 0) {
  const src = resolve(process.argv[si + 1]);
  const f = join(here, 'install-info.json');
  const info = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) : {};
  info.hash = runtimeHash(src);
  writeFileSync(f, JSON.stringify(info, null, 2) + '\n');
  console.log(`  content fingerprint ${info.hash}`);
  process.exit(0);
}
const read = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const mine = read(join(here, 'config.json'))?.version || 'unknown';
const info = read(join(here, 'install-info.json'));
const say = m => { if (!quiet) console.log(m); };

if (!info) { say(`VERSION — connector-qa ${mine} · running from the source or a linked install`); process.exit(0); }
const src = info.source ? resolve(info.source) : null;
const theirs = src && existsSync(join(src, 'config.json')) ? read(join(src, 'config.json'))?.version : null;
if (!theirs) { say(`VERSION — connector-qa ${mine} · installed ${String(info.installed_at || '').slice(0, 10)}; source folder not found, nothing to compare`); process.exit(0); }
if (theirs === mine) {
  /* same version — but was the source edited since the install? */
  if (info.hash && runtimeHash(src) !== info.hash) {
    console.error(`VERSION — installed connector-qa ${mine} matches the source's version, but the source at ${src} has changed since it was installed.`);
    console.error(`  This run would use the older files. Update the installed copy first:`);
    console.error(process.platform === 'win32' ? `    cd "${src}"; .\\install.ps1` : `    cd "${src}" && bash install.sh`);
    console.error('  Then start a new Claude Code session so the updated skill is loaded.');
    process.exit(3);
  }
  say(`VERSION — connector-qa ${mine} · installed copy matches the source`); process.exit(0);
}

const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const newer = cmp(theirs, mine) > 0;
console.error(`VERSION — installed connector-qa ${mine}, but the source at ${src} is ${theirs}${newer ? ' (newer)' : ''}.`);
console.error(`  This run would use ${mine}. Stop and update the installed copy first:`);
console.error(process.platform === 'win32' ? `    cd "${src}"; .\\install.ps1` : `    cd "${src}" && bash install.sh`);
console.error('  Then start a new Claude Code session so the updated skill is loaded.');
process.exit(3);
