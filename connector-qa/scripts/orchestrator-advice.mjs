#!/usr/bin/env node
/**
 * orchestrator-advice.mjs — Step 0: which model should orchestrate this run? (3.9)
 *
 *   node orchestrator-advice.mjs --dir <connectorDir> [--model <session model>] [--areas a,b | --all] [--record]
 *
 * Reads what is on disk (knowledge file, capability list, assembled API list and its page inventory)
 * and suggests sonnet or opus, with the reason (lib/orchestrator.mjs; thresholds in
 * config.models.orchestrator_advice). With --model — the session's model, read with get_session,
 * never typed — it says whether the session is below the suggestion:
 *
 *   ADVISE   below the suggestion and the user has not been told for this pair: ask once, continue or switch
 *   OK       at or above it, or already told
 *
 * Advice never blocks: exit 0 either way (the hard gate is config.models.required_orchestrator).
 * --record stores {actual, suggested, type, reasons, below, at} as run_meta.orchestrator in the
 * knowledge file — or, before Stage 1 has written it, in _agent_out/orchestrator.json, carried into
 * run_meta by the next --record. Reports show it in their run details.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, loadConfig, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { resolveAreas } from './lib/scope.mjs';
import { orchestratorAdvice, belowSuggestion, familyOf, ADVICE_DEFAULTS } from './lib/orchestrator.mjs';
import { apiListState } from './lib/api-provenance.mjs';

const USAGE = 'usage: orchestrator-advice.mjs --dir <connectorDir> [--model <session model>] [--areas a,b | --all] [--record]';
const a = parseArgs(process.argv.slice(2), { known: ['dir', 'connector', 'model', 'areas', 'all', 'record'], usage: USAGE });
if (!a.dir) { console.error(USAGE); process.exit(EXIT.USAGE); }
const cfg = loadConfig();
const C = { ...ADVICE_DEFAULTS, ...(cfg.models?.orchestrator_advice || {}) };
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const opt = p => existsSync(p) ? readJson(p) : null;
const PENDING = join(a.dir, '_agent_out', 'orchestrator.json');

if (C.enabled === false) { console.log('ORCHESTRATOR — advice off (config.models.orchestrator_advice.enabled)'); process.exit(EXIT.OK); }

const knowledge = opt(P('knowledge')), capsDoc = opt(P('capabilities'));
let api = null;
try { const t = existsSync(P('api')) ? readFileSync(P('api'), 'utf8') : null; api = t && /x-assembled/.test(t) ? JSON.parse(t) : null; } catch { api = null; }
const inventory = opt(join(a.dir, '_agent_out', 'api-docs', 'inventory.json'));
let scopeAreas = null;
if (a.all) scopeAreas = (capsDoc?.areas || []).length || null;
else if (a.areas && a.areas !== true) scopeAreas = capsDoc ? resolveAreas(capsDoc, a.areas).ids.length : String(a.areas).split(',').filter(Boolean).length;

/* 3.9.2 — a list assembled without evidence is not a spec, whatever its shape */
const apiState = capsDoc || api ? apiListState(a.dir, conn, capsDoc, knowledge?.run_meta) : null;
const adv = orchestratorAdvice({ knowledge, capsDoc, api, inventory, scopeAreas, apiState }, C);
const TYPE = { spec: 'a source with a machine-readable API description', assembled: 'a source whose API list is assembled from its web docs',
  assembled_unverified: 'a source whose API list is assembled (unverified): built without evidence, to be rebuilt with api-from-docs.mjs',
  no_vendor_api: 'a source without a vendor business API (a database, files or a generic interface)', large_platform: 'a large platform (ERP or CRM scale: many tables, capabilities or business areas)', unknown: 'not known yet' };
console.log(`ORCHESTRATOR — ${conn}`);
console.log(`  suggested: ${adv.suggested || '—'} · ${TYPE[adv.type] || adv.type}`);
for (const r of adv.reasons) console.log(`    · ${r}`);
for (const j of adv.judgement.filter(j => !adv.reasons.some(r => r.includes(j)))) console.log(`    · judgement left on the orchestrator: ${j}`);
if (apiState?.status === 'unverified') console.log(`    · API list assembled (unverified): ${apiState.reasons[0]}${apiState.kept ? ' — kept knowingly' : ' — detect-stage routes to 1.5a'}`);

const prev = knowledge?.run_meta?.orchestrator || opt(PENDING);
if (a.model && a.model !== true) {
  const below = belowSuggestion(a.model, adv.suggested);
  const told = !!(prev?.told && prev.actual === a.model && prev.suggested === adv.suggested);
  console.log(`  session: ${a.model}${familyOf(a.model) ? ` (${familyOf(a.model)})` : ''}`);
  if (below && !told) {
    console.log(`\nADVISE  This connector looks like ${TYPE[adv.type] || adv.type}; ${adv.suggested[0].toUpperCase() + adv.suggested.slice(1)} is suggested as orchestrator (${adv.reasons[0]}); you are on ${familyOf(a.model) ? familyOf(a.model)[0].toUpperCase() + familyOf(a.model).slice(1) : a.model}. Continue or switch?`);
    console.log('  Ask the user once (AskUserQuestion); only the user can switch the session model. Then --record.');
  } else console.log(`\nOK  ${below ? 'already told the user for this model and suggestion' : 'the session model meets the suggestion'}`);
  if (a.record) {
    const rec = { actual: a.model, family: familyOf(a.model), suggested: adv.suggested, type: adv.type, reasons: adv.reasons, judgement: adv.judgement,
      below, told: below || !!prev?.told, at: new Date().toISOString() };
    if (knowledge) { knowledge.run_meta = { ...(knowledge.run_meta || {}), orchestrator: rec }; writeJson(P('knowledge'), knowledge); console.log(`  → run_meta.orchestrator in ${P('knowledge')}`); }
    else { writeJson(PENDING, rec); console.log(`  → ${PENDING} (moved into run_meta by the next --record, once Stage 1 has written the knowledge file)`); }
  }
} else if (a.record) { console.error('--record needs --model (the session model from get_session)'); process.exit(EXIT.USAGE); }
process.exit(EXIT.OK);
