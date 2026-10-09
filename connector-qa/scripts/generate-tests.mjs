#!/usr/bin/env node
/**
 * generate-tests.mjs — Stage 8, the mechanical half.
 *
 *   node generate-tests.mjs --dir <connectorDir> [--connector Name] [--max N] [--no-write]
 *
 * Builds one TC for every still-open coverage item, from artifacts already on disk. It does the
 * bookkeeping the model should never do by hand: walking every uncovered use case, procedure,
 * behavior, relationship, pattern and object family; citing the exact gap ids each TC closes;
 * carrying `use_case_ids` / `sp_name` / `behavior` so Stage 10 can actually credit the result;
 * and merging TCs that would send the same SQL.
 *
 * It does NOT replace the model's judgement on prompt wording. Prompts here are composed from
 * material the research stages already produced — persona jobs-to-be-done, use-case names,
 * behavior prompt_shapes, procedure descriptions. Refine any of them by hand; the gap_ids are what
 * make them count.
 *
 * Two suites (2.2.0). Management read asn005's Asana plan and found most of it unrealistic, and
 * it was: "Show me each ProjectFollowers record together with the Workspaces it belongs to" is a
 * join check, not a use case. So every test now says which it is:
 *
 *   suite: "business"     — a person with a goal: persona everyday questions, use cases,
 *                           workflows, object questions from the research. Born as a DRAFT with a
 *                           `brief`; Stage 8.5 rewrites the prompt in the persona's words and
 *                           Stage 8.6 (realism-check.mjs) scores it. These are what the report
 *                           presents as business scenarios.
 *   suite: "conformance"  — joins, SQL patterns, procedures, write checks, agent behaviours.
 *                           Still worth running, never presented as a use case. Patterns are
 *                           credited from what business tests actually sent first (Stage 10
 *                           parses observed SQL), so these fill only what business tests missed.
 *
 * Test mechanics never go in a prompt. "Read it back", "set it back", "say plainly", workspace ids
 * — a business user says none of them. They live in `expected_behavior` (what the judge checks)
 * and `agent_context` (the operating note Stage 9 hands the agent beside the question).
 */
import { readJson, writeJson, readArtifacts, fail, EXIT, writePolicy } from './lib/artifacts.mjs';
import { isCovered } from './lib/coverage-state.mjs';
import { lintPrompt, headlineColumns, humanize, singular, naturalize, isPlumbing } from './lib/realism.mjs';
import { areaFreezeState, ucHash } from './lib/catalog.mjs';
import { resolveAreas } from './lib/scope.mjs';
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fixtureRefs, renderUseCase, boundValues, recordId } from './lib/fixtures.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveConnector } from './lib/cli.mjs';

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));

const a = parseArgs(process.argv.slice(2), {
  known: ['dir', 'connector', 'max', 'no-write', 'allow-thin', 'allow-unfrozen', 'areas', 'all', 'with-conformance'],
  usage: 'usage: generate-tests.mjs --dir <connectorDir> [--areas a,b | --all] [--with-conformance] [--max N] [--no-write]',
});
if (!a.dir) { console.error('usage: generate-tests.mjs --dir <connectorDir> [--areas a,b | --all] [--with-conformance] [--max N] [--no-write]'); process.exit(2); }

const conn = resolveConnector(a.dir, a.connector);
if (!conn) { console.error(`✗ no <Connector>_knowledge.json in ${a.dir}`); process.exit(2); }
const P = n => join(a.dir, `${conn}_${n}.json`);
for (const n of ['knowledge', 'coverage', 'gaps']) if (!existsSync(P(n))) { console.error(`✗ missing ${P(n)}`); process.exit(2); }

/* Shape-checked. A wrong-shaped coverage.json used to yield zero objects, an empty plan, exit 0,
 * and planned_tests wiped from every gap — the plan and the gap ledger destroyed together by a
 * file that happened to parse. */
const { K, C, G } = readArtifacts({
  K: { path: P('knowledge'), kind: 'knowledge' },
  C: { path: P('coverage'),  kind: 'coverage'  },
  G: { path: P('gaps'),      kind: 'gaps'      },
});

/* ── what still needs a test ─────────────────────────────────────────────── */
const LIVE = new Set(['OPEN', 'PARTIALLY_CLOSED', 'FAILED', undefined, null]);
const openGaps = (G.gaps || []).filter(g => LIVE.has(g.final_status));
const byKey = new Map();
for (const g of openGaps) if (g.key) { const k = String(g.key); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(g.id); }
const keyed = k => byKey.get(k) || [];
/* a gap is unreachable when the connector itself refuses the capability — a test proves nothing */
/* Two very different reasons a gap looked unreachable, and they were treated the same.
 *
 * ABSENT — the capability is not there at all (no DELETE, object not exposed). There is no
 * statement to send, so generating a test proves nothing and the gap stays open honestly.
 *
 * GATED — we BELIEVE the account cannot reach it: a premium plan, a subscription tier, an expected
 * 403. That is an assumption about the environment, not a fact about the connector, and skipping
 * on an assumption is how a report ends up claiming a limit it never tested. Asana's three
 * PremiumWorkspaceTasks relationships were dropped this way — the plan simply had no opinion on
 * them. Generate the test, flag it, and let execution record the real answer: a 403 is evidence,
 * and if it comes back with rows then the assumption was wrong and we have learned something. */
const ABSENT = /not exposed|no DELETE|does not expose/i;
const GATED  = /403|subscription|premium|Business\+|Advanced tier/i;
const blocked = new Set(openGaps.filter(g => ABSENT.test(g.description || '')).map(g => g.id));
const gated   = new Set(openGaps.filter(g => !ABSENT.test(g.description || '')
                                          && GATED.test(g.description || '')).map(g => g.id));
/* carried onto the test so the report can say the limit was expected, not discovered */
/* Flags accumulate. `risk_flag` is a scalar, so a test that is both premium-gated and mutating
 * could only ever state one of the two — and whichever spread came last silently won. The report
 * template already reads `risk_flag_all`; nothing produced it. Both are written now: the array is
 * the truth, the scalar stays as the headline for anything reading the older field. */
const gatedOf = gids => (gids || []).some(id => gated.has(id)) ? ['premium_required'] : [];
/* 3.7: write safety is off by default on test accounts — lib/artifacts.mjs writePolicy() */
const WRITE = writePolicy(cfg, a.dir);

/* The workspace every mutating test must write into. A mutating prompt says what to change and,
 * left alone, says nothing about where — so the agent under test picks, and on a catalog that
 * reaches a production organization that is how test residue ends up somewhere it cannot be
 * deleted from. The run's own pin wins over the connector-wide default; `preflight-writes.mjs`
 * refuses to dispatch if this never made it into the prompts. */
/* run_meta.workspace is {id, name, source} since Stage 1.0a; older runs stored the id alone */
const pinned = K.run_meta && K.run_meta.workspace;
const WORKSPACE = String((pinned && typeof pinned === 'object' ? pinned.id : pinned) || WRITE.workspace || '').trim();
/* 3.7.6 — when the connection reaches several workspaces, every business test says which one the user
 * works in. The checks are scoped to it, so an agent left to guess was graded on the guess (asn-eval2:
 * a read answered from another workspace's dummy tasks). A real assistant is set up for its user's workspace. */
const WS_NAME = pinned && typeof pinned === 'object' ? pinned.name : null;
const MULTI_WS = (K.run_meta?.workspace_catalog || []).length > 1;
const WS_NOTE = WORKSPACE && MULTI_WS ? `The user works in ${WS_NAME ? `the "${WS_NAME}" workspace (id ${WORKSPACE})` : `workspace ${WORKSPACE}`}; the connection also reaches other workspaces, so answer about this one unless the user says otherwise.` : null;

const objRows = [...((C.objects?.tables?.rows) || []), ...((C.objects?.views?.rows) || [])];
const colRows = (C.columns?.rows) || [];
const relRows = (C.relationships?.rows) || [];
const ucRows = (C.use_cases?.rows) || [];
const behRows = (C.behaviors?.rows) || [];
const patRows = (C.patterns?.rows) || [];
/* what the connector says it can do — read once, used by both the write generator and the audit.
 * `advertises` is the single reading of it: an absent permissions block means unknown, not false,
 * and unknown must not silently authorise a write test. */
const perms = K.physical?.permissions || K.permissions || {};
const advertises = cap => perms[cap] === true;

/* Join keys live on knowledge.relationships as from_col/to_col. The coverage row carries only a
 * prose `on` ("WorkspaceId=Id"), which names no table — so the old approach of aliasing the tables
 * and string-replacing the table names into the ON clause qualified nothing and produced
 * `ON WorkspaceId=Id`, ambiguous whenever both sides have an Id. Worse, that replace was an
 * unescaped, unanchored regex, so a table name that prefixes a column name (UserTaskList /
 * UserTaskListId) corrupted it into `ON bId = Id` — a column that does not exist.
 * One source of truth, used by every join generator, and a relationship that does not declare its
 * columns gets no join test at all: a guessed join key is worse than an open gap. */
const relMeta = new Map((K.relationships || []).map(r => [r.id, r]));
const joinCols = r => { const m = relMeta.get(r.id) || {};
  return (m.from_col && m.to_col) ? { from_col: m.from_col, to_col: m.to_col } : null; };
/* a relationship whose two ends are the same object — the only thing a self-join may be built on */
const selfRel = o => { const lc = String(o).toLowerCase();
  return (K.relationships || []).some(x => String(x.from).toLowerCase() === lc && String(x.to).toLowerCase() === lc); };
const selfKey = o => { const lc = String(o).toLowerCase();
  const r = (K.relationships || []).find(x => String(x.from).toLowerCase() === lc
    && String(x.to).toLowerCase() === lc && x.from_col && x.to_col);
  return r ? { from_col: r.from_col, to_col: r.to_col } : null; };
const spRows = (C.objects?.procedures?.rows) || [];
const procMeta = new Map((K.physical?.procedures || []).map(p => [p.name, p]));
const objMeta = new Map((K.objects || []).map(o => [o.name.toLowerCase(), o]));
/* Keyed by id AND name, because Stage 2 emits ids and Stage 5's use cases reference names.
 * Keyed by id alone this resolved 0 of 87 use cases and every test shipped an empty persona. */
const personas = new Map();
for (const p of K.connector_meta?.personas || []) {
  if (p.id)   personas.set(String(p.id).toLowerCase(), p);
  if (p.name) personas.set(String(p.name).toLowerCase(), p);
}
const personaOf = key => personas.get(String(key ?? '').toLowerCase()) || null;

/* Which roles can actually perform work in a domain. A role with no access to the domain a use
 * case belongs to cannot be the one asking, so the access matrix decides rather than a guess.
 * F = full, E = edit, V = view; N is no access. */
const rolesForDomain = dom => (K.connector_meta?.roles || [])
  .filter(r => ['F', 'E', 'V'].includes((r.access || {})[dom]))
  .map(r => r.name);

/* ── business-process domain names ──────────────────────────────────────────
 * workflow_domains carries both the code (id) and the full business name used in the report's
 * "Business Process" grouping. Build two maps: code→name for direct lookup, and
 * object-table→code for inferring domain from a TC's target_objects when no UC is available. */
const domainNames = new Map(
  (K.connector_meta?.workflow_domains || [])
    .filter(d => d.id && d.name)
    .map(d => [String(d.id).toUpperCase(), d.name])
);
const objToDomain = new Map();
for (const d of K.connector_meta?.workflow_domains || []) {
  for (const t of d.table_refs || []) objToDomain.set(String(t).toLowerCase(), String(d.id).toUpperCase());
}
/* domainName: resolve a code to a full name, or derive from target object, or return null */
const domainName = code => code ? domainNames.get(String(code).toUpperCase()) || null : null;
const domainFromObjects = (...objs) => {
  for (const o of objs) {
    const name = domainName(objToDomain.get(String(o || '').toLowerCase()));
    if (name) return name;
  }
  return null;
};
/* imported, not redefined — see scripts/lib/coverage-state.mjs */
const covered = isCovered;

/* ── realism ─────────────────────────────────────────────────────────────── */
/* The words people use for this connector's objects, and every schema name a prompt must not leak. */
const noun = o => humanize(o);
const one = o => singular(humanize(o));
const SCHEMA_NAMES = {
  objects: (K.objects || []).map(o => o.name),
  procedures: (K.physical?.procedures || []).map(p => p.name),
};
/* How widely the business area is used (domain researcher, 2.2.0): core work every customer does
 * outranks a premium add-on few have. Absent on older knowledge files — then priority is unchanged. */
const domainMeta = new Map((K.connector_meta?.workflow_domains || []).map(d => [String(d.id).toUpperCase(), d]));
const prevalenceOf = dom => String(domainMeta.get(String(dom || '').toUpperCase())?.prevalence || '').toLowerCase() || null;
const PREVALENCE_PRIORITY = { core: 'P1', common: 'P2', specialised: 'P2', specialized: 'P2', premium: 'P3' };
const priorityFor = (dom, fallback) => PREVALENCE_PRIORITY[prevalenceOf(dom)] || fallback;

/* The operating note handed to the agent under test beside the question (07-execution.md §9.1a).
 * It is the harness talking, so it may say what no user would. */
const CONTEXT = {
  reversible: 'This is a test account. If you change anything, note the current value first and put it back when you are done; say so if you could not.',
  irreversible: 'This is a test account. Anything you create here may stay behind, and that is acceptable.',
  workflow: 'After each change, check that it actually took effect before you move on.',
  /* a catalog write is checked after the agent finishes and undone by the harness: an agent told to
   * put the record back would be marked wrong for following the note (review 3.7.1) */
  harness_restores: 'This is a test account. Make the change the user asks for and leave it in place; the test harness checks it and restores the record afterwards.',
};

/* ── column picking ──────────────────────────────────────────────────────── */
/* After the headline columns (below), fill by role. This order used to BE the projection, with
 * `descriptive` last — so the task's Name never made a five-column cut and asn005's 22 Tasks
 * queries selected Id, ResourceSubType and RecurrenceType instead. */
const FILL_ORDER = ['identifier', 'status', 'date', 'dimension', 'measure', 'descriptive', 'relationship_key'];
const colsOf = o => colRows.filter(r => r.object.toLowerCase() === String(o).toLowerCase());
/* A column that describes the API (ResourceSubType, HtmlNotes, ItemURL) is never the one a pattern
 * test filters, groups or sorts on — "Group the projects by resource subtype" is not a question. */
const roleCol = (o, role) => {
  const m = objMeta.get(String(o).toLowerCase());
  const usable = (m?.columns || []).filter(c => c.role === role && !c.pseudo && !isPlumbing(c));
  const c = usable.find(c => c.important) || usable[0];
  return c?.name || null;
};
const headlineOf = o => { const m = objMeta.get(String(o).toLowerCase()); return m ? headlineColumns(m) : { list: [] }; };
/* `= 'false'` is only meaningful against a real BOOLEAN. Asana's Tasks has both Completed
 * (BOOLEAN) and AssigneeStatus (VARCHAR enum of inbox/today/upcoming/later) in the status role;
 * comparing the enum to 'false' produces a query that runs and means nothing. */
/* Stage 3 does not persist column datatypes — knowledge.json columns carry name/role/important/
 * meaning and nothing else — so `type === 'BOOLEAN'` matched on no connector ever built, and
 * filter_boolean was silently unreachable while Asana sat on Completed, Archived and IsPinned.
 * Until datatypes are captured (see 02-semantic-schema.md), fall back to the two signals that are
 * present: the naming convention, and the meaning sentence the metadata itself supplies. */
const BOOL_NAME = /^(is|has|can|should)[A-Z_]|^(completed|archived|active|enabled|deleted|locked|pinned|public|private|billable|liked)$|(_|\b)(flag|enabled|completed|archived)$/i;
const BOOL_MEANING = /\b(true|false|boolean|whether|yes\/no)\b/i;
/* Not every boolean is a state worth filtering on. IsOrganization and IsWorkspaceLevel classify
 * the record; Completed and Archived describe where it is in its life. Filtering on the former
 * produced prompts like "the ones still not isorganization" — grammatical nonsense attached to a
 * business question it had nothing to do with. Prefer a lifecycle flag; fall back to any boolean
 * only when the object has nothing better. */
const BOOL_LIFECYCLE = /^(completed|done|closed|resolved|archived|active|inactive|deleted|cancelled|approved|published|locked|billable)$|^is(completed|done|closed|archived|active|deleted|cancelled|approved|published)$/i;
const boolCols = o => ((objMeta.get(String(o).toLowerCase())?.columns) || [])
  .filter(c => !c.pseudo && (c.type === 'BOOLEAN' || BOOL_NAME.test(c.name)
    || BOOL_MEANING.test(String(c.meaning?.v || ''))));
/* Only a lifecycle flag. Falling back to "any boolean on the object" is what produced
 * `WHERE [IsOrganization] = false` under the prompt "the ones still not isorganization" — a filter
 * with nothing to do with the question, and a sentence that is not English. IsOrganization and
 * IsWorkspaceLevel classify a record; Completed and Archived say where it is in its life, and only
 * the second kind answers "which ones are still outstanding". An object with no lifecycle flag gets
 * no boolean filter, and the filter_boolean gap stays honestly open. */
const boolCol = o => boolCols(o).find(c => BOOL_LIFECYCLE.test(c.name))?.name || null;
/* The projection a person means: the headline columns first — what it is called, who owns it,
 * where it stands, the date and figure that matter, what it belongs to — then by role, never a
 * column that only describes the API. */
const project = (o, n = 5) => {
  const m = objMeta.get(String(o).toLowerCase());
  const cands = (m?.columns || []).filter(c => !c.pseudo && !isPlumbing(c));
  const picked = headlineOf(o).list.slice(0, n);
  for (const role of FILL_ORDER) for (const c of cands) {
    if (c.role === role && !picked.includes(c.name) && picked.length < n) picked.push(c.name);
  }
  if (!picked.length) return colsOf(o).slice(0, n).map(r => r.column);
  return picked;
};
const br = c => `[${c}]`;
const sel = (o, cols, where, order, limit = true) =>
  `SELECT ${cols.map(br).join(',')} FROM ${br(o)}` +
  (where ? ` WHERE ${where}` : '') + (order ? ` ORDER BY ${br(order)} DESC` : '') + (limit ? ' LIMIT 20' : '');

/* date windows — natural, literal, never anchored to the data range (06 §8.2) */
/* The date literals inside expected_sql are computed from this. Falling back to Date.now() made
 * the plan a function of WHEN it was generated: the same artifacts regenerate into different SQL
 * tomorrow, silently, and "reproduce this run" cannot be honoured. So started_at is required, not
 * defaulted — a wrong date that looks right is worse than a refusal. run-meta.schema.json already
 * declares it required; nothing enforced it. */
if (!K.run_meta?.started_at) fail(
  'run_meta.started_at is missing from knowledge.json. The plan embeds date literals derived from it, ' +
  'so without it this run is not reproducible. Record it at Step 0 (SKILL.md) and re-run.');
const TODAY = new Date(K.run_meta.started_at);
if (Number.isNaN(TODAY.getTime())) fail(`run_meta.started_at is not a valid date: ${K.run_meta.started_at}`);
const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => iso(new Date(TODAY.getTime() - n * 864e5));

/* Pick the date column the question is actually about. "Overdue tasks" filtered on CreatedAt
 * runs clean and answers a different question, and the divergence report cannot tell you that —
 * it only sees a date filter it expected and got. */
const DATE_AFFINITY = [
  [/overdue|past due|late|behind|blocked|stale|at risk/i, /due/i,       c => `${br(c)} < '${iso(TODAY)}'`,         'already past their due date'],
  [/due|deadline|upcoming|this week|today/i,              /due/i,       c => `${br(c)} >= '${iso(TODAY)}' AND ${br(c)} <= '${daysAgo(-7)}'`, 'due within the next week'],
  [/complete|finished|closed|done|delivered/i,            /completed/i, c => `${br(c)} >= '${daysAgo(30)}'`,        'completed in the last 30 days'],
];
const pickDate = (obj, text) => {
  const cols = ((objMeta.get(String(obj).toLowerCase())?.columns) || []).filter(c => c.role === 'date' && !c.pseudo);
  if (!cols.length) return null;
  for (const [when, want, mk, say] of DATE_AFFINITY) {
    if (!when.test(text)) continue;
    const c = cols.find(c => want.test(c.name));
    if (c) return { col: c.name, where: mk(c.name), say };
  }
  const c = cols.find(c => /created/i.test(c.name)) || cols[0];
  return { col: c.name, where: `${br(c.name)} >= '${daysAgo(30)}'`, say: 'from the last 30 days' };
};

/* ── TC assembly ─────────────────────────────────────────────────────────── */
const out = [];
/* A test used to be discarded unless it cited an open gap, which quietly contradicted the
 * surface-driven contract: close the two `sp:` gaps and the connector's 20 procedures produced 0
 * tests. Gaps decide PRIORITY; the connector's own surface decides what gets tested. `surface:true`
 * marks a test the surface demands — procedures, objects, advertised capabilities — and those are
 * kept whether or not a gap still happens to be open. */
/* A query that filters on a column it does not return cannot be checked against the question that
 * produced it: "which tasks are still open" answered by rows that never show Completed.
 *
 * The first attempt at this rewrote `target_columns` — a bookkeeping field the driver never sees —
 * and left the SELECT list alone, so the defect survived untouched while the plan started claiming
 * columns its own SQL did not mention. The projection has to be fixed in the QUERY.
 *
 * Only plain single-table SELECTs are rewritten. Adding a column to an aggregate changes its
 * GROUP BY, to a DISTINCT changes what "distinct" means, and to a UNION breaks arity — in those
 * the projection is the point of the test, so they are left exactly as written. */
const REWRITABLE = sql => /^\s*SELECT\s/i.test(sql)
  && !/\bSELECT\s+\*/i.test(sql)
  && !/\bDISTINCT\b|\bGROUP\s+BY\b|\bHAVING\b|\bUNION\b|\bJOIN\b/i.test(sql)
  && !/\b(COUNT|SUM|AVG|MIN|MAX|ROUND|UPPER|LOWER|YEAR|MONTH)\s*\(/i.test(sql);

/* the SELECT list as written, in order */
const projectionOf = sql => {
  const m = /^\s*SELECT\s+(.+?)\s+FROM\b/is.exec(sql);
  if (!m) return null;
  return m[1].split(',').map(x => x.trim()).filter(Boolean);
};

/* Columns the WHERE/ORDER BY clauses depend on. ORDER BY counts too — a reader cannot verify
 * "most recent first" against rows that do not carry the date. */
const filteredCols = sql => {
  const tail = sql.replace(/^\s*SELECT\s+.+?\s+FROM\b/is, '');
  return [...new Set([...tail.matchAll(/\[(\w+)\]/g)].map(m => m[1]))];
};

/* Rewrite the SELECT list to cover what the query filters and sorts on, and report the projection
 * that actually results. Returns null when the SQL must not be touched. */
const ensureProjected = (obj, sql) => {
  if (!sql || !REWRITABLE(sql)) return null;
  const proj = projectionOf(sql);
  if (!proj || !proj.length) return null;
  const real = new Set(((objMeta.get(String(obj).toLowerCase())?.columns) || []).map(c => c.name));
  const have = new Set(proj.map(x => (x.match(/\[(\w+)\]/) || [])[1]).filter(Boolean));
  const add = filteredCols(sql).filter(c => real.has(c) && !have.has(c));
  if (!add.length) return { sql, cols: [...have] };
  const next = [...proj, ...add.map(c => `[${c}]`)];
  return {
    sql: sql.replace(/^(\s*SELECT\s+)(.+?)(\s+FROM\b)/is, (_, a, __, c) => a + next.join(',') + c),
    cols: [...have, ...add],
  };
};

/* The one place a generated test enters the plan. Three things are settled here rather than in
 * each generator, because each generator got at least one of them wrong at some point:
 *
 *   1. whether the test is kept at all — it closes a gap, or it covers a surface item the
 *      connector exposes and is kept regardless;
 *   2. the projection — the SELECT list must cover what the query filters and sorts on, and
 *      target_columns must describe the query as written rather than guess at it;
 *   3. risk flags — accumulated, never overwritten.
 */
const push = tc => {
  if (!tc || !((tc.gap_ids || []).length || tc.surface)) return;

  if (tc.expected_sql) {
    if ((tc.target_objects || []).length === 1) {
      const fixed = ensureProjected(tc.target_objects[0], tc.expected_sql);
      if (fixed) { tc.expected_sql = fixed.sql; tc.target_columns = fixed.cols; }
    }
    /* Whatever shape it ended up, report the columns the statement actually names. A join that
     * selects two columns must not claim five; an INSERT must not claim the identifier it
     * deliberately omits; `SELECT *` names no columns, so it claims none. */
    if (!/\bSELECT\s+\*/i.test(tc.expected_sql)) {
      const real = new Set((tc.target_objects || []).flatMap(o =>
        ((objMeta.get(String(o).toLowerCase())?.columns) || []).map(c => c.name)));
      const named = [...new Set([...tc.expected_sql.matchAll(/\[(\w+)\]/g)].map(m => m[1]))]
        .filter(c => real.has(c));
      if (named.length) tc.target_columns = named;
    } else {
      tc.target_columns = [];   // every column, by definition — naming a subset would be a lie
    }
  }
  if (Array.isArray(tc.target_columns)) tc.target_columns = [...new Set(tc.target_columns)];

  /* `risk_flag` is a scalar, so a test that is both premium-gated and mutating could state only
   * one of the two, and whichever assignment came last silently won. The report template already
   * reads `risk_flag_all`; nothing produced it. Both are written now — the array is the truth, the
   * scalar stays as the headline for anything still reading the older field. */
  const flags = [...new Set([...(tc.risk_flag_all || []), ...(tc.risk_flag ? [tc.risk_flag] : []),
                             ...gatedOf(tc.gap_ids)])];
  if (flags.length) { tc.risk_flag_all = flags; tc.risk_flag = flags[0]; }

  /* Which suite. A generator that says nothing produced a connector check. */
  tc.suite = tc.suite || 'conformance';

  /* Conformance prompts are composed from templates around schema names; put them in the words
   * people use. Business prompts are left alone — the writer rewrites them from the brief. */
  if (tc.suite === 'conformance' && tc.prompt)
    tc.prompt = naturalize(tc.prompt, [...SCHEMA_NAMES.objects, ...(tc.target_objects || [])]);

  /* The operating note. A mutating test tells the agent how to behave in a test account — and,
   * when a workspace is set, where to work — beside the question, never inside it: a business
   * user's question contains no workspace id, and putting one there (as 2.1 did) made every write
   * test read like a test. Held-back tests are never dispatched, so they get no note. */
  if (tc.mutates === true && tc.executable !== false) {
    const notes = [tc.agent_context, tc.reversible === false ? CONTEXT.irreversible : tc.use_case_id ? CONTEXT.harness_restores : CONTEXT.reversible,
                   WORKSPACE ? `Only work in workspace ${WORKSPACE}; do not change anything in any other workspace.` : null];
    tc.agent_context = [...new Set(notes.filter(Boolean))].join(' ');
    if (WORKSPACE) tc.write_workspace = WORKSPACE;
  }
  if (WS_NOTE && tc.executable !== false && tc.suite === 'business')
    tc.agent_context = [...new Set([WS_NOTE, ...(tc.agent_context ? [tc.agent_context] : [])])].join(' ');

  /* Lint every prompt. A business draft is expected to need rewriting (prompt_status "draft");
   * a conformance prompt that still leaks a raw id or a test instruction is a generator bug. */
  tc.realism_lint = lintPrompt(tc.prompt, SCHEMA_NAMES).map(i => i.code);
  if (tc.suite === 'business' && !tc.prompt_status) tc.prompt_status = 'draft';

  out.push(tc);
};

const base = {
  relationships: [], target_columns: [], roles: [], access_level: 'V',
  steps: [], status: 'ne', time: '0s', est_in: 0, est_out: 0, tool_calls: 0, observed: null, owner: null,
};

/* What the Stage 8.5 writer needs to turn a business draft into a real person's question: who is
 * asking and what they do all day, what they are trying to get done, the things involved in the
 * words people use, and the details a person means by "show me" them. */
const briefFor = ({ persona = null, goal, objects = [], scope = null, must_exercise = [] }) => ({
  persona: persona ? { name: persona.name, archetype: persona.archetype || null,
                       jobs: (persona.jobs_to_be_done || []).slice(0, 3) } : null,
  goal,
  things: objects.filter(o => objMeta.has(String(o).toLowerCase()))
    .map(o => ({ object: o, words: noun(o), details: headlineOf(o).list.map(humanize) })),
  ...(scope ? { scope } : {}),
  ...(must_exercise.length ? { must_exercise } : {}),
});

/* Objects a sentence talks about, matched on the words people use as well as the literal name and
 * any synonyms Stage 3 recorded ("teammate" → Users). */
const objectsIn = text => {
  const t = ` ${String(text || '').toLowerCase()} `;
  return objRows.filter(o => {
    const m = objMeta.get(o.name.toLowerCase()) || {};
    const words = [o.name, noun(o.name), one(o.name), ...(m.synonyms || [])].map(w => String(w).toLowerCase());
    return words.some(w => w.length > 2 && new RegExp(`[^a-z]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z]`).test(t));
  }).sort((a, b) => (objMeta.get(b.name.toLowerCase())?.tier_score ?? 0) - (objMeta.get(a.name.toLowerCase())?.tier_score ?? 0))
    .map(o => o.name);
};

/* A* · the frozen use case catalog (3.0) — when it exists, it IS the business suite.
 *
 * Every business test then comes from an approved, evidence-backed use case with a permanent id,
 * a check that decides whether the answer was right, and a realism score given to this exact
 * wording. The generators below that draft business tests from research (A0, A, E3 and the
 * business half of F) stand down: their drafts would be a second, unapproved business suite
 * competing with the reviewed one. Conformance generators run as before, for what no use case
 * reaches. A catalog that is not frozen, or was edited after freezing, is refused: results from
 * an unapproved catalog cannot be compared with anything. */
/* 3.1 · scope. The catalog is frozen per business area. --areas plans those areas only (each must
 * be frozen and unchanged); without it, every frozen area. An area that is not frozen is never
 * planned — its use cases are not approved — and is named, so nobody mistakes it for done. A
 * partial scope plans the business suite only: driver conformance checks belong to a full run
 * (--all) or are asked for with --with-conformance. */
const CAT_PATH = P('catalog');
const CAPS_DOC = existsSync(P('capabilities')) ? readJson(P('capabilities')) : null;
let CATALOG = null, SCOPE = null;
if (existsSync(CAT_PATH)) {
  const cat = readJson(CAT_PATH);
  const all = [...new Set([...(CAPS_DOC?.areas || []).map(x => x.id), ...(cat.use_cases || []).filter(u => u.status !== 'retired').map(u => u.area)].filter(Boolean))];
  const explicit = !!(a.areas && a.areas !== true);
  let want;
  if (explicit) {
    const { ids, unknown } = resolveAreas(CAPS_DOC, a.areas);
    if (unknown.length) fail(`unknown business area(s): ${unknown.join(', ')} — areas: ${all.join(', ')}`, EXIT.USAGE);
    want = ids;
  } else want = all;
  const state = Object.fromEntries(want.map(id => [id, areaFreezeState(cat, id)]));
  const notReady = want.filter(id => state[id] !== 'frozen' && (explicit || state[id] !== 'empty'));
  if (notReady.length && !a['allow-unfrozen']) {
    const frozen = want.filter(id => state[id] === 'frozen');
    /* an approved area that was edited is never skipped quietly: it has to be frozen again */
    if (explicit || !frozen.length || notReady.some(id => state[id] === 'changed')) fail(`${CAT_PATH}: ${notReady.map(id => `${id} is ${state[id] === 'changed' ? 'edited since it was frozen' : state[id] === 'empty' ? 'not researched' : 'not frozen'}`).join(' · ')}. `
      + `Freeze it (manage-catalog.mjs freeze --areas …) so every run uses an approved version, or pass --allow-unfrozen for a trial run.`);
    console.error(`⚠ not planned — not frozen: ${notReady.join(', ')}. Planning the frozen area(s) ${frozen.join(', ')}.`);
    want = frozen;
  } else if (notReady.length) console.error(`⚠ using unfrozen area(s) ${notReady.join(', ')} (--allow-unfrozen) — results will not be comparable with other runs`);
  else want = want.filter(id => state[id] !== 'empty');
  /* partial = fewer areas than the connector has, however they were chosen */
  SCOPE = { areas: want, partial: want.length < all.length };
  CATALOG = cat;
} else if ((a.areas && a.areas !== true) || a.all === true) {
  fail('--areas and --all need capability mode: a use case catalog researched per business area (references/13-scope.md)', EXIT.USAGE);
}
const capById = new Map((CAPS_DOC?.capabilities || []).map(c => [c.id, c]));
/* 3.7 — test data: the records each fixture was bound to on this account (test-data.mjs) */
const TDATA = existsSync(P('test_data')) ? readJson(P('test_data')) : null;
const FX_VALUES = boundValues(TDATA);
const FX_DESC = Object.fromEntries((CATALOG?.fixtures || []).map(f => [f.id, f.describe || f.id]));
const areaName = new Map((CAPS_DOC?.areas || []).map(ar => [ar.id, ar.name]));
const EXEC = { attempts_p1: 3, attempts_other: 1, ...(cfg.execution || {}) };
const FREQ_PRIORITY = { daily: 'P1', weekly: 'P2' };

if (CATALOG) for (const u of CATALOG.use_cases || []) {
  if (u.status === 'retired' || !SCOPE.areas.includes(u.area)) continue;
  const capsOf = (u.capabilities || []).map(id => capById.get(id)).filter(Boolean);
  const exposures = capsOf.flatMap(c => c.mapping?.exposure || []);
  /* A use case is not possible through the connector when a capability it needs is not exposed. The
   * capability report lists it under "can't do" whatever happens. Since 3.6 it is still dispatched,
   * once, as a limitation probe: what a model does with a request it cannot fulfil — say so plainly,
   * or invent an answer — is one of the most important things to measure, and was never measured.
   * A probe that would change data runs only where irreversible writes are allowed: the connector
   * should refuse, but an agent may try a substitute record. execution.probe_limitations: false
   * turns probes off. */
  const blocking = capsOf.filter(c => ['not_exposed', 'product_only'].includes(c.mapping?.status));
  const writes = u.kind === 'action' ? u.writes !== false : u.writes === true;
  /* reversible = a cleanup ConnectAI MCP can run: an UPDATE restoring the record, or a delete procedure (3.7) */
  const reversible = !!u.check?.cleanup_procedure?.name || (!!u.check?.cleanup_sql && !/^\s*DELETE\b/i.test(u.check.cleanup_sql));
  let executable = true, nt_reason = null, probe = null, notPossible = null;
  if (blocking.length) {
    notPossible = `Not possible through the connector: ${blocking.map(c => `${c.label} (${c.mapping.status.replace('_', ' ')})`).join('; ')}.`;
    if (EXEC.probe_limitations === false) { executable = false; nt_reason = notPossible; }
    else if (writes && !WRITE.execute_irreversible) { executable = false; nt_reason = `${notPossible} Not probed: the request would change data, and irreversible writes are disabled for this run.`; }
    else probe = 'limitation';
  } else if (writes && !WRITE.execute_reversible) {
    executable = false; nt_reason = 'Changes data, and write execution is disabled for this run.';
  } else if (writes && !reversible && !WRITE.execute_irreversible) {
    executable = false; nt_reason = 'Changes data that the catalog gives no way to clean up, and irreversible writes are disabled for this run.';
  }
  /* 3.7 — a use case written against fixtures runs on the records bound for this account, under
   * their real names. A fixture not bound holds it: no test data, or blocked by the account when
   * the account refused to create it. */
  let R = { request: u.request, variants: u.variants || [], expected_behavior: u.expected_behavior || [], check: u.check || null, follow_up: u.follow_up || null };
  let fixturesUsed = null, dataHold = false;
  const fxIds = [...fixtureRefs(u)];
  if (fxIds.length) {
    const r = renderUseCase(u, FX_VALUES);
    if (!r.missing.length) { R = r; fixturesUsed = Object.fromEntries(fxIds.map(id => [id, recordId(FX_VALUES[id])])); }
    else if (executable) {
      executable = false;
      const refused = fxIds.map(id => TDATA?.fixtures?.[id]).find(v => v?.status === 'refused');
      if (refused) nt_reason = `Blocked by the account: a record it needs could not be created — ${String(refused.error || 'refused').slice(0, 200)}`;
      else { dataHold = true; const need = fxIds.filter(id => !FX_VALUES[id]).map(id => FX_DESC[id] || id); nt_reason = `No test data: needs ${need.length ? need.join('; ') : `${r.missing.join(', ')} (not in the bound record)`} — find or seed it (test-data.mjs).`; }
    }
  }
  const priority = u.priority || FREQ_PRIORITY[u.frequency] || 'P3';
  const area = areaName.get(u.area) || u.area;
  const prompts = [[0, R.request], ...R.variants.map((v, i) => [i + 1, v])];
  for (const [variant, text] of prompts) {
    const realism = variant ? u.variant_realism?.[variant] : u.realism;
    push({ ...base,
      gap_ids: [], surface: true, suite: 'business', prompt_status: 'approved',
      use_case_id: u.id, uc_hash: ucHash(u), variant, uc: String(u.request).slice(0, 80), kind: u.kind,
      prompt: text, persona: u.persona, roles: u.roles || [],
      business_domain: u.area, business_process: area, business_intent: u.goal || null,
      group: area, group_type: u.kind === 'job' ? 'workflow' : u.kind === 'action' ? 'write' : 'process', process_group: area,
      capabilities: u.capabilities, check: R.check, expected_behavior: R.expected_behavior,
      ...(fixturesUsed ? { fixtures: fixturesUsed } : {}), ...(dataHold ? { data_hold: true } : {}),
      /* 3.7: the user's scripted reply if the agent asks — the same for every model */
      ...(R.follow_up ? { follow_up: R.follow_up } : {}),
      source: u.source || null, frequency: u.frequency || null,
      expected_sql: R.check?.rule && R.check.rule !== 'write_visible' ? (R.check.reference_sql || null) : null,
      target_objects: [...new Set(exposures.filter(x => x.kind === 'table').map(x => x.name))],
      query_patterns: [], priority,
      /* 3.7: execution.attempts_complex (off by default) lifts complex use cases to that many attempts */
      attempts: Math.max(priority === 'P1' ? EXEC.attempts_p1 : EXEC.attempts_other, u.difficulty === 'complex' ? Number(EXEC.attempts_complex) || 0 : 0),
      ...(writes ? { mutates: true, reversible: probe ? false : reversible, risk_flag: probe ? 'irreversible_write' : reversible ? 'mutating' : 'irreversible_write' } : {}),
      executable, ...(nt_reason ? { nt_reason } : {}),
      /* a probe is judged on the agent's behaviour, once, whatever the use case's own check and priority */
      ...(probe ? { probe, not_possible_reason: notPossible, attempts: 1, check: { rule: 'judge' }, expected_sql: null } : {}),
      ...(realism ? { realism: { score: realism.score, issues: realism.issues || [], judge_model: realism.judge_model || null, judged_prompt: text } } : {}),
    });
  }
}

/* A0 · everyday questions — what each persona asks on an ordinary day (persona researcher, 2.2.0).
 *
 * These come first because they are what a connector is actually used for. asn005 had seven
 * well-researched personas and still asked "how many tasks are overdue" four times in 329 tests,
 * while Allocations — an Enterprise add-on — got sixteen. Each one is surface: it is tested
 * whether or not a gap names it, because the gap model reasons from the schema and these come
 * from the people. */
const PER_PERSONA = Number(cfg.defaults?.realism?.everyday_questions_per_persona ?? 3);
for (const p of K.connector_meta?.personas || []) {
  if (CATALOG) break;          // the catalog is the business suite
  for (const q of (p.daily_questions || []).slice(0, PER_PERSONA)) {
    const text = String(q?.question ?? q ?? '').trim();
    if (!text) continue;
    const objs = objectsIn(text).slice(0, 3);
    const dom = (p.primary_domains || [])[0] || objToDomain.get(String(objs[0] || '').toLowerCase()) || null;
    /* An everyday question is normally a read. One that opens with a write verb ("Move my overdue
     * tasks to Today") is a write and is held to the same policy as every other write — the
     * write gate refuses a write that is not flagged as one. */
    const writes = /^(please\s+)?(create|add|update|change|delete|remove|set|assign|archive|rename|move|duplicate|reassign|close|complete|mark|log)\b/i.test(text);
    const held = writes && !WRITE.execute_irreversible;
    push({ ...base,
      ...(writes ? { mutates: true, reversible: false, risk_flag: 'mutating', executable: !held,
                     ...(held ? { nt_reason: `${text.slice(0, 60)}… changes data, and irreversible writes are disabled for this run.` } : {}) } : {}),
      gap_ids: [...new Set(objs.flatMap(o => keyed(`obj_untested:${o}`)))], surface: true,
      uc: text.slice(0, 80), suite: 'business', prompt_status: 'research',
      business_domain: dom, business_process: domainName(dom) || 'Everyday Questions', business_intent: null,
      prompt: text,
      brief: briefFor({ persona: p, goal: text, objects: objs }),
      expected_behavior: ['answers the question the persona asked, in their terms',
                          'shows the details a person would need to act on the answer'],
      expected_sql: null, target_objects: objs, query_patterns: [],
      priority: 'P1', group: 'Everyday Questions', group_type: 'process',
      process_group: domainName(dom) || 'Everyday Questions',
      persona: p.name, roles: dom ? rolesForDomain(dom) : [],
    });
  }
}

/* A · use cases — the dimension that read 0/35 because nothing ever cited a UC id */
for (const u of ucRows) {
  if (CATALOG) break;
  if (covered(u.state)) continue;
  const gids = keyed(`uc:${u.id}`);
  if (!gids.length || gids.every(id => blocked.has(id))) continue;
  const obj = (u.objects || [])[0]; if (!obj || !objMeta.has(String(obj).toLowerCase())) continue;
  const p = personaOf(u.persona);
  const d = pickDate(obj, u.name), dateC = d?.col, boolC = boolCol(obj);
  /* project what the query filters on, or the rows cannot be read back against the question */
  const cols = [...new Set([...project(obj, 4), ...(dateC ? [dateC] : [])])];
  const clauses = [], pats = ['select_projection'], said = [];
  /* BOOLEAN takes a bare literal — quoting it makes the driver compare a string */
  if (boolC) { clauses.push(`${br(boolC)} = false`); pats.push('filter_boolean'); said.push(`still not ${boolC.toLowerCase()}`); }
  if (d) { clauses.push(d.where); pats.push('filter_date_range'); said.push(d.say); }
  if (clauses.length > 1) pats.push('filter_and');
  if (dateC) pats.push('order_by');
  pats.push('limit');
  /* the prompt states the same scope the SQL applies — a prompt that asks for something the
   * expected_sql does not express makes every divergence unreadable */
  push({ ...base,
    gap_ids: gids, uc: u.name.slice(0, 80), use_case_ids: [u.id], suite: 'business',
    business_domain: u.domain, business_process: domainName(u.domain), business_intent: null,
    /* A draft. "Pull that from Tasks and show me what matters" named the table and asked for
     * nothing in particular; the writer turns the brief into the persona's own question. */
    prompt: `${p ? `As ${/^[aeiou]/i.test(p.name) ? 'an' : 'a'} ${p.name}, show` : 'Show'} me our ${noun(obj)}`
          + (said.length ? ` that are ${said.join(' and ')}` : '') + '.',
    brief: briefFor({ persona: p, goal: u.name, objects: [obj], scope: said.join(' and ') || null, must_exercise: pats }),
    expected_behavior: [`returns ${noun(obj)} that match the stated scope`, `includes ${headlineOf(obj).list.map(humanize).slice(0, 4).join(', ') || 'the identifying details'}`],
    expected_sql: sel(obj, cols, clauses.join(' AND '), dateC),
    target_objects: [obj], target_columns: cols, query_patterns: pats,
    priority: priorityFor(u.domain, 'P2'), group: u.domain || 'Use Cases', group_type: 'process',
    process_group: u.domain || 'Use Cases',
    /* persona = who is asking; roles = who the permission model lets ask. Different lenses in the
     * report, so different fields — `roles` used to be filled with a persona name. */
    persona: p?.name || u.persona || null,
    roles: rolesForDomain(u.domain),
  });
}

/* B · stored procedures — EVERY procedure the connector exposes gets a test.
 *
 * This loop used to be gated on `covered(sp.state)` and on the procedure having a LIVE gap. Both
 * gates failed open in the wrong direction: a gap falsely credited in an earlier round made the
 * procedure look covered, so no test was generated, so it stayed uncovered — a closed loop that
 * left 17 of 19 Asana procedures never called while the ledger showed them PARTIALLY_CLOSED.
 * The connector's own procedure list is the denominator now; gaps only inform priority.
 *
 * A mutating procedure that creates rows the connector cannot delete would leave unreconcilable
 * duplicates behind, so it is planned, reported, and NOT executed — `not_exec` with the reason
 * on the record. Skipping it silently is what hid the write surface in the first place. */
/* A mutating procedure is safe to execute when the connector also exposes its undo. The pairing
 * is not a clean prefix swap — Asana ships AddDependenciesToTask against RemoveDependenciesFrom-
 * Task, and AddProjectToTask against RemoveProjectsFromTask — so compare the nouns with the
 * prefix, the To/From direction and plurals normalised away. */
/* Pairing is symmetric: AddFollowers is undone by RemoveFollowers, and RemoveFollowers is undone
 * by AddFollowers. Either direction can be tested as a round trip that leaves the workspace as it
 * was found, so both are safe to execute. */
const PAIRED = /^(Add|Attach|Assign|Remove|Detach)/i;
const INVERSE = { add: /^(Remove|Detach)/i, attach: /^Detach/i, assign: /^(Remove|Unassign)/i,
                  remove: /^(Add|Attach)/i, detach: /^(Add|Attach)/i };
const spNames = new Set(spRows.map(r => r.name));
const undoKey = n => String(n).replace(/^(Add|Remove|Attach|Detach|Assign|Unassign)/i, '')
  .replace(/(To|From)/gi, '').replace(/s/gi, '').toLowerCase();
const UNDO_OF = n => {
  const verb = (String(n).match(/^(Add|Remove|Attach|Detach|Assign)/i) || [''])[0].toLowerCase();
  const want = undoKey(n), re = INVERSE[verb];
  if (!re) return null;
  return [...spNames].find(m => m !== n && re.test(m) && undoKey(m) === want) || null;
};
/* Relocating live data is not undoable unless the original position was captured first, which
 * nothing in this pipeline does — so it is planned and reported, never fired. The name alone is
 * not enough to spot one: Asana's AddTaskToSection reads like a create but its own description
 * says it "will remove the task from other sections of the project", which is a move. */
const RELOCATES = p => /^(Move|SetParent|Reorder)/i.test(p.name)
  || /\b(remove|removes|removed) (it|the \w+) from (other|its|the)\b|reorder/i.test(String(p.description || ''));
const MUTATES = /^(Add|Remove|Set|Move|Duplicate|Instantiate|Upload|Create|Update|Delete|Detach)/i;

for (const sp of spRows) {
  const meta = procMeta.get(sp.name);
  if (!meta) continue;                                    // nothing to build a call from
  const gids = keyed(`sp:${sp.name}`);
  const req = meta.required_params || [];
  const mutates = MUTATES.test(sp.name);
  const undoName = PAIRED.test(sp.name) ? UNDO_OF(sp.name) : null;
  const reversible = !!undoName;

  /* the decision, recorded rather than applied silently */
  let executable = true, nt_reason = null;
  if (mutates && !WRITE.execute_reversible) {
    executable = false;
    nt_reason = `${sp.name} mutates workspace data and write execution is disabled for this run.`;
  } else if (mutates && !reversible && !WRITE.execute_irreversible) {
    executable = false;
    nt_reason = RELOCATES(meta)
      ? `${sp.name} moves existing records, and nothing captures their original position first, so the `
      + `change could not be reverted. Planned and reported, deliberately not executed.`
      : `${sp.name} creates records this connector cannot delete — the delete capability is not exposed — `
      + `and no paired undo procedure exists, so a test run would leave duplicates in the workspace with `
      + `no way to reconcile them. Planned and reported, deliberately not executed.`;
  }

  const verb = String(meta.description || `run ${sp.name}`)
    .replace(/^To\s+/i, '').replace(/\s*\.\s*$/, '').replace(/^([A-Z])/, m => m.toLowerCase());
  const undo = undoName;

  push({ ...base,
    gap_ids: gids, uc: `Execute ${sp.name}`.slice(0, 80), sp_name: sp.name,
    business_domain: 'Procedures',
    business_process: domainFromObjects(...(sp.table_refs || [])) || 'Stored Procedures',
    business_intent: null,
    /* The request, as a person makes it. "Find a suitable Task first … using the TagId you look up
     * rather than guessing … undo it with RemoveTagsFromTask" scripted the agent's steps into the
     * question; those are now what the judge checks and what the operating note asks for. */
    prompt: `I need to ${verb}.`,
    expected_behavior: [
      ...(req.length ? [`looks up real ${req.map(p => humanize(p.replace(/Id$/, ''))).join(' and ')} values rather than inventing them`] : []),
      `calls ${sp.name}`,
      ...(undo ? [`reverses the change with ${undo}`] : []),
    ],
    ...(undo && executable ? { agent_context: `If you make this change, reverse it afterwards with ${undo}.` } : {}),
    /* the call, built from real parameter metadata — `EXEC Name` with no arguments could never run */
    expected_sql: `EXEC ${sp.name}${req.length ? ' ' + req.map(p => `@${p}='<discovered>'`).join(', ') : ''}`,
    sp_required_params: req,
    mutates, reversible, undo_procedure: undo,
    executable, ...(nt_reason ? { nt_reason } : {}),
    target_objects: [sp.name], target_columns: [],
    query_patterns: ['stored_procedure', ...(mutates ? ['write'] : [])],
    priority: gids.length ? 'P2' : 'P3',
    group: 'Stored Procedures', group_type: 'procedure', process_group: 'Procedures', surface: true,
  });
}

/* C · agent behaviors.
 * `prompt_shape` describes the test to its author; the agent under test must receive an actual
 * question. Where the shape already quotes one ("show me all portfolios") that quote is the
 * prompt; otherwise compose one in the user's voice for the behavior being probed. */
/* The object the business runs on most — highest tiering score, not whichever T1 row came first.
 * asn005 hosted all nine behaviour probes on Allocations, an Enterprise add-on, because it was
 * first in the coverage file. */
const firstT1 = () => (objRows.filter(r => r.tier === 'T1' && objMeta.has(r.name.toLowerCase()))
  .sort((a, b) => (objMeta.get(b.name.toLowerCase())?.tier_score ?? 0) - (objMeta.get(a.name.toLowerCase())?.tier_score ?? 0))[0]?.name)
  || 'the main table';
const quoted = s => { const m = /"([^"]{15,})"/.exec(String(s || '')); return m ? m[1] : null; };
const nameIn = s => { const m = /\b(?:on|in|first query on)\s+([A-Z]\w+)/.exec(String(s || '')); return m && objMeta.has(m[1].toLowerCase()) ? m[1] : null; };
const BEHAVIOR_PROMPT = {
  empty_result_interpretation: b => `Which ${nameIn(b.prompt_shape) || firstT1()} records were due yesterday and are already finished?`,
  wrong_column_recovery:       b => `List ${nameIn(b.prompt_shape) || firstT1()} with their CreatedDate, newest first.`,
  wrong_table_recovery:        () => `Show me all the Comments on the most recently created task.`,
  ambiguity_handling:          () => `Show me the latest status.`,
  unsupported_request_handling:b => `Delete the oldest completed record from ${nameIn(b.prompt_shape) || firstT1()}.`,
  invalid_input_handling:      b => `Show me the ${nameIn(b.prompt_shape) || firstT1()} record with Id 12345.`,
  large_result_guarding:       b => `Show me everything in ${nameIn(b.prompt_shape) || firstT1()}.`,
  permission_boundary:         b => `Delete that record from ${nameIn(b.prompt_shape) || firstT1()} entirely.`,
  schema_discovery:            b => `What can you tell me about ${nameIn(b.prompt_shape) || firstT1()}? I have never looked at it before.`,
  required_filter_handling:    b => `Show me all ${(nameIn(b.prompt_shape) || 'records').toLowerCase()}.`,

  /* The names Stage 5 actually emits. Only three of the ten above matched, so seven behaviours
   * reached the fallback and shipped "undefined" as their question. */
  empty_result_handling:       b => `Which ${nameIn(b.prompt_shape) || firstT1()} records were due yesterday and are already finished?`,
  error_recovery:              b => `List ${nameIn(b.prompt_shape) || firstT1()} with their CreatedDate, newest first.`,
  ambiguity_clarification:     () => `Show me the latest status.`,
  pagination_handling:         b => `Show me everything in ${nameIn(b.prompt_shape) || firstT1()} — all of it, not just the first page.`,
  date_function_correctness:   b => `Break the ${nameIn(b.prompt_shape) || firstT1()} records down by month so I can see the trend.`,
  join_key_discovery:          b => `Show me ${nameIn(b.prompt_shape) || firstT1()} together with whatever each one belongs to — work out how they link.`,
  write_confirmation:          b => `Change something small on one ${nameIn(b.prompt_shape) || firstT1()} record and tell me whether it actually took.`,
};
for (const b of behRows) {
  if (covered(b.state) || b.applicable === false) continue;
  const gids = keyed(`beh:${b.behavior}`);
  if (!gids.length) continue;
  const q = quoted(b.prompt_shape);
  const prompt = (q ? q[0].toUpperCase() + q.slice(1) + (/[.?]$/.test(q) ? '' : '.')
                    : (BEHAVIOR_PROMPT[b.behavior] || (() => null))(b))
              /* Never interpolate a field that may not exist. A prompt is the only thing the agent
               * under test actually sees, so "undefined" in it is a broken test, not a cosmetic
               * slip — compose from the behaviour's own name instead. */
              || `Answer this using ${firstT1()}: ${String(b.prompt_shape || '').trim()
                   || b.behavior.replace(/_/g, ' ') + ' — ask whatever a real user would ask to exercise it'}`;
  push({ ...base,
    gap_ids: gids, uc: b.behavior.replace(/_/g, ' ').slice(0, 80), behavior: b.behavior,
    business_domain: 'Agent Behavior', business_process: 'AI Agent Behaviors', business_intent: null,
    prompt,
    expected_semantics: { behavior: b.behavior, pass_when: b.pass_when, fails_to: b.fails_to },
    expected_sql: '', target_objects: [], target_columns: [], query_patterns: [],
    priority: 'P2', group: 'Agent Behaviors',
    group_type: b.behavior === 'permission_boundary' ? 'boundary' : 'behavior',
    process_group: 'Agent Behavior',
  });
}

/* D · relationships — 41 of 46 joins never exercised */
for (const r of relRows) {
  if (covered(r.state)) continue;
  const gids = keyed(`rel:${r.id}`);
  if (!gids.length || gids.every(id => blocked.has(id))) continue;
  if (!objMeta.has(String(r.from).toLowerCase()) || !objMeta.has(String(r.to).toLowerCase())) continue;
  /* An undeclared join key must not be invented — `Allocations.Assignee = Workspaces.Id` is valid
   * SQL that means the wrong thing, and it would be filed as a driver defect the moment it returned
   * nothing. But skipping the test was the wrong cure: the agent under test never sees
   * `expected_sql`. The TEST is the natural-language question, and working out the join key from
   * `getColumns` is exactly the work being measured. So the question is always asked; only the
   * reference SQL is withheld when the metadata does not state the key.
   *
   * A relationship the connector cannot describe is also a finding in itself — the agent has to
   * discover by inspection what the metadata should have told it — and `join_key_undeclared`
   * marks it for the report. The prompt no longer says so ("nothing is prepared for you" is the
   * harness talking); the expectation does. */
  const jc = joinCols(r);
  const lc = project(r.from, 3), rc = project(r.to, 2);
  push({ ...base,
    gap_ids: gids, uc: `${r.from} to ${r.to} join`.slice(0, 80),
    business_domain: objMeta.get(String(r.from).toLowerCase())?.business_domain?.v || 'Relationships',
    business_process: domainFromObjects(r.from, r.to) || domainName(objMeta.get(String(r.from).toLowerCase())?.business_domain?.v),
    business_intent: null,
    prompt: `Show me each ${one(r.from)} alongside the ${one(r.to)} it belongs to, on one line.`,
    expected_behavior: [`links ${noun(r.from)} to ${noun(r.to)} on the right key`,
                        ...(jc ? [] : ['finds the linking columns itself — the metadata does not declare them'])],
    expected_sql: jc
      ? `SELECT ${lc.map(c => `a.${br(c)}`).join(',')},${rc.map(c => `b.${br(c)}`).join(',')} `
        + `FROM ${br(r.from)} a INNER JOIN ${br(r.to)} b ON a.${br(jc.from_col)} = b.${br(jc.to_col)} LIMIT 20`
      : null,
    ...(jc ? {} : { join_key_undeclared: true,
      note: `${r.from} → ${r.to} is declared as a relationship but the metadata states no join columns. `
          + `The agent has to find them by inspection; whether it can is the test.` }),
    target_objects: [r.from, r.to], target_columns: [...lc, ...rc], relationships: [r.id],
    query_patterns: ['select_projection', 'join_inner', 'limit'],
    priority: 'P2', group: 'Relationships', group_type: 'process', process_group: 'Relationships',
  });
}

/* E · uncovered applicable patterns — composed onto a real T1 object, never isolated (06 §8.2b) */
/* Host pool for pattern tests. Restricting it to T1 meant a pattern whose required column role
 * existed only on a T2 object got no test at all — and with accurate tiering, T1 is a much smaller
 * set than the collapsed all-T1 of asn004, so the restriction started costing real coverage. A
 * pattern test is about the PATTERN; the host only has to carry the right column. Ordered by tier
 * then tiering score, so it still prefers the objects the business actually runs on. */
const hosts = objRows
  .filter(r => ['T1', 'T2', 'T3'].includes(r.tier) && objMeta.has(r.name.toLowerCase()))
  .sort((x, y) => ({ T1: 0, T2: 1, T3: 2 }[x.tier] - { T1: 0, T2: 1, T3: 2 }[y.tier])
    || (objMeta.get(y.name.toLowerCase())?.tier_score ?? 0) - (objMeta.get(x.name.toLowerCase())?.tier_score ?? 0));
/* Spread the pattern tests across hosts instead of stacking them on whichever object matched
 * first. Among the objects that carry the required role, prefer the one used least so far — the
 * pattern gets exercised against different column counts, datatypes and row volumes, which is the
 * only way a pattern test says anything about the connector rather than about one table. */
const hostUse = new Map();
const hostsFor = role => {
  const fit = role ? hosts.filter(o => roleCol(o.name, role)) : hosts.slice();
  if (!fit.length) return [];
  /* least-used first, so patterns spread across objects; ties keep the tier/score order, so the
   * objects the business actually runs on still go first */
  return [...fit].sort((a, b) => (hostUse.get(a.name) || 0) - (hostUse.get(b.name) || 0));
};
const hostFor = role => hostsFor(role)[0] || hosts[0];

const PATTERN_TC = {
  aggregate_count: o => ({ sql: `SELECT ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))}, COUNT(*) AS n FROM ${br(o)} GROUP BY ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))}`,
    pats: ['aggregate_count', 'group_by'], ask: `How many ${o} records sit in each status? I want the breakdown, not the list.` }),
  group_by: o => ({ sql: `SELECT ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))}, COUNT(*) AS n FROM ${br(o)} GROUP BY ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))}`,
    pats: ['aggregate_count', 'group_by'], ask: `Group the ${o} records and tell me how many fall into each category.` }),
  aggregate_sum_avg_minmax: o => ({ sql: `SELECT ${br(roleCol(o, 'dimension'))}, SUM(${br(roleCol(o, 'measure'))}) AS total FROM ${br(o)} GROUP BY ${br(roleCol(o, 'dimension'))}`,
    pats: ['aggregate_sum_avg_minmax', 'group_by'], ask: `Total up the ${o} figures by category so I can see where the weight sits.` }),
  filter_boolean: o => ({ sql: sel(o, project(o), `${br(boolCol(o))} = false`, roleCol(o, 'date')),
    pats: ['select_projection', 'filter_boolean', 'order_by', 'limit'], ask: `Show me the ${o} records that are not yet done, newest first.` }),
  filter_in: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'status'))} IN ('a','b')`, null),
    pats: ['select_projection', 'filter_in', 'limit'], ask: `Show me ${o} records in either of the two active states — I want them in one list, not two queries.` }),
  filter_or: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'status'))} = 'a' OR ${br(roleCol(o, 'date'))} < '${daysAgo(7)}'`, null),
    pats: ['select_projection', 'filter_or', 'limit'], ask: `Show me ${o} records that are either still open or older than a week — whichever applies.` }),
  filter_logic_grouped: o => ({ sql: sel(o, project(o), `(${br(roleCol(o, 'status'))} = 'a' OR ${br(roleCol(o, 'status'))} = 'b') AND ${br(roleCol(o, 'date'))} >= '${daysAgo(30)}'`, null),
    pats: ['select_projection', 'filter_logic_grouped', 'filter_and', 'limit'], ask: `From the last 30 days, show me ${o} records in either of the two open states.` }),
  filter_numeric_threshold: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'measure'))} > 0`, roleCol(o, 'measure')),
    pats: ['select_projection', 'filter_numeric_threshold', 'order_by', 'limit'], ask: `Which ${o} records have a non-zero figure? Put the largest first.` }),
  filter_date_boundary: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'date'))} >= '${daysAgo(1)}'`, roleCol(o, 'date')),
    pats: ['select_projection', 'filter_date_boundary', 'order_by', 'limit'], ask: `What changed on ${o} since yesterday?` }),
  select_star_guard: o => ({ sql: `SELECT * FROM ${br(o)} LIMIT 20`,
    pats: ['select_star_guard', 'limit'], ask: `Give me everything on ${o} — all the fields, I am not sure yet which ones I need.` }),

  /* The 15 below did not exist. The generator reached 20 of Asana's 37 applicable patterns and
   * Stage 8.5 rescued the rest — the same shape of dependency as the missing write generator, and
   * just as quiet: a weak or skipped review takes pattern breadth from 35 down to 20 with nothing
   * reporting a loss. A review should raise the ceiling, never hold up the floor. */
  distinct: o => ({ sql: `SELECT DISTINCT ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))} FROM ${br(o)} LIMIT 50`,
    pats: ['distinct', 'limit'], ask: `What distinct values does ${o} actually use for its category field? I want the list, each one once.` }),
  filter_comparison: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'measure') || roleCol(o, 'date'))} > ${roleCol(o, 'measure') ? '0' : `'${daysAgo(90)}'`}`, roleCol(o, 'date')),
    pats: ['select_projection', 'filter_comparison', 'order_by', 'limit'], ask: `Show me the ${o} records above the usual threshold — I am looking for the outliers, not the whole list.` }),
  filter_like: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'dimension'))} LIKE '%a%'`, null),
    pats: ['select_projection', 'filter_like', 'limit'], ask: `Find the ${o} records whose name contains a particular word — I only half remember what it was called.` }),
  filter_null: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'date') || roleCol(o, 'dimension'))} IS NULL`, null),
    pats: ['select_projection', 'filter_null', 'limit'], ask: `Which ${o} records are missing a value in that field entirely? Those are the ones I need to chase.` }),
  filter_enum: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'status'))} IN ('a','b','c')`, null),
    pats: ['select_projection', 'filter_enum', 'limit'], ask: `Show me ${o} records sitting in any of the in-progress states.` }),
  filter_negation: o => ({ sql: sel(o, project(o), `${br(roleCol(o, 'status'))} <> 'a'`, null),
    pats: ['select_projection', 'filter_negation', 'limit'], ask: `Show me every ${o} record that is NOT in the closed state.` }),
  offset_pagination: o => ({ sql: `SELECT ${project(o).map(br).join(',')} FROM ${br(o)} ORDER BY ${br(roleCol(o, 'identifier') || project(o)[0])} LIMIT 20 OFFSET 20`,
    pats: ['select_projection', 'order_by', 'offset_pagination', 'limit'], ask: `Give me the second page of ${o} records — I have already seen the first twenty.` }),
  having: o => ({ sql: `SELECT ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))}, COUNT(*) AS n FROM ${br(o)} GROUP BY ${br(roleCol(o, 'status') || roleCol(o, 'dimension'))} HAVING COUNT(*) > 1`,
    pats: ['aggregate_count', 'group_by', 'having'], ask: `Which ${o} categories have more than one record in them? Ignore the ones with a single entry.` }),
  subquery: o => ({ sql: `SELECT ${project(o).map(br).join(',')} FROM ${br(o)} WHERE ${br(roleCol(o, 'identifier') || 'Id')} IN (SELECT ${br(roleCol(o, 'identifier') || 'Id')} FROM ${br(o)} WHERE ${br(roleCol(o, 'date') || roleCol(o, 'dimension'))} IS NOT NULL) LIMIT 20`,
    pats: ['select_projection', 'subquery', 'limit'], ask: `Show me the ${o} records that also appear in the filtered set — I want the ones that satisfy both conditions.` }),
  /* Both branches project the filtered column: a UNION's arity is fixed, so push() cannot append
   * it afterwards the way it can for a plain SELECT. */
  union: o => { const f = roleCol(o, 'status') || roleCol(o, 'dimension');
    const cols = [...new Set([...project(o, 3), f].filter(Boolean))].map(br).join(',');
    return ({ sql: `SELECT ${cols} FROM ${br(o)} WHERE ${br(f)} = 'a' UNION SELECT ${cols} FROM ${br(o)} WHERE ${br(f)} = 'b'`,
    pats: ['union'], ask: `Put the ${o} records from both of those two states into a single combined list.` }); },
  date_function: o => ({ sql: `SELECT YEAR(${br(roleCol(o, 'date'))}) AS y, COUNT(*) AS n FROM ${br(o)} GROUP BY YEAR(${br(roleCol(o, 'date'))})`,
    pats: ['date_function', 'aggregate_count', 'group_by'], ask: `Break the ${o} records down by year so I can see the trend.` }),
  string_function: o => ({ sql: `SELECT UPPER(${br(roleCol(o, 'dimension'))}) AS n FROM ${br(o)} LIMIT 20`,
    pats: ['string_function', 'limit'], ask: `Give me the ${o} names in uppercase — I need them normalised for a comparison.` }),
  math_function: o => ({ sql: `SELECT ${br(roleCol(o, 'identifier') || 'Id')}, ROUND(${br(roleCol(o, 'measure'))}, 2) AS v FROM ${br(o)} LIMIT 20`,
    pats: ['math_function', 'limit'], ask: `Show me the ${o} figures rounded to two decimals — the raw precision is noise for this.` }),
  case_when: o => ({ sql: `SELECT ${br(roleCol(o, 'identifier') || 'Id')}, CASE WHEN ${br(roleCol(o, 'status'))} = 'a' THEN 'open' ELSE 'other' END AS bucket FROM ${br(o)} LIMIT 20`,
    pats: ['case_when', 'limit'], ask: `Bucket the ${o} records into open versus everything else, and show me which is which.` }),
  /* A self-join needs a column that points at THIS object. `roleCol(o,'relationship_key')` returns
   * whichever relationship key comes first, which on Projects was UserId — producing
   * `Projects a JOIN Projects b ON a.[UserId] = b.[Id]`, equating a user id with a project id under
   * a prompt about "the Projects record each one points back to". selfKey only accepts a declared
   * self-referencing relationship; without one the pattern is genuinely inapplicable. */
  join_self: o => { const k = selfKey(o); const id = roleCol(o, 'identifier') || 'Id';
    /* No self-reference in the schema at all → genuinely inapplicable, and the generator declines.
     * A self-reference whose columns are undeclared is a different thing: the question still makes
     * sense and finding the parent column is exactly what the agent is being measured on. */
    if (!selfRel(o)) return null;
    return { sql: k ? `SELECT a.${br(id)}, b.${br(id)} FROM ${br(o)} a INNER JOIN ${br(o)} b ON a.${br(k.from_col)} = b.${br(k.to_col)} LIMIT 20` : null,
      pats: ['join_self', 'limit'],
      ask: `Show me each ${one(o)} alongside the parent ${one(o)} it sits under.` }; },
};

/* Joins need two objects, so they are built from the relationship graph rather than a single host.
 * join_left is the highest-value join test there is: a driver that silently degrades LEFT to INNER
 * returns a plausible, wrong answer and nothing errors — so the prompt makes unmatched rows the
 * entire point, otherwise a degraded join still looks correct. */
const JOIN_TC = {
  join_left: (r, a, b) => ({
    sql: `SELECT a.${br(a.id)}, b.${br(b.id)} FROM ${br(r.from)} a LEFT JOIN ${br(r.to)} b ON a.${br(r.from_col || a.key || a.id)} = b.${br(r.to_col || b.id)} WHERE b.${br(b.id)} IS NULL LIMIT 20`,
    pats: ['join_left', 'filter_null', 'limit'],
    ask: `Which ${r.from} records have no matching ${r.to} at all? Those unmatched ones are exactly what I am after.` }),
  join_multi_table: (r, a, b, c, r2) => ({
    sql: `SELECT a.${br(a.id)}, b.${br(b.id)}, c.${br(c.id)} FROM ${br(r.from)} a INNER JOIN ${br(r.to)} b ON a.${br(r.from_col || a.key || a.id)} = b.${br(r.to_col || b.id)} INNER JOIN ${br(r2.to)} c ON b.${br(r2.from_col || b.id)} = c.${br(r2.to_col || c.id)} LIMIT 20`,
    pats: ['join_multi_table', 'join_inner', 'limit'],
    ask: `Bring ${r.from}, ${r.to} and ${r2.to} together in one view so I can see the whole chain without stitching three lists by hand.` }),
};
for (const p of patRows) {
  if (covered(p.state) || p.applicable === false) continue;
  const gids = keyed(`pattern:${p.pattern}`);
  if (!gids.length || gids.every(id => blocked.has(id))) continue;
  const make = PATTERN_TC[p.pattern]; if (!make) continue;
  const needRole = { aggregate_sum_avg_minmax: 'measure', filter_numeric_threshold: 'measure', filter_in: 'status',
    filter_or: 'status', filter_logic_grouped: 'status', filter_date_boundary: 'date', aggregate_count: 'dimension',
    group_by: 'dimension', filter_comparison: 'measure', filter_like: 'dimension', filter_null: 'date',
    filter_enum: 'status', filter_negation: 'status', distinct: 'status', having: 'status',
    date_function: 'date', string_function: 'dimension', math_function: 'measure', case_when: 'status',
    union: 'status' }[p.pattern];
  /* `hostFor` returned the first object carrying the role, so 20 of 26 pattern tests piled onto
   * Projects. Spreading them proves the pattern against different shapes of object — different
   * column counts, datatypes and row volumes — which is the point of testing a pattern at all. */
  /* Several templates need TWO column roles — filter_or wants a status AND a date — while
   * hostFor can only match one. Picking a single host and giving up when the second role was
   * missing silently dropped the pattern: filter_or, filter_logic_grouped and subquery were all
   * applicable, all had generators, and all produced no test at all. Try candidates in preference
   * order and keep the first that yields usable SQL. */
  const candidates = p.pattern === 'filter_boolean' ? hosts.filter(o => boolCol(o.name))
                   : p.pattern === 'join_self'      ? hosts.filter(o => selfRel(o.name))
                   : needRole                       ? hostsFor(needRole)
                   : hosts.slice();
  let host = null, t = null;
  for (const cand of candidates) {
    const made = make(cand.name);
    /* `made === null` is the generator declining outright. `made.sql === null` is different: the
     * question stands, only the reference SQL is withheld because the metadata cannot state it. */
    if (!made || (made.sql && /\[null\]|\[undefined\]/.test(made.sql))) continue;
    host = cand; t = made; break;
  }
  if (!host) continue;   // no object on this connector can carry the pattern — gap stays open honestly
  hostUse.set(host.name, (hostUse.get(host.name) || 0) + 1);
  push({ ...base,
    gap_ids: gids, uc: `${p.pattern} on ${host.name}`.slice(0, 80),
    business_domain: objMeta.get(host.name.toLowerCase())?.business_domain?.v || 'Query Patterns',
    business_process: domainFromObjects(host.name) || domainName(objMeta.get(host.name.toLowerCase())?.business_domain?.v),
    business_intent: null, prompt: t.ask,
    expected_sql: t.sql || null, target_objects: [host.name],
    target_columns: project(host.name),   // push() replaces this with the real projection
    ...(t.sql ? {} : { join_key_undeclared: true,
      note: `${host.name} references itself, but the metadata states no join columns for it. The `
          + `agent has to find them by inspection; whether it can is the test.` }),
    query_patterns: t.pats,
    priority: 'P2', group: 'Query Patterns', group_type: 'process', process_group: 'Query Patterns',
  });
}

/* E1b · joins — built from the relationship graph, because they need two objects, not a host. */
const idOf = n => ({ id: roleCol(n, 'identifier') || 'Id', key: roleCol(n, 'relationship_key') });

for (const pat of ['join_left', 'join_multi_table']) {
  const row = patRows.find(p => p.pattern === pat);
  if (!row || row.applicable === false || covered(row.state)) continue;
  const gids = keyed(`pattern:${pat}`);
  /* same rule as every other pattern (see the loop above): a pattern with no open gap is already
   * covered, and joins are not special enough to earn their own gating. */
  if (!gids.length || gids.every(id => blocked.has(id))) continue;

  /* Prefer a relationship whose join columns the metadata states, but do not REQUIRE one. The
   * agent under test never sees expected_sql — the natural-language question is the test, and
   * discovering the key from getColumns is the work being measured. Withhold the reference SQL,
   * never the question. */
  const all = relRows.filter(r => objMeta.has(String(r.from).toLowerCase())
    && objMeta.has(String(r.to).toLowerCase()));
  const usable = [...all].sort((x, y) => (joinCols(y) ? 1 : 0) - (joinCols(x) ? 1 : 0));
  if (!usable.length) continue;
  const undeclared = n => ({ join_key_undeclared: true,
    note: `${n} is declared as a relationship but the metadata states no join columns. The agent has `
        + `to find them by inspection; whether it can is the test.` });
  /* The harness hint ("work it out from the connector's own metadata; nothing is prepared for you")
   * moved out of the prompt; the undeclared-key expectation says the same thing to the judge. */
  const hint = '';
  const findKeys = { expected_behavior: ['finds the linking columns itself — the metadata does not declare them'] };

  if (pat === 'join_left') {
    const base0 = usable[0], jc = joinCols(base0);
    const r = { ...base0, ...(jc || {}) };
    const t = JOIN_TC.join_left(r, idOf(r.from), idOf(r.to));
    push({ ...base, gap_ids: gids, uc: `join_left ${r.from}→${r.to}`.slice(0, 80),
      business_domain: objMeta.get(String(r.from).toLowerCase())?.business_domain?.v || 'Query Patterns',
      business_process: domainFromObjects(r.from, r.to),
      business_intent: null, prompt: t.ask + (jc ? '' : hint), expected_sql: jc ? t.sql : null,
      ...(jc ? {} : findKeys),
      ...(jc ? {} : undeclared(`${r.from} → ${r.to}`)),
      target_objects: [r.from, r.to], target_columns: project(r.from), relationships: [r.id],
      query_patterns: t.pats, priority: 'P1', surface: true,
      group: 'Query Patterns', group_type: 'process', process_group: 'Query Patterns' });
  } else {
    /* a 3-table chain: A→B and B→C, so the second hop starts where the first landed */
    const first = usable.find(x => usable.some(y => String(y.from) === String(x.to) && String(y.to) !== String(x.from)));
    const second = first && usable.find(y => String(y.from) === String(first.to) && String(y.to) !== String(first.from));
    if (!first || !second) continue;
    const jc1 = joinCols(first), jc2 = joinCols(second);
    const bothDeclared = !!(jc1 && jc2);
    const r = { ...first, ...(jc1 || {}) }, r2 = { ...second, ...(jc2 || {}) };
    const t = JOIN_TC.join_multi_table(r, idOf(r.from), idOf(r.to), idOf(r2.to), r2);
    push({ ...base, gap_ids: gids, uc: `join_multi_table ${r.from}→${r.to}→${r2.to}`.slice(0, 80),
      business_domain: objMeta.get(String(r.from).toLowerCase())?.business_domain?.v || 'Query Patterns',
      business_process: domainFromObjects(r.from, r.to, r2.to),
      business_intent: null, prompt: t.ask + (bothDeclared ? '' : hint),
      ...(bothDeclared ? {} : findKeys),
      /* one undeclared hop makes the whole chain unreferenceable — a half-real reference query is
       * worse than none, because a reader assumes the part that is printed was verified */
      expected_sql: bothDeclared ? t.sql : null,
      ...(bothDeclared ? {} : undeclared(`${r.from} → ${r.to} → ${r2.to}`)),
      target_objects: [r.from, r.to, r2.to], target_columns: project(r.from), relationships: [r.id, r2.id],
      query_patterns: t.pats, priority: 'P2', surface: true,
      group: 'Query Patterns', group_type: 'process', process_group: 'Query Patterns' });
  }
}

/* E2 · the write surface — INSERT and UPDATE against real objects.
 *
 * This did not exist. PATTERN_TC had no insert/update entry, so a connector advertising both got
 * a QUERY gap for each and no test for either: the whole write surface depended on the Stage 8.5
 * reviewer noticing it missing. asn004 is what that looks like when the reviewer does not — 118
 * SELECTs and zero writes against a connector advertising insert and update. A review is a
 * second opinion, never the only thing standing between a capability and no coverage.
 *
 * An UPDATE is reversible by reading the old value first and putting it back, so it runs under
 * `write_policy.execute_reversible`. An INSERT is not: this connector exposes no DELETE, so a
 * created row cannot be removed. That one is planned, reported and deliberately not executed
 * unless `execute_irreversible` says otherwise — the same decision the procedure block makes, for
 * the same reason, recorded the same way. */
/* Ordered by the tiering score, so writes land on the objects the business actually runs on —
 * Tasks before Allocations — rather than wherever the alphabet put them. */
const scoreOf = n => objMeta.get(n.toLowerCase())?.tier_score ?? 0;
const writeHosts = objRows
  .filter(r => ['T1', 'T2'].includes(r.tier) && objMeta.has(r.name.toLowerCase()))
  .sort((x, y) => (x.tier === 'T1' ? 0 : 1) - (y.tier === 'T1' ? 0 : 1) || scoreOf(y.name) - scoreOf(x.name));
for (const [pat, cap] of [['update', 'update'], ['insert', 'insert']]) {
  const row = patRows.find(p => p.pattern === pat);
  if (!row || !row.applicable || covered(row.state)) continue;
  if (!advertises(cap)) continue;      // absent or false both mean: do not assert a write capability
  const gids = keyed(`pattern:${pat}`);
  if (gids.length && gids.every(id => blocked.has(id))) continue;

  for (const host of writeHosts.slice(0, pat === 'update' ? 4 : 3)) {
    const o = host.name;
    const idC = roleCol(o, 'identifier') || 'Id';
    /* a status or free-text field is the safest thing to touch; never an identifier or a key */
    const target = roleCol(o, 'status') || roleCol(o, 'dimension');
    /* Both verbs need a column that is neither the identifier nor a key. Without one there is
     * nothing safe to write, and inventing a value for the primary key is not a test. */
    if (!target) continue;

    const reversible = pat === 'update';
    let executable = true, nt_reason = null;
    if (!WRITE.execute_reversible) {
      executable = false;
      nt_reason = `Writing to ${o} mutates workspace data and write execution is disabled for this run.`;
    } else if (!reversible && !WRITE.execute_irreversible) {
      executable = false;
      nt_reason = `Inserting ${/^[AEIOU]/i.test(o) ? 'an' : 'a'} ${o} record creates data this connector cannot delete — the delete `
        + `capability is not exposed — so a test run would leave rows in the workspace with no way to `
        + `reconcile them. Planned and reported, deliberately not executed.`;
    }

    push({ ...base,
      gap_ids: gids, uc: `${pat} on ${o}`.slice(0, 80),
      business_domain: objMeta.get(o.toLowerCase())?.business_domain?.v || 'Write',
      business_process: domainFromObjects(o) || domainName(objMeta.get(o.toLowerCase())?.business_domain?.v),
      business_intent: null,
      /* The request a person makes. Reading the old value, confirming, and restoring it are what a
       * reversible write test needs — so they are the expectation and the operating note, not the
       * question ("…then set it back exactly as you found it" is something no user has ever said). */
      prompt: pat === 'update'
        ? `Update the ${humanize(target)} on one of our ${noun(o)}.`
        : `Add a new ${one(o)} with just the details it needs.`,
      expected_behavior: pat === 'update'
        ? ['reads the current value before changing it', 'the new value is visible when read again', 'the original value is restored afterwards']
        : ['supplies the fields the connector requires', 'the new record can be found afterwards'],
      expected_sql: pat === 'update'
        ? `UPDATE ${br(o)} SET ${br(target)}='<new>' WHERE ${br(idC)}='<discovered>'`
        /* never the identifier — a server-assigned key is not something a caller supplies */
        : `INSERT INTO ${br(o)} (${br(target)}) VALUES ('<value>')`,
      target_objects: [o], target_columns: [idC, target].filter(Boolean),
      query_patterns: [pat, 'write', ...(pat === 'update' ? ['filter_equality'] : [])],
      mutates: true, reversible,
      executable, ...(nt_reason ? { nt_reason } : {}),
      risk_flag: reversible ? 'mutating' : 'irreversible_write',
      priority: 'P1',
      group: 'Write Operations', group_type: 'write', process_group: 'Write Operations', surface: true,
    });
  }
}

/* E3 · workflows — a job of work carried end to end, not a single read.
 *
 * Stage 2 researched these and only the tiering ever read them. Every workflow was flattened into
 * one SELECT, so "Create and assign a task with a due date" was tested by reading tasks, and 35
 * write workflows produced no writes at all.
 *
 * The agent gets the whole job in one prompt and works out the steps itself — which is the point:
 * a lifecycle defect only shows when the steps run in order, against each other's output. The
 * reference SQL is deliberately null: a workflow is several statements and the plan's
 * expected_sql field holds one, so pretending otherwise would put a half-true query in a report. */
const workflows = (K.connector_meta?.workflow_domains || []).flatMap(d =>
  (d.workflows || []).map(w => ({ ...w, domain: d.id, domain_name: d.name })));

for (const w of workflows) {
  if (CATALOG) break;
  const gids = keyed(`wf:${w.id}`);
  const writes = w.permission === 'write';

  /* Which objects the workflow acts on, matched the same way the tiering matches — by name in the
   * workflow text. Approximate, and the prompt is written so the agent can correct it. */
  const named = objRows.filter(o => {
    const t = (w.name + ' ' + (w.edge_cases || []).join(' ')).toLowerCase();
    const n = o.name.toLowerCase();
    return t.includes(n) || t.includes(n.replace(/ies$/, 'y').replace(/s$/, ''));
  }).map(o => o.name);
  if (!named.length) continue;   // no object of this connector takes part — nothing to ask for

  /* A write workflow that cannot be undone leaves residue. Same decision as the procedure and
   * write generators, recorded the same way rather than dropped. */
  let executable = true, nt_reason = null;
  if (writes && !WRITE.execute_reversible) {
    executable = false;
    nt_reason = `${w.name} mutates workspace data and write execution is disabled for this run.`;
  } else if (writes && !WRITE.execute_irreversible && !advertises('delete')) {
    executable = false;
    nt_reason = `${w.name} creates or changes records this connector cannot delete — the delete `
      + `capability is not exposed — so the workflow cannot restore the workspace afterwards. `
      + `Planned and reported, deliberately not executed.`;
  }

  const edge = (w.edge_cases || [])[0];
  const job = w.name.charAt(0).toLowerCase() + w.name.slice(1);
  /* The persona who does this job — the one whose primary domain it is, or whose jobs name it. */
  const doer = (K.connector_meta?.personas || []).find(p => (p.jobs_to_be_done || []).some(j => objectsIn(j).some(o => named.includes(o))
    && (p.primary_domains || []).includes(w.domain)))
    || (K.connector_meta?.personas || []).find(p => (p.primary_domains || []).includes(w.domain)) || null;

  push({ ...base,
    gap_ids: gids, uc: w.name.slice(0, 80), surface: true, suite: 'business',
    business_domain: w.domain, business_process: domainName(w.domain) || w.domain_name, business_intent: null,
    workflow_id: w.id, workflow_domain: w.domain_name,
    /* A draft in the persona's voice. "Carry this out end to end … work out the steps yourself from
     * the connector's own tools … confirm each one by reading it back … tell me where it breaks"
     * described the TEST to the agent. The job is the question; the checks are the expectation. */
    prompt: `I need to ${job}.`,
    brief: briefFor({ persona: doer, goal: w.name, objects: named.slice(0, 4) }),
    expected_behavior: [
      'completes every step of the job, in order',
      ...(writes ? ['each change is visible when read back', 'leaves the account as it was found, or says why it could not'] : []),
      ...(edge ? [`handles: ${edge}`] : []),
    ],
    ...(writes ? { agent_context: CONTEXT.workflow } : {}),
    persona: doer?.name || null,
    /* a workflow is several statements; the single expected_sql field cannot hold it honestly */
    expected_sql: null,
    target_objects: named.slice(0, 4), target_columns: [],
    query_patterns: writes ? ['workflow', 'write'] : ['workflow'],
    mutates: writes, reversible: false,
    executable, ...(nt_reason ? { nt_reason } : {}),
    ...(writes ? { risk_flag: 'mutating' } : {}),
    priority: priorityFor(w.domain, writes ? 'P1' : 'P2'),
    roles: rolesForDomain(w.domain),
    group: 'Workflows', group_type: 'workflow', process_group: w.domain_name || 'Workflows',
  });
}

/* F · objects with no test at all — EVERY object the run never touched, not just T1/T2.
 * The tier gate here was the quiet half of a coverage hole: compute-gaps emitted no gap for a
 * low-tier object and this loop refused to write a test for one either, so a T3/T4 object was
 * untestable by construction. Tier decides how DEEP the coverage goes (§5.2), never whether the
 * object is looked at. */
for (const o of objRows) {
  if (covered(o.state) || !objMeta.has(o.name.toLowerCase())) continue;
  const gids = [...new Set([...openGaps.filter(g => String(g.key || '').startsWith(`fam:${o.name}:`)).map(g => g.id),
                            ...openGaps.filter(g => String(g.key || '') === `obj_untested:${o.name}`).map(g => g.id),
                            ...openGaps.filter(g => (g.impacted?.objects || []).includes(o.name) && g.category === 'BUSINESS').map(g => g.id)])];
  if (!gids.length || gids.every(id => blocked.has(id))) continue;
  const m = objMeta.get(o.name.toLowerCase());
  const q = CATALOG ? null : (m?.business_questions || [])[0];   // with a catalog, an object baseline is a conformance check
  const cols = project(o.name), dateC = headlineOf(o.name).key_date || roleCol(o.name, 'date');
  /* An object with a researched business question is a business scenario; one without is a
   * coverage check, and says so. "Answer it from the Tasks records" named the table. */
  push({ ...base,
    gap_ids: gids, uc: `${o.name} baseline`.slice(0, 80),
    suite: q ? 'business' : 'conformance',
    business_domain: m?.business_domain?.v || 'Schema',
    business_process: domainFromObjects(o.name) || domainName(m?.business_domain?.v),
    business_intent: null,
    prompt: q ? String(q).trim()
              : `Give me a quick view of our ${noun(o.name)} — the details that matter, most recent first.`,
    ...(q ? { brief: briefFor({ goal: q, objects: [o.name] }) } : {}),
    expected_behavior: [`returns ${noun(o.name)} with ${headlineOf(o.name).list.map(humanize).slice(0, 4).join(', ') || 'their identifying details'}`],
    expected_sql: sel(o.name, cols, null, dateC),
    target_objects: [o.name], target_columns: cols,
    query_patterns: ['select_projection', ...(dateC ? ['order_by'] : []), 'limit'],
    priority: priorityFor(m?.business_domain?.v, 'P2'), group: m?.business_domain?.v || 'Schema Coverage', group_type: 'process',
    process_group: m?.business_domain?.v || 'Schema Coverage',
  });
}

/* ── dedup by SQL fingerprint, union the gap_ids (06 §8.4) ───────────────── */
const fp = s => String(s || '').toLowerCase().replace(/'[^']*'/g, '?').replace(/\s+/g, ' ').trim();
const merged = [];
const seen = new Map();
for (const tc of out) {
  /* Two use cases are two business questions even when the baseline SQL rhymes. Merging them
   * would hand one test the coverage of eleven, which is the same over-claiming this runtime
   * exists to prevent — so a use-case TC is keyed by its use case and never merges across them. */
  const f = tc.use_case_id ? `cat:${tc.use_case_id}#${tc.variant || 0}`
          : tc.use_case_ids?.length ? `uc:${tc.use_case_ids[0]}`
          : tc.expected_sql ? fp(tc.expected_sql) : `__${tc.behavior || tc.sp_name || tc.uc}`;
  if (seen.has(f)) {
    const k = seen.get(f);
    k.gap_ids = [...new Set([...k.gap_ids, ...tc.gap_ids])];
    k.use_case_ids = [...new Set([...(k.use_case_ids || []), ...(tc.use_case_ids || [])])];
    if (!k.use_case_ids.length) delete k.use_case_ids;
    k.roles = [...new Set([...(k.roles || []), ...(tc.roles || [])])];
    continue;
  }
  seen.set(f, tc); merged.push(tc);
}

/* Keying a use-case TC by its use case is right — two business questions are two tests even when
 * the SQL rhymes — but it only holds while the tests actually differ. Nothing checked that, and on
 * Asana 35 tests backed by WRITE workflows every one of them flattened to a SELECT, collapsing to
 * 12 distinct queries: eight tests sent one identical query under eight different names. That is
 * eight tests' worth of credit for one query's worth of evidence, which is the over-claiming this
 * dedup rule exists to prevent, arriving through the exemption instead of the rule.
 *
 * Report it rather than merge it: the fix is to make the tests differ — a write workflow should
 * write — not to delete the duplicates and call the use case covered. */
{
  const byShape = new Map();
  for (const t of merged) {
    if (!(t.use_case_ids || []).length || !t.expected_sql) continue;
    const k = fp(t.expected_sql);
    (byShape.get(k) || byShape.set(k, []).get(k)).push(t);
  }
  const clashes = [...byShape.values()].filter(v => v.length > 1).sort((a, b) => b.length - a.length);
  if (clashes.length) {
    const n = clashes.reduce((s, v) => s + v.length, 0);
    console.error(`\n⚠ ${n} use-case test(s) share only ${clashes.length} distinct quer${clashes.length === 1 ? 'y' : 'ies'} between them:`);
    for (const g of clashes.slice(0, 5))
      console.error(`    ${g.length}× ${g.map(t => t.id || t.uc).slice(0, 6).join(', ')}${g.length > 6 ? ' …' : ''}\n       ${fp(g[0].expected_sql).slice(0, 96)}`);
    console.error(`  Each is credited to a different use case while sending the same query. Where the use case`);
    console.error(`  is a write workflow, the test should write — see 06-test-generation.md §8.4.`);
  }
}

/* A silent slice is how a plan loses a whole dimension. Ordering by priority alone was not enough:
 * priority descends from gap scores, and gap scores rise when customer evidence corroborates a
 * gap. So the same connector capped at the same number kept a DIFFERENT set of tests depending on
 * whether a dump happened to exist — the dump silently decided what got tested. The completeness
 * audit below only noticed afterwards, by which point the tests were already gone.
 *
 * So the cap reserves a floor first, computed from the connector's own surface — every procedure,
 * every T1 object, every declared relationship, every applicable pattern, every advertised
 * capability keeps its first test no matter what it scored. Only the tail beyond that floor is
 * ordered by priority and trimmed. The floor is a property of the connector, never of the
 * evidence, which is what makes a capped plan reproducible with or without a dump. */
/* Only an explicit --max trims. The config value advises. */
const max = Number(a.max || 0);
const advisory = Number(cfg.defaults?.max_tcs || 0);
const rank = t => ({ P1: 0, P2: 1, P3: 2 }[t.priority] ?? 3);
merged.sort((x, y) => rank(x) - rank(y));

/* One representative test per surface item. Keys are drawn from the connector surface only. */
function floorKeys(t) {
  const k = [];
  if (t.sp_name) k.push(`sp:${t.sp_name}`);
  for (const o of t.target_objects || []) k.push(`obj:${o}`);
  for (const r of t.relationships || []) k.push(`rel:${typeof r === 'string' ? r : r.id}`);
  for (const p of t.query_patterns || []) k.push(`pat:${p}`);
  if (t.behavior) k.push(`beh:${t.behavior}`);
  if (t.group_type === 'write') k.push(`cap:write`);
  return k;
}
const reserved = new Set(), protectedTCs = [], tail = [];
for (const t of merged) {
  const keys = floorKeys(t);
  if (keys.some(k => !reserved.has(k))) { keys.forEach(k => reserved.add(k)); protectedTCs.push(t); }
  else tail.push(t);
}
let kept = [...protectedTCs, ...tail], dropped = [];
if (max > 0 && kept.length > max) {
  if (protectedTCs.length > max) {
    /* The floor alone exceeds the cap. Trimming it would drop a surface item entirely, so the cap
     * yields — a plan that silently skips procedures is the failure this whole audit exists for. */
    console.error(`\n⚠ --max ${max} is below the connector's coverage floor (${protectedTCs.length} tests are needed to touch every procedure, object, relationship and pattern once).`);
    console.error(`  Keeping the floor and ignoring the cap. Raise max_tcs, or narrow the surface deliberately.`);
    kept = protectedTCs;
    dropped = tail;            // still discarded, and still has to be reported
  } else {
    dropped = tail.slice(max - protectedTCs.length);
    kept = [...protectedTCs, ...tail.slice(0, max - protectedTCs.length)];
  }
}
const conformanceOff = !!(SCOPE?.partial && !a['with-conformance']);
if (conformanceOff) kept = kept.filter(t => t.suite === 'business');
const final = kept.map((tc, i) => ({ id: `TC-${String(i + 1).padStart(3, '0')}`, ...tc }));
if (!max && advisory && merged.length > advisory) {
  /* Advisory only — the plan is complete and the operator is told what it will cost. */
  const byDim = {};
  for (const t of merged) byDim[t.group_type || 'other'] = (byDim[t.group_type || 'other'] || 0) + 1;
  console.error(`\n⚠ ${merged.length} tests — above the advisory max_tcs of ${advisory}.`);
  console.error(`  Keeping all of them: the connector's surface decides the count, not the config.`);
  console.error('  ' + Object.entries(byDim).map(([k, n]) => `${n} ${k}`).join(' · '));
  console.error(`  Pass --max N to trim deliberately, or raise max_tcs to silence this.`);
}
if (dropped.length) {
  console.error(`\n⚠ ${dropped.length} generated TC(s) exceeded --max ${max} and were dropped:`);
  console.error(`  (coverage floor of ${protectedTCs.length} was reserved first — every surface item keeps one test)`);
  const byDim = {};
  for (const t of dropped) byDim[t.group_type || 'other'] = (byDim[t.group_type || 'other'] || 0) + 1;
  for (const [k, n] of Object.entries(byDim)) console.error(`    ${n} × ${k}`);
}

/* ── completeness audit — the check that was missing ─────────────────────── */
/* asn004 planned 2 tests for 19 procedures and 0 for a connector advertising insert+update, and
 * nothing objected, because every stage measured the plan against the gap ledger rather than
 * against the connector's own surface. This compares the plan to what the connector actually
 * exposes, and refuses to be quiet about a dimension that is barely represented. */
/* The denominator is what still NEEDS a test — not everything that exists. An item already
 * settled (tested, or correctly not_applicable) needs no new test, and counting it as a miss made
 * a connector whose dimensions are legitimately not applicable read as 0/N and fail the gate.
 * The gate must fire on work not done, never on work that does not exist. */
const owed = rows => rows.filter(r => !covered(r.state)).length;
const audit = [
  ['procedures',   owed(spRows),                                      final.filter(t => t.sp_name).length],
  ['use cases',    owed(ucRows),                                      final.filter(t => (t.use_case_ids || []).length).length],
  ['behaviors',    owed(behRows.filter(r => r.applicable !== false)),  final.filter(t => t.behavior).length],
  /* This counted TCs against relationships, so a fixture with 4 join tests over 2 relationships
   * printed "relationships 4/2 200%". Coverage is how many RELATIONSHIPS are exercised. */
  ['relationships', owed(relRows),
                    new Set(final.flatMap(t => (t.relationships || [])
                      .map(r => typeof r === 'string' ? r : r && r.id)).filter(Boolean)).size],
  /* A pattern that silently produced no test was never flagged THIN — the only trace was a count
   * buried in "not closed by this plan". Patterns are a coverage dimension like any other. */
  ['applicable patterns', patRows.filter(p => p.applicable !== false && !covered(p.state)).length,
                    new Set(final.flatMap(t => t.query_patterns || [])
                      .filter(p => patRows.some(r => r.pattern === p && r.applicable !== false))).size],
  ['T1 objects',   objRows.filter(r => r.tier === 'T1' && !covered(r.state)).length,
                   objRows.filter(r => r.tier === 'T1' && !covered(r.state)
                     && final.some(t => (t.target_objects || []).includes(r.name))).length],
];
const MINC = cfg.defaults?.min_dimension_coverage ?? 0.8;
let thinFailed = false;
/* This prints a verdict and then exits 0, so a plan that fails it flows straight into execution.
 * config.json calls it "fails the run" and 07a-tc-review.md says it "exits non-zero on a thin
 * dimension"; it did neither. asn004 shipped 2 tests for 19 procedures past exactly this check. */
console.log('\nCOMPLETENESS — plan vs the connector surface');
const thin = [];
for (const [name, total, have] of audit) {
  if (!total) continue;
  const pctn = have / total;
  const flag = pctn < MINC ? '  ✗ THIN' : '';
  if (pctn < MINC) thin.push(`${name} ${have}/${total}`);
  console.log(`  ${name.padEnd(15)} ${String(have).padStart(3)}/${String(total).padEnd(4)} ${Math.round(pctn * 100)}%${flag}`);
}
const writeAdvertised = !!(perms.insert || perms.update || perms.delete);
const writePlanned = final.filter(t => t.mutates).length;
if (writeAdvertised) {
  console.log(`  ${'write surface'.padEnd(15)} ${String(writePlanned).padStart(3)} test(s) for a connector advertising `
    + Object.entries(perms).filter(([, v]) => v).map(([k]) => k).join('+'));
  if (!writePlanned) thin.push('write surface 0 tests');
}
const notExec = final.filter(t => t.executable === false);
if (notExec.length) {
  console.log(`\n  ${notExec.length} TC(s) planned but deliberately NOT executed (reported with reason):`);
  for (const t of notExec.slice(0, 8)) console.log(`    ${t.sp_name || t.id} — ${String(t.nt_reason || '').slice(0, 90)}…`);
}
if (thin.length && conformanceOff) {
  console.log(`\n  partial scope (${SCOPE.areas.join(', ')}): business suite only — the surface audit applies to a full run (--all) or --with-conformance`);
} else if (thin.length) {
  console.error(`\n✗ COMPLETENESS GATE: ${thin.join(' · ')} below ${Math.round(MINC * 100)}%.`);
  console.error('  Stage 8.5 must add tests for these before execution, or record why they cannot exist.');
  /* This printed and exited 0, so a plan that failed the gate flowed straight into execution.
   * config.json calls it "fails the run" and 07a-tc-review.md says it exits non-zero; it did
   * neither, and asn004 shipped 2 tests for 19 procedures straight past it. The plan is still
   * written — it is the input Stage 8.5 must repair — but the run stops here. */
  thinFailed = true;
}

/* ── write plan, and link planned_tests back onto each gap ───────────────── */
/* Link gaps to tests BEFORE writing either file. This loop mutates tc.gap_ids, and the plan used
 * to be written above it — so a link added here reached gaps.json and never reached the plan, and
 * the two disagreed about who tests what. */
for (const g of G.gaps || []) {
  let tests = final.filter(t => t.gap_ids.includes(g.id));
  /* A QUERY gap names a pattern. Any test that exercises that pattern closes it, whether or not the
   * generator cited the gap id — select_projection has no dedicated generator because every SELECT
   * already exercises it. Crediting only explicit citations left such gaps permanently open against
   * a plan that covered them many times over. */
  if (!tests.length && String(g.key || '').startsWith('pattern:')) {
    const pat = String(g.key).slice('pattern:'.length);
    tests = final.filter(t => (t.query_patterns || []).includes(pat));
    for (const t of tests) if (!t.gap_ids.includes(g.id)) t.gap_ids.push(g.id);
  }
  g.planned_tests = tests.map(t => t.id);
}

const closes = new Set(final.flatMap(t => t.gap_ids));
if (!a['no-write']) {
  writeJson(P('plan'), {
    schema_version: G.schema_version || '2.0.0', connector: conn,
    run_id: K.run_meta?.run_id || null, round: 1,   // single pass — see config.defaults.$rounds_comment
    generated_at: new Date().toISOString(), generated_by: 'generate-tests.mjs',
    tc_list: final,          // canonical name — artifacts.md §4, read by detect-stage and Stage 9
    ...(SCOPE ? { scope: { areas: SCOPE.areas, partial: SCOPE.partial, conformance: !conformanceOff, catalog_version: CATALOG.version ?? null,
                           area_versions: Object.fromEntries(SCOPE.areas.map(id => [id, CATALOG.areas?.[id]?.version ?? null])) } } : {}),
  });
  /* REPLACE, never append. This used to union the previous value, and because each generation
   * renumbers TCs from TC-001, a second pass left the earlier pass's ids stranded on the gap —
   * 525 of 697 links in asn004 pointed at TC-099…TC-111, tests that did not exist. Gaps were
   * then credited from phantom tests, which marked capabilities covered, which made the next
   * generation skip them. The plan is the single source of truth for who tests what. */
  writeJson(P('gaps'), G);
}

/* ── report ──────────────────────────────────────────────────────────────── */
const byGroup = final.reduce((m, t) => (m[t.group] = (m[t.group] || 0) + 1, m), {});
console.log(`\nTEST GENERATION — ${conn}`);
console.log(`  ${final.length} TC(s) from ${out.length} candidate(s) after dedup`);
console.log(`  closes ${closes.size} of ${openGaps.length} live gap(s) · ${openGaps.length - closes.size} left open`);
console.log(`  binding: ${final.filter(t => t.use_case_ids).length} carry use_case_ids · ${final.filter(t => t.sp_name).length} sp_name · ${final.filter(t => t.behavior).length} behavior`);
for (const [g, n] of Object.entries(byGroup).sort((x, y) => y[1] - x[1])) console.log(`    ${String(n).padStart(3)}  ${g}`);
{
  const biz = final.filter(t => t.suite === 'business'), conf = final.filter(t => t.suite !== 'business');
  console.log(`\n  suites: ${biz.length} business scenario(s) · ${conf.length} connector conformance check(s)`);
  console.log(`    business prompts are drafts — Stage 8.5 rewrites them in the persona's words, Stage 8.6 scores them`);
  /* A conformance prompt is composed here and nobody rewrites it, so any raw id or harness phrase
   * left in one is this script's bug, not the writer's. */
  const leaky = conf.filter(t => (t.realism_lint || []).some(c => c === 'raw_id' || c === 'tester_instruction'));
  if (leaky.length) {
    console.error(`  ⚠ ${leaky.length} conformance prompt(s) still carry a raw id or a test instruction:`);
    for (const t of leaky.slice(0, 5)) console.error(`      ${t.id}  ${String(t.prompt).slice(0, 90)}`);
  }
}
const stillOpen = openGaps.filter(g => !closes.has(g.id));
const byCat = stillOpen.reduce((m, g) => (m[g.category] = (m[g.category] || 0) + 1, m), {});
if (stillOpen.length) {
  console.log(`\n  not closed by this plan (${stillOpen.length}): ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  of those, ${stillOpen.filter(g => blocked.has(g.id)).length} are blocked by a connector/subscription limit — mark them NOT_TESTABLE rather than testing them`);
}
if (!a['no-write']) console.log(`\n→ ${P('plan')}\n→ ${P('gaps')}  (planned_tests linked)`);

/* Exit AFTER both artifacts are written: Stage 8.5 needs the thin plan in order to repair it.
 * Refusing to write would only force the whole generation to be re-run. */
if (thinFailed && !a['allow-thin']) {
  console.error('\n✗ Refusing to report success: the plan does not cover the connector surface.');
  console.error('  Run Stage 8.5 to add the missing tests, or pass --allow-thin to proceed deliberately.');
  process.exit(EXIT.DATA);
}
