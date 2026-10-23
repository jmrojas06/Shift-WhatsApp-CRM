"use client"

import { useCallback, useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { hasModule } from '@/lib/verticals/registry'
import { fetchSummaryRows } from '@/modules/ventas/queries'
import { formatAmounts, salesSummary } from '@/modules/ventas/panel'
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import {
  loadTodayAppointments,
  loadUnreadSummary,
  loadWhatsAppHealth,
  type TodayAppointments,
  type UnreadSummary,
  type WhatsAppHealth,
} from '@/lib/dashboard/attention'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { AttentionSection, type SalesAttention } from '@/components/dashboard/attention-section'
import { TodaySummary } from '@/components/dashboard/today-summary'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

type RangeDays = 7 | 30 | 90

/** First-response goal (minutes) shown in the summary and the chart. */
const RESPONSE_TARGET_MINUTES = 5

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const format = useFormatter()
  const { profile, account, accountId, defaultCurrency } = useAuth()
  const agendaEnabled = hasModule(account, 'agenda')
  const salesEnabled = hasModule(account, 'ventas')

  // `undefined` = loading, `null` = failed (each card shows its own state).
  const [unread, setUnread] = useState<UnreadSummary | null | undefined>(undefined)
  const [whatsapp, setWhatsapp] = useState<WhatsAppHealth | undefined>(undefined)
  const [appointments, setAppointments] = useState<TodayAppointments | null | undefined>(undefined)
  const [sales, setSales] = useState<SalesAttention | null | undefined>(undefined)

  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)

  const loadAll = useCallback(() => {
    const db = createClient()

    // Kick everything off in parallel. Each block has its own
    // setState + finally so a slow query doesn't hold up faster
    // sections — each widget shows its own skeleton independently.
    void loadUnreadSummary(db)
      .then(setUnread)
      .catch((err) => {
        console.error('[dashboard] unread failed:', err)
        setUnread(null)
      })

    void loadWhatsAppHealth().then(setWhatsapp)

    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => console.error('[dashboard] metrics failed:', err))
      .finally(() => setMetricsLoading(false))

    void loadConversationsSeries(db, 30)
      .then((s) => setSeries((prev) => ({ ...prev, 30: s })))
      .catch((err) => console.error('[dashboard] series failed:', err))
      .finally(() => setSeriesLoading(false))

    void loadPipelineDonut(db)
      .then((p) => setPipeline(p))
      .catch((err) => console.error('[dashboard] pipeline failed:', err))
      .finally(() => setPipelineLoading(false))

    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => console.error('[dashboard] response time failed:', err))
      .finally(() => setResponseTimeLoading(false))

    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Module cards wait for the account (they need its id and modules).
  useEffect(() => {
    if (!accountId) return
    const db = createClient()
    const now = new Date()
    if (agendaEnabled) {
      void loadTodayAppointments(db, accountId, now)
        .then(setAppointments)
        .catch((err) => {
          console.error('[dashboard] appointments failed:', err)
          setAppointments(null)
        })
    }
    if (salesEnabled) {
      void fetchSummaryRows(db, accountId, now).then(({ rows, error }) => {
        if (error || !rows) {
          setSales(null)
          return
        }
        const summary = salesSummary(rows, now, defaultCurrency)
        setSales({
          pendingToCollect: formatAmounts(summary.pendingToCollect, defaultCurrency),
          soldThisMonth: formatAmounts(summary.soldThisMonth, defaultCurrency),
        })
      })
    }
  }, [accountId, agendaEnabled, salesEnabled, defaultCurrency])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      setSeriesLoading(true)
      const db = createClient()
      loadConversationsSeries(db, r)
        .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
        .catch((err) => console.error('[dashboard] series failed:', err))
        .finally(() => setSeriesLoading(false))
    },
    [series],
  )

  const firstName = profile?.full_name?.trim().split(/\s+/)[0]
  const today = format.dateTime(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <div>
        <h1 className="text-[28px] leading-tight font-semibold text-foreground">
          {firstName ? t('greeting', { name: firstName }) : t('greetingNoName')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle', { date: today.charAt(0).toUpperCase() + today.slice(1) })}
        </p>
      </div>

      <AttentionSection
        unread={unread}
        whatsapp={whatsapp}
        agendaEnabled={agendaEnabled}
        appointments={appointments}
        salesEnabled={salesEnabled}
        sales={sales}
      />

      <TodaySummary
        metrics={metrics}
        metricsLoading={metricsLoading}
        responseTime={responseTime}
        targetMinutes={RESPONSE_TARGET_MINUTES}
      />

      {/* items-stretch (the grid default) plus h-full on each wrapper
          lines the paired cards' borders up at the taller one's height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full min-w-0 lg:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full min-w-0 lg:col-span-2">
          <ActivityFeed items={activity} loading={activityLoading} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full min-w-0 lg:col-span-3">
          <ResponseTimeChart
            data={responseTime}
            loading={responseTimeLoading}
            thresholdMinutes={RESPONSE_TARGET_MINUTES}
          />
        </div>
        <div className="h-full min-w-0 lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            currency={defaultCurrency}
          />
        </div>
      </div>
    </div>
  )
}
