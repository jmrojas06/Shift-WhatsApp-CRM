'use client';

// ============================================================
// ApiKeysSettings — Settings → API keys
//
// Manage the credentials that authenticate the public REST API
// (`/api/v1/*`). Any member sees the roster (read-only); admin+ can
// mint and revoke (gated by <RequireRole min="admin"> here and the
// admin-only API routes + RLS on the server).
//
// One-time reveal: a freshly-minted key's plaintext is shown ONCE in
// the creation dialog. After it closes, only the prefix remains —
// the server stores just the hash. The UI states this explicitly so
// the absence of a "copy again" button reads as intentional, not a
// bug (same lesson as the invite-link flow).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { API_SCOPES, type ApiScope } from '@/lib/api-keys/scopes';
import { useFormatter, useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';
import { ConfirmDialog } from './confirm-dialog';
import { LoadError } from './load-error';

// Message key (under `Settings.apiKeys.scopeDescriptions`) for each scope.
// `SCOPE_DESCRIPTIONS` in lib/api-keys/scopes.ts is English-only, so the
// dialog reads these instead. Typed as a Record so a new scope without a
// description fails the build.
const SCOPE_DESCRIPTION_KEY: Record<ApiScope, string> = {
  'messages:send': 'messagesSend',
  'messages:read': 'messagesRead',
  'contacts:read': 'contactsRead',
  'contacts:write': 'contactsWrite',
  'conversations:read': 'conversationsRead',
  'broadcasts:send': 'broadcastsSend',
  'webhooks:manage': 'webhooksManage',
};

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

type DateFormatter = ReturnType<typeof useFormatter>;

// In the app's language (next-intl), not the browser's.
function fmtDate(iso: string, format: DateFormatter): string {
  return format.dateTime(new Date(iso), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function keyStatus(k: ApiKey): 'active' | 'revoked' | 'expired' {
  if (k.revoked_at) return 'revoked';
  if (k.expires_at && new Date(k.expires_at).getTime() <= Date.now())
    return 'expired';
  return 'active';
}

export function ApiKeysSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.apiKeys');
  const format = useFormatter();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Key waiting for the "revoke it?" confirmation.
  const [keyToRevoke, setKeyToRevoke] = useState<ApiKey | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetch('/api/account/api-keys', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setLoadFailed(true);
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const data = (await res.json()) as { keys: ApiKey[] };
      setKeys(data.keys);
    } catch (err) {
      console.error('[ApiKeysSettings] load error:', err);
      setLoadFailed(true);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevoke(key: ApiKey) {
    setRevoking(key.id);
    try {
      const res = await fetch(`/api/account/api-keys/${key.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('revokeFailed'));
        return;
      }
      toast.success(t('revokeSuccess', { name: key.name }));
      // Reflect the revoke locally without a refetch.
      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id ? { ...k, revoked_at: new Date().toISOString() } : k
        )
      );
    } catch (err) {
      console.error('[ApiKeysSettings] revoke error:', err);
      toast.error(t('networkError'));
    } finally {
      setRevoking(null);
    }
  }

  if (loading) {
    return (
      <section className="space-y-6">
        <SettingsPanelHead title={t('title')} />
        {/* Skeleton rows shaped like the key list (name, prefix, scopes). */}
        <Card role="status">
          <span className="sr-only">{t('loadingKeys')}</span>
          <CardContent aria-hidden className="divide-y divide-border p-0">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-2 px-4 py-3">
                <div className="h-3 w-36 animate-pulse rounded-full bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded-full bg-muted" />
                <div className="h-4 w-40 max-w-full animate-pulse rounded-full bg-muted" />
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={
          t.rich('description', {
            apiCode: (chunks: React.ReactNode) => <code className="text-xs">{chunks}</code>,
            headerCode: (chunks: React.ReactNode) => <code className="text-xs">{chunks}</code>
          })
        }
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('newApiKey')}
            </Button>
          </RequireRole>
        }
      />

      {loadFailed ? (
        <LoadError message={t('loadFailed')} onRetry={() => void load()} />
      ) : keys.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <KeyRound className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              {t('noApiKeys')}
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                {t.rich('createOneHint', {
                  bold: (chunks: React.ReactNode) => (
                    <span className="text-foreground">{chunks}</span>
                  ),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {t('askAdminHint')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {keys.map((k) => {
                const status = keyStatus(k);
                const inactive = status !== 'active';
                return (
                  <li
                    key={k.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`truncate text-sm font-medium ${
                            inactive
                              ? 'text-muted-foreground line-through'
                              : 'text-foreground'
                          }`}
                        >
                          {k.name}
                        </span>
                        {status === 'revoked' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('revoked')}
                          </Badge>
                        )}
                        {status === 'expired' && (
                          <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                            {t('expired')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                        {k.key_prefix}…
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {k.scopes.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            {t('noScopes')}
                          </span>
                        ) : (
                          k.scopes.map((s) => (
                            <Badge
                              key={s}
                              className="border-border bg-muted text-muted-foreground text-[10px]"
                            >
                              {s}
                            </Badge>
                          ))
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-xs">
                        {t('created', { date: fmtDate(k.created_at, format) })}
                        {' · '}
                        {k.last_used_at
                          ? t('lastUsed', { date: fmtDate(k.last_used_at, format) })
                          : t('neverUsed')}
                        {k.expires_at && status !== 'expired'
                          ? ` · ${t('expires', { date: fmtDate(k.expires_at, format) })}`
                          : ''}
                      </p>
                    </div>

                    {status === 'active' && (
                      <RequireRole min="admin">
                        <Button
                          variant="destructive"
                          size="sm"
                          // Revoking breaks every integration using this
                          // key, so it asks first (dialog below).
                          onClick={() => setKeyToRevoke(k)}
                          disabled={revoking === k.id}
                          aria-label={t('revokeLabel', { name: k.name })}
                          className="self-start sm:self-auto"
                        >
                          {revoking === k.id ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : (
                            <Trash2 className="size-4" aria-hidden />
                          )}
                          {t('revoke')}
                        </Button>
                      </RequireRole>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />

      <ConfirmDialog
        open={keyToRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setKeyToRevoke(null);
        }}
        title={t('revokeDialogTitle')}
        description={keyToRevoke ? t('revokeConfirm', { name: keyToRevoke.name }) : null}
        confirmLabel={t('revoke')}
        busyLabel={t('revoking')}
        cancelLabel={t('cancel')}
        busy={revoking !== null}
        onConfirm={async () => {
          if (!keyToRevoke) return;
          await handleRevoke(keyToRevoke);
          setKeyToRevoke(null);
        }}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time plaintext reveal.
// ------------------------------------------------------------

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Settings.apiKeys');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Once set, we switch from the form to the reveal view.
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  function reset() {
    setName('');
    setScopes([]);
    setSubmitting(false);
    setCreatedKey(null);
  }

  function toggleScope(scope: ApiScope, checked: boolean) {
    setScopes((prev) =>
      checked ? [...prev, scope] : prev.filter((s) => s !== scope)
    );
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scopes }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createError'));
        return;
      }
      setCreatedKey(payload.plaintext as string);
      onCreated();
    } catch (err) {
      console.error('[CreateKeyDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('copyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('copyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label htmlFor="api-key-created">{t('apiKeyLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  id="api-key-created"
                  readOnly
                  value={createdKey}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copyKey}>
                  <Copy className="size-4" />
                  {t('copy')}
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('newKeyTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('newKeyDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="api-key-name" className="text-muted-foreground">
                  {t('nameLabel')}
                </Label>
                <Input
                  id="api-key-name"
                  value={name}
                  maxLength={80}
                  placeholder={t('namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <p id="api-key-scopes" className="text-sm leading-none font-medium">
                  {t('scopesLabel')}
                </p>
                <div
                  role="group"
                  aria-labelledby="api-key-scopes"
                  className="border-border space-y-2 rounded-lg border p-3"
                >
                  {API_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={scopes.includes(scope)}
                        onCheckedChange={(checked) =>
                          toggleScope(scope, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-mono text-xs">
                          {scope}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {t(`scopeDescriptions.${SCOPE_DESCRIPTION_KEY[scope]}`)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">
                  {t.rich('scopesHint', {
                    code: (chunks: React.ReactNode) => (
                      <code className="text-[11px]">{chunks}</code>
                    ),
                  })}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('createKey')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
