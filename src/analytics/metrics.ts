import type { DailyMetric } from "../types.js";

export interface Summary {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr: number;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  cpm: number | null;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const safe = (a: number, b: number) => (b > 0 ? a / b : null);

export function summarise(rows: DailyMetric[]): Summary {
  const t = rows.reduce(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
      conversions: acc.conversions + r.conversions,
      revenue: acc.revenue + r.revenue,
    }),
    { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 },
  );
  const r = (n: number | null, dp = 2) => (n === null ? null : round(n, dp));
  return {
    spend: round(t.spend),
    impressions: t.impressions,
    clicks: t.clicks,
    conversions: t.conversions,
    revenue: round(t.revenue),
    ctr: round(safe(t.clicks, t.impressions) ?? 0, 4),
    cpc: r(safe(t.spend, t.clicks)),
    cpa: r(safe(t.spend, t.conversions)),
    roas: r(safe(t.revenue, t.spend)),
    cpm: r(safe(t.spend * 1000, t.impressions)),
  };
}
