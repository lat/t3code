import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatTokens, makeWindow } from "@t3tools/shared/usageFormat";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { scaleLinear } from "d3-scale";
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
import type { DitherColor } from "../dither-kit/palette";
import { Tooltip } from "../dither-kit/tooltip";
import { Skeleton } from "../ui/skeleton";
import { Tooltip as UiTooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import {
  type ActivityGrid,
  buildActivityGrid,
  buildMonthUsage,
  type DayTokens,
  dayStart,
  forecastPool,
  formatCompactUsd,
  formatPoolPercent,
  localDay,
  type MonthUsage,
  type PoolForecast,
  poolForecastMembers,
  primaryPoolWindow,
} from "./homeDashboard.logic";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ACTIVITY_WEEKS = 20;
const POOL_HISTORY_MS = 3 * DAY_MS;
const POOL_FORECAST_MS = 3 * DAY_MS;

const POOLS = [
  { driver: "codex", provider: "codex", label: "Codex" },
  { driver: "claudeAgent", provider: "claude", label: "Claude" },
] as const satisfies readonly {
  driver: string;
  provider: UsageProviderKind;
  label: string;
}[];

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
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-home-dashboard-card
      className="flex min-w-0 flex-col gap-3 rounded-xl border p-4 backdrop-blur-md"
    >
      <header className="flex min-w-0 items-center justify-between gap-3 text-sm">
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

function PoolChart({
  forecast,
  from,
  to,
  now,
  formatMoment,
}: {
  readonly forecast: PoolForecast;
  readonly from: number;
  readonly to: number;
  readonly now: number;
  readonly formatMoment: (at: number) => string;
}) {
  const span = to - from;
  const at = (time: number) => `${((time - from) / span) * 100}%`;
  const data = forecast.points.map((point) => ({
    label: formatMoment(point.at),
    remaining: Math.round(point.remaining),
  }));
  const days: { at: number; label: string }[] = [];
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  for (let day = localDay(from); dayStart(day) < to;) {
    const noon = dayStart(day) + 12 * HOUR_MS;
    if (noon > from && noon < to) days.push({ at: noon, label: weekday.format(noon) });
    const next = new Date(dayStart(day));
    next.setDate(next.getDate() + 1);
    day = localDay(next.getTime());
  }
  const band = forecast.emptyBand;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-24">
        <span
          className="pointer-events-none absolute -top-4 -translate-x-1/2 text-3xs tracking-wider text-muted-foreground uppercase"
          style={{ left: at(now) }}
        >
          Now
        </span>
        <AreaChart
          data={data}
          config={{ remaining: { label: "Left", color: "indigo" } }}
          margins={{ top: 4, right: 0, bottom: 0, left: 0 }}
          className="absolute inset-0"
        >
          <Tooltip
            labelKey="label"
            variant="frosted-glass"
            valueFormatter={(value) => formatPoolPercent(value)}
          />
          <Area dataKey="remaining" variant="dotted" />
        </AreaChart>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/35"
          style={{ left: at(now) }}
        />
        {band ? (
          <div
            aria-hidden
            data-pool-empty-band
            className="pointer-events-none absolute inset-y-0"
            style={{ left: at(band.from), width: `${((band.to - band.from) / span) * 100}%` }}
          >
            <span
              data-pool-refill-label
              className="absolute top-1 right-0 translate-x-1/2 rounded-sm px-1 text-3xs tabular-nums"
            >
              +{formatPoolPercent(band.percent)}
            </span>
          </div>
        ) : null}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-foreground/45"
          style={{ left: at(now) }}
        />
      </div>
      <div className="relative h-3 text-3xs tracking-wider text-muted-foreground uppercase">
        {days.map((day) => (
          <span key={day.at} className="absolute -translate-x-1/2" style={{ left: at(day.at) }}>
            {day.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function PoolCard({
  label,
  pool,
  usage,
  now,
  formatMoment,
}: {
  readonly label: string;
  readonly pool: ReturnType<typeof collectLimitPools>[number] | undefined;
  readonly usage: readonly DayTokens[];
  readonly now: number;
  readonly formatMoment: (at: number) => string;
}) {
  const window = pool ? primaryPoolWindow(pool) : null;
  const from = now - POOL_HISTORY_MS;
  const to = now + POOL_FORECAST_MS;
  const forecast = window
    ? forecastPool({ members: poolForecastMembers(window), usage, now, from, to })
    : null;
  return (
    <DashboardCard
      icon={<GaugeIcon />}
      title={`${label} pool`}
      aside={
        forecast?.runsOutAt ? (
          <span className="text-warning">Runs out {formatMoment(forecast.runsOutAt)}</span>
        ) : null
      }
    >
      {forecast ? (
        <>
          <div className="flex min-w-0 items-baseline justify-between gap-3">
            <p className="min-w-0 truncate">
              <span className="text-2xl font-medium text-foreground tabular-nums">
                {formatPoolPercent(forecast.remainingPercent)}
              </span>{" "}
              <span className="text-sm text-muted-foreground">
                left of {formatPoolPercent(forecast.capacityPercent)}
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
          <div className="pt-3">
            <PoolChart
              forecast={forecast}
              from={from}
              to={to}
              now={now}
              formatMoment={formatMoment}
            />
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No limits reported.</p>
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
  return (
    <DashboardCard
      icon={<CalendarIcon />}
      title="Activity"
      aside={grid.totalTokens > 0 ? `${formatTokens(grid.totalTokens)} tokens` : null}
    >
      {loading ? (
        <Skeleton className="h-36 w-full" />
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-3xs text-muted-foreground">
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
                          aria-label={`${labelOfDay(cell.day)}: ${formatTokens(cell.tokens)} tokens`}
                          data-activity-level={cell.level}
                          className="aspect-square rounded-xs"
                        />
                      }
                    />
                    <TooltipPopup side="top">
                      {labelOfDay(cell.day)}: {formatTokens(cell.tokens)} tokens
                    </TooltipPopup>
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

function UsageCard({ month, loading }: { readonly month: MonthUsage; readonly loading: boolean }) {
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
  const tickIndexes = [...new Set([0, Math.min(7, month.days.length - 1), month.days.length - 1])];

  return (
    <DashboardCard
      icon={<ChartLineIcon />}
      title="Usage"
      aside={month.costUsd > 0 ? `${formatCompactUsd(month.costUsd)} this month` : null}
    >
      {loading ? (
        <Skeleton className="h-36 w-full" />
      ) : month.providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No usage this month.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-3xs text-muted-foreground tabular-nums">
            <div className="flex h-24 flex-col justify-between text-right">
              <span className="-translate-y-1/2">{formatTokens(top)}</span>
              <span className="translate-y-1/2">0</span>
            </div>
            <div className="relative h-24 border-b border-white/15">
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
                  valueFormatter={(value) => `${formatTokens(value)} tokens`}
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

/** Subscription pools, activity, and month-to-date usage under the new thread composer. */
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
  const tokensOf = (provider: UsageProviderKind): readonly DayTokens[] =>
    merged.daily.map((entry) => ({
      day: entry.day,
      tokens: entry.byProvider.get(provider)?.totalTokens ?? 0,
    }));
  const loading = isPending && merged.daily.length === 0;

  return (
    <div data-home-dashboard className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {POOLS.map(({ driver, provider, label }) => (
        <PoolCard
          key={driver}
          label={label}
          pool={pools.find((pool) => pool.driver === (driver as ServerProvider["driver"]))}
          usage={tokensOf(provider)}
          now={now}
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
      <UsageCard month={buildMonthUsage(merged.daily, today)} loading={loading} />
    </div>
  );
}
