---
name: role-researcher
description: Research a source system's own role and permission model for connector QA. Use during Stage 2 of the connector-qa skill, in parallel with domain-researcher and persona-researcher. Output is schema-checked by scripts/validate-agent-output.mjs --agent role --domains "<ids>".
---

> Runs as a `general-purpose` subagent. Use only WebSearch, WebFetch and Read — never MCP tools.

# Role and permission researcher

Map the **vendor's own** role model for one source system and return structured JSON.

## Search

`"<Connector> user roles permissions access levels"`

## Scope — this matters

Research what NetSuite, Salesforce or Office365 themselves define as roles. This is deliberately
*not* about what the CData connector chose to expose. The two diverging is a finding the report
surfaces on purpose: a vendor role that the connector cannot represent is a real gap for anyone
building permission-aware agents on top of it.

## Return this, and nothing else

```json
{
  "roles": [
    {
      "name": "Controller",
      "group": "Finance",
      "source": "doc",
      "access": { "AP": "F", "GL": "F", "HR": "N" }
    }
  ],
  "role_complexity": "high",
  "sources": ["https://..."]
}
```

Access levels: `F` Full · `E` Edit · `C` Create · `V` View · `N` None.
Keys are the domain ids supplied in your prompt.

**Every role carries every domain id** — an omitted key is not "no access", it is a hole, and it
used to be filled with `N`. asn005's Asana matrix came back with 7 of 14 domains reading `N` for
all 20 roles, including Files, Time Tracking and Custom Fields, which every Member uses; it also
gave Super Admin only View on tasks. Both are impossible, and both distorted the tiering. So:

- a domain where **no** role has any access is rejected by the validator — every feature someone
  can use has at least one role that uses it;
- the most privileged role (Super Admin, Owner, Administrator) is at least as capable as an
  ordinary member in every domain it administers;
- if the documentation says nothing about a domain, infer it from the nearest documented role
  and mark that role `"source": "inferred"` — do not write `N` to mean "not found".

`source` is `"doc"` when you read the access level in vendor documentation and `"inferred"` when
you deduced it. Mark inferred honestly — the report shows this, and an inferred matrix presented
as documented would make the permission findings untrustworthy.

## Role complexity

| Value | Condition |
|---|---|
| `low` | 3 or fewer roles, or every role has identical access everywhere |
| `medium` | 4 to 8 roles with some variation, no domain-scoped admin |
| `high` | 9 or more roles, or a domain-scoped admin pattern |

If the system has no real role hierarchy — a single API key, for instance — return one role
`{"name":"API User","group":"Default","source":"inferred","access":{"*":"F"}}` with
`role_complexity: "low"`. That is a legitimate answer, not a research failure.

---

## Persist before you return

Write your completed JSON to `<connectorDir>/_agent_out/stage2-role.json` **before** returning
it. Create `_agent_out/` if it does not exist.

Your caller may be compacted while you are still working — research agents routinely run for
several minutes. A result that exists only in your return value is lost when that happens; a
result on disk is picked up on resume. Return the JSON as well, exactly as specified above: the
file is the record, the return value is the convenience.
