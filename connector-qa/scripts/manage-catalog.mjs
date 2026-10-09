#!/usr/bin/env node
/**
 * manage-catalog.mjs — Stage 5.5: build, check, judge, review and freeze the use case catalog,
 * one business area at a time (3.1).
 *
 *   node manage-catalog.mjs add           --dir <d> --from <researcher output> [--batch RB-001]
 *   node manage-catalog.mjs validate      --dir <d>                     problems block a freeze
 *   node manage-catalog.mjs ids           --dir <d> [--prefix ASN]      permanent ids for new use cases
 *   node manage-catalog.mjs sources-prep  --dir <d> [--areas a,b]       the cited pages to check
 *   node manage-catalog.mjs sources-merge --dir <d> --checks <f>        record what each page showed
 *   node manage-catalog.mjs judge-prep    --dir <d> [--areas a,b]       the realism judge's package
 *   node manage-catalog.mjs judge-merge   --dir <d> --scores <f>        apply the judge's 1–5 scores
 *   node manage-catalog.mjs review-prep   --dir <d> [--areas a,b]       the whole-area coverage review's package
 *   node manage-catalog.mjs review-merge  --dir <d> --review <f>        record the reviewer's findings
 *   node manage-catalog.mjs review-answer --dir <d> --answers <f>       record what was done about each finding
 *   node manage-catalog.mjs tag           --dir <d> --from <f>          difficulty and tests for use cases written before they existed
 *   node manage-catalog.mjs retire        --dir <d> --ids UC-…,UC-… --why "…"   drop redundant or low-value use cases
 *   node manage-catalog.mjs sample        --dir <d> [--areas a,b] [--n 20]   CSV for the human review
 *   node manage-catalog.mjs human-merge   --dir <d> --ratings <f.csv>
 *   node manage-catalog.mjs freeze        --dir <d> [--areas a,b] [--skip-human]
 *   node manage-catalog.mjs status        --dir <d> [--areas a,b]
 *   node manage-catalog.mjs reset-area    --dir <d> --areas a,b         retire an area's use cases to research it again
 *
 * The catalog is {C}_catalog.json in the connector folder. Each business area is frozen on its
 * own (`cat.areas[<id>]` holds its version and hash), so areas researched later never reopen
 * areas already approved. A stored result is tied to its use case's own hash, so a freeze of one
 * area leaves every other area's results valid.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson, loadConfig, fail, EXIT } from './lib/artifacts.mjs';
import { parseArgs, resolveConnector } from './lib/cli.mjs';
import { validateCatalog, assignIds, catalogHash, sampleForReview, agreement, similarity, areaUseCases, areaHash,
         areaFreezeState, areaCompleteness, areaHumanCheck, sourceProblems, wholeFrozen, liveUseCases,
         areaMix, personaBalance, areaSetHash, coverageReviewState, answerProblems, FINDING_TYPES, DIFFICULTY, SKILLS, SKILL_LABEL,
         MIX_DEFAULTS, PERSONA_DEFAULTS, INFERRED_DEFAULT_SHARE, nearDuplicateChoice } from './lib/catalog.mjs';
import { evidenceOf } from './lib/evidence.mjs';
import { resolveAreas } from './lib/scope.mjs';
import { withExamples } from './lib/fixtures.mjs';
import { rubric } from './lib/realism.mjs';

const CMDS = ['add', 'validate', 'ids', 'sources-prep', 'sources-merge', 'judge-prep', 'judge-merge', 'review-prep', 'review-merge', 'review-answer', 'tag', 'retire', 'sample', 'human-merge', 'freeze', 'status', 'reset-area'];
const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'prefix', 'scores', 'ratings', 'n', 'model', 'skip-human', 'reviewer', 'areas', 'from', 'batch', 'checks', 'review', 'answers', 'ids', 'why', 'second'],
  usage: `usage: manage-catalog.mjs <${CMDS.join('|')}> --dir <connectorDir>`,
});
const cmd = a._[0];
if (!a.dir || !CMDS.includes(cmd)) { console.error(`usage: manage-catalog.mjs <${CMDS.join('|')}> --dir <connectorDir>`); process.exit(EXIT.USAGE); }

const cfg = loadConfig();
const C = { min_score: 4, min_agreement: 0.8, human_sample: 20, dedup: 0.8, human_min_per_area: 5, human_regrow: 0.25,
            min_capability_coverage: 1, verify_sources: true, coverage_review: true, human_review: false, max_inferred_share: INFERRED_DEFAULT_SHARE, ...PERSONA_DEFAULTS, ...(cfg.catalog || {}) };
C.mix = { ...MIX_DEFAULTS, ...(cfg.catalog?.mix || {}) };
const MIN = Number(cfg.defaults?.realism?.min_score ?? C.min_score);
/* 3.9 — the human sample is required only when config.catalog.human_review is true (off by default);
 * `freeze --skip-human` skips it for one freeze whatever the config says. Recorded either way. */
const humanSkip = a['skip-human'] === true ? 'flag' : C.human_review === true ? null : 'config';
C.min_score = MIN;
const conn = resolveConnector(a.dir, a.connector);
const P = n => join(a.dir, `${conn}_${n}.json`);
const CAT = P('catalog');
const capsDoc = existsSync(P('capabilities')) ? readJson(P('capabilities')) : null;
const caps = capsDoc?.capabilities || [];
const areaIds = (capsDoc?.areas || []).map(x => x.id);
const areaName = id => (capsDoc?.areas || []).find(x => x.id === id)?.name || id;

if (!existsSync(CAT) && cmd !== 'add') fail(`no ${CAT} — research adds use cases to it (manage-catalog.mjs add, references/11-catalog.md)`);
const cat = existsSync(CAT) ? readJson(CAT) : { connector: conn, use_cases: [] };
cat.use_cases = cat.use_cases || [];
cat.areas = cat.areas || {};
const live = () => liveUseCases(cat);
const K = existsSync(P('knowledge')) ? readJson(P('knowledge')) : {};
const schema = { objects: (K.objects || []).map(o => o.name), procedures: (K.physical?.procedures || []).map(p => p.name) };
const save = () => writeJson(CAT, cat);
const say = (...x) => console.log(...x);
const now = () => new Date().toISOString();

/** --areas → ids. Without it: every area that has use cases. */
function scope() {
  if (a.areas && a.areas !== true) {
    const { ids, unknown } = resolveAreas(capsDoc, a.areas);
    if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')} — areas: ${areaIds.join(', ') || '(none)'}`, EXIT.USAGE);
    return ids;
  }
  return [...new Set(live().map(u => u.area).filter(Boolean))];
}
const inScope = ids => u => ids.includes(u.area);

function check() {
  const v = validateCatalog(cat, { capabilities: caps, schema, dedup: C.dedup, areas: areaIds });
  say(`CATALOG — ${conn} · ${v.count} use case(s) · ${Object.values(cat.areas).filter(x => x.frozen).length} area(s) frozen`);
  for (const p of v.problems.slice(0, 25)) say(`  ✗ ${p}`);
  if (v.problems.length > 25) say(`  … and ${v.problems.length - 25} more problem(s)`);
  for (const w of v.warnings.slice(0, 15)) say(`  ⚠ ${w}`);
  return v;
}

/* ── add · merge one research batch ───────────────────────────────────────── */
if (cmd === 'add') {
  if (!a.from || !existsSync(a.from)) fail('--from must name the researcher\'s output (references/11-catalog.md §5.5b)', EXIT.USAGE);
  const IN = JSON.parse(readFileSync(a.from, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const RP = P('research_plan');
  const rp = existsSync(RP) ? readJson(RP) : { connector: conn, batches: [] };
  const batch = a.batch ? rp.batches.find(b => b.id === a.batch) : null;
  if (a.batch && !batch) fail(`no batch ${a.batch} in ${RP}`);
  if (batch?.status === 'done') fail(`${a.batch} was already added — re-adding it would duplicate its use cases`);
  if (batch?.status === 'superseded') fail(`${a.batch} was superseded when its area was reset — its research belongs to the old area; dispatch the new batch instead (scope.mjs research-plan)`);
  const stamp = now();
  const added = [], dropped = [], outside = [], replaced = [], stronger = [];
  /* Duplicates are checked against the WHOLE catalog, every area, not just this batch: a later
   * area's researcher does not know what an earlier one wrote. 3.9: of two near-duplicates the better
   * evidenced one is kept (nearDuplicateChoice) — a draft gives way to a newcomer with stronger
   * evidence; an approved or frozen one never does, and the stronger page is noted beside it. */
  const pool = live().map(u => ({ id: u.id, request: u.request, rec: u }));
  const short = s => String(s).slice(0, 60);
  for (const u of IN.use_cases || []) {
    const near = pool.map(p => ({ p, s: similarity(p.request, u.request) })).sort((x, y) => y.s - x.s)[0];
    if (near && near.s >= C.dedup) {
      const old = near.p.rec;
      const choice = nearDuplicateChoice(u, old, { frozen: !!old.id && areaFreezeState(cat, old.area) === 'frozen' });
      const pctS = `${Math.round(near.s * 100)}%`;
      if (choice === 'keep_existing') { dropped.push(`"${short(u.request)}" ≈ ${near.p.id || 'another new one'} (${pctS})`); continue; }
      if (choice === 'note_stronger') {
        old.stronger_evidence = [...(old.stronger_evidence || []).filter(x => x.url !== u.source?.url), { kind: u.source?.kind || null, title: u.source?.title || null, url: u.source?.url || null, request: u.request, batch: batch?.id || null, at: stamp }];
        stronger.push(`${old.id}: ${evidenceOf(u.source)} evidence for "${short(u.request)}" — ${u.source?.url || 'no URL'}`);
        dropped.push(`"${short(u.request)}" ≈ ${old.id} (${pctS}) — kept ${old.id}, which is approved; its stronger page is noted`);
        continue;
      }
      /* replace: a draft from an earlier batch is retired (ids are permanent); one from this batch is simply taken out */
      if (old.id) Object.assign(old, { status: 'retired', retired_at: stamp, retired_why: `near-duplicate of a better-evidenced use case (${evidenceOf(u.source)} beats ${evidenceOf(old.source)}): "${short(u.request)}"` });
      else { cat.use_cases.splice(cat.use_cases.indexOf(old), 1); added.splice(added.indexOf(old), 1); }
      pool.splice(pool.indexOf(near.p), 1);
      replaced.push({ old, why: `${old.id || `"${short(old.request)}"`} (${evidenceOf(old.source)}) ≈ "${short(u.request)}" (${evidenceOf(u.source)}, ${pctS})` });
    }
    if (batch && !batch.areas.includes(u.area)) outside.push(`${u.area}: "${String(u.request).slice(0, 50)}"`);
    if (batch?.cross && !(u.also_areas || []).length) u.also_areas = batch.areas.filter(x => x !== u.area);
    const rec = { ...u, id: undefined, status: 'draft', added_at: stamp, research_batch: batch?.id || null, ...(batch?.cross ? { cross: true } : {}) };
    delete rec.id;
    cat.use_cases.push(rec); pool.push({ request: u.request, rec }); added.push(rec);
    for (const r of replaced) if (!r.by) r.by = rec;
  }
  /* 3.7: the records the batch's use cases need — named, found in the account or seeded */
  let fxAdded = 0;
  for (const f of IN.fixtures || []) {
    if (!f?.id) continue;
    cat.fixtures = (cat.fixtures || []).filter(x => x.id !== f.id);
    cat.fixtures.push({ ...f, added_at: stamp, research_batch: batch?.id || null }); fxAdded++;
  }
  /* capabilities the researcher judged to have no business use — each with its reason */
  for (const n of IN.no_business_use || []) {
    if (!n.capability_id) continue;
    cat.no_business_use = (cat.no_business_use || []).filter(x => x.capability_id !== n.capability_id);
    cat.no_business_use.push({ capability_id: n.capability_id, reason: n.reason || '', by: IN.model || null, at: stamp });
  }
  /* kinds of request (or personas) the writer found no realistic use case for — each with its reason */
  for (const m of IN.mix_explained || []) {
    if (!m.area || !m.need) continue;
    cat.mix_explained = (cat.mix_explained || []).filter(x => !(x.area === m.area && x.need === m.need));
    cat.mix_explained.push({ area: m.area, need: m.need, reason: m.reason || '', by: IN.model || null, at: stamp });
  }
  assignIds(cat, a.prefix || cat.prefix || conn.slice(0, 3));
  save();
  if (batch) { batch.status = 'done'; batch.done_at = stamp; batch.added = added.length; batch.dropped = dropped.length; writeJson(RP, rp); }
  say(`ADD — ${conn}${batch ? ` · ${batch.id} (${batch.areas.join('+')})` : ''} · ${added.length} use case(s) added as ${added.map(u => u.id).join(', ') || '—'}${fxAdded ? ` · ${fxAdded} fixture(s)` : ''}`);
  for (const r of replaced) if (r.old.id && r.by?.id) r.old.replaced_by = r.by.id;
  if (replaced.length) { save(); say(`  ${replaced.length} near-duplicate(s) replaced by a better-evidenced one:`); for (const r of replaced.slice(0, 10)) say(`    ↑ ${r.why} → ${r.by?.id || '—'}`); }
  if (dropped.length) { say(`  ${dropped.length} dropped as near-duplicates of the catalog:`); for (const d of dropped.slice(0, 10)) say(`    ≈ ${d}`); }
  if (stronger.length) { say(`  ⚠ stronger evidence found for ${stronger.length} approved use case(s) — swap the source at the next review if it fits:`); for (const d of stronger.slice(0, 10)) say(`    ${d}`); }
  if (outside.length) say(`  ⚠ ${outside.length} outside the batch's areas: ${outside.slice(0, 4).join(' · ')}`);
  for (const id of [...new Set(added.map(u => u.area))]) if (areaFreezeState(cat, id) === 'changed') say(`  ⚠ ${id} was frozen; it now has new use cases and must be frozen again`);
  process.exit(EXIT.OK);
}

if (cmd === 'validate') {
  const v = check();
  if (v.problems.length) { console.error(`\n✗ ${v.problems.length} problem(s) — fix them before freezing`); process.exit(EXIT.DATA); }
  say('\n  ✓ every use case has evidence, a structure, clean wording and a usable check');
  process.exit(EXIT.OK);
}

if (cmd === 'ids') {
  const n = assignIds(cat, a.prefix || cat.prefix || conn.slice(0, 3));
  for (const u of cat.use_cases) if (!u.added_at) u.added_at = now();
  save(); say(`  ${n} new id(s) assigned · prefix UC-${cat.prefix}-`); process.exit(EXIT.OK);
}

/* ── sources · every cited page is checked before it counts as evidence ──── */
if (cmd === 'sources-prep') {
  const ids = scope();
  const byUrl = new Map();
  for (const u of live().filter(inScope(ids))) {
    const s = u.source || {};
    if (!s.url || s.kind === 'customer_dump' || (s.verified && s.verified.url === s.url)) continue;
    if (!byUrl.has(s.url)) byUrl.set(s.url, []);
    byUrl.get(s.url).push({ id: u.id, request: u.request, source_title: s.title || null });
  }
  const out = P('sources_to_check');
  writeJson(out, { connector: conn,
    instructions: ['Open every URL with the page reader (references/10a-page-reader.md): a page that comes back as an empty JavaScript',
      'shell is read again with a rendered browser before it is judged — never call a page not_found because a plain fetch saw no text.',
      'For each URL, return {"url","status","support","page_kind","title_seen","note"} with status',
      '"found" — the page exists and is about what the listed use cases claim it shows;',
      '"off_topic" — the page exists but does not support them; "not_found" — missing, moved or a login wall.',
      'support (for found): "strong" — it shows people doing or asking for this work as the use cases describe;',
      '"weak" — related but partial: a feature announcement, a feature request, an adjacent topic.',
      'page_kind: "user_post" (a real user in a forum or community), "vendor_page" (the vendor\'s own help, use case, tutorial, blog or',
      'marketing), "third_party" (another company\'s site, often selling a product), "api_doc" (developer documentation).',
      'Do not judge the use cases. Return {"model": "<you>", "checks": [ … ]} with one entry per URL.'],
    items: [...byUrl].map(([url, ucs]) => ({ url, use_cases: ucs })) });
  say(`  ${byUrl.size} page(s) to check for ${[...byUrl.values()].flat().length} use case(s) in ${ids.join(', ') || '—'}\n→ ${out}`);
  process.exit(EXIT.OK);
}

if (cmd === 'sources-merge') {
  if (!a.checks || !existsSync(a.checks)) fail('--checks must name the source checker\'s output', EXIT.USAGE);
  const S = JSON.parse(readFileSync(a.checks, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const OK = ['found', 'off_topic', 'not_found'];
  const bad = (S.checks || []).filter(c => !OK.includes(c.status));
  if (bad.length) fail(`${bad.length} check(s) with a status outside ${OK.join(' · ')}: ${bad.slice(0, 3).map(c => c.url).join(', ')}`);
  const byUrl = new Map((S.checks || []).map(c => [c.url, c]));
  let n = 0;
  const failed = [];
  for (const u of live()) {
    const c = byUrl.get(u.source?.url);
    if (!c) continue;
    u.source.verified = { status: c.status, url: c.url, at: now(), title_seen: c.title_seen || null, note: c.note || null, by: S.model || null,
                          ...(['strong', 'weak'].includes(c.support) ? { support: c.support } : {}),
                          ...(['user_post', 'vendor_page', 'third_party', 'api_doc'].includes(c.page_kind) ? { page_kind: c.page_kind } : {}) };
    n++;
    if (c.status !== 'found') failed.push(`${u.id} ${c.status.replace('_', ' ')} — ${c.url}`);
  }
  save();
  say(`  ${n} use case(s) checked against ${byUrl.size} page(s) · ${failed.length} with evidence that does not hold`);
  for (const f of failed.slice(0, 12)) say(`    ✗ ${f}`);
  if (failed.length) say('  Replace the source with one that does support the use case, or retire the use case.');
  process.exit(EXIT.OK);
}

if (cmd === 'judge-prep') {
  const ids = scope();
  const pkg = {
    connector: conn, catalog_hash: catalogHash(cat), areas: ids,
    instructions: [
      `Score each use case for realism, 1 to 5, against the rubric. Judge the REQUEST only: would this persona,`,
      `at this moment, with this goal, ask it this way? You see the evidence it came from. Do not rewrite.`,
      `For any score below ${MIN}, say in "issues" what makes it unrealistic and in "suggestion" how the persona`,
      `would actually put it. Return {"model": "<you>", "scores": [{"id","score","criteria":{},"issues":[],"suggestion":""}]}`,
      `with one entry for EVERY id. Score each variant too, as "<id>#v1", "<id>#v2".`,
    ],
    rubric: rubric(MIN),
    /* only what is not yet judged on its current wording — a judged use case is not paid for twice */
    use_cases: live().filter(inScope(ids)).filter(u => a.second === true
        /* 3.7: the second judge scores every request not yet second-judged on its current wording */
        ? u.realism_second?.judged_request !== u.request
        : !u.realism || u.realism.judged_request !== u.request || (u.variants || []).some((t, i) => u.variant_realism?.[String(i + 1)]?.judged !== t))
      .map(u => ({ id: u.id, request: withExamples(u.request, cat), variants: (u.variants || []).map(v => withExamples(v, cat)), persona: u.persona,
        moment: u.moment || null, goal: u.goal, frequency: u.frequency || null, source: u.source })),
  };
  const out = a.second === true ? join(a.dir, `${conn}_catalog_judge_input_2.json`) : P('catalog_judge_input');
  if (a.second === true) pkg.instructions = pkg.instructions.filter(l => !/variant/i.test(l)).concat(['Score the main request only, with one entry for every id.']);
  writeJson(out, pkg);
  say(`  ${pkg.use_cases.length} use case(s) in ${ids.join(', ') || '—'} packaged for config.models.realism_judge (${cfg.models?.realism_judge || 'opus'})\n→ ${out}`);
  process.exit(EXIT.OK);
}

if (cmd === 'judge-merge') {
  if (!a.scores || !existsSync(a.scores)) fail('--scores must name the judge\'s output', EXIT.USAGE);
  /* 3.7 — --second: the second judge's scores are kept beside the first, never in their place */
  if (a.second === true) {
    const S2 = JSON.parse(readFileSync(a.scores, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const byId2 = new Map(live().map(u => [u.id, u]));
    let n2 = 0;
    for (const s of S2.scores || []) {
      const u = byId2.get(String(s.id).split('#v')[0]); const score = Number(s.score);
      if (!u || String(s.id).includes('#v') || !(score >= 1 && score <= 5)) continue;
      u.realism_second = { score, issues: s.issues || [], judged_request: u.request, judge_model: a.model || S2.model || cfg.models?.second_judge || null };
      n2++;
    }
    save();
    const split = live().filter(u => u.realism && u.realism_second && u.realism_second.judged_request === u.request
      && (Math.abs(u.realism.score - u.realism_second.score) >= 2 || (u.realism.score >= MIN) !== (u.realism_second.score >= MIN)));
    say(`  ${n2} second-judge score(s) applied · ${split.length} use case(s) where the two judges disagree — the human sample takes them first`);
    for (const u of split.slice(0, 10)) say(`    ≠ ${u.id} ${u.realism.score} vs ${u.realism_second.score} — "${String(u.request).slice(0, 70)}"`);
    process.exit(EXIT.OK);
  }
  const S = JSON.parse(readFileSync(a.scores, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const byId = new Map(live().map(u => [u.id, u]));
  let n = 0; const skipped = [];
  for (const s of S.scores || []) {
    const [id, vi] = String(s.id).split('#v');
    const u = byId.get(id); if (!u) { skipped.push(`${s.id}: not in the catalog`); continue; }
    const score = Number(s.score);
    /* one bad entry must not throw away the rest of the judge's work — it stays unjudged and blocks the freeze */
    if (!(score >= 1 && score <= 5)) { skipped.push(`${s.id}: score ${s.score} is not 1 to 5`); continue; }
    if (vi && !(u.variants || [])[Number(vi) - 1]) { skipped.push(`${s.id}: no such variant`); continue; }
    const rec = { score, criteria: s.criteria || {}, issues: s.issues || [], ...(s.suggestion ? { suggestion: s.suggestion } : {}),
      judge_model: a.model || S.model || cfg.models?.realism_judge || null };
    if (vi) { u.variant_realism = u.variant_realism || {}; u.variant_realism[vi] = { ...rec, judged: (u.variants || [])[Number(vi) - 1] }; }
    else { u.realism = { ...rec, judged_request: u.request }; }
    n++;
  }
  save();
  const low = live().filter(u => u.realism && u.realism.score < MIN);
  say(`  ${n} score(s) applied · ${low.length} use case(s) below ${MIN}`);
  for (const x of skipped) console.error(`  ⚠ skipped ${x}`);
  for (const u of low.slice(0, 10)) say(`    ✗ ${u.id} ${u.realism.score} — ${(u.realism.issues || []).join('; ').slice(0, 90)}${u.realism.suggestion ? ` → "${u.realism.suggestion}"` : ''}`);
  process.exit(EXIT.OK);
}

/* ── coverage review · a fresh reviewer reads each area's whole set ───────── */
if (cmd === 'review-prep') {
  const ids = scope();
  const areaOf = id => (capsDoc?.areas || []).find(x => x.id === id) || { id };
  const capLabel = new Map(caps.map(c => [c.id, c.label || c.id]));
  const pkg = {
    connector: conn,
    instructions: [
      'You review one or more business areas of a use case catalog as a whole. Each use case is a request a real person',
      'would put to an AI assistant connected to the source. The set is the benchmark that compares AI models on this',
      'connector, so it must cover the area\'s real work without padding. Judge the SET, not each wording (a separate',
      'judge did that). Read the area\'s flows, personas, capabilities and every use case, then list:',
      '- what is missing: an important workflow, a persona\'s everyday work, a request that combines objects, an action,',
      '  an ambiguous request, a request missing a detail the AI must ask for, a request the source cannot do (the AI must',
      '  say so), a complex multi-step request;',
      '- what is redundant (the same scenario reworded) and what is low value (trivial, a single lookup with no business',
      '  intent, testing the connector rather than the AI, or not something this persona would do);',
      'Each persona must ask what that role actually needs: a sponsor, a team lead and an analyst want different things.',
      'Use the figures given (mix, persona balance, overlaps) as leads, not verdicts. Do not pad: say "complete" when nothing',
      'important is missing. Every finding needs a concrete "what" — a missing workflow is named, with the persona and the',
      'kind of request it would be — so the writer can find evidence for it.',
      `Return {"model":"<you>","areas":[{"area","verdict":"complete|gaps","findings":[{"type","what","persona","ids":[],"suggestion"}]}]}`,
      `with type one of ${FINDING_TYPES.join(', ')}. ids name the use cases a redundant, low_value, off_persona or off_area finding is about.`,
    ],
    skills: Object.fromEntries([...DIFFICULTY, ...SKILLS].map(k => [k, SKILL_LABEL[k]])),
    areas: ids.map(id => {
      const ar = areaOf(id);
      return {
        area: id, name: ar.name || id,
        flows: (ar.flows || []).map(f => ({ id: f.id, name: f.name || f.label || f.id })),
        personas: ar.personas || [],
        capabilities: [...new Set([...(ar.capability_ids || []), ...(ar.flows || []).flatMap(f => f.capability_ids || [])])].map(c => ({ id: c, label: capLabel.get(c) || c })),
        no_business_use: (cat.no_business_use || []).filter(n => (ar.capability_ids || []).includes(n.capability_id)),
        mix: areaMix(cat, id, C.mix),
        personas_balance: personaBalance(cat, capsDoc, id, C),
        mix_explained: (cat.mix_explained || []).filter(x => x.area === id),
        use_cases: areaUseCases(cat, id).map(u => ({ id: u.id, persona: u.persona, goal: u.goal, kind: u.kind, writes: u.writes ?? null,
          difficulty: u.difficulty ?? null, tests: u.tests ?? null, request: u.request, capabilities: (u.capabilities || []).map(c => capLabel.get(c) || c),
          expected_behavior: u.expected_behavior || [] })),
      };
    }),
  };
  const out = P('catalog_coverage_input');
  writeJson(out, pkg);
  say(`  ${ids.length} area(s), ${pkg.areas.reduce((n, x) => n + x.use_cases.length, 0)} use case(s) packaged for agents/catalog-reviewer.md (config.models.research_business)\n→ ${out}`);
  process.exit(EXIT.OK);
}

if (cmd === 'review-merge') {
  if (!a.review || !existsSync(a.review)) fail('--review must name the coverage reviewer\'s output', EXIT.USAGE);
  const R = JSON.parse(readFileSync(a.review, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const stamp = now();
  for (const r of R.areas || []) {
    if (!areaIds.includes(r.area) && !live().some(u => u.area === r.area)) { console.error(`  ⚠ skipped ${r.area}: not a business area`); continue; }
    const bad = (r.findings || []).filter(f => !FINDING_TYPES.includes(f.type) || !String(f.what || '').trim());
    if (bad.length) fail(`${r.area}: ${bad.length} finding(s) with an unknown type or no "what" — types: ${FINDING_TYPES.join(', ')}`);
    const st = cat.areas[r.area] = cat.areas[r.area] || {};
    if (st.coverage_review) st.coverage_review_history = [...(st.coverage_review_history || []), { at: st.coverage_review.at, findings: (st.coverage_review.findings || []).length, answered: Object.keys(st.coverage_review.answers || {}).length }];
    const findings = (r.findings || []).map((f, i) => ({ n: `F${i + 1}`, type: f.type, what: f.what, persona: f.persona || null, ids: f.ids || [], suggestion: f.suggestion || null }));
    st.coverage_review = { at: stamp, model: R.model || a.model || null, verdict: findings.length ? 'gaps' : 'complete', set_hash: areaSetHash(cat, r.area), findings, answers: {} };
    say(`  ${r.area}: ${findings.length ? `${findings.length} finding(s)` : 'complete — no findings'}`);
    for (const f of findings.slice(0, 12)) say(`    ${f.n} ${f.type.replace(/_/g, ' ')}${f.persona ? ` · ${f.persona}` : ''}${f.ids.length ? ` · ${f.ids.join(', ')}` : ''} — ${String(f.what).slice(0, 110)}`);
  }
  save();
  say('\n  Answer every finding: add use cases (scope.mjs research-plan --areas <a> --fill plans evidence for the missing ones), retire redundant or low-value ones, or keep with a reason — then manage-catalog.mjs review-answer --answers <file>');
  process.exit(EXIT.OK);
}

if (cmd === 'review-answer') {
  if (!a.answers || !existsSync(a.answers)) fail('--answers must name the writer\'s answers to the coverage review', EXIT.USAGE);
  const A = JSON.parse(readFileSync(a.answers, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const byArea = new Map();
  for (const x of A.answers || []) { if (!byArea.has(x.area)) byArea.set(x.area, []); byArea.get(x.area).push(x); }
  const probs = [...byArea].flatMap(([id, xs]) => answerProblems(cat, id, xs));
  if (probs.length) { for (const p of probs.slice(0, 20)) console.error(`  ✗ ${p}`); fail(`${probs.length} answer(s) do not hold — nothing was recorded`); }
  const stamp = now();
  for (const [id, xs] of byArea) {
    const rv = cat.areas[id].coverage_review;
    for (const x of xs) rv.answers[x.finding] = { action: x.action, ids: x.ids || [], reason: x.reason || null, at: stamp };
    rv.set_after = areaSetHash(cat, id);
    const st = coverageReviewState(cat, id);
    say(`  ${id}: ${xs.length} answer(s) recorded · ${st.ok ? 'review settled' : st.reason}`);
  }
  save();
  process.exit(EXIT.OK);
}

/* ── tag · difficulty and skills for use cases written before 3.2 ─────────────
 * Tags describe a use case; they are not part of what was asked or how it is checked, so they are
 * outside its hash: tagging a frozen area keeps it frozen and every stored result valid. */
if (cmd === 'tag') {
  if (!a.from || !existsSync(a.from)) fail('--from must name the tagger output: {"tags":[{"id","difficulty","tests"}]}', EXIT.USAGE);
  const IN = JSON.parse(readFileSync(a.from, 'utf8').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const byId = new Map(live().map(u => [u.id, u]));
  const bad = [];
  for (const t of IN.tags || []) {
    if (!byId.has(t.id)) bad.push(`${t.id}: not a live use case`);
    else if (!DIFFICULTY.includes(t.difficulty)) bad.push(`${t.id}: difficulty "${t.difficulty}"`);
    else if (!Array.isArray(t.tests) || t.tests.some(x => !SKILLS.includes(x))) bad.push(`${t.id}: tests must use ${SKILLS.join(', ')}`);
  }
  if (bad.length) { for (const b of bad.slice(0, 15)) console.error(`  ✗ ${b}`); fail(`${bad.length} tag(s) refused — nothing was changed`); }
  const before = Object.fromEntries(Object.keys(cat.areas).map(id => [id, areaFreezeState(cat, id)]));
  for (const t of IN.tags || []) Object.assign(byId.get(t.id), { difficulty: t.difficulty, tests: [...new Set(t.tests)], tagged_by: IN.model || a.model || null });
  const moved = Object.keys(before).filter(id => before[id] !== areaFreezeState(cat, id));
  if (moved.length) fail(`tagging would change the freeze state of ${moved.join(', ')} — refused`);
  save();
  const untagged = live().filter(u => !u.difficulty).length;
  say(`  ${(IN.tags || []).length} use case(s) tagged${untagged ? ` · ${untagged} still untagged` : ' · every live use case tagged'} · freeze states unchanged`);
  process.exit(EXIT.OK);
}

if (cmd === 'retire') {
  const ids = String(a.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length || !a.why || a.why === true) fail('--ids names the use cases and --why says why they go (redundant with …, low value because …)', EXIT.USAGE);
  const byId = new Map(live().map(u => [u.id, u]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) fail(`not live use cases: ${missing.join(', ')}`);
  const stamp = now();
  /* retired, never deleted: ids are permanent and stored results stay readable as history */
  for (const id of ids) Object.assign(byId.get(id), { status: 'retired', retired_at: stamp, retired_why: String(a.why) });
  cat.hash = catalogHash(cat); cat.frozen = wholeFrozen(cat, areaIds);
  save();
  const areas = [...new Set(ids.map(id => byId.get(id).area))];
  say(`  ${ids.length} use case(s) retired · ${areas.map(id => `${id} ${areaFreezeState(cat, id)}`).join(' · ')}`);
  process.exit(EXIT.OK);
}

const csvEsc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(c => c.trim()));
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), (r[i] ?? '').trim()])));
}

if (cmd === 'sample') {
  const ids = scope();
  /* enough for every area in scope to reach its own minimum */
  const n = Number(a.n || Math.max(C.human_sample, ids.length * C.human_min_per_area));
  const pick = sampleForReview(cat, n, { areas: ids });
  const out = join(a.dir, `${conn}_catalog_review.csv`);
  const lines = ['id,area,persona,request,source,judge_score,rating,comment',
    ...pick.map(u => [u.id, u.area, u.persona, u.request, `${u.source?.kind}: ${u.source?.title}`, u.realism?.score ?? '', '', ''].map(csvEsc).join(','))];
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  say(`  ${pick.length} use case(s) sampled across ${new Set(pick.map(u => u.area)).size} area(s) and ${new Set(pick.map(u => u.persona)).size} persona(s) — not yet rated first`);
  say(`→ ${out}\n  A person fills "rating" (1-5: would a real user ask this?) and "comment", then: manage-catalog.mjs human-merge --ratings <file>`);
  process.exit(EXIT.OK);
}

if (cmd === 'human-merge') {
  if (!a.ratings || !existsSync(a.ratings)) fail('--ratings must name the filled-in review CSV', EXIT.USAGE);
  const ratings = parseCsv(readFileSync(a.ratings, 'utf8')).filter(r => r.id && r.rating);
  if (!ratings.length) fail('the review file has no ratings filled in');
  const byId = new Map(live().map(u => [u.id, u]));
  const stamp = now();
  /* Ratings are kept per area and accumulate: a later sample of an area adds to its review. Each
   * rating remembers the wording the person saw, so rewording a use case voids its rating. */
  const touched = new Set();
  for (const r of ratings) {
    const u = byId.get(r.id); if (!u) continue;
    u.human = { rating: Number(r.rating), comment: r.comment || null };
    const st = cat.areas[u.area] = cat.areas[u.area] || {};
    const rev = st.human_review = st.human_review || { ratings: [] };
    rev.ratings = rev.ratings.filter(x => x.id !== u.id);
    rev.ratings.push({ id: u.id, rating: Number(r.rating), comment: r.comment || null, request: u.request });
    rev.at = stamp; rev.reviewer = a.reviewer || rev.reviewer || null;
    touched.add(u.area);
  }
  for (const id of touched) {
    const rev = cat.areas[id].human_review;
    const ag = agreement(areaUseCases(cat, id), rev.ratings, MIN);
    Object.assign(rev, { n: ag.n, agree: ag.agree, rate: ag.rate, disagreements: ag.disagreements });
  }
  /* the whole-catalog figure the report prints */
  const all = Object.values(cat.areas).flatMap(x => x.human_review?.ratings || []);
  const ag = agreement(live(), all, MIN);
  cat.human_review = { n: ag.n, agree: ag.agree, rate: ag.rate, reviewer: a.reviewer || null, at: stamp, disagreements: ag.disagreements };
  save();
  for (const id of touched) {
    const rv = cat.areas[id].human_review;
    say(`  ${id}: ${rv.agree} of ${rv.n} agree with the judge (${rv.rate == null ? '—' : Math.round(rv.rate * 100) + '%'})`);
  }
  for (const d of ag.disagreements.slice(0, 8)) say(`    ≠ ${d.id} judge ${d.judge} · human ${d.human}${d.comment ? ` — ${d.comment}` : ''}`);
  process.exit(EXIT.OK);
}

/* ── freeze / status — per area ───────────────────────────────────────────── */
/* The set-level checks: the kinds of request the area holds, how its personas are served, and the
 * whole-area coverage review. An area frozen before these existed keeps its freeze — they apply the
 * next time it is researched or changed, and status shows what it would need. */
function qualityBlockers(id) {
  const out = [];
  const mix = areaMix(cat, id, C.mix);
  if (mix.untagged) out.push(`${mix.untagged} use case(s) without difficulty or tests tags`);
  /* the floors are counted only on tagged use cases — an untagged set would read as empty */
  else if (mix.missing.length) out.push(`mix below its floor: ${mix.missing.map(m => `${m.label} ${m.have}/${m.min}`).join(', ')} — add use cases or explain under mix_explained`);
  if (capsDoc) {
    const pb = personaBalance(cat, capsDoc, id, C);
    if (pb.thin.length) out.push(`thin persona(s): ${pb.thin.map(p => `${p.persona} ${p.have}/${p.min}`).join(', ')} — add their own use cases or explain under mix_explained as persona:<name>`);
  }
  /* inferred use cases fill gaps in the written evidence; they must not become the benchmark */
  const ucsA = areaUseCases(cat, id), inferred = ucsA.filter(u => u.source?.kind === 'inferred').length;
  if (ucsA.length && inferred / ucsA.length > Number(C.max_inferred_share)) out.push(`${inferred} of ${ucsA.length} use cases are inferred — at most ${Math.round(100 * C.max_inferred_share)}% (catalog.max_inferred_share); find written evidence for some`);
  if (C.coverage_review !== false) { const r = coverageReviewState(cat, id); if (!r.ok) out.push(r.reason); }
  return out;
}

/** One line of what the area holds, for status. */
function mixLine(id) {
  const m = areaMix(cat, id, C.mix);
  const f = k => `${SKILL_LABEL[k]} ${m.counts[k]}${m.missing.some(x => x.need === k) ? '✗' : ''}`;
  const pb = capsDoc ? personaBalance(cat, capsDoc, id, C) : null;
  return [...(m.untagged === m.total ? [] : [`difficulty: ${DIFFICULTY.map(f).join(' · ')}`, `tests: ${SKILLS.map(f).join(' · ')}`]),
    ...(pb ? [`personas: ${Object.entries(pb.counts).map(([p, n]) => `${p} ${n}${pb.thin.some(t => t.persona === p) ? '✗' : ''}`).join(' · ')}${pb.dominant ? ` · ⚠ ${pb.dominant.persona} holds ${Math.round(pb.dominant.share * 100)}%` : ''}${pb.overlaps.length ? ` · ⚠ ${pb.overlaps.length} question(s) shared across personas` : ''}`] : []),
    ...(m.untagged ? [`${m.untagged} untagged`] : [])];
}
function blockersFor(id, v) {
  const ucs = areaUseCases(cat, id);
  const out = [];
  if (!ucs.length) return ['no use cases yet'];
  const probs = [...ucs.flatMap(u => v.problemsById[u.id] || []), ...(v.problemsByArea?.[id] || [])];
  if (probs.length) out.push(`${probs.length} validation problem(s)`);
  const unscored = ucs.filter(u => !u.realism || u.realism.judged_request !== u.request);
  const low = ucs.filter(u => u.realism && u.realism.judged_request === u.request && u.realism.score < MIN);
  /* variants are run as tests too, so each is judged on its own wording */
  const vr = (u, i) => u.variant_realism?.[String(i + 1)];
  const vUnscored = ucs.flatMap(u => (u.variants || []).map((t, i) => (vr(u, i)?.judged === t ? null : `${u.id}#v${i + 1}`))).filter(Boolean);
  const vLow = ucs.flatMap(u => (u.variants || []).map((t, i) => (vr(u, i)?.judged === t && vr(u, i).score < MIN ? `${u.id}#v${i + 1}` : null))).filter(Boolean);
  if (unscored.length) out.push(`${unscored.length} use case(s) not judged, or reworded since`);
  if (low.length) out.push(`${low.length} use case(s) below realism ${MIN}`);
  if (vUnscored.length) out.push(`${vUnscored.length} variant(s) not judged, or reworded since (${vUnscored.slice(0, 5).join(', ')})`);
  if (vLow.length) out.push(`${vLow.length} variant(s) below realism ${MIN} (${vLow.slice(0, 5).join(', ')})`);
  const src = ucs.filter(u => sourceProblems(u, { verify: C.verify_sources !== false }).length);
  if (src.length) out.push(`${src.length} use case(s) whose source is missing, unchecked or does not hold (${src.slice(0, 4).map(u => u.id).join(', ')})`);
  if (capsDoc) {
    const comp = areaCompleteness(cat, capsDoc, id);
    const share = comp.caps_total ? comp.caps_covered / comp.caps_total : 1;
    if (share < Number(C.min_capability_coverage)) out.push(`research incomplete: ${comp.missing_caps.length} of ${comp.caps_total} capabilities used by no use case and not explained (${comp.missing_caps.slice(0, 4).map(c => c.id).join(', ')}${comp.missing_caps.length > 4 ? ' …' : ''}) — scope.mjs research-plan --fill`);
    if (comp.personas_missing.length) out.push(`no use case for persona(s) ${comp.personas_missing.join(', ')}`);
  }
  if (areaFreezeState(cat, id) !== 'frozen') out.push(...qualityBlockers(id));
  if (!humanSkip) { const h = areaHumanCheck(cat, id, C); if (!h.ok) out.push(h.reason); }
  return out;
}

if (cmd === 'freeze' || cmd === 'status') {
  const v = check();
  const ids = scope();
  if (!ids.length) fail('no area has use cases yet');
  const report = ids.map(id => ({ id, state: areaFreezeState(cat, id), blockers: blockersFor(id, v) }));
  say('');
  for (const r of report) {
    const st = r.state === 'frozen' ? `frozen v${cat.areas[r.id].version}` : r.state;
    say(`  ${r.id.padEnd(6)} ${areaName(r.id).slice(0, 26).padEnd(26)} ${String(areaUseCases(cat, r.id).length).padStart(3)} use case(s) · ${st}${r.blockers.length ? ` · ✗ ${r.blockers.join(' · ')}` : ' · ✓ ready'}`);
    if (cmd === 'status') {
      for (const l of mixLine(r.id)) say(`         ${l}`);
      const later = r.state === 'frozen' ? qualityBlockers(r.id) : [];
      if (later.length) say(`         ⓘ frozen before the set checks — when next researched it will need: ${later.join(' · ')}`);
    }
  }
  const blocked = report.filter(r => r.blockers.length);
  if (cmd === 'status') {
    if (blocked.length) { console.error(`\n  not ready to freeze: ${blocked.map(r => r.id).join(', ')}`); process.exit(EXIT.DATA); }
    say('\n  ✓ ready to freeze'); process.exit(EXIT.OK);
  }
  if (blocked.length) { console.error(`\n✗ cannot freeze ${blocked.map(r => r.id).join(', ')} — see above. Nothing was frozen.`); process.exit(EXIT.DATA); }
  const stamp = now();
  const frozen = [];
  for (const r of report) {
    const hash = areaHash(cat, r.id);
    const st = cat.areas[r.id] = cat.areas[r.id] || {};
    if (st.frozen && st.hash === hash) { say(`  ${r.id} already frozen as v${st.version} — nothing changed`); continue; }
    st.version = (Number(st.version) || 0) + 1;
    Object.assign(st, { hash, frozen: true, frozen_at: stamp });
    st.history = [...(st.history || []), { version: st.version, hash, at: stamp, count: areaUseCases(cat, r.id).length, human_skipped: !!humanSkip, ...(humanSkip ? { human_skipped_by: humanSkip } : {}) }];
    for (const u of areaUseCases(cat, r.id)) u.status = 'approved';
    frozen.push(`${r.id} v${st.version}`);
  }
  /* whole-catalog fields, for the report and older readers */
  cat.hash = catalogHash(cat);
  cat.frozen = wholeFrozen(cat, areaIds);
  if (frozen.length) {
    cat.version = (Number(cat.version) || 0) + 1;
    cat.history = [...(cat.history || []), { version: cat.version, hash: cat.hash, at: stamp, count: live().length, areas: frozen, human_skipped: !!humanSkip, ...(humanSkip ? { human_skipped_by: humanSkip } : {}) }];
  }
  save();
  /* 3.9 — the run's decision, beside the run's other facts */
  if (frozen.length && existsSync(P('knowledge'))) {
    const K = readJson(P('knowledge'));
    K.run_meta = { ...(K.run_meta || {}), human_review: humanSkip ? `skipped (${humanSkip})` : 'required', human_review_at: stamp };
    writeJson(P('knowledge'), K);
  }
  say(`\n  ✓ ${frozen.length ? `frozen ${frozen.join(', ')}` : 'nothing new to freeze'} · catalog revision v${cat.version ?? 0} · ${live().length} use cases${cat.frozen ? ' · every area frozen' : ''}${humanSkip ? ` · human review SKIPPED${humanSkip === 'config' ? ' (off: config.catalog.human_review)' : ''}` : ''}`);
  process.exit(EXIT.OK);
}

/* ── reset-area · research an area again ──────────────────────────────────── */
if (cmd === 'reset-area') {
  if (!a.areas || a.areas === true) fail('--areas names the area(s) to research again', EXIT.USAGE);
  const ids = scope();
  const stamp = now();
  let n = 0;
  /* retired, never deleted: ids are permanent, and stored results stay readable as history */
  for (const u of live().filter(inScope(ids))) { u.status = 'retired'; u.retired_at = stamp; u.retired_why = 'area reset for new research'; n++; }
  for (const id of ids) if (cat.areas[id]) {
    const st = cat.areas[id];
    cat.areas[id] = { history: [...(st.history || []), { reset_at: stamp, was_version: st.version ?? null }], version: st.version ?? 0 };
  }
  const RP = P('research_plan');
  if (existsSync(RP)) {
    const rp = readJson(RP);
    for (const b of rp.batches) if (b.areas.some(x => ids.includes(x)) && b.status !== 'superseded') { b.status = 'superseded'; b.superseded_at = stamp; }
    writeJson(RP, rp);
  }
  cat.hash = catalogHash(cat); cat.frozen = wholeFrozen(cat, areaIds);
  save();
  say(`  ${n} use case(s) retired in ${ids.join(', ')} · their research batches superseded · next: scope.mjs research-plan --areas ${ids.join(',')}`);
  process.exit(EXIT.OK);
}
