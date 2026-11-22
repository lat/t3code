import type { LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  buildActivityGrid,
  dayStart,
  forecastPool,
  formatSpan,
  localDay,
  tightestPoolWindow,
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
    expect(forecast.runway).toEqual({
      resetAt: now + 5 * DAY,
      runsOutAt: now + 52 * HOUR,
      leftAtReset: 0,
    });
  });

  it("reaches the reset with quota left at a slower burn", () => {
    const forecast = forecastPool({
      members: [
        { weight: 1, usedPercent: 48, refillPercent: 48, resetsAt: now + DAY, windowMs: 7 * DAY },
      ],
      usage,
      now,
      from: now - DAY,
      to: now + 2 * DAY,
    });
    expect(forecast.runway?.runsOutAt).toBeNull();
    // 48 percent over six days is a third of a percent an hour, so 52 less 8 by the reset.
    expect(forecast.runway?.leftAtReset).toBeCloseTo(44);
  });

  it("falls back to the window's average pace without token history", () => {
    const forecast = forecastPool({
      members: [
        // Two days into a week with 60 percent spent: 30 a day, so 40 lasts another 32 hours.
        {
          weight: 1,
          usedPercent: 60,
          refillPercent: 60,
          resetsAt: now + 5 * DAY,
          windowMs: 7 * DAY,
        },
      ],
      usage: [],
      now,
      from: now - DAY,
      to: now + 2 * DAY,
    });
    expect(forecast.runway?.runsOutAt).toBeCloseTo(now + 32 * HOUR);
  });

  it("stays level without recent usage", () => {
    const forecast = forecastPool({
      members: [
        { weight: 5, usedPercent: 20, refillPercent: 20, resetsAt: now + DAY, windowMs: 7 * DAY },
      ],
      // Spent early in the window, nothing in the last three days.
      usage: [{ day: addDays("2026-11-14", -5), tokens: 2400 }],
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

describe("formatSpan", () => {
  it.each([
    [40 * 60_000, "40m"],
    [3 * HOUR + 20 * 60_000, "3h 20m"],
    [5 * HOUR, "5h"],
    [2 * DAY + 5 * HOUR, "2d 5h"],
    [3 * DAY, "3d"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatSpan(ms)).toBe(expected);
  });
});

describe("tightestPoolWindow", () => {
  const poolWindow = (
    id: string,
    kind: LimitPoolWindow["kind"],
    usedPercent: number,
  ): LimitPoolWindow =>
    ({
      id,
      kind,
      label: id,
      members: [{ window: { id, kind, label: id, usedPercent } }],
      weights: [1],
      capacity: 1,
      columns: [],
    }) as unknown as LimitPoolWindow;

  it("charts the most spent weekly quota among several", () => {
    const pool = {
      driver: "antigravity",
      windows: [
        poolWindow("gemini-5h", "session", 90),
        poolWindow("gemini-weekly", "weekly", 20),
        poolWindow("3p-weekly", "weekly", 60),
      ],
    } as unknown as LimitPool;
    expect(tightestPoolWindow(pool)?.id).toBe("3p-weekly");
  });

  it("charts only the quotas a card includes", () => {
    const pool = {
      driver: "antigravity",
      windows: [
        poolWindow("gemini-5h", "session", 90),
        poolWindow("gemini-weekly", "weekly", 20),
        poolWindow("gemini-argon-weekly", "weekly", 35),
        poolWindow("3p-weekly", "weekly", 100),
      ],
    } as unknown as LimitPool;
    expect(tightestPoolWindow(pool, (window) => window.id.startsWith("gemini"))?.id).toBe(
      "gemini-argon-weekly",
    );
  });

  it("returns null for a pool without windows", () => {
    expect(tightestPoolWindow({ windows: [] } as unknown as LimitPool)).toBeNull();
  });
});
