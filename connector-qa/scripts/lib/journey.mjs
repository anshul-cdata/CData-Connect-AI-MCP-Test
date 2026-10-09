/* journey.mjs — what the agent under test actually did, as structured steps.
 *
 * Stage 9's agent returns its MCP calls in order. Until 3.0 they were folded into a verdict and a
 * few step marks, with results cut to 300 characters; nothing could be scored or compared across
 * models afterwards. This normalises the raw call log into steps that say, for every call: what
 * kind of step it was, the exact input, the reason the agent gave, what came back, which error
 * class it hit and whose fault that was, and whether it was a retry of, or a recovery from, an
 * earlier failure. Every metric the scorer uses is derived here, so it is the same for every
 * connector and every model.
 *
 * Nothing in here knows about any particular connector. Error classes match CData's common error
 * wording and HTTP status codes; anything else is `unclassified`, which the report lists so the
 * taxonomy can grow.
 */

export const DISCOVERY = new Set(['getCatalogs', 'getSchemas', 'getTables', 'getColumns', 'getInstructions',
  'getProcedures', 'getProcedureParameters', 'getStarted', 'search_context']);
const QUERY = new Set(['queryData']);
const PROC = new Set(['executeProcedure']);
const WRITE_TOOL = new Set(['execute_insert', 'execute_update', 'execute_delete']);
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|MERGE|UPSERT)\b/i;

/* The source's plan, edition or add-ons lack the feature. One pattern for every script that asks
 * (credit-coverage.mjs too): in asn-tr1 Asana's "Time tracking is not available on your current plan
 * or add-ons" and "… requires resource management features to be enabled in an enterprise
 * organization" were recognised by coverage crediting but not here, so honest refusals were charged
 * to nobody and scored as wrong answers. */
export const PLAN_LIMIT = /premium|paid plan|upgrade your plan|not available (for (free users|this (task|workspace|plan))|on (your|the|this) (current )?(plan|edition|subscription|tier))|plan or add-?ons|requires? an? (business|enterprise|premium) (plan|tier|organi[sz]ation)|requires? .{0,80}\b(features?|add-?on)s? to be enabled|enabled in an? (business|enterprise|premium) (organi[sz]ation|plan|account)/i;

/* [class, pattern, cause]. Order matters: the first match wins. `cause` is who owns the fix —
 * connector (the driver or server), instructions (the usage instructions the agent reads through
 * getInstructions did not tell it something it needed: the catalog, the schema, a required filter),
 * metadata (the schema the connector advertises contradicts itself — see attributeCauses), ai (the
 * agent guessed wrong), account (the test account's data or rights), harness (the test harness
 * blocked the call before it reached the connector — nobody's product fault, but the attempt is not
 * valid evidence). */
export const ERROR_CLASSES = [
  ['catalog_not_found',     /catalog\b[^.]*\b(does not exist|is inaccessible|not found|unknown)/i, 'instructions'],
  ['schema_not_found',      /schema\b[^.]*\b(does not exist|not found|unknown)/i, 'instructions'],
  ['table_not_found',       /invalid object name|\b(table|object|view)\b[^.]*\b(does not exist|not found|could not be found|unknown)/i, 'ai'],
  ['column_not_found',      /\bcolumn\b[^.]*\b(not found|does not exist|unknown|invalid)|invalid column name|unrecognized column/i, 'ai'],
  /* the dialect has its own function set; an agent cannot know it unless the instructions list it */
  ['unsupported_function',  /\bfunction\b[^.]*\b(not supported|is not recognized|unknown|does not exist)/i, 'instructions'],
  ['timeout',               /time[d]?[ -]?out|timeout|took too long/i, 'connector'],
  ['rate_limit',            /rate limit|too many requests|\b429\b|throttl/i, 'connector'],
  /* the connector's MCP server did not answer at all — not the agent's query */
  ['server_unavailable',    /server (isn't|is not) responding|service unavailable|\b50[23]\b|bad gateway|cannot obtain connection/i, 'connector'],
  /* the source's plan or licence lacks the feature (Asana: goals and dependencies need a paid plan) —
   * before `permission`, because those messages often say "premium permissions" */
  ['plan_limit',            PLAN_LIMIT, 'account'],
  /* the test harness (Claude Code's permission check) refused the call before it reached the connector */
  ['harness_blocked',       /denied by the claude code|auto mode classifier|permission to use [^ ]+ has been denied|tool use was rejected/i, 'harness'],
  ['auth_required',         /action required[^.]*authenticate|re-?authenticate|authenticate this connection/i, 'account'],
  ['permission',            /permission|forbidden|\b403\b|not authori[sz]ed|\b401\b|access denied/i, 'account'],
  /* a source that only lists records under a parent: "Column Id or [OwnerId and WorkspaceId] is required",
   * "You should specify one of team, user + workspace" — the agent cannot know this unless it is told */
  ['required_filter',       /(requires?|must (specify|include|provide))\b[^.]*\b(filter|criteria|where|parameter)|is required to retrieve the results|(should|must) specify (exactly )?one of|expects one of the following|not a valid regular workspace/i, 'instructions'],
  ['unsupported_operation', /not supported|unsupported|read[- ]only|cannot be (inserted|updated|deleted)|could not be (inserted|updated|deleted)|unable to perform '?\w+'? operation|operation is not allowed/i, 'connector'],
  /* the result was bigger than the agent's context can take — the agent read without a filter or limit */
  ['result_too_large',      /exceeds maximum allowed tokens|result \([\d,]+ characters\) exceeds|response too large/i, 'ai'],
  ['syntax_error',          /syntax error|parse error|unexpected (token|end)|malformed|mismatched input/i, 'ai'],
  ['record_not_found',      /\b404\b|(record|resource)\b[^.]*\bnot found|no such|does not refer to a/i, 'ai'],
];

/* the name an error says was not found: "Unrecognized column [Text] in query for table [Projects]",
 * "Invalid column name 'Foo'", "Table 'Bar' does not exist" */
const NAME_IN_ERROR = /(?:column|table|object|view)(?:\s+name)?\s*[\['"]([A-Za-z0-9_ ]+?)[\]'"]/i;
const TABLE_IN_ERROR = /for table\s*\[([A-Za-z0-9_]+)\]/i;
const lastPart = t => String(t || '').replace(/[[\]]/g, '').split('.').pop();
const fromTable = sql => { const m = /\bFROM\s+((?:\[[^\]]+\]|[A-Za-z0-9_]+)(?:\.(?:\[[^\]]+\]|[A-Za-z0-9_]+))*)/i.exec(String(sql || '')); return m ? lastPart(m[1]) : null; };
const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(text);
const tableOfInput = input => { try { return JSON.parse(input || '{}').tableName || null; } catch { return /tableName"?\s*:\s*"([^"]+)"/.exec(String(input || ''))?.[1] || null; } };

/**
 * Whose fix is each failed call? Re-derived from the stored error text, so a journey stored before a
 * change to the taxonomy takes the current attribution without being run again. One rule needs the
 * journey, not just the error: a table or column the connector itself advertised earlier in the same
 * journey (a successful getTables, or getColumns of that table) and then rejected is the METADATA's —
 * the schema contradicts itself. A name it never advertised is the agent's guess.
 */
export function attributeCauses(steps) {
  const tables = [], columns = new Map();
  for (const s of steps || []) {
    if (s.ok) {
      if (s.tool === 'getTables' && s.result) tables.push(String(s.result));
      const t = s.tool === 'getColumns' && s.result ? tableOfInput(s.input) : null;
      if (t) { const k = lastPart(t).toLowerCase(); columns.set(k, (columns.get(k) || '') + '\n' + s.result); }
      continue;
    }
    if (!s.error) continue;
    const e = classifyError(s.error);
    let cause = e.cause;
    const name = NAME_IN_ERROR.exec(s.error)?.[1]?.trim();
    if (name && e.class === 'column_not_found') {
      const t = (TABLE_IN_ERROR.exec(s.error)?.[1] || fromTable(s.input) || '').toLowerCase();
      if (t && columns.has(t) && mentions(columns.get(t), name)) cause = 'metadata';
      /* stored results are trimmed (ingest keeps 1,500 characters): a listing cut short cannot show the
       * name was not advertised, so a cause decided on the full text stands (review 3.7.1) */
      else if (s.cause === 'metadata' && t && / …$/.test(columns.get(t) || '')) cause = 'metadata';
    }
    if (name && e.class === 'table_not_found' && tables.some(r => mentions(r, lastPart(name)))) cause = 'metadata';
    s.error_class = e.class; s.cause = cause;
  }
  return steps;
}

export function classifyError(text) {
  const s = String(text || '');
  for (const [cls, re, cause] of ERROR_CLASSES) if (re.test(s)) return { class: cls, cause };
  return { class: 'unclassified', cause: 'unknown' };
}

const asObj = v => {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return null;
};
const sqlOf = input => {
  const o = asObj(input) || {};
  return o.query || o.sql || o.statement || null;
};
const reasonOf = (call) => {
  if (call.reason) return String(call.reason);
  const o = asObj(call.input) || {};
  const ctx = asObj(o.llmContext);
  return ctx && ctx.reason ? String(ctx.reason) : null;
};
/* An error may arrive as its own field, as an error object in the result, or as the result text
 * the MCP server returned — often after a status prefix ("[500] The query failed: …"), so the
 * opening of the text is searched rather than only its first word. */
const ERROR_TEXT = /^\s*(\[\d{3}\]\s*)?(error\b|the query failed|exception|stmt\b|failed\b)|\bthe query failed\b|\berror:\s|\bexception:\s/i;
const errorOf = call => {
  if (call.error) return String(call.error);
  const r = call.result;
  if (r && typeof r === 'object') {
    if (r.error) return typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
    if (r.isError === true) return JSON.stringify(r.content ?? r).slice(0, 2000);
    return null;
  }
  const s = typeof r === 'string' ? r : '';
  return ERROR_TEXT.test(s.slice(0, 200)) ? s : null;
};
const categoryOf = (tool, sql) => {
  if (WRITE_TOOL.has(tool) || (sql && WRITE_SQL.test(sql))) return 'write';
  if (PROC.has(tool)) return 'procedure';
  if (QUERY.has(tool)) return 'query';
  if (DISCOVERY.has(tool)) return 'discovery';
  return 'other';
};
/* the same call twice, ignoring the reason text the agent attached (as a string or an object) */
const fingerprint = (tool, input) => {
  const o = asObj(input);
  if (o && typeof o === 'object') { const { llmContext, reason, ...rest } = o; return tool + '|' + JSON.stringify(rest).replace(/\s+/g, ' '); }
  return tool + '|' + String(input ?? '').replace(/\s+/g, ' ');
};

/**
 * Normalise one agent's raw return into steps and metrics.
 * @param {{calls: object[], final_sql?: string, final_rows?: object[], answer?: string, gave_up?: boolean,
 *          wall_ms?: number, tokens?: number}} raw
 */
export function normalizeJourney(raw) {
  const calls = Array.isArray(raw?.calls) ? raw.calls : [];
  const steps = [];
  const seen = new Map();
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i] || {};
    const tool = String(c.tool || c.name || 'unknown');
    const sql = sqlOf(c.input);
    const err = errorOf(c);
    const cat = categoryOf(tool, sql);
    const fp = fingerprint(tool, c.input);
    const step = {
      n: i + 1, tool, category: cat,
      input: sql || (c.input == null ? null : (typeof c.input === 'string' ? c.input : JSON.stringify(c.input))),
      reason: reasonOf(c),
      ok: !err,
      ...(err ? { error: err, ...(() => { const e = classifyError(err); return { error_class: e.class, cause: e.cause }; })() } : {}),
      result: err ? null : (c.result == null ? null : String(typeof c.result === 'string' ? c.result : JSON.stringify(c.result))),
      rows: Number.isFinite(c.rows) ? c.rows : null,
      ms: Number.isFinite(c.ms) ? c.ms : null,
      repeated: seen.has(fp) ? seen.get(fp) : null,
    };
    seen.set(fp, step.n);
    steps.push(step);
  }
  attributeCauses(steps);

  /* retries and recoveries. A retry is a later call in the same category as a failed one; a
   * recovery is the first successful step after a failure that moves the agent forward — a
   * discovery call that fixes the cause, or the successful retry itself. */
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].ok) continue;
    const failed = steps[i];
    const later = steps.slice(i + 1);
    const retry = later.find(s => s.category === failed.category);
    if (retry && retry.retry_of == null) retry.retry_of = failed.n;
    const fix = later.find(s => s.ok);
    if (fix && fix.recovery_of == null) fix.recovery_of = failed.n;
    failed.recovered = later.some(s => s.ok && s.category === failed.category);
  }

  const acting = steps.filter(s => ['query', 'procedure', 'write'].includes(s.category));
  const firstOk = steps.findIndex(s => s.ok && ['query', 'procedure', 'write'].includes(s.category));
  const failedSteps = steps.filter(s => !s.ok);
  const metrics = {
    calls: steps.length,
    /* query, procedure and write calls — what efficiency is measured on; discovery is part of the job */
    acting_calls: acting.length,
    discovery_calls: steps.filter(s => s.category === 'discovery').length,
    failed: failedSteps.length,
    recoveries: failedSteps.filter(s => s.recovered).length,
    dead_ends: failedSteps.filter(s => !s.recovered).length,
    repeated: steps.filter(s => s.repeated != null).length,
    calls_before_first_result: firstOk >= 0 ? firstOk + 1 : null,
    writes: steps.filter(s => s.category === 'write' && s.ok).length,
    first_attempt: failedSteps.length === 0 && acting.length > 0,
    gave_up: raw?.gave_up === true,
    time_ms: Number.isFinite(raw?.wall_ms) ? raw.wall_ms : (steps.every(s => s.ms != null) && steps.length ? steps.reduce((a, s) => a + s.ms, 0) : null),
    tokens: Number.isFinite(raw?.tokens) ? raw.tokens : null,
    error_classes: [...new Set(failedSteps.map(s => s.error_class))],
  };
  return {
    steps, metrics,
    final_sql: raw?.final_sql || null,
    final_rows: Array.isArray(raw?.final_rows) ? raw.final_rows : null,
    answer: raw?.answer || null,
    assumptions: Array.isArray(raw?.assumptions) ? raw.assumptions : [],
  };
}
