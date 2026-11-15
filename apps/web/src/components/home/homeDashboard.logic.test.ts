import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  buildActivityGrid,
  dayStart,
  forecastPool,
  formatCompactUsd,
  localDay,
  tokensBetween,
} from "./homeDashboard.logic";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("tokensBetween", () => {
  it("spreads a day's tokens across it and today's only up to now", () => {
    const now = dayStart("2026-11-14") + 12 * HOUR;
    const usage = [
      { day: "2026-11-13", tokens: 2400 },
      { day: "2026-11-14", tokens: 1200 },
    ];
    expect(
      tokensBetween(usage, dayStart("2026-11-13"), dayStart("2026-11-13") + 6 * HOUR, now),
    ).toBe(600);
    expect(tokensBetween(usage, dayStart("2026-11-14"), now, now)).toBe(1200);
    expect(tokensBetween(usage, now - 6 * HOUR, now, now)).toBe(600);
  });
});

describe("forecastPool", () => {
  const now = dayStart("2026-11-14") + 12 * HOUR;
  // 100 tokens an hour, every hour, for the past week.
  const usage = Array.from({ length: 8 }, (_, index) => ({
    day: addDays("2026-11-14", index - 7),
    tokens: index === 7 ? 1200 : 2400,
  }));

  it("projects the current burn to empty, then refills at the reset", () => {
    const forecast = forecastPool({
      members: [
        // Started two days ago and has spent 48 of its percent: 4,800 tokens at 1 percent per 100.
        {
          weight: 1,
          usedPercent: 48,
          refillPercent: 48,
          resetsAt: now + 5 * DAY,
          windowMs: 7 * DAY,
        },
      ],
      usage,
      now,
      from: now - DAY,
      to: now + 6 * DAY,
    });
    expect(forecast.capacityPercent).toBe(100);
    expect(forecast.remainingPercent).toBe(52);
    expect(forecast.runsOutAt).toBe(now + 52 * HOUR);
    expect(forecast.emptyBand).toEqual({ from: now + 52 * HOUR, to: now + 5 * DAY, percent: 48 });
    expect(forecast.points.find((point) => point.at === now - DAY)?.remaining).toBe(76);
    expect(forecast.points.at(-1)?.remaining).toBeLessThan(48);
  });

  it("stays level without recent usage", () => {
    const forecast = forecastPool({
      members: [
        { weight: 5, usedPercent: 20, refillPercent: 20, resetsAt: now + DAY, windowMs: 7 * DAY },
      ],
      usage: [],
      now,
      from: now - DAY,
      to: now + 2 * DAY,
    });
    expect(forecast.runsOutAt).toBeNull();
    expect(forecast.nextRefill).toEqual({ at: now + DAY, percent: 100 });
    expect(new Set(forecast.points.filter((p) => p.at <= now).map((p) => p.remaining))).toEqual(
      new Set([400]),
    );
    expect(forecast.points.at(-1)?.remaining).toBe(500);
  });
});

describe("buildActivityGrid", () => {
  it("ends on this week, blanks future days, and ranks active days by quartile", () => {
    const today = "2026-11-12";
    const grid = buildActivityGrid(
      [
        { day: "2026-11-09", tokens: 10 },
        { day: "2026-11-10", tokens: 20 },
        { day: "2026-11-11", tokens: 30 },
        { day: "2026-11-12", tokens: 40 },
      ],
      today,
      2,
    );
    const lastWeek = grid.weeks.at(-1)!;
    expect(lastWeek.map((cell) => cell?.level ?? null)).toEqual([0, 1, 2, 3, 4, null, null]);
    expect(grid.weeks[0]![0]!.day).toBe("2026-11-01");
    expect(grid.totalTokens).toBe(100);
    expect(localDay(dayStart(today))).toBe(today);
  });
});

describe("formatCompactUsd", () => {
  it.each([
    [12.4, "$12"],
    [3600, "$3.6k"],
    [3000, "$3k"],
    [125_000, "$125k"],
    [2_460_000, "$2.5M"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatCompactUsd(value)).toBe(expected);
  });
});
