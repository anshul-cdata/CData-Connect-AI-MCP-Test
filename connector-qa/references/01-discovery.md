# Stages 1–2 · Connector Discovery and Source Understanding

**Contents**

- Stage 1 — Connector Discovery
  - 1.0a Record which connection, tenant and user this run is pointed at
  - 1.1 Three populations, never one blended count
  - 1.2 Column discovery is staged, not exhaustive
  - 1.3 Stored procedure registry
  - 1.4 Categorize every object
- Stage 2 — Source Understanding
  - Parallel subagents — Stage 2 research
  - Exposure — the one comparison that must not be skipped
  - 2.1 Business domains and workflows → `$WORKFLOW_DOMAINS`
  - 2.2 Personas → `$PERSONAS`
  - 2.3 Roles and permissions → `$ROLES` + `$ACCESS_MATRIX`
  - 2.4 Assemble `$CONNECTOR_META`

Prerequisite: read `00-contracts.md` first — §7, §9 and §10 are used throughout this file.

---

## Stage 1 — Connector Discovery

Metadata calls, not tests. First write `run_meta` into `$KNOWLEDGE_FILE` (`00-contracts.md`
§11) with `run_state: "in_progress"` and record `metadata_snapshot_at` when `getTables()`
returns — that timestamp is the schema this run tested. Record the connector's build or version
from `getStarted()` as `run_meta.connector_build`: it is part of the results fingerprint, so an
eval never compares runs made against different builds. In capability mode also set
`run_meta.mode: "capability"` and `run_meta.capability_spec` (where Stage 1.5a got the source's API description — `{url, fetched_at, source}`).
Then call in order and store each result.

```
getCatalogs()                    → $CATALOGS
getInstructions()                → $INSTRUCTIONS      (quirks, required filters, limits)
getSchemas()                     → $SCHEMAS
getTables()                      → $TABLES            (name, type: TABLE | VIEW)
getProcedures()                  → $PROCEDURES
getProcedureParameters(<each>)   → $PROC_PARAMS       (name, type, required/optional)
```

### 1.0a Record which connection, tenant and user this run is pointed at

Before anything else, write these into `$KNOWLEDGE_FILE` `run_meta`:

| Field | From | Read by |
|---|---|---|
| `catalog` | the Connect AI catalog (connection) name, from `getCatalogs()` | `account-probe.mjs`, `test-data.mjs` |
| `schema` | the schema name, from `getSchemas()` | `account-probe.mjs`, `test-data.mjs` |
| `workspace` | `{id, name, source}` — the account or workspace the connection is bound to | reports; the write gate |
| `workspace_catalog` | `[{id, name, is_organization}]` — every workspace or tenant the connection can reach | the strict write gate (safe mode) |
| `me` | the connection's own user id | `preflight-data.mjs --me`, `test-data.mjs --me` |

`workspace` and `workspace_catalog` come from one read-only query of the source's own
workspace/tenant object, when it has one (for example `Workspaces`, `Organizations`, `Companies`,
`Accounts`); otherwise take whatever identity `getStarted()` reports for `workspace`. `me` comes
from the source's own-user object (for example a `Users/Me`-style table).

This costs a couple of queries and answers a question nothing else can answer afterwards. The catalog name
(for example `Asana1`) says nothing about which org is behind it: a connection pointed at a production tenant
looks identical at runtime to one pointed at a sandbox. That is tolerable for a read-only run and
not tolerable once `write_policy.execute_irreversible` is true, because the run then creates
records it cannot remove and the only evidence of where they landed is this field.

Both reports print it in the footer beside the run id. When the observed workspace does not match
`write_policy.workspace` (when one is set; `write_workspace` is retired), **stop and say so** rather than writing — a mismatch means either
the config or the connection is wrong, and guessing which costs someone a cleanup in a live org.

### 1.1 Three populations, never one blended count

`$TABLES` entries carry `type`. Object coverage tracks **tables**, **views** and **stored
procedures** as three separate populations. A connector that exposes 40 tables and 6 views does
not have "46 objects" — it has two populations with different coverage objectives.

### 1.2 Column discovery is staged, not exhaustive

Calling `getColumns()` on every object wastes an enormous amount of context on a 500-object
connector. Call it on:

- every object that Stage 5 tiering places in **T1 or T2**,
- any object whose purpose is not evident from its name, and
- any object referenced by customer evidence (Stage 4).

T3/T4 objects get columns lazily, only if a test targets them.

Record `columns_loaded` per object. **An object without columns can only ever reach partial
column coverage, and that is itself a `SCHEMA` gap.**

> Ordering note: tiering happens in Stage 5, after this stage. Load columns for the obvious
> `core`-category objects now, then top up during Stage 5 once tiers are scored. Do not block
> Stage 2 on column loading.

### 1.3 Stored procedure registry

```javascript
$SP_REGISTRY = $PROCEDURES.map(p => ({
  name:            p.name,
  description:     p.description || "(undocumented)",
  params:          $PROC_PARAMS[p.name],    // [{name, type, required}]
  required_params: /* subset where required === true */,
  covered:         false,                    // set true when a TC cites it
  param_combos_tested: []                    // filled in Stage 10
}));
```

### 1.4 Categorize every object

Assign each entry in `$TABLES` a category from `00-contracts.md` §9. Store as
`$TABLE_CATEGORIES` (map of `objectName → category`).

---

## Stage 2 — Source Understanding

Understand the **source system**, not just the connector surface. Authority order:

```
$INSTRUCTIONS → CData connector docs → vendor/source product docs
  → source API docs → business/domain docs → customer evidence (Stage 4)
```

The three subsections below are independent. When `config.delegation.parallel_research_agents`
is true, dispatch §2.1, §2.2 and §2.3 as three `general-purpose` subagents **in a single
message**, each given the relevant `agents/*.md` brief. **Validate every return before using it:**

```bash
echo '<agent json>' | node "<skill>/scripts/validate-agent-output.mjs" --agent domain|persona|role [--domains "AP,GL"]
```

A rejected return is re-requested once with the listed problems quoted back; a second rejection
is recorded as a `SCHEMA` gap ("research for X could not be validated") rather than accepted.
Unvalidated agent output was how a hallucinated domain could enter the coverage denominator
silently.

### Parallel subagents — Stage 2 research

When `config.delegation.parallel_research_agents` is true, dispatch all four **in a single
message** so they run concurrently. Each burns heavy search context and returns a small
structured result.

| Agent definition | Returns | Writes |
|---|---|---|
| `agents/domain-researcher.md` | `$WORKFLOW_DOMAINS` | `_agent_out/stage2-domain.json` |
| `agents/persona-researcher.md` | `$PERSONAS` | `_agent_out/stage2-persona.json` |
| `agents/role-researcher.md` | `$ROLES` + `$ACCESS_MATRIX` | `_agent_out/stage2-role.json` |
| `agents/integration-pattern-researcher.md` | `$INTEGRATION_PATTERNS` | `_agent_out/stage2-integration.json` |

The **integration-pattern-researcher** answers a different question from the other three: not what
the business needs, but what BI/ETL tools (Power BI, Tableau, Excel) automatically generate
against this connector. Its output feeds the query-pattern applicability pass in Stage 5 — a
pattern the integration agent marks "high frequency" gets applicability `true` even if no customer
evidence exists yet. See `agents/integration-pattern-researcher.md`.

Give each the connector name, this skill's absolute path, and — for the role researcher — the
domain ids. **Run the domain researcher first and pass its ids to the role researcher**: a role
matrix built on provisional keys and reconciled afterwards is how asn005 ended up with seven
domains no role could touch, and `validate-agent-output.mjs --agent role --domains <ids>` now
rejects a matrix with a missing or all-`N` domain.

Models per agent: **`config.models.research_business`** for the domain and persona researchers —
their output now writes the business prompts (persona everyday questions become the first tests),
so telling real work from vendor marketing earns the stronger model — and **`config.models.research`**
for the role and integration-pattern researchers, which extract from documentation. Omit `model`
when the value is `session`, and record both in `run_meta.models`. Validate the domain, persona
and role results with `validate-agent-output.mjs` and re-ask on failure (it has no validator for the
integration researcher, whose result is not validated by script): since 2.2 it rejects domains without
`prevalence`, personas without `archetype` and `daily_questions`, and a persona set with no
`doer`, `coordinator` or `analyst`.

### Exposure — the one comparison that must not be skipped

`domain-researcher` returns each vendor domain with `table_refs`. **A domain with an empty
`table_refs` is a legitimate and important answer**: the business area is real and the connector
exposes nothing for it. Do not drop such domains and do not invent objects for them.
`compute-gaps.mjs` turns each one into an `EXPOSURE` gap and counts them in the funnel as
`domains_without_connector_object`. That count is the difference between "we tested what the
connector exposes" and "we know what the connector fails to expose."

---

### 2.1 Business domains and workflows → `$WORKFLOW_DOMAINS`

**Search both:**
- `"$CONNECTOR business workflows use cases modules API"`
- `"$CONNECTOR standard reports"`

> Vendor **standard reports** are the single richest source of *real* business use cases — they
> are what the vendor itself ships because customers need them. Weight them accordingly.

```javascript
{
  id: "AP", name: "Accounts Payable",
  table_refs: ["VendorBill", "VendorPayment", "Vendor"],
  workflows: [
    { id: "AP01", name: "Approve and pay vendor bills", permission: "write",
      edge_cases: ["Bills awaiting approval >5 days", "Duplicate bill detection"] }
  ]
}
```

**Sizing:** discover as many domains as the connector genuinely has. No cap, no padding.
Enterprise connectors (NetSuite, SAP) may have 20+; simple ones 4–6. Merge only genuinely
overlapping domains. Never invent or drop a domain to hit a count.

---

### 2.2 Personas → `$PERSONAS`

**Search:** `"$CONNECTOR typical users business personas roles daily tasks"`

```javascript
{
  id: "PERSONA_AP", name: "AP Clerk",
  description: "Processes vendor bills, manages approvals and payments",
  primary_categories: ["core", "analytics"],   // from $TABLE_CATEGORIES
  primary_domains:    ["AP", "GL"],
  jobs_to_be_done: [
    "Clear the approval queue before the payment run",
    "Catch duplicate bills before they are paid"
  ]
}
```

Discard any persona whose daily questions never touch this connector's objects.

**Reference by connector type** — keep only what is natural here:

| Connector type | Common personas |
|---|---|
| ERP / Finance | Finance Analyst, Controller, AP Clerk, AR Clerk, Budget Manager, Auditor |
| CRM / Sales | Sales Rep, Sales Manager, Sales Ops Analyst, RevOps |
| HR / HCM | HR Business Partner, Payroll Admin, Recruiter, Benefits Admin |
| IT / Admin | IT Admin, Security Analyst, System Integrator, Data Engineer |
| Operations | Operations Manager, Supply Chain Analyst, Warehouse Manager |
| Marketing | Campaign Manager, Marketing Analyst, Demand Gen |
| Support / ITSM | Support Agent, Support Manager, QA Analyst |
| Project Management | Project Manager, Resource Manager, Portfolio Manager |

---

### 2.3 Roles and permissions → `$ROLES` + `$ACCESS_MATRIX`

**Search:** `"$CONNECTOR user roles permissions access levels"`

Research the **vendor's own** role model — what NetSuite, Salesforce or Office365 themselves
define. This is *not* about what the CData connector chose to expose. **The gap between vendor
roles and connector implementation is itself a reportable finding.**

```javascript
$ROLES = [{
  name: "Controller", group: "Finance",
  source: "doc",                      // "doc" = found in vendor docs · "inferred" = deduced
  access: { "AP": "F", "GL": "F", "HR": "N" }    // levels per 00-contracts.md §10
}];

$ACCESS_MATRIX[role_name][domain_id] = "F" | "E" | "C" | "V" | "N";
```

Flag `source: "inferred"` honestly for any access level deduced rather than read.

If the connector has no meaningful role hierarchy (single API key), set one role
`{name:"API User", group:"Default", source:"inferred", access:{"*":"F"}}` and
`$ROLE_COMPLEXITY = "low"`.

**Role complexity:**

| Value | Condition |
|---|---|
| `low` | ≤3 roles, or all roles have identical access across all domains |
| `medium` | 4–8 roles with some variation; no workload-admin scoping |
| `high` | ≥9 roles, **or** a workload-admin pattern (roles scoped to specific domains only) |

**Recommendation** (surfaced in the report's exec bar) — one line telling a reader how much
weight the role dimension deserves for this connector:

| Complexity | Recommendation |
|---|---|
| `low` | Role dimension adds little — read the Business Process lens |
| `medium` | Some role variation — worth checking the Role × Process matrix |
| `high` | Complex role hierarchy — permission boundaries carry real risk here |

---

### 2.4 Assemble `$CONNECTOR_META`

```javascript
{
  app:              "$CONNECTOR",
  subtitle:         "<one line on what the connector exposes>",
  roles:            $ROLES,
  workflow_domains: $WORKFLOW_DOMAINS,
  personas:         $PERSONAS,
  role_complexity:  $ROLE_COMPLEXITY,
  recommendation:   $RECOMMENDATION,
  sources:          ["<URL1>", "<URL2>"]
}
```

Write `$KNOWLEDGE_FILE` with everything gathered so far. Shape: `artifacts.md` §1.
