#!/usr/bin/env node
/**
 * enhance-steps.mjs — enrich checkpoint steps so the report template renders the full AI journey.
 *
 * DESIGN:
 *  - Set t:'d' ONLY for true schema-discovery tool calls (getTables, getColumns, etc.)
 *  - Set t:'p' for confirmed-successful actions
 *  - NEVER set t:'f' — the template classifies failure types from s.e / s.r text via ERR_KINDS
 *  - Move error text from s.r → s.e when s.r describes a failure (makes red step display work)
 *  - Fill s.q with real catalog-qualified SQL from observed.sql when steps lack it
 *
 * Usage as a module:  import { enhanceCheckpoint } from './enhance-steps.mjs';
 *                     enhanceCheckpoint(ck);   // mutates in place
 *
 * Usage as a CLI:     node enhance-steps.mjs --checkpoint <path>
 */
import { readFileSync, writeFileSync } from 'node:fs';

// True schema-discovery tool calls → always t:'d'
const DISCOVERY_TOOL_RE = /^(get[Tt]ables?\b|get[Cc]olumns?(\s+\w+|\()?|get[Pp]rocedures?\b|get[Ii]nstructions?\b|get[Ss]tarted?\b|get[Cc]atalogs?\b|get[Ss]chemas?\b)/i;

// Only treat as real SQL if it has the catalog qualifier [Connector].[Schema].
const HAS_CATALOG    = /\[\w+\]\.\[\w+\]\./i;
const REAL_SQL_START = /^\s*(SELECT\b|INSERT\s+INTO\b|UPDATE\s+\[|DELETE\s+FROM\s+\[|EXEC[UTE]*\s+\[|WITH\s+\[)/i;

function isRealSql(s) {
  if (!s) return false;
  const t = String(s).trim();
  return HAS_CATALOG.test(t) || (REAL_SQL_START.test(t) && t.length > 50);
}

// Patterns that indicate text in r describes a failure (move to e so template renders red)
const FAILURE_IN_R = [
  /\berror\b/i, /\bfailed?\b/i, /invalid column/i, /invalid table/i,
  /HTTP \[?4\d{3,}/i, /could not be (inserted|updated|deleted)/i,
  /not supported/i, /syntax error/i, /unknown column/i, /is not recognized/i,
  /not authoriz/i, /forbidden/i, /timed? ?out/i,
  /Views cannot be (inserted|updated|deleted)/i,
  /column could not be updated/i,
  /\breject[s]?\b.{0,40}(status|parent|workspace|permission)/i,
  /API rejects/i,
];

// Patterns that indicate text in r is a confirmed good result → mark t:'p'
const SUCCESS_IN_R = [
  /\d+\s*rows?\s*returned/i,
  /\d+\s*rows?[:\s]/i,
  /rows?\s*affected[:\s]*[1-9]/i,
  /\bok,\s*(Id|row|1\b)/i,
  /^ok$/i,                        // bare "ok" result
  /^Id[=:]\s*\d+/,
  /created\b.{0,40}\bId\b/i,
  /succeeded\b/i,
  /confirmed working/i,
  /PASS\b/,
  /no write attempted/i,          // deliberate skip — agent made the right call
  /not attempted/i,
  /declined? to (create|write|insert|update)/i,
];

function failsInR(r)   { return FAILURE_IN_R.some(re => re.test(String(r || ''))); }
function successInR(r) { return SUCCESS_IN_R.some(re => re.test(String(r || ''))); }

function discoveryLabel(a) {
  const s = String(a || '').trim();
  const m = s.match(/^(get[Tt]ables?|get[Cc]olumns?\s+\w+|get[Cc]olumns?|get[Pp]rocedures?|get[Ii]nstructions?|get[Ss]tarted?|get[Cc]atalogs?|get[Ss]chemas?)\b/i);
  if (!m) return null;
  const raw = m[0].trim();
  const base = raw.split(/\s+/)[0];
  const param = raw.includes(' ') ? raw.split(/\s+/).slice(1).join(' ') : '';
  return param ? `${base}(${param})` : `${base}()`;
}

function shortSqlLabel(sql) {
  const m = String(sql).match(/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|EXEC\w*|EXECUTE\w*)\s+(?:\[?\w+\]?\.?){0,4}/i);
  return m ? m[0].replace(/\[|\]/g, '').trim().slice(0, 60) : String(sql).slice(0, 50);
}

function splitSql(sql) {
  return String(sql)
    .split(/;\s*(?=\s*(SELECT|INSERT|UPDATE|DELETE|EXEC|WITH)\b)/i)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function processStep(s) {
  const step = { ...s };
  const a = String(step.a || '').trim();
  const r = String(step.r || '').trim();
  const e = String(step.e || '').trim();

  // 1. True schema-discovery tool call → t:'d'
  const dlabel = discoveryLabel(a);
  if (dlabel) {
    step.a = dlabel;
    step.t = 'd';
    return step;
  }

  // 2. Real SQL in q: ensure e/r are in the right field, set t:'p' on success
  if (step.q && isRealSql(step.q)) {
    if (!e && failsInR(r)) { step.e = r; step.r = ''; }
    else if (e || failsInR(r)) { /* has error → leave t unset → template classifies */ }
    else if (r && successInR(r)) { step.t = 'p'; }
    return step;
  }

  // 3. a contains real SQL → move to q, then classify
  if (!step.q && isRealSql(a)) {
    step.q = a;
    step.a = shortSqlLabel(a);
    if (!e && failsInR(r)) { step.e = r; step.r = ''; }
    else if (!e && !failsInR(r) && successInR(r)) { step.t = 'p'; }
    return step;
  }

  // 4. Abbreviated SQL in a (INSERT/UPDATE/DELETE/SELECT without catalog)
  if (/^(SELECT|INSERT|UPDATE|DELETE|EXEC)\b/i.test(a)) {
    if (!e && failsInR(r)) { step.e = r; step.r = ''; }
    else if (!e && successInR(r)) { step.t = 'p'; }
    return step;
  }

  // 5. Narrative step — NEVER set t:'f'; let ERR_KINDS + template fallback classify failures
  if (!e && failsInR(r)) {
    step.e = r;
    step.r = '';
    // leave t unset → template returns 'rejected' (or ERR_KINDS classification)
  } else if (!e && successInR(r)) {
    step.t = 'p';
  }
  return step;
}

function enhanceTc(tc) {
  const obs = tc.observed || {};
  const obsql = obs.sql && String(obs.sql).trim() !== 'null' ? String(obs.sql).trim() : '';
  const isPassed = ['pass', 'pass_query'].includes(tc.status || '');
  const isFailed = ['fail', 'partial', 'boundary'].includes(tc.status || '');

  const newSteps = (tc.steps || []).map(processStep);

  // Upgrade: replace abbreviated SQL in q with catalog-qualified SQL from observed.sql
  const hasCatalog = s => s.q && HAS_CATALOG.test(String(s.q));
  if (obsql && isRealSql(obsql)) {
    const stmts = splitSql(obsql).filter(isRealSql);
    for (const step of newSteps) {
      if (hasCatalog(step)) continue;
      const al = String(step.a || '').trim().toLowerCase();
      const match = stmts.find(stmt => {
        const sl = stmt.toLowerCase();
        if (al.startsWith('select') && sl.startsWith('select')) {
          const tbl = al.match(/(?:select\s+)(\w+)/i)?.[1]?.toLowerCase();
          return tbl && sl.includes(tbl);
        }
        if (al.startsWith('insert') && sl.startsWith('insert')) {
          const tbl = al.match(/insert\s+(?:into\s+)?(\w+)/i)?.[1]?.toLowerCase();
          return tbl && sl.includes(tbl);
        }
        if (al.startsWith('update') && sl.startsWith('update')) {
          const tbl = al.match(/update\s+(\w+)/i)?.[1]?.toLowerCase();
          return tbl && sl.includes(tbl);
        }
        if (al.startsWith('delete') && sl.startsWith('delete')) {
          const tbl = al.match(/delete\s+(?:from\s+)?(\w+)/i)?.[1]?.toLowerCase();
          return tbl && sl.includes(tbl);
        }
        return false;
      });
      if (match) {
        step.q = match;
        step.a = shortSqlLabel(match);
        const r = String(step.r || '').trim();
        const e = String(step.e || '').trim();
        if (!e && failsInR(r)) { step.e = r; step.r = ''; }
        else if (!e && !failsInR(r) && isPassed) { step.t = 'p'; }
        else if (!e && !failsInR(r) && successInR(r)) { step.t = 'p'; }
      }
    }
  }

  // Inject SQL steps from observed.sql when no real SQL at all in any step
  const hasRealSql = newSteps.some(s => s.q && isRealSql(s.q));
  if (obsql && isRealSql(obsql) && !hasRealSql) {
    const stmts = splitSql(obsql).filter(isRealSql);
    const errStep = isFailed ? newSteps.find(s => s.e || failsInR(s.r)) : null;
    for (const stmt of stmts) {
      if (newSteps.some(s => s.q === stmt)) continue;
      newSteps.push({
        ...(isPassed ? { t: 'p' } : {}),
        a: shortSqlLabel(stmt),
        q: stmt,
        r: '',
        ...(isFailed && errStep ? { e: errStep.e || errStep.r } : {}),
      });
    }
  }

  tc.steps = newSteps;
  return tc;
}

/**
 * Enhance all steps in a parsed checkpoint object, mutating in place.
 * Returns the number of TCs enhanced (for logging).
 */
export function enhanceCheckpoint(ck) {
  let enhanced = 0;
  for (const group of (ck.groups || [])) {
    for (let i = 0; i < (group.tcs || []).length; i++) {
      // Wipe all t values first so classification always starts fresh
      for (const s of (group.tcs[i].steps || [])) { delete s.t; }
      const before = JSON.stringify(group.tcs[i].steps || []);
      group.tcs[i] = enhanceTc(group.tcs[i]);
      if (JSON.stringify(group.tcs[i].steps || []) !== before) enhanced++;
    }
  }
  return enhanced;
}

// CLI mode: node enhance-steps.mjs --checkpoint <path>
if (process.argv[1] && process.argv[1].endsWith('enhance-steps.mjs')) {
  const args = process.argv.slice(2);
  const cpIdx = args.indexOf('--checkpoint');
  const cpPath = cpIdx >= 0 ? args[cpIdx + 1] : null;
  if (!cpPath) { console.error('usage: enhance-steps.mjs --checkpoint <path>'); process.exit(2); }

  const ck = JSON.parse(readFileSync(cpPath, 'utf8'));
  const total = (ck.groups || []).reduce((s, g) => s + (g.tcs || []).length, 0);
  const enhanced = enhanceCheckpoint(ck);
  const steps = (ck.groups || []).reduce((s, g) => s + (g.tcs || []).flatMap(t => t.steps || []).length, 0);
  writeFileSync(cpPath, JSON.stringify(ck, null, 2), 'utf8');
  console.log(`enhance-steps: ${total} TCs processed, ${enhanced} enhanced, ${steps} steps total`);
}
