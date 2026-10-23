'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-sections';
import { scrollEdges } from './rail-scroll';

// Width at/above which the rail is a vertical column (already in view, so
// no auto-scroll needed). Mirrors the Tailwind `lg:` breakpoint that
// drives the row→column switch in the markup below — keep the two in sync.
const RAIL_DESKTOP_MIN_PX = 1024;

/**
 * The settings left rail — grouped, vertical on desktop and a
 * horizontal row of chips on narrow screens. On the row, a soft fade
 * appears on whichever side still has sections hidden, so it is obvious
 * the row scrolls (a chip cut mid-word with no hint read as broken).
 * The active chip auto-scrolls into view so a deep-linked section is
 * never off-screen. Chips are 44px tall on touch screens.
 */
export function SettingsRail({
  active,
  onSelect,
  hints,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
}) {
  const t = useTranslations('Settings');
  const activeRef = useRef<HTMLButtonElement>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ moreStart: false, moreEnd: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((prev) =>
      prev.moreStart === next.moreStart && prev.moreEnd === next.moreEnd
        ? prev
        : next,
    );
  }, []);

  // Re-measure when the row resizes (rotation, sidebar, font load).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // When horizontal (mobile), keep the active chip in view. On desktop
  // the rail is a static column, so skip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia(`(min-width: ${RAIL_DESKTOP_MIN_PX}px)`).matches) return;
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [active]);

  return (
    <div className="relative min-w-0 border-b border-border lg:sticky lg:top-0 lg:border-b-0">
      <nav
        ref={scrollerRef}
        onScroll={measure}
        aria-label={t('sectionsNav')}
        className={cn(
          'flex gap-1.5 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          'lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0',
        )}
      >
        {RAIL_GROUPS.map(({ group }) => {
          const items = SETTINGS_SECTIONS.filter(
            (s) => SECTION_META[s].group === group,
          );
          const showLabel = group !== 'top';
          return (
            <div
              key={group}
              role="group"
              aria-label={showLabel ? t(`groups.${group}`) : undefined}
              className="flex shrink-0 gap-1.5 lg:flex-col lg:gap-0.5"
            >
              {showLabel ? (
                <div
                  aria-hidden
                  className="hidden px-3 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block"
                >
                  {t(`groups.${group}`)}
                </div>
              ) : null}
              {items.map((s) => {
                const meta = SECTION_META[s];
                const Icon = meta.icon;
                const isActive = s === active;
                return (
                  <button
                    key={s}
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    onClick={() => onSelect(s)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                      'pointer-coarse:min-h-11 lg:w-full',
                      // Mobile chips carry a hairline so each reads as a
                      // separate, tappable item; the desktop column doesn't.
                      'border lg:border-transparent',
                      isActive
                        ? 'border-primary-soft-2 bg-primary-soft text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1">{t(`sections.${s}`)}</span>
                    {hints?.[s] != null ? (
                      <span
                        className={cn(
                          'hidden items-center gap-1.5 text-xs lg:inline-flex',
                          isActive ? 'text-primary' : 'text-muted-foreground',
                        )}
                      >
                        {hints[s]}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Scroll hints (mobile row only). Decorative: the chips stay
          reachable by swipe, keyboard Tab and the auto-scroll above. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-linear-to-r from-background to-transparent transition-opacity duration-150 lg:hidden',
          edges.moreStart ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-background to-transparent transition-opacity duration-150 lg:hidden',
          edges.moreEnd ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}
