import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BudgetChange, BudgetPlan } from "../types.js";

export interface Policy {
  /** Hard ceiling on the sum of all daily budgets after a plan is applied. */
  maxTotalDaily: number;
  /** Max single-campaign change per plan, as a fraction (0.25 = ±25%). */
  maxChangePct: number;
  /** Campaign IDs the AI may never touch. */
  protectedCampaigns: string[];
  /** Plans must be applied within this many minutes of being proposed. */
  planTtlMinutes: number;
  auditLogPath?: string;
}

export const DEFAULT_POLICY: Policy = {
  maxTotalDaily: 500,
  maxChangePct: 0.25,
  protectedCampaigns: [],
  planTtlMinutes: 30,
};

export class PolicyViolation extends Error {}

/**
 * Two-phase commit for spend changes: the model can only *propose* a plan; applying
 * it needs the plan id back, which must still be fresh and still pass policy.
 */
export class Guardrails {
  private plans = new Map<string, BudgetPlan>();

  constructor(public policy: Policy = DEFAULT_POLICY, private now = () => new Date()) {}

  check(changes: BudgetChange[], totalBefore: number): string[] {
    const errors: string[] = [];
    for (const c of changes) {
      if (this.policy.protectedCampaigns.includes(c.campaignId)) {
        errors.push(`${c.campaignId} is protected`);
      }
      if (c.to < 0) errors.push(`${c.campaignId}: negative budget`);
      const pct = c.from > 0 ? Math.abs(c.to - c.from) / c.from : Infinity;
      if (pct > this.policy.maxChangePct + 1e-9) {
        errors.push(
          `${c.campaignId}: ${(pct * 100).toFixed(1)}% change exceeds ` +
            `${(this.policy.maxChangePct * 100).toFixed(0)}% limit`,
        );
      }
    }
    const after = totalBefore + changes.reduce((s, c) => s + (c.to - c.from), 0);
    if (after > this.policy.maxTotalDaily + 1e-9) {
      errors.push(`total daily budget ${after.toFixed(2)} exceeds cap ${this.policy.maxTotalDaily}`);
    }
    return errors;
  }

  propose(changes: BudgetChange[], totalBefore: number, warnings: string[] = []): BudgetPlan {
    const errors = this.check(changes, totalBefore);
    if (errors.length) throw new PolicyViolation(errors.join("; "));
    const created = this.now();
    const plan: BudgetPlan = {
      id: `plan_${randomUUID().slice(0, 8)}`,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.policy.planTtlMinutes * 60_000).toISOString(),
      totalBefore: round(totalBefore),
      totalAfter: round(totalBefore + changes.reduce((s, c) => s + (c.to - c.from), 0)),
      changes,
      warnings,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  consume(planId: string): BudgetPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new PolicyViolation(`unknown or already-applied plan ${planId}`);
    this.plans.delete(planId);
    if (this.now() > new Date(plan.expiresAt)) {
      throw new PolicyViolation(`plan ${planId} expired at ${plan.expiresAt}; propose again`);
    }
    return plan;
  }

  async audit(event: string, data: unknown): Promise<void> {
    if (!this.policy.auditLogPath) return;
    const line = JSON.stringify({ ts: this.now().toISOString(), event, data }) + "\n";
    await appendFile(this.policy.auditLogPath, line, "utf8");
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
