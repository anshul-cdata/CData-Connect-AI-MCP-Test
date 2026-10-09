/**
 * sql-patterns.mjs — the ONE place SQL pattern detection lives.
 *
 * Used by mine-dump.mjs (customer evidence) and parse-sql.mjs (observed SQL from execution),
 * so the two can never disagree about what "filter_date_range" means. Pattern names match
 * references/04-coverage-model.md §5.4 exactly.
 *
 * Some patterns are only decidable with column roles (is [Status] an enum? is [d] a date?).
 * parseSql() accepts an optional roles map {column -> role} and refines when it has one;
 * without it, those patterns fall back to their syntactic parent (filter_equality etc.).
 */

/* ── syntactic patterns: decidable from SQL text alone ─────────────────────── */
export const SYNTACTIC = {
  select:                   /\bSELECT\b[\s\S]*?\bFROM\b/i,
  select_projection:        /\bSELECT\s+(?!\*)(?!DISTINCT\s+\*)[\s\S]*?\bFROM\b/i,
  select_star_guard:        /\bSELECT\s+(?:DISTINCT\s+)?(?:\w+\.)?\*\s+FROM\b/i,
  distinct:                 /\bSELECT\s+DISTINCT\b/i,
  filter_equality:          /\bWHERE\b[\s\S]*?(?<![<>!])=(?!=)/i,
  filter_comparison:        /\bWHERE\b[\s\S]*?(?:<>|!=|<=|>=|<|>)/i,
  filter_in:                /\b(?<!NOT\s)IN\s*\(/i,
  filter_like:              /\b(?<!NOT\s)LIKE\b/i,
  filter_null:              /\bIS\s+(?:NOT\s+)?NULL\b/i,
  filter_date_range:        /\bBETWEEN\s+'?\d{4}-\d{2}-\d{2}|[<>]=?\s*'\d{4}-\d{2}-\d{2}/i,
  filter_and:               /\bWHERE\b[\s\S]*?\bAND\b/i,
  filter_or:                /\bWHERE\b[\s\S]*?\bOR\b/i,
  filter_logic_grouped:     /\bWHERE\b[\s\S]*?\([^()]*\b(?:OR|AND)\b[^()]*\)/i,
  filter_negation:          /\bNOT\s+(?:IN|LIKE)\b|<>|!=/i,
  order_by:                 /\bORDER\s+BY\b/i,
  limit:                    /\bLIMIT\s+\d|\bTOP\s+\d|\bFETCH\s+(?:FIRST|NEXT)\b/i,
  offset_pagination:        /\bOFFSET\s+\d/i,
  aggregate_count:          /\bCOUNT\s*\(/i,
  aggregate_sum_avg_minmax: /\b(?:SUM|AVG|MIN|MAX)\s*\(/i,
  group_by:                 /\bGROUP\s+BY\b/i,
  having:                   /\bHAVING\b/i,
  join_left:                /\bLEFT\s+(?:OUTER\s+)?JOIN\b/i,
  join_right_full_cross:    /\b(?:RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN\b/i,
  subquery:                 /\(\s*SELECT\b/i,
  union:                    /\bUNION\b/i,
  case_when:                /\bCASE\s+WHEN\b/i,
  date_function:            /\b(?:GETDATE|DATEADD|DATEDIFF|DATENAME|DATEPART|YEAR|MONTH|QUARTER|DAY|NOW|CURRENT_DATE|CURRENT_TIMESTAMP)\s*\(/i,
  string_function:          /\b(?:CONCAT|SUBSTRING|TRIM|LTRIM|RTRIM|UPPER|LOWER|LEN|LENGTH|REPLACE|CHARINDEX)\s*\(/i,
  math_function:            /\b(?:ROUND|ABS|CEILING|FLOOR|POWER|SQRT|MOD)\s*\(/i,
  stored_procedure:         /^\s*(?:EXEC|EXECUTE|CALL)\b/i,
  insert:                   /^\s*INSERT\b/i,
  update:                   /^\s*UPDATE\b/i,
  delete:                   /^\s*DELETE\b/i,
  parameterized:            /@[A-Za-z_]\w*/,
};

/** Patterns whose detection depends on literal values being inlined — masked by @param binding. */
export const LITERAL_DEPENDENT = new Set(['filter_date_range', 'filter_like']);

/** Patterns that need column roles to name precisely; the key is the role, the value the refined pattern.
 *  `date` is deliberately absent: filtering a date column with DATEADD() is `date_function`, not a literal
 *  range, and the syntactic filter_date_range regex already catches BETWEEN / literal-date comparisons.
 *  Refining on role here would credit a range pattern the agent never sent. */
export const ROLE_REFINED = {
  status:  'filter_enum',
  bool:    'filter_boolean',
  measure: 'filter_numeric_threshold',
};

const RE_OBJ       = /(?:FROM|JOIN|INTO|UPDATE)\s+(?:\[([^\]]+)\]\.)?(?:\[([^\]]+)\]\.)?\[([^\]]+)\](?:\s+(?:AS\s+)?(\w+))?/gi;
const RE_COL       = /\[([A-Za-z_][^\]]{0,80})\]/g;
const RE_JOIN      = /\bJOIN\s+(?:\[[^\]]+\]\.)*\[([^\]]+)\](?:\s+(?:AS\s+)?(\w+))?\s+ON\s+([^\s]+)\s*=\s*([^\s)]+)/gi;
const RE_WHERE     = /\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bHAVING\b|$)/i;
const RE_ANY_JOIN  = /\bJOIN\b/gi;
const RE_PLAIN_JOIN = /(?<!LEFT\s)(?<!RIGHT\s)(?<!FULL\s)(?<!CROSS\s)(?<!OUTER\s)\b(?:INNER\s+)?JOIN\b/i;

/**
 * Parse one SQL statement into the structure Stage 10 credits coverage from.
 * @param {string} sql
 * @param {Record<string,string>=} roles  column name -> role (date|status|measure|bool|...)
 */
export function parseSql(sql, roles) {
  const q = String(sql || '');
  const objects = [];
  for (const m of q.matchAll(RE_OBJ)) objects.push(m[3]);
  const objSet = new Set(objects);

  const columns = [];
  const seen = new Set();
  for (const m of q.matchAll(RE_COL)) {
    const c = m[1];
    if (objSet.has(c) || seen.has(c)) continue;
    seen.add(c); columns.push(c);
  }

  const joins = [];
  for (const m of q.matchAll(RE_JOIN)) {
    const to = m[1], from = objects[0] || null;
    if (from && to !== from) joins.push({ from, to, on: (m[3] + ' = ' + m[4]).replace(/\[|\]/g, '') });
  }

  const patterns = new Set();
  for (const [name, re] of Object.entries(SYNTACTIC)) if (re.test(q)) patterns.add(name);
  if (RE_PLAIN_JOIN.test(q)) patterns.add('join_inner');

  const joinCount = (q.match(RE_ANY_JOIN) || []).length;
  if (joinCount >= 2) patterns.add('join_multi_table');
  if (objects.length && new Set(objects.map(o => o.toLowerCase())).size < objects.length) patterns.add('join_self');

  const whereClause = (q.match(RE_WHERE) || [])[1] || '';
  { let d = 0, mx = 0;
    for (const ch of whereClause) { if (ch === '(') mx = Math.max(mx, ++d); else if (ch === ')') d--; }
    if (mx >= 2) patterns.add('filter_nested_deep'); }

  if (roles && typeof roles === 'object') {
    for (const m of whereClause.matchAll(RE_COL)) {
      const role = roles[m[1]] ?? roles[m[1].toLowerCase()];
      const refined = role && ROLE_REFINED[role];
      if (refined) patterns.add(refined);
    }
  }

  return { objects: [...objSet], columns, joins, patterns: [...patterns].sort() };
}

/** Lowercase, collapse whitespace, replace literals with ? — for TC dedup. */
export function fingerprint(sql) {
  return String(sql || '')
    .replace(/'[^']*'/g, '?').replace(/\b\d+(?:\.\d+)?\b/g, '?').replace(/@\w+/g, '?')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Remove literal values but keep structure — safe to persist from a customer dump. */
export function stripLiterals(sql) {
  return String(sql || '')
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+)?\b/g, '?')
    .replace(/(?<=[=<>(,\s])\d+(?:\.\d+)?(?=[\s,)]|$)/g, '?')
    .replace(/\s+/g, ' ').trim();
}

/** The measured prior — which patterns real users actually issue. Drives applicability defaults. */
export const MEASURED_PRIOR = {
  source: '13,826 real MCP queries: NetSuite SuiteQL, NetSuite SuiteTalk, Salesforce, QuickBooks Online (Sep 2026)',
  near_zero: ['date_function', 'having', 'offset_pagination', 'subquery', 'union', 'distinct',
              'join_right_full_cross', 'filter_negation', 'filter_nested_deep', 'string_function', 'math_function'],
  dominant:  ['filter_equality', 'order_by', 'limit', 'select_projection', 'filter_and', 'filter_in',
              'join_inner', 'join_left', 'join_multi_table', 'filter_logic_grouped'],
};

/** Band membership — mirrors 04-coverage-model.md "The floor". */
export const BANDS = {
  1: ['select', 'select_projection', 'filter_equality', 'limit', 'order_by'],
  2: ['filter_comparison', 'filter_date_range', 'filter_null', 'filter_in', 'filter_and', 'filter_or',
      'filter_logic_grouped', 'join_inner', 'join_left', 'join_multi_table', 'aggregate_count',
      'group_by', 'aggregate_sum_avg_minmax', 'stored_procedure', 'insert', 'update', 'delete',
      'filter_numeric_threshold', 'filter_enum', 'filter_boolean', 'filter_like', 'filter_date_boundary'],
  3: ['having', 'offset_pagination', 'subquery', 'union', 'distinct', 'date_function',
      'string_function', 'math_function', 'case_when', 'join_self', 'join_right_full_cross',
      'filter_negation', 'filter_nested_deep', 'select_star_guard'],
};
export function bandOf(pattern) {
  for (const [b, list] of Object.entries(BANDS)) if (list.includes(pattern)) return Number(b);
  return null;
}
