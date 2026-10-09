# connector-qa — getting started

Test one CData connector the way a customer's AI assistant uses it: through **CData ConnectAI
MCP**. The skill researches real business use cases for the source, has an AI agent carry each one
out, checks every answer, and writes a capability report. This guide runs **one business area**.

---

## 1. Before you start

| You need | Notes |
|---|---|
| Claude Code 2.1+ | Desktop app (Code tab) or CLI. |
| Node.js 20+ | Required for the scripts. No `npm install` needed. |
| A CData Connect AI account with MCP access | If calls fail with `403 FEATURE_NOT_ENABLED — only spreadsheet-type clients`, MCP access is not enabled on the account. Ask your Connect AI admin. |
| The Connect AI MCP server added to Claude Code | Its tools appear as `mcp__<server id>__queryData`, `getTables`, … |
| A connection to the source in Connect AI | Pointed at a **test** account or workspace. Writes go there. |
| A published API description for the source | Most SaaS vendors publish an OpenAPI file. The skill finds and reads it. |

**Allow the connector's tools.** In auto permission mode, Claude Code may refuse connector calls
at random unless they are allowed up front, which makes tests fail for reasons that are not the
connector's or the model's. Add one rule to `.claude/settings.local.json` in the folder you run
Claude Code from (replace `<server id>`):

```json
{ "permissions": { "allow": ["mcp__<server id>"] } }
```

The skill checks this for you before it runs anything (`check-harness.mjs`).

## 2. Install

1. Unzip `connector-qa-<version>.zip` into the folder that should hold your reports, for example
   `ConnectAIMCPTest\`. You get `ConnectAIMCPTest\connector-qa\`.
2. From inside `connector-qa`, run:
   ```powershell
   .\install.ps1
   ```
   (macOS / Linux: `bash install.sh`. If PowerShell blocks scripts:
   `powershell -ExecutionPolicy Bypass -File .\install.ps1`.)
3. It ends with **Ready.** Start a **new** Claude Code session. Re-run `install.ps1` after you
   receive a newer zip. Every run first checks that the installed copy matches the folder it was
   installed from, and stops with the command to run if it does not.

Reports are written next to the skill: `ConnectAIMCPTest\<Source>\`.

## 3. Pick a business area

In the new session, type:

```
/connector-qa <Source>
```

for example `/connector-qa Asana`. The first run discovers the connector and builds the capability
list (what the source's API can do, matched to what ConnectAI MCP offers), then shows the business
areas with their personas and capabilities, and asks what to do. Note the area id, for example `TR`.

## 4. Run one business area

```
/connector-qa <Source> --areas <AREA_ID> --execute
```

For a clear run, add your decisions in the same message. A template:

```
/connector-qa <Source> --areas <AREA_ID> --execute

Run only the <area name> business area, all personas, with Sonnet as the agent under test. No eval.
I want the complete capability report at the end.

My decisions:
- Fresh start for this area.
- Skip the human review sample (record the skip in the report).   ← or: I will rate a sample
- Writes only in <test workspace name>, each cleaned up after checking. Show me any seed records
  before writing them.
- Inferred use cases only for workflows with checked evidence of real use (max 30%).
- Keep use cases that need unsupported capabilities; report them as not supported.

Post a short status update at every stage with tokens used, and stop and ask me before anything
outside these decisions.
```

## 5. What happens, and what you will be asked

| Stage | What it does | Your part |
|---|---|---|
| Discovery and capability list | Tables, columns, procedures, usage instructions; the source's API mapped to ConnectAI MCP | — |
| Test account check | One read per table: which business areas the test account can really test (data, empty, refused) | Choose areas knowing this; seed data or use a better account for ⚠ areas |
| Research and use cases | Evidence of real work, use cases per persona, link checks, a whole-area review, a realism judge, then the area is frozen | Rate a sample if you chose human review |
| Test data | Uses the records the account already has for each use case; lists what is missing and how it would create it | Approve the records it proposes to create; decide if it says `AREA NOT READY` |
| Run | A fresh agent per use case, only the request and the MCP tools; daily use cases 3 times. Requests ConnectAI MCP cannot fulfil are still asked once, to see whether the agent says so or invents an answer | Approve writes that cannot be undone, if any |
| Check and report | Answers checked, failures given an owner, reports built | Read the report |

**Every run starts with one question:** "This run can create and change records in <workspace>. Is
this a test account?" Answer it and leave the run going. Writes are on by default, because
connectors are tested on test accounts; answer "read only", or set `write_policy.safe_mode: true`
in `config.json`, to hold back records that cannot be deleted. The report lists every record a run
left in the account.

## 6. What you get

In `ConnectAIMCPTest\<Source>\`:

- `<Source>_capability_report.html` — **start here.** Capabilities (supported, partly, not supported,
  not applicable), and every use case with one verdict: correct, partly correct, incorrect, not
  supported, not applicable, blocked by the account, or blocked by test data. Only the first three
  measure the AI; the rest are findings about the connector, the source or the test account.
- `<Source>_catalog.json` — the frozen use cases, reused by every later run and model.
- No status file is written by any script: the orchestrator posts status updates in the
  conversation (and may keep that log in a file if you ask it to).
- Results under `ConnectAIMCPTest\_results\<Source>\<run id>\`.

To compare AI models on the same use cases later: `/connector-qa <Source> --areas <AREA_ID> --eval`.

## 7. Time and tokens

One business area of about 40 use cases takes a few hours and roughly 3–5M tokens: research about
0.5M, the agent runs most of it, checks and judging about 0.5M. Start a long run in a fresh session,
so the conversation itself stays small.

## 8. If something goes wrong

| You see | Meaning |
|---|---|
| `403 FEATURE_NOT_ENABLED` | Connect AI account has no MCP access. Ask your admin. |
| `catalog '…' does not exist or is inaccessible` | The connection was removed or renamed in Connect AI. Re-add it. |
| "Permission … denied by the auto mode classifier" | A connector tool is not allowed. Add the rule in section 1. |
| Many "no test data" results | The test account holds nothing for those use cases. Seed data, or accept it. |
| `AREA NOT READY` before the run | Fewer than half the area's use cases can test the AI on this account (no data, or features missing from its plan). Seed data, use an account with those features, or run anyway knowing the report will mostly describe the account. |
| "Blocked by the account" | The source refused for the test account's plan or rights, and the agent said so. Not the connector's or the AI's fault. |
| Writes refused with "not available on your current plan" | The source's plan lacks the feature. Charged to the test account, not to CData. |

More detail: `README.md` and `SKILL.md`.
