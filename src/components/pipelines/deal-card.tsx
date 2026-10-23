"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useFormatter, useTranslations } from "next-intl";
import { calendarDateForFormat } from "./deal-utils";

interface DealCardProps {
  deal: Deal;
  /** Kept for callers; the stage color now lives on the column header. */
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const format = useFormatter();
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  function formatCloseDate(value: string) {
    const { date, timeZone } = calendarDateForFormat(value);
    return format.dateTime(date, {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(timeZone ? { timeZone } : {}),
    });
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border bg-card px-3 py-3 text-left shadow-(--shadow-card) outline-none transition-[transform,box-shadow,border-color] duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 ${
        isOverlay
          ? "shadow-lg"
          : "hover:-translate-y-px hover:border-input"
      }`}
    >
      {/* Only phrasing content (spans) is valid inside a <button>. */}
      <span className="flex items-start justify-between gap-2">
        <span className="block min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground break-words">
          {deal.title}
        </span>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
            <Check aria-hidden className="size-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
            <X aria-hidden className="size-3" />
            {t("lost")}
          </span>
        )}
      </span>

      {/* Contact row */}
      <span className="mt-2 flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-foreground"
        >
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className="truncate text-xs text-muted-foreground">{contactLabel}</span>
      </span>

      <span className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="font-heading text-sm font-semibold tabular-nums text-foreground">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar aria-hidden className="size-3" />
            {formatCloseDate(deal.expected_close_date)}
          </span>
        )}
      </span>

      {assigneeLabel && (
        <span className="mt-2 flex items-center justify-end">
          <span
            aria-hidden
            title={assigneeLabel}
            className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initials(assigneeLabel)}
          </span>
          <span className="sr-only">{t("assignedTo", { name: assigneeLabel })}</span>
        </span>
      )}
    </button>
  );
}
