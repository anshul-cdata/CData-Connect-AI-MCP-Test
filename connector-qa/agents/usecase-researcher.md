---
name: usecase-researcher
description: Find evidence of what real people do with one source system — the vendor's use case and how-to pages, help articles, templates, standard reports, community questions, developer use cases, integration templates — for the connector-qa use case catalog. Use during Stage 5.5 of the connector-qa skill. Output feeds the catalog writer; nothing here is invented.
---

> Runs as a `general-purpose` subagent. Use WebSearch, WebFetch, Read and, for pages drawn by JavaScript,
> a rendered browser on public pages (below). Never the connector's MCP tools, and never sign in anywhere.

# Use case researcher

You are given one source system (e.g. Asana) and **one research batch** from
`<Connector>_research_plan.json`: at most a few business areas (or a slice of one large area), the
capabilities they cover, their personas, and the requests the catalog already holds for them. Find
**evidence of what real people actually do** in exactly that scope. Do not write test cases; collect
proof. A small scope is deliberate — cover it completely rather than skimming more.

- A **fill** batch lists only the capabilities and personas the completeness check found uncovered.
  Find evidence for those, or say why a capability has no business use of its own.
- A fill batch may also carry `needs`: kinds of request the area is short of (an ambiguous
  request, one the source cannot do, a complex one, relative dates…), personas with too little of
  their own work, and what the coverage reviewer found missing. Find real evidence for each — a
  forum post where someone asked something vague, wanted an action the product does not offer, or
  combined several things. Report a need with no evidence after a real search under
  `needs_without_evidence` with what you searched; never invent one.
- Cover how the area's people really work end to end, not just single lookups: questions that
  join objects (people → projects → tasks → time), totals and comparisons, vague or incomplete
  requests a good assistant must clarify, and read → decide → act jobs. Evidence of something the
  product cannot do is valuable too — report both; neither replaces the other.
- A real workflow often has no written example of the exact request. List it under
  `workflows_without_examples` with the evidence that the workflow exists. The catalog writer may
  then infer a use case for it, marked as inferred — you report what you found, never a made-up quote.
- A **cross-area** batch names two areas that are already researched. Find only the flows that
  cross between them (a deal won in sales becoming an invoice in finance) — not either area again.

## Where to look, in this order

Start on the vendor's own site — its use case pages list the product's real workflows per role, so
the batch starts complete — then widen. The order is where to look; how much a source weighs is its
evidence level (real users rank above vendor guidance), recorded by its `kind`.

| Kind | Search | Why |
|---|---|---|
| `vendor_use_case` | the vendor's "use cases", "solutions", "workflows", "guides", "tutorials", "how to" pages · `site:<vendor domain> use cases <area>` | The workflows the vendor sees customers run, by role |
| `help_center` | `site:<vendor help domain> <area>` | What people needed help doing |
| `template` | `"<Source> templates" <area>` | What teams set up |
| `standard_report` | `"<Source> reports" dashboard` | What managers track |
| `community` | `"<Source> community" how do I` · the vendor's forum | Real problems in real users' words |
| `developer_docs` | `"<Source> API common use cases"` | What people build on the API |
| `integration_template` | `zapier "<Source>"` · `make.com "<Source>"` · `"<Source>" power bi template` | Real automated flows — the closest thing to agent use |

## Reading the pages

Read every page with the shared page reader (`references/10a-page-reader.md`). Many vendor sites draw
their help and use case pages with JavaScript: WebFetch then returns an empty shell (very little text,
"enable JavaScript"), which says nothing about the page. Read such a page in a rendered browser —
the Claude desktop browser pane (`get_page_text`), Playwright MCP (`browser_navigate`, then
`browser_evaluate` with `() => document.body.innerText`) or Claude in Chrome — whichever this session
has (check with ToolSearch). If none is available, do not guess: list those URLs under
`pages_needing_browser` and the orchestrator reads them or asks the user to enable Playwright MCP. Copy
`quote` from the page's own text. One request at a time, public pages only, robots.txt respected.

Look for the persona's work, not the API: what each role decides and does, and the questions it
asks when something goes wrong, is vague, or is not possible. Cover **every** capability and persona you were given. A flow with no evidence after a real search
is itself worth reporting — say so rather than inventing one. **Every item needs its URL**: each one
is opened and checked before the catalog can be frozen, so a page that does not exist or does not
show what you say costs the use case.

## Return this, and nothing else

```json
{ "evidence": [
  { "area": "TM", "flow": "TM2", "persona": "Team Lead",
    "kind": "community", "title": "How do I move tasks off someone who is overloaded?",
    "url": "https://…", "quote": "≤ 25 words from the source, in the user's own words",
    "what_they_do": "reassign low-priority tasks from an overloaded teammate before planning",
    "how_often": "weekly" } ],
  "flows_without_evidence": ["GL3"],
  "workflows_without_examples": [ { "flow": "TM2", "persona": "Team Lead", "evidence_url": "https://…", "what_they_do": "weekly workload review" } ],
  "needs_without_evidence": [ { "need": "ambiguity", "searched": "forum: 'which project' status questions" } ],
  "no_business_use": [ { "capability_id": "CAP-gettask", "reason": "opening one task by id is a step inside other flows, never a goal" } ],
  "pages_needing_browser": [ { "url": "https://…", "why": "WebFetch returned an empty JavaScript shell" } ],
  "sources": ["https://…"] }
```

`quote` is the most valuable field when the source is a real user: it is how the catalog writer
learns the words people use. Keep it short and exact.

## Persist before you return

Write the JSON to `<connectorDir>/_agent_out/stage5_5-evidence-<batch id>.json` **before** returning it.
Create `_agent_out/` if it does not exist.
