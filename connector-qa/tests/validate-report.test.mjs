/* `validate-report.mjs` is the last gate before a report is handed to someone.
 *
 * It had no test, and `build-report.mjs` swallows its failure into a counter — so if it regressed
 * to always-pass, every report would still be stamped validated and nothing in the suite would
 * notice. A validator that cannot fail is worse than no validator: it converts "unchecked" into
 * "checked and fine".
 *
 * These assert it FAILS on the things it exists to catch, which is the half that matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const validate = file => {
  const r = spawnSync(process.execPath, [join(SK, 'scripts', 'validate-report.mjs'), file], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: String(r.stdout || '') + String(r.stderr || '') };
};
const write = (html, name = 'r.html') => {
  const f = join(mkdtempSync(join(tmpdir(), 'cqa-vr-')), name);
  writeFileSync(f, html, 'utf8');
  return f;
};

test('validate-report: a file that is not a generated report fails', () => {
  const { code, out } = validate(write('<html><body>hello</body></html>'));
  assert.notEqual(code, 0, 'plain HTML is not a report');
  assert.match(out, /script|report/i);
});

test('validate-report: a missing file is a usage error, not a pass', () => {
  const { code } = validate(join(tmpdir(), 'definitely-not-here-12345.html'));
  assert.equal(code, 2, 'a missing file must be exit 2, never 0');
});

test('validate-report: an unfilled template constant is caught', () => {
  /* The failure this exists for: build-report emits the template with a constant it never filled,
     and the report renders as blank sections rather than erroring. */
  const html = `<html><body><script>
const CONNECTOR = "Demo";
const GROUPS = /* FILL: see Part 1 — GROUPS */ [];
</script></body></html>`;
  const { code, out } = validate(write(html));
  assert.notEqual(code, 0, 'a FILL marker left in a shipped report must fail validation');
  assert.match(out, /FILL|unfilled/i);
});

/* The positive case — that a freshly built report validates — lives in report-render.test.mjs,
   which builds one from a fixture. The version here scavenged the temp directory for any report it
   could find, so it validated whatever an earlier run had left behind: it failed the moment a real
   bug was fixed, because the stale file still had it. A test that depends on leftovers is not a
   test. */
