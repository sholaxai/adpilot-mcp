import type { DailyMetric } from "../types.js";

export type MetricKey = "spend" | "cpa" | "roas" | "ctr" | "cpc";

export interface Anomaly {
  metric: MetricKey;
  date: string;
  value: number;
  baselineMedian: number;
  score: number; // robust z-score
  direction: "up" | "down";
  severity: "warning" | "critical";
  /** true when the move is bad for the advertiser (e.g. CPA up, ROAS down) */
  harmful: boolean;
}

const derive: Record<MetricKey, (r: DailyMetric) => number | null> = {
  spend: (r) => r.spend,
  cpa: (r) => (r.conversions > 0 ? r.spend / r.conversions : null),
  roas: (r) => (r.spend > 0 ? r.revenue / r.spend : null),
  ctr: (r) => (r.impressions > 0 ? r.clicks / r.impressions : null),
  cpc: (r) => (r.clicks > 0 ? r.spend / r.clicks : null),
};

const higherIsWorse: Record<MetricKey, boolean> = {
  spend: true, cpa: true, cpc: true, roas: false, ctr: false,
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Robust z-score using median absolute deviation, which isn't thrown off by
 * earlier outliers the way mean/stddev is. 1.4826 scales MAD to σ for normal data.
 */
export function robustZ(value: number, baseline: number[]): { z: number; med: number } {
  const med = median(baseline);
  const mad = median(baseline.map((x) => Math.abs(x - med))) * 1.4826;
  const floor = Math.max(Math.abs(med) * 0.05, 1e-9); // avoid div-by-zero on flat series
  return { z: (value - med) / Math.max(mad, floor), med };
}

export interface DetectOptions {
  window?: number;
  warn?: number;
  critical?: number;
  metrics?: MetricKey[];
  lookback?: number; // how many most recent days to evaluate
}

export function detectAnomalies(rows: DailyMetric[], opts: DetectOptions = {}): Anomaly[] {
  const { window = 14, warn = 3, critical = 5, lookback = 1 } = opts;
  const metrics = opts.metrics ?? (Object.keys(derive) as MetricKey[]);
  const out: Anomaly[] = [];

  for (let i = Math.max(rows.length - lookback, 1); i < rows.length; i++) {
    const today = rows[i]!;
    const hist = rows.slice(Math.max(0, i - window), i);
    if (hist.length < 5) continue;
    for (const m of metrics) {
      const v = derive[m](today);
      const base = hist.map(derive[m]).filter((x): x is number => x !== null);
      if (v === null || base.length < 5) continue;
      const { z, med } = robustZ(v, base);
      const abs = Math.abs(z);
      if (abs < warn) continue;
      const direction = z > 0 ? "up" : "down";
      out.push({
        metric: m,
        date: today.date,
        value: +v.toFixed(4),
        baselineMedian: +med.toFixed(4),
        score: +z.toFixed(2),
        direction,
        severity: abs >= critical ? "critical" : "warning",
        harmful: (direction === "up") === higherIsWorse[m],
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}
