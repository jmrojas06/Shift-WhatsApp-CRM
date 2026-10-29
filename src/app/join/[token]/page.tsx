'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { CardContent } from '@/components/ui/card';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-shell';
import { redeemErrorKey } from '@/components/auth/redeem-error';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

// Message keys per peek failure reason — resolved through `t` inside
// the component (hooks can't run at module level). Snake_case reasons
// come from the API; the catalogue uses camelCase leaves.
const FAIL_KEY: Record<PeekFail['reason'], 'notFound' | 'used' | 'expired' | 'serverError'> = {
  not_found: 'notFound',
  used: 'used',
  expired: 'expired',
  server_error: 'serverError',
};

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  const t = useTranslations('JoinPage');
  const tErrors = useTranslations('AuthErrors');
  // Role labels are shared with Settings → Members so the invite page
  // and the member list always agree on what a role is called.
  const tRoles = useTranslations('Settings.roles');
  const format = useFormatter();

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` and `/signup` do.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use different email)
        // rather than a 3-second toast.
        // The RPC's refusal text is English; swap in a translated one
        // when we recognise it, otherwise keep what the server sent.
        const known = redeemErrorKey(res.status, payload.error);
        const localized =
          known === 'alreadyMember'
            ? t('conflictAlreadyMember')
            : known === 'sharedAccount'
              ? t('conflictSharedAccount')
              : known === 'hasData'
                ? t('conflictHasData')
                : known === 'notFound'
                  ? t('fail.notFoundBody')
                  : known === 'used'
                    ? t('fail.usedBody')
                    : known === 'expired'
                      ? t('fail.expiredBody')
                      : known === 'unauthorized'
                        ? tErrors('sessionExpired')
                        : null;
        if (res.status === 409) {
          setConflictMessage(localized || payload.error || t('conflictDefault'));
        } else {
          toast.error(localized || payload.error || t('acceptFailed'));
        }
        setAccepting(false);
        return;
      }
      toast.success(t('welcome'));
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error(t('serverUnreachable'));
      setAccepting(false);
    }
  }, [token, t, tErrors]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error(t('signOutFailed'));
      setSigningOut(false);
    }
  }, [t]);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <AuthCard>
        <CardContent
          role="status"
          className="flex flex-col items-center gap-3 px-6 py-8 text-sm text-muted-foreground"
        >
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
          {t('verifying')}
        </CardContent>
      </AuthCard>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const failKey = FAIL_KEY[peek.reason];
    return (
      <AuthCard>
        <AuthCardHeader
          icon={MailX}
          tone="warning"
          title={t(`fail.${failKey}Title`)}
          description={t(`fail.${failKey}Body`)}
        />
        <CardContent className="flex flex-col gap-2 px-6">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is
              the right primary action; the "create account" /
              "sign in" links stay as secondary options. Other
              failure reasons (not_found / used / expired) are
              terminal for this token, so no retry — just the
              signup/sign-in escape hatches. */}
          {peek.reason === 'server_error' ? (
            <>
              <Button size="lg" onClick={loadPeekAndAuth} className="w-full">
                {t('tryAgain')}
              </Button>
              <Link
                href="/signup"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
              >
                {t('createNewAccount')}
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/signup"
                className={cn(buttonVariants({ size: 'lg' }), 'w-full')}
              >
                {t('createNewAccount')}
              </Link>
              <Link
                href="/login"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
              >
                {t('signIn')}
              </Link>
            </>
          )}
        </CardContent>
      </AuthCard>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <AuthCardHeader
      icon={UsersRound}
      title={t.rich('invitedTo', {
        name: peek.account_name,
        account: (chunks) => <span className="text-primary">{chunks}</span>,
      })}
      description={t.rich('joinAs', {
        role: tRoles(peek.role),
        date: format.dateTime(new Date(peek.expires_at), {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
        badge: (chunks) => (
          <span className="inline-flex items-center gap-1 font-medium text-foreground">
            <ShieldCheck className="size-3.5 text-primary" aria-hidden />
            {chunks}
          </span>
        ),
      })}
    />
  );

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <AuthCard>
          {inviteHeader}
          <CardContent className="flex flex-col gap-3 px-6">
            <Button
              size="lg"
              onClick={handleAccept}
              disabled={accepting}
              className="w-full"
            >
              {accepting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {t('accepting')}
                </>
              ) : (
                <>
                  <CheckCircle aria-hidden />
                  {t('acceptInvitation')}
                </>
              )}
            </Button>
            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              {t('acceptNote', { name: peek.account_name })}
            </p>
          </CardContent>
        </AuthCard>

        {/* Conflict modal — opens when the redeem endpoint returns 409
            (caller already in a shared account or has domain data).
            Blocks the flow until the user picks a recovery action so
            they aren't stuck retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
                {t('conflictTitle', { name: peek.account_name })}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              <p>
                {t.rich('conflictBody', {
                  name: peek.account_name,
                  account: (chunks) => (
                    <span className="text-popover-foreground">{chunks}</span>
                  ),
                })}
              </p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button variant="outline" onClick={() => setConflictMessage(null)}>
                {t('staySignedIn')}
              </Button>
              <Button onClick={handleSignOutAndRetry} disabled={signingOut}>
                {signingOut ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden />
                    {t('signingOut')}
                  </>
                ) : (
                  t('signOutSwitch')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed: prompt to sign up or sign in -----
  return (
    <AuthCard>
      {inviteHeader}
      <CardContent className="flex flex-col gap-2 px-6">
        <Link
          href={`/signup?invite=${encodeURIComponent(token!)}`}
          className={cn(buttonVariants({ size: 'lg' }), 'w-full')}
        >
          {t('createAndJoin')}
        </Link>
        <Link
          href={`/login?invite=${encodeURIComponent(token!)}`}
          className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
        >
          {t('haveAccount')}
        </Link>
      </CardContent>
    </AuthCard>
  );
}
