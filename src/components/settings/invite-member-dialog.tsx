'use client';

// ============================================================
// InviteMemberDialog
//
// Two-step modal:
//   1. Form  — role + expiry + optional label → POST creates the invite.
//   2. Result — the share URL, returned ONCE. Copy-to-clipboard, plus a
//              "Send via WhatsApp" deep link that pre-fills wa.me with
//              a friendly message containing the URL.
//
// The plaintext token is server-stored only as a SHA-256 hash, so once
// the result step is dismissed the link is gone forever — the dialog
// shouts this in copy.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, MessageCircle, Sparkles } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';

type InviteRole = 'admin' | 'agent' | 'viewer';

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches the
   *  pending-invitations list. */
  onCreated: () => void;
}

const EXPIRY_OPTIONS = [
  { value: '1', labelKey: 'days1' },
  { value: '7', labelKey: 'days7' },
  { value: '30', labelKey: 'days30' },
];

// Server caps label at 80 chars (see src/app/api/account/invitations/route.ts).
// Mirror it on the client so we short-circuit before the round-trip
// rather than letting the user submit and bounce off a 400.
const MAX_LABEL_LEN = 80;

interface CreatedInvite {
  url: string;
  role: InviteRole;
  expiresInDays: number;
  /** Snapshotted at creation time so a later account rename can't
   *  retroactively change the wa.me message text on the result step. */
  accountName: string;
}

export function InviteMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: InviteMemberDialogProps) {
  const t = useTranslations('Settings.invite');
  const tRoles = useTranslations('Settings.roles');
  const { account } = useAuth();
  const [role, setRole] = useState<InviteRole>('agent');
  const [expiry, setExpiry] = useState<string>('7');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreatedInvite | null>(null);

  function reset() {
    setRole('agent');
    setExpiry('7');
    setLabel('');
    setResult(null);
    setSubmitting(false);
  }

  async function handleCreate() {
    // Mirror the server's max-length check so we don't ship an
    // obviously-too-long label across the wire just to bounce off
    // a 400. The Input also has a `maxLength={MAX_LABEL_LEN}` cap
    // but a paste can land an over-limit string into state before
    // the limit kicks in on the next keystroke — this is the safety
    // net for that path.
    const trimmedLabel = label.trim();
    if (trimmedLabel.length > MAX_LABEL_LEN) {
      toast.error(t('labelTooLong', { max: MAX_LABEL_LEN }));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          expiresInDays: Number(expiry),
          label: trimmedLabel || undefined,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('createFailed'));
        return;
      }

      const data = (await res.json()) as {
        url: string;
        expiresInDays: number;
      };

      setResult({
        url: data.url,
        role,
        expiresInDays: data.expiresInDays,
        // Snapshot the account name into the result so the wa.me
        // share message has team context. Falls back to a generic
        // string if `account` hasn't loaded yet (shouldn't happen
        // — the dialog requires admin+ which requires a loaded
        // profile — but stay safe).
        accountName: account?.name ?? t('fallbackAccountName'),
      });
      onCreated();
    } catch (err) {
      console.error('[InviteMemberDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success(t('copied'));
    } catch {
      // Most likely "not in a secure context" — happens on http://
      // local IPs. Surface the link in the toast so the admin can
      // hand-copy it.
      toast.error(t('clipboardBlocked'));
    }
  }

  function whatsappShareUrl(url: string): string {
    // Include the account name so the recipient knows which team
    // they're being invited to before clicking through. This matters
    // for users in multi-team contexts where "our wacrm account"
    // wouldn't be enough to disambiguate.
    const accountName = result?.accountName ?? t('fallbackAccountName');
    const message = t('whatsappMessage', { accountName, expiresInDays: result?.expiresInDays ?? 0, url });
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset state when the dialog closes — both for cancel and
        // for dismissal after a successful create. The plaintext URL
        // is intentionally NOT preserved across opens.
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Sparkles className="size-4 text-primary" />
                {t('inviteCreated')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('inviteCreatedDesc', {
                  role: tRoles(result.role),
                  days: result.expiresInDays,
                  bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <Label htmlFor="invite-link">{t('inviteLink')}</Label>
              <div className="flex gap-2">
                <Input
                  id="invite-link"
                  readOnly
                  value={result.url}
                  className="bg-muted font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  onClick={copyToClipboard}
                  className="shrink-0"
                >
                  <Copy className="size-4" aria-hidden />
                  {t('copy')}
                </Button>
              </div>

              {/* Warning tokens: text is the state colour itself, which
                  the theme keeps at AA contrast in light and dark. */}
              <div role="note" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground">
                <strong className="font-semibold text-warning">
                  {t('saveLinkNow')}
                </strong>{' '}
                {t('saveLinkHint')}
              </div>

              {/* Anchor styled with `buttonVariants` rather than wrapping
                  in <Button asChild>. The wacrm Button is the Base UI
                  ButtonPrimitive — it has no Radix-style asChild slot.
                  Direct anchor preserves right-click "Open in new tab"
                  behaviour too. */}
              <a
                href={whatsappShareUrl(result.url)}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonVariants({
                  variant: 'outline',
                  className: 'w-full',
                })}
              >
                <MessageCircle className="size-4" aria-hidden />
                {t('sendViaWhatsApp')}
              </a>
            </div>

            <DialogFooter className="bg-popover border-border">
              {/* Copy is this step's one primary action. */}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('dialogTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t('dialogDesc')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="invite-role">{t('roleLabel')}</Label>
                <Select
                  value={role}
                  onValueChange={(v) => v && setRole(v as InviteRole)}
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue>{tRoles(role)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">{tRoles('admin')}</SelectItem>
                    <SelectItem value="agent">{tRoles('agent')}</SelectItem>
                    <SelectItem value="viewer">{tRoles('viewer')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {tRoles(`${role}Hint` as 'adminHint' | 'agentHint' | 'viewerHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-expiry">{t('validForLabel')}</Label>
                <Select
                  value={expiry}
                  onValueChange={(v) => v && setExpiry(v)}
                >
                  <SelectTrigger id="invite-expiry" className="w-full">
                    {/* Without explicit content the trigger shows the raw
                        value ("7") instead of "7 días". */}
                    <SelectValue>
                      {t(
                        (EXPIRY_OPTIONS.find((o) => o.value === expiry)?.labelKey ??
                          'days7') as Parameters<typeof t>[0],
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.labelKey as Parameters<typeof t>[0])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-label">
                  {t('labelTitle')}
                  <span className="text-xs font-normal text-muted-foreground">{t('optional')}</span>
                </Label>
                <Input
                  id="invite-label"
                  placeholder={t('labelPlaceholder')}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={MAX_LABEL_LEN}
                />
                <p className="text-xs text-muted-foreground">
                  {t('labelHint')}
                </p>
              </div>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {t('creating')}
                  </>
                ) : (
                  t('generateLink')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
