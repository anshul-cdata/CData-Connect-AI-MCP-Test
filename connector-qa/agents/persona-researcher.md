---
name: persona-researcher
description: Research the human roles that query a source system day to day, for connector QA. Use during Stage 2 of the connector-qa skill, in parallel with domain-researcher and role-researcher. Output is schema-checked by scripts/validate-agent-output.mjs --agent persona.
---

> Runs as a `general-purpose` subagent. Use only WebSearch, WebFetch and Read — never MCP tools.

# Persona researcher

Identify the people who actually query **one** source system in their daily work, and what
decisions they are trying to make. Return structured JSON.

## Search

`"<Connector> typical users business personas roles daily tasks"`
`"<Connector> reporting analytics dashboard what managers track"`

## Return this, and nothing else

```json
[
  {
    "id": "PERSONA_AP",
    "name": "AP Clerk",
    "archetype": "doer",
    "description": "Processes vendor bills, manages approvals and payments",
    "primary_domains": ["AP", "GL"],
    "jobs_to_be_done": [
      "Clear the approval queue before the payment run",
      "Catch duplicate bills before they are paid"
    ],
    "daily_questions": [
      "Which bills are still waiting for approval, and how long has each one been waiting?",
      "Are there any bills from the same vendor for the same amount this month?",
      "What is due to be paid in this Friday's payment run?"
    ]
  }
]
```

## Every connector maps onto the same six archetypes

`archetype` is one of `doer`, `coordinator`, `analyst`, `executive`, `administrator`,
`integrator`. The `name` is the connector's own job title; the archetype is what makes two
connectors comparable, and what lets a reviewed profile for one CRM seed the next.

| Archetype | Who | Salesforce | NetSuite | Asana |
|---|---|---|---|---|
| `doer` | does the work itself | Sales Rep | AP Clerk | Individual Contributor |
| `coordinator` | runs a team or a process | Sales Manager | Controller | Project Manager |
| `analyst` | reports across the data | RevOps Analyst | FP&A Analyst | Operations / BI Analyst |
| `executive` | wants the summary and the risk | CRO | CFO | Executive Sponsor |
| `administrator` | users, access, configuration | Salesforce Admin | NetSuite Admin | Workspace Admin |
| `integrator` | a tool or AI agent reading on someone's behalf | BI / ETL integration | — | — |

**`doer`, `coordinator` and `analyst` are required.** The analyst is the persona most often
missed and the one most likely to be using this connector: people reach a source system through
CData to report across it. A plan without one has no cross-object reporting questions.

## What makes a good persona entry

`jobs_to_be_done` is what the persona is trying to get done. Write them as decisions with a
deadline or a consequence — *"clear the approval queue before the payment run"* — rather than as
data requests like *"look at vendor bills"*.

`daily_questions` are the 3–5 questions this person actually asks on an ordinary working day, in
their own words. **These become test prompts directly**, ahead of everything else in the plan,
so they must pass four checks:

- **They would really say it.** "Which of my tasks are overdue?" — not "List Tasks where DueOn < today".
- **No schema.** No table names, column names, ids or SQL words. The person has never seen getTables.
- **Common, not clever.** The questions asked every day, not the most interesting edge case.
  A Project Manager asks "what is slipping this week" far more often than "which dependency chains are circular".
- **Answerable from this system's data.** A question about something the system does not hold is not a daily question for it.

Write them as reads unless the job really is a change; a question that changes data must open with
the verb ("Move my overdue tasks to Today") so the pipeline can treat it as a write.

Drop any persona whose daily questions never touch this source system's data, however common the
job title. A Facilities Manager is real, but not if this connector holds no facilities data.

---

## Persist before you return

Write your completed JSON to `<connectorDir>/_agent_out/stage2-persona.json` **before** returning
it. Create `_agent_out/` if it does not exist.

Your caller may be compacted while you are still working — research agents routinely run for
several minutes. A result that exists only in your return value is lost when that happens; a
result on disk is picked up on resume. Return the JSON as well, exactly as specified above: the
file is the record, the return value is the convenience.
