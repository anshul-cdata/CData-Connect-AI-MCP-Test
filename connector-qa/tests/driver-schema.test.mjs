/* Stage 0.5 — reading what the driver ships, and what that is allowed to change.
 *
 * The question this answers is "which objects must this run test": on a connector whose
 * getTables() returns thousands of rows, a few hundred are what CData documented and the rest are
 * a generated catalog. Getting that split wrong in either direction is expensive — too generous
 * and the floor is meaningless, too strict and documented surface goes untested — and each of the
 * four providers below broke an earlier version of the rule in a different way.
 *
 * Synthetic trees rather than the real enlistment: these assert the LOGIC, and they run on a
 * machine with no driver source at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SK = join(here, '..');
const READER = join(SK, 'scripts', 'read-driver-schema.mjs');
const TIER = join(SK, 'scripts', 'tier-objects.mjs');

/* Build a fake driver enlistment. `files` maps a path under Provider<Name>/ to its contents. */
function enlistment(provider, files) {
  const root = mkdtempSync(join(tmpdir(), 'cqa-drv-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, `Provider${provider}`, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}
const RSD = name => `<rsb:script xmlns:rsb="http://www.rssbus.com/ns/rsbscript/2">
  <rsb:info title="${name}" desc="${name} table."><attr name="Id" xs:type="string" key="true" /></rsb:info>
</rsb:script>`;

function read(root, connector) {
  const out = join(mkdtempSync(join(tmpdir(), 'cqa-out-')), 'ds.json');
  execFileSync(process.execPath, [READER, '--connector', connector, '--root', root, '--out', out],
    { encoding: 'utf8', stdio: 'pipe' });
  return JSON.parse(readFileSync(out, 'utf8'));
}

test('one level of tables: everything is documented', () => {
  const root = enlistment('Flat', { 'infoscripts/Alpha.rsd': RSD('Alpha'), 'infoscripts/Beta.rsd': RSD('Beta') });
  const d = read(root, 'Flat');
  assert.equal(d.counts.documented, 2);
  assert.equal(d.counts.generated, 0);
  assert.equal(d.driver_class, 'static');
});

test('tables at the root AND beneath it: the root is the documented set', () => {
  /* NetSuite's shape — 127 documented beside a generated catalog of 2,519. */
  const root = enlistment('Split', {
    'infoscripts/Account.rsd': RSD('Account'),
    'infoscripts/Generated/LookupA.rsd': RSD('LookupA'),
    'infoscripts/Generated/LookupB.rsd': RSD('LookupB'),
  });
  const d = read(root, 'Split');
  assert.equal(d.counts.documented, 1, 'only the root table is documented');
  assert.equal(d.counts.generated, 2);
  assert.deepEqual(d.documented_objects, ['Account']);
});

test('a mirroring aspect folder does not redeem a generated table', () => {
  /* NetSuite also keeps scripts/SuiteQL alongside infoscripts/SuiteQL. Judging each folder on its
   * own made scripts/SuiteQL — which has no sibling root level — look documented, and the floor
   * jumped from 127 to 1,407. */
  const root = enlistment('Mirror', {
    'infoscripts/Account.rsd': RSD('Account'),
    'infoscripts/Gen/Lookup.rsd': RSD('Lookup'),
    'scripts/Gen/Lookup.rsd': RSD('Lookup'),
    'scripts/Gen/Other.rsd': RSD('Other'),
  });
  const d = read(root, 'Mirror');
  assert.equal(d.counts.documented, 1);
  assert.ok(!d.documented_objects.includes('Lookup'), 'a generated table is not documented by its mirror copy');
});

test('procedures sitting at the root do not make it the authority', () => {
  /* Jira's shape: five .rsb (CreateSchema, OAuth) directly in infoscripts/ while all 96 tables
   * live in jiraschema/ below it. Counting those five marked every real Jira table generated. */
  const root = enlistment('ProcRoot', {
    'infoscripts/CreateSchema.rsb': '<rsb:script/>',
    'infoscripts/GetOAuthAccessToken.rsb': '<rsb:script/>',
    'infoscripts/schema/Issues.rsd': RSD('Issues'),
    'infoscripts/schema/Projects.rsd': RSD('Projects'),
  });
  const d = read(root, 'ProcRoot');
  assert.equal(d.counts.documented, 2, 'the tables are documented, not generated');
  assert.equal(d.counts.generated, 0);
});

test('a provider\'s own test fixtures are not shipped surface', () => {
  const root = enlistment('WithTests', {
    'infoscripts/Real.rsd': RSD('Real'),
    'tests/infoscripts/Fixture.rsd': RSD('Fixture'),
  });
  const d = read(root, 'WithTests');
  assert.deepEqual(d.documented_objects, ['Real']);
});

test('sys_ tables and *Internal helpers are excluded', () => {
  const root = enlistment('Noisy', {
    'infoscripts/Real.rsd': RSD('Real'),
    'infoscripts/sys_tables.rsd': RSD('sys_tables'),
    'infoscripts/RealInternal.rsd': RSD('RealInternal'),
  });
  assert.deepEqual(read(root, 'Noisy').documented_objects, ['Real']);
});

test('no documented tables plus an inference signal is the inferred class', () => {
  /* MongoDB, Snowflake, Elasticsearch — 264 of 586 providers document nothing at all, and for
   * those the source is the only statement of what objects will exist. */
  const root = enlistment('Guessy', {
    'scripts/sys_tables.rsd': RSD('sys_tables'),
    'src/TypeDetectionScheme.java': 'class TypeDetectionScheme { int RowScanDepth; }',
  });
  const d = read(root, 'Guessy');
  assert.equal(d.counts.documented, 0);
  assert.equal(d.driver_class, 'inferred');
  assert.ok(d.evidence.schema_inference, 'names the file that shows schema is sampled');
});

test('no documented tables and no inference signal is user-defined', () => {
  const root = enlistment('Byhand', { 'scripts/sys_tables.rsd': RSD('sys_tables') });
  assert.equal(read(root, 'Byhand').driver_class, 'user_defined');
});

test('documented tables plus custom-object support is remote-catalog', () => {
  const root = enlistment('Tenanted', {
    'infoscripts/Account.rsd': RSD('Account'),
    'src/GetCustomRecordInformation.java': 'class X { String s = "CUSTOMRECORD"; }',
  });
  const d = read(root, 'Tenanted');
  assert.equal(d.driver_class, 'remote_catalog');
  assert.ok(d.evidence.custom_object_support);
});

test('a documented CustomFields table is not mistaken for runtime custom objects', () => {
  /* Asana ships a documented CustomFields table and generates nothing at runtime. A looser signal
   * matching "custom field" or "CreateSchema" classified it remote_catalog and MongoDB too. */
  const root = enlistment('HasCustomFields', {
    'infoscripts/CustomFields.rsd': RSD('CustomFields'),
    'src/Select.java': 'void f(){ /* read the custom field values */ }',
  });
  assert.equal(read(root, 'HasCustomFields').driver_class, 'static');
});

/* ── the floor ───────────────────────────────────────────────────────────────── */

/* One object with no business signal at all, so the weights put it at the bottom. */
function tierDir(withDriverSchema) {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-tier-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Demo_knowledge.json'), JSON.stringify({
    schema_version: '2.0.0', connector: 'Demo', semantic_complete: true,
    run_meta: { run_id: 'r1', started_at: '2026-09-01T00:00:00Z', models: {} },
    connector_meta: { workflow_domains: [], personas: [], roles: [] },
    relationships: [],
    objects: [{ name: 'Forgotten', type: 'TABLE', tier: 'T4', category: 'lookup', columns_loaded: true,
                business_meaning: { v: 'x', confidence: 'FACT', source: 'vendor_docs' }, columns: [] }],
  }));
  if (withDriverSchema) writeFileSync(join(dir, 'Demo_driver_schema.json'), JSON.stringify({
    schema_version: '2.0.0', connector: 'Demo', driver_class: 'static',
    documented_objects: ['Forgotten'], generated_objects: [], procedures: [],
    counts: { documented: 1, generated: 0, procedures: 0 },
  }));
  return dir;
}
const tierOf = dir => {
  const out = execFileSync(process.execPath, [TIER, '--dir', dir], { encoding: 'utf8', stdio: 'pipe' });
  const m = out.match(/^(T[1-4])\s+1$/m);
  return m ? m[1] : null;
};

test('without Stage 0.5 the tiering is exactly what it always was', () => {
  /* The regression guard. A machine with no driver enlistment must produce an unchanged run. */
  assert.equal(tierOf(tierDir(false)), 'T4');
});

test('a documented object cannot fall below the floor', () => {
  assert.equal(tierOf(tierDir(true)), 'T2',
    'an object CData documented is guaranteed coverage depth even with no business signal');
});
