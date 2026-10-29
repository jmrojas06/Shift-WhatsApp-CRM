"use client";

import { List, Reply } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list message shows the same way it does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). The three fallback labels shown
 * for empty fields come from the `Interactive` catalogue in the UI
 * language; a host can still override them via `labels`.
 */
export interface InteractivePreviewLabels {
  /** Shown in place of an empty body. */
  body?: string;
  /** Shown in place of an untitled reply button. */
  button?: string;
  /** Shown in place of an empty list button label. */
  menu?: string;
}

export function InteractivePreview({
  payload,
  className,
  labels,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
  labels?: InteractivePreviewLabels;
}) {
  const t = useTranslations("Interactive");
  const bodyLabel = labels?.body ?? t("previewBody");
  const buttonLabel = labels?.button ?? t("previewButton");
  const menuLabel = labels?.menu ?? t("previewMenu");
  return (
    <div
      className={cn(
        "w-full max-w-[260px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border",
        className,
      )}
    >
      <div className="px-3 py-2">
        {payload.header ? (
          <p className="mb-1 break-words text-sm font-semibold">
            {payload.header}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-sm">
          {payload.body || (
            <span className="text-muted-foreground">{bodyLabel}</span>
          )}
        </p>
        {payload.footer ? (
          <p className="mt-1 break-words text-[11px] text-muted-foreground">
            {payload.footer}
          </p>
        ) : null}
      </div>

      {payload.kind === "buttons" ? (
        <div className="flex flex-col border-t border-border">
          {payload.buttons.map((b, i) => (
            <button
              key={b.id || i}
              type="button"
              disabled
              className="flex items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary first:border-t-0"
            >
              <Reply className="h-3.5 w-3.5" aria-hidden />
              <span className="truncate">{b.title || buttonLabel}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          disabled
          className="flex w-full items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary"
        >
          <List className="h-3.5 w-3.5" aria-hidden />
          <span className="truncate">{payload.button_label || menuLabel}</span>
        </button>
      )}
    </div>
  );
}
