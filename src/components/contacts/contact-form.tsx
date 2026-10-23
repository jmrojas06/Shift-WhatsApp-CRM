'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import {
  validateContactFields,
  type ContactFormErrors,
} from './contact-form-validation';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, AlertTriangle, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  contactTags?: ContactTag[];
  onSaved: () => void;
  /** Open an existing contact's detail view — used by the duplicate
   *  notice to jump to the contact that already owns this number. */
  onViewExisting?: (contactId: string) => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  contactTags = [],
  onSaved,
  onViewExisting,
}: ContactFormProps) {
  const t = useTranslations('Contacts.form');
  const supabase = createClient();
  const { accountId } = useAuth();
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);
  // Inline field errors (message keys), shown under each field.
  const [errors, setErrors] = useState<ContactFormErrors>({});

  // Duplicate-phone detection for NEW contacts. `exact` (same digits)
  // hard-blocks the save; a fuzzy trunk-variant match only warns. The
  // DB unique index (migration 022) is the real backstop — this is the
  // friendly heads-up before we get there.
  const [dupMatch, setDupMatch] = useState<
    { contact: ExistingContact; exact: boolean } | null
  >(null);
  const [checkingDup, setCheckingDup] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setSelectedTagIds(contactTags.map((ct) => ct.tag_id));
      setDupMatch(null);
      setErrors({});
      fetchTags();
    }
  }, [open, contact]);

  // Look up an existing contact with this number (new contacts only).
  // Runs on blur so we don't query on every keystroke.
  async function checkDuplicate() {
    if (isEdit || !accountId) return;
    const value = phone.trim();
    if (!value) {
      setDupMatch(null);
      return;
    }
    setCheckingDup(true);
    try {
      const existing = await findExistingContact(supabase, accountId, value);
      setDupMatch(
        existing
          ? { contact: existing, exact: isExactMatch(existing, value) }
          : null,
      );
    } finally {
      setCheckingDup(false);
    }
  }

  async function fetchTags() {
    setLoadingTags(true);
    const { data } = await supabase
      .from('tags')
      .select('*')
      .order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // A number typed here must carry its country code (leading `+`):
    // "4155551212" reads as a US number to the person typing it but is
    // delivered to +41 (Switzerland) by Meta (issue #586). Only checked
    // when the number actually changed — contacts created by the inbound
    // webhook store Meta's digits-only form, and editing their name must
    // not be blocked by a phone the user never touched.
    const phoneChanged = !isEdit || phone.trim() !== (contact?.phone ?? '');
    const fieldErrors = validateContactFields({ phone, email, phoneChanged });
    setErrors(fieldErrors);
    if (fieldErrors.phone || fieldErrors.email) {
      // Move focus to the first field that needs fixing so keyboard and
      // screen-reader users land on the message.
      document
        .getElementById(fieldErrors.phone ? 'cf-phone' : 'cf-email')
        ?.focus();
      return;
    }

    // Hard-block an exact duplicate on create (the DB unique index is
    // the real backstop; this avoids a round-trip + a raw error toast).
    if (!isEdit && dupMatch?.exact) {
      toast.error(t('toastConflict'));
      return;
    }

    setSaving(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error(t('notAuthenticated'));
      if (!accountId) throw new Error(t('notLinkedToAccount'));

      let contactId = contact?.id;

      if (isEdit && contactId) {
        const { error } = await supabase
          .from('contacts')
          .update({
            name: name.trim() || null,
            phone: phone.trim(),
            email: email.trim() || null,
            company: company.trim() || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contactId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: name.trim() || null,
            phone: phone.trim(),
            email: email.trim() || null,
            company: company.trim() || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        contactId = data.id;
      }

      // Sync tags
      if (contactId) {
        const existingTagIds = new Set(contactTags.map((tag) => tag.tag_id));
        const desiredTagIds = new Set(selectedTagIds);
        const toRemove = [...existingTagIds].filter((id) => !desiredTagIds.has(id));
        const toAdd = [...desiredTagIds].filter((id) => !existingTagIds.has(id));

        for (const tagId of toRemove) {
          await deleteContactTag(contactId, tagId);
        }
        for (const tagId of toAdd) {
          await addContactTag(contactId, tagId);
        }
      }

      toast.success(isEdit ? t('toastSuccessEdit') : t('toastSuccessAdd'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      // The unique index (migration 022) rejects a duplicate phone that
      // slipped past the on-blur check (race, or a format that
      // normalizes equal). Surface it as the friendly duplicate notice
      // and, for new contacts, point the user at the existing record.
      if (isUniqueViolation(err)) {
        toast.error(t('toastConflict'));
        if (!isEdit && accountId) {
          const existing = await findExistingContact(
            supabase,
            accountId,
            phone.trim(),
          );
          if (existing) setDupMatch({ contact: existing, exact: true });
        }
        return;
      }
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('editTitle') : t('addTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit
              ? t('editDesc')
              : t('addDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cf-name">{t('nameLabel')}</Label>
            <Input
              id="cf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              autoComplete="off"
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-phone">
              {t('phoneLabel')}
              <span className="font-normal text-muted-foreground">
                ({t('requiredMark')})
              </span>
            </Label>
            <Input
              id="cf-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              required
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (dupMatch) setDupMatch(null);
                if (errors.phone) setErrors((prev) => ({ ...prev, phone: undefined }));
              }}
              onBlur={checkDuplicate}
              placeholder={t('phonePlaceholder')}
              aria-invalid={errors.phone ? true : undefined}
              aria-describedby={errors.phone ? 'cf-phone-error' : 'cf-phone-hint'}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            {errors.phone ? (
              <p id="cf-phone-error" role="alert" className="text-xs text-destructive">
                {t(errors.phone)}
              </p>
            ) : dupMatch ? (
              <div
                id="cf-phone-hint"
                className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                  dupMatch.exact
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : 'border-warning/40 bg-warning/10 text-warning'
                }`}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="space-y-1">
                  <p>
                    {dupMatch.exact
                      ? t('dupExact')
                      : t('dupSimilar')}
                  </p>
                  {onViewExisting && (
                    <button
                      type="button"
                      onClick={() => onViewExisting(dupMatch.contact.id)}
                      className="font-medium underline underline-offset-2 hover:no-underline"
                    >
                      {t('viewExisting', { name: dupMatch.contact.name || dupMatch.contact.phone })}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p id="cf-phone-hint" className="text-xs text-muted-foreground">
                {t('phoneHint')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-email">{t('emailLabel')}</Label>
            <Input
              id="cf-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
              }}
              placeholder={t('emailPlaceholder')}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'cf-email-error' : undefined}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            {errors.email && (
              <p id="cf-email-error" role="alert" className="text-xs text-destructive">
                {t(errors.email)}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-company">{t('companyLabel')}</Label>
            <Input
              id="cf-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t('companyPlaceholder')}
              autoComplete="off"
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <p id="cf-tags-label" className="text-sm font-medium leading-none">
              {t('tagsLabel')}
            </p>
            {loadingTags ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="size-3 animate-spin" />
                {t('loadingTags')}
              </div>
            ) : tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('noTagsAvailable')}
              </p>
            ) : (
              // Toggle chips. The tag name and color are user data, so
              // they're shown exactly as stored; the color only tints the
              // chip (dot when off, soft fill + border when on).
              <div
                role="group"
                aria-labelledby="cf-tags-label"
                className="flex flex-wrap gap-2"
              >
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleTag(tag.id)}
                      className={`inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm font-medium text-foreground transition-colors outline-none cursor-pointer focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11 ${
                        selected ? '' : 'border-border bg-transparent hover:bg-muted'
                      }`}
                      style={
                        selected
                          ? { backgroundColor: tag.color + '26', borderColor: tag.color }
                          : undefined
                      }
                    >
                      {selected ? (
                        <Check className="size-3.5 shrink-0" style={{ color: tag.color }} />
                      ) : (
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                      )}
                      <span className="truncate">{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving || checkingDup || (!isEdit && !!dupMatch?.exact)}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('update') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
