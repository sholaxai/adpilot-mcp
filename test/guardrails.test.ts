import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, Guardrails, PolicyViolation } from "../src/guardrails/policy.js";
import type { BudgetChange } from "../src/types.js";

const change = (id: string, from: number, to: number): BudgetChange => ({
  campaignId: id, platform: "mock", from, to, reason: "test",
});

describe("guardrails", () => {
  it("rejects oversized per-campaign moves", () => {
    const g = new Guardrails({ ...DEFAULT_POLICY, maxChangePct: 0.2 });
    expect(() => g.propose([change("a", 100, 150)], 100)).toThrow(/exceeds 20% limit/);
  });

  it("rejects total over cap and protected campaigns", () => {
    const g = new Guardrails({ ...DEFAULT_POLICY, maxTotalDaily: 110, protectedCampaigns: ["p"] });
    const errs = g.check([change("a", 100, 120), change("p", 10, 11)], 110);
    expect(errs.join()).toMatch(/exceeds cap/);
    expect(errs.join()).toMatch(/p is protected/);
  });

  it("plans are single-use", () => {
    const g = new Guardrails();
    const plan = g.propose([change("a", 100, 110)], 100);
    expect(g.consume(plan.id).id).toBe(plan.id);
    expect(() => g.consume(plan.id)).toThrow(PolicyViolation);
  });

  it("plans expire", () => {
    let t = new Date("2026-11-17T20:00:00Z");
    const g = new Guardrails({ ...DEFAULT_POLICY, planTtlMinutes: 5 }, () => t);
    const plan = g.propose([change("a", 100, 110)], 100);
    t = new Date("2026-11-17T20:06:00Z");
    expect(() => g.consume(plan.id)).toThrow(/expired/);
  });
});
