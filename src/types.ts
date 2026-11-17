export type Platform = "meta" | "google" | "openai" | "mock";
export type CampaignStatus = "ACTIVE" | "PAUSED";

export interface Campaign {
  id: string;
  platform: Platform;
  name: string;
  status: CampaignStatus;
  /** Daily budget in major currency units (e.g. GBP). */
  dailyBudget: number;
  currency: string;
}

export interface DailyMetric {
  date: string; // YYYY-MM-DD
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
}

export interface BudgetChange {
  campaignId: string;
  platform: Platform;
  from: number;
  to: number;
  reason: string;
}

export interface BudgetPlan {
  id: string;
  createdAt: string;
  expiresAt: string;
  totalBefore: number;
  totalAfter: number;
  changes: BudgetChange[];
  warnings: string[];
}
