"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  MessageSquare,
  UserPlus,
  Columns3,
  Megaphone,
  Zap,
  Inbox,
  TriangleAlert,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { groupActivity } from '@/lib/dashboard/group-activity'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

interface KindTheme {
  icon: ComponentType<{ className?: string }>
}

const KIND_THEME: Record<ActivityKind, KindTheme> = {
  message: { icon: MessageSquare },
  contact: { icon: UserPlus },
  deal: { icon: Columns3 },
  broadcast: { icon: Megaphone },
  automation: { icon: Zap },
}

import { useLocale, useTranslations } from 'next-intl'

export function ActivityFeed({ items, loading }: ActivityFeedProps) {
  const t = useTranslations('Dashboard.activityFeed')
  const tEmpty = useTranslations('Dashboard.emptyState')
  const locale = useLocale()
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)

  // Back-to-back identical events (one chatty customer) fold into one row.
  const groups = items ? groupActivity(items) : []
  const totalLoaded = groups.length
  const visible = groups.slice(0, pageSize)
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card shadow-(--shadow-card)">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
        <Link
          href="/inbox"
          // Negative margin + padding grows the tap target (≥44px on touch)
          // without making the header taller.
          className="-my-2 -mr-2 inline-flex min-h-9 items-center rounded-md px-2 text-xs font-medium text-primary hover:text-primary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
        >
          {t('viewAll')}
        </Link>
      </header>

      {loading ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !items ? (
        <div className="p-5">
          <EmptyState
            icon={TriangleAlert}
            title={tEmpty('loadError')}
            hint={tEmpty('loadErrorHint')}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Inbox}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {visible.map(({ item: it, count }) => {
              const Icon = KIND_THEME[it.kind].icon
              const row = (
                <div className="flex min-h-12 items-center gap-3 px-5 py-2.5">
                  <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={it.text}>
                    {it.text}
                    {count > 1 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('repeated', { count })}
                      </span>
                    )}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                    {relativeTime(it.at, t, locale)}
                  </span>
                </div>
              )
              return (
                <li key={it.id} className="transition-colors hover:bg-muted/50">
                  {it.href ? (
                    <Link href={it.href} className="block">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>
          <footer className="mt-auto flex items-center justify-between border-t border-border px-5 py-3 text-xs">
            <span className="text-muted-foreground tabular-nums">
              {t('showingOf', { visible: visible.length, totalLoaded, plus: (items?.length ?? 0) === 50 ? '+' : '' })}
            </span>
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground">{t('show')}</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    aria-pressed={pageSize === size}
                    className={cn(
                      'min-h-8 min-w-8 rounded-md px-2 py-1 font-medium tabular-nums transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11',
                      pageSize === size
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                    )}
                  >
                    {size}
                  </button>
                )
              })}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

function relativeTime(
  iso: string,
  t: ReturnType<typeof useTranslations>,
  locale: string,
): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('timeS', { sec: Math.max(1, diffSec) })
  if (diffSec < 3600) return t('timeM', { min: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('timeH', { hr: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('timeD', { day: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString(locale)
}
