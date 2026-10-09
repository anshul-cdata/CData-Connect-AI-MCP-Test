/* realism.mjs — what makes a test read like the business, as code.
 *
 * Management reviewed asn005's 329 Asana prompts and found most of them unrealistic, and they were
 * right: "Show me each ProjectFollowers record together with the Workspaces it belongs to", "Change
 * the Archived on one Projects record … then set it back exactly as you found it", "Work only in
 * workspace 1209868780107533". Three distinct defects, each one mechanical enough to detect:
 *
 *   1. the schema leaks into the question — CamelCase table names, "X records", SQL vocabulary;
 *   2. the test harness leaks into the question — "read it back", "say plainly", "do not invent";
 *   3. raw identifiers leak into the question — workspace and record ids nobody types.
 *
 * `lintPrompt` finds all three. It is used by generate-tests.mjs (so drafts are born clean), by
 * review-merge.mjs and realism-check.mjs (so a rewrite that reintroduces them is caught), and by the
 * tests. It cannot tell whether a question is one a real person would ask — that is the realism
 * judge's job — but it guarantees the judge never has to spend its attention on these.
 *
 * `headlineColumns` is the other half of realism: the columns a person means when they say "show me
 * the tasks". None of asn005's 22 Tasks queries selected the task's Name, because the projection
 * walked column roles in a fixed order and `descriptive` came last.
 */

/* ── harness phrases: instructions to the agent under test, not words a user says ──────────── */
export const TESTER_PHRASES = [
  [/\bread (it|them|its current value|the current value)\b[^.]*\bback\b|\bby reading it back\b/i, 'asks the agent to read its own write back'],
  [/\bset it back\b|\bput (it|them|the workspace|everything) back\b|\bas you found it\b|\bleave the workspace\b/i, 'asks the agent to restore state'],
  [/\b(say|tell me) (so )?plainly\b/i, 'tells the agent how to report a limitation'],
  [/\bdo not (invent|guess|make up)\b|\brather than guessing\b|\bnot by guessing\b/i, 'warns the agent against hallucinating'],
  [/\bnothing is prepared\b|\bconnector'?s own (tools|metadata)\b|\bfrom the metadata\b/i, 'tells the agent how to discover the schema'],
  [/\bwork out the steps yourself\b|\bcarry this out end to end\b/i, 'describes the test instead of the job'],
  [/\bconfirm (each one|it|that it|each step) (actually )?(took|worked|landed)\b/i, 'asks for verification the user would not ask for'],
  [/\bthrowaway\b|\btest data\b|\btest record\b/i, 'names the test itself'],
  [/\bwork only in workspace\b|\bdo not touch any other workspace\b/i, 'pins the write target inside the question'],
  [/\bfind a suitable \w+ first\b/i, 'scripts the agent\'s first step'],
  [/\bwhere it breaks\b|\bif it fails\b|\bwhether the delete was refused\b/i, 'asks the agent to report on the connector'],
];

/* SQL vocabulary. Upper-case keywords only for the ambiguous words — "where" and "select" are
 * ordinary English, "WHERE" and "SELECT" are not. */
const SQL_JARGON = [
  /\b(INNER|LEFT|RIGHT|OUTER|SELF)[ -]JOIN\b/i, /\bGROUP BY\b/i, /\bHAVING\b/, /\bsub-?query\b/i,
  /\bUNION\b/, /\bOFFSET\b/, /\bSELECT\b/, /\bWHERE\b/, /\bLIMIT \d/, /\bDISTINCT\b/, /\bNULL\b/,
  /\bCASE WHEN\b/i, /\bin uppercase\b/i, /\bprimary key\b|\bforeign key\b|\bjoin key\b/i,
];

const RAW_ID = /\b\d{6,}\b/;

/** "ProjectFollowers" → "project followers", "SubTasks" → "subtasks". Words a person would say. */
export function humanize(name) {
  const words = String(name || '').replace(/[_-]+/g, ' ').split(/(?<=[a-z0-9])(?=[A-Z])|\s+/).filter(Boolean);
  return words.map(w => w.toLowerCase()).join(' ')
    .replace(/\bsub (tasks?|items?|projects?)\b/g, 'sub$1')
    .replace(/\bid\b/g, 'ID');
}

/** A singular noun phrase: "time tracking entries" → "time tracking entry". */
export function singular(phrase) {
  return String(phrase).replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/([^s])s$/, '$1');
}

/**
 * Everything mechanical that makes a prompt read like a test instead of a person.
 * @param {string} prompt
 * @param {{objects?: string[], procedures?: string[], columns?: string[]}} known — schema names
 * @returns {{code: string, detail: string}[]} empty when clean
 */
export function lintPrompt(prompt, known = {}) {
  const s = String(prompt || '');
  const issues = [];
  if (!s.trim()) return [{ code: 'empty', detail: 'no prompt' }];

  for (const [re, why] of TESTER_PHRASES) {
    const m = re.exec(s);
    if (m) issues.push({ code: 'tester_instruction', detail: `"${m[0]}" — ${why}` });
  }

  const id = RAW_ID.exec(s);
  if (id) issues.push({ code: 'raw_id', detail: `"${id[0]}" — a raw identifier nobody types` });

  for (const re of SQL_JARGON) {
    const m = re.exec(s);
    if (m) { issues.push({ code: 'sql_jargon', detail: `"${m[0]}" — SQL vocabulary` }); break; }
  }

  /* A schema name is a leak when it could only have come from getTables: CamelCase compounds
   * (ProjectFollowers, TimeTrackingEntries) anywhere, and any table name used as "<Name> record".
   * "tasks" and "projects" in lower case are how people talk and stay allowed. */
  const names = [...new Set([...(known.objects || []), ...(known.procedures || [])].map(String))];
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/[a-z][A-Z]/.test(n) && new RegExp(`\\b${esc}\\b`).test(s)) {
      issues.push({ code: 'schema_name', detail: `"${n}" — a table or procedure name, not a word people use` });
    } else if (new RegExp(`\\b${esc} records?\\b`).test(s)) {
      issues.push({ code: 'schema_name', detail: `"${n} record" — schema phrasing` });
    }
  }
  for (const c of known.columns || []) {
    if (/[a-z][A-Z]/.test(c) && new RegExp(`\\b${c}\\b`).test(s))
      issues.push({ code: 'schema_name', detail: `"${c}" — a column name, not a word people use` });
  }
  return issues;
}

/* 3.6 — advice on how a request reads, for the writer. Warnings only: a person can legitimately ask
 * several things at once. Judge round 1 of the Asana TR catalog caught six of these by hand. */
const WRITE_VERBS = /\b(create|add|log|update|change|rename|move|set|assign|reassign|delete|remove|archive|close|complete|mark|approve|submit|extend|reduce|drop|bump)\b/gi;
const EXPORT = /\b(export|dump|sync|every (night|hour)|nightly|all (the )?(records|rows|entries) (from|in)|for (our|the) (billing|payroll) (export|system|file))\b/i;
/** A request that reads like a scheduled export or sync (3.7: reported as its own pattern). */
export const isBulkExport = text => EXPORT.test(String(text || ''));
export function adviseRequest(prompt) {
  const s = String(prompt || ''), out = [];
  const verbs = new Set((s.match(WRITE_VERBS) || []).map(v => v.toLowerCase()));
  if (verbs.size >= 3) out.push(`asks for ${verbs.size} different changes at once (${[...verbs].slice(0, 4).join(', ')}) — does a person really bundle these, or is it exercising create/update/delete?`);
  if (EXPORT.test(s)) out.push('reads like a scheduled export or sync, which is a pipeline job rather than a request to an assistant — keep it only if a person would ask it in a conversation');
  return out;
}

/* ── headline columns ───────────────────────────────────────────────────────────────────────── */
/* Columns that describe the API, not the business. An Asana task carries ResourceType,
 * ResourceSubType, AssigneeResourceType and HtmlNotes; none of them is something a person asks for. */
const PLUMBING = /resource_?(sub)?type$|^(html|raw|json)|url$|uri$|^gid$|etag|^external$|separator|^_|permalink/i;
/** true for a column that describes the API rather than the business */
export const isPlumbing = c => !!c && (c.role === 'technical' || PLUMBING.test(String(c.name || c)));

/**
 * Replace schema names in generated text with the words people use: "one Tasks record" → "one
 * task", "ProjectFollowers records" → "project followers", "Allocations" → "allocations".
 * Used on conformance prompts, which are composed from templates; business prompts are rewritten
 * by the writer instead.
 */
export function naturalize(text, names = []) {
  let s = String(text || '');
  /* longest first, so "PremiumWorkspaceTasks" is replaced before "Tasks" can eat its tail */
  for (const n of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plural = humanize(n), one = singular(plural);
    const det = `(one|each|every|a|an|the|that|this)((?: new| single| specific| existing)?)`;
    const toOne = (_, d, adj) => `${d === 'an' ? 'a' : d}${adj} ${one}`;
    s = s.replace(new RegExp(`\\b${det} ${esc} records?\\b`, 'g'), toOne)
         .replace(new RegExp(`\\b${esc} records?\\b`, 'g'), plural)
         .replace(new RegExp(`\\b(one|each|every|a|an)((?: new| single| specific| existing)?) ${esc}\\b`, 'g'), toOne)
         .replace(new RegExp(`\\b${esc}\\b`, 'g'), plural);
  }
  /* "a allocation" → "an allocation"; "u" is left alone ("a user") */
  return s.replace(/\b([Aa]) ([aeio])/g, (_, a, v) => `${a}n ${v}`);
}

/* Change-history columns describe an edit, not the record: Stories carries OldName, NewDatesDueOn
 * and OldApprovalStatus, and none of them is what the story is. */
/* case matters: "OldName" and "old_name" are history, "Newsletter" is not */
const isOldNew = n => /^(Old|New|Previous|Prior)(?=[A-Z])|^(old|new|previous|prior)_/.test(n);
/* Social and display flags sit in the status role but say nothing about where the work stands:
 * StatusUpdates' "Liked" was picked over its StatusType. */
const NOT_A_STATE = /liked|heart|pinned|edited|follow|public|private|visible|separator/i;

/** first column passing the earliest test — tests are in preference order */
const pick = (cols, ...tests) => {
  for (const t of tests) { const c = cols.find(t); if (c) return c.name; }
  return null;
};
/** first column whose name matches the earliest entry of a ranked vocabulary */
const ranked = (cols, words, shape) => {
  for (const w of words) {
    const c = cols.find(c => shape(w).test(c.name));
    if (c) return c.name;
  }
  return null;
};

const OWNERISH = /(assignee|owner|assigned_?to|created_?by|creator|author|requester|reporter|user|member|rep|manager)(_?(display_?)?name)?$/i;
const PARENT_WORDS = ['project', 'parent', 'portfolio', 'account', 'opportunity', 'customer', 'company',
  'task', 'team', 'board', 'folder', 'organi[sz]ation', 'workspace', 'section'];
const PARENTISH = new RegExp(`(${PARENT_WORDS.join('|')})_?name$`, 'i');

/**
 * The columns a person means by "show me the <things>": what it is called, who owns it, where it
 * stands, the date that matters, the figure that matters, and what it belongs to. Generic on
 * purpose — every CRM, ERP, ticketing and project tool has these, under different names.
 *
 * Stage 3 may set `object.headline_columns` (array of names, or {label, owner, state, key_date,
 * amount, parent}); when present it wins, because the semantic pass read the meanings and this
 * only reads names and roles.
 *
 * @param {{columns?: object[], headline_columns?: string[]|object}} obj — a knowledge.objects entry
 * @returns {{label, owner, state, key_date, amount, parent, list: string[]}}
 */
export function headlineColumns(obj) {
  const all = ((obj && obj.columns) || []).filter(c => c && c.name && !c.pseudo);
  const real = new Set(all.map(c => c.name));
  const SLOTS = ['label', 'owner', 'state', 'key_date', 'amount', 'parent'];
  const set = obj && obj.headline_columns;
  if (set && (Array.isArray(set) ? set.length : Object.keys(set).length)) {
    const named = Array.isArray(set) ? { list: set } : set;
    const list = (named.list || SLOTS.map(k => named[k])).filter(n => n && real.has(n));
    if (list.length) {
      const r = Object.fromEntries(SLOTS.map(k => [k, named[k] && real.has(named[k]) ? named[k] : null]));
      if (!r.label) r.label = list[0];
      return { ...r, list };
    }
  }

  const cols = all.filter(c => c.role !== 'technical' && !PLUMBING.test(c.name) && !isOldNew(c.name));
  const textual = cols.filter(c => c.role === 'descriptive' || c.role === 'dimension');
  const isOwner = c => OWNERISH.test(c.name);
  const isParent = c => PARENTISH.test(c.name) && !/^assignee/i.test(c.name);

  const label = pick(textual,
    c => /^(name|title|subject|summary|display_?name|full_?name|label|headline)$/i.test(c.name),
    c => c.role === 'descriptive' && /name$|title$/i.test(c.name) && !isOwner(c) && !isParent(c),
    c => c.role === 'descriptive' && !isOwner(c) && !isParent(c) && !/notes?$|description$|body$|html/i.test(c.name),
    c => /^(text|body|description)$/i.test(c.name));

  const owner = pick(textual,
    c => isOwner(c) && /name$/i.test(c.name) && !/^created|^creator/i.test(c.name),
    c => isOwner(c) && /name$/i.test(c.name))
    || pick(cols, c => isOwner(c) && c.role === 'relationship_key' && !/^created|^creator/i.test(c.name));

  const states = cols.filter(c => c.role === 'status' && !NOT_A_STATE.test(c.name));
  const state = ranked(states, ['status', 'state', 'stage', 'phase', 'completed', 'closed', 'resolved', 'done', 'approved', 'archived'],
      w => new RegExp(`^${w}$`, 'i'))
    || pick(states, c => /^status|status$|state$|stage$/i.test(c.name), () => true);

  const dates = cols.filter(c => c.role === 'date');
  const key_date = pick(dates,
    c => /due/i.test(c.name) && !/at$/i.test(c.name),
    c => /due/i.test(c.name),
    c => /(close|end|target|deadline|expir)/i.test(c.name),
    c => /(entered|logged|posted|occurred|transaction)/i.test(c.name),
    c => /start/i.test(c.name),
    c => /created/i.test(c.name),
    () => true);

  const measures = cols.filter(c => c.role === 'measure' && !/like|heart|follow|view/i.test(c.name));
  const amount = pick(measures,
    c => /amount|total|price|cost|revenue|balance|value/i.test(c.name),
    c => /duration|minutes|hours|effort|estimate|quantity|qty/i.test(c.name));

  const parentText = ranked(textual.filter(isParent), PARENT_WORDS, w => new RegExp(`${w}_?name$`, 'i'));
  /* A workspace or section name is a weak parent; a project key names the thing people mean. */
  const parentKey = pick(cols, c => /^(project|parent|account|portfolio)_?id$/i.test(c.name));
  const parent = parentText && !/^(workspace|section)/i.test(parentText.replace(/^.*?(workspace|section)/i, '$1'))
    ? parentText : (parentKey || parentText);

  const list = [...new Set([label, owner, state, key_date, amount, parent].filter(Boolean))];
  return { label, owner, state, key_date, amount, parent, list };
}

/* ── persona archetypes ─────────────────────────────────────────────────────────────────────── */
/* The fixed shape every connector's personas map onto. The names are the connector's own (Sales
 * Rep, AP Clerk, Project Manager); the archetype is what makes two connectors comparable and lets
 * one connector's reviewed profile seed another in the same business domain. */
export const ARCHETYPES = ['doer', 'coordinator', 'analyst', 'executive', 'administrator', 'integrator'];
/* the three a realistic suite cannot do without; the others are reported when missing */
export const REQUIRED_ARCHETYPES = ['doer', 'coordinator', 'analyst'];

/* ── the realism rubric ─────────────────────────────────────────────────────────────────────── */
/* One set of words for every judge: the plan gate (realism-check.mjs) and the catalog judge
 * (manage-catalog.mjs) score against the same criteria, so a catalog score and a plan score mean
 * the same thing. */
export function rubric(minScore = 4) {
  return {
    scale: '1 = no real person would ask this · 3 = plausible but stilted or generic · 5 = exactly how this persona asks it on an ordinary day',
    criteria: {
      persona_fit:     'Would THIS persona, doing their job, ask it? A question an executive would never ask is not an executive scenario.',
      real_goal:       'Is there a decision or task behind it — something they need the answer for — rather than data for its own sake?',
      natural_wording: 'Is it in their words? No table or column names, ids, SQL vocabulary, or instructions to an AI.',
      everyday:        'Is it something people ask routinely, rather than an edge case invented to exercise a feature?',
      answerable:      'Could the system plausibly answer it from its own data? For a request the source cannot do: do people really ask it, and expect to be told plainly that it is not possible?',
      delegation:      'Would a person hand this to an AI assistant rather than click it in the app themselves? Strongest when it needs finding, combining, deciding or acting; a one-click lookup the app already shows is weak.',
    },
    pass: `score >= ${minScore}`,
  };
}
