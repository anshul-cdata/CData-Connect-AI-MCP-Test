#!/usr/bin/env node
/**
 * score-gaps.mjs — Stage 7. The priority formula from 05-gap-analysis §7.1, as code.
 *
 *   node score-gaps.mjs --gaps gaps.json --knowledge K.json
 *
 * Six-term sum, four bands. Refuses to score a gap whose business_importance the model has
 * not yet filled (prints them instead), so an unscored gap can never silently become P4.
 *
 * No-dump floor (review H6): without customer evidence nothing can be STRONG, which would push
 * every T1 gap on a no-dump connector to P3 — exactly the connectors where inference runs
 * unchecked. So for T1 gaps with no evidence available, evidence_weight floors at MEDIUM.
 */
import { readJson, writeJson } from './lib/artifacts.mjs';
import { bandOf } from './lib/sql-patterns.mjs';
import { parseArgs } from './lib/cli.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['gaps', 'knowledge'],
  usage: 'usage: score-gaps.mjs --gaps gaps.json --knowledge K.json',
});
if (!a.gaps || !a.knowledge) { console.error('usage: score-gaps.mjs --gaps gaps.json --knowledge K.json'); process.exit(2); }

const G = readJson(a.gaps);
const K = readJson(a.knowledge);
const hasEvidence = !!(K.customer_evidence && K.customer_evidence.available);

const TIER = { T1: 4, T2: 3, T3: 2, T4: 1 };
const IMP  = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const EVI  = { STRONG: 3, MEDIUM: 2, WEAK: 1 };
const WRITE_PATTERNS = new Set(['insert', 'update', 'delete']);

const unscored = [];
let scored = 0;
for (const g of G.gaps || []) {
  if (!g.business_importance || !IMP[g.business_importance]) { unscored.push(g.id); continue; }

  let evi = EVI[g.evidence_strength] || 1;
  if (!hasEvidence && g.tier === 'T1' && evi < 2) evi = 2;                 // H6 floor

  let risk = 0;
  if (g.known_production_failure) risk += 2;
  if ((g.impacted?.patterns || []).some(p => WRITE_PATTERNS.has(p)) || g.behavior === 'permission_boundary') risk += 1;
  if (g.category === 'EXPOSURE' && g.on_standard_report) risk += 2;        // a shipped vendor report nobody can run through
                                                                            // the connector is a production failure by another name
  if ((g.impacted.patterns || []).some(p => bandOf(p) === 1)) risk += 1;   // Band 1 can never be waived

  const dep  = g.blocks || g.category === 'RELATIONSHIP' ? 1 : 0;
  const cost = g.cost_high ? 1 : 0;

  const score = (TIER[g.tier] || 2) + IMP[g.business_importance] + evi + risk + dep - cost;
  g.priority_score = score;
  g.priority = score >= 11 ? 'P1' : score >= 8 ? 'P2' : score >= 5 ? 'P3' : 'P4';
  g.score_terms = { tier: TIER[g.tier] || 2, importance: IMP[g.business_importance], evidence: evi, risk, dependency: dep, cost: -cost, floor_applied: !hasEvidence && g.tier === 'T1' && (EVI[g.evidence_strength] || 1) < 2 };
  delete g.needs_model;
  scored++;
}

G.prioritized = unscored.length === 0;
writeJson(a.gaps, G);

const dist = (G.gaps || []).reduce((m, g) => (g.priority && (m[g.priority] = (m[g.priority] || 0) + 1), m), {});
console.log(`\nPRIORITIZATION — ${scored} scored${hasEvidence ? '' : ' · no-dump floor applied to T1 gaps'}`);
console.log(`  P1 ${dist.P1 || 0} · P2 ${dist.P2 || 0} · P3 ${dist.P3 || 0} · P4 ${dist.P4 || 0}`);
if (unscored.length) {
  console.log(`\n✗ ${unscored.length} gap(s) still need business_importance before the plan can be built:`);
  console.log('  ' + unscored.join(' '));
  console.log('  prioritized stays FALSE until every gap is scored.');
  process.exit(1);
}
console.log(`\n✓ prioritized: true → ${a.gaps}`);
