'use client'

// ============================================================
// /agenda — página del vertical de la agenda (citas).
//
// Solo visible para cuentas con el módulo agenda (`modules` o, mientras
// esté vacío, `vertical_key` 'agenda' / 'barberia'); el sidebar ya la oculta para el resto y
// aquí además se bloquea el contenido por si alguien entra por URL
// directa.
//
// Lee servicios, equipo y palabras del negocio con el cliente del
// usuario (RLS: los miembros leen) e instala el tipo de negocio contra
// la API server-only con service-role — nunca desde el navegador.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  BellRing,
  CalendarDays,
  CalendarX,
  Check,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Settings2,
  UserX,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { hasModule } from '@/lib/verticals/registry'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { GatedButton } from '@/components/ui/gated-button'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

import { DEFAULT_LABELS, readLabels, type AgendaLabels } from '@/verticals/agenda/labels'
import {
  appointmentAnswerLines,
  hasAnswerEntries,
  isAgendaInstalled,
  isMissingMigrationError,
  suggestedAiPrompt,
} from '@/verticals/agenda/panel'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'
import type { AppointmentStatus } from '@/verticals/agenda/appointments'
import {
  formatDayLabel,
  formatLongDate,
  formatTimeLabel,
} from '@/verticals/agenda/agent/format'
import { pickDueReminder } from '@/verticals/agenda/agent/reminders'
import {
  addDaysToKey,
  startOfZonedDay,
  zonedDateKey,
  zonedParts,
} from '@/verticals/agenda/agent/time'
import { isPresetKey } from '@/verticals/agenda/presets'
import {
  type AgendaInstallReport,
  type InstallSectionCounts,
} from '@/verticals/agenda/seed'

import { agendaConfigApi } from './configuracion/_components/api'
import { ModuleNotEnabled } from './_components/module-not-enabled'
import { SetupWizard } from './_components/setup-wizard'

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

interface AppointmentRow {
  id: string
  starts_at: string
  status: string
  service_id: string | null
  staff_id: string | null
  contact_id: string | null
  /** jsonb: `{ [idPregunta]: { label, value } }` o, en citas viejas, texto plano. */
  answers: unknown
}

interface ReminderAppointmentRow extends AppointmentRow {
  reminder_sent_at: string | null
  reminder_2h_sent_at: string | null
}

interface ReminderItem {
  id: string
  startsAt: string
  serviceName: string | null
  staffName: string | null
  contactName: string | null
  contactPhone: string | null
  /** Señal que el runner enviaría ahora mismo (o null). */
  pendingKind: 'h24' | 'h2' | null
  sent24At: string | null
  sent2hAt: string | null
}

interface AgendaAppointment {
  id: string
  starts_at: string
  status: AppointmentStatus
  serviceName: string | null
  staffName: string | null
  contactName: string | null
  contactPhone: string | null
  /** Respuestas a las preguntas extra, ya con su etiqueta ("Placa: ABC123"). */
  answerLines: string[]
}

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: T.agendaStatusPending,
  confirmed: T.agendaStatusConfirmed,
  completed: T.agendaStatusCompleted,
  no_show: T.agendaStatusNoShow,
  cancelled: T.agendaStatusCancelled,
}

const STATUS_BADGE_VARIANTS: Record<
  AppointmentStatus,
  'success' | 'secondary' | 'outline' | 'destructive' | 'warning'
> = {
  pending: 'warning',
  confirmed: 'success',
  completed: 'secondary',
  no_show: 'destructive',
  cancelled: 'outline',
}

/** Estados desde los que la agenda permite actuar. */
const EDITABLE_STATUSES: readonly AppointmentStatus[] = ['pending', 'confirmed']

export default function AgendaPage() {
  const { account, accountId, canEditSettings, canSendMessages, defaultCurrency } =
    useAuth()
  const router = useRouter()
  const supabase = createClient()

  const [services, setServices] = useState<BookingServiceRow[]>([])
  const [staff, setStaff] = useState<BookingStaffRow[]>([])
  const [listsLoading, setListsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  // La base no tiene aún las columnas/tablas de la migración 051.
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [labels, setLabels] = useState<AgendaLabels>({ ...DEFAULT_LABELS })
  const [presetKey, setPresetKey] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [report, setReport] = useState<AgendaInstallReport | null>(null)
  // "Tu agenda está lista" solo tras elegir el tipo en el asistente, no al reinstalar.
  const [reportFromWizard, setReportFromWizard] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const [appointments, setAppointments] = useState<AgendaAppointment[]>([])
  const [agendaLoading, setAgendaLoading] = useState(true)
  const [agendaFailed, setAgendaFailed] = useState(false)
  const [agendaError, setAgendaError] = useState<string | null>(null)
  const [changingId, setChangingId] = useState<string | null>(null)
  const [pastPrompt, setPastPrompt] = useState<{
    appointment: AgendaAppointment
    status: AppointmentStatus
  } | null>(null)
  // "Cancelar cita" no se puede deshacer: se confirma antes de enviar.
  const [cancelPrompt, setCancelPrompt] = useState<AgendaAppointment | null>(
    null,
  )

  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [remindersTwoHour, setRemindersTwoHour] = useState(false)
  const [remindersOn, setRemindersOn] = useState(true)
  const [remindersLoading, setRemindersLoading] = useState(true)
  const [remindersFailed, setRemindersFailed] = useState(false)

  const isAgenda = hasModule(account, 'agenda')
  /** Owner/admin/agent mueven citas; viewer es solo-lectura. */
  const canManageAppointments = canSendMessages

  const load = useCallback(async () => {
    if (!accountId || !isAgenda) return
    setListsLoading(true)
    setLoadFailed(false)
    const [servicesRes, staffRes, settingsRes] = await Promise.all([
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
      supabase
        .from('booking_settings')
        .select('labels, preset_key')
        .eq('account_id', accountId)
        .maybeSingle(),
    ])
    if (servicesRes.error || staffRes.error || settingsRes.error) {
      setMigrationMissing(isMissingMigrationError(settingsRes.error))
      setLoadFailed(true)
    } else {
      setMigrationMissing(false)
      setServices((servicesRes.data ?? []) as BookingServiceRow[])
      setStaff((staffRes.data ?? []) as BookingStaffRow[])
      const settingsRow = settingsRes.data as {
        labels: unknown
        preset_key: string | null
      } | null
      // Lectura tolerante: una palabra mala en la base vuelve a la de por defecto.
      setLabels(readLabels(settingsRow?.labels))
      setPresetKey(settingsRow?.preset_key ?? null)
    }
    setListsLoading(false)
  }, [accountId, isAgenda, supabase])

  /**
   * Agenda del día en America/Bogota: ventana [inicio del día local,
   * inicio del día siguiente). Nombre de servicio/profesional/contacto
   * se resuelve con consultas aparte — sin embeds de PostgREST, que se
   * rompen cuando el schema cache está frío (ver auth/account.ts).
   * Las respuestas a las preguntas extra se muestran con la etiqueta
   * guardada; si viene vacía (formato viejo) se usa la de la pregunta,
   * por eso se leen TAMBIÉN las preguntas desactivadas.
   */
  const loadAgenda = useCallback(async () => {
    if (!accountId || !isAgenda) return
    setAgendaLoading(true)
    setAgendaFailed(false)
    try {
      const dayKey = zonedDateKey(new Date())
      const from = startOfZonedDay(dayKey)
      const to = startOfZonedDay(addDaysToKey(dayKey, 1))
      const { data, error } = await supabase
        .from('booking_appointments')
        .select(
          'id, starts_at, status, service_id, staff_id, contact_id, answers',
        )
        .eq('account_id', accountId)
        .gte('starts_at', from.toISOString())
        .lt('starts_at', to.toISOString())
        .order('starts_at', { ascending: true })

      if (error) {
        if (isMissingMigrationError(error)) setMigrationMissing(true)
        setAgendaFailed(true)
        return
      }

      const rows = (data ?? []) as AppointmentRow[]
      const ids = (values: (string | null)[]) =>
        [...new Set(values.filter((v): v is string => Boolean(v)))]
      const serviceIds = ids(rows.map((r) => r.service_id))
      const staffIds = ids(rows.map((r) => r.staff_id))
      const contactIds = ids(rows.map((r) => r.contact_id))

      // Solo se buscan las preguntas si alguna cita trae respuestas (`{}` no cuenta).
      const hasAnswers = rows.some((row) => hasAnswerEntries(row.answers))

      const [svcRows, staffRows, contactRows, questionRows] =
        await Promise.all([
          serviceIds.length
            ? supabase
                .from('booking_services')
                .select('id, name')
                .eq('account_id', accountId)
                .in('id', serviceIds)
                .then((r) => (r.data ?? []) as { id: string; name: string }[])
            : Promise.resolve([] as { id: string; name: string }[]),
          staffIds.length
            ? supabase
                .from('booking_staff')
                .select('id, name')
                .eq('account_id', accountId)
                .in('id', staffIds)
                .then((r) => (r.data ?? []) as { id: string; name: string }[])
            : Promise.resolve([] as { id: string; name: string }[]),
          contactIds.length
            ? supabase
                .from('contacts')
                .select('id, name, phone')
                .eq('account_id', accountId)
                .in('id', contactIds)
                .then(
                  (r) =>
                    (r.data ?? []) as {
                      id: string
                      name: string | null
                      phone: string | null
                    }[],
                )
            : Promise.resolve(
                [] as {
                  id: string
                  name: string | null
                  phone: string | null
                }[],
              ),
          // Todas las preguntas de la cuenta (activas o no): solo sirven para
          // completar la etiqueta de respuestas viejas. Si la consulta falla,
          // las respuestas se muestran con la etiqueta que traen.
          hasAnswers
            ? supabase
                .from('booking_questions')
                .select('id, label, position')
                .eq('account_id', accountId)
                .then(
                  (r) =>
                    (r.error ? [] : (r.data ?? [])) as {
                      id: string
                      label: string
                      position: number
                    }[],
                )
            : Promise.resolve(
                [] as { id: string; label: string; position: number }[],
              ),
        ])

      const serviceNames = new Map(svcRows.map((s) => [s.id, s.name]))
      const staffNames = new Map(staffRows.map((s) => [s.id, s.name]))
      const contacts = new Map(contactRows.map((c) => [c.id, c]))

      setAppointments(
        rows.map((row) => {
          const contact = row.contact_id
            ? contacts.get(row.contact_id)
            : undefined
          return {
            id: row.id,
            starts_at: row.starts_at,
            status: row.status as AppointmentStatus,
            serviceName: row.service_id
              ? (serviceNames.get(row.service_id) ?? null)
              : null,
            staffName: row.staff_id
              ? (staffNames.get(row.staff_id) ?? null)
              : null,
            contactName: contact?.name ?? null,
            contactPhone: contact?.phone ?? null,
            answerLines: appointmentAnswerLines(row.answers, questionRows),
          }
        }),
      )
    } catch {
      setAgendaFailed(true)
    } finally {
      setAgendaLoading(false)
    }
  }, [accountId, isAgenda, supabase])

  /**
   * Recordatorios: citas activas dentro de ±48 h con el estado de sus
   * dos señales. La clasificación usa `pickDueReminder` — la MISMA
   * función pura que el runner — para que la sección muestre lo que
   * el cron enviará en la próxima pasada o ya envió.
   */
  const loadReminders = useCallback(async () => {
    if (!accountId || !isAgenda) return
    setRemindersLoading(true)
    setRemindersFailed(false)
    try {
      const now = new Date()
      const fromIso = new Date(now.getTime() - 48 * 3_600_000).toISOString()
      const toIso = new Date(now.getTime() + 48 * 3_600_000).toISOString()
      const [appointmentsRes, settingsRes] = await Promise.all([
        supabase
          .from('booking_appointments')
          .select(
            'id, starts_at, status, service_id, staff_id, contact_id, reminder_sent_at, reminder_2h_sent_at',
          )
          .eq('account_id', accountId)
          .in('status', ['pending', 'confirmed'])
          .gte('starts_at', fromIso)
          .lt('starts_at', toIso)
          .order('starts_at', { ascending: true }),
        supabase
          .from('booking_settings')
          .select('reminders_2h_enabled, reminders_enabled')
          .eq('account_id', accountId)
          .maybeSingle(),
      ])

      if (isMissingMigrationError(settingsRes.error)) setMigrationMissing(true)
      if (appointmentsRes.error) {
        setRemindersFailed(true)
        return
      }

      const remindersRow = settingsRes.data as {
        reminders_2h_enabled?: boolean
        reminders_enabled?: boolean | null
      } | null
      const twoHourEnabled = remindersRow?.reminders_2h_enabled === true
      // Solo un `false` literal apaga los recordatorios (igual que en el bot).
      const remindersEnabled = remindersRow?.reminders_enabled !== false
      setRemindersTwoHour(twoHourEnabled)
      setRemindersOn(remindersEnabled)

      const rows = (appointmentsRes.data ?? []) as ReminderAppointmentRow[]
      const ids = (values: (string | null)[]) =>
        [...new Set(values.filter((v): v is string => Boolean(v)))]
      const serviceIds = ids(rows.map((r) => r.service_id))
      const staffIds = ids(rows.map((r) => r.staff_id))
      const contactIds = ids(rows.map((r) => r.contact_id))

      const [svcRows, staffRows, contactRows] = await Promise.all([
        serviceIds.length
          ? supabase
              .from('booking_services')
              .select('id, name')
              .eq('account_id', accountId)
              .in('id', serviceIds)
              .then((r) => (r.data ?? []) as { id: string; name: string }[])
          : Promise.resolve([] as { id: string; name: string }[]),
        staffIds.length
          ? supabase
              .from('booking_staff')
              .select('id, name')
              .eq('account_id', accountId)
              .in('id', staffIds)
              .then((r) => (r.data ?? []) as { id: string; name: string }[])
          : Promise.resolve([] as { id: string; name: string }[]),
        contactIds.length
          ? supabase
              .from('contacts')
              .select('id, name, phone')
              .eq('account_id', accountId)
              .in('id', contactIds)
              .then(
                (r) =>
                  (r.data ?? []) as {
                    id: string
                    name: string | null
                    phone: string | null
                  }[],
              )
          : Promise.resolve(
              [] as { id: string; name: string | null; phone: string | null }[],
            ),
      ])

      const serviceNames = new Map(svcRows.map((s) => [s.id, s.name]))
      const staffNames = new Map(staffRows.map((s) => [s.id, s.name]))
      const contacts = new Map(contactRows.map((c) => [c.id, c]))
      const nowMs = now.getTime()

      setReminders(
        rows.map((row) => {
          const contact = row.contact_id
            ? contacts.get(row.contact_id)
            : undefined
          return {
            id: row.id,
            startsAt: row.starts_at,
            serviceName: row.service_id
              ? (serviceNames.get(row.service_id) ?? null)
              : null,
            staffName: row.staff_id
              ? (staffNames.get(row.staff_id) ?? null)
              : null,
            contactName: contact?.name ?? null,
            contactPhone: contact?.phone ?? null,
            // Con los recordatorios apagados nada se enviará: no hay "por enviar".
            pendingKind: remindersEnabled
              ? pickDueReminder({
                  startsAtMs: new Date(row.starts_at).getTime(),
                  nowMs,
                  reminderSentAtMs: row.reminder_sent_at
                    ? new Date(row.reminder_sent_at).getTime()
                    : null,
                  reminder2hSentAtMs: row.reminder_2h_sent_at
                    ? new Date(row.reminder_2h_sent_at).getTime()
                    : null,
                  twoHourEnabled,
                })
              : null,
            sent24At: row.reminder_sent_at,
            sent2hAt: row.reminder_2h_sent_at,
          }
        }),
      )
    } catch {
      setRemindersFailed(true)
    } finally {
      setRemindersLoading(false)
    }
  }, [accountId, isAgenda, supabase])

  const changeStatus = useCallback(
    async (
      appointment: AgendaAppointment,
      status: AppointmentStatus,
      confirmPast: boolean,
    ) => {
      setChangingId(appointment.id)
      setAgendaError(null)
      try {
        const res = await fetch(
          `/api/verticals/agenda/appointments/${appointment.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, confirm_past: confirmPast }),
          },
        )
        const payload = (await res.json().catch(() => null)) as {
          error?: string
          code?: string
        } | null
        if (
          res.status === 409 &&
          payload?.code === 'past_confirmation_required'
        ) {
          setPastPrompt({ appointment, status })
          return
        }
        if (!res.ok) {
          setAgendaError(payload?.error ?? T.agendaChangeFailed)
          return
        }
        setPastPrompt(null)
        await loadAgenda()
      } catch {
        setAgendaError(T.agendaChangeFailed)
      } finally {
        setChangingId(null)
      }
    },
    [loadAgenda],
  )

  useEffect(() => {
    void load()
    void loadAgenda()
    void loadReminders()
  }, [load, loadAgenda, loadReminders])

  /** Reinstalar: vuelve a aplicar el tipo de negocio que ya tiene la cuenta. */
  const handleInstall = useCallback(async () => {
    setInstalling(true)
    setInstallError(null)
    setReport(null)
    setReportFromWizard(false)
    const res = await agendaConfigApi.installPreset(
      isPresetKey(presetKey) ? presetKey : undefined,
    )
    if (!res.ok) {
      setInstallError(res.error || T.installFailed)
    } else {
      setReport(res.data.report)
      await load()
    }
    setInstalling(false)
  }, [load, presetKey])

  /** El asistente terminó: se muestra el reporte y se recargan las listas. */
  const handleWizardInstalled = useCallback(
    async (installed: AgendaInstallReport) => {
      setInstallError(null)
      setReport(installed)
      setReportFromWizard(true)
      await load()
    },
    [load],
  )

  // Mientras el contexto de cuenta carga no se puede saber si el
  // vertical aplica; el shell de la app ya muestra el estado de cuenta.
  if (!account) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{T.loading}</p>
      </div>
    )
  }

  if (!isAgenda) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{T.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{T.subtitle}</p>
        </div>
        <ModuleNotEnabled />
      </div>
    )
  }

  // "En blanco" no crea servicios ni equipo: se reconoce por el reporte de
  // la instalación recién hecha o por el tipo de negocio guardado.
  const installed = isAgendaInstalled({
    servicesCount: services.length,
    staffCount: staff.length,
    hasReport: report !== null,
    presetKey,
  })
  const todayLabel = formatLongDate(zonedDateKey(new Date()))
  const loadErrorText = migrationMissing ? T.migrationMissing : T.loadError
  const promptSuggestion = report ? suggestedAiPrompt(report) : null

  const sectionLines: Array<[string, InstallSectionCounts]> = report
    ? [
        [T.sections.services(labels), report.services],
        [T.sections.staff(labels), report.staff],
        [T.sections.staffServices(labels), report.staffServices],
        [T.sections.workingHours, report.workingHours],
        [T.sections.tags, report.tags],
        [T.sections.customFields, report.customFields],
        [T.sections.quickReplies, report.quickReplies],
        [T.sections.knowledge, report.knowledge],
        [T.sections.questions, report.questions],
      ]
    : []

  const aiPromptLine = report
    ? report.aiPrompt === 'written'
      ? T.aiPromptWritten
      : report.aiPrompt === 'already_set'
        ? T.aiPromptAlreadySet
        : T.aiPromptNoConfig
    : ''

  const remindersPending = reminders.filter((r) => r.pendingKind !== null)
  const remindersSent = reminders.filter(
    (r) => r.pendingKind === null && (r.sent24At || r.sent2hAt),
  )
  const showWizard = !listsLoading && !loadFailed && !installed

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">{T.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{T.subtitle}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => router.push('/agenda/configuracion')}
        >
          <Settings2 className="h-4 w-4" />
          {T.config.openConfig}
        </Button>
      </div>

      {loadFailed && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{loadErrorText}</AlertDescription>
        </Alert>
      )}

      {/* Sin plantilla: el asistente (tipo de negocio) es lo primero que hay que hacer. */}
      {showWizard && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px] font-semibold">
              {T.statusTitle}
            </CardTitle>
            <CardDescription>{T.statusNotInstalledBody}</CardDescription>
          </CardHeader>
          <CardContent>
            <SetupWizard
              canEdit={canEditSettings}
              currentKey={presetKey}
              onInstalled={handleWizardInstalled}
            />
          </CardContent>
        </Card>
      )}

      {/* Resultado de la última instalación (solo justo después de instalar). */}
      {report && (
        <Card>
          <CardContent className="space-y-3">
            {/* "Tu agenda está lista" solo tras el asistente; al reinstalar basta el reporte. */}
            {reportFromWizard && (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-semibold">{T.wizard.doneTitle}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {T.wizard.doneBody}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => router.push('/agenda/configuracion')}
                >
                  <Settings2 className="h-4 w-4" />
                  {T.wizard.goToConfig}
                </Button>
              </div>
            )}
            <p className="text-sm font-medium">{T.reportTitle}</p>
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {sectionLines.map(([label, counts]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-4 text-sm"
                >
                  <span className="min-w-0 text-muted-foreground">{label}</span>
                  <span className="shrink-0 text-right">
                    {counts.created > 0 &&
                      `${counts.created} ${T.createdLabel}`}
                    {counts.created > 0 && counts.skipped > 0 && ' · '}
                    {counts.skipped > 0 &&
                      `${counts.skipped} ${T.skippedLabel}`}
                    {counts.created === 0 && counts.skipped === 0 && '0'}
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 text-sm sm:col-span-2">
                <span className="text-muted-foreground">
                  {T.sections.pipeline}
                </span>
                <span className="text-right">
                  {report.pipeline.created
                    ? T.pipelineCreated(report.pipeline.stagesCreated)
                    : T.pipelineSkipped}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 text-sm sm:col-span-2">
                <span className="text-muted-foreground">
                  {T.sections.aiAgent}
                </span>
                <span className="text-right">{aiPromptLine}</span>
              </div>
            </div>

            {report.warnings.length > 0 && (
              <Alert role="status">
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-4">
                    {report.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {promptSuggestion && (
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {T.promptSuggestionTitle}
                </p>
                <p className="text-xs text-muted-foreground">
                  {T.promptSuggestionHint}
                </p>
                <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
                  {promptSuggestion}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
      {/* Agenda del día: lo principal de la página */}
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">{T.agendaTitle}</CardTitle>
          <CardDescription className="first-letter:uppercase">
            {todayLabel}
            {!agendaLoading && !agendaFailed && appointments.length > 0 &&
              ` · ${T.agendaCount(appointments.length, labels)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {agendaFailed && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{loadErrorText}</AlertDescription>
            </Alert>
          )}

          {agendaError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{agendaError}</AlertDescription>
            </Alert>
          )}

          {agendaLoading ? (
            <p className="text-sm text-muted-foreground">{T.loading}</p>
          ) : appointments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
                <CalendarDays
                  className="size-6 text-muted-foreground"
                  aria-hidden="true"
                />
              </span>
              <p className="text-sm text-muted-foreground">
                {T.agendaEmpty(labels)}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {appointments.map((appointment) => {
                const parts = zonedParts(new Date(appointment.starts_at))
                const editable =
                  canManageAppointments &&
                  EDITABLE_STATUSES.includes(appointment.status)
                const busy = changingId === appointment.id
                return (
                  <li
                    key={appointment.id}
                    className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 gap-3">
                      <p className="w-[5.5rem] shrink-0 pt-px text-sm font-semibold whitespace-nowrap tabular-nums">
                        {formatTimeLabel(parts)}
                      </p>
                      <div className="min-w-0 break-words">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                          <span className="min-w-0">
                            {appointment.serviceName ?? T.agendaServiceGone}
                          </span>
                          <Badge
                            variant={STATUS_BADGE_VARIANTS[appointment.status]}
                          >
                            {STATUS_LABELS[appointment.status]}
                          </Badge>
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {appointment.staffName ?? T.agendaStaffGone} ·{' '}
                          {appointment.contactName?.trim() ||
                            appointment.contactPhone ||
                            T.agendaContactFallback}
                        </p>
                        {appointment.answerLines.length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {appointment.answerLines.map((line, index) => (
                              <li key={index} className="break-words">
                                {line}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                    {editable && (
                      <div className="flex items-center gap-2 sm:shrink-0">
                        {/* Acción principal de cada fila; lo demás va en "Más". */}
                        <Button
                          variant="outline"
                          className="flex-1 sm:flex-none"
                          disabled={busy}
                          onClick={() =>
                            void changeStatus(appointment, 'completed', false)
                          }
                        >
                          {busy ? (
                            <Loader2 className="animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="text-primary" aria-hidden="true" />
                          )}
                          {T.agendaActionComplete}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            disabled={busy}
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={T.agendaActionMoreLabel}
                                title={T.agendaActionMoreLabel}
                              />
                            }
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-auto min-w-44">
                            <DropdownMenuItem
                              className="pointer-coarse:min-h-11"
                              onClick={() =>
                                void changeStatus(appointment, 'no_show', false)
                              }
                            >
                              <UserX aria-hidden="true" />
                              {T.agendaActionNoShow}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              className="pointer-coarse:min-h-11"
                              onClick={() => setCancelPrompt(appointment)}
                            >
                              <CalendarX aria-hidden="true" />
                              {T.agendaActionCancel(labels)}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Columna secundaria: recordatorios, servicios, equipo y plantilla */}
      <div className="min-w-0 space-y-6">
      {/* Recordatorios: resumen en una línea + lo por enviar / enviado */}
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px] font-semibold">
            <BellRing className="size-4 text-muted-foreground" aria-hidden="true" />
            {T.remindersTitle}
          </CardTitle>
          <CardDescription>
            {remindersLoading
              ? T.loading
              : T.remindersSummary(remindersOn, remindersTwoHour)}{' '}
            <Link
              href="/agenda/configuracion"
              className="font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {T.remindersConfigLink}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {remindersFailed && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{T.remindersLoadFailed}</AlertDescription>
            </Alert>
          )}

          {remindersLoading ? null : remindersPending.length === 0 &&
            remindersSent.length === 0 ? (
            !remindersFailed && (
              <p className="text-sm text-muted-foreground">{T.remindersEmpty}</p>
            )
          ) : (
            <div className="space-y-4">
              {remindersPending.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {T.remindersPendingTitle}
                  </p>
                  <ul className="divide-y divide-border">
                    {remindersPending.map((item) => {
                      const parts = zonedParts(new Date(item.startsAt))
                      return (
                        <li
                          key={item.id}
                          className="flex items-start justify-between gap-3 py-2.5"
                        >
                          <div className="min-w-0 break-words">
                            <p className="text-sm">
                              {formatDayLabel(parts.dateKey)} ·{' '}
                              {formatTimeLabel(parts)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.serviceName ?? T.agendaServiceGone} ·{' '}
                              {item.contactName?.trim() ||
                                item.contactPhone ||
                                T.agendaContactFallback}
                            </p>
                          </div>
                          <Badge variant="info" className="shrink-0">
                            {item.pendingKind === 'h2'
                              ? T.remindersPending2h
                              : T.remindersPending24h}
                          </Badge>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {remindersSent.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {T.remindersSentTitle}
                  </p>
                  <ul className="divide-y divide-border">
                    {remindersSent.map((item) => {
                      const parts = zonedParts(new Date(item.startsAt))
                      const sentAt = item.sent2hAt ?? item.sent24At
                      const sentParts = sentAt
                        ? zonedParts(new Date(sentAt))
                        : null
                      return (
                        <li
                          key={item.id}
                          className="flex items-start justify-between gap-3 py-2.5"
                        >
                          <div className="min-w-0 break-words">
                            <p className="text-sm">
                              {formatDayLabel(parts.dateKey)} ·{' '}
                              {formatTimeLabel(parts)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.serviceName ?? T.agendaServiceGone} ·{' '}
                              {item.contactName?.trim() ||
                                item.contactPhone ||
                                T.agendaContactFallback}
                              {sentParts &&
                                ` · ${T.remindersSentAt(
                                  formatDayLabel(sentParts.dateKey),
                                  formatTimeLabel(sentParts),
                                )}`}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {item.sent24At && (
                              <Badge variant="secondary">
                                {T.remindersSent24h}
                              </Badge>
                            )}
                            {item.sent2hAt && (
                              <Badge variant="secondary">
                                {T.remindersSent2h}
                              </Badge>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Servicios y equipo: listas compactas (se editan en Configuración) */}
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-[15px] font-semibold">
            {T.servicesTitle(labels)}
          </CardTitle>
          {!listsLoading && services.length > 0 && (
            <CardDescription>
              {T.servicesCount(services.length, labels)}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {listsLoading ? (
            <p className="text-sm text-muted-foreground">{T.loading}</p>
          ) : services.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {T.servicesEmpty(labels)}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {services.map((service) => (
                <li
                  key={service.id}
                  className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm break-words">
                      <span className="min-w-0">{service.name}</span>
                      {!service.is_active && (
                        <Badge variant="outline">{T.inactiveLabel}</Badge>
                      )}
                    </p>
                    {service.description && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {service.description}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm tabular-nums">
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

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-[15px] font-semibold">
            {T.staffTitle(labels)}
          </CardTitle>
          {!listsLoading && staff.length > 0 && (
            <CardDescription>{T.staffCount(staff.length, labels)}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {listsLoading ? (
            <p className="text-sm text-muted-foreground">{T.loading}</p>
          ) : staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {T.staffEmpty(labels)}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {staff.map((member) => (
                <li key={member.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm break-words">
                    <span className="min-w-0">{member.name}</span>
                    {!member.is_active && (
                      <Badge variant="outline">{T.inactiveLabel}</Badge>
                    )}
                  </p>
                  {member.bio && (
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      {member.bio}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Estado de la plantilla: información de instalación, no trabajo
          diario. Va al final, sin sombra y con la acción en segundo plano. */}
      {installed && !loadFailed && (
        <Card
          size="sm"
          className="bg-muted/40 shadow-none"
        >
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground">
              {T.statusTitle}
              <Badge variant="secondary">{T.statusInstalled}</Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              {T.statusInstalledBody}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <GatedButton
              variant="ghost"
              size="sm"
              canAct={canEditSettings}
              gateReason={T.gateReason}
              onClick={handleInstall}
              disabled={installing || listsLoading}
              className="-ml-2.5 text-muted-foreground hover:text-foreground"
            >
              {installing ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw aria-hidden="true" />
              )}
              {installing ? T.installing : T.reinstallButton}
            </GatedButton>
            {installError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{installError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
      </div>
      </div>

      {/* Confirmación explícita para editar una cita que ya pasó */}
      <Dialog
        open={pastPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setPastPrompt(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{T.agendaPastTitle}</DialogTitle>
            <DialogDescription>
              {pastPrompt &&
                (() => {
                  const parts = zonedParts(
                    new Date(pastPrompt.appointment.starts_at),
                  )
                  return T.agendaPastBody(
                    formatLongDate(parts.dateKey),
                    formatTimeLabel(parts),
                  )
                })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPastPrompt(null)}>
              {T.agendaPastBack}
            </Button>
            <Button
              disabled={changingId !== null}
              onClick={() => {
                if (pastPrompt) {
                  void changeStatus(
                    pastPrompt.appointment,
                    pastPrompt.status,
                    true,
                  )
                }
              }}
            >
              {T.agendaPastConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmación para cancelar (cerrar una cita no tiene vuelta atrás) */}
      <Dialog
        open={cancelPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setCancelPrompt(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{T.agendaCancelTitle(labels)}</DialogTitle>
            <DialogDescription>
              {cancelPrompt &&
                T.agendaCancelBody(
                  [
                    formatTimeLabel(
                      zonedParts(new Date(cancelPrompt.starts_at)),
                    ),
                    cancelPrompt.serviceName ?? T.agendaServiceGone,
                    cancelPrompt.contactName?.trim() ||
                      cancelPrompt.contactPhone ||
                      T.agendaContactFallback,
                  ].join(' · '),
                )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelPrompt(null)}>
              {T.agendaCancelBack}
            </Button>
            <Button
              variant="destructive"
              disabled={changingId !== null}
              onClick={() => {
                if (cancelPrompt) {
                  const appointment = cancelPrompt
                  setCancelPrompt(null)
                  void changeStatus(appointment, 'cancelled', false)
                }
              }}
            >
              {T.agendaCancelConfirm(labels)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
