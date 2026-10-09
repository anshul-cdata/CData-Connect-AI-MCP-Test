#!/usr/bin/env node
/**
 * check-skill.mjs — consistency check for the skill itself. Ships with the skill (review M2).
 *
 *   node check-skill.mjs [<skill folder>]     defaults to the folder containing scripts/
 *
 * Verifies: every intra-skill file reference resolves; SKILL.md routes to every reference file;
 * no reference file is orphaned; frontmatter is valid; SKILL.md is under 500 lines; every script
 * parses; config.json is valid and names every artifact; no username leaked into shipped files.
 * Exit 0 clean · 1 problems.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const SK = process.argv[2] || join(here, '..');
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? (['node_modules', 'runs', 'dist', '_archive'].includes(f) ? [] : walk(p)) : [p]; });
const files = walk(SK);
const rel = f => relative(SK, f).replace(/\\/g, '/');
const present = new Set(files.map(rel));
const problems = [], notes = [];

/* 1 · cross-references */
const REF = /(?:references\/|agents\/|assets\/|scripts\/(?:lib\/)?|evals\/|schemas\/|config)[\w./-]*\.(?:md|html|mjs|json|txt)/g;
const referenced = new Set();
for (const f of files.filter(f => /\.(md|mjs|json|ps1|sh)$/.test(f) && !f.includes('assets'))) {
  const text = readFileSync(f, 'utf8');
  for (const hit of new Set(text.match(REF) || [])) {
    const target = hit.startsWith('config') ? 'config.json' : hit;
    referenced.add(target);
    if (!present.has(target)) problems.push(`${rel(f)} → ${hit} NOT FOUND`);
  }
}
/* 2 · routing + orphans */
const skill = readFileSync(join(SK, 'SKILL.md'), 'utf8');
const routed = new Set(skill.match(/references\/[\w.-]+\.md/g) || []);
for (const p of present) if (p.startsWith('references/') && !referenced.has(p)) problems.push(`orphaned: ${p} is never referenced`);
for (const p of present) if (p.startsWith('agents/') && !referenced.has(p)) problems.push(`orphaned agent: ${p}`);
notes.push(`SKILL.md routes to ${routed.size} reference file(s); ${[...present].filter(p => p.startsWith('references/')).length} exist`);
/* 3 · frontmatter + size */
const fm = skill.match(/^---\n([\s\S]*?)\n---/);
if (!fm) problems.push('SKILL.md has no frontmatter');
else { if (!/^name:\s*\S+/m.test(fm[1])) problems.push('SKILL.md frontmatter lacks name'); if (!/^description:/m.test(fm[1])) problems.push('SKILL.md frontmatter lacks description'); }
const lines = skill.split('\n').length; if (lines > 500) problems.push(`SKILL.md is ${lines} lines (>500)`); else notes.push(`SKILL.md ${lines} lines`);
for (const ag of files.filter(f => rel(f).startsWith('agents/'))) {
  const t = readFileSync(ag, 'utf8').replace(/\r\n/g, '\n');
  const afm = t.match(/^---\n([\s\S]*?)\n---/);
  if (!afm || !/^name:\s*\S+/m.test(afm[1])) problems.push(`${rel(ag)} lacks frontmatter name`);
  if (afm && /^tools:/m.test(afm[1])) problems.push(`${rel(ag)} declares tools: in frontmatter — unenforced for skill-folder agents and therefore misleading`);
}
/* 4 · scripts parse */
for (const s of files.filter(f => f.endsWith('.mjs'))) {
  try { execFileSync(process.execPath, ['--check', s], { stdio: 'pipe' }); } catch (e) { problems.push(`${rel(s)} does not parse: ${(e.stderr || '').toString().split('\n')[0]}`); }
}
/* 5 · config */
try {
  const cfg = JSON.parse(readFileSync(join(SK, 'config.json'), 'utf8'));
  for (const k of ['knowledge', 'coverage', 'gaps', 'plan', 'checkpoint', 'report', 'gap_report']) if (!cfg.artifacts || !cfg.artifacts[k]) problems.push(`config.artifacts.${k} missing`);
  if (!cfg.version) problems.push('config.json lacks version');

  /* Every `config.a.b` path the docs quote must actually exist. SKILL.md told the orchestrator to
   * read `config.defaults.required_orchestrator` while the key lives under `config.models`, so the
   * model gate silently read undefined and never fired — a control that looked implemented, passed
   * review, and did nothing. A misquoted path is indistinguishable from a disabled feature. */
  const has = p => p.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg) !== undefined;
  const IGNORE = /^config\.(root|version|artifacts|json)$/;   // generic references, not leaf keys
  /* The checker names example paths in its own comments, and a CHANGELOG describes keys that no
   * longer exist — that is what a changelog is for. Both would otherwise fail this check forever.
   * `_doc/` builds the framework document, whose whole job is to explain the skill: it quotes
   * `config.defaults.required_orchestrator` to tell the story of the gate that silently read
   * undefined, and `config.a.b` as the example of what this very check catches. Prose describing
   * a path is not a reference to it. */
  const EXEMPT = new Set(['scripts/check-skill.mjs', 'CHANGELOG.md']);
  const exempt = f => EXEMPT.has(rel(f)) || rel(f).startsWith('_doc/');
  for (const f of files.filter(f => /\.(md|mjs)$/.test(f) && !exempt(f))) {
    const txt = readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/`config\.([A-Za-z_][\w.]*)`/g)) {
      const path = m[1].replace(/\.$/, '');
      if (IGNORE.test(`config.${path}`) || path.includes('{') ) continue;
      if (!has(path)) problems.push(`${rel(f)} references \`config.${path}\` which does not exist in config.json`);
    }
  }
} catch (e) { problems.push(`config.json invalid: ${e.message}`); }
/* 5b · control characters smuggled into source */
/* Editing these files through a shell heredoc turned every \\b inside a regex into a literal
 * backspace byte (0x08). `/FROM\\b/` became `/FROM<BS>/` — a VALID regex that simply never
 * matches. --check passed, the test suite passed, and a projection rewrite silently did nothing
 * through several rounds of review. A raw control byte in source is never intentional. */
{
  const CTRL = new RegExp('[' + [0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]
    .map(c => '\\u' + c.toString(16).padStart(4, '0')).join('') + ']', 'g');
  for (const f of files.filter(f => /\.(mjs|md|json|html)$/.test(f))) {
    const n = (readFileSync(f, 'utf8').match(CTRL) || []).length;
    if (n) problems.push(`${rel(f)} contains ${n} raw control character(s) — likely a regex escape corrupted by an editing tool`);
  }
}

/* 5c · README and SKILL.md must document the same run flags */
/* README described `--maxrounds N` as "gap-closure iterations, default `3`" long after rounds were
 * removed and no script accepted the flag — and documented none of --fresh, --rerun or --resume
 * while claiming to show the whole interface. The config-path check above cannot see this class:
 * a CLI flag is not a `config.a.b` path, so nothing compared the two documents. SKILL.md is the
 * copy the orchestrator actually reads, which makes it the reference; README drifting from it is
 * the defect. A flag documented with behaviour the code dropped is worse than one left out. */
{
  const flagsIn = txt => new Set([...txt.matchAll(/^\|\s*`(--[a-z][\w-]*)/gm)].map(m => m[1]));
  const readme = join(SK, 'README.md');
  if (existsSync(readme)) {
    const doc = flagsIn(readFileSync(readme, 'utf8')), src = flagsIn(skill);
    const missing = [...src].filter(f => !doc.has(f));
    const invented = [...doc].filter(f => !src.has(f));
    if (missing.length) problems.push(`README.md omits run flag(s) SKILL.md accepts: ${missing.join(', ')}`);
    if (invented.length) problems.push(`README.md documents run flag(s) SKILL.md does not accept: ${invented.join(', ')}`);
    if (!missing.length && !invented.length) notes.push(`README and SKILL.md document the same ${src.size} run flag(s)`);
  }

  /* And a file has to agree with itself. §0.2's usage line — the line anyone copies first —
   * advertised four flags while the table directly beneath it documented five, omitting `--rerun`,
   * which detect-stage.mjs implements and routes on. Comparing two documents against each other
   * cannot catch one document contradicting itself a line later. */
  const usage = skill.match(/^\/connector-qa .*$/m);
  if (usage) {
    const advertised = new Set([...usage[0].matchAll(/--[a-z][\w-]*/g)].map(m => m[0]));
    const omitted = [...flagsIn(skill)].filter(f => !advertised.has(f));
    if (omitted.length) problems.push(`SKILL.md usage line omits flag(s) its own table documents: ${omitted.join(', ')}`);
  }
}

/* 6 · no username in shipped files (source folder only) */
const user = (process.env.USERNAME || process.env.USER || '').trim();
if (user && existsSync(join(SK, 'install.ps1'))) for (const f of files.filter(f => /\.(md|mjs|json|ps1|sh|html)$/.test(f) && !rel(f).startsWith('runs/'))) {
  if (rel(f) === 'config.json') continue;   // installed copy legitimately carries root
  if (readFileSync(f, 'utf8').includes(user)) problems.push(`${rel(f)} contains the username "${user}"`);
}

console.log(`\ncheck-skill · ${files.length} files`);
notes.forEach(n => console.log('  · ' + n));
if (problems.length) { console.log(`\n✗ ${problems.length} problem(s):`); problems.forEach(p => console.log('  ' + p)); process.exit(1); }
console.log('  ✓ all references resolve · no orphans · frontmatter valid · scripts parse · config valid\n');
