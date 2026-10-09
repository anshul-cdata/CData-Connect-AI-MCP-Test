#!/usr/bin/env node
/**
 * read-driver-schema.mjs — Stage 0.5. What the driver ships, read before connecting to anything.
 *
 *   node read-driver-schema.mjs --connector <Name> [--out <file>] [--root <driver source>]
 *
 * This answers one question: **which objects must this run test?** On a connector where
 * `getTables()` returns 1,500 rows, roughly 130 of them are what CData documented and the rest are
 * a generated catalog. The driver's own authors already made that distinction — documented tables
 * sit at the root of the schema folder, generated ones in a subfolder under it — so the split is
 * read rather than guessed. Name shape cannot do this: on NetSuite it separates barely a fifth.
 *
 * Beyond object discovery, this stage also parses documented .rsd file CONTENTS to extract:
 *
 *   relationships[]   FK links declared in .rsd files (referencedby / lookup / ForeignKeyField
 *       attributes on columns). These seed the coverage model's relationship dimension before
 *       getTables() runs — a connector that hides FK metadata at runtime is still testable.
 *
 *   column_signals{}  Per-object: has_datetime, has_identifier, has_measure, ops (insert/update/
 *       delete/readonly). Stage 5 uses this to decide pattern applicability structurally rather
 *       than waiting for getColumns(). The per-column flags are NOT extracted — whether an agent
 *       can navigate required filters IS the measurement; handing the answer removes the finding.
 *
 *   implied_objects[] Objects referenced by FK in documented tables but not themselves in the
 *       documented set. Each is an EXPOSURE gap candidate: the FK is real, the object may not be
 *       reachable. Stage 6 emits the gap; Stage 2 researchers are told to look for it.
 *
 * Deliberately NOT read here, each for a reason:
 *
 *   per-column flags (IsRequired, filterable, urlparam)  Whether an agent can work out that a
 *       query needs a filter IS the measurement. Handing the pipeline the answer removes the
 *       finding — see 07-execution.md on why expected_sql is left unqualified.
 *   mcp-instructions.md   What the MCP surface serves is what matters; reading the file from disk
 *       describes a file, not the connector's behaviour.
 *   changelog.md   Useful for a human triaging a failure, but the deployed build is not readable
 *       from any system table, so it can decide nothing automatically.
 *
 * Read-only. Writes one artifact and prints a summary. Exit 0 ok, 2 usage, 3 data.
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, relative, dirname } from 'node:path';
import { parseArgs, die, EXIT } from './lib/cli.mjs';
import { loadConfig } from './lib/artifacts.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['connector', 'out', 'root'],
  required: ['connector'],
  usage: 'node read-driver-schema.mjs --connector <Name> [--out <file>] [--root <driver source>]',
});

const cfg = loadConfig();
/* Machine-specific, exactly like $ROOT: flag, then environment, then config. The shared copy of
 * config.json carries no path, so nobody ships their own filesystem inside it. */
const ROOT = a.root || process.env.CONNECTOR_QA_DRIVER_ROOT || (cfg.driver_source && cfg.driver_source.root) || '';
if (!ROOT) die('no driver source configured — pass --root, set CONNECTOR_QA_DRIVER_ROOT, or fill config.driver_source.root', EXIT.USAGE);
if (!existsSync(ROOT)) die(`driver source not found: ${ROOT}`);

/* ── locate the provider ─────────────────────────────────────────────────────── */

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const want = `provider${norm(a.connector)}`;
const dirs = readdirSync(ROOT).filter(d => { try { return statSync(join(ROOT, d)).isDirectory(); } catch { return false; } });
/* `ProviderX` and `ProviderXJ` are the .NET and Java builds of one connector and ship the same
 * object set; prefer the unsuffixed one so a run is not classified off the other edition. */
const providerName = dirs.find(d => norm(d) === want) || dirs.find(d => norm(d) === want + 'j');
if (!providerName) {
  const near = dirs.filter(d => norm(d).includes(norm(a.connector).slice(0, 6))).slice(0, 6);
  die(`no provider folder for "${a.connector}" under ${ROOT}` + (near.length ? `\n    did you mean: ${near.join(', ')}` : ''));
}
const PROV = join(ROOT, providerName);

/* ── collect ─────────────────────────────────────────────────────────────────── */

const schemaFiles = [], sourceFiles = [];
(function walk(dir) {
  let entries; try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    /* A provider's own test fixtures carry .rsd files too — Jira keeps one under tests/infoscripts
     * and Salesforce four under tests/. They are not shipped surface and must not enter a
     * denominator. */
    if (st.isDirectory()) { if (!/^tests?$/i.test(e)) walk(p); }
    else if (/\.(rsd|rsb)$/i.test(e)) schemaFiles.push(p);
    else if (/\.(cs|java)$/i.test(e)) sourceFiles.push(p);
  }
})(PROV);

const relOf = p => relative(PROV, p).replace(/\\/g, '/');
const isNoise = n => /^sys_/i.test(n) || /Internal$/.test(n);

/* ── curated vs generated, from the driver's own layout ──────────────────────── */

/* Where a schema folder holds files directly AND has subfolders holding more, the root files are
 * the documented set and the subfolder is a generated catalog — that is NetSuite's 127 against
 * 2,519. Where every file sits at one level, there is only one set, whatever its depth: Asana puts
 * all 33 at the root of infoscripts/, Jira puts all 82 under infoscripts/jiraschema/, and both are
 * entirely documented. Treating "in a subfolder" as generated marks all of Jira generated. */
/* Tables only. Procedures sit in the same folders and say nothing about how the table set is
 * organised — Jira keeps five .rsb (CreateSchema, three OAuth) directly in infoscripts/ while all
 * 96 of its tables live in jiraschema/ beneath it. Counting those five made infoscripts/ look like
 * NetSuite's documented root and marked every real Jira table generated. */
const byFolder = new Map();
for (const f of schemaFiles) {
  if (!/\.rsd$/i.test(f)) continue;
  const d = dirname(relOf(f));
  if (!byFolder.has(d)) byFolder.set(d, []);
  byFolder.get(d).push(f);
}
const topOf = d => d.split('/')[0];

/* Only a folder that has files at its own level AND subfolders beneath it is evidence of the
 * split — that shape says "these are the documented ones, those were generated". NetSuite's
 * infoscripts/ is exactly that: 127 beside SuiteQL/'s 1,241. Judging each folder in isolation
 * instead marks NetSuite's scripts/SuiteQL (1,283 files, no sibling root level) as documented and
 * inflates the floor tenfold. One authority decides for the provider; everything else mirrors it. */
const authority = [...new Set([...byFolder.keys()].map(topOf))]
  .find(top => byFolder.has(top) && [...byFolder.keys()].some(d => d !== top && topOf(d) === top));

const generatedFolders = new Set(
  authority ? [...byFolder.keys()].filter(d => d !== authority && topOf(d) === authority) : []);

/* With an authority present, a name is documented only if it appears at that authority's root —
 * its copy under a generated folder does not redeem it, and its copy in a mirroring aspect folder
 * (scripts/SuiteQL) must not either. */
const documentedNames = authority
  ? new Set((byFolder.get(authority) || []).map(f => basename(f).replace(/\.(rsd|rsb)$/i, '')))
  : null;
const isGenerated = f => authority
  ? !documentedNames.has(basename(f).replace(/\.(rsd|rsb)$/i, ''))
  : false;

/* ── the object and procedure sets ───────────────────────────────────────────── */

const tables = new Map(), procedures = new Map();
for (const f of schemaFiles) {
  const name = basename(f).replace(/\.(rsd|rsb)$/i, '');
  if (isNoise(name)) continue;
  const gen = isGenerated(f);
  if (/\.rsb$/i.test(f)) {
    if (/oauth/i.test(name)) continue;          // connection plumbing, never a business procedure
    if (!procedures.has(name)) procedures.set(name, { name, generated: gen });
    continue;
  }
  const prior = tables.get(name);
  /* A table listed both at the root and in a generated folder is documented. */
  if (prior && !(prior.generated && !gen)) continue;
  tables.set(name, { name, generated: gen, source: relOf(f) });
}

const all = [...tables.values()];
const documented = all.filter(t => !t.generated).map(t => t.name).sort();
const generated = all.filter(t => t.generated).map(t => t.name).sort();

/* ── class, from evidence rather than a list of connector names ──────────────── */

/* Read a bounded slice of the source: enough to see which discovery mechanism a driver uses,
 * without loading a 231-file tree into memory. */
/* Narrow on purpose. "custom field" matches Asana, which ships a documented CustomFields table and
 * generates nothing at runtime, and "CreateSchema" matches MongoDB, whose CreateSchema.rsb is an
 * inference helper. Both would be misread as runtime custom-object support. These four name a
 * mechanism for objects that exist in a tenant and not in the driver. */
const CUSTOM = /CustomObject|CUSTOMRECORD|customrecord|SavedSearch/;
const INFER  = /RowScanDepth|TypeDetectionScheme|InferSchema|BsonDataModel|FlattenArrays/i;
let customSignal = null, inferSignal = null;
for (const f of sourceFiles) {
  const n = basename(f);
  if (!customSignal && CUSTOM.test(n)) customSignal = relOf(f);
  if (!inferSignal && INFER.test(n)) inferSignal = relOf(f);
  if (customSignal && inferSignal) break;
}
if (!customSignal || !inferSignal) {
  for (const f of sourceFiles.slice(0, 400)) {
    let txt; try { txt = readFileSync(f, 'utf8'); } catch { continue; }
    if (!customSignal && CUSTOM.test(txt)) customSignal = relOf(f);
    if (!inferSignal && INFER.test(txt)) inferSignal = relOf(f);
    if (customSignal && inferSignal) break;
  }
}

const klass = documented.length === 0
  ? (inferSignal ? 'inferred' : 'user_defined')
  : (customSignal ? 'remote_catalog' : 'static');

const STRATEGY = {
  static:         'Every documented object is the test floor. There is nothing else to discover.',
  remote_catalog: 'Documented objects are the floor; custom objects arrive at runtime and are selected by business importance.',
  inferred:       'Nothing is documented — the driver infers schema by sampling. Objects can only be enumerated at runtime, and selection is entirely by importance.',
  user_defined:   'Nothing is documented — the surface is whatever configuration supplies. Objects can only be enumerated at runtime.',
};

/* ── parse documented .rsd contents for FK graph and column signals ──────────── */

/* Only scan documented objects. Generated objects number in the thousands on some connectors
 * (NetSuite: 2,519) — scanning them all would be expensive and they are not the test floor.
 * For implied_objects we check whether FK targets exist in the full set (documented + generated). */

const allObjectNames = new Set([...documented, ...generated]);

/* ── .rsd content parsing helpers ───────────────────────────────────────────── */

/* CData .rsd files come in several dialects depending on connector age and target runtime:
 *
 *   Dialect A (most common): <rsb:field name="X" xs:type="string" other:referencedby="Y" />
 *   Dialect B (older):       <attr name="X" type="String" lookup="Y"></attr>
 *   Dialect C (newer infoscripts): attributes spread across MULTIPLE lines
 *
 * The only robust approach is to normalize first: collapse every XML element to a single line
 * before applying regexes. This handles multi-line elements, any attribute order, and any
 * namespace prefix on FK attributes.
 *
 * Normalize step: replace any whitespace (including newlines) between a tag-open and its
 * closing '>' with a single space. Tags never contain '>' in attribute values in CData .rsd
 * files (values are object names, types, or booleans), so this is safe. */

/** Collapse multi-line XML elements to single-line for reliable attribute extraction. */
function normalizeTags(text) {
  /* Match from < (not comment/doctype) to the first > that closes it.
   * We do NOT use dotall on the outer match — instead we replace newlines inside tags only. */
  return text.replace(/<(?!!--)(?:[^>"']|"[^"]*"|'[^']*')*>/g, tag =>
    tag.replace(/\s+/g, ' '));
}

/* After normalization every element fits on one logical line. Attribute order no longer matters
 * because we extract each attribute independently, not in a paired capture. */

/* Matches any XML element that represents a field or a set/attr directive. */
const RE_ELEM = /<(?:[\w:]+:)?(?:field|attr|set|col)\b([^>]*)>/gi;

/* Extract a named attribute value from a normalized element's attribute string.
 * Handles: name="val", name='val'. Namespace-prefixed attrs (other:foo="val") also match. */
function getAttr(attrs, ...names) {
  for (const n of names) {
    /* Escape the name for use in a regex; allow any namespace prefix before it. */
    const re = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${n}\\s*=\\s*["']([^"']+)["']`, 'i');
    const m = re.exec(attrs);
    if (m) return m[1];
  }
  return null;
}

/** Extract FK targets from one .rsd file's text. Returns array of {from_col, to} objects. */
function extractFKs(text) {
  const fks = [];
  const norm = normalizeTags(text);
  let m;
  const re = new RegExp(RE_ELEM.source, 'gi');
  while ((m = re.exec(norm)) !== null) {
    const attrs = m[1];
    /* FK attribute names across dialects: referencedby, lookup, ForeignKeyField, references.
     * All may carry an arbitrary namespace prefix (other:, rsb:, xs:, etc.). */
    const target = getAttr(attrs, 'referencedby', 'lookup', 'ForeignKeyField', 'references');
    if (!target) continue;
    const colName = getAttr(attrs, 'name');
    fks.push({ from_col: colName || '(unknown)', to: target });
  }
  return fks;
}

/** Extract operation flags and column type signals from one .rsd file's text. */
function extractSignals(text) {
  const ops = { insert: false, update: false, delete: false, readonly: false };
  let has_datetime = false, has_identifier = false, has_measure = false;
  const norm = normalizeTags(text);
  let m;

  const re = new RegExp(RE_ELEM.source, 'gi');
  while ((m = re.exec(norm)) !== null) {
    const attrs = m[1];

    /* Operation flags. CData uses two styles:
     *   <rsb:set attr="SUPPORTSINSERT" value="TRUE" />   (attr+value, either order)
     *   <rsb:set attr="READONLY" value="TRUE" />         (same)
     * getAttr handles both attribute orders because it extracts each independently. */
    const attrName = (getAttr(attrs, 'attr', 'name') || '').toUpperCase();
    const attrVal  = (getAttr(attrs, 'value') || '').toUpperCase();
    if (attrVal === 'TRUE' || attrVal === 'YES' || attrVal === '1') {
      if (attrName === 'SUPPORTSINSERT') ops.insert = true;
      if (attrName === 'SUPPORTSUPDATE') ops.update = true;
      if (attrName === 'SUPPORTSDELETE') ops.delete = true;
      if (attrName === 'READONLY')       ops.readonly = true;
    }

    /* Column type signals from field elements. */
    const typ = (getAttr(attrs, 'xs:type', 'type', 'datatype') || '').toLowerCase();
    const isKey = /\bkey\s*=\s*["']true["']/i.test(attrs) || /\bprimarykey\s*=\s*["']true["']/i.test(attrs);
    if (isKey) has_identifier = true;
    if (/datetime|timestamp|date$/.test(typ)) has_datetime = true;
    if (/decimal|double|float|int|long|short|numeric|money|currency/.test(typ)) has_measure = true;
  }

  return { ops, has_datetime, has_identifier, has_measure };
}

/** Count how many XML elements RE_ELEM can find in a normalized text.
 * Zero elements in a non-trivial file is the dialect-detection signal. */
function countElements(norm) {
  let n = 0;
  const re = new RegExp(RE_ELEM.source, 'gi');
  while (re.exec(norm) !== null) n++;
  return n;
}

/* Scan only documented tables (the test floor). Bound to 500 files to handle connectors with
 * large documented sets without pathological runtimes. */
const relationships = [];
const column_signals = {};
const fkTargetsSeen = new Set();
const parse_warnings = [];   // files where regex found zero elements — possible new dialect

const EXCERPT_BYTES = 1500;  // enough to show the dialect without bloating the output
const MIN_FILE_BYTES = 200;  // below this the file is legitimately almost empty; not a warning

const docFiles = schemaFiles.filter(f => /\.rsd$/i.test(f) && !isGenerated(f)).slice(0, 500);
for (const f of docFiles) {
  const objName = basename(f).replace(/\.rsd$/i, '');
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }

  /* Dialect guard: if the file is non-trivial but normalization found zero elements, the file
   * uses a dialect the regex does not understand. Record an excerpt for the orchestrator to
   * parse with AI judgment rather than silently returning empty signals. */
  const norm = normalizeTags(text);
  if (text.length > MIN_FILE_BYTES && countElements(norm) === 0) {
    parse_warnings.push({
      object: objName,
      file: relOf(f),
      reason: 'zero_elements_after_normalize',
      excerpt: text.slice(0, EXCERPT_BYTES),
    });
    /* Still emit a default entry so the object is present in column_signals. */
    column_signals[objName] = { ops: { insert: false, update: false, delete: false, readonly: false },
                                has_datetime: false, has_identifier: false, has_measure: false };
    continue;
  }

  const sigs = extractSignals(text);
  column_signals[objName] = sigs;

  const fks = extractFKs(text);
  for (const { from_col, to } of fks) {
    fkTargetsSeen.add(to);
    relationships.push({ from: objName, from_col: from_col || '(unknown)', to, confidence: 'rsd_declared' });
  }
}

/* Implied objects: FK targets that are not in the known object set. */
const implied_objects = [...fkTargetsSeen]
  .filter(t => !allObjectNames.has(t))
  .sort();

/* ── emit ────────────────────────────────────────────────────────────────────── */

const out = {
  schema_version: '2.1.0',
  connector: a.connector,
  provider: providerName,
  read_at: new Date().toISOString(),
  driver_class: klass,
  strategy: STRATEGY[klass],
  evidence: {
    custom_object_support: customSignal,     // the file that shows custom objects are discovered
    schema_inference: inferSignal,           // the file that shows schema is sampled, not shipped
    generated_folders: [...generatedFolders].sort(),
  },
  counts: {
    documented: documented.length,
    generated: generated.length,
    procedures: procedures.size,
    relationships: relationships.length,
    implied_objects: implied_objects.length,
    parse_warnings: parse_warnings.length,
  },
  documented_objects: documented,
  generated_objects: generated,
  procedures: [...procedures.values()].map(p => p.name).sort(),
  /* New in v2.1.0 — FK graph and column signals extracted from .rsd file contents. */
  relationships,        // [{from, from_col, to, confidence:"rsd_declared"}]
  column_signals,       // {ObjectName: {ops:{insert,update,delete,readonly}, has_datetime, has_identifier, has_measure}}
  implied_objects,      // objects referenced by FK but absent from documented+generated set
  /* Non-empty when a documented .rsd file used a dialect the regex parser could not parse.
   * Each entry carries a file excerpt. The orchestrator applies AI judgment to extract
   * relationships and column signals from the excerpt and merges them in. */
  parse_warnings,       // [{object, file, reason:"zero_elements_after_normalize", excerpt}]
};
const outPath = a.out || join(process.cwd(), `${a.connector}_driver_schema.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`\ndriver schema · ${a.connector}  (${providerName})`);
console.log(`  class            ${klass}`);
console.log(`  documented       ${String(documented.length).padStart(5)}   ← the test floor`);
console.log(`  generated        ${String(generated.length).padStart(5)}${generated.length ? '   tiered, not dismissed' : ''}`);
console.log(`  procedures       ${String(procedures.size).padStart(5)}`);
console.log(`  relationships    ${String(relationships.length).padStart(5)}   ← from .rsd FK declarations`);
if (implied_objects.length) console.log(`  implied objects  ${String(implied_objects.length).padStart(5)}   ← FK targets not in schema: ${implied_objects.slice(0, 5).join(', ')}${implied_objects.length > 5 ? '…' : ''}`);
if (parse_warnings.length) console.log(`  ⚠ parse warnings ${String(parse_warnings.length).padStart(4)}   ← unknown dialect — orchestrator must apply AI fallback`);
if (customSignal) console.log(`  custom objects   ${customSignal}`);
if (inferSignal)  console.log(`  schema inference ${inferSignal}`);
console.log(`\n  ${STRATEGY[klass]}`);
console.log(`\n→ ${outPath}\n`);
process.exit(EXIT.OK);
