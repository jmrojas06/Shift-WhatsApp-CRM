'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  PlugZap,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useFormatter, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import { classifyMetaError, localizeMetaError } from './meta-error-i18n';
import { ConfirmDialog } from './confirm-dialog';
import { ReadOnlyNote } from './readonly-note';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

// Meta ids are decimal digit strings — mirrors the server-side check in
// POST /api/whatsapp/config so the obvious paste mistakes get a named
// field before a round-trip.
const META_ID_RE = /^\d+$/;

// `meta` object the config route attaches to every failed Meta call
// (issue #505): what a user quotes to Meta support.
type MetaErrorMeta = {
  code: number | null;
  subcode: number | null;
  fbtrace_id: string | null;
  step: string;
  field?: string | null;
  message?: string | null;
};
type MetaFailure = { message: string; meta: MetaErrorMeta | null };
type WabaSubscription = {
  checked: boolean;
  subscribed: boolean | null;
  app_id_match: boolean | null;
  error?: string;
};

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const tReadOnly = useTranslations('Settings.readOnly');
  const format = useFormatter();
  const supabase = createClient();
  // The reconnect action in the status banner moves focus here: a
  // dropped connection is fixed by pasting a fresh token and saving.
  const accessTokenRef = useRef<HTMLInputElement>(null);
  const phoneNumberIdRef = useRef<HTMLInputElement>(null);
  const wabaIdRef = useRef<HTMLInputElement>(null);
  // The route words Meta failures in English; this swaps in the
  // translated, actionable text from the failure's code/step and keeps
  // the server's wording only when there is nothing to map (validation
  // and auth errors are already translated server-side).
  const metaText = useCallback(
    (meta: MetaErrorMeta | null | undefined, fallback: string) =>
      localizeMetaError(meta, t) ?? fallback,
    [t],
  );
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const {
    user,
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Structured details of the last failed Meta call (health check or
  // save) — rendered as small muted text under the actionable message.
  const [statusMeta, setStatusMeta] = useState<MetaErrorMeta | null>(null);
  const [saveFailure, setSaveFailure] = useState<MetaFailure | null>(null);
  // A form mistake caught before any request: shown under the field
  // (and the field gets focus) instead of only in a toast that fades.
  const [fieldError, setFieldError] = useState<{
    field: 'phone' | 'waba' | 'token';
    message: string;
  } | null>(null);
  const [wabaSubscription, setWabaSubscription] = useState<WabaSubscription | null>(null);
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [verifyEdited, setVerifyEdited] = useState(false);

  // Inbound-media mirror (issue #466). Unlike everything else on this
  // page it is NOT part of handleSave: that path insists on re-entering
  // the access token so it can re-verify with Meta, which is a silly
  // toll to pay for flipping a boolean. The switch writes straight to
  // the row instead — RLS (migration 017) restricts whatsapp_config
  // UPDATE to admins, hence the canEditSettings gate below; without it
  // a viewer's toggle would match zero rows and appear to work.
  const [mirrorMedia, setMirrorMedia] = useState(true);
  const [savingMirror, setSavingMirror] = useState(false);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        // Same treatment as the access token: the row carries the encrypted
        // value, which is enough to know one exists. Show a mask instead of
        // an empty box so nobody concludes the token was never saved.
        setVerifyToken(data.verify_token ? MASKED_TOKEN : '');
        setVerifyEdited(false);
        setPin('');
        setTokenEdited(false);
        // Undefined on a row read before migration 039 — treat that as
        // on, matching the webhook's own default.
        setMirrorMedia(data.mirror_inbound_media !== false);
      } else {
        setConfig(null);
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
        setVerifyEdited(false);
        setMirrorMedia(true);
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);

      // Then verify health via the API (decrypts token + pings Meta)
      if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
            setStatusMeta(null);
            setWabaSubscription(payload.waba_subscription ?? null);
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(metaText(payload.meta, payload.message || ''));
            setStatusMeta(payload.meta ?? null);
            setWabaSubscription(null);
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(null);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [supabase, t, metaText]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleToggleMirrorMedia(next: boolean) {
    if (!config || !accountId || savingMirror) return;
    // Optimistic — the switch should feel instant; a failure rolls it
    // back rather than leaving the UI ahead of the row.
    const previous = mirrorMedia;
    setMirrorMedia(next);
    setSavingMirror(true);
    try {
      const { error } = await supabase
        .from('whatsapp_config')
        .update({ mirror_inbound_media: next })
        .eq('account_id', accountId);
      if (error) throw new Error(error.message);
      setConfig({ ...config, mirror_inbound_media: next });
    } catch (error) {
      console.error('Failed to update media retention setting:', error);
      setMirrorMedia(previous);
      toast.error(t('mirrorInboundSaveFailed'));
    } finally {
      setSavingMirror(false);
    }
  }

  // Puts a form mistake under its field and moves focus there. The
  // toast stays too: it is what a screen reader announces first.
  function failField(field: 'phone' | 'waba' | 'token', message: string) {
    setFieldError({ field, message });
    toast.error(message);
    const target =
      field === 'phone'
        ? phoneNumberIdRef.current
        : field === 'waba'
          ? wabaIdRef.current
          : accessTokenRef.current;
    target?.focus();
  }

  async function handleSave() {
    setFieldError(null);
    if (!phoneNumberId.trim()) {
      failField('phone', t('phoneNumberIdRequired'));
      return;
    }
    if (!META_ID_RE.test(phoneNumberId.trim())) {
      failField('phone', t('phoneNumberIdNotNumeric'));
      return;
    }
    if (wabaId.trim() && !META_ID_RE.test(wabaId.trim())) {
      failField('waba', t('wabaIdNotNumeric'));
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      failField('token', t('accessTokenRequired'));
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        // Only sent when the user actually typed one. Left out otherwise
        // (undefined is dropped from the JSON body) so the server keeps the
        // stored token instead of nulling it — see resolveVerifyTokenForSave.
        ...(verifyEdited &&
        verifyToken.trim() &&
        verifyToken.trim() !== MASKED_TOKEN
          ? { verify_token: verifyToken.trim() }
          : {}),
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        failField('token', t('reenterAccessToken'));
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        // The route names the failing step and which field to check
        // (issue #505). Keep the details on screen — a toast is too
        // short-lived to copy a trace id out of.
        const failMessage = metaText(data.meta, data.error || t('saveFailed'));
        setSaveFailure({
          message: failMessage,
          meta: data.meta ?? null,
        });
        toast.error(failMessage, { duration: 10000 });
        setSaving(false);
        return;
      }
      setSaveFailure(null);

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        const registrationMessage = t('savedButRegistrationFailed', {
          error: metaText(data.meta, data.registration_error),
        });
        setSaveFailure({
          message: registrationMessage,
          meta: data.meta ?? null,
        });
        toast.error(registrationMessage, { duration: 12000 });
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(
          t('savedRegistrationSkipped'),
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? t('liveWithName', { name: data.phone_info.verified_name })
            : t('connectedGeneric'),
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(payload.waba_subscription ?? null);
        toast.success(
          payload.phone_info?.verified_name
            ? t('connectedTo', { name: payload.phone_info.verified_name })
            : t('apiConnectionOk')
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        const failMessage = metaText(payload.meta, payload.message || '');
        setStatusMessage(failMessage);
        setStatusMeta(payload.meta ?? null);
        setWabaSubscription(null);
        toast.error(failMessage || t('apiConnectionFailed'), { duration: 10000 });
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error(t('connectionTestFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success(t('fullyWired'));
      } else {
        toast.error(
          t('notFullyRegistered'),
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error(t('verifyEndpointUnreachable'));
    } finally {
      setVerifyingRegistration(false);
    }
  }

  // Both "Reset" buttons only open the confirmation; the delete itself
  // runs from the dialog's confirm button (handleReset).
  function requestReset() {
    setResetOpen(true);
  }

  async function handleReset() {
    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('resetFailed'));
        return;
      }

      toast.success(t('resetDone'));
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setVerifyEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
      setStatusMeta(null);
      setSaveFailure(null);
      setWabaSubscription(null);
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('resetFailed'));
    } finally {
      setResetting(false);
      setResetOpen(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('webhookCopied'));
  }

  // UI only: brings the access-token field into view and focuses it
  // (its own onFocus clears the mask, exactly as a click would). The
  // actual reconnect is still the existing Save flow.
  function focusAccessToken() {
    const el = accessTokenRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t("title")}
          description={t("description")}
        />
        {/* Skeleton shaped like the status banner + credentials card. */}
        <div role="status" className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <span className="sr-only">{t('loadingConfig')}</span>
          <div aria-hidden className="space-y-6">
            <div className="h-20 animate-pulse rounded-xl bg-muted" />
            <div className="space-y-4 rounded-xl border border-border bg-card p-4">
              <div className="h-4 w-40 animate-pulse rounded-full bg-muted" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-28 animate-pulse rounded-full bg-muted" />
                  <div className="h-10 animate-pulse rounded-lg bg-muted" />
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden className="hidden h-64 animate-pulse rounded-xl bg-muted lg:block" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';
  // A saved number that no longer authenticates with Meta. (No saved
  // config at all is "not set up", not "needs reconnecting".)
  const needsReconnect = !!config && connectionStatus !== 'connected';
  // The new token is typed in (not the mask, not empty): from here the
  // next step is Save, not Reconnect. Only drives which button is the
  // filled one — each button still does the same thing and is enabled
  // exactly as before.
  const tokenReady =
    tokenEdited && accessToken.trim() !== '' && accessToken !== MASKED_TOKEN;
  const reconnectShown = needsReconnect && !showResetBanner && canEditSettings;
  // Only admins/owners can change the connection (the route and RLS both
  // refuse everyone else), so the form is read-only for the rest.
  const readOnly = !canEditSettings;

  // Step + code + trace id in small muted text, so a user can quote
  // them to Meta support (issue #505). The step names are wire values
  // from the route, shown verbatim.
  const renderMetaDetails = (meta: MetaErrorMeta) => (
    <div className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-muted-foreground break-all">
      <p>
        {t('metaErrorStep')}: <code>{meta.step}</code>
        {meta.code !== null && meta.code !== undefined && (
          <>
            {' · '}
            {t('metaErrorCode')}:{' '}
            <code>
              {meta.code}
              {meta.subcode !== null && meta.subcode !== undefined ? `/${meta.subcode}` : ''}
            </code>
          </>
        )}
        {meta.fbtrace_id && (
          <>
            {' · '}
            {t('metaErrorTrace')}: <code>{meta.fbtrace_id}</code>
          </>
        )}
      </p>
      {/* The WABA/phone mismatch carries an internal marker, not a Meta
          answer, so there is nothing worth quoting from it. */}
      {meta.message && classifyMetaError(meta) !== 'wabaMismatch' && (
        <p>
          {t('metaErrorMessage')}: {meta.message}
        </p>
      )}
      <p>{t('metaErrorDetailsHint')}</p>
    </div>
  );

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="border-warning/30 bg-warning/10 px-4 py-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-warning mt-0.5 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <AlertTitle className="text-foreground font-semibold mb-1">
                  {t('tokenCorrupted')}
                </AlertTitle>
                <AlertDescription className="text-muted-foreground text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  variant="destructive"
                  onClick={requestReset}
                  disabled={resetting || readOnly}
                  className="mt-3"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Last save failed — why, which field, and what to quote to Meta */}
        {saveFailure && (
          <Alert className="border-destructive/30 bg-destructive/10 px-4 py-3">
            <div className="flex items-start gap-3">
              <XCircle className="size-5 text-destructive mt-0.5 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <AlertTitle className="text-destructive font-semibold mb-1">{t('lastSaveFailed')}</AlertTitle>
                <AlertDescription className="text-foreground/90 text-sm">
                  {saveFailure.message}
                </AlertDescription>
                {saveFailure.meta && renderMetaDetails(saveFailure.meta)}
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        {/* Three looks: connected (success), saved but not connecting
            (warning + one primary "Reconnect" that takes you to the
            token field), and never set up (neutral). */}
        <Alert
          role={needsReconnect ? 'alert' : 'status'}
          className={cn(
            'px-4 py-3',
            connectionStatus === 'connected'
              ? 'border-success/30 bg-success/8'
              : needsReconnect
                ? 'border-warning/35 bg-warning/10'
                : 'border-border bg-card',
          )}
        >
          <div className="flex items-start gap-2.5">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
            ) : needsReconnect ? (
              <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden />
            ) : (
              <PlugZap className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <AlertTitle className="mb-0.5 font-semibold text-foreground">
                {connectionStatus === 'connected'
                  ? t('credentialsValid')
                  : needsReconnect
                    ? t('needsReconnectTitle')
                    : t('notConnected')}
              </AlertTitle>
              <AlertDescription className="text-muted-foreground">
                {connectionStatus === 'connected'
                  ? t('connectedDesc')
                  : statusMessage ||
                    (needsReconnect ? t('needsReconnectDesc') : t('notConnectedDesc'))}
              </AlertDescription>
              {needsReconnect && !showResetBanner && !canEditSettings && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('reconnectAskAdmin')}
                </p>
              )}
              {reconnectShown && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button
                    variant={tokenReady ? 'outline' : 'default'}
                    onClick={focusAccessToken}
                  >
                    <PlugZap aria-hidden />
                    {t('reconnect')}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t('reconnectHint')}
                  </span>
                </div>
              )}
              {connectionStatus === 'connected' && wabaSubscription?.checked && (
                <p
                  className={
                    'mt-1 text-xs ' +
                    (wabaSubscription.subscribed === false
                      ? 'font-medium text-warning'
                      : 'text-muted-foreground')
                  }
                >
                  {wabaSubscription.subscribed === false
                    ? t('wabaNotSubscribed')
                    : wabaSubscription.subscribed === true
                      ? t('wabaSubscribed')
                      : wabaSubscription.error}
                </p>
              )}
              {connectionStatus !== 'connected' && statusMeta && renderMetaDetails(statusMeta)}
            </div>
          </div>
        </Alert>

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {config && (
          <Alert
            role={isRegistered ? 'status' : 'alert'}
            className={cn(
              'px-4 py-3',
              isRegistered
                ? 'border-success/30 bg-success/8'
                : 'border-warning/35 bg-warning/10',
            )}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex min-w-0 items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
                ) : (
                  <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
                )}
                <AlertTitle className="mb-0 font-semibold text-foreground">
                  {isRegistered
                    ? t('registered')
                    : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <span
                  dangerouslySetInnerHTML={{
                    __html: t('subscribedSince', {
                      date: config.registered_at
                        ? format.dateTime(new Date(config.registered_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : t('unknownDate'),
                    }),
                  }}
                />
              ) : lastRegistrationError ? (
                <>
                  {t('lastAttemptFailed')}
                  <span className="text-destructive">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('retryHint')}
                </>
              ) : (
                <>{t('noRegistrationHint')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('diagnosticLastRun')}
                  <span className={registrationProbe.live ? 'text-success' : 'text-warning'}>
                    {registrationProbe.live ? t('live') : t('notLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-success shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-destructive shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-destructive">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold text-foreground">{t('apiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="wa-phone-number-id">{t('phoneNumberId')}</Label>
              <Input
                ref={phoneNumberIdRef}
                id="wa-phone-number-id"
                inputMode="numeric"
                autoComplete="off"
                placeholder={t('phoneNumberIdPlaceholder')}
                value={phoneNumberId}
                disabled={readOnly}
                aria-invalid={fieldError?.field === 'phone' || undefined}
                aria-describedby={fieldError?.field === 'phone' ? 'wa-phone-number-id-error' : undefined}
                onChange={(e) => {
                  setPhoneNumberId(e.target.value);
                  if (fieldError?.field === 'phone') setFieldError(null);
                }}
              />
              {fieldError?.field === 'phone' && (
                <p id="wa-phone-number-id-error" className="text-xs font-medium text-destructive">
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-waba-id">{t('wabaId')}</Label>
              <Input
                ref={wabaIdRef}
                id="wa-waba-id"
                inputMode="numeric"
                autoComplete="off"
                placeholder={t('wabaIdPlaceholder')}
                value={wabaId}
                disabled={readOnly}
                aria-invalid={fieldError?.field === 'waba' || undefined}
                aria-describedby={fieldError?.field === 'waba' ? 'wa-waba-id-error' : undefined}
                onChange={(e) => {
                  setWabaId(e.target.value);
                  if (fieldError?.field === 'waba') setFieldError(null);
                }}
              />
              {fieldError?.field === 'waba' && (
                <p id="wa-waba-id-error" className="text-xs font-medium text-destructive">
                  {fieldError.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-access-token">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  ref={accessTokenRef}
                  id="wa-access-token"
                  autoComplete="off"
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  disabled={readOnly}
                  aria-invalid={fieldError?.field === 'token' || undefined}
                  aria-describedby={fieldError?.field === 'token' ? 'wa-access-token-error' : undefined}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                    if (fieldError?.field === 'token') setFieldError(null);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? t('hideToken') : t('showToken')}
                  aria-pressed={showToken}
                  className="absolute right-0.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:size-10"
                >
                  {showToken ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              </div>
              {fieldError?.field === 'token' && (
                <p id="wa-access-token-error" className="text-xs font-medium text-destructive">
                  {fieldError.message}
                </p>
              )}
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-verify-token">{t('webhookVerifyToken')}</Label>
              <Input
                id="wa-verify-token"
                autoComplete="off"
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                disabled={readOnly}
                onChange={(e) => {
                  setVerifyToken(e.target.value);
                  setVerifyEdited(true);
                }}
                onFocus={() => {
                  if (verifyToken === MASKED_TOKEN) {
                    setVerifyToken('');
                    setVerifyEdited(true);
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                {config?.verify_token && !verifyEdited
                  ? t('webhookVerifyTokenSaved')
                  : t('webhookVerifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-pin">
                {t('twoStepPin')}
                <span className="font-normal text-muted-foreground">{t('optional')}</span>
              </Label>
              <Input
                id="wa-pin"
                autoComplete="off"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('pinPlaceholder')}
                value={pin}
                disabled={readOnly}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold text-foreground">{t('webhookTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="wa-webhook-url">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  id="wa-webhook-url"
                  readOnly
                  value={webhookUrl}
                  className="bg-muted text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon-lg"
                  onClick={handleCopyWebhookUrl}
                  aria-label={t('copyWebhookUrl')}
                  className="shrink-0"
                >
                  <Copy className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Attachment retention. Only meaningful once a number is
            connected, since it governs what the webhook does with
            inbound media. */}
        {config && (
          <Card>
            <CardHeader>
              <CardTitle className="text-[15px] font-semibold text-foreground">{t('mediaTitle')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('mediaDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('mirrorInbound')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('mirrorInboundDesc')}
                  </p>
                  {!mirrorMedia && (
                    <p className="mt-1 text-xs font-medium text-warning">
                      {t('mirrorInboundOffWarning')}
                    </p>
                  )}
                </div>
                <Switch
                  checked={mirrorMedia}
                  onCheckedChange={handleToggleMirrorMedia}
                  disabled={savingMirror || !canEditSettings}
                  aria-label={t('mirrorInbound')}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Action Buttons */}
        {readOnly && <ReadOnlyNote>{tReadOnly('whatsapp')}</ReadOnlyNote>}
        <div className="flex flex-wrap gap-3">
          {/* One filled (green) button per view: while Reconnect is the
              step to take, Save steps back to outline until a new token
              has been typed. */}
          <Button
            variant={reconnectShown && !tokenReady ? 'outline' : 'default'}
            onClick={handleSave}
            disabled={saving || readOnly}
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="destructive"
              onClick={requestReset}
              disabled={resetting || readOnly}
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold text-foreground">{t('setupInstructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step3_2') }} />
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step3_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step3_4') }} />
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step4_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t.raw('step4_4') }} />
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <ConfirmDialog
      open={resetOpen}
      onOpenChange={setResetOpen}
      title={t('resetDialogTitle')}
      description={t('resetConfirm')}
      confirmLabel={t('resetConfig')}
      busyLabel={t('resetting')}
      cancelLabel={t('cancel')}
      busy={resetting}
      onConfirm={handleReset}
    />
    </section>
  );
}
