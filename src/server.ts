import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdapterRegistry } from "./adapters/adapter.js";
import { allocate } from "./analytics/allocator.js";
import { detectAnomalies } from "./analytics/anomaly.js";
import { summarise } from "./analytics/metrics.js";
import { Guardrails, PolicyViolation } from "./guardrails/policy.js";
import type { BudgetChange, Platform } from "./types.js";

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

export function buildServer(registry: AdapterRegistry, guard = new Guardrails()) {
  const server = new McpServer({ name: "adpilot-mcp", version: "0.2.0" });

  server.registerTool(
    "list_campaigns",
    {
      description: "List every campaign across connected ad platforms with status and daily budget.",
      inputSchema: { status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ALL") },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const all = await registry.allCampaigns();
      return json(status === "ALL" ? all : all.filter((c) => c.status === status));
    },
  );

  server.registerTool(
    "campaign_performance",
    {
      description:
        "KPIs (spend, CTR, CPC, CPA, ROAS, CPM) per campaign over the last N days, ranked by ROAS.",
      inputSchema: { days: z.number().int().min(1).max(90).default(14) },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const campaigns = await registry.allCampaigns();
      const rows = await Promise.all(
        campaigns.map(async (c) => ({
          id: c.id, platform: c.platform, name: c.name, status: c.status,
          dailyBudget: c.dailyBudget,
          ...summarise(await registry.get(c.platform).getDailyMetrics(c.id, days)),
        })),
      );
      rows.sort((a, b) => (b.roas ?? -1) - (a.roas ?? -1));
      return json({ days, totals: summarise(rows.map((r) => ({ date: "", ...r }))), campaigns: rows });
    },
  );

  server.registerTool(
    "detect_anomalies",
    {
      description:
        "Flag unusual moves in spend/CPA/ROAS/CTR/CPC using robust z-scores (median + MAD) " +
        "against a trailing baseline. Returns the most severe first.",
      inputSchema: {
        days: z.number().int().min(7).max(90).default(21),
        threshold: z.number().min(1.5).max(10).default(3),
        onlyHarmful: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ days, threshold, onlyHarmful }) => {
      const campaigns = (await registry.allCampaigns()).filter((c) => c.status === "ACTIVE");
      const findings = [];
      for (const c of campaigns) {
        const rows = await registry.get(c.platform).getDailyMetrics(c.id, days);
        for (const a of detectAnomalies(rows, { warn: threshold })) {
          if (!onlyHarmful || a.harmful) findings.push({ campaignId: c.id, name: c.name, ...a });
        }
      }
      findings.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
      return json({ count: findings.length, findings });
    },
  );

  server.registerTool(
    "propose_budget_plan",
    {
      description:
        "Propose a reallocation of daily budgets toward higher-ROAS campaigns. Uses spend-weighted " +
        "ROAS shrinkage and bounded water-filling. Nothing changes until apply_budget_plan is called.",
      inputSchema: {
        days: z.number().int().min(3).max(90).default(14),
        totalDaily: z.number().positive().optional()
          .describe("New total daily budget. Defaults to the current total."),
        maxStep: z.number().min(0.01).max(1).optional(),
        aggressiveness: z.number().min(0.5).max(4).default(1.5),
        pauseCriticalAnomalies: z.boolean().default(true),
      },
    },
    async ({ days, totalDaily, maxStep, aggressiveness, pauseCriticalAnomalies }) => {
      const campaigns = (await registry.allCampaigns()).filter((c) => c.status === "ACTIVE");
      const warnings: string[] = [];
      const inputs = await Promise.all(
        campaigns.map(async (c) => {
          const rows = await registry.get(c.platform).getDailyMetrics(c.id, days);
          const s = summarise(rows);
          const crit = detectAnomalies(rows).filter((a) => a.severity === "critical" && a.harmful);
          if (crit.length) {
            warnings.push(`${c.name}: critical ${crit.map((a) => a.metric).join(", ")} anomaly`);
          }
          return {
            id: c.id, platform: c.platform as Platform, name: c.name, current: c.dailyBudget,
            spend: s.spend, revenue: s.revenue,
            locked: guard.policy.protectedCampaigns.includes(c.id),
            freeze: pauseCriticalAnomalies && crit.length > 0,
          };
        }),
      );

      // Campaigns with a critical harmful anomaly get frozen at current spend, not boosted.
      const result = allocate(
        inputs.map((i) => ({ ...i, locked: i.locked || i.freeze })),
        { total: totalDaily, maxStep: maxStep ?? guard.policy.maxChangePct, aggressiveness },
      );
      const byId = new Map(inputs.map((i) => [i.id, i]));
      const changes: BudgetChange[] = result
        .filter((r) => Math.abs(r.proposed - r.current) >= 0.5)
        .map((r) => ({
          campaignId: r.id,
          platform: byId.get(r.id)!.platform,
          from: r.current,
          to: r.proposed,
          reason: `shrunk ROAS ${r.shrunkRoas}`,
        }));

      try {
        const totalBefore = inputs.reduce((s, i) => s + i.current, 0);
        const plan = guard.propose(changes, totalBefore, warnings);
        await guard.audit("plan.proposed", plan);
        return json({ ...plan, next: `Call apply_budget_plan with planId "${plan.id}" to execute.` });
      } catch (e) {
        if (e instanceof PolicyViolation) return fail(`Blocked by policy: ${e.message}`);
        throw e;
      }
    },
  );

  server.registerTool(
    "apply_budget_plan",
    {
      description: "Execute a previously proposed budget plan. Plans expire and can only be applied once.",
      inputSchema: { planId: z.string().regex(/^plan_[a-f0-9]{8}$/) },
      annotations: { destructiveHint: true },
    },
    async ({ planId }) => {
      let plan;
      try {
        plan = guard.consume(planId);
      } catch (e) {
        if (e instanceof PolicyViolation) return fail(e.message);
        throw e;
      }
      const applied: string[] = [];
      const failed: Array<{ campaignId: string; error: string }> = [];
      for (const c of plan.changes) {
        try {
          await registry.get(c.platform).setDailyBudget(c.campaignId, c.to);
          applied.push(c.campaignId);
        } catch (e) {
          failed.push({ campaignId: c.campaignId, error: (e as Error).message });
        }
      }
      await guard.audit("plan.applied", { planId, applied, failed });
      return json({ planId, applied, failed });
    },
  );

  server.registerTool(
    "set_campaign_status",
    {
      description: "Pause or resume a single campaign. Protected campaigns are refused.",
      inputSchema: { campaignId: z.string(), status: z.enum(["ACTIVE", "PAUSED"]) },
      annotations: { destructiveHint: true },
    },
    async ({ campaignId, status }) => {
      if (guard.policy.protectedCampaigns.includes(campaignId)) {
        return fail(`${campaignId} is protected by policy`);
      }
      const c = await registry.findCampaign(campaignId);
      await registry.get(c.platform).setStatus(campaignId, status);
      await guard.audit("campaign.status", { campaignId, status });
      return json({ campaignId, status });
    },
  );

  return server;
}
