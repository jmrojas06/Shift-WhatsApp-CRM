'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Password field with a show/hide toggle. Typing a password blind on a
 * phone is the commonest reason a sign-in or sign-up fails, so every
 * password field in the signed-out screens (and the change-password
 * form) uses this. The toggle is a real button: reachable by Tab, named,
 * and `aria-pressed`. It keeps the field's own `autoComplete`, so the
 * password manager still recognises it.
 */
export function PasswordInput({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  const t = useTranslations('AuthFields');
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        // Hiding the characters is the point: never let the browser
        // "fix" or capitalise them while they are shown.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn('pr-11', className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t('hidePassword') : t('showPassword')}
        aria-pressed={visible}
        disabled={props.disabled}
        className="absolute right-0.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-10"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
