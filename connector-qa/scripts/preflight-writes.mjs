#!/usr/bin/env node
/**
 * preflight-writes.mjs — the gate Stage 9 must pass before it dispatches a mutating test.
 *
 *   node preflight-writes.mjs --dir "<run dir>" [--connector <Name>]
 *
 * Exit 0 = safe to dispatch. Exit 3 = refused, nothing was run. Exit 2 = bad usage.
 *
 * Why this exists
 * ---------------
 * A mutating test says *what* to change and never says *where*. The Asana plan carried 61 tests
 * with `mutates: true`, 47 of them irreversible, and not one named a workspace id — 47 said the
 * word "workspace" in prose and left the choice to the agent under test. That catalog reaches
 * four workspaces, one of which is a real organization. An agent picking the first workspace it
 * finds would have written 47 undeletable records into it, and the run would have reported a
 * clean pass, because nothing in the pipeline was measuring where the writes landed.
 *
 * `write_policy.write_workspace` held the sentence "test environment — confirmed by the operator;
 * residue is acceptable there". That is a note to a human. It constrains no query and no prompt,
 * and a policy that cannot be evaluated is not a policy.
 *
 * The rule: if the plan will execute anything that mutates, the run must name the workspace, that
 * workspace must be one discovery actually saw, and it must not be an organization. Prose is not
 * a pin, and an unverifiable pin is refused rather than trusted.
 *
 * Strict mode is opt-in (2.2.0)
 * -----------------------------
 * Connectors are tested against test accounts, where every workspace is disposable and a pin is
 * ceremony. So the pin gate runs only when asked for — `write_policy.require_workspace_pin: true`,
 * `run_meta.require_workspace_pin: true` for one run, or `--strict`. Without it this script still
 * refuses a write that is not flagged as one (that check protects the held-back logic, not the
 * workspace), still lists what will be written, and passes. A `workspace` that is set is still
 * handed to the agent under test as operating context by generate-tests.mjs.
 */

import { readJson, loadConfig, writePolicy } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector, die, EXIT } from './lib/cli.mjs';
import { cleanupProblems } from './lib/checks.mjs';
import { join } from 'node:path';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'plan', 'knowledge', 'strict'],
  required: ['dir'],
  usage: 'node preflight-writes.mjs --dir "<run dir>" [--connector <Name>] [--strict]',
});

const cfg = loadConfig();
const connector = resolveConnector(a.dir, a.connector);
const plan = readJson(a.plan || join(a.dir, `${connector}_plan.json`));
const know = readJson(a.knowledge || join(a.dir, `${connector}_knowledge.json`), { required: false }) || {};

const policy = writePolicy(cfg, a.dir);
const meta = know.run_meta || {};

/* ── what the plan will actually do ─────────────────────────────────────────── */

const tcs = plan.tc_list || [];
/* `executable: false` means the plan already held it back — those never reach the connector, so
 * they place nothing at risk and must not force a pin that the run does not need. */
const willMutate = tcs.filter(t => t.mutates === true && t.executable !== false);
const irreversible = willMutate.filter(t => t.reversible === false);

console.log(`\npreflight-writes · ${connector}`);
console.log(`  ${tcs.length} test(s) planned · ${willMutate.length} will mutate · ${irreversible.length} irreversibly`);

/* ── a write that forgot to say it was one ──────────────────────────────────── */

/* Everything below keys on `mutates`, which makes that flag the only thing standing between an
 * unscoped write and a production workspace. One test reached this gate reading "Change something
 * small on one Allocations record" with `mutates` undefined — invisible here, and it would have
 * been dispatched with the read-only tests.
 *
 * Two signals, both deliberately narrow, because a gate that cries wolf is a gate people route
 * around: a write verb in `expected_sql`, or a sentence that *opens* with an imperative write
 * verb. "Tell me whether a rule can be created" does not match; "Change something small" does. */
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i;
const WRITE_OPENER = /(^|[.?!]\s+)(?:please\s+|now\s+|then\s+|first\s+)?(create|add|update|change|delete|remove|set|assign|archive|rename|move|duplicate|insert)\s+(?!me\b|up\b)/i;
const unflagged = tcs.filter(t => t.mutates !== true && t.executable !== false
  && (WRITE_SQL.test(t.expected_sql || '') || WRITE_OPENER.test(t.prompt || '')));

if (unflagged.length) {
  die(`REFUSED — ${unflagged.length} test(s) instruct a write but are not flagged \`mutates: true\`.\n` +
      `    Everything this gate does keys on that flag, so these would be dispatched as if read-only\n` +
      `    and no workspace would be enforced on them:\n\n` +
      unflagged.slice(0, 8).map(t => `      ${t.id}  ${String(t.prompt || t.expected_sql || '').replace(/\s+/g, ' ').slice(0, 88)}`).join('\n') +
      (unflagged.length > 8 ? `\n      … and ${unflagged.length - 8} more` : '') +
      `\n\n    Set \`mutates\` (and \`reversible\`) on them, or reword the prompt if it does not write.\n` +
      `    Nothing was dispatched.`);
}

if (!willMutate.length) {
  console.log(`\n  ✓ nothing in this plan writes — no workspace pin required\n`);
  process.exit(EXIT.OK);
}

/* ── the cleanup that will run after each attempt ───────────────────────────── */

/* A catalog use case undoes its own change with `check.cleanup_sql`, run unattended after every
 * attempt of every model. Whoever approves the writes approves these too, so they are printed in
 * full, and one that could touch more than the use case's own records stops the run. */
const cleanups = willMutate.filter(t => t.check?.cleanup_sql);
/* 3.7: a delete procedure, run through executeProcedure once per located record */
const procCleanups = willMutate.filter(t => t.check?.cleanup_procedure?.name);
if (procCleanups.length) {
  console.log(`  cleanup by procedure after each attempt (${procCleanups.length}):`);
  for (const t of procCleanups) console.log(`    ${t.id}${t.use_case_id ? ' ' + t.use_case_id : ''}  ${t.check.cleanup_procedure.name}(${JSON.stringify(t.check.cleanup_procedure.parameters || {})})`);
}
if (cleanups.length) {
  console.log(`  cleanup after each attempt (${cleanups.length}):`);
  const bad = [];
  for (const t of cleanups) {
    console.log(`    ${t.id}${t.use_case_id ? ' ' + t.use_case_id : ''}  ${String(t.check.cleanup_sql).replace(/\s+/g, ' ')}`);
    const p = cleanupProblems(t.check.cleanup_sql, t.target_objects || []);
    if (/\{\{located\}\}/.test(t.check.cleanup_sql) && !t.check.locate_sql) p.push('uses {{located}} with no locate_sql');
    if (p.length) bad.push(`${t.id}: ${p.join('; ')}`);
  }
  if (bad.length) die(`REFUSED — ${bad.length} cleanup statement(s) could change more than the test's own records:\n      ${bad.join('\n      ')}\n\n    Fix them in the catalog and freeze it again. Nothing was dispatched.`);
}

/* ── strict or not ──────────────────────────────────────────────────────────── */

const strict = a.strict === true || a.strict === 'true'
  || (meta.require_workspace_pin ?? policy.require_workspace_pin) === true;

if (!strict) {
  /* run_meta.workspace is {id, name, source} since Stage 1.0a; older runs stored the id alone */
  const ws = meta.workspace ?? policy.workspace ?? '';
  const pinned = (typeof ws === 'object' ? [ws.id, ws.name && `"${ws.name}"`].filter(Boolean).join(' ') : String(ws)).trim();
  const objects = [...new Set(willMutate.flatMap(t => t.target_objects || []))];
  console.log(`  workspace pin not required (write_policy.require_workspace_pin is off)`);
  console.log(`  writes will touch: ${objects.slice(0, 10).join(', ')}${objects.length > 10 ? ' …' : ''}`);
  console.log(pinned
    ? `  workspace ${pinned} is set and is passed to the agent as operating context`
    : `  no workspace set — the agent works wherever the connection points`);
  if (irreversible.length)
    console.log(`  ⚠ ${irreversible.length} irreversible write(s) will leave records the connector cannot delete`);
  console.log(`\n  ✓ proceeding — set require_workspace_pin: true (or pass --strict) for the pinned-workspace gate\n`);
  process.exit(EXIT.OK);
}

/* ── the pin ────────────────────────────────────────────────────────────────── */

/* Two places may carry it. `run_meta.workspace` is this run's decision and wins; the config key is
 * the standing default for the connector. An id is a string of digits — the prose sentence that
 * used to live in `write_workspace` is explicitly not one. */
/* run_meta.workspace is {id, name, source} since Stage 1.0a; older runs stored the id alone */
const wsPin = meta.workspace ?? policy.workspace ?? '';
const pin = String(typeof wsPin === 'object' ? wsPin?.id ?? '' : wsPin).trim();
const source = meta.workspace ? 'knowledge.run_meta.workspace' : policy.workspace ? 'config.defaults.write_policy.workspace' : null;

/* an id is one token — digits for some sources, letters and digits for others; prose is not one */
if (!pin || !/^[A-Za-z0-9_.:-]{3,}$/.test(pin)) {
  const prose = policy.write_workspace ? `\n    write_policy.write_workspace says: "${String(policy.write_workspace).slice(0, 90)}"\n    That is a note, not a target. It names no workspace and constrains no query.` : '';
  /* A refusal that does not say what a valid answer looks like just moves the work. Where
   * discovery captured the catalog, print the candidates and mark the ones that are off-limits. */
  const seen = meta.workspace_catalog || know.workspace_catalog || null;
  const options = Array.isArray(seen) && seen.length
    ? '\n\n    Reachable workspaces:\n' + seen.map(w => {
        const org = (w.is_organization ?? w.IsOrganization) === true;
        return `      ${org ? '✗' : '·'} ${w.id ?? w.Id}  ${w.name ?? w.Name}${org ? '   [ORGANIZATION — not a write target]' : ''}`;
      }).join('\n')
    : '';
  die(`REFUSED — ${willMutate.length} mutating test(s) (${irreversible.length} irreversible) and no workspace pinned.${prose}${options}\n\n` +
      `    Set the workspace id in one of:\n` +
      `      knowledge.run_meta.workspace                  (this run)\n` +
      `      config.defaults.write_policy.workspace        (every run of this connector)\n\n` +
      `    Nothing was dispatched.`);
}

/* ── is the pin a real, non-organization workspace? ──────────────────────────── */

/* Discovery records what it saw so this can be checked rather than assumed. Without the catalog
 * the pin is a number nobody verified — which is the same position as having no pin at all, so it
 * refuses. Capturing the catalog is one read-only query; trusting an unverified id is permanent. */
const catalog = meta.workspace_catalog || know.workspace_catalog || null;
if (!Array.isArray(catalog) || !catalog.length) {
  die(`REFUSED — workspace ${pin} is pinned (${source}) but no workspace catalog was captured, so\n` +
      `    nothing can confirm it exists or that it is not a production organization.\n\n` +
      `    Record what discovery saw at knowledge.run_meta.workspace_catalog as\n` +
      `      [{ "id": "...", "name": "...", "is_organization": true|false }, …]\n\n` +
      `    Nothing was dispatched.`);
}

const norm = w => ({
  id: String(w.id ?? w.Id ?? w.gid ?? '').trim(),
  name: String(w.name ?? w.Name ?? '(unnamed)'),
  org: (w.is_organization ?? w.IsOrganization ?? w.isOrganization) === true,
});
const rows = catalog.map(norm);
const hit = rows.find(w => w.id === pin);

console.log(`  workspace catalog: ${rows.length} reachable`);
for (const w of rows) console.log(`    ${w.id === pin ? '→' : ' '} ${w.id}  ${w.name}${w.org ? '   [ORGANIZATION]' : ''}`);

if (!hit) {
  die(`\nREFUSED — pinned workspace ${pin} (${source}) is not among the ${rows.length} workspaces this\n` +
      `    catalog reaches. A typo here writes into whichever workspace the agent picks instead.\n\n` +
      `    Nothing was dispatched.`);
}

if (hit.org) {
  die(`\nREFUSED — ${pin} "${hit.name}" is a production organization (IsOrganization: true), and this\n` +
      `    plan would write ${irreversible.length} record(s) into it that the connector exposes no way to delete.\n` +
      `    Test residue does not belong in an organization workspace. Pin a test workspace instead.\n\n` +
      `    Nothing was dispatched.`);
}

/* ── the prompts must carry the pin, or the agent still chooses ──────────────── */

/* The gate above proves the operator named a safe workspace. It does not prove the agent will use
 * it: a prompt that says "create a task" and never says where sends the agent hunting. Every
 * mutating prompt has to carry the id, and a warning here is the difference between a policy that
 * holds and one that is merely recorded.
 *
 * Since 2.2.0 the id travels in `agent_context`, the operating note Stage 9 hands the agent beside
 * the question — a business user's question never contains a workspace id, so putting it there
 * made every write test read like a test. Either place counts. */
const carries = t => [t.prompt, t.expected_sql, t.agent_context].some(s => String(s || '').includes(pin));
const silent = willMutate.filter(t => !carries(t));
if (silent.length) {
  die(`\nREFUSED — ${silent.length} of ${willMutate.length} mutating test(s) do not name workspace ${pin} in their\n` +
      `    prompt, SQL or agent_context, so the agent under test would choose a workspace itself.\n` +
      `    First few: ${silent.slice(0, 6).map(t => t.id).join(', ')}${silent.length > 6 ? ' …' : ''}\n\n` +
      `    Re-run generation with the workspace pinned, or inject it into those prompts.\n` +
      `    Nothing was dispatched.`);
}

console.log(`\n  ✓ ${willMutate.length} mutating test(s) target ${pin} "${hit.name}" — not an organization`);
console.log(`  ✓ every mutating test carries it`);
if (irreversible.length) {
  console.log(`  ⚠ ${irreversible.length} are irreversible: this run will leave records in "${hit.name}" that`);
  console.log(`    the connector cannot delete. write_policy.execute_irreversible is ${policy.execute_irreversible === true}.`);
}
console.log('');
process.exit(EXIT.OK);
