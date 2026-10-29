"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  CircleCheck,
  CircleAlert,
  Clock,
  UserPlus,
  PlayCircle,
  PauseCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { useFormatter, useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRunDuration } from "@/components/flows/run-duration";
import { cn } from "@/lib/utils";

/**
 * Run history viewer.
 *
 * Lists the 50 most recent runs for a flow, newest first. Each row
 * collapses to a one-liner (contact + status + time); expanding shows
 * the full `flow_run_events` timeline for that run — useful for
 * debugging "why didn't my flow advance?" by surfacing the engine's
 * own log.
 */

interface RunRow {
  id: string;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed";
  current_node_key: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  contact: { id: string; name: string | null; phone: string } | null;
}

interface EventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const STATUS_META: Record<
  RunRow["status"],
  { classes: string; icon: typeof Clock }
> = {
  active: {
    classes: "border-success/40 bg-success/10 text-success",
    icon: PlayCircle,
  },
  completed: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: CircleCheck,
  },
  handed_off: {
    classes: "border-warning/40 bg-warning/10 text-warning",
    icon: UserPlus,
  },
  timed_out: {
    classes: "border-border bg-muted/60 text-muted-foreground",
    icon: Clock,
  },
  paused_by_agent: {
    classes: "border-border bg-muted text-muted-foreground",
    icon: PauseCircle,
  },
  failed: {
    classes: "border-destructive/40 bg-destructive/10 text-destructive",
    icon: CircleAlert,
  },
};

export default function FlowRunsPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("Flows.logs");
  const tEdit = useTranslations("Flows.edit");

  const [flow, setFlow] = useState<{ id: string; name: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notFound, setNotFound] = useState(false);
  // A real load failure (network/500) is not "flow not found".
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      setLoadFailed(false);
      try {
        const res = await fetch(`/api/flows/${params.id}/runs`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: { id: string; name: string };
          runs: RunRow[];
          events: EventRow[];
        };
        if (!cancelled) {
          setFlow(json.flow);
          setRuns(json.runs ?? []);
          setEvents(json.events ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id, reloadKey]);

  function toggle(runId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">{t("loading")}</span>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
        >
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{tEdit("notFound")}</p>
        <Link
          href="/flows"
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {tEdit("backToFlows")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={`/flows/${flow.id}`}
        className="mb-2 inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
      >
        <ArrowLeft className="h-3 w-3" aria-hidden />
        {flow.name}
      </Link>
      <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("description")}
      </p>

      {runs.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center text-sm text-muted-foreground">
          {t("emptyState")}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2">
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              events={events.filter((e) => e.flow_run_id === run.id)}
              expanded={expanded.has(run.id)}
              onToggle={() => toggle(run.id)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({
  run,
  events,
  expanded,
  onToggle,
  t,
}: {
  run: RunRow;
  events: EventRow[];
  expanded: boolean;
  onToggle: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const format = useFormatter();
  const locale = useLocale();
  const uid = useId();
  const panelId = `${uid}-events`;
  const meta = STATUS_META[run.status];
  const StatusIcon = meta.icon;
  const contactLabel =
    run.contact?.name?.trim() || run.contact?.phone || t("unknownContact");
  // How long the run lasted (start → end), not how long ago it ended.
  const duration = formatRunDuration(run.started_at, run.ended_at, locale);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {contactLabel}
            </span>
            <Badge variant="outline" className={cn("gap-1", meta.classes)}>
              <StatusIcon className="h-3 w-3" aria-hidden />
              {t(
                run.status === "active"
                  ? "statusActive"
                  : run.status === "completed"
                  ? "statusCompleted"
                  : run.status === "handed_off"
                  ? "statusHandedOff"
                  : run.status === "timed_out"
                  ? "statusTimedOut"
                  : run.status === "paused_by_agent"
                  ? "statusPaused"
                  : "statusFailed"
              )}
            </Badge>
            {run.status === "active" && run.current_node_key && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("atNode", { node: run.current_node_key })}
              </code>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {t("started", {
                time: format.dateTime(new Date(run.started_at), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </span>
            {run.reprompt_count > 0 && (
              <span>· {t("repromptsCount", { count: run.reprompt_count })}</span>
            )}
            {duration && <span className="tabular-nums">· {t("ranFor", { duration })}</span>}
          </div>
        </div>
      </button>
      {expanded && (
        <div id={panelId} className="border-t border-border px-4 py-3">
          {Object.keys(run.vars).length > 0 && (
            <details className="mb-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("capturedVars", { count: Object.keys(run.vars).length })}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 text-[11px] text-muted-foreground">
                {JSON.stringify(run.vars, null, 2)}
              </pre>
            </details>
          )}
          <div className="flex flex-col gap-1">
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("noEvents")}
              </p>
            ) : (
              events.map((ev, ix) => <EventLine key={ix} ev={ev} t={t} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const EVENT_COLOR: Record<string, string> = {
  started: "text-success",
  node_entered: "text-muted-foreground",
  message_sent: "text-info",
  reply_received: "text-primary",
  fallback_fired: "text-warning",
  handoff: "text-warning",
  timeout: "text-muted-foreground",
  error: "text-destructive",
  completed: "text-success",
};

function EventLine({
  ev,
  t,
}: {
  ev: EventRow;
  t: ReturnType<typeof useTranslations>;
}) {
  const format = useFormatter();
  const cls = EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
  const summary = Object.keys(ev.payload).length > 0 ? summarizePayload(ev.payload) : "";
  // Wraps on phones (two fixed 8rem columns alone overflowed 375px); keeps
  // the aligned columns from `sm` up.
  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded-md px-2 py-1 text-xs">
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums sm:w-32">
        {format.dateTime(new Date(ev.created_at), {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </span>
      <span className={cn("shrink-0 text-[11px] font-medium sm:w-32", cls)}>
        {Object.hasOwn(EVENT_COLOR, ev.event_type)
          ? t(`eventTypes.${ev.event_type}`)
          : ev.event_type}
      </span>
      {ev.node_key && (
        <code className="max-w-full shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] break-all text-muted-foreground">
          {ev.node_key}
        </code>
      )}
      {summary && (
        <span className="min-w-0 basis-full text-[11px] break-all text-muted-foreground sm:basis-auto sm:flex-1">
          {summary}
        </span>
      )}
    </div>
  );
}

function summarizePayload(payload: Record<string, unknown>): string {
  // Show the keys that matter most to a human debugger; full JSON is
  // available via the "Captured vars" details panel for the run.
  const keys = ["reply_id", "captured_key", "reason", "advancing_to"];
  for (const k of keys) {
    if (k in payload && payload[k] !== null && payload[k] !== undefined) {
      return `${k}=${String(payload[k]).slice(0, 80)}`;
    }
  }
  return "";
}
