import { describe, expect, it } from "vitest";
import { allocate, shrinkRoas } from "../src/analytics/allocator.js";
import { detectAnomalies, median, robustZ } from "../src/analytics/anomaly.js";
import { summarise } from "../src/analytics/metrics.js";
import type { DailyMetric } from "../src/types.js";

const day = (i: number, o: Partial<DailyMetric> = {}): DailyMetric => ({
  date: `2026-11-${String(i).padStart(2, "0")}`,
  spend: 50, impressions: 10000, clicks: 150, conversions: 5, revenue: 200, ...o,
});

describe("metrics", () => {
  it("summarises and guards divide-by-zero", () => {
    const s = summarise([day(1), day(2, { conversions: 0, revenue: 0 })]);
    expect(s.spend).toBe(100);
    expect(s.cpa).toBe(20);
    expect(s.roas).toBe(2);
    expect(summarise([]).cpa).toBeNull();
  });
});

describe("anomaly detection", () => {
  it("median + robust z ignore earlier outliers", () => {
    expect(median([1, 3, 2, 100])).toBe(2.5);
    const { z } = robustZ(10, [10, 10.5, 9.5, 10, 500]);
    expect(Math.abs(z)).toBeLessThan(1);
  });

  it("flags a CPA spike on the latest day as harmful + critical", () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      day(i + 1, { spend: 50 + (i % 3), conversions: 5 + (i % 2) }));
    rows.push(day(15, { conversions: 1 }));
    const found = detectAnomalies(rows);
    const cpa = found.find((a) => a.metric === "cpa");
    expect(cpa?.direction).toBe("up");
    expect(cpa?.harmful).toBe(true);
    expect(cpa?.severity).toBe("critical");
  });

  it("treats a ROAS jump as non-harmful", () => {
    const rows = Array.from({ length: 10 }, (_, i) => day(i + 1, { revenue: 200 + (i % 3) * 5 }));
    rows.push(day(11, { revenue: 900 }));
    const roas = detectAnomalies(rows).find((a) => a.metric === "roas");
    expect(roas?.harmful).toBe(false);
  });

  it("needs a minimum history", () => {
    expect(detectAnomalies([day(1), day(2), day(3)])).toEqual([]);
  });
});

describe("allocator", () => {
  it("shrinks low-spend ROAS toward the prior", () => {
    expect(shrinkRoas(10, 200, 2, 150)).toBeLessThan(4); // raw ROAS would be 20
  });

  it("conserves total budget and shifts toward winners within step limits", () => {
    const res = allocate(
      [
        { id: "a", current: 100, spend: 1000, revenue: 5000 },
        { id: "b", current: 100, spend: 1000, revenue: 1000 },
        { id: "c", current: 100, spend: 1000, revenue: 2500 },
      ],
      { maxStep: 0.2 },
    );
    const by = Object.fromEntries(res.map((r) => [r.id, r.proposed]));
    expect(by.a).toBeCloseTo(120);
    expect(by.b).toBeCloseTo(80);
    expect(res.reduce((s, r) => s + r.proposed, 0)).toBeCloseTo(300, 1);
  });

  it("never moves locked campaigns", () => {
    const res = allocate([
      { id: "a", current: 50, spend: 500, revenue: 5000, locked: true },
      { id: "b", current: 50, spend: 500, revenue: 500 },
    ]);
    expect(res.find((r) => r.id === "a")!.proposed).toBe(50);
  });

  it("respects a new total", () => {
    const res = allocate(
      [
        { id: "a", current: 100, spend: 700, revenue: 2100 },
        { id: "b", current: 100, spend: 700, revenue: 2000 },
      ],
      { total: 220, maxStep: 0.5 },
    );
    expect(res.reduce((s, r) => s + r.proposed, 0)).toBeCloseTo(220, 1);
  });
});
