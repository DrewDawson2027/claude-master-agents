# Configuration Reference

## cost/budgets.json

Budget limits per scope. Used by cost_runtime.py and smart_automation.py.

```json
{
  "global": {
    "dailyUSD": 10.0,
    "monthlyUSD": 200.0
  },
  "teams": {
    "my-team": {
      "dailyUSD": 5.0
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `global.dailyUSD` | number | Default daily budget limit |
| `global.monthlyUSD` | number | Default monthly budget limit |
| `teams.{id}.dailyUSD` | number | Per-team daily budget override |

---

## cost/config.json

Cost tracking configuration.

```json
{
  "currency": "USD",
  "refreshIntervalMs": 60000,
  "exportFormat": "csv"
}
```

---

## cost/team-preset-profiles.json

Model presets for team scaling. Used by team_runtime.py auto-bootstrap and scale commands.

```json
{
  "heavy": {
    "members": [
      { "name": "coder", "role": "coder", "model": "sonnet" },
      { "name": "reviewer", "role": "reviewer", "model": "sonnet" },
      { "name": "tester", "role": "tester", "model": "sonnet" },
      { "name": "researcher", "role": "researcher", "model": "haiku" }
    ]
  },
  "standard": {
    "members": [
      { "name": "coder", "role": "coder", "model": "sonnet" },
      { "name": "reviewer", "role": "reviewer", "model": "haiku" }
    ]
  },
  "lite": {
    "members": [
      { "name": "worker", "role": "general", "model": "haiku" }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `{preset}.members[]` | array | List of member definitions |
| `.name` | string | Member display name |
| `.role` | string | Member role (coder, reviewer, tester, researcher, general) |
| `.model` | string | Claude model (sonnet, haiku, opus) |

---

## governance/parity-rubric.json

Grading rubric for parity audits. Each category lists required MCP tools or files.

```json
{
  "categories": {
    "category_name": {
      "required": ["tool_or_file_1", "tool_or_file_2"]
    }
  }
}
```

Current categories (12): runtime_orchestration, context_communication, task_coordination, cost_observability, reliability, onboarding_repeatability, governance_security, ecosystem_distribution_local, observability, policy_governance, collaboration, smart_automation.

Grading: A = 100%, B = 75%+, C = 50%+, D = < 50%.

---

## governance/team-policies/{id}.json

Per-team policy overrides.

```json
{
  "teamId": "my-team",
  "allowedTools": ["coord_team_*", "coord_cost_*"],
  "blockedTools": ["coord_policy_redact"],
  "maxMembers": 6,
  "allowedModels": ["sonnet", "haiku"],
  "budgetOverride": {
    "dailyUSD": 8.0
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `allowedTools` | string[] | Glob patterns for permitted tools |
| `blockedTools` | string[] | Explicitly denied tools |
| `maxMembers` | number | Maximum team size |
| `allowedModels` | string[] | Models this team can use |
| `budgetOverride` | object | Team-specific budget limits |

---

## governance/TRUST_TIERS.md

Trust tier definitions for plugins/MCP servers:
- **Tier 0**: Custom core (always trusted)
- **Tier 1**: Official Anthropic plugins (trusted by default)
- **Tier 2**: Community plugins (require approval + pin + smoke test)

---

## governance/tier2-approvals.json

Approved community plugins with pinned versions.

```json
{
  "approvals": [
    {
      "name": "plugin-name",
      "version": "1.2.3",
      "approvedAt": "2026-01-15T10:00:00Z",
      "approvedBy": "drew"
    }
  ]
}
```

---

## governance/marketplace-channels.json

Plugin marketplace sources.

```json
{
  "channels": [
    {
      "name": "official",
      "url": "https://registry.anthropic.com",
      "tier": 1,
      "autoSync": true
    }
  ]
}
```

---

## hooks/token-guard-config.json

Token guard enforcement limits.

```json
{
  "maxAgentsPerSession": 5,
  "maxExploreAgents": 1,
  "warnAtTokens": 150000,
  "blockAtTokens": 300000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `maxAgentsPerSession` | number | Hard cap on Task tool calls |
| `maxExploreAgents` | number | Max Explore-type agents |
| `warnAtTokens` | number | Token count warning threshold |
| `blockAtTokens` | number | Token count blocking threshold |

---

## distribution/manifest.json

Bundle manifest for packaging and distribution.

```json
{
  "name": "claude-parity-layer",
  "version": "1.0.0",
  "components": {
    "component_name": {
      "files": ["path/to/file"],
      "required": true
    }
  },
  "compatibility": {
    "claude_code_min": "1.0.0",
    "node_min": "18.0.0",
    "python_min": "3.10"
  }
}
```

---

## teams/{id}/config.json

Per-team runtime configuration (auto-generated).

```json
{
  "teamId": "my-team",
  "createdAt": "2026-02-21T10:00:00Z",
  "preset": "standard",
  "members": [
    {
      "id": "coder",
      "name": "coder",
      "role": "coder",
      "model": "sonnet",
      "status": "active",
      "operatorRole": "lead",
      "presence": "available"
    }
  ],
  "ownership": {
    "owners": ["drew"],
    "escalation": ["drew@email.com"],
    "project": "my-project"
  }
}
```
