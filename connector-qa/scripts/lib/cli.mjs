/**
 * cli.mjs — one argument parser, one connector resolver, one set of exit codes.
 *
 * The parser was copy-pasted verbatim into eleven scripts, with three further hand-rolled variants
 * and two scripts reading `process.argv[2]` raw: sixteen entry points, five conventions. The
 * divergence was load-bearing rather than cosmetic — the shared copy **silently accepted any
 * unknown flag**, so `--maxrounds 3` (documented in SKILL.md and README) parsed into `a.maxrounds`
 * and was ignored by every consumer, while `mine-dump` exited 2 on the same typo. A documented flag
 * that does nothing is indistinguishable from a broken feature.
 *
 * Connector-name derivation had six copies with three behaviours: four scripts took the directory
 * basename, two scanned for `*_knowledge.json`. Run `build-report --dir ./out` on a folder not
 * named after the connector and it silently derived the wrong name while `generate-tests` on the
 * same folder found the right one.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 0 success · 2 the caller invoked it wrong · 3 the data is wrong. */
export const EXIT = { OK: 0, USAGE: 2, DATA: 3 };

/** Report an operator-facing failure. An uncaught throw buries the message in a stack trace. */
export function die(message, code = EXIT.DATA) {
  console.error('\n✗ ' + message);
  process.exit(code);
}

/**
 * Parse `--flag value` and `--flag` (boolean). Keys keep their dashes: `--allow-thin` → `a['allow-thin']`.
 *
 * @param {string[]} argv     typically process.argv.slice(2)
 * @param {object}   spec
 * @param {string[]} spec.known     every flag this script accepts. An unknown one is an error —
 *                                  that is the whole point. Omit to accept anything (discouraged).
 * @param {string[]} spec.required  flags that must be present.
 * @param {string}   spec.usage     the usage line, printed on any failure.
 */
export function parseArgs(argv, { known = null, required = [], usage = '' } = {}) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (!v.startsWith('--')) { positional.push(v); continue; }
    const key = v.slice(2);
    const next = argv[i + 1];
    out[key] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
  }
  out._ = positional;

  if (known) {
    const unknown = Object.keys(out).filter(k => k !== '_' && !known.includes(k));
    if (unknown.length) {
      console.error(`unknown flag(s): ${unknown.map(k => '--' + k).join(', ')}`);
      if (usage) console.error(usage);
      console.error(`known flags: ${known.map(k => '--' + k).join(' ')}`);
      process.exit(EXIT.USAGE);
    }
  }
  const missing = required.filter(k => out[k] === undefined);
  if (missing.length) {
    console.error(`missing required flag(s): ${missing.map(k => '--' + k).join(', ')}`);
    if (usage) console.error(usage);
    process.exit(EXIT.USAGE);
  }
  return out;
}

/**
 * Decide which connector a directory holds.
 *
 * An explicit `--connector` is authoritative: if it names something that is not there, that is an
 * error, never a silent retarget onto whatever happens to be present. `tier-objects --connector
 * Salesforce` on a folder holding only `Demo_*.json` used to rewrite Demo's tiering and exit 0.
 *
 * @param {string}  dir       the connector folder
 * @param {?string} explicit  the --connector value, if the caller gave one
 * @param {string}  marker    the artifact whose presence identifies a connector
 */
export function resolveConnector(dir, explicit = null, marker = '_knowledge.json') {
  if (explicit) {
    if (!existsSync(join(dir, `${explicit}${marker}`)))
      die(`no ${marker.replace(/^_/, '')} for connector "${explicit}" in ${dir}`, EXIT.USAGE);
    return explicit;
  }
  let found = [];
  try { found = readdirSync(dir).filter(f => f.endsWith(marker)); } catch { /* dir may not exist */ }
  if (found.length === 1) return found[0].slice(0, -marker.length);
  if (found.length > 1)
    die(`${found.length} connectors in ${dir} (${found.map(f => f.slice(0, -marker.length)).join(', ')}) — pass --connector`, EXIT.USAGE);
  /* Nothing found: fall back to the directory name so the caller's own "missing artifact" error
   * names the file it expected, which is more useful than a generic complaint from here. */
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}
