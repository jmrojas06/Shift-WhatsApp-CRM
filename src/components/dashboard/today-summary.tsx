"use client"

import { useLocale, useTranslations } from 'next-intl'

import type { MetricsBundle, ResponseTimeSummary } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

interface TodaySummaryProps {
  metrics: MetricsBundle | null
  metricsLoading: boolean
  responseTime: ResponseTimeSummary | null
  /** Response-time goal in minutes, shared with the response chart. */
  targetMinutes: number
}

/** "1 s", "4,5 min", "2,1 h" — short, unit-labelled durations. */
export function formatMinutes(mins: number, locale: string): string {
  const num = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 })
  // Under 10 s keep a decimal so nearby chart ticks don't repeat ("1 s, 1 s").
  if (mins * 60 < 10) return `${num(Math.max(0.1, mins * 60))} s`
  if (mins < 1) return `${Math.round(mins * 60)} s`
  if (mins < 60) return `${num(mins)} min`
  return `${num(mins / 60)} h`
}

/**
 * "Resumen de hoy" — four quiet numbers in one strip (one card, hairline
 * dividers) instead of four shouting cards. Deltas are words, not
 * arrows, and only color when they mean something.
 */
export function TodaySummary({ metrics, metricsLoading, responseTime, targetMinutes }: TodaySummaryProps) {
  const t = useTranslations('Dashboard.summary')
  const locale = useLocale()

  const delta = (current: number, previous: number) => {
    const diff = current - previous
    if (diff === 0) return { text: t('sameAsYesterday'), tone: 'muted' as const }
    return diff > 0
      ? { text: t('moreThanYesterday', { count: diff }), tone: 'good' as const }
      : { text: t('lessThanYesterday', { count: -diff }), tone: 'muted' as const }
  }

  const weekAvg = responseTime?.thisWeekAvg ?? null

  const stats =
    metrics && !metricsLoading
      ? [
          {
            label: t('activeConversations'),
            value: metrics.activeConversations.current.toLocaleString(locale),
            note: { text: t('openNow'), tone: 'muted' as const },
          },
          {
            label: t('newContacts'),
            value: metrics.newContactsToday.current.toLocaleString(locale),
            note: delta(metrics.newContactsToday.current, metrics.newContactsToday.previous),
          },
          {
            label: t('messagesSent'),
            value: metrics.messagesSentToday.current.toLocaleString(locale),
            note: delta(metrics.messagesSentToday.current, metrics.messagesSentToday.previous),
          },
          {
            label: t('firstResponse'),
            value: weekAvg == null ? '—' : formatMinutes(weekAvg, locale),
            note:
              weekAvg == null
                ? { text: t('noDataYet'), tone: 'muted' as const }
                : weekAvg <= targetMinutes
                  ? { text: t('withinTarget', { minutes: targetMinutes }), tone: 'good' as const }
                  : { text: t('aboveTarget', { minutes: targetMinutes }), tone: 'warn' as const },
          },
        ]
      : null

  return (
    <section aria-labelledby="summary-title" className="space-y-3">
      <h2 id="summary-title" className="text-[15px] font-semibold text-foreground">
        {t('title')}
      </h2>
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card shadow-(--shadow-card) lg:grid-cols-4">
        {(stats ?? Array.from({ length: 4 }, () => null)).map((stat, i) => (
          <div
            key={i}
            className={cn(
              'flex flex-col gap-1 p-4 sm:px-5',
              // Hairlines between cells: left edge for every column but the
              // first, top edge for the second row on the 2-column phone grid.
              i % 2 === 1 && 'border-l border-border',
              i >= 2 && 'border-t border-border lg:border-t-0',
              i === 2 && 'lg:border-l',
            )}
          >
            {stat ? (
              <>
                <span className="text-[13px] text-muted-foreground">{stat.label}</span>
                <span className="font-heading text-2xl font-semibold tracking-tight text-foreground tabular-nums">
                  {stat.value}
                </span>
                <span
                  className={cn(
                    'text-xs',
                    stat.note.tone === 'good' && 'text-success',
                    stat.note.tone === 'warn' && 'text-warning',
                    stat.note.tone === 'muted' && 'text-muted-foreground',
                  )}
                >
                  {stat.note.text}
                </span>
              </>
            ) : (
              <>
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-7 w-12" />
                <Skeleton className="h-3 w-20" />
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
