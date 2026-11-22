import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatTokens, makeWindow } from "@t3tools/shared/usageFormat";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import {
  antigravityWindowLimitsModel,
  collectLimitAccounts,
  collectLimitPools,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { scaleLinear } from "d3-scale";
import { T, useGT } from "gt-react";
import { CalendarIcon, ChartLineIcon, GaugeIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useUsage } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveHour12 } from "../../timestampFormat";
import { Area } from "../dither-kit/area";
import { AreaChart } from "../dither-kit/area-chart";
import type { DitherColor, SeriesColor } from "../dither-kit/palette";
import { Tooltip } from "../dither-kit/tooltip";
import { Skeleton } from "../ui/skeleton";
import { Tooltip as UiTooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import {
  type ActivityGrid,
  addDays,
  buildActivityGrid,
  buildMonthUsage,
  type DayTokens,
  dayStart,
  forecastPool,
  formatPoolPercent,
  formatSpan,
  localDay,
  type MonthUsage,
  type PoolForecast,
  type PoolRunway,
  poolForecastMembers,
  primaryPoolWindow,
  tightestPoolWindow,
} from "./homeDashboard.logic";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// A quarter fits a third of the dashboard at readable cell sizes.
const ACTIVITY_WEEKS = 13;
const POOL_HISTORY_MS = 3 * DAY_MS;
const POOL_FORECAST_MS = 3 * DAY_MS;

interface PoolQuota {
  /** The quotas this card may chart; the one closest to running out wins. */
  readonly includes: (window: LimitPoolWindow) => boolean;
  /** Whether a model's tokens spend the charted quota. */
  readonly meters: (window: LimitPoolWindow, model: string) => boolean;
}

interface PoolEntry {
  readonly driver: string;
  readonly provider: UsageProviderKind;
  readonly label: string;
  readonly quota?: PoolQuota;
}

// Each pool charts in its provider's series color, as in the Usage legend.
const POOLS: readonly PoolEntry[] = [
  { driver: "codex", provider: "codex", label: "Codex" },
  { driver: "claudeAgent", provider: "claude", label: "Claude" },
  // Antigravity meters each model family apart. Claude already has its own card, so this one
  // charts the Gemini quotas, whichever binds first, against Gemini tokens alone.
  {
    driver: "antigravity",
    provider: "antigravity",
    label: "Antigravity",
    quota: {
      includes: (window) => window.id.startsWith("gemini"),
      meters: (window, model) => antigravityWindowLimitsModel(window, model),
    },
  },
];

const SERIES_COLOR: Record<UsageProviderKind, DitherColor> = {
  codex: "white",
  claude: "coral",
  grok: "grey",
  cursor: "grey",
  opencode: "blue",
  antigravity: "purple",
  pi: "green",
  muse: "blue",
};

const providerLabel = (provider: UsageProviderKind) =>
  provider === "claude" ? "Claude" : PROVIDER_PRESENTATION[provider].label;

function DashboardCard({
  icon,
  title,
  aside,
  className,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly aside?: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-home-dashboard-card
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border p-4 backdrop-blur-md",
        className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <h2 className="flex min-w-0 items-center gap-2 font-medium text-foreground/90">
          <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
          <span className="truncate">{title}</span>
        </h2>
        {aside ? <div className="shrink-0 text-xs text-muted-foreground">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

function useMomentFormat() {
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const [format] = useState(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12,
      }),
  );
  return (at: number) => format.format(at);
}

interface ChartTick {
  readonly at: number;
  readonly label: string;
  readonly align?: "start" | "center" | "end";
}

/** A series over `[from, to]` with the future past `now` shaded. */
function ForecastChart({
  points,
  from,
  to,
  now,
  color,
  seriesLabel,
  ticks,
  formatMoment,
  formatValue,
  children,
}: {
  readonly points: readonly { readonly at: number; readonly value: number }[];
  readonly from: number;
  readonly to: number;
  readonly now: number;
  readonly color: SeriesColor;
  readonly seriesLabel: string;
  readonly ticks: readonly ChartTick[];
  readonly formatMoment: (at: number) => string;
  readonly formatValue: (value: number) => string;
  /** Overlays positioned over the chart, such as the pool's empty band. */
  readonly children?: ReactNode;
}) {
  const span = to - from;
  const at = (time: number) => `${((time - from) / span) * 100}%`;
  const data = points.map((point) => ({ label: formatMoment(point.at), value: point.value }));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-24">
        <span
          className="pointer-events-none absolute -top-4 -translate-x-1/2 text-3xs tracking-wider text-muted-foreground uppercase"
          style={{ left: at(now) }}
        >
          <T>Now</T>
        </span>
        <AreaChart
          data={data}
          config={{ value: { label: seriesLabel, color } }}
          margins={{ top: 4, right: 0, bottom: 0, left: 0 }}
          className="absolute inset-0"
        >
          <Tooltip labelKey="label" variant="frosted-glass" valueFormatter={formatValue} />
          <Area dataKey="value" variant="dotted" />
        </AreaChart>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/35"
          style={{ left: at(now) }}
        />
        {children}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/45"
          style={{ left: at(now) }}
        />
      </div>
      <div className="relative h-3 text-3xs tracking-wider text-muted-foreground uppercase">
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className={cn(
              "absolute whitespace-nowrap",
              tick.align === "start"
                ? ""
                : tick.align === "end"
                  ? "-translate-x-full"
                  : "-translate-x-1/2",
            )}
            style={{ left: at(tick.at) }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function PoolChart({
  forecast,
  from,
  to,
  now,
  color,
  formatMoment,
}: {
  readonly forecast: PoolForecast;
  readonly color: SeriesColor;
  readonly from: number;
  readonly to: number;
  readonly now: number;
  readonly formatMoment: (at: number) => string;
}) {
  const gt = useGT();
  const span = to - from;
  const days: ChartTick[] = [];
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  for (let day = localDay(from); dayStart(day) < to; day = addDays(day, 1)) {
    const noon = dayStart(day) + 12 * HOUR_MS;
    if (noon > from && noon < to) days.push({ at: noon, label: weekday.format(noon) });
  }
  const band = forecast.emptyBand;

  return (
    <ForecastChart
      points={forecast.points.map((point) => ({
        at: point.at,
        value: Math.round(point.remaining),
      }))}
      from={from}
      to={to}
      now={now}
      color={color}
      seriesLabel={gt("Left", { $context: "remaining share of a usage limit" })}
      ticks={days}
      formatMoment={formatMoment}
      formatValue={formatPoolPercent}
    >
      {band ? (
        <div
          aria-hidden
          data-pool-empty-band
          className="pointer-events-none absolute inset-y-0"
          style={{
            left: `${((band.from - from) / span) * 100}%`,
            width: `${((band.to - band.from) / span) * 100}%`,
          }}
        >
          <span
            data-pool-refill-label
            className="absolute top-1 right-0 translate-x-1/2 rounded-sm px-1 text-3xs tabular-nums"
          >
            +{formatPoolPercent(band.percent)}
          </span>
        </div>
      ) : null}
    </ForecastChart>
  );
}

/** Whether the pool lasts to its refill at the recent pace, under the headline. */
function PoolRunwayLine({
  runway,
  now,
  formatMoment,
}: {
  readonly runway: PoolRunway;
  readonly now: number;
  readonly formatMoment: (at: number) => string;
}) {
  const gt = useGT();
  if (runway.runsOutAt !== null && runway.runsOutAt <= now) {
    return (
      <p data-pool-runway="empty" className="text-xs text-warning">
        <T>Out until the reset</T>
      </p>
    );
  }
  if (runway.runsOutAt !== null) {
    return (
      <p data-pool-runway="short" className="min-w-0 truncate text-xs text-warning">
        {gt("On pace to run out {time}, {gap} before the reset", {
          time: formatMoment(runway.runsOutAt),
          gap: formatSpan(runway.resetAt - runway.runsOutAt),
        })}
      </p>
    );
  }
  return (
    <p data-pool-runway="lasts" className="min-w-0 truncate text-xs text-muted-foreground">
      {gt("On pace to reach the reset with {left} left", {
        left: formatPoolPercent(runway.leftAtReset),
      })}
    </p>
  );
}

function PoolCard({
  label,
  pool,
  daily,
  provider,
  now,
  color,
  quota,
  formatMoment,
}: {
  readonly label: string;
  readonly color: SeriesColor;
  readonly quota: PoolQuota | undefined;
  readonly pool: ReturnType<typeof collectLimitPools>[number] | undefined;
  readonly daily: readonly DailyTotals[];
  readonly provider: UsageProviderKind;
  readonly now: number;
  readonly formatMoment: (at: number) => string;
}) {
  const gt = useGT();
  const window = pool
    ? quota
      ? tightestPoolWindow(pool, quota.includes)
      : primaryPoolWindow(pool)
    : null;
  // Which quota is charted, when the card picks one of several.
  const windowName = quota && window ? window.label.split(" · ")[0] : null;
  const usage: readonly DayTokens[] = daily.map((entry) => ({
    day: entry.day,
    tokens:
      quota && window
        ? [...entry.byModel.values()].reduce(
            (sum, model) =>
              model.provider === provider && quota.meters(window, model.model)
                ? sum + model.totalTokens
                : sum,
            0,
          )
        : (entry.byProvider.get(provider)?.totalTokens ?? 0),
  }));
  const from = now - POOL_HISTORY_MS;
  const to = now + POOL_FORECAST_MS;
  const forecast = window
    ? forecastPool({ members: poolForecastMembers(window), usage, now, from, to })
    : null;
  return (
    <DashboardCard icon={<GaugeIcon />} title={gt("{provider} pool", { provider: label })}>
      {forecast ? (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 truncate">
                <span className="text-2xl font-medium text-foreground tabular-nums">
                  {formatPoolPercent(forecast.remainingPercent)}
                </span>{" "}
                <span className="text-sm text-muted-foreground">
                  {gt("left of {capacity}", {
                    capacity: formatPoolPercent(forecast.capacityPercent),
                  })}
                  {windowName ? ` · ${windowName}` : null}
                </span>
              </p>
              {forecast.nextRefill ? (
                <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  <span className="text-foreground/90">
                    +{formatPoolPercent(forecast.nextRefill.percent)}
                  </span>{" "}
                  {formatMoment(forecast.nextRefill.at)}
                </p>
              ) : null}
            </div>
            {forecast.runway ? (
              <PoolRunwayLine runway={forecast.runway} now={now} formatMoment={formatMoment} />
            ) : null}
          </div>
          <div className="mt-auto pt-3">
            <PoolChart
              forecast={forecast}
              from={from}
              to={to}
              now={now}
              color={color}
              formatMoment={formatMoment}
            />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          <T>No limits reported.</T>
        </p>
      )}
    </DashboardCard>
  );
}

const activityDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const labelOfDay = (day: string) => activityDayFormat.format(dayStart(day));

function ActivityCard({
  grid,
  loading,
}: {
  readonly grid: ActivityGrid;
  readonly loading: boolean;
}) {
  const gt = useGT();
  const describe = (cell: { readonly day: string; readonly tokens: number }) =>
    gt("{day}: {tokens} tokens", { day: labelOfDay(cell.day), tokens: formatTokens(cell.tokens) });
  return (
    <DashboardCard
      icon={<CalendarIcon />}
      title={gt("Activity")}
      aside={
        grid.totalTokens > 0
          ? gt("{tokens} tokens", { tokens: formatTokens(grid.totalTokens) })
          : null
      }
    >
      {loading ? (
        <Skeleton className="h-36 w-full" />
      ) : (
        <div className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-3xs text-muted-foreground">
          <span />
          <div className="relative h-4">
            {grid.months.map((month) => (
              <span
                key={`${month.column}:${month.label}`}
                className="absolute"
                style={{ left: `${(month.column / grid.weeks.length) * 100}%` }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div className="grid grid-rows-7 gap-0.75">
            {["", "Mon", "", "Wed", "", "Fri", ""].map((label, row) => (
              // oxlint-disable-next-line react/no-array-index-key -- weekday rows are positional
              <span key={row} className="flex items-center leading-none">
                {label}
              </span>
            ))}
          </div>
          <div
            className="grid grid-flow-col grid-rows-7 gap-0.75"
            style={{ gridTemplateColumns: `repeat(${grid.weeks.length}, minmax(0, 1fr))` }}
          >
            {grid.weeks.flatMap((week, column) =>
              week.map((cell, row) =>
                cell ? (
                  <UiTooltip key={cell.day}>
                    <TooltipTrigger
                      render={
                        <span
                          role="img"
                          aria-label={describe(cell)}
                          data-activity-level={cell.level}
                          className="aspect-square rounded-xs"
                        />
                      }
                    />
                    <TooltipPopup side="top">{describe(cell)}</TooltipPopup>
                  </UiTooltip>
                ) : (
                  // oxlint-disable-next-line react/no-array-index-key -- future days are positional
                  <span key={`future:${column}:${row}`} className="aspect-square" />
                ),
              ),
            )}
          </div>
        </div>
      )}
    </DashboardCard>
  );
}

function UsageCard({
  month,
  loading,
  className,
}: {
  readonly month: MonthUsage;
  readonly loading: boolean;
  readonly className?: string | undefined;
}) {
  const gt = useGT();
  const top =
    month.peakTokens > 0 ? scaleLinear().domain([0, month.peakTokens]).nice().domain()[1]! : 0;
  const config = Object.fromEntries(
    month.providers.map((provider) => [
      provider,
      { label: providerLabel(provider), color: SERIES_COLOR[provider] },
    ]),
  );
  const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const labelOf = (day: string) => dayLabel.format(dayStart(day));
  const data = month.rows.map((row) => ({ ...row, label: labelOf(String(row.day)) }));
  const monthTokens = [...month.totals.values()].reduce((sum, tokens) => sum + tokens, 0);
  const tickIndexes = [...new Set([0, Math.min(7, month.days.length - 1), month.days.length - 1])];

  return (
    <DashboardCard
      icon={<ChartLineIcon />}
      title={gt("Usage", { $context: "token usage chart title" })}
      className={className}
      aside={
        monthTokens > 0 ? gt("{tokens} this month", { tokens: formatTokens(monthTokens) }) : null
      }
    >
      {loading ? (
        <Skeleton className="h-36 w-full" />
      ) : month.providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No usage this month.</T>
        </p>
      ) : (
        <div className="flex flex-1 flex-col gap-2">
          <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(6rem,1fr)_auto] gap-x-2 text-3xs text-muted-foreground tabular-nums">
            <div className="flex flex-col justify-between text-right">
              <span className="-translate-y-1/2">{formatTokens(top)}</span>
              <span className="translate-y-1/2">0</span>
            </div>
            <div className="relative border-b border-white/15">
              <AreaChart
                data={data}
                config={config}
                margins={{ top: 0, right: 0, bottom: 0, left: 0 }}
                bloom="low"
                className="absolute inset-0"
              >
                <Tooltip
                  labelKey="label"
                  variant="frosted-glass"
                  valueFormatter={(value) => gt("{tokens} tokens", { tokens: formatTokens(value) })}
                />
                {month.providers.map((provider) => (
                  <Area
                    key={provider}
                    dataKey={provider}
                    variant={provider === "codex" ? "dotted" : "gradient"}
                  />
                ))}
              </AreaChart>
            </div>
            <span />
            <div className="relative h-3 uppercase">
              {tickIndexes.map((index) => (
                <span
                  key={index}
                  className={cn(
                    "absolute",
                    index === 0
                      ? "left-0"
                      : index === month.days.length - 1
                        ? "right-0"
                        : "-translate-x-1/2",
                  )}
                  style={
                    index === 0 || index === month.days.length - 1
                      ? undefined
                      : { left: `${(index / (month.days.length - 1)) * 100}%` }
                  }
                >
                  {labelOf(month.days[index]!)}
                </span>
              ))}
            </div>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {month.providers.map((provider) => (
              <li key={provider} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 rounded-xs"
                  style={{ backgroundColor: PROVIDER_PRESENTATION[provider].color }}
                />
                <span className="text-foreground/85">{providerLabel(provider)}</span>
                <span className="tabular-nums">
                  {formatTokens(month.totals.get(provider) ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashboardCard>
  );
}

/** Subscription pools, then activity and month-to-date usage, under the new thread composer. */
export function HomeDashboard() {
  const [now] = useState(() => Date.now());
  const [window] = useState(() => makeWindow(ACTIVITY_WEEKS * 7, new Date(now), "day"));
  const { merged, isPending } = useUsage(window);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const formatMoment = useMomentFormat();

  const refreshLimits = useEffectEvent(() => {
    for (const [environmentId, presentation] of presentations) {
      if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
        continue;
      }
      void refreshUsageLimits(
        environmentId,
        () => refreshProviders({ environmentId, input: {} }),
        true,
      ).catch(() => undefined);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks connected providers for fresh limits when the dashboard opens; refreshUsageLimits throttles repeats
  useEffect(() => refreshLimits(), []);

  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const today = localDay(now);
  const loading = isPending && merged.daily.length === 0;

  return (
    // Pools on top, history below, three a row once the dashboard is wide enough.
    <div className="@container">
      <div data-home-dashboard className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @2xl:grid-cols-3">
        {POOLS.map((entry) => (
          <PoolCard
            key={entry.driver}
            label={entry.label}
            quota={entry.quota}
            pool={pools.find((pool) => pool.driver === (entry.driver as ServerProvider["driver"]))}
            daily={merged.daily}
            provider={entry.provider}
            now={now}
            color={SERIES_COLOR[entry.provider]}
            formatMoment={formatMoment}
          />
        ))}
        <ActivityCard
          grid={buildActivityGrid(
            merged.daily.map((entry) => ({ day: entry.day, tokens: entry.totalTokens })),
            today,
            ACTIVITY_WEEKS,
          )}
          loading={loading}
        />
        <UsageCard
          month={buildMonthUsage(merged.daily, today)}
          loading={loading}
          className="@lg:col-span-2"
        />
      </div>
    </div>
  );
}
