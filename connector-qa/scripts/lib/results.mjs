/* results.mjs — the permanent record of what every model did with every use case.
 *
 *   <root>/_results/<Connector>/<run_id>/manifest.json   what produced the run
 *   <root>/_results/<Connector>/<run_id>/results.jsonl   one line per use case × attempt
 *
 * Plans and checkpoints are working files and are deleted when a run finishes. This is not: it is
 * what an eval reads instead of re-running a model, and what a capability report is built from.
 * A stored run may stand in for a fresh one only when everything except the model is the same —
 * catalog version, connector build, the connector's usage instructions, the workspace. That is the
 * fingerprint; the model is deliberately left out of it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogHash } from './catalog.mjs';
import { bindingsHash } from './fixtures.mjs';

export const sha = s => createHash('sha1').update(String(s ?? '')).digest('hex');

/**
 * What a result depends on, other than the model. The MCP server's tool prefix is deliberately
 * not part of it: it differs per machine for the same server, and would make every run on another
 * machine look incomparable. The connector build and its instructions are what identify it.
 * @param {{catalog_version, catalog_hash, connector_build, instructions, workspace}} f
 */
export function fingerprint(f) {
  const parts = {
    catalog_version: f.catalog_version ?? null,
    catalog_hash: f.catalog_hash ?? null,
    connector_build: f.connector_build ?? null,
    instructions: f.instructions_hash ?? (f.instructions != null ? sha(f.instructions).slice(0, 8) : null),
    workspace: f.workspace ?? null,
  };
  /* 3.7.1: which records the fixtures were bound to is recorded, but compared per use case (each result
   * carries the records it used, lib/scope.mjs) — in the environment key, binding one area's data
   * would invalidate every other area's results */
  return { ...parts, ...(f.test_data ? { test_data: f.test_data } : {}), key: sha(JSON.stringify(parts)).slice(0, 12), env_key: envKeyOf(parts) };
}

/**
 * The environment a result was measured in — everything in the fingerprint except the catalog.
 * Since 3.1 results are reused per use case (each record carries its use case's hash), so the
 * catalog growing by an area does not make earlier results incomparable; a different connector
 * build, set of usage instructions or workspace still does. Computed from the parts, so manifests
 * written before 3.1 have one too.
 */
export function envKeyOf(f) {
  if (!f) return null;
  if (f.env_key) return f.env_key;
  return sha(JSON.stringify({ connector_build: f.connector_build ?? null, instructions: f.instructions ?? null, workspace: f.workspace ?? null })).slice(0, 12);
}

/** The fingerprint of a run about to happen, or just ingested: from the knowledge file and catalog. */
export function fingerprintFor(K, cat, testData = null) {
  const meta = (K && K.run_meta) || {};
  return fingerprint({
    test_data: bindingsHash(testData),
    catalog_version: cat?.version ?? null, catalog_hash: cat ? catalogHash(cat) : null,
    connector_build: meta.connector_build ?? null,
    instructions: K?.instructions_raw ?? null,
    workspace: typeof meta.workspace === 'object' ? meta.workspace?.id ?? null : meta.workspace ?? null,
  });
}

export const runDir = (root, connector, runId) => join(root, '_results', connector, runId);

export function writeRun(root, connector, runId, manifest, records) {
  const d = runDir(root, connector, runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ format: 'connector-qa-results/1', connector, run_id: runId, ...manifest }, null, 2));
  writeFileSync(join(d, 'results.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return d;
}

export function appendResult(root, connector, runId, record) {
  const d = runDir(root, connector, runId);
  mkdirSync(d, { recursive: true });
  appendFileSync(join(d, 'results.jsonl'), JSON.stringify(record) + '\n');
}

export function readRun(root, connector, runId) {
  const d = runDir(root, connector, runId);
  const mp = join(d, 'manifest.json'), rp = join(d, 'results.jsonl');
  if (!existsSync(mp)) return null;
  const manifest = JSON.parse(readFileSync(mp, 'utf8'));
  const records = existsSync(rp) ? readFileSync(rp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { manifest, records, dir: d };
}

export function listRuns(root, connector) {
  const d = join(root, '_results', connector);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(n => n !== 'evals' && existsSync(join(d, n, 'manifest.json')))
    .map(n => readRun(root, connector, n).manifest)
    /* newest first by when the run STARTED — re-ingesting an old run must not make it newest */
    .sort((a, b) => String(b.run_started_at || b.finished_at || '').localeCompare(String(a.run_started_at || a.finished_at || '')));
}

/** The newest stored run for `model` whose fingerprint matches, or null. */
export function findReusable(root, connector, fpKey, model) {
  return listRuns(root, connector).find(m => m.fingerprint?.key === fpKey && m.model === model && m.complete === true) || null;
}

/** Collapse attempts to one row per use case: the median-scoring attempt, with the spread. */
export function byUseCase(records) {
  const g = new Map();
  for (const r of records) {
    const k = r.use_case_id || r.tc_id;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return [...g.entries()].map(([k, rs]) => {
    /* 3.7.1: the outcome most attempts reached decides; among those, the median score. Unscored
     * outcomes (blocked, no data) vote too — five blocked attempts and one correct are not "correct". */
    const tally = rs.reduce((m, r) => m.set(r.outcome, (m.get(r.outcome) || 0) + 1), new Map());
    const top = [...tally.entries()].sort((x, y) => y[1] - x[1] || (rs.find(r => r.outcome === y[0] && Number.isFinite(r.score)) ? 1 : 0) - (rs.find(r => r.outcome === x[0] && Number.isFinite(r.score)) ? 1 : 0))[0][0];
    const pick = rs.filter(r => r.outcome === top);
    const scored = pick.filter(r => Number.isFinite(r.score)).sort((a, b) => a.score - b.score);
    const rep = scored.length ? scored[Math.floor((scored.length - 1) / 2)] : pick[0];
    const allScored = rs.filter(r => Number.isFinite(r.score)).sort((a, b) => a.score - b.score);
    const correct = rs.filter(r => r.outcome === 'correct').length;
    return { ...rep, id: k, attempts: rs.map(r => ({ n: r.attempt, score: r.score, outcome: r.outcome, variant: r.variant || 0,
      calls: r.metrics?.calls, failed: r.metrics?.failed, time_ms: r.metrics?.time_ms,
      failed_steps: (r.steps || []).filter(s => !s.ok).map(s => ({ n: s.n, class: s.error_class || null, cause: s.cause || null, recovered: !!s.recovered })) })),
      pass_rate: rs.length ? correct / rs.length : null,
      spread: allScored.length ? allScored[allScored.length - 1].score - allScored[0].score : null };
  });
}
