import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Small status / role pill used across the settings redesign
 * (Overview tiles, WhatsApp banner, the "Active" appearance markers).
 *
 * Every variant is token-driven: the text uses the state token itself
 * (`--success`, `--warning`, `--destructive`, `--primary`), which the
 * theme defines with AA contrast in both modes, over the same hue at a
 * low alpha. No fixed Tailwind palette colours.
 */
export type ChipVariant = 'owner' | 'admin' | 'ok' | 'warn' | 'danger' | 'muted';

export const CHIP_VARIANTS: Record<ChipVariant, string> = {
  owner: 'border-warning/30 bg-warning/12 text-warning',
  admin: 'border-primary-soft-2 bg-primary-soft text-primary',
  ok: 'border-success/30 bg-success/12 text-success',
  warn: 'border-warning/30 bg-warning/12 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
};

export function SettingsChip({
  variant = 'muted',
  className,
  children,
}: {
  variant?: ChipVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5',
        CHIP_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small live status dot (e.g. WhatsApp connected indicator). */
export function StatusDot({
  tone = 'ok',
  className,
}: {
  tone?: 'ok' | 'warn' | 'muted';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        tone === 'ok'
          ? 'bg-success'
          : tone === 'warn'
            ? 'bg-warning'
            : 'bg-muted-foreground',
        className,
      )}
    />
  );
}
