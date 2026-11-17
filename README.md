# adpilot-mcp

![ci](https://github.com/sholaxai/adpilot-mcp/actions/workflows/ci.yml/badge.svg)

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT or any MCP client **analyse and manage paid ad campaigns**, with hard guardrails so the model can never torch your budget.

> "Which campaigns are bleeding money this week? Move budget to whatever's actually converting."

It pulls the numbers, spots the anomaly, proposes a bounded reallocation and waits for you to approve it.

## Tools

| Tool | What it does | Mutates? |
|---|---|---|
| `list_campaigns` | Every campaign across connected platforms | no |
| `campaign_performance` | Spend, CTR, CPC, CPA, ROAS, CPM over N days, ranked by ROAS | no |
| `detect_anomalies` | Robust z-score (median + MAD) anomaly detection on spend, CPA, ROAS, CTR, CPC | no |
| `propose_budget_plan` | Builds a reallocation plan and returns a short-lived `planId` | no |
| `apply_budget_plan` | Executes a plan once, before it expires | **yes** |
| `set_campaign_status` | Pause or resume a campaign | **yes** |

## How the maths works

**Anomaly detection.** Each day is compared with a trailing 14-day baseline using `(x − median) / (1.4826 · MAD)`. Unlike mean/stddev, one earlier bad day doesn't inflate the baseline and hide the next one. Findings are labelled `harmful` based on direction, so CPA up is bad and ROAS up is good.

**Budget allocation.**
1. Each campaign's ROAS is shrunk toward the portfolio ROAS, weighted by how much it has actually spent. A campaign that spent £8 and got one lucky sale doesn't win the whole budget.
2. Score = `shrunkROAS ^ aggressiveness`.
3. The total is split proportionally, then **water-filled**: each pass pins whichever side (over-max or under-min) has the bigger violation and redistributes the rest, so the total is conserved exactly while every campaign stays within ±`maxStep` of its current budget.
4. Campaigns with a *critical, harmful* anomaly are frozen rather than boosted.

## Guardrails

- **Two-phase commit:** the model can only *propose*. Applying needs the `planId`, which is single-use and expires (30 minutes by default).
- **Per-campaign change cap** (default ±25%) and a **total daily spend ceiling**.
- **Protected campaigns** can never be changed or paused.
- **Append-only JSONL audit log** of every proposal and execution.

## Setup

```bash
npm install && npm run build
```

Add it to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "adpilot": {
      "command": "node",
      "args": ["/path/to/adpilot-mcp/dist/index.js"],
      "env": {
        "META_AD_ACCOUNT_ID": "1234567890",
        "META_ACCESS_TOKEN": "EAAB...",
        "ADPILOT_MAX_TOTAL_DAILY": "300",
        "ADPILOT_MAX_CHANGE_PCT": "0.2",
        "ADPILOT_PROTECTED": "120201234,120205678",
        "ADPILOT_AUDIT_LOG": "/path/to/adpilot-audit.jsonl"
      }
    }
  }
}
```

With no platform credentials it starts in **mock mode**, with four seeded campaigns including one that has a runaway-spend anomaly to catch. That makes it easy to demo and test. Set `ADPILOT_MOCK=1` to force mock mode alongside real adapters.

## Architecture

```
src/
  adapters/      AdsAdapter interface, registry, Meta Graph API, seeded mock
  analytics/     metrics roll-up, robust anomaly detection, ROAS allocator
  guardrails/    policy checks, plan lifecycle, audit log
  server.ts      MCP tool definitions (zod-validated)
  index.ts       stdio entrypoint + env config
```

Adding a platform means implementing four methods: `listCampaigns`, `getDailyMetrics`, `setDailyBudget` and `setStatus`.

## Tests

```bash
npm test         # unit tests + full MCP client↔server round-trips over an in-memory transport
npm run typecheck
```

## Roadmap

- [ ] Google Ads adapter (GAQL `searchStream`)
- [ ] OpenAI Ads adapter
- [ ] Hourly pacing alerts
- [ ] Creative-level fatigue detection

## License

MIT
