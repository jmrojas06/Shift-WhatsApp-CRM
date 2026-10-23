"use client"

import Link from 'next/link'
import type { ReactNode } from 'react'
import { AlertTriangle, ArrowRight, CalendarDays, MessageSquare, Wallet } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import type {
  TodayAppointments,
  UnreadSummary,
  WhatsAppHealth,
} from '@/lib/dashboard/attention'
import { AGENDA_TZ } from '@/verticals/agenda/agent/time'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

/** `undefined` = still loading, `null` = failed to load. */
type Loadable<T> = T | null | undefined

export interface SalesAttention {
  /** Pre-formatted unpaid amount, e.g. "$150.000". */
  pendingToCollect: string
  /** Pre-formatted paid this month. */
  soldThisMonth: string
}

interface AttentionSectionProps {
  unread: Loadable<UnreadSummary>
  whatsapp: Loadable<WhatsAppHealth>
  /** Whether the account has the Agenda module (otherwise no card). */
  agendaEnabled: boolean
  appointments: Loadable<TodayAppointments>
  /** Whether the account has the Ventas module (otherwise no card). */
  salesEnabled: boolean
  sales: Loadable<SalesAttention>
}

/**
 * "Para atender" — the first thing on the dashboard: what needs a reply,
 * who is coming in today and what is still to collect, each with the one
 * action that resolves it. Cards for modules the account doesn't have
 * are simply not rendered.
 */
export function AttentionSection({
  unread,
  whatsapp,
  agendaEnabled,
  appointments,
  salesEnabled,
  sales,
}: AttentionSectionProps) {
  const t = useTranslations('Dashboard.attention')
  const showWhatsApp = whatsapp === 'needs_attention' || whatsapp === 'not_configured'

  return (
    <section aria-labelledby="attention-title" className="space-y-3">
      <h2 id="attention-title" className="text-[15px] font-semibold text-foreground">
        {t('title')}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {showWhatsApp && <WhatsAppCard health={whatsapp} />}
        <UnreadCard unread={unread} />
        {agendaEnabled && <AppointmentsCard data={appointments} />}
        {salesEnabled && <SalesCard data={sales} />}
      </div>
    </section>
  )
}

function Card({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: 'default' | 'warning'
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 sm:min-h-40 sm:p-5',
        tone === 'warning'
          ? 'border-warning/30 bg-warning/5'
          : 'border-border bg-card shadow-(--shadow-card)',
      )}
    >
      {children}
    </div>
  )
}

function CardLabel({ icon: Icon, children }: { icon: typeof MessageSquare; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Icon className="size-4" aria-hidden />
      {children}
    </span>
  )
}

function BigNumber({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <span
      className={cn(
        'font-heading leading-none font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere]',
        // Several currencies ("$1.200.000 COP + US$300 USD") would overflow the card at full size.
        compact ? 'text-2xl' : 'text-[32px]',
      )}
    >
      {children}
    </span>
  )
}

function CardError() {
  const t = useTranslations('Dashboard.attention')
  return <p className="text-sm text-muted-foreground">{t('loadError')}</p>
}

function CardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-9 w-28" />
    </div>
  )
}

function UnreadCard({ unread }: { unread: Loadable<UnreadSummary> }) {
  const t = useTranslations('Dashboard.attention')
  const format = useFormatter()
  return (
    <Card>
      <CardLabel icon={MessageSquare}>{t('unreadTitle')}</CardLabel>
      {unread === undefined ? (
        <CardSkeleton />
      ) : unread === null ? (
        <CardError />
      ) : unread.count === 0 ? (
        <>
          <BigNumber>0</BigNumber>
          <p className="text-sm text-muted-foreground">{t('noUnread')}</p>
          <Link href="/inbox" className={cn(buttonVariants({ variant: 'outline' }), 'mt-auto self-start')}>
            {t('openInbox')}
          </Link>
        </>
      ) : (
        <>
          <span className="flex items-baseline gap-3">
            <BigNumber>{unread.count}</BigNumber>
            {unread.latest && (
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {unread.latest.who ?? t('unknownContact')}
                {unread.latest.at ? `, ${format.relativeTime(new Date(unread.latest.at))}` : ''}
              </span>
            )}
          </span>
          <Link
            href={unread.latest ? `/inbox?c=${unread.latest.conversationId}` : '/inbox'}
            className={cn(buttonVariants(), 'mt-auto self-start')}
          >
            {t('reply')}
            <ArrowRight data-icon="inline-end" />
          </Link>
        </>
      )}
    </Card>
  )
}

function WhatsAppCard({ health }: { health: WhatsAppHealth }) {
  const t = useTranslations('Dashboard.attention')
  const needsReconnect = health === 'needs_attention'
  return (
    <Card tone="warning">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-warning">
        <AlertTriangle className="size-4" aria-hidden />
        {needsReconnect ? t('whatsappReconnectTitle') : t('whatsappSetupTitle')}
      </span>
      <p className="text-sm text-muted-foreground">
        {needsReconnect ? t('whatsappReconnectBody') : t('whatsappSetupBody')}
      </p>
      <Link
        href="/settings?tab=whatsapp"
        className={cn(buttonVariants({ variant: 'outline' }), 'mt-auto self-start')}
      >
        {needsReconnect ? t('reconnect') : t('connect')}
      </Link>
    </Card>
  )
}

function AppointmentsCard({ data }: { data: Loadable<TodayAppointments> }) {
  const t = useTranslations('Dashboard.attention')
  const format = useFormatter()
  return (
    <Card>
      <CardLabel icon={CalendarDays}>{t('appointmentsTitle')}</CardLabel>
      {data === undefined ? (
        <CardSkeleton />
      ) : data === null ? (
        <CardError />
      ) : (
        <>
          <BigNumber>{data.total}</BigNumber>
          {data.upcoming.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {data.upcoming.map((a) => (
                <li key={a.id} className="flex gap-2">
                  {/* "10:30 a. m." is wider than 3.5rem and never wraps, so it needs a real minimum width. */}
                  <span className="min-w-[4.75rem] shrink-0 font-medium whitespace-nowrap text-foreground tabular-nums">
                    {format.dateTime(new Date(a.startsAt), {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone: AGENDA_TZ,
                    })}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {[a.contact, a.service].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {data.total > 0 ? t('noMoreAppointments') : t('noAppointments')}
            </p>
          )}
          <Link href="/agenda" className={cn(buttonVariants({ variant: 'outline' }), 'mt-auto self-start')}>
            {t('viewAgenda')}
          </Link>
        </>
      )}
    </Card>
  )
}

function SalesCard({ data }: { data: Loadable<SalesAttention> }) {
  const t = useTranslations('Dashboard.attention')
  return (
    <Card>
      <CardLabel icon={Wallet}>{t('salesTitle')}</CardLabel>
      {data === undefined ? (
        <CardSkeleton />
      ) : data === null ? (
        <CardError />
      ) : (
        <>
          <BigNumber compact={data.pendingToCollect.length > 12}>{data.pendingToCollect}</BigNumber>
          <p className="text-sm text-muted-foreground">
            {t('soldThisMonth', { amount: data.soldThisMonth })}
          </p>
          <Link href="/ventas" className={cn(buttonVariants({ variant: 'outline' }), 'mt-auto self-start')}>
            {t('viewSales')}
          </Link>
        </>
      )}
    </Card>
  )
}
