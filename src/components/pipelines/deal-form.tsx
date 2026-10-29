"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import type {
  Contact,
  Conversation,
  Deal,
  DealStatus,
  PipelineStage,
  Profile,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { contactMatchesQuery, contactOptionLabel } from "./deal-utils";

// Native selects styled like the Input primitive (40 px, 44 px on touch).
const SELECT_CLASS =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-muted px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive pointer-coarse:h-11";

type RequiredField = "title" | "contact" | "stage";

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  onSaved,
}: DealFormProps) {
  const t = useTranslations("Pipelines.form");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // False until the contact list answers, so the picker can say "loading"
  // instead of "no matches".
  const [contactsLoaded, setContactsLoaded] = useState(false);
  // Required-field messages show only after a save attempt.
  const [showErrors, setShowErrors] = useState(false);

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setShowErrors(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId("");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
    }
  }, [open, deal, defaultStageId, stages, defaultCurrency]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [c, p] = await Promise.all([
        supabase.from("contacts").select("*").order("name"),
        supabase.from("profiles").select("*").order("full_name"),
      ]);
      if (cancelled) return;
      setContacts((c.data ?? []) as Contact[]);
      setProfiles((p.data ?? []) as Profile[]);
      setContactsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("contact_id", contactId)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLinkedConversation((data as Conversation | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, supabase]);

  const missing: RequiredField[] = [
    ...(!title.trim() ? (["title"] as const) : []),
    ...(!contactId ? (["contact"] as const) : []),
    ...(!stageId ? (["stage"] as const) : []),
  ];
  const fieldError = (field: RequiredField) =>
    showErrors && missing.includes(field);

  // The picker works with the Contact object; only its id is saved.
  const selectedContact = contacts.find((c) => c.id === contactId) ?? null;
  const contactEmptyText = !contactsLoaded
    ? t("loadingContacts")
    : contacts.length === 0
      ? t("noContactsYet")
      : t("noContactMatches");

  async function handleSave() {
    if (missing.length > 0) {
      // Point at the fields instead of a generic toast.
      setShowErrors(true);
      document.getElementById(`deal-${missing[0]}`)?.focus();
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
    };

    if (deal) {
      const { error } = await supabase
        .from("deals")
        .update(payload)
        .eq("id", deal.id);
      if (error) {
        toast.error(t("toastFailedSave"));
        setSaving(false);
        return;
      }
    } else {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t("toastNotSignedIn"));
        setSaving(false);
        return;
      }
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { error } = await supabase
        .from("deals")
        .insert({ ...payload, user_id: user.id, account_id: accountId, status: "open" });
      if (error) {
        toast.error(t("toastFailedCreate"));
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await supabase
      .from("deals")
      .update({ status })
      .eq("id", deal.id);
    setStatusAction(null);
    if (error) {
      toast.error(t("toastFailedStatus"));
      return;
    }
    toast.success(
      status === "won" ? t("toastMarkedWon") : status === "lost" ? t("toastMarkedLost") : t("toastReopened"),
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await supabase.from("deals").delete().eq("id", deal.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? t("editDeal") : t("newDeal")}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="deal-title">
                {t("title")}
                <span className="font-normal text-muted-foreground">
                  ({t("requiredMark")})
                </span>
              </Label>
              <Input
                id="deal-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("titlePlaceholder")}
                autoComplete="off"
                aria-invalid={fieldError("title") || undefined}
                aria-describedby={fieldError("title") ? "deal-title-error" : undefined}
                className="border-border bg-muted text-foreground"
              />
              {fieldError("title") && (
                <p id="deal-title-error" role="alert" className="text-xs text-destructive">
                  {t("titleRequired")}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-contact">
                {t("contact")}
                <span className="font-normal text-muted-foreground">
                  ({t("requiredMark")})
                </span>
              </Label>
              <Combobox
                id="deal-contact"
                items={contacts}
                value={selectedContact}
                onValueChange={(c) => setContactId(c?.id ?? "")}
                getItemKey={(c) => c.id}
                getItemLabel={contactOptionLabel}
                getItemDescription={(c) => (c.name ? c.phone : c.email)}
                filter={contactMatchesQuery}
                placeholder={t("searchContactPlaceholder")}
                emptyText={contactEmptyText}
                triggerLabel={t("showContacts")}
                clearLabel={t("clearContact")}
                invalid={fieldError("contact")}
                aria-describedby={fieldError("contact") ? "deal-contact-error" : undefined}
                className="border-border bg-muted"
              />
              {fieldError("contact") && (
                <p id="deal-contact-error" role="alert" className="text-xs text-destructive">
                  {t("contactRequired")}
                </p>
              )}

              {linkedConversation && (
                <Link
                  href="/inbox"
                  className="mt-1 inline-flex min-h-8 items-center gap-1.5 self-start rounded-lg bg-primary/10 px-2.5 text-xs text-primary outline-none hover:bg-primary/20 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
                >
                  <MessageSquare aria-hidden className="size-3.5" />
                  {t("linkToConversation")}
                </Link>
              )}
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="deal-value">{t("value")}</Label>
                <Input
                  id="deal-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0"
                  className="border-border bg-muted text-foreground tabular-nums"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="deal-currency">{t("currency")}</Label>
                <select
                  id="deal-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className={SELECT_CLASS}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-close-date">{t("expectedCloseDate")}</Label>
              <Input
                id="deal-close-date"
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-stage">
                {t("stage")}
                <span className="font-normal text-muted-foreground">
                  ({t("requiredMark")})
                </span>
              </Label>
              <select
                id="deal-stage"
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                aria-invalid={fieldError("stage") || undefined}
                aria-describedby={fieldError("stage") ? "deal-stage-error" : undefined}
                className={SELECT_CLASS}
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {fieldError("stage") && (
                <p id="deal-stage-error" role="alert" className="text-xs text-destructive">
                  {t("stageRequired")}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-assignee">{t("assignedTo")}</Label>
              <select
                id="deal-assignee"
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">{t("unassigned")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="deal-notes">{t("notes")}</Label>
              <Textarea
                id="deal-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("notesPlaceholder")}
                className="min-h-[100px] border-border bg-muted text-foreground"
              />
            </div>

            {deal && (
              <div className="space-y-2 rounded-xl border border-border bg-muted/50 p-3">
                <p className="text-[13px] font-medium text-muted-foreground">
                  {t("status")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {/* Outline/soft so the footer's save stays the only
                      primary button in the sheet. */}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="min-w-32 flex-1 border-border text-success hover:text-success"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <>
                        <Check aria-hidden className="size-4" />
                        {t("markAsWon")}
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => handleStatusChange("lost")}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="min-w-32 flex-1"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <>
                        <X aria-hidden className="size-4" />
                        {t("markAsLost")}
                      </>
                    )}
                  </Button>
                </div>
                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    {t("reopenDeal")}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border bg-popover p-4">
            {/* Says what's missing instead of a silently disabled button. */}
            {showErrors && missing.length > 0 && (
              <p role="alert" className="mb-3 text-xs text-destructive">
                {t("missingFields", {
                  fields: missing.map((f) => t(f)).join(", "),
                })}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex-1"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                {saving ? t("saving") : deal ? t("saveChanges") : t("createDeal")}
              </Button>
            </div>

            {deal &&
              (confirmDelete ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
                  <span className="text-destructive">{t("deletePrompt")}</span>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                    >
                      {t("cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting ? t("deleting") : t("deleteDeal")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                  {t("deleteDeal")}
                </Button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
