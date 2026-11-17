import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapters/adapter.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { DEFAULT_POLICY, Guardrails } from "../src/guardrails/policy.js";
import { buildServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

let client: Client;
let mock: MockAdapter;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as TextResult;
  return { ok: !r.isError, text: r.content[0]!.text, data: r.isError ? null : JSON.parse(r.content[0]!.text) };
}

beforeEach(async () => {
  mock = new MockAdapter(7, new Date("2026-11-17T12:00:00Z"));
  const guard = new Guardrails({ ...DEFAULT_POLICY, protectedCampaigns: ["mock_104"] });
  const server = buildServer(new AdapterRegistry().register(mock), guard);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe("MCP tools", () => {
  it("exposes the expected tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "apply_budget_plan", "campaign_performance", "detect_anomalies",
      "list_campaigns", "propose_budget_plan", "set_campaign_status",
    ]);
  });

  it("ranks performance by ROAS", async () => {
    const { data } = await call("campaign_performance", { days: 14 });
    const roas = data.campaigns.map((c: { roas: number }) => c.roas);
    expect(roas).toEqual([...roas].sort((a: number, b: number) => b - a));
  });

  it("catches the seeded lookalike CPA spike", async () => {
    const { data } = await call("detect_anomalies", { days: 21 });
    expect(data.findings.some((f: { campaignId: string }) => f.campaignId === "mock_103")).toBe(true);
  });

  it("propose → apply round-trip changes budgets but leaves protected + anomalous alone", async () => {
    const before = await mock.listCampaigns();
    const { data: plan } = await call("propose_budget_plan", {});
    expect(plan.id).toMatch(/^plan_/);
    const touched = plan.changes.map((c: { campaignId: string }) => c.campaignId);
    expect(touched).not.toContain("mock_104");
    expect(touched).not.toContain("mock_103");
    expect(plan.totalAfter).toBeCloseTo(plan.totalBefore, 0);

    const { data: res } = await call("apply_budget_plan", { planId: plan.id });
    expect(res.failed).toEqual([]);
    const after = await mock.listCampaigns();
    expect(after).not.toEqual(before);

    const again = await call("apply_budget_plan", { planId: plan.id });
    expect(again.ok).toBe(false);
  });

  it("refuses to pause protected campaigns", async () => {
    const r = await call("set_campaign_status", { campaignId: "mock_104", status: "PAUSED" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/protected/);
  });
});
