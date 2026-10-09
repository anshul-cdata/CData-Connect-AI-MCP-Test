#!/usr/bin/env node
/**
 * finish-run.mjs — Stage 12 clean-up, done right.
 *
 *   node finish-run.mjs --dir <connector folder>
 *
 * 1. Stamps knowledge.json with run_state:"complete" + completed_at, so detect-stage.mjs
 *    routes the NEXT invocation to Stage 1 instead of Stage 8 (review C1).
 * 2. Archives knowledge / coverage / gaps / plan / checkpoint / both reports to
 *    runs/<run_id>/ so history accumulates instead of being overwritten.
 * 3. Deletes whatever `config.delete_after_report` names (default: checkpoint only — the plan is
 *    retained so the test cases outlive the run and a compaction cannot lose them).
 * 4. Leaves knowledge / coverage / gaps in place, marked complete — still useful to a human,
 *    no longer misread by the router.
 */
import { existsSync, mkdirSync, copyFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, nowIso, loadConfig } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector'],
  usage: 'usage: finish-run.mjs --dir <connector folder>',
});
if (!a.dir) { console.error('usage: finish-run.mjs --dir <connector folder>'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const connector = resolveConnector(a.dir, a.connector);
const p = k => join(a.dir, cfg.artifacts[k].replace('{connector}', connector));

const K = readJson(p('knowledge'));
const runId = (K.run_meta && K.run_meta.run_id) || `run_${nowIso().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const archive = join(a.dir, 'runs', runId);
mkdirSync(archive, { recursive: true });

K.run_state = 'complete';
K.completed_at = nowIso();
K.run_meta = { ...(K.run_meta || {}), run_id: runId, finished_at: K.completed_at };
writeJson(p('knowledge'), K);

const files = [p('knowledge'), p('coverage'), p('gaps'), p('plan'), p('checkpoint'), p('checkpoint').replace(/\.json$/, '.jsonl'),
               p('report'), p('gap_report'), join(a.dir, 'customer_evidence.json'), p('coverage').replace(/\.json$/, '.stage10-summary.json'),
               /* capability mode: copied for history; the catalog and capability list stay in place for the next run */
               ...['capabilities', 'catalog', 'capability_report'].filter(k => cfg.artifacts?.[k]).map(p)];
let archived = 0;
for (const f of files) if (existsSync(f)) { copyFileSync(f, join(archive, f.split(/[\\/]/).pop())); archived++; }

for (const k of cfg.delete_after_report || ['plan', 'checkpoint']) {
  for (const f of [p(k), p(k).replace(/\.json$/, '.jsonl')]) if (existsSync(f)) unlinkSync(f);
}
const s10 = p('coverage').replace(/\.json$/, '.stage10-summary.json'); if (existsSync(s10)) unlinkSync(s10);

console.log(`run ${runId} complete · archived ${archived} file(s) → ${archive}\nknowledge.json marked run_state:complete — next invocation starts at Stage 1 (or pass --resume)`);
