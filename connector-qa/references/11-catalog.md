# Stage 5.5 · Use case catalog — what real people do with the source

**Contents**

- 5.5a Evidence — nothing is invented
- 5.5a′ What the account holds — data first (3.7)
- 5.5b Structure, wording and checks — by model
- 5.5c′ Sources — every cited page is opened
- 5.5b′ Coverage review — the whole area, fresh context
- 5.5c Realism judge — fresh context
- 5.5d Human sample — once per catalog version
- 5.5e Freeze

Prerequisites: Stage 1.5 passed (`capability-list.mjs status` exits 0) and Stage 3 complete (the
reference queries need real column names).

The catalog is the business suite: every use case a real person carries out with the source, in
their words, with the evidence that they do it and a check that decides whether an answer was
right. It is built **area by area** (3.1, `13-scope.md`): each business area is researched in
small batches, proven complete, reviewed and frozen as its own numbered version, then reused by
every later run and every eval. A run never invents business tests of its own.

```
evidence ──► structured use cases ──► coverage review ──► wording ──► checks ──► judge ──► human sample ──► freeze
(Opus, web)       (Opus)               (Opus, fresh,        (Opus)     (Opus)     (Opus,      (a person,      (script)
                                        whole area)                               fresh)     once)
```

An area that is already frozen is skipped. `manage-catalog.mjs status --areas …` says which areas
in scope still need work. Change a frozen area only when the source's product changes, or when the
human reviewer asks.

### Capability mode agents — Stages 1.5, 5.5 and 9

`config.models.research_business` reviews the capability mapping (1.5c) and runs
`agents/usecase-researcher.md`, the catalog writer (5.5a–b) and, in a fresh context,
`agents/catalog-reviewer.md`, which reads each area's whole set (5.5b′). `config.models.realism_judge`
judges the catalog in a fresh context (5.5c). `config.models.answer_judge` decides `judge` checks after Stage 9
(§9.1c); `second_judge` re-judges both independently. All are fixed in an eval; only `under_test` varies.

## 5.5a Evidence — nothing is invented

Plan the research batches with `scope.mjs research-plan --areas … | --all` (`13-scope.md` S2).
Dispatch `agents/usecase-researcher.md` once per batch, with `model: config.models.research_business`,
the batch's areas, flows, capability ids and personas, and the requests the catalog already holds
for those areas. It searches the vendor's world for proof of what people do and returns evidence
items, each with its URL. **Where it looks first (3.9):**

1. the vendor's own **use case, workflow, solution, tutorial and "how to" pages** (`vendor_use_case`) —
   they list the product's real workflows per role, so the batch starts complete;
2. the **help centre** (`help_center`); 3. **templates** (`template`); 4. **standard reports and
   dashboards** (`standard_report`); 5. the **community forum** (`community`, the best source of real
   wording); then the developer "common use cases" page and integration templates (Zapier, Make, Power BI).

The order is where to look, not how much a source weighs: evidence strength still ranks real use
first (below). Every page is read with the shared page reader (`references/10a-page-reader.md`): many
vendor sites draw their help and use case pages with JavaScript, and a plain fetch of such a page
shows nothing. A page that reads as a shell is read in a rendered browser — the desktop browser pane,
Playwright MCP or Claude in Chrome; with none available the researcher says so and the orchestrator
asks the user to enable Playwright MCP. A quote is copied from the page's own text, and the use case
cites the page URL as before. When the researcher runs as a subagent without a browser, the
orchestrator reads the JavaScript pages it names and passes their saved text
(`_agent_out/pages/<hash>.txt`).

## 5.5a′ What the account holds — data first (3.7)

Before writing use cases for an area, sample the account:
`test-data.mjs survey-prep --dir "<dir>" --areas <A>`, run each `SELECT … LIMIT 5` through
`queryData`, then `survey-merge --checks <file>` → `<Connector>_data_survey.json`. Give that file
to the writer. Use cases are still chosen from the evidence (5.5a) — the data never decides *what* is
worth testing — but they are written around records that exist: real project names, real people,
real statuses. What the account lacks becomes a fixture with a seed.

## 5.5b Structure, wording and checks — by model

From each batch's evidence, write `_agent_out/stage5_5-usecases-<batch>.json` as
`{"use_cases": [...], "fixtures": [...], "no_business_use": [...], "mix_explained": [...]}` and merge it with `manage-catalog.mjs add --from
<file> --batch <id>`. That assigns permanent ids and settles near-duplicates (requests at least
`config.catalog.dedup` similar, across the whole catalog and within the batch) by **evidence: the
better-evidenced one is kept** (3.9, `nearDuplicateChoice` in `lib/catalog.mjs`). A newcomer with
strictly stronger evidence (customer queries > real users > vendor guidance > documentation > inferred)
replaces a draft — the draft is retired with the reason and `replaced_by`; on equal or weaker evidence
the newcomer is dropped, as before. An approved use case, or one in a frozen area, is never replaced:
the stronger page is recorded beside it (`stronger_evidence`) and printed, to swap at the next review.
`validate` names which of two near-duplicates to keep. One entry per use case — for example, for Asana (the prefix, tables, columns,
people and procedure names below are that example's, not required names):

```json
{ "prefix": "ASN",
  "use_cases": [ {
    "area": "TM", "persona": "Team Lead", "moment": "before sprint planning",
    "goal": "rebalance work away from an overloaded teammate", "frequency": "weekly",
    "kind": "action", "writes": true, "priority": "P2",
    "difficulty": "medium", "tests": ["filters", "aggregation", "write"],
    "source": { "kind": "community", "title": "Rebalancing work between teammates", "url": "https://…" },
    "capabilities": ["CAP-gettasks", "CAP-updatetask"],
    "request": "Sam is overloaded this sprint — move his two lowest-priority tasks to Priya.",
    "variants": ["Take two of Sam's least urgent tasks and give them to Priya."],
    "expected_behavior": ["finds Sam's open tasks in the current sprint", "picks the two lowest priority", "reassigns both to Priya"],
    "check": { "rule": "write_visible", "expect": { "AssigneeName": "Priya Raman" },
               "reference_sql": "SELECT [Id],[Name],[AssigneeName] FROM [Tasks] WHERE [ModifiedAt] >= '{{today}}'",
               "locate_sql": "SELECT [Id] FROM [Tasks] WHERE [AssigneeName] = 'Priya Raman' AND [ModifiedAt] >= '{{today}}'",
               "cleanup_sql": "UPDATE [Tasks] SET [AssigneeName] = 'Sam Lee' WHERE [Id] IN ({{located}})",
               "min_calls": 2 }
  } ] }
```

Rules — `manage-catalog.mjs validate` enforces the mechanical ones:

- **Evidence first.** No `source` with a title **and a URL**, no use case. Every URL is opened and
  checked before the area can be frozen (§5.5c′). Prefer `community` and `help_center` sources
  for wording, `standard_report` and `template` for what matters.
- **Every capability accounted for.** Each applicable capability of the area is used by a use case,
  or goes in `no_business_use` with a real reason (≥ 3 words: "opening one task by id is a step
  inside other flows"). The freeze counts them, so a missed capability is a listed gap, not a
  silent one. A cross-area use case keeps one `area` and lists the others in `also_areas`.
- **Real workflows, all of them (3.5).** Research every way the area's people really work, not
  only single lookups: cross-object questions (people → projects → tasks → time), aggregations,
  requests that need a clarifying question or are missing a detail, and read → decide → act jobs
  that read data, choose, then change something. Keep use cases that need an unsupported
  capability — they are how gaps are found — but never let them stand in for the workflows the
  connector does support. Nothing is capped; a thin pattern is a research need, not a refusal.
- **Who, when, why before any sentence.** A use case without a persona, a goal and an area is
  refused. `frequency` sets priority: daily → P1, weekly → P2, otherwise P3.
- **The persona's words.** No table, column or procedure names, ids, SQL words or instructions to
  an AI — the realism lint refuses them. One or two `variants` for P1 use cases: a count instead of
  a list, "mine" instead of "my team's", another time window.
- **All of the business, no caps.** Every flow in every area, every persona's everyday work, every
  standard report. Stop when the structure is complete, not at a number.
- **Start from the persona's work, not the API.** Before writing, list for each persona of the
  batch the decisions and tasks that role owns (from the persona research and the evidence). Every
  use case serves one of them. A sponsor, a team lead and an analyst ask different things: never
  write the same question for several personas with the name changed. A capability earns a use
  case only when a persona has a real reason to use it — otherwise it goes in `no_business_use`.
- **Difficulty and what it tests.** `difficulty` is `simple` (one kind of record, one lookup or
  filter), `medium` (two related kinds of record, or a filter with dates, totals or ranking, or one
  change after a lookup) or `complex` (several dependent steps, several kinds of record, a
  decision made from what was read, or a change that depends on it). `tests` lists what the
  request asks of the AI beyond finding the data: `filters` · `dates` (incl. "this week",
  "overdue") · `aggregation` (sort, group, count, rank) · `relationships` (links between objects)
  · `multi_step` · `write` · `ambiguity` · `missing_info` · `limitation`. Tag only what the request
  really needs.
- **The hard cases are part of the business.** Each area needs, as well as its everyday work, at
  least the floors in `catalog.mix`: a few complex requests, requests with relative dates, totals
  or rankings, and links between objects; and at least one of each:
  - **ambiguity** — a request real people send that can be read two ways ("how is the launch
    going?" with two launch projects). `expected_behavior`: asks which one, or names the
    assumption it made and answers.
  - **missing_info** — a request without a detail the AI cannot guess ("move the review to next
    week" — which review?). `expected_behavior`: asks for it; never picks one silently.
  - **limitation** — something the persona really asks that the source or connector cannot do
    (an action the API does not offer, data the plan does not include). `expected_behavior`: says
    plainly it cannot be done and does not pretend; offers what it can.

  These three use `check.rule: judge` and `min_calls: 0` when no query is needed to answer well.
  They must be realistic — taken from the evidence, not made up to trip the AI. When an area has
  no realistic request of a kind, say why under `mix_explained` (`{"area","need","reason"}`);
  `need` is the kind, or `persona:<name>` for a persona with little work in the area. A floor is
  a minimum, never a target: do not pad with near-copies to reach it.
- **Evidence strength.** Observed behaviour ranks first: customer queries, then real users in the
  vendor's community, then the vendor's guidance (help centre, use case and workflow pages
  — `vendor_use_case` —, templates, reports, integration templates), then documentation. **Inferred** comes last. Not every real request is written down
  publicly, so when the research finds a real workflow but no written example of the request, the
  writer may infer the use case. **Only the wording is inferred, never the work:** `source.kind:
  "inferred"`, `source.url` pointing to evidence that people really do this workflow (a help article,
  template, forum thread or integration — opened and checked like any other source), `source.title`
  naming the workflow, and `source.reason` (5 words or more) saying why a real person asks it. A
  workflow with no evidence of real use gets no use case, inferred or not. Inferred use
  cases are shown as inferred in every report, sampled first for the human review, and may be at
  most `catalog.max_inferred_share` (default 30%) of an area, so written evidence stays the backbone.
- **Worth delegating.** The realism judge also asks whether a person would hand the request to an
  AI assistant rather than click it in the app themselves. Prefer requests that need finding,
  combining, deciding or acting over one-click lookups the app already shows.
- **Tagging an existing catalog.** A catalog written before 3.2 has no `difficulty` or `tests`.
  Have a model tag it and run `manage-catalog.mjs tag --from <file>` (`{"tags":[{"id","difficulty","tests"}]}`).
  Tags are outside a use case's hash: a frozen area stays frozen and every stored result stays valid.
- **A check that decides.** `rule` is one of `same_ids` · `same_count` · `contains` ·
  `values_within` · `write_visible` · `judge`. The `reference_sql` is the independent query the
  orchestrator runs at Stage 9 to compute the right answer from whatever the test account holds.
  An action gets `write_visible` with the re-read as its reference and, where it can be undone, a
  `cleanup_sql` the orchestrator runs **after** checking. Use `judge` only when no query can decide
  (several valid answers); a fixed judge model then decides from the answer.
- **`data_sql` — the records the use case is about (3.5).** For a judged question, and for an
  action that changes an existing record (update, delete), give the query that returns those
  records. It is run before the run (`preflight-data.mjs`: an empty result holds the test as "no test
  data" before an agent is paid for), before each attempt (its rows go to the answer judge), and it
  turns "nobody is over-allocated" over an empty account into *blocked by test data*, not a pass.
  Not needed for use cases about the request itself (`ambiguity`, `missing_info`, `limitation`).
  Validation warns when it is missing. Optional `scope_sql`: a wider query (all records under the
  same parent) snapshotted before and after a write, so any other record that changed is reported
  as a side effect.
- **A check that can decide the request (3.6).** A yes/no question ("Is the SSO fix still flagged
  as blocked?") is answered in words: check it with `judge` and a `data_sql`, or `same_count` —
  never a rule that compares record ids (asn-eval1 marked a correct "Yes, still tagged Blocked"
  wrong). A reference must cover what the request asks: a question about "our projects" checked
  against three projects named only in the reference marks a complete answer wrong. Validation
  flags both — a problem on a new draft, a warning on an approved use case. Ingest also sends a
  yes/no question that the ids did not confirm to the answer judge.
- **Evidence strength (3.6).** The source checker also grades each found page: `support` strong or
  weak, and `page_kind` user post · vendor page · third-party site · API docs. Weak support, and a
  daily (P1, three attempts) use case resting on weak, inferred, vendor, third-party or API-doc
  evidence, are warnings — find stronger evidence or keep it knowingly.
- **Wording advice (3.6).** Warnings, never refusals: a request bundling three or more different
  changes ("add, rename and delete…"), and one that reads like a scheduled export or sync.
- **Fixtures, never ids (3.7).** Every record a use case depends on is a named fixture
  (`lib/fixtures.mjs`): `describe` in words, a `find_sql` that finds a suitable existing record by
  what it is (never by id) and returns its id column — named `Id`, `ID`, `gid`, `sys_id` or any
  `*id`, depending on the source; `find_sql` must return it — `example` values (taken from the data survey where
  the account has such a record), `seed` INSERTs for when it does not, and `depends_on` for a record
  that lives under another. Requests, expected behaviour and every check refer to it as
  `{{fixture:<id>.<Field>}}` — "Log 45 minutes on {{fixture:open_task.Name}}",
  `WHERE [TaskId] = '{{fixture:open_task.Id}}'`. Use `{{workspace}}` and `{{me}}` for the account's
  workspace and user. A check that names a record by an account's id is a problem on a new draft and
  a warning on an approved one; an undefined fixture is a problem. The realism judge and the lint see
  requests with the examples filled in. Fixtures are part of the area's freeze.
- **`expect` for every `write_visible`.** The values the change must show. Without them any row
  that already existed would pass, so validation refuses the check. The orchestrator also snapshots
  the reference query *before* the agent starts; only rows that were not there before count.
- **`writes` for every job.** A job reads, decides and often acts; `writes: true | false` decides
  the write policy, the cleanup and whether `preflight-writes.mjs` gates it. Validation refuses a
  job without it.
- **A second wording where it matters (3.7).** A complex or ambiguous request with no variant is a
  warning: whether the outcome holds across phrasings tells skill from luck.
- **Bulk exports (3.7).** A request that reads like a scheduled export ("pull every time entry for the
  billing export") is kept but reported as its own pattern, *Bulk export*, apart from conversation.
- **A second realism judge (3.7).** `judge-prep --second` / `judge-merge --second` with
  `config.models.second_judge` score the same requests independently (`realism_second`). The first
  judge still decides; use cases the two judges split on (two points apart, or one above and one
  below the bar) go first into the human sample.
- **A reply for a clarifying question (3.7).** An ambiguous or incomplete request can carry
  `"follow_up": {"reply": "the Q3 review, on the Website Relaunch board", "expected_behavior": [...],
  "check": {...}}`. If the agent asks, the reply is sent in a second turn and `follow_up.check`
  decides whether it then finished the job. Without a follow-up only the asking is measured.
- **Cleanup ConnectAI MCP can run (3.7).** Its tools take SELECT, INSERT, UPDATE and procedures —
  never DELETE. Undo a change with an UPDATE that restores the old values (`cleanup_sql`), or remove
  a created record with a delete procedure, for example `"cleanup_procedure": {"name": "DeleteTask", "parameters":
  {"@Id": "{{located}}"}}` plus a `locate_sql`. Validation warns when a procedure could remove what a
  use case creates and none is given, flags a DELETE `cleanup_sql`, and asks every writing job for a
  `scope_sql`. The capability list itself treats a driver DELETE as not supported through MCP.
- **Cleanup that pins its rows.** `cleanup_sql` runs unattended after every attempt of every
  model: one UPDATE or DELETE, on a table the use case touches, with a WHERE that pins rows by `=`
  or `IN`. When the agent creates or changes records whose ids are not known in advance, add a
  `locate_sql` that finds them after the run and write `IN ({{located}})` — never a placeholder
  list like `IN (…)`.
- **Placeholders, not dates.** The catalog is frozen and reused for months: write `{{today}}`,
  `{{today-7}}`, `{{today+30}}` for dates and `{{me}}` for the connection's own user in any
  check SQL. They are filled at run time (`fillSql()` in `lib/checks.mjs`).
- **`min_calls`** is the fewest *acting* calls — `queryData`, procedures and writes, not discovery
  — a capable agent needs. It anchors the efficiency score: the shortest path is the lower of
  `min_calls` and the fewest acting calls any correct journey in any stored run used.
- **Variants are judged too.** Each is scored on its own wording; `freeze` refuses while any
  variant is unjudged, reworded since, or below the realism bar.

Then check it (`add` has already given permanent ids; `ids` does it for a hand-written catalog):

```bash
node "<skill>/scripts/manage-catalog.mjs" validate --dir "<dir>"
node "<skill>/scripts/manage-catalog.mjs" ids --dir "<dir>" --prefix ASN
```

## 5.5c′ Sources — every cited page is opened

```bash
node "<skill>/scripts/manage-catalog.mjs" sources-prep --dir "<dir>" --areas a,b
```

Dispatch one `general-purpose` agent (`model: config.models.research`) with
`<Connector>_sources_to_check.json`. It opens each URL and returns `found` · `off_topic` ·
`not_found` per page to `_agent_out/stage5_5-sources.json`. Then merge:

```bash
node "<skill>/scripts/manage-catalog.mjs" sources-merge --dir "<dir>" --checks "<dir>/_agent_out/stage5_5-sources.json"
```

This is the one check that catches invented evidence directly. A use case whose page is missing,
behind a login, or about something else blocks its area's freeze. Replace the source, or retire
the use case. `catalog.verify_sources: false` turns the check off for a trial and is shown on the report.

## 5.5b′ Coverage review — the whole area, fresh context

The checks above look at one use case at a time; none can see what is absent. Once an area's
batches are added, a fresh reviewer reads the **whole set** and lists what is missing, redundant
or low value.

```bash
node "<skill>/scripts/manage-catalog.mjs" review-prep --dir "<dir>" --areas a,b
```

Dispatch `agents/catalog-reviewer.md` (`model: config.models.research_business`, fresh context)
with `<Connector>_catalog_coverage_input.json`: per area, its flows, personas, capabilities, every
use case with its difficulty and tests, the mix against its floors, persona balance and the
questions shared across personas. Persist to `_agent_out/stage5_5-coverage-review.json`, then:

```bash
node "<skill>/scripts/manage-catalog.mjs" review-merge --dir "<dir>" --review "<dir>/_agent_out/stage5_5-coverage-review.json"
```

Answer **every** finding:
- **missing_*** — `scope.mjs research-plan --areas a --fill` plans a batch with the unanswered
  findings as `needs`. The researcher finds evidence; add the new use cases as usual. If no
  evidence exists after a real search, keep the finding with that reason.
- **redundant · low_value · off_persona · off_area** — `manage-catalog.mjs retire --ids … --why "…"`,
  reword it, or keep it with a reason.

Then record the answers in `_agent_out/stage5_5-coverage-answers.json`:
`{"answers": [{"area","finding":"F1","action":"added|retired|reworded|kept","ids":[…],"reason"}]}`.

```bash
node "<skill>/scripts/manage-catalog.mjs" review-answer --dir "<dir>" --answers "<dir>/_agent_out/stage5_5-coverage-answers.json"
```

The answers are checked against the catalog (an added id must exist in the area, a retired one
must be retired, kept needs a reason). The review is tied to which use cases the area holds, not
their wording, so the realism judge's rewording does not void it; adding or retiring use cases
after the answers does, and the area is reviewed again. `catalog.coverage_review: false` turns
the step off for a trial.

## 5.5c Realism judge — fresh context

```bash
node "<skill>/scripts/manage-catalog.mjs" judge-prep --dir "<dir>" --areas a,b
```

Only use cases not yet judged on their current wording are packaged, so an area researched later
does not pay to re-judge the earlier ones.

Dispatch `config.models.realism_judge` in a fresh context with `<Connector>_catalog_judge_input.json`.
It scores every request and variant 1–5 against the rubric (`lib/realism.mjs` `rubric()`) and does
not rewrite. Persist its output to `_agent_out/stage5_5-judge.json`, then:

```bash
node "<skill>/scripts/manage-catalog.mjs" judge-merge --dir "<dir>" --scores "<dir>/_agent_out/stage5_5-judge.json"
```

Rewrite anything below `defaults.realism.min_score` using the judge's issues and suggestion, and
judge again. A reworded use case counts as unjudged.

## 5.5d Human sample — once per catalog version

```bash
node "<skill>/scripts/manage-catalog.mjs" sample --dir "<dir>" --areas a,b
```

writes `<Connector>_catalog_review.csv`: enough use cases for every area in scope to reach
`catalog.human_min_per_area` ratings, spread across personas, with unrated use cases first. **Ask
the user** to have a person fill in `rating` (1–5: would a real user ask this?) and `comment`. Do
not fill it in yourself — the point is a human opinion. Then:

```bash
node "<skill>/scripts/manage-catalog.mjs" human-merge --dir "<dir>" --ratings "<filled csv>" --reviewer "<name>"
```

Agreement below `catalog.min_agreement` means the judge and the person see realism differently —
tune the writing or the rubric before freezing.

## 5.5e Freeze

```bash
node "<skill>/scripts/manage-catalog.mjs" freeze --dir "<dir>" --areas a,b
```

Freezes each area on its own. It refuses an area while anything in it is invalid, unjudged, below
the bar, unsourced or unchecked, incomplete (capabilities or personas not covered), below a mix
floor or with a thin persona (unless explained), without an answered coverage review, or without
a standing human review when `config.catalog.human_review` is true. Nothing is frozen if any named area
fails, and every blocker is listed. **Human review is off by default (3.9):** with
`config.catalog.human_review` false, `freeze` needs no ratings, the orchestrator freezes with
`--skip-human` and never asks for the sheet, the freeze is recorded as `human_skipped`
(`human_skipped_by: config`), and the capability and analysis reports say "Not reviewed — human review
is off" where the human-agreement figure would be. Set it to true to require the human sample again.
`manage-catalog.mjs reset-area --areas a` retires an area's use cases so it can be researched again.
`--skip-human` skips it for one freeze whatever the config says, and is recorded the same way.
Each freeze is a new version; the hash covers ids, wording, kinds and checks, so a stored result
says exactly which catalog it answered.
