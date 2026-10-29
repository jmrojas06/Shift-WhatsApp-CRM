"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  HelpCircle,
  UserPlus,
  FileText,
} from "lucide-react";

import { useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/dashboard/skeleton";
import { cn } from "@/lib/utils";

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS = (t: ReturnType<typeof useTranslations>): Record<FlowRow["status"], string> => ({
  draft: t("statusDraft"),
  active: t("statusActive"),
  archived: t("statusArchived"),
});

const STATUS_COLORS: Record<FlowRow["status"], string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-success/40 bg-success/10 text-success",
  archived: "border-border bg-muted/50 text-muted-foreground",
};

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tGate = useTranslations("GatedButton");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  // True when the first load failed: show an error with a retry instead of
  // the "no flows yet" empty state, which would be a lie.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<FlowRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadFailed(false);
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch("/api/flows"),
          fetch("/api/flows/templates"),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
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
  }, [reloadKey]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("cloneFailedStatus", { status: res.status }));
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    const flow = pendingDelete;
    if (!flow) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      setPendingDelete(null);
      toast.success(t("deleteSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("deleteError"));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    // Skeleton cards shaped like the final grid instead of a bare spinner.
    return (
      <div className="space-y-6" role="status" aria-busy="true">
        <span className="sr-only">{t("loading")}</span>
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-full max-w-lg" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
            <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              {t("beta")}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason={tGate("reasons.createFlows")}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t("newFlow")}
        </GatedButton>
      </header>

      {loadFailed ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center">
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
      ) : flows.length === 0 ? (
        <EmptyState
          onCreate={() => setCreateOpen(true)}
          canCreate={canCreate}
          t={t}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {flows.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onEdit={() => router.push(`/flows/${flow.id}`)}
              onDelete={() => setPendingDelete(flow)}
              t={t}
            />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-4xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("createDesc")}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("startTemplate")}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon] ?? FileText;
                  return (
                    <button
                      key={template.slug}
                      type="button"
                      onClick={() => handleUseTemplate(template.slug)}
                      disabled={creating}
                      className="flex flex-col gap-2.5 rounded-lg border border-border bg-background p-4 text-left transition-colors outline-none hover:border-primary/40 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                    >
                      <Icon className="h-5 w-5 text-primary" aria-hidden />
                      <span className="text-sm font-semibold text-popover-foreground">
                        {template.name}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {template.description}
                      </span>
                      <span className="mt-auto border-t border-border pt-2 text-[11px] text-muted-foreground">
                        {t("nodeCount", { count: template.node_count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("startBlank")}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              aria-label={t("startBlank")}
              placeholder={t("placeholderName")}
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {t("createBlank")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({
  onCreate,
  canCreate,
  t,
}: {
  onCreate: () => void;
  canCreate: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const tGate = useTranslations("GatedButton");
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Workflow className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">
        {t("emptyTitle")}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {t("emptyDesc")}
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason={tGate("reasons.createFlows")}
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        {t("createFirst")}
      </GatedButton>
    </div>
  );
}

function FlowCard({
  flow,
  onEdit,
  onDelete,
  t,
}: {
  flow: FlowRow;
  onEdit: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const triggerSummary = describeTrigger(flow, t);
  const StatusIcon =
    flow.status === "active"
      ? PlayCircle
      : flow.status === "archived"
        ? Archive
        : PauseCircle;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 gap-1 text-[11px]",
            STATUS_COLORS[flow.status],
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {STATUS_LABELS(t)[flow.status]}
        </Badge>
      </div>

      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {flow.description || triggerSummary}
      </p>

      <div className="mt-4 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {t("runCount", { count: flow.execution_count })}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          {t("edit")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("delete")}
        </Button>
      </div>
    </div>
  );
}

function describeTrigger(flow: FlowRow, t: ReturnType<typeof useTranslations>): string {
  if (flow.trigger_type === "keyword") {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return t("triggerKeywordNone");
    return t("triggerKeyword", { keywords: keywords.join(", ") });
  }
  if (flow.trigger_type === "first_inbound_message") {
    return t("triggerFirstInbound");
  }
  return t("triggerManual");
}
