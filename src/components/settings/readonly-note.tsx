import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Plain-sight explanation for a section the current role can only look
 * at. A tooltip on a disabled button never shows on touch screens, so
 * the reason is written on the page instead.
 */
export function ReadOnlyNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="note"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground',
        className,
      )}
    >
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
