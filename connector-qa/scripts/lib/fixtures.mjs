/* fixtures.mjs — the records a use case needs, named once and found or created per account (3.7).
 *
 * A catalog is frozen and reused for months, on whatever account runs it. Until 3.7 its checks named
 * records by one account's ids (Asana TR: 17 of 17 reference queries), so a re-seeded or different
 * account broke every check, and a use case like "fix the 90 minutes logged last Thursday" ran on an
 * account with no such entry and measured nothing.
 *
 * A fixture is a named slot in the catalog (`cat.fixtures`):
 *
 *   { "id": "launch_project", "area": "TM", "table": "Projects",
 *     "describe": "an active project with at least three open tasks, one of them overdue",
 *     "find_sql": "SELECT [Id],[Name] FROM [C].[S].[Projects] WHERE … ORDER BY [Name]",
 *     "example": { "Name": "Website Relaunch" },
 *     "seed": ["INSERT INTO [C].[S].[Projects] ([Name],[Workspace]) VALUES ('Website Relaunch','{{workspace}}')"],
 *     "depends_on": [] }
 *
 * Use cases refer to it as {{fixture:launch_project.Name}} in the request, the expected behaviour
 * and every check query ({{fixture:launch_project.Id}}). Data first: test-data.mjs runs each
 * find_sql against the account and binds the first row it returns — a real record, under its real
 * name. Only when nothing suitable exists is the seed run (the user approves it first), and the
 * find runs again to bind what was created. The bindings live in <Connector>_test_data.json, and
 * generate-tests.mjs renders every request and check with them. Nothing here knows any source.
 */
import { createHash } from 'node:crypto';

export const FIXTURE_REF = /\{\{fixture:([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\}\}/g;
/* a record named by an account's raw id: a long quoted number, or a bare one of 13+ digits */
export const HARDCODED_ID = /'\d{10,}'|(?<![\w'])\d{13,}(?![\w'])/;
const CHECK_SQL = ['reference_sql', 'data_sql', 'locate_sql', 'cleanup_sql', 'scope_sql'];

const procParams = ch => Object.values(ch?.cleanup_procedure?.parameters || {});
const texts = u => [u.request, ...(u.variants || []), ...(u.expected_behavior || []), ...CHECK_SQL.map(k => u.check?.[k]), ...Object.values(u.check?.expect || {}), ...procParams(u.check),
  u.follow_up?.reply, ...(u.follow_up?.expected_behavior || []), ...CHECK_SQL.map(k => u.follow_up?.check?.[k]), ...Object.values(u.follow_up?.check?.expect || {})].filter(v => v != null).map(String);

/** A bound record's id, whatever the source calls it (Id, ID, gid, sys_id, …). */
export const recordId = values => { if (!values) return null; const k = Object.keys(values).find(x => /^(id|gid|sys_id|uuid|key)$/i.test(x)) || Object.keys(values).find(x => /id$/i.test(x)); return k ? values[k] : null; };

/** The fixture ids a use case refers to. */
export function fixtureRefs(u) {
  const out = new Set();
  for (const t of texts(u)) for (const m of t.matchAll(FIXTURE_REF)) out.add(m[1]);
  return out;
}

/** Replace {{fixture:id.Field}} with bound values. In SQL a value is escaped for a quoted literal. */
export function renderFixtures(text, values = {}, { sql = false } = {}) {
  const missing = new Set();
  const out = String(text ?? '').replace(FIXTURE_REF, (m, id, field) => {
    const row = values[id];
    const v = row ? Object.entries(row).find(([k]) => k.toLowerCase() === field.toLowerCase())?.[1] : undefined;
    if (v == null) { missing.add(`${id}.${field}`); return m; }
    return sql ? String(v).replace(/'/g, "''") : String(v);
  });
  return { text: out, missing: [...missing] };
}

/** A use case with every fixture reference filled — request, variants, expected behaviour, checks. */
export function renderUseCase(u, values = {}) {
  const miss = new Set();
  const R = (t, sql) => { if (t == null) return t; const r = renderFixtures(t, values, { sql }); r.missing.forEach(x => miss.add(x)); return r.text; };
  const check = u.check ? { ...u.check } : null;
  if (check) for (const k of CHECK_SQL) if (check[k]) check[k] = R(check[k], true);
  if (check?.expect) check.expect = Object.fromEntries(Object.entries(check.expect).map(([k, v]) => [k, typeof v === 'string' ? R(v, false) : v]));
  /* a cleanup procedure's parameters are values, not SQL: filled unescaped, so a fixture's id reaches it */
  if (check?.cleanup_procedure?.parameters) check.cleanup_procedure = { ...check.cleanup_procedure,
    parameters: Object.fromEntries(Object.entries(check.cleanup_procedure.parameters).map(([k, v]) => [k, typeof v === 'string' ? R(v, false) : v])) };
  let follow_up = null;
  if (u.follow_up) {
    const fc = u.follow_up.check ? { ...u.follow_up.check } : null;
    if (fc) for (const k of CHECK_SQL) if (fc[k]) fc[k] = R(fc[k], true);
    if (fc?.expect) fc.expect = Object.fromEntries(Object.entries(fc.expect).map(([k, v]) => [k, typeof v === 'string' ? R(v, false) : v]));
    follow_up = { ...u.follow_up, reply: R(u.follow_up.reply), expected_behavior: (u.follow_up.expected_behavior || []).map(e => R(e)), check: fc };
  }
  return { request: R(u.request), variants: (u.variants || []).map(v => R(v)), expected_behavior: (u.expected_behavior || []).map(e => R(e)),
           check, follow_up, missing: [...miss] };
}

/** Example values per fixture, for judging and linting a request before any account is bound. */
export const exampleValues = cat => Object.fromEntries((cat?.fixtures || []).map(f => [f.id, f.example || {}]));
/** A request as a reader sees it before binding: fixture names replaced by their examples. */
export const withExamples = (text, cat) => renderFixtures(text, exampleValues(cat)).text;

/** Fixtures in dependency order; a cycle or an unknown dependency is reported, not looped on. */
export function bindOrder(fixtures = []) {
  const byId = new Map(fixtures.map(f => [f.id, f]));
  const order = [], seen = new Set(), stack = new Set(), problems = [];
  const visit = id => {
    if (seen.has(id)) return;
    if (stack.has(id)) { problems.push(`fixture ${id} depends on itself through a cycle`); return; }
    const f = byId.get(id);
    if (!f) return;
    stack.add(id);
    for (const d of f.depends_on || []) { if (!byId.has(d)) problems.push(`fixture ${id} depends on ${d}, which is not defined`); else visit(d); }
    stack.delete(id); seen.add(id); order.push(f);
  };
  for (const f of fixtures) visit(f.id);
  return { order, problems };
}

/** Mechanical problems with the fixtures and with how use cases refer to them. */
export function fixtureProblems(cat) {
  const fx = cat?.fixtures || [];
  const problems = [];
  const ids = new Set();
  for (const f of fx) {
    const at = `fixture ${f.id || '(no id)'}`;
    if (!f.id || !/^[A-Za-z0-9_-]+$/.test(f.id)) problems.push(`${at}: needs an id of letters, digits, _ or -`);
    else if (ids.has(f.id)) problems.push(`${at}: defined twice`); else ids.add(f.id);
    if (!f.describe || String(f.describe).trim().split(/\s+/).length < 3) problems.push(`${at}: describe the record it needs in words (who reads the report must know what was looked for)`);
    if (!/^\s*SELECT\b/i.test(f.find_sql || '')) problems.push(`${at}: find_sql must be a SELECT that returns suitable existing records`);
    else { const sel = /^\s*SELECT\s+([\s\S]*?)\s+FROM\b/i.exec(f.find_sql)?.[1] || '';
           if (!/\b(id|gid|sys_id|uuid|key|\w*id)\b/i.test(sel) && sel.trim() !== '*') problems.push(`${at}: find_sql must return the record's Id`); }
    if (HARDCODED_ID.test(f.find_sql || '')) problems.push(`${at}: find_sql names a record by its id — find it by what it is, so it works on any account`);
    for (const s of [].concat(f.seed || [])) if (!/^\s*INSERT\b/i.test(String(s))) problems.push(`${at}: each seed statement must be an INSERT`);
    if (!f.example || typeof f.example !== 'object') problems.push(`${at}: needs example values (e.g. {"Name": "…"}) so the request can be judged before an account is bound`);
  }
  problems.push(...bindOrder(fx).problems);
  for (const u of cat?.use_cases || []) {
    if (u.status === 'retired') continue;
    for (const id of fixtureRefs(u)) if (!ids.has(id)) problems.push(`${u.id || 'a use case'}: refers to fixture ${id}, which is not defined`);
  }
  return problems;
}

/** A short, stable hash of the records a run used — part of the results fingerprint. */
export function bindingsHash(td) {
  const f = td?.fixtures || {};
  const core = Object.keys(f).sort().filter(k => f[k]?.values).map(k => [k, recordId(f[k].values)]);
  return core.length ? createHash('sha1').update(JSON.stringify(core)).digest('hex').slice(0, 12) : null;
}

/** id → bound values, for the fixtures found or seeded. */
export const boundValues = td => Object.fromEntries(Object.entries(td?.fixtures || {}).filter(([, v]) => ['found', 'seeded'].includes(v.status) && v.values).map(([k, v]) => [k, v.values]));
