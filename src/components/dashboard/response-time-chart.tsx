"use client"

import { Clock, TriangleAlert } from 'lucide-react'
import { DOW_SHORT_MON_FIRST } from '@/lib/dashboard/date-utils'
import type { ResponseTimeSummary } from '@/lib/dashboard/types'
import { BarChart } from '@/components/tremor/bar-chart'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null
  loading: boolean
  /** Minutes. Surfaced as a "target" pill in the header. The
   *  hand-rolled SVG version drew this as a horizontal dashed
   *  line on the chart; Tremor BarChart doesn't expose Recharts
   *  primitives, so we promote it to the header for now. A
   *  follow-up can introduce an overlay or extend the vendored
   *  BarChart with a `referenceLines` prop. */
  thresholdMinutes?: number
}

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { formatMinutes } from './today-summary'

// Single category, single colour — the data is "average minutes
// per weekday". Tremor expects categories as the second tuple in
// the row object, so we shape the buckets into
// `{ day: 'Mon', 'Avg minutes': 4.2 }` rows below. The category name
// doubles as the tooltip label, so it comes from the catalogue.

export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
}: ResponseTimeChartProps) {
  const t = useTranslations('Dashboard.responseTimeChart')
  const tEmpty = useTranslations('Dashboard.emptyState')
  const format = useFormatter()
  const locale = useLocale()
  const category = t('avgMinutes')
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      // 2024-01-01 was a Monday — format Monday-first weekdays in the
      // UI locale (en: "Mon", pt: "seg.", …).
      day:
        format.dateTime(new Date(Date.UTC(2024, 0, 1 + i)), {
          weekday: 'short',
          timeZone: 'UTC',
        }) || DOW_SHORT_MON_FIRST[i],
      [category]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? []

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card shadow-(--shadow-card)">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1 basis-60">
          <h2 className="text-sm font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs whitespace-nowrap">
          {thresholdMinutes > 0 && (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground tabular-nums">
              {t('target', { minutes: thresholdMinutes })}
            </span>
          )}
          {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
            <div>
              <div className="text-muted-foreground">
                {t('thisWeek')}{' '}
                <span className="font-medium text-foreground tabular-nums">
                  {fmt(data.thisWeekAvg, locale)}
                </span>
              </div>
              <div className="text-muted-foreground">
                {t('lastWeek')}{' '}
                <span className="tabular-nums">{fmt(data.lastWeekAvg, locale)}</span>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 p-5">
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !data ? (
          <EmptyState
            icon={TriangleAlert}
            title={tEmpty('loadError')}
            hint={tEmpty('loadErrorHint')}
          />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title={t('noReplies')}
            hint={t('noRepliesHint')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[category]}
            // `series1` is the validated aqua of the chart palette (--series-1).
            colors={['series1']}
            valueFormatter={(value) => formatMinutes(value, locale)}
            showLegend={false}
            yAxisWidth={48}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px]"
          />
        )}
      </div>
    </section>
  )
}

function fmt(mins: number | null, locale: string): string {
  if (mins == null) return '—'
  return formatMinutes(mins, locale)
}
