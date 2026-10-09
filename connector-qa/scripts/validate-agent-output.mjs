#!/usr/bin/env node
/**
 * validate-agent-output.mjs — check a research agent's JSON before it enters the model.
 *
 *   node validate-agent-output.mjs --agent domain|persona|role --file output.json
 *   echo '<json>' | node validate-agent-output.mjs --agent domain
 *
 * Review H5: the three research agents returned JSON that was trusted as-is. A hallucinated
 * domain with 40 workflows, or a role matrix with unknown domain ids, would enter the coverage
 * denominator silently. This validator rejects malformed output so the orchestrator re-asks.
 *
 * Exit 0 valid · 1 invalid (problems listed) · 2 usage.
 */
/* 2.2.0 — shape is not enough. asn005's role matrix was perfectly well-formed and said that no
 * Asana role could touch files, time tracking or custom fields; that matrix tiered the plan. So
 * the checks below also reject research that is internally impossible, and require what the
 * realism work depends on: persona archetypes and everyday questions, domain prevalence. Older
 * agent output that lacks the new fields fails here on purpose — re-run the researcher. */
import { readFileSync } from 'node:fs';
import { parseArgs } from './lib/cli.mjs';
import { ARCHETYPES, REQUIRED_ARCHETYPES, lintPrompt } from './lib/realism.mjs';

const a = parseArgs(process.argv.slice(2), {
  known: ['agent', 'file', 'domains'],
  usage: 'usage: validate-agent-output.mjs --agent domain|persona|role [--file out.json] [--domains "AP,GL,..."]',
});
if (!a.agent) { console.error('usage: validate-agent-output.mjs --agent domain|persona|role [--file out.json] [--domains "AP,GL,..."]'); process.exit(2); }

const raw = a.file ? readFileSync(a.file, 'utf8') : readFileSync(0, 'utf8');
let data;
try { data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
catch (e) { console.log(JSON.stringify({ valid: false, problems: [`not JSON: ${e.message}`] })); process.exit(1); }

const problems = [];
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const arr = v => Array.isArray(v) ? v : null;
const idRe = /^[A-Z][A-Z0-9_]{1,15}$/;
const PREVALENCE = ['core', 'common', 'specialised', 'specialized', 'premium'];

if (a.agent === 'domain') {
  const list = arr(data) || arr(data.domains);
  if (!list) problems.push('expected a JSON array of domains (or {domains:[...]})');
  else {
    if (list.length === 0) problems.push('zero domains — a connector always has at least one');
    if (list.length > 40) problems.push(`${list.length} domains is implausible; merge overlapping ones`);
    const ids = new Set();
    list.forEach((d, i) => {
      if (!isStr(d.id) || !idRe.test(d.id)) problems.push(`domains[${i}].id must be a short UPPERCASE code`);
      if (ids.has(d.id)) problems.push(`duplicate domain id ${d.id}`); ids.add(d.id);
      if (!isStr(d.name)) problems.push(`domains[${i}].name missing`);
      if (!arr(d.table_refs)) problems.push(`domains[${i}].table_refs must be an array (empty is allowed — it becomes an EXPOSURE gap)`);
      const wf = arr(d.workflows); if (!wf || !wf.length) problems.push(`domains[${i}].workflows must be a non-empty array`);
      else wf.forEach((w, j) => { if (!isStr(w.id) || !isStr(w.name)) problems.push(`domains[${i}].workflows[${j}] needs id and name`);
        if (!['read', 'write', 'admin'].includes(w.permission)) problems.push(`domains[${i}].workflows[${j}].permission must be read|write|admin`); });
      if (d.standard_reports != null && !arr(d.standard_reports)) problems.push(`domains[${i}].standard_reports must be an array`);
      if (!PREVALENCE.includes(String(d.prevalence || '').toLowerCase()))
        problems.push(`domains[${i}].prevalence must be one of ${PREVALENCE.join('|')} — tiering cannot tell core work from a premium add-on without it`);
    });
    if (list.length >= 4 && list.every(d => String(d.prevalence).toLowerCase() === 'core'))
      problems.push('every domain is marked core — prevalence that does not discriminate is no signal; mark add-ons and specialised modules honestly');
  }
} else if (a.agent === 'persona') {
  const list = arr(data) || arr(data.personas);
  if (!list) problems.push('expected a JSON array of personas');
  else {
    if (!list.length) problems.push('zero personas');
    if (list.length > 20) problems.push(`${list.length} personas is implausible`);
    list.forEach((p, i) => {
      if (!isStr(p.id) || !isStr(p.name)) problems.push(`personas[${i}] needs id and name`);
      const j = arr(p.jobs_to_be_done); if (!j || !j.length) problems.push(`personas[${i}].jobs_to_be_done must be non-empty`);
      else j.forEach((s, k) => { if (!isStr(s) || s.split(/\s+/).length < 4) problems.push(`personas[${i}].jobs_to_be_done[${k}] is too short to be a real decision`); });
      if (!arr(p.primary_domains)) problems.push(`personas[${i}].primary_domains must be an array`);
      if (!ARCHETYPES.includes(p.archetype)) problems.push(`personas[${i}].archetype must be one of ${ARCHETYPES.join('|')}`);
      const dq = arr(p.daily_questions);
      if (!dq || dq.length < 2) problems.push(`personas[${i}].daily_questions needs 2-5 everyday questions — they become the first test prompts`);
      else dq.forEach((q, k) => {
        const text = typeof q === 'string' ? q : q?.question;
        if (!isStr(text) || text.split(/\s+/).length < 4) { problems.push(`personas[${i}].daily_questions[${k}] is too short to be a real question`); return; }
        /* the person has never seen getTables — a question that leaks the schema is not theirs */
        const leaks = lintPrompt(text).filter(x => x.code !== 'schema_name');
        if (leaks.length) problems.push(`personas[${i}].daily_questions[${k}] ${leaks.map(x => x.detail).join('; ')}`);
        if (/\b[a-z]+[A-Z][a-zA-Z]+\b|\b[A-Z][a-z]+[A-Z][a-zA-Z]*\b/.test(text)) problems.push(`personas[${i}].daily_questions[${k}] contains a CamelCase name — write it the way the person says it`);
      });
    });
    const have = new Set(list.map(p => p.archetype));
    const missing = REQUIRED_ARCHETYPES.filter(a => !have.has(a));
    if (missing.length) problems.push(`no persona with archetype ${missing.join(', ')} — a realistic plan needs a ${missing.join(', ')} (see agents/persona-researcher.md)`);
  }
} else if (a.agent === 'role') {
  const roles = arr(data.roles);
  if (!roles) problems.push('expected {roles:[...], role_complexity, sources}');
  else {
    if (!roles.length) problems.push('zero roles — return the API User fallback instead');
    const known = a.domains ? new Set(String(a.domains).split(',').map(s => s.trim())) : null;
    roles.forEach((r, i) => {
      if (!isStr(r.name)) problems.push(`roles[${i}].name missing`);
      if (!['doc', 'inferred'].includes(r.source)) problems.push(`roles[${i}].source must be doc|inferred`);
      if (!r.access || typeof r.access !== 'object') problems.push(`roles[${i}].access must be an object`);
      else for (const [d, lvl] of Object.entries(r.access)) {
        if (!['F', 'E', 'C', 'V', 'N'].includes(lvl)) problems.push(`roles[${i}].access.${d} = ${lvl} is not F|E|C|V|N`);
        if (known && d !== '*' && !known.has(d)) problems.push(`roles[${i}].access has unknown domain id "${d}"`);
      }
      /* an omitted domain used to be filled with N downstream — that is a hole, not an answer */
      if (known && r.access && !('*' in r.access))
        for (const d of known) if (!(d in r.access)) problems.push(`roles[${i}] (${r.name}) has no access level for domain ${d} — every role carries every domain`);
    });
    if (!['low', 'medium', 'high'].includes(data.role_complexity)) problems.push('role_complexity must be low|medium|high');

    /* Impossible matrices. No product ships a feature that no role may use, and the top role is
     * not weaker than an ordinary member. */
    const RANK = { N: 0, V: 1, C: 2, E: 3, F: 4 };
    const domainsSeen = known ? [...known] : [...new Set(roles.flatMap(r => Object.keys(r.access || {})).filter(d => d !== '*'))];
    const wild = roles.some(r => r.access && r.access['*']);
    if (!wild) for (const d of domainsSeen) {
      if (roles.length > 1 && roles.every(r => (r.access || {})[d] == null || (r.access || {})[d] === 'N'))
        problems.push(`no role has any access to domain ${d} — that is a research gap, not a permission model; infer it and mark source "inferred"`);
    }
    const top = roles.find(r => /^(super ?admin|owner|administrator|system administrator|org(anization)? admin)$/i.test(String(r.name).trim()));
    const member = roles.find(r => /^(member|user|standard user|employee)$/i.test(String(r.name).trim()));
    if (top && member && !wild) {
      const weaker = domainsSeen.filter(d => (RANK[(top.access || {})[d]] ?? 0) < (RANK[(member.access || {})[d]] ?? 0)
        && (RANK[(member.access || {})[d]] ?? 0) >= RANK.E);
      if (weaker.length >= Math.max(2, Math.ceil(domainsSeen.length / 3)))
        problems.push(`"${top.name}" has less access than "${member.name}" in ${weaker.join(', ')} — check the matrix; an administrator weaker than a member across most areas is almost certainly a research error`);
    }
  }
} else problems.push(`unknown agent type ${a.agent}`);

const valid = problems.length === 0;
console.log(JSON.stringify({ valid, agent: a.agent, problems, count: Array.isArray(data) ? data.length : (data.roles || data.domains || data.personas || []).length }));
process.exit(valid ? 0 : 1);
