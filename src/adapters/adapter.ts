import type { Campaign, CampaignStatus, DailyMetric, Platform } from "../types.js";

/** Every ad platform is reduced to this small surface so the analytics stay platform-agnostic. */
export interface AdsAdapter {
  readonly platform: Platform;
  listCampaigns(): Promise<Campaign[]>;
  getDailyMetrics(campaignId: string, days: number): Promise<DailyMetric[]>;
  setDailyBudget(campaignId: string, amount: number): Promise<void>;
  setStatus(campaignId: string, status: CampaignStatus): Promise<void>;
}

export class AdapterRegistry {
  private adapters = new Map<Platform, AdsAdapter>();

  register(adapter: AdsAdapter): this {
    this.adapters.set(adapter.platform, adapter);
    return this;
  }

  get(platform: Platform): AdsAdapter {
    const a = this.adapters.get(platform);
    if (!a) throw new Error(`No adapter registered for platform "${platform}"`);
    return a;
  }

  all(): AdsAdapter[] {
    return [...this.adapters.values()];
  }

  async allCampaigns(): Promise<Campaign[]> {
    const lists = await Promise.all(this.all().map((a) => a.listCampaigns()));
    return lists.flat();
  }

  async findCampaign(id: string): Promise<Campaign> {
    const c = (await this.allCampaigns()).find((x) => x.id === id);
    if (!c) throw new Error(`Unknown campaign ${id}`);
    return c;
  }
}

export function isoDaysAgo(n: number, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
