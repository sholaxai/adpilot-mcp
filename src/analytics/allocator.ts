/**
 * Budget allocator.
 *
 * 1. Shrink each campaign's observed ROAS toward the portfolio ROAS, weighted by
 *    how much it has actually spent (empirical-Bayes style). Tiny-spend campaigns
 *    with one lucky sale don't hoover up the whole budget.
 * 2. Score = shrunkROAS^aggressiveness.
 * 3. Split the fixed total proportional to score, then "water-fill" so every
 *    campaign stays within [min, max] and within ±maxStep of its current budget.
 */

export interface AllocInput {
  id: string;
  current: number;
  spend: number;
  revenue: number;
  locked?: boolean;
}

export interface AllocOptions {
  total?: number;           // defaults to sum of current budgets
  priorSpend?: number;      // pseudo-spend for shrinkage (higher = more conservative)
  aggressiveness?: number;  // exponent on ROAS
  minBudget?: number;
  maxBudget?: number;
  maxStep?: number;         // max fractional change per run, e.g. 0.2 = ±20%
}

export interface AllocResult {
  id: string;
  current: number;
  proposed: number;
  shrunkRoas: number;
}

export function shrinkRoas(spend: number, revenue: number, prior: number, priorSpend: number) {
  return (revenue + prior * priorSpend) / (spend + priorSpend);
}

export function allocate(items: AllocInput[], opts: AllocOptions = {}): AllocResult[] {
  const {
    priorSpend = 150,
    aggressiveness = 1.5,
    minBudget = 5,
    maxBudget = Number.POSITIVE_INFINITY,
    maxStep = 0.2,
  } = opts;
  const total = opts.total ?? items.reduce((s, i) => s + i.current, 0);
  const totSpend = items.reduce((s, i) => s + i.spend, 0);
  const prior = totSpend > 0 ? items.reduce((s, i) => s + i.revenue, 0) / totSpend : 1;

  const rows = items.map((i) => {
    const r = shrinkRoas(i.spend, i.revenue, prior, priorSpend);
    const lo = i.locked ? i.current : Math.max(minBudget, i.current * (1 - maxStep));
    const hi = i.locked ? i.current : Math.min(maxBudget, i.current * (1 + maxStep));
    return { ...i, shrunk: r, score: Math.max(r, 1e-6) ** aggressiveness, lo, hi, out: 0 };
  });

  // Water-filling. Each pass only pins the side (over-max or under-min) with the larger
  // total violation; pinning both at once would leak budget. Converges in <= n passes.
  let free = rows.slice();
  for (let iter = 0; iter <= rows.length && free.length; iter++) {
    const fixed = rows.filter((r) => !free.includes(r)).reduce((s, r) => s + r.out, 0);
    const remaining = total - fixed;
    const scoreSum = free.reduce((s, r) => s + r.score, 0);
    for (const r of free) r.out = (remaining * r.score) / scoreSum;

    const over = free.filter((r) => r.out > r.hi);
    const under = free.filter((r) => r.out < r.lo);
    if (!over.length && !under.length) break;
    const overAmt = over.reduce((s, r) => s + (r.out - r.hi), 0);
    const underAmt = under.reduce((s, r) => s + (r.lo - r.out), 0);
    const pin = overAmt >= underAmt ? over : under;
    for (const r of pin) r.out = overAmt >= underAmt ? r.hi : r.lo;
    free = free.filter((r) => !pin.includes(r));
  }

  return rows.map((r) => ({
    id: r.id,
    current: r.current,
    proposed: Math.round(r.out * 100) / 100,
    shrunkRoas: Math.round(r.shrunk * 100) / 100,
  }));
}
