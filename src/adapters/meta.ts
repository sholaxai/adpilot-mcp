import type { Campaign, CampaignStatus, DailyMetric } from "../types.js";
import type { AdsAdapter } from "./adapter.js";

type Fetch = typeof fetch;

interface InsightRow {
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}

const PURCHASE = "offsite_conversion.fb_pixel_purchase";

/** Meta Marketing API (Graph). Budgets are stored in minor units (pence/cents). */
export class MetaAdapter implements AdsAdapter {
  readonly platform = "meta" as const;
  private base: string;

  constructor(
    private adAccountId: string,
    private accessToken: string,
    private currency = "GBP",
    apiVersion = "v21.0",
    private fetchImpl: Fetch = fetch,
  ) {
    this.base = `https://graph.facebook.com/${apiVersion}`;
  }

  private async call<T>(path: string, init: RequestInit = {}, params: Record<string, string> = {}) {
    const url = new URL(`${this.base}/${path}`);
    url.searchParams.set("access_token", this.accessToken);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, init);
    const body = (await res.json()) as T & { error?: { message: string } };
    if (!res.ok || body.error) throw new Error(`Meta API: ${body.error?.message ?? res.status}`);
    return body;
  }

  async listCampaigns(): Promise<Campaign[]> {
    const out: Campaign[] = [];
    let after: string | undefined;
    do {
      const page = await this.call<{
        data: Array<{ id: string; name: string; status: string; daily_budget?: string }>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(`act_${this.adAccountId}/campaigns`, {}, {
        fields: "id,name,status,daily_budget",
        limit: "100",
        ...(after ? { after } : {}),
      });
      for (const c of page.data) {
        out.push({
          id: c.id,
          platform: "meta",
          name: c.name,
          status: c.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
          dailyBudget: Number(c.daily_budget ?? 0) / 100,
          currency: this.currency,
        });
      }
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
    } while (after);
    return out;
  }

  async getDailyMetrics(campaignId: string, days: number): Promise<DailyMetric[]> {
    const res = await this.call<{ data: InsightRow[] }>(`${campaignId}/insights`, {}, {
      fields: "spend,impressions,clicks,actions,action_values",
      time_increment: "1",
      date_preset: days <= 7 ? "last_7d" : days <= 14 ? "last_14d" : "last_30d",
    });
    const pick = (arr: InsightRow["actions"]) =>
      Number(arr?.find((a) => a.action_type === PURCHASE)?.value ?? 0);
    return res.data.slice(-days).map((r) => ({
      date: r.date_start,
      spend: Number(r.spend ?? 0),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      conversions: pick(r.actions),
      revenue: pick(r.action_values),
    }));
  }

  async setDailyBudget(campaignId: string, amount: number): Promise<void> {
    await this.call(campaignId, { method: "POST" }, { daily_budget: String(Math.round(amount * 100)) });
  }

  async setStatus(campaignId: string, status: CampaignStatus): Promise<void> {
    await this.call(campaignId, { method: "POST" }, { status });
  }
}
