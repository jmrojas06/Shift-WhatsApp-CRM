"use client";

import { useId, useMemo, useState } from "react";
import type { Deal, PipelineStage } from "@/types";
import { ChevronDown, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * Weighted pipeline value: value × per-stage probability.
 * First stage ≈ 10%, stages interpolate up to 90% before the final stage,
 * final stage (Won) = 100%. Lost deals excluded.
 */
function computeStageProbability(
  stage: PipelineStage,
  sortedStages: PipelineStage[],
): number {
  const n = sortedStages.length;
  if (n <= 1) return 1;
  const index = sortedStages.findIndex((s) => s.id === stage.id);
  if (index < 0) return 0;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  const t = index / (slots - 1);
  return 0.1 + t * (0.9 - 0.1);
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const { defaultCurrency } = useAuth();
  // Only affects mobile: on sm+ the metrics are always shown.
  const [expanded, setExpanded] = useState(false);
  const metricsId = useId();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    const active = deals.filter((d) => d.status !== "lost");
    const openDeals = active.filter((d) => d.status !== "won");

    const totalCount = active.length;
    const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0);
    const avgValue = totalCount > 0 ? totalValue / totalCount : 0;

    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    const weightedValue = openDeals.reduce((sum, d) => {
      const stage = stageById.get(d.stage_id);
      if (!stage) return sum;
      const prob = computeStageProbability(stage, sortedStages);
      return sum + Number(d.value || 0) * prob;
    }, 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = (d: Deal) => {
      const ts = d.updated_at ?? d.created_at;
      return ts ? new Date(ts) >= monthStart : false;
    };
    const wonThisMonth = deals.filter(
      (d) => d.status === "won" && thisMonth(d),
    ).length;
    const lostThisMonth = deals.filter(
      (d) => d.status === "lost" && thisMonth(d),
    ).length;

    return {
      totalCount,
      totalValue,
      avgValue,
      weightedValue,
      wonThisMonth,
      lostThisMonth,
    };
  }, [deals, sortedStages]);

  return (
    <TooltipProvider>
      <section
        aria-label={t("sectionLabel")}
        className="rounded-xl border border-border bg-card shadow-(--shadow-card)"
      >
        {/* Mobile: metrics start folded so the board stays on the first
            screen. The toggle keeps the two headline numbers visible. */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={metricsId}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-4 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:hidden"
        >
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">
            {t("summary", {
              count: stats.totalCount,
              value: formatCurrency(stats.totalValue, defaultCurrency),
            })}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-foreground">
            {expanded ? t("hideMetrics") : t("showMetrics")}
            <ChevronDown
              aria-hidden
              className={`size-4 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            />
          </span>
        </button>

        <dl
          id={metricsId}
          className={`${expanded ? "grid" : "hidden"} grid-cols-2 gap-x-4 gap-y-3 border-t border-border p-4 sm:grid sm:grid-cols-3 sm:border-t-0 xl:grid-cols-6`}
        >
          <Metric
            label={t("totalDeals")}
            value={String(stats.totalCount)}
            tooltip={t("totalDealsTooltip")}
            t={t}
          />
          <Metric
            label={t("pipelineValue")}
            value={formatCurrency(stats.totalValue, defaultCurrency)}
            tooltip={t("pipelineValueTooltip")}
            t={t}
          />
          <Metric
            label={t("avgDealSize")}
            value={formatCurrency(stats.avgValue, defaultCurrency)}
            tooltip={t("avgDealSizeTooltip")}
            t={t}
          />
          <Metric
            label={t("weightedValue")}
            value={formatCurrency(stats.weightedValue, defaultCurrency)}
            tooltip={t("weightedValueTooltip")}
            t={t}
          />
          <Metric
            label={t("wonThisMonth")}
            value={String(stats.wonThisMonth)}
            tooltip={t("wonThisMonthTooltip")}
            t={t}
          />
          <Metric
            label={t("lostThisMonth")}
            value={String(stats.lostThisMonth)}
            tooltip={t("lostThisMonthTooltip")}
            t={t}
          />
        </dl>
      </section>
    </TooltipProvider>
  );
}

function Metric({
  label,
  value,
  tooltip,
  t,
}: {
  label: string;
  value: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[13px] text-muted-foreground">
        <span className="truncate">{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("howCalculated", { label })}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:size-8"
              />
            }
          >
            <Info aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </dt>
      <dd className="truncate font-heading text-lg font-semibold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
