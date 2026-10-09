/**
 * artifacts.mjs — read/write the connector artifacts with schema-version checks.
 * A v1 knowledge.json read by a v3 skill must refuse loudly, never misroute silently.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = '2.0.0';
/* Read from config.json rather than duplicated here. This constant is stamped into every report
 * footer (build-report.mjs), so when it drifted from config.version every report published the
 * wrong skill version — exactly what run-meta.schema.json exists to prevent. */
export const SKILL_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', '..', 'config.json'), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

/* The minimum shape each artifact must have to be usable. A file can be valid JSON, carry no
 * schema_version, and still be the wrong thing entirely — an empty array, a truncated write, a
 * model that emitted the wrong structure. generate-tests then read zero objects from it, wrote an
 * empty plan, exited 0, and destroyed planned_tests on all 357 gaps. Valid JSON is not a contract. */
const SHAPE = {
  knowledge: d => Array.isArray(d.objects) || 'expected an "objects" array',
  coverage:  d => (d.objects && typeof d.objects === 'object') || 'expected an "objects" object',
  gaps:      d => Array.isArray(d.gaps) || 'expected a "gaps" array',
  plan:      d => Array.isArray(d.tc_list) || 'expected a "tc_list" array',
};

/** Throw unless the artifact has the shape its kind requires. */
export function assertShape(kind, data, path) {
  const check = SHAPE[kind];
  if (!check) return data;
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`${path} is not a ${kind} artifact — ${Array.isArray(data) ? 'it is an array' : 'it is ' + typeof data}. Nothing was written.`);
  const ok = check(data);
  if (ok !== true) throw new Error(`${path} does not look like a ${kind} artifact: ${ok}. Nothing was written.`);
  return data;
}

/* Exit codes, one convention for every script in this toolkit:
 *   0  success
 *   2  usage error — the caller passed the wrong flags
 *   3  data error — an artifact is missing, malformed, or fails a gate
 * An uncaught throw gives the operator a stack trace with the real message buried in it, so the
 * entry points call this instead. */
export const EXIT = { OK: 0, USAGE: 2, DATA: 3 };
export function fail(message, code = EXIT.DATA) {
  console.error('\n✗ ' + message);
  process.exit(code);
}

/** Read several artifacts, reporting a bad one as an operator message rather than a stack trace. */
export function readArtifacts(spec) {
  const out = {};
  for (const [name, { path, kind, required = true }] of Object.entries(spec)) {
    try { out[name] = readJson(path, { required, kind }); }
    catch (e) { fail(e.message); }
  }
  return out;
}

export function readJson(path, { required = true, kind = null } = {}) {
  if (!existsSync(path)) { if (required) throw new Error(`missing artifact: ${path}`); return null; }
  /* A bare JSON.parse reports "Unterminated string at position 400" and never names the file,
   * which on a five-artifact pipeline is a guessing game. readJsonl already does this properly. */
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`${path} is not valid JSON: ${e.message}`); }
  const v = data && data.schema_version;
  if (v && String(v).split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
    throw new Error(`schema_version ${v} in ${path} is incompatible with skill schema ${SCHEMA_VERSION}. ` +
                    `Archive the connector folder and run fresh.`);
  }
  if (kind) assertShape(kind, data, path);
  return data;
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const out = { schema_version: SCHEMA_VERSION, ...data, updated_at: new Date().toISOString() };
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); break; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 4) throw e;
      const until = Date.now() + 50 * (i + 1); while (Date.now() < until) { /* brief wait, then retry */ }
    }
  }
  return out;
}

/* appendJsonl was exported here and imported by nothing — Stage 9 appends through the
 * orchestrator and review-merge writes its own line. Removed rather than left as a claim that
 * something uses it. Restore it if a script ever needs it. */

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${path}:${i + 1} is not valid JSON`); }
  });
}

/** Resolve every artifact path for a connector from config.json — one source of truth. */
export function artifactPaths(config, root, connector) {
  const dir = join(root, connector);
  const a = config.artifacts;
  const p = k => join(dir, a[k].replace('{connector}', connector));
  return {
    dir,
    knowledge: p('knowledge'), coverage: p('coverage'), gaps: p('gaps'),
    plan: p('plan'), checkpoint: p('checkpoint'),
    checkpointJsonl: p('checkpoint').replace(/\.json$/, '.jsonl'),
    report: p('report'), gapReport: p('gap_report'),
    evidence: join(dir, 'customer_evidence.json'),
    runs: join(dir, 'runs'),
  };
}

export const nowIso = () => new Date().toISOString();
export const runId  = () => `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;

/** Load config.json from the skill folder that contains the calling script. */
/* Resolves from THIS module rather than from the caller. It used to require the caller to pass
 * import.meta.url — the kind of argument every caller gets right until one forgets, and a forgotten
 * one throws a TypeError from deep inside node:url rather than saying what is wrong. lib/ always
 * sits at scripts/lib/, so config.json is always one or two levels up from here. */
/* Every other failure in the toolkit prints a sentence and exits with a code. This one threw, so a
 * missing or malformed config.json was the single failure that reached the operator as a raw Node
 * stack trace — the shape people read as "the tool is broken" rather than "the install is
 * incomplete", which is the opposite of what it means. */
/**
 * The write policy in force (3.7). Connectors are tested on test accounts, so write safety is OFF by
 * default: writes run, including creates the connector cannot delete. `safe_mode: true` restores the
 * strict rules — irreversible writes held, a pinned workspace required. A run whose user answered
 * "read only this time" at the start (`write-policy.mjs confirm`) is in safe mode for that connector
 * folder until answered again.
 * @param {object} cfg   config.json
 * @param {string} [dir] the connector folder, for the user's start-of-run answer
 */
export function writePolicy(cfg, dir = null) {
  const p = cfg?.defaults?.write_policy || {};
  let choice = null;
  if (dir) { const f = join(dir, '_write_choice.json'); if (existsSync(f)) { try { choice = JSON.parse(readFileSync(f, 'utf8')); } catch { choice = null; } } }
  const safe = choice?.safe_mode === true || p.safe_mode === true;
  /* the user answered "read only" at the start: nothing that changes data runs, reversible or not */
  const readOnly = choice?.answer === 'readonly';
  return { ...p, safe_mode: safe, read_only: readOnly, choice,
    execute_reversible: readOnly ? false : p.execute_reversible !== false,
    execute_irreversible: safe ? false : p.execute_irreversible !== false,
    require_workspace_pin: safe ? true : p.require_workspace_pin === true,
    confirm_at_start: p.confirm_at_start !== false };
}

export function loadConfig(scriptUrl = import.meta.url) {
  const here = dirname(fileURLToPath(scriptUrl));
  for (const c of [join(here, '..', 'config.json'), join(here, '..', '..', 'config.json')]) {
    if (!existsSync(c)) continue;
    try { return JSON.parse(readFileSync(c, 'utf8')); }
    catch (e) { fail(`config.json at ${c} is not valid JSON: ${e.message}`); }
  }
  fail(`config.json not found next to the scripts folder (looked relative to ${here}).\n` +
       `    The skill is installed incompletely — re-run install.ps1 or install.sh.`);
}
