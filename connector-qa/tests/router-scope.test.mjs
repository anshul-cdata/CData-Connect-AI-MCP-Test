/* asn-tr1: a fresh run scoped to one business area froze its catalog, and the router sent it straight
 * to Stage 8 — which failed, because the coverage model and gaps (Stages 5–7) did not exist yet. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { areaHash } from '../scripts/lib/catalog.mjs';

const SK = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = (dir, ...args) => JSON.parse(execFileSync(process.execPath, [join(SK, 'scripts', 'detect-stage.mjs'), '--dir', dir, '--connector', 'Demo', ...args], { encoding: 'utf8' }));

test('a scoped run with a frozen area goes through Stages 5, 6 and 7 before planning', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cqa-route-')), 'Demo');
  mkdirSync(dir, { recursive: true });
  const W = (f, o) => writeFileSync(join(dir, f), JSON.stringify(o));
  W('Demo_knowledge.json', { schema_version: '2.0.0', connector: 'Demo', semantic_complete: true, run_meta: { run_id: 'r1', mode: 'capability' }, objects: [] });
  W('Demo_capabilities.json', { capabilities: [{ id: 'CAP-a', label: 'Get tasks', mapping: { status: 'exposed', confidence: 'reviewed' }, review: { by: 'opus' } }],
    areas: [{ id: 'TR', name: 'Time tracking', capability_ids: ['CAP-a'], personas: ['Team Lead'] }] });
  const cat = { use_cases: [{ id: 'UC-DMO-0001', area: 'TR', persona: 'Team Lead', goal: 'g', kind: 'question', request: 'Who logged the most hours this week?',
    capabilities: ['CAP-a'], check: { rule: 'judge' }, status: 'approved' }], areas: {} };
  cat.areas.TR = { version: 1, frozen: true, hash: areaHash(cat, 'TR'), frozen_at: '2026-10-05T08:05:00Z' };
  W('Demo_catalog.json', cat);
  assert.equal(stage(dir, '--areas', 'TR').stage, 5, 'no coverage model: Stage 5, not 8');
  W('Demo_coverage.json', { schema_version: '2.0.0', connector: 'Demo' });
  assert.equal(stage(dir, '--areas', 'TR').stage, 6, 'no gaps: Stage 6');
  W('Demo_gaps.json', { gaps: [{ id: 'GAP-001' }] });
  assert.equal(stage(dir, '--areas', 'TR').stage, 7, 'gaps not prioritised: Stage 7');
  W('Demo_gaps.json', { gaps: [{ id: 'GAP-001' }], prioritized: true });
  assert.equal(stage(dir, '--areas', 'TR').stage, 8, 'then the plan');
});

/* 2026-10-05: the NetSuite run used an installed 2.1.0 while the source was at 3.4.2, and nothing said so. */
import { cpSync, readFileSync as rf } from 'node:fs';
test('check-version stops a run whose installed copy differs from its source', () => {
  const root = mkdtempSync(join(tmpdir(), 'cqa-ver-'));
  const inst = join(root, 'installed'), src = join(root, 'source');
  for (const d of [inst, src]) { mkdirSync(join(d, 'scripts'), { recursive: true }); cpSync(join(SK, 'scripts', 'check-version.mjs'), join(d, 'scripts', 'check-version.mjs')); }
  writeFileSync(join(src, 'config.json'), JSON.stringify({ version: '3.4.2' }));
  writeFileSync(join(inst, 'config.json'), JSON.stringify({ version: '2.1.0' }));
  const run = d => { try { return { code: 0, out: execFileSync(process.execPath, [join(d, 'scripts', 'check-version.mjs')], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: String(e.stderr) }; } };
  assert.equal(run(inst).code, 0, 'no install record: running from a source or a shared copy');
  writeFileSync(join(inst, 'install-info.json'), JSON.stringify({ source: src, version: '2.1.0' }));
  const stale = run(inst);
  assert.equal(stale.code, 3);
  assert.match(stale.out, /installed connector-qa 2\.1\.0, but the source .* is 3\.4\.2 \(newer\)/);
  assert.match(stale.out, /install/);
  writeFileSync(join(inst, 'config.json'), JSON.stringify({ version: '3.4.2' }));
  assert.equal(run(inst).code, 0, 'matching versions pass');
  writeFileSync(join(inst, 'install-info.json'), JSON.stringify({ source: join(root, 'gone'), version: '3.4.2' }));
  assert.equal(run(inst).code, 0, 'a source that is no longer on this machine is not an error');
  assert.ok(rf(join(SK, 'SKILL.md'), 'utf8').includes('check-version.mjs'), 'Step 0 runs the check');
});
