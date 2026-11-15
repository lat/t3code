import type { UsageProviderKind } from "@t3tools/contracts";
import type { LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BURN_LOOKBACK_MS = 3 * DAY_MS;

export interface DayTokens {
  readonly day: string;
  readonly tokens: number;
}

/** Local midnight for a `YYYY-MM-DD` usage day; usage days are bucketed in the client's zone. */
export function dayStart(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

/** Calendar arithmetic on local days, safe across DST's 23 and 25 hour days. */
export function addDays(day: string, count: number): string {
  const date = new Date(dayStart(day));
  date.setDate(date.getDate() + count);
  return localDay(date.getTime());
}

export function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/**
 * Tokens spent in `[from, to)`, spreading each day's total evenly across the day. Today's
 * bucket only covers the time up to `now`.
 */
export function tokensBetween(
  usage: readonly DayTokens[],
  from: number,
  to: number,
  now: number,
): number {
  if (to <= from) return 0;
  let total = 0;
  for (const { day, tokens } of usage) {
    if (tokens <= 0) continue;
    const start = dayStart(day);
    const end = Math.min(start + DAY_MS, Math.max(now, start + 1));
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0) total += (tokens * overlap) / (end - start);
  }
  return total;
}

export interface PoolForecastPoint {
  readonly at: number;
  /** Remaining pool in member percent, from 0 to `capacityPercent`. */
  readonly remaining: number;
}

export interface PoolForecast {
  readonly capacityPercent: number;
  readonly remainingPercent: number;
  readonly points: readonly PoolForecastPoint[];
  readonly runsOutAt: number | null;
  readonly nextRefill: { readonly at: number; readonly percent: number } | null;
  /** The stretch the forecast spends empty, ending at the refill that ends it. */
  readonly emptyBand: {
    readonly from: number;
    readonly to: number;
    readonly percent: number;
  } | null;
}

export interface PoolForecastMember {
  readonly weight: number;
  readonly usedPercent: number;
  readonly refillPercent: number;
  readonly resetsAt: number | null;
  readonly windowMs: number | null;
}

export function poolForecastMembers(window: LimitPoolWindow): readonly PoolForecastMember[] {
  return window.members.map((member, index) => {
    const resetsAt = member.window.resetsAt ? Date.parse(member.window.resetsAt) : Number.NaN;
    const windowMins = member.window.windowDurationMins;
    return {
      weight: window.weights[index] ?? 1,
      usedPercent: Math.max(0, Math.min(100, member.window.usedPercent)),
      refillPercent: Math.max(0, Math.min(100, member.refillPercent)),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      windowMs: windowMins === undefined ? null : windowMins * 60_000,
    };
  });
}

/**
 * Estimates the pool's level over `[from, to]` from the current limits and token history.
 *
 * Limits only report the present, so the past is reconstructed by assuming a pool percent costs
 * the same number of tokens throughout the current windows, and the future assumes the last
 * three days' burn rate continues. Resets refill what each member has spent today.
 */
export function forecastPool(input: {
  readonly members: readonly PoolForecastMember[];
  readonly usage: readonly DayTokens[];
  readonly now: number;
  readonly from: number;
  readonly to: number;
  readonly stepMs?: number;
}): PoolForecast {
  const { members, usage, now, from, to } = input;
  const stepMs = input.stepMs ?? HOUR_MS;
  const capacityPercent = members.reduce((sum, member) => sum + member.weight * 100, 0);
  const usedNow = members.reduce((sum, member) => sum + member.weight * member.usedPercent, 0);
  const remainingPercent = Math.max(0, capacityPercent - usedNow);

  const starts = members.flatMap((member) =>
    member.resetsAt !== null && member.windowMs !== null
      ? [{ member, at: member.resetsAt - member.windowMs }]
      : [],
  );
  const earliestStart =
    starts.length > 0
      ? starts.reduce((min, start) => Math.min(min, start.at), Number.POSITIVE_INFINITY)
      : now - 7 * DAY_MS;
  const tokensInWindows = tokensBetween(usage, earliestStart, now, now);
  const percentPerToken = tokensInWindows > 0 ? usedNow / tokensInWindows : 0;
  const burnPerMs =
    (percentPerToken * tokensBetween(usage, now - BURN_LOOKBACK_MS, now, now)) / BURN_LOOKBACK_MS;

  const clamp = (value: number) => Math.max(0, Math.min(capacityPercent, value));
  // A previous window is assumed to have run at the current window's pace.
  const previousSpend = (member: PoolForecastMember, start: number) => {
    if (member.windowMs === null) return 0;
    const elapsed = Math.max(HOUR_MS, now - start);
    return member.weight * Math.min(100, (member.usedPercent * member.windowMs) / elapsed);
  };
  const levelAt = (at: number) => {
    let level = remainingPercent + percentPerToken * tokensBetween(usage, at, now, now);
    for (const start of starts) {
      if (start.at > at && start.at <= now) level -= previousSpend(start.member, start.at);
    }
    return clamp(level);
  };

  const resets = members
    .flatMap((member) =>
      member.resetsAt !== null && member.resetsAt > now
        ? [{ at: member.resetsAt, percent: member.weight * member.refillPercent }]
        : [],
    )
    .sort((left, right) => left.at - right.at);
  const nextRefill = resets.find((reset) => reset.percent > 0) ?? null;

  const points: PoolForecastPoint[] = [];
  for (let at = from; at < now; at += stepMs) points.push({ at, remaining: levelAt(at) });
  points.push({ at: now, remaining: remainingPercent });

  const future = { level: remainingPercent, cursor: now, runsOutAt: null as number | null };
  const drainUntil = (until: number) => {
    const elapsed = until - future.cursor;
    if (elapsed > 0 && burnPerMs > 0 && future.level > 0) {
      const next = future.level - burnPerMs * elapsed;
      if (next <= 0 && future.runsOutAt === null) {
        future.runsOutAt = future.cursor + future.level / burnPerMs;
      }
      future.level = Math.max(0, next);
    }
    future.cursor = Math.max(future.cursor, until);
  };

  let emptyBand: PoolForecast["emptyBand"] = null;
  let resetIndex = 0;
  const firstFuture = from + Math.ceil((now - from) / stepMs) * stepMs;
  for (let at = firstFuture > now ? firstFuture : firstFuture + stepMs; at <= to; at += stepMs) {
    while (resetIndex < resets.length && resets[resetIndex]!.at <= at) {
      const reset = resets[resetIndex]!;
      drainUntil(reset.at);
      if (future.level === 0 && future.runsOutAt !== null && !emptyBand && reset.percent > 0) {
        emptyBand = { from: future.runsOutAt, to: reset.at, percent: reset.percent };
      }
      future.level = clamp(future.level + reset.percent);
      resetIndex += 1;
    }
    drainUntil(at);
    points.push({ at, remaining: future.level });
  }

  return {
    capacityPercent,
    remainingPercent,
    points,
    runsOutAt: future.runsOutAt,
    nextRefill,
    emptyBand,
  };
}

/** The window a pool card charts: the weekly allowance when there is one. */
export function primaryPoolWindow(pool: LimitPool): LimitPoolWindow | null {
  return (
    pool.windows.find((window) => window.kind === "weekly") ??
    pool.windows.find((window) => window.kind === "session") ??
    pool.windows[0] ??
    null
  );
}

export interface ActivityCell {
  readonly day: string;
  readonly tokens: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityGrid {
  /** Week columns, each Sunday first; days after today are null. */
  readonly weeks: readonly (readonly (ActivityCell | null)[])[];
  readonly months: readonly { readonly column: number; readonly label: string }[];
  readonly totalTokens: number;
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function buildActivityGrid(
  usage: readonly DayTokens[],
  today: string,
  weekCount: number,
): ActivityGrid {
  const byDay = new Map(usage.map((entry) => [entry.day, entry.tokens]));
  const todayStart = dayStart(today);
  const todayWeekday = new Date(todayStart).getDay();
  const firstDay = new Date(todayStart);
  firstDay.setDate(firstDay.getDate() - todayWeekday - (weekCount - 1) * 7);

  const days: string[] = [];
  for (let index = 0; index < weekCount * 7; index += 1) {
    const date = new Date(firstDay);
    date.setDate(firstDay.getDate() + index);
    days.push(localDay(date.getTime()));
  }
  const active = days
    .map((day) => byDay.get(day) ?? 0)
    .filter((tokens) => tokens > 0)
    .sort((left, right) => left - right);
  const quantile = (share: number) => active[Math.floor(share * (active.length - 1))] ?? 0;
  const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];
  const levelOf = (tokens: number): ActivityCell["level"] => {
    if (tokens <= 0) return 0;
    if (tokens <= thresholds[0]!) return 1;
    if (tokens <= thresholds[1]!) return 2;
    if (tokens <= thresholds[2]!) return 3;
    return 4;
  };

  const weeks: (ActivityCell | null)[][] = [];
  const months: { column: number; label: string }[] = [];
  let totalTokens = 0;
  for (let column = 0; column < weekCount; column += 1) {
    const week: (ActivityCell | null)[] = [];
    for (let row = 0; row < 7; row += 1) {
      const day = days[column * 7 + row]!;
      if (day > today) {
        week.push(null);
        continue;
      }
      const tokens = byDay.get(day) ?? 0;
      totalTokens += tokens;
      week.push({ day, tokens, level: levelOf(tokens) });
      if (day.endsWith("-01") || (column === 0 && row === 0)) {
        const label = MONTH_LABELS[Number(day.slice(5, 7)) - 1]!;
        if (months.at(-1)?.label !== label) months.push({ column, label });
      }
    }
    weeks.push(week);
  }
  // A label squeezed against the next month's reads as one word.
  const spaced = months.filter(
    (month, index) => (months[index + 1]?.column ?? Infinity) - month.column >= 2,
  );
  return { weeks, months: spaced, totalTokens };
}

export interface MonthUsage {
  readonly days: readonly string[];
  readonly providers: readonly UsageProviderKind[];
  readonly rows: readonly Record<string, number | string>[];
  readonly totals: ReadonlyMap<UsageProviderKind, number>;
  readonly costUsd: number;
  readonly peakTokens: number;
}

/** Month-to-date usage, widened to the last week early in a month so the chart has a shape. */
export function buildMonthUsage(daily: readonly DailyTotals[], today: string): MonthUsage {
  const monthStart = `${today.slice(0, 8)}01`;
  const weekAgo = addDays(today, -6);
  const since = monthStart < weekAgo ? monthStart : weekAgo;
  const days: string[] = [];
  for (let day = since; day <= today; day = addDays(day, 1)) days.push(day);
  const byDay = new Map(daily.map((entry) => [entry.day, entry]));
  const totals = new Map<UsageProviderKind, number>();
  let costUsd = 0;
  for (const day of days) {
    const entry = byDay.get(day);
    if (!entry) continue;
    if (day >= monthStart) costUsd += entry.costUsd;
    for (const [provider, value] of entry.byProvider) {
      if (day >= monthStart) totals.set(provider, (totals.get(provider) ?? 0) + value.totalTokens);
    }
  }
  const providers = [...totals]
    .filter(([, tokens]) => tokens > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([provider]) => provider);
  let peakTokens = 0;
  const rows = days.map((day) => {
    const row: Record<string, number | string> = { day };
    const entry = byDay.get(day);
    for (const provider of providers) {
      const tokens = entry?.byProvider.get(provider)?.totalTokens ?? 0;
      row[provider] = tokens;
      peakTokens = Math.max(peakTokens, tokens);
    }
    return row;
  });
  return { days, providers, rows, totals, costUsd, peakTokens };
}

export function formatCompactUsd(value: number): string {
  if (value >= 1e6) return `$${trimDecimal(value / 1e6)}M`;
  if (value >= 1e3) return `$${trimDecimal(value / 1e3)}k`;
  return `$${Math.round(value)}`;
}

export function formatPoolPercent(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")}%`;
}

function trimDecimal(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}
