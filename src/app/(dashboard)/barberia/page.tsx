'use client'

// ============================================================
// /barberia — página del vertical de barbería.
//
// Solo visible para cuentas con `vertical_key = 'barberia'` (el
// sidebar ya la oculta para el resto; aquí además se bloquea el
// contenido por si alguien entra por URL directa).
//
// Lee servicios y barberos con el cliente del usuario (RLS: los
// miembros leen) e instala la plantilla contra la API server-only
// con service-role — nunca desde el navegador.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Scissors, Users } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { GatedButton } from '@/components/ui/gated-button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { BARBERIA_TEXTS as T } from '@/verticals/barberia/texts'
import {
  BARBERIA_AI_PROMPT,
  type BarberiaInstallReport,
  type InstallSectionCounts,
} from '@/verticals/barberia/seed'

interface BookingServiceRow {
  id: string
  name: string
  description: string | null
  duration_minutes: number
  price: number | string
  is_active: boolean
}

interface BookingStaffRow {
  id: string
  name: string
  bio: string | null
  is_active: boolean
}

export default function BarberiaPage() {
  const { account, accountId, canEditSettings, defaultCurrency } = useAuth()
  const supabase = createClient()

  const [services, setServices] = useState<BookingServiceRow[]>([])
  const [staff, setStaff] = useState<BookingStaffRow[]>([])
  const [listsLoading, setListsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [report, setReport] = useState<BarberiaInstallReport | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  const isBarberia = account?.vertical_key === 'barberia'

  const load = useCallback(async () => {
    if (!accountId || !isBarberia) return
    setListsLoading(true)
    setLoadFailed(false)
    const [servicesRes, staffRes] = await Promise.all([
      supabase
        .from('booking_services')
        .select('id, name, description, duration_minutes, price, is_active')
        .eq('account_id', accountId)
        .order('position', { ascending: true }),
      supabase
        .from('booking_staff')
        .select('id, name, bio, is_active')
        .eq('account_id', accountId)
        .order('position', { ascending: true }),
    ])
    if (servicesRes.error || staffRes.error) {
      setLoadFailed(true)
    } else {
      setServices((servicesRes.data ?? []) as BookingServiceRow[])
      setStaff((staffRes.data ?? []) as BookingStaffRow[])
    }
    setListsLoading(false)
  }, [accountId, isBarberia, supabase])

  useEffect(() => {
    void load()
  }, [load])

  const handleInstall = useCallback(async () => {
    setInstalling(true)
    setInstallError(null)
    setReport(null)
    try {
      const res = await fetch('/api/verticals/barberia/setup', {
        method: 'POST',
      })
      const payload = (await res.json().catch(() => null)) as {
        report?: BarberiaInstallReport
        error?: string
      } | null
      if (!res.ok || !payload?.report) {
        setInstallError(payload?.error ?? T.installFailed)
      } else {
        setReport(payload.report)
        await load()
      }
    } catch {
      setInstallError(T.installFailed)
    } finally {
      setInstalling(false)
    }
  }, [load])

  // Mientras el contexto de cuenta carga no se puede saber si el
  // vertical aplica; el shell de la app ya muestra el estado de cuenta.
  if (!account) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{T.loading}</p>
      </div>
    )
  }

  if (!isBarberia) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{T.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{T.subtitle}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{T.notEnabledTitle}</CardTitle>
            <CardDescription>{T.notEnabledBody}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const installed = services.length > 0 || staff.length > 0

  const sectionLines: Array<[string, InstallSectionCounts]> = report
    ? [
        [T.sections.services, report.services],
        [T.sections.staff, report.staff],
        [T.sections.staffServices, report.staffServices],
        [T.sections.workingHours, report.workingHours],
        [T.sections.tags, report.tags],
        [T.sections.customFields, report.customFields],
        [T.sections.quickReplies, report.quickReplies],
        [T.sections.knowledge, report.knowledge],
      ]
    : []

  const aiPromptLine = report
    ? report.aiPrompt === 'written'
      ? T.aiPromptWritten
      : report.aiPrompt === 'already_set'
        ? T.aiPromptAlreadySet
        : T.aiPromptNoConfig
    : ''

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{T.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{T.subtitle}</p>
      </div>

      {/* Estado de instalación + botón */}
      <Card>
        <CardHeader>
          <CardTitle>{T.statusTitle}</CardTitle>
          <CardDescription>
            {listsLoading
              ? T.loading
              : installed
                ? T.statusInstalledBody
                : T.statusNotInstalledBody}
          </CardDescription>
          {!listsLoading && (
            <CardAction>
              <Badge variant={installed ? 'default' : 'outline'}>
                {installed ? T.statusInstalled : T.statusNotInstalled}
              </Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {T.servicesCount(services.length)} ·{' '}
              {T.staffCount(staff.length)}
            </span>
            <div className="ml-auto">
              <GatedButton
                canAct={canEditSettings}
                gateReason={T.gateReason}
                onClick={handleInstall}
                disabled={installing}
              >
                {installing && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {installing
                  ? T.installing
                  : installed
                    ? T.reinstallButton
                    : T.installButton}
              </GatedButton>
            </div>
          </div>

          {installError && (
            <Alert variant="destructive">
              <AlertDescription>{installError}</AlertDescription>
            </Alert>
          )}

          {loadFailed && (
            <Alert variant="destructive">
              <AlertDescription>{T.loadError}</AlertDescription>
            </Alert>
          )}

          {/* Resultado de la última instalación */}
          {report && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <p className="text-sm font-medium">{T.reportTitle}</p>
              <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                {sectionLines.map(([label, counts]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span>
                      {counts.created > 0 &&
                        `${counts.created} ${T.createdLabel}`}
                      {counts.created > 0 && counts.skipped > 0 && ' · '}
                      {counts.skipped > 0 &&
                        `${counts.skipped} ${T.skippedLabel}`}
                      {counts.created === 0 && counts.skipped === 0 && '—'}
                    </span>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-4 text-sm sm:col-span-2">
                  <span className="text-muted-foreground">
                    {T.sections.pipeline}
                  </span>
                  <span>
                    {report.pipeline.created
                      ? T.pipelineCreated(report.pipeline.stagesCreated)
                      : T.pipelineSkipped}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-4 text-sm sm:col-span-2">
                  <span className="text-muted-foreground">
                    {T.sections.aiAgent}
                  </span>
                  <span>{aiPromptLine}</span>
                </div>
              </div>

              {report.warnings.length > 0 && (
                <Alert>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {report.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {report.aiPrompt === 'no_config' && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {T.promptSuggestionTitle}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {T.promptSuggestionHint}
                  </p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-3 text-xs">
                    {BARBERIA_AI_PROMPT}
                  </pre>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Servicios y barberos */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{T.servicesTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {listsLoading ? (
              <p className="text-sm text-muted-foreground">{T.loading}</p>
            ) : services.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Scissors className="mb-2 h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {T.servicesEmpty}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {services.map((service) => (
                  <li
                    key={service.id}
                    className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {service.name}
                        {!service.is_active && (
                          <Badge variant="outline" className="ml-2">
                            {T.inactiveLabel}
                          </Badge>
                        )}
                      </p>
                      {service.description && (
                        <p className="text-xs text-muted-foreground">
                          {service.description}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-medium">
                        {formatCurrency(Number(service.price), defaultCurrency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {T.minutes(service.duration_minutes)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{T.staffTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {listsLoading ? (
              <p className="text-sm text-muted-foreground">{T.loading}</p>
            ) : staff.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Users className="mb-2 h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{T.staffEmpty}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {staff.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {member.name}
                        {!member.is_active && (
                          <Badge variant="outline" className="ml-2">
                            {T.inactiveLabel}
                          </Badge>
                        )}
                      </p>
                      {member.bio && (
                        <p className="text-xs text-muted-foreground">
                          {member.bio}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
