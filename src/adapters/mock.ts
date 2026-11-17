import type { Campaign, CampaignStatus, DailyMetric } from "../types.js";
import { type AdsAdapter, isoDaysAgo } from "./adapter.js";

/** Small, fast, seedable PRNG so demo data is deterministic across runs and tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Profile {
  ctr: number;
  cvr: number;
  cpm: number;
  aov: number;
  /** If set, the last day spikes CPA by this factor (to demo anomaly detection). */
  spikeLastDay?: number;
}

const SEED_CAMPAIGNS: Array<Campaign & { profile: Profile }> = [
  { id: "mock_101", platform: "mock", name: "Prospecting – UK 18-34", status: "ACTIVE",
    dailyBudget: 60, currency: "GBP", profile: { ctr: 0.012, cvr: 0.03, cpm: 6, aov: 42 } },
  { id: "mock_102", platform: "mock", name: "Retargeting – site visitors 30d", status: "ACTIVE",
    dailyBudget: 25, currency: "GBP", profile: { ctr: 0.021, cvr: 0.07, cpm: 9, aov: 48 } },
  { id: "mock_103", platform: "mock", name: "Lookalike – purchasers 1%", status: "ACTIVE",
    dailyBudget: 40, currency: "GBP",
    profile: { ctr: 0.01, cvr: 0.025, cpm: 7, aov: 40, spikeLastDay: 3.2 } },
  { id: "mock_104", platform: "mock", name: "Brand awareness – video", status: "ACTIVE",
    dailyBudget: 30, currency: "GBP", profile: { ctr: 0.006, cvr: 0.008, cpm: 4, aov: 38 } },
];

export class MockAdapter implements AdsAdapter {
  readonly platform = "mock" as const;
  private campaigns = new Map(SEED_CAMPAIGNS.map((c) => [c.id, structuredClone(c)]));

  constructor(private seed = 42, private today = new Date()) {}

  async listCampaigns(): Promise<Campaign[]> {
    return [...this.campaigns.values()].map(({ profile: _p, ...c }) => c);
  }

  async getDailyMetrics(campaignId: string, days: number): Promise<DailyMetric[]> {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Unknown campaign ${campaignId}`);
    const rng = mulberry32(this.seed + Number(campaignId.replace(/\D/g, "")));
    const out: DailyMetric[] = [];
    for (let i = days; i >= 1; i--) {
      const jitter = () => 0.85 + rng() * 0.3;
      let spend = +(c.dailyBudget * (0.9 + rng() * 0.1)).toFixed(2);
      const impressions = Math.round((spend / (c.profile.cpm * jitter())) * 1000);
      const clicks = Math.round(impressions * c.profile.ctr * jitter());
      const conversions = Math.round(clicks * c.profile.cvr * jitter());
      if (i === 1 && c.profile.spikeLastDay) {
        // Simulates a runaway-spend bug: platform overspends with no extra results.
        spend = +(spend * c.profile.spikeLastDay).toFixed(2);
      }
      const revenue = +(conversions * c.profile.aov * jitter()).toFixed(2);
      out.push({ date: isoDaysAgo(i, this.today), spend, impressions, clicks, conversions, revenue });
    }
    return out;
  }

  async setDailyBudget(campaignId: string, amount: number): Promise<void> {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Unknown campaign ${campaignId}`);
    c.dailyBudget = amount;
  }

  async setStatus(campaignId: string, status: CampaignStatus): Promise<void> {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new Error(`Unknown campaign ${campaignId}`);
    c.status = status;
  }
}
