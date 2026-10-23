"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadError } from "./load-error";
import { ReadOnlyNote } from "./readonly-note";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import type { QuickReply, QuickReplyKind } from "@/types";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  content_text: string;
  interactive_payload: InteractiveMessagePayload;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    content_text: "",
    interactive_payload: blankButtonsPayload(),
  };
}

export function QuickRepliesManager() {
  const t = useTranslations("Settings.quickReplies");
  const tReadOnly = useTranslations("Settings.readOnly");
  const { profileLoading } = useAuth();
  // The API takes writes from agents up (viewers are read-only).
  const canWrite = useCan("send-messages");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  // Reply waiting for the "delete it?" confirmation.
  const [toDelete, setToDelete] = useState<QuickReply | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
      else setLoadFailed(true);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (qr: QuickReply) =>
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      content_text: qr.content_text ?? "",
      interactive_payload:
        qr.interactive_payload ?? blankButtonsPayload(),
    });

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    const payload =
      draft.kind === "interactive"
        ? { title: draft.title, kind: "interactive", interactive_payload: draft.interactive_payload }
        : { title: draft.title, kind: "text", content_text: draft.content_text };

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t("saveError"));
        return;
      }
      toast.success(draft.id ? t("updated") : t("created"));
      setDraft(null);
      await load();
    } catch {
      toast.error(t("saveError"));
    } finally {
      setSaving(false);
    }
  }, [draft, load, t]);

  // Runs from the confirmation dialog; a failed request (including a
  // network error) now reports instead of failing silently.
  const remove = useCallback(async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/quick-replies/${toDelete.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("deleteError"));
        return;
      }
      setToDelete(null);
      await load();
    } catch {
      toast.error(t("deleteError"));
    } finally {
      setDeleting(false);
    }
  }, [toDelete, load, t]);

  return (
    <div>
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={
          <Button onClick={openCreate} disabled={!canWrite}>
            <Plus className="mr-1 h-4 w-4" />
            {t("new")}
          </Button>
        }
      />

      {!canWrite && !profileLoading && (
        <ReadOnlyNote className="mb-4">{tReadOnly("quickReplies")}</ReadOnlyNote>
      )}

      {loadFailed && !loading ? (
        <LoadError message={t("loadFailed")} onRetry={() => void load()} />
      ) : loading ? (
        // Skeleton rows shaped like the list (icon, name, preview line).
        <ul role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t("loading")}</span>
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              aria-hidden
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              <span className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-muted" />
              <span className="min-w-0 flex-1 space-y-2">
                <span className="block h-3 w-32 animate-pulse rounded-full bg-muted" />
                <span className="block h-3 w-56 max-w-full animate-pulse rounded-full bg-muted" />
              </span>
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((qr) => (
            <li
              key={qr.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {qr.kind === "interactive" ? (
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : (
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{qr.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {qr.kind === "interactive" && qr.interactive_payload
                    ? interactivePayloadPreviewText(qr.interactive_payload)
                    : qr.content_text}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => openEdit(qr)}
                  disabled={!canWrite}
                  aria-label={t("editLabel", { name: qr.title })}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setToDelete(qr)}
                  disabled={!canWrite}
                  aria-label={t("deleteLabel", { name: qr.title })}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("edit") : t("new")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <div>
                <Label htmlFor="qr-name" className="mb-2">
                  {t("nameLabel")}
                </Label>
                <Input
                  id="qr-name"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder={t("namePlaceholder")}
                />
              </div>
              <div role="group" aria-label={t("kindLabel")} className="flex gap-2">
                <KindTab
                  active={draft.kind === "text"}
                  label={t("kindText")}
                  onClick={() => setDraft({ ...draft, kind: "text" })}
                />
                <KindTab
                  active={draft.kind === "interactive"}
                  label={t("kindInteractive")}
                  onClick={() => setDraft({ ...draft, kind: "interactive" })}
                />
              </div>
              {draft.kind === "text" ? (
                <div>
                  <Label htmlFor="qr-text" className="mb-2">
                    {t("messageLabel")}
                  </Label>
                  <Textarea
                    id="qr-text"
                    value={draft.content_text}
                    onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                    placeholder={t("textPlaceholder")}
                    className="min-h-28"
                  />
                </div>
              ) : (
                <InteractiveBuilder
                  value={draft.interactive_payload}
                  onChange={(p) => setDraft({ ...draft, interactive_payload: p })}
                />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={t("deleteTitle")}
        description={t("deleteDesc", { name: toDelete?.title ?? "" })}
        confirmLabel={t("delete")}
        busyLabel={t("deleting")}
        cancelLabel={t("cancel")}
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}

function KindTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11 " +
        (active
          ? "border-primary bg-primary-soft text-primary"
          : "border-border bg-muted text-muted-foreground hover:text-foreground")
      }
    >
      {label}
    </button>
  );
}
