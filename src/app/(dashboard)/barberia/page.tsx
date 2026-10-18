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
import { useRouter } from 'next/navigation'
import {
  BellRing,
  CalendarDays,
  Loader2,
  Scissors,
  Settings2,
  Users,
} from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import { GatedButton } from '@/components/ui/gated-button'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

import { BARBERIA_TEXTS as T } from '@/verticals/barberia/texts'
import type { AppointmentStatus } from '@/verticals/barberia/appointments'
import { formatLongDate, formatTimeLabel } from '@/verticals/barberia/agent/format'
import { pickDueReminder } from '@/verticals/barberia/agent/reminders'
import {
  addDaysToKey,
  startOfZonedDay,
  zonedDateKey,
  zonedParts,
} from '@/verticals/barberia/agent/time'
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

interface AppointmentRow {
  id: string
  starts_at: string
  status: string
  service_id: string | null
  staff_id: string | null
  contact_id: string | null
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
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  pending: 'outline',
  confirmed: 'default',
  completed: 'secondary',
  no_show: 'destructive',
  cancelled: 'outline',
}

/** Estados desde los que la agenda permite actuar. */
const EDITABLE_STATUSES: readonly AppointmentStatus[] = ['pending', 'confirmed']

export default function BarberiaPage() {
  const { account, accountId, canEditSettings, canSendMessages, defaultCurrency } =
    useAuth()
  const router = useRouter()
  const supabase = createClient()

  const [services, setServices] = useState<BookingServiceRow[]>([])
  const [staff, setStaff] = useState<BookingStaffRow[]>([])
  const [listsLoading, setListsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [report, setReport] = useState<BarberiaInstallReport | null>(null)
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

  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [remindersTwoHour, setRemindersTwoHour] = useState(false)
  const [remindersLoading, setRemindersLoading] = useState(true)
  const [remindersFailed, setRemindersFailed] = useState(false)

  const isBarberia = account?.vertical_key === 'barberia'
  /** Owner/admin/agent mueven citas; viewer es solo-lectura. */
  const canManageAppointments = canSendMessages

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

  /**
   * Agenda del día en America/Bogota: ventana [inicio del día local,
   * inicio del día siguiente). Nombre de servicio/barbero/contacto se
   * resuelve con consultas aparte — sin embeds de PostgREST, que se
   * rompen cuando el schema cache está frío (ver auth/account.ts).
   */
  const loadAgenda = useCallback(async () => {
    if (!accountId || !isBarberia) return
    setAgendaLoading(true)
    setAgendaFailed(false)
    try {
      const dayKey = zonedDateKey(new Date())
      const from = startOfZonedDay(dayKey)
      const to = startOfZonedDay(addDaysToKey(dayKey, 1))
      const { data, error } = await supabase
        .from('booking_appointments')
        .select('id, starts_at, status, service_id, staff_id, contact_id')
        .eq('account_id', accountId)
        .gte('starts_at', from.toISOString())
        .lt('starts_at', to.toISOString())
        .order('starts_at', { ascending: true })

      if (error) {
        setAgendaFailed(true)
        return
      }

      const rows = (data ?? []) as AppointmentRow[]
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
          }
        }),
      )
    } catch {
      setAgendaFailed(true)
    } finally {
      setAgendaLoading(false)
    }
  }, [accountId, isBarberia, supabase])

  /**
   * Recordatorios: citas activas dentro de ±48 h con el estado de sus
   * dos señales. La clasificación usa `pickDueReminder` — la MISMA
   * función pura que el runner — para que la sección muestre lo que
   * el cron enviará en la próxima pasada o ya envió.
   */
  const loadReminders = useCallback(async () => {
    if (!accountId || !isBarberia) return
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
          .select('reminders_2h_enabled')
          .eq('account_id', accountId)
          .maybeSingle(),
      ])

      if (appointmentsRes.error) {
        setRemindersFailed(true)
        return
      }

      const twoHourEnabled =
        (settingsRes.data as { reminders_2h_enabled?: boolean } | null)
          ?.reminders_2h_enabled === true
      setRemindersTwoHour(twoHourEnabled)

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
            pendingKind: pickDueReminder({
              startsAtMs: new Date(row.starts_at).getTime(),
              nowMs,
              reminderSentAtMs: row.reminder_sent_at
                ? new Date(row.reminder_sent_at).getTime()
                : null,
              reminder2hSentAtMs: row.reminder_2h_sent_at
                ? new Date(row.reminder_2h_sent_at).getTime()
                : null,
              twoHourEnabled,
            }),
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
  }, [accountId, isBarberia, supabase])

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
          `/api/verticals/barberia/appointments/${appointment.id}`,
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
  const todayLabel = formatLongDate(zonedDateKey(new Date()))

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

  const remindersPending = reminders.filter((r) => r.pendingKind !== null)
  const remindersSent = reminders.filter(
    (r) => r.pendingKind === null && (r.sent24At || r.sent2hAt),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{T.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{T.subtitle}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => router.push('/barberia/configuracion')}
        >
          <Settings2 className="h-4 w-4" />
          {T.config.openConfig}
        </Button>
      </div>

      {/* Agenda del día */}
      <Card>
        <CardHeader>
          <CardTitle>{T.agendaTitle}</CardTitle>
          <CardAction>
            <span className="text-sm text-muted-foreground">{todayLabel}</span>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {agendaFailed && (
            <Alert variant="destructive">
              <AlertDescription>{T.loadError}</AlertDescription>
            </Alert>
          )}

          {agendaError && (
            <Alert variant="destructive">
              <AlertDescription>{agendaError}</AlertDescription>
            </Alert>
          )}

          {agendaLoading ? (
            <p className="text-sm text-muted-foreground">{T.loading}</p>
          ) : appointments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CalendarDays className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{T.agendaEmpty}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {appointments.map((appointment) => {
                const parts = zonedParts(new Date(appointment.starts_at))
                const editable =
                  canManageAppointments &&
                  EDITABLE_STATUSES.includes(appointment.status)
                return (
                  <li
                    key={appointment.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {formatTimeLabel(parts)} ·{' '}
                        {appointment.serviceName ?? T.agendaServiceGone}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {appointment.staffName ?? T.agendaStaffGone} ·{' '}
                        {appointment.contactName?.trim() ||
                          appointment.contactPhone ||
                          T.agendaContactFallback}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_BADGE_VARIANTS[appointment.status]}>
                        {STATUS_LABELS[appointment.status]}
                      </Badge>
                      {editable && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={changingId === appointment.id}
                            onClick={() =>
                              void changeStatus(appointment, 'completed', false)
                            }
                          >
                            {T.agendaActionComplete}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={changingId === appointment.id}
                            onClick={() =>
                              void changeStatus(appointment, 'no_show', false)
                            }
                          >
                            {T.agendaActionNoShow}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={changingId === appointment.id}
                            onClick={() =>
                              void changeStatus(appointment, 'cancelled', false)
                            }
                          >
                            {T.agendaActionCancel}
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recordatorios de citas */}
      <Card>
        <CardHeader>
          <CardTitle>{T.remindersTitle}</CardTitle>
          <CardAction>
            <Badge variant={remindersTwoHour ? 'default' : 'outline'}>
              {remindersTwoHour ? T.remindersTwoHourOn : T.remindersTwoHourOff}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{T.remindersHint}</p>
            <p className="text-xs text-muted-foreground">
              {T.remindersWindowNote}
            </p>
          </div>

          {remindersFailed && (
            <Alert variant="destructive">
              <AlertDescription>{T.remindersLoadFailed}</AlertDescription>
            </Alert>
          )}

          {remindersLoading ? (
            <p className="text-sm text-muted-foreground">{T.loading}</p>
          ) : remindersPending.length === 0 && remindersSent.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <BellRing className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {T.remindersEmpty}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {remindersPending.length > 0 && (
                <div>
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {T.remindersPendingTitle}
                  </p>
                  <ul className="divide-y divide-border">
                    {remindersPending.map((item) => {
                      const parts = zonedParts(new Date(item.startsAt))
                      return (
                        <li
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-3 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {formatLongDate(parts.dateKey)} ·{' '}
                              {formatTimeLabel(parts)} ·{' '}
                              {item.serviceName ?? T.agendaServiceGone}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.staffName ?? T.agendaStaffGone} ·{' '}
                              {item.contactName?.trim() ||
                                item.contactPhone ||
                                T.agendaContactFallback}
                            </p>
                          </div>
                          <Badge variant="outline">
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
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
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
                          className="flex flex-wrap items-center justify-between gap-3 py-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {formatLongDate(parts.dateKey)} ·{' '}
                              {formatTimeLabel(parts)} ·{' '}
                              {item.serviceName ?? T.agendaServiceGone}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.staffName ?? T.agendaStaffGone} ·{' '}
                              {item.contactName?.trim() ||
                                item.contactPhone ||
                                T.agendaContactFallback}
                              {sentParts &&
                                ` · ${T.remindersSentAt(
                                  formatLongDate(sentParts.dateKey),
                                  formatTimeLabel(sentParts),
                                )}`}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
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
    </div>
  )
}
