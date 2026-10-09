/* Sync this repo with the deployed skill at ~/.claude/skills/connector-qa.
 *
 * These two copies drifted for a day without anyone noticing: every fix landed in the deployed
 * copy, which runs, while the repo — which holds the only test suite — stayed behind. The tests
 * therefore passed against code nobody was running. This makes the copy a command with a
 * direction, so a sync is deliberate and its result is printed.
 *
 *   node scripts/sync-skill.mjs            # report drift only, change nothing
 *   node scripts/sync-skill.mjs --pull     # deployed → repo
 *   node scripts/sync-skill.mjs --push     # repo → deployed
 *
 * Repo-only scaffolding (tests, evals, README, package.json) is never pushed: the deployed skill
 * does not need it and should not carry it.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const REPO = process.cwd();
const SKILL = process.env.CONNECTOR_QA_SKILL || join(homedir(), '.claude', 'skills', 'connector-qa');
const a = new Set(process.argv.slice(2));
/* Repo-only scaffolding. `sync-skill.mjs` is itself a development tool — the deployed skill has
 * no second copy to reconcile with, so shipping it there would be noise. */
const REPO_ONLY = new Set(['tests', 'evals', 'README.md', 'CHANGELOG.md', 'GETTING-STARTED.md', 'package.json',
  'node_modules', '.git', 'sync-skill.mjs', 'dist', 'tools', 'install-info.json']);
const EXT = /\.(mjs|md|json|html)$/;

if (!existsSync(SKILL)) { console.error(`deployed skill not found at ${SKILL}`); process.exit(2); }

const walk = (root, base = root, out = []) => {
  for (const e of readdirSync(root)) {
    /* `_`-prefixed files are working scratch — mockups, drafts — and never ship */
    if (REPO_ONLY.has(e) || e.startsWith('.') || e.startsWith('_')) continue;
    const p = join(root, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else if (EXT.test(e)) out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
};
const hash = p => {
  if (!existsSync(p)) return null;
  /* Machine-local paths are deliberately not synced, so they must not count as drift */
  if (p.endsWith('config.json')) {
    try { const c = JSON.parse(readFileSync(p, 'utf8')); delete c.root;
      if (c.driver_source) delete c.driver_source.root;
      return createHash('md5').update(JSON.stringify(c)).digest('hex'); } catch {}
  }
  return createHash('md5').update(readFileSync(p)).digest('hex');
};

const files = [...new Set([...walk(SKILL), ...walk(REPO)])].sort();
const drift = [];
for (const f of files) {
  const s = hash(join(SKILL, f)), r = hash(join(REPO, f));
  if (s === r) continue;
  drift.push({ f, state: !s ? 'repo-only' : !r ? 'deployed-only' : 'differs' });
}

if (!drift.length) { console.log('in sync — no differences'); process.exit(0); }

const dir = a.has('--pull') ? 'pull' : a.has('--push') ? 'push' : null;
if (!dir) {
  console.log(`${drift.length} file(s) differ between repo and deployed skill:\n`);
  for (const d of drift) console.log(`  ${d.state.padEnd(14)} ${d.f}`);
  console.log(`\nrepo     ${REPO}\ndeployed ${SKILL}`);
  console.log(`\nNothing changed. Re-run with --pull (deployed → repo) or --push (repo → deployed).`);
  process.exit(1);
}

let n = 0;
for (const { f, state } of drift) {
  const from = join(dir === 'pull' ? SKILL : REPO, f);
  const to   = join(dir === 'pull' ? REPO : SKILL, f);
  if (!existsSync(from)) {
    console.log(`  skip (absent at source) ${f}`);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  /* `config.root` is machine-local: the deployed skill lives under ~/.claude/skills, whose parent
   * is not the project, so it cannot infer the root and genuinely needs an absolute path — while
   * the repo is the shared copy and must never carry anyone's home directory. Copying the file
   * wholesale propagated one machine's path to the other and put a username into the shared copy.
   * Everything syncs except that field, which each side keeps. */
  if (f === 'config.json' && existsSync(to)) {
    const src = JSON.parse(readFileSync(from, 'utf8'));
    const dst = JSON.parse(readFileSync(to, 'utf8'));
    src.root = dst.root ?? '';
    /* Same reasoning for the driver enlistment: an absolute path, machine-specific, and one that
     * contains a username on Windows. Without this a sync silently wipes it and Stage 0.5 goes
     * quiet — which looks like the feature not working rather than a path being cleared. */
    if (src.driver_source) src.driver_source.root = (dst.driver_source && dst.driver_source.root) || '';
    writeFileSync(to, JSON.stringify(src, null, 2) + '\n', 'utf8');
    n++; console.log(`  updated ${f}  (kept this copy's machine-local paths)`);
    continue;
  }
  copyFileSync(from, to); n++;
  console.log(`  ${state === 'differs' ? 'updated' : 'added  '} ${f}`);
}
console.log(`\n${dir === 'pull' ? 'deployed → repo' : 'repo → deployed'}: ${n} file(s)`);
