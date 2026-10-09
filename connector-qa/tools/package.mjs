/* Build the zip you hand to someone else: dist/connector-qa-<version>.zip
 *
 *   npm run package        # runs check-skill and the test suite first, then this
 *
 * The working folder carries things a recipient should never get — node_modules, report
 * previews, mockups, archived documents, a machine-local config. Zipping it by hand shipped all
 * of them once. This copies only what belongs in a shared copy into dist/connector-qa/, refuses
 * to continue if the config carries a machine path, and zips that.
 *
 * Excluded: node_modules, dist, runs, anything starting with `.` or `_` (scratch, previews,
 * _doc sources, _archive).
 */
import { readdirSync, statSync, readFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = new Set(['node_modules', 'dist', 'runs']);
const cfg = JSON.parse(readFileSync(join(REPO, 'config.json'), 'utf8'));
const NAME = 'connector-qa';
const DIST = join(REPO, 'dist');
const STAGE = join(DIST, NAME);
const ZIP = join(DIST, `${NAME}-${cfg.version}.zip`);

const die = m => { console.error(`\n  ✗ ${m}\n`); process.exit(1); };

/* A shared copy must not carry anyone's machine. install.ps1/sh fill these in per machine. */
if (cfg.root) die(`config.root is "${cfg.root}" — it must be empty in a shared copy`);
if (cfg.driver_source?.root) die(`config.driver_source.root is "${cfg.driver_source.root}" — it must be empty in a shared copy`);
const wp = cfg.defaults?.write_policy || {};
/* 3.7: write safety ships off (test accounts), so every recipient is asked at the start of each run
 * whether the workspace is a test one — that question must ship on */
if (wp.confirm_at_start === false) die('write_policy.confirm_at_start is false — ship it true, so a recipient is asked whether writes may go to their workspace');
if (wp.workspace) die(`write_policy.workspace is pinned to "${wp.workspace}" — that is your workspace, not theirs`);

const files = [];
const walk = dir => {
  for (const e of readdirSync(dir)) {
    if (EXCLUDE.has(e) || e.startsWith('.') || e.startsWith('_')) continue;
    const p = join(dir, e);
    /* an empty stray file (a root-level "=" from a mistyped command) is not part of the skill */
    if (!statSync(p).isDirectory() && statSync(p).size === 0) { console.log(`  skipped empty file ${relative(REPO, p)}`); continue; }
    if (statSync(p).isDirectory()) walk(p); else files.push(relative(REPO, p));
  }
};
walk(REPO);

rmSync(DIST, { recursive: true, force: true });
for (const f of files) {
  mkdirSync(dirname(join(STAGE, f)), { recursive: true });
  copyFileSync(join(REPO, f), join(STAGE, f));
}

/* bsdtar writes zip with -a: built into Windows 10+ (System32\tar.exe) and macOS. GNU tar
   (Linux, Git Bash) cannot, so use zip there. */
const winTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
try {
  if (process.platform === 'win32' && existsSync(winTar)) execFileSync(winTar, ['-a', '-c', '-f', ZIP, '-C', DIST, NAME]);
  else if (process.platform === 'darwin') execFileSync('tar', ['-a', '-c', '-f', ZIP, '-C', DIST, NAME]);
  else execFileSync('zip', ['-qr', ZIP, NAME], { cwd: DIST });
} catch (e) { die(`could not create the zip: ${e.message}`); }

const kb = Math.round(statSync(ZIP).size / 1024);
console.log(`\n  ✓ ${relative(REPO, ZIP)}  (${files.length} files, ${kb} KB)`);
console.log(`    unzip anywhere, e.g. ConnectAIMCPTest\\, then run install.ps1 (Windows) or bash install.sh\n`);
