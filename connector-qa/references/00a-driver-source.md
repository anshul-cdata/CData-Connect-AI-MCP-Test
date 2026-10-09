# Stage 0.5 · Driver Source

**Contents**

- Why it exists
- Driver classes
- What it deliberately does not read
- What reads the artifact
- AI fallback for `parse_warnings`
- Using the artifact in this run
- Configuration

Read what the driver **ships**, before connecting to anything.

```bash
node "<skill>/scripts/read-driver-schema.mjs" --connector "$CONNECTOR" --out "$ROOT/$CONNECTOR/${CONNECTOR}_driver_schema.json"
```

**Entirely optional.** With no driver source configured the stage is skipped and every later stage
behaves exactly as it did before. Nothing downstream requires the artifact; what reads it, reads it
only if it is there.

---

## Why it exists

`getTables()` shows what a driver chose to expose at run time. On a large connector that is
thousands of rows, and nothing in the MCP surface says which of them the product actually
committed to supporting. The driver's own authors already made that distinction — documented
tables sit at the root of the schema folder, generated ones in a subfolder beneath it — so it is
**read rather than inferred**. Name shape cannot substitute: on NetSuite it separates barely a
fifth of the generated catalog.

| | `getTables()` | documented |
|---|---|---|
| NetSuite | ~2,650 | **127** |
| Salesforce | ~1,073 | 1,069 |
| Jira | 82 | 82 |
| Asana | 33 | 33 |

The reduction is real where it matters and absent where it does not, which is the honest result.
Across the enlistment, 322 of 586 providers document objects at all; **264 document nothing**, and
for those the source is the only statement of what will exist.

---

## Driver classes

Derived from evidence in the tree, never from a list of connector names.

| Class | Detected by | Selection strategy |
|---|---|---|
| `static` | documented tables, no custom-object mechanism in source | every documented object is the floor; there is nothing else |
| `remote_catalog` | documented tables **and** a custom-object mechanism | documented objects are the floor; tenant objects arrive at run time and are chosen by business importance |
| `inferred` | no documented tables, schema-sampling code present | nothing is shipped — objects exist only at run time, selection is entirely by importance |
| `user_defined` | no documented tables, no sampling code | the surface is whatever configuration supplies |

`evidence.custom_object_support` and `evidence.schema_inference` name the file each conclusion came
from, so a wrong classification is traceable rather than mysterious.

---

## What it deliberately does not read

Each of these was considered and rejected for a reason worth keeping:

**Per-column flags** — `IsRequired`, `filterable`, `urlparam`. Whether an agent can work out that a
query needs a filter **is the measurement**. Handing the pipeline the answer deletes the finding,
for the same reason `expected_sql` is left unqualified (`07-execution.md`). A run that spends
fifty calls discovering a required filter has produced the result, not wasted the calls.

**`mcp-instructions.md`** — what the MCP surface serves is what matters. Reading the file from disk
describes a file, not the connector's behaviour.

**`changelog.md`** — genuinely useful to a human triaging a failure, and it can decide nothing
automatically: no system table exposes the deployed build, so the changelog can only raise a
question, never answer one.

---

## What reads the artifact

**Stage 5 · tiering.** A documented object cannot fall below `config.defaults.documented_tier_floor`
(`T2`). This is a floor, not a weight, because a weight can be outvoted — a documented object with
no workflow, little role reach and no persona would score T4 and get shallow coverage. The business
model still ranks *within* the documented set; it cannot rank any of it out.

**Stage 2 reads nothing of it, on purpose.** Research must stay independent of what CData
implemented. Feed it the object list and it can only ever find what already exists, and the
`EXPOSURE` gap — a real business domain the connector exposes nothing for — becomes undetectable.
The two meet at generation, never before.

---

## AI fallback for `parse_warnings`

If `parse_warnings` is non-empty, apply this fallback before Stage 2. Each entry in
`parse_warnings[]` contains a `file`, `object` name, and an `excerpt` of the first 1,500 bytes
of a .rsd file whose dialect the script could not parse (zero XML elements found after
normalization). For each:

1. Read the excerpt and identify the dialect — what element names and attribute names does it use?
2. Extract: FK targets (any attribute whose value looks like another table name, especially on
   columns that end in `Id` or `Key`), operation flags (any flag indicating read-only, insert,
   update, delete), and column type signals (datetime, identifier, measure columns).
3. Merge your findings into `$DRIVER_SCHEMA.relationships[]` and `$DRIVER_SCHEMA.column_signals{}`,
   marking `confidence: "ai_fallback"` on any relationship you add.
4. If a full read of the file is needed (excerpt was not enough), read it directly — the path is
   under the driver source root.
5. Log one line per warning resolved: `  ✓ parse_warning resolved: <Object> — found N FK(s), dialect: <description>`

This is the designed extension point. When a new connector ships a dialect the script has not
seen, the AI fallback catches it here, and the resolved pattern feeds back into the script as a
new `normalizeTags` branch or `getAttr` variant in the next skill version.

---

## Using the artifact in this run

It answers *which objects must this run test* — `getTables()` returns ~2,650 rows on NetSuite and
127 of them are what CData documented. It also extracts the FK graph and column operation flags
from .rsd file contents, producing `relationships[]`, `column_signals{}` and `implied_objects[]`.
Optional throughout: with no enlistment the stage is skipped and every later stage behaves exactly
as before. See `references/00a-driver-source.md`.

**If `parse_warnings` is non-empty, apply the AI fallback in `references/00a-driver-source.md` before Stage 2.**

**Pass the driver schema to Stage 2 research agents.** When `{C}_driver_schema.json` is present,
include these fields in every agent dispatch context:
- `driver_schema.relationships[]` — FK graph read from .rsd files; use to focus join-pattern and
  workflow-step research on the object pairs that are actually linked.
- `driver_schema.implied_objects[]` — objects referenced by FK but absent from the schema; tell
  domain-researcher and integration-pattern-researcher to look for these specifically.
- `driver_schema.column_signals{}` — per-object operation flags (insert/update/delete); tell
  domain-researcher whether write workflows are plausible before it researches them.

## Configuration

| Key | Meaning |
|---|---|
| `config.driver_source.root` | absolute path to the enlistment (the folder holding `Provider*`). Machine-specific, empty in the shared copy |
| `CONNECTOR_QA_DRIVER_ROOT` | environment override |
| `--root` | per-invocation override, wins over both |
| `config.defaults.documented_tier_floor` | the floor tier, default `T2` |

Resolution order is `--root` → environment → config, the same shape as `$ROOT`, and for the same
reason: an absolute path on Windows contains a username, so the shared copy carries none.

> On a connector with several hundred documented objects the floor has a cost: Stage 3 loads
> columns for T1+T2 only, so flooring 1,069 Salesforce objects at T2 means 1,069 `getColumns`
> calls. Four connectors in the enlistment are that large. Lower the floor to `T3` if that
> trade is wrong for a given run.
