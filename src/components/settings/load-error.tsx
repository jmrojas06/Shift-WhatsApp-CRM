'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/**
 * Shown when a settings list could not be loaded. Without it a failed
 * request left an empty list that read as "nothing here yet" — and the
 * only explanation was a toast that fades. The message comes from the
 * caller (each list already has its own "could not load" text).
 */
export function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const t = useTranslations('Settings.common');
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="min-w-0">{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
        <RotateCw aria-hidden />
        {t('retry')}
      </Button>
    </div>
  );
}
