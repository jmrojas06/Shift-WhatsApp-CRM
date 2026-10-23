"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { Automation } from "@/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { triggerMeta, formatRelative, isKnownTrigger } from "@/lib/automations/trigger-meta"
import { cn } from "@/lib/utils"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

export default function AutomationsPage() {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const tGate = useTranslations("GatedButton")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"))
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: Automation) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    )
  }

  if (automations === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  const showTemplates = automations.length < 3

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason={tGate("reasons.createAutomations")}
          onClick={() => router.push("/automations/new")}
        >
          <Plus className="h-4 w-4" />
          {t("create")}
        </GatedButton>
      </div>

      {automations.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted">
            <Zap className="size-6 text-muted-foreground" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-[15px] font-semibold text-foreground">{t("emptyTitle")}</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {t("emptyDesc")}
          </p>
        </div>
      )}

      {showTemplates && (
        <section aria-labelledby="automation-templates-title">
          <h2
            id="automation-templates-title"
            className="mb-3 text-[15px] font-semibold text-foreground"
          >
            {t("templatesTitle")}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {TEMPLATE_ORDER.map((slug) => {
              const t = AUTOMATION_TEMPLATES[slug]
              const Icon = TEMPLATE_ICON[slug]
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => startFromTemplate(slug)}
                  className="group flex min-h-11 min-w-0 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-(--shadow-card) transition-colors outline-none hover:border-input hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
                    <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{t.name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {automations.length > 0 && (
        <ul className="space-y-3">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              onToggle={(next) => toggleActive(a, next)}
              onEdit={() => router.push(`/automations/${a.id}/edit`)}
              onDuplicate={() => duplicate(a)}
              onLogs={() => router.push(`/automations/${a.id}/logs`)}
              onDelete={() => setPendingDelete(a)}
              t={t}
            />
          ))}
        </ul>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
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
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AutomationCard({
  automation,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
  t,
}: {
  automation: Automation
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const tTriggers = useTranslations("Automations.builder.triggers")
  const tRelative = useTranslations("Automations.relative")
  const meta = triggerMeta(automation.trigger_type)
  const triggerLabel = isKnownTrigger(automation.trigger_type)
    ? tTriggers(`${automation.trigger_type}.label`)
    : automation.trigger_type
  return (
    <li className="rounded-xl border border-border bg-card shadow-(--shadow-card) transition-colors hover:border-input">
      <div className="flex items-center gap-3 p-4 sm:gap-4">
        <div
          className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-muted sm:flex"
          aria-hidden
        >
          <Zap
            className={cn(
              "size-5",
              automation.is_active ? "text-primary" : "text-muted-foreground",
            )}
          />
        </div>

        <button
          type="button"
          onClick={onEdit}
          className="min-w-0 flex-1 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">
              {automation.name}
            </span>
            {automation.is_active && (
              <span className="inline-flex size-2 shrink-0 rounded-full bg-success">
                <span className="sr-only">{t("activeIndicator")}</span>
              </span>
            )}
          </div>
          {automation.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{automation.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                meta.pillClass,
              )}
            >
              {triggerLabel}
            </span>
            <span className="tabular-nums">
              {t("runs", { count: automation.execution_count })}
            </span>
            <span aria-hidden>·</span>
            <span>{t("lastRun", { time: formatRelative(automation.last_executed_at, tRelative) })}</span>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <span className="flex size-11 items-center justify-center sm:size-auto">
            <Switch
              checked={automation.is_active}
              onCheckedChange={(v) => onToggle(!!v)}
              aria-label={automation.is_active ? t("deactivate") : t("activate")}
            />
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("openMenu")}
              className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:bg-muted pointer-coarse:size-11"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-44">
              <DropdownMenuItem onClick={onEdit} className="pointer-coarse:min-h-11">
                <Pencil className="h-4 w-4" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate} className="pointer-coarse:min-h-11">
                <Copy className="h-4 w-4" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogs} className="pointer-coarse:min-h-11">
                <FileText className="h-4 w-4" />
                {t("viewLogs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={onDelete}
                className="pointer-coarse:min-h-11"
              >
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  )
}
