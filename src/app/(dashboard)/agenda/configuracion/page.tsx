'use client'

// ============================================================
// /agenda/configuracion — onboarding del vertical sin SQL.
//
// Solo para cuentas de la agenda (`vertical_key` 'agenda' o la
// clave anterior 'barberia'). Lee toda la
// configuración con el cliente del usuario (RLS: los miembros
// leen) en una sola ronda de consultas y la reparte entre las
// pestañas (incluidas las palabras del negocio, que dan nombre a las
// pestañas Servicios y Equipo). Las escrituras van por /api/verticals/agenda/*, que
// validan rol (admin+) y datos en el servidor — el navegador nunca
// usa service-role.
//
// `reload` se pasa a las secciones y NO muestra el spinner global:
// cada sección maneja su propio estado de guardado para no perder
// la pestaña activa al refrescar.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { isAgendaVerticalKey } from '@/lib/verticals/registry'
import { capitalize, readLabels } from '@/verticals/agenda/labels'
import { readQuestion } from '@/verticals/agenda/questions'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'
import { togglesFromRow } from '@/verticals/agenda/toggles'

import { BotSection } from './_components/bot-section'
import { BusinessSection } from './_components/business-section'
import { BusinessTypeSection } from './_components/business-type-section'
import { PiecesSection } from './_components/pieces-section'
import { QuestionsSection } from './_components/questions-section'
import { ScheduleSection } from './_components/schedule-section'
import { ServicesSection } from './_components/services-section'
import { StaffSection } from './_components/staff-section'
import { TimeOffSection } from './_components/timeoff-section'
import {
  EMPTY_SETTINGS,
  type QuestionRow,
  type ServiceRow,
  type SettingsRow,
  type StaffRow,
  type StaffServicesMap,
  type TimeOffRow,
  type WorkingHoursRow,
} from './_components/types'

export default function AgendaConfiguracionPage() {
  const { account, accountId, canEditSettings } = useAuth()
  const router = useRouter()
  const isAgenda = isAgendaVerticalKey(account?.vertical_key)

  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [settings, setSettings] = useState<SettingsRow>(EMPTY_SETTINGS)
  const [services, setServices] = useState<ServiceRow[]>([])
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [staffServices, setStaffServices] = useState<StaffServicesMap>({})
  const [workingHours, setWorkingHours] = useState<WorkingHoursRow[]>([])
  const [timeOff, setTimeOff] = useState<TimeOffRow[]>([])
  const [questions, setQuestions] = useState<QuestionRow[]>([])

  const load = useCallback(async () => {
    if (!accountId || !isAgenda) return
    setFailed(false)

    const supabase = createClient()
    const [
      settingsRes,
      servicesRes,
      staffRes,
      linksRes,
      hoursRes,
      timeOffRes,
      questionsRes,
    ] = await Promise.all([
      supabase
        .from('booking_settings')
        .select(
          'address, reminders_2h_enabled, bot_texts, labels, preset_key, choose_staff, show_price, show_duration, reminders_enabled, allow_reschedule',
        )
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('booking_services')
        .select('id, name, description, duration_minutes, price, is_active, position')
        .eq('account_id', accountId)
        .order('position', { ascending: true }),
      supabase
        .from('booking_staff')
        .select('id, name, bio, is_active, position')
        .eq('account_id', accountId)
        .order('position', { ascending: true }),
      supabase
        .from('booking_staff_services')
        .select('staff_id, service_id')
        .eq('account_id', accountId),
      supabase
        .from('booking_working_hours')
        .select('id, staff_id, weekday, start_time, end_time')
        .eq('account_id', accountId)
        .order('weekday', { ascending: true })
        .order('start_time', { ascending: true }),
      supabase
        .from('booking_time_off')
        .select('id, staff_id, starts_at, ends_at, reason')
        .eq('account_id', accountId)
        .order('starts_at', { ascending: true }),
      supabase
        .from('booking_questions')
        .select('id, label, kind, required, options, position')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .order('position', { ascending: true }),
    ])

    if (
      settingsRes.error ||
      servicesRes.error ||
      staffRes.error ||
      linksRes.error ||
      hoursRes.error ||
      timeOffRes.error ||
      questionsRes.error
    ) {
      setFailed(true)
      return
    }

    // La fila puede no existir (config idempotente: la primera
    // escritura la crea). bot_texts puede traer basura de versiones
    // anteriores: se normaliza a un objeto plano.
    const rawSettings = settingsRes.data as
      | ({
          address: string | null
          reminders_2h_enabled: boolean | null
          bot_texts: unknown
          labels: unknown
          preset_key: string | null
        } & Record<string, unknown>)
      | null
    const rawOverrides = rawSettings?.bot_texts
    setSettings({
      address: rawSettings?.address ?? null,
      reminders_2h_enabled: rawSettings?.reminders_2h_enabled === true,
      bot_texts:
        rawOverrides &&
        typeof rawOverrides === 'object' &&
        !Array.isArray(rawOverrides)
          ? (rawOverrides as Record<string, string>)
          : {},
      // Lectura tolerante: una palabra mala en la base vuelve a su valor por defecto.
      labels: readLabels(rawSettings?.labels),
      toggles: togglesFromRow(rawSettings),
      preset_key: rawSettings?.preset_key ?? null,
    })

    // Una fila rota (insertada a mano) se descarta en vez de romper la pestaña.
    setQuestions(
      ((questionsRes.data ?? []) as unknown[])
        .map((row) => readQuestion(row))
        .filter((q): q is QuestionRow => q !== null),
    )

    setServices((servicesRes.data ?? []) as ServiceRow[])
    setStaff((staffRes.data ?? []) as StaffRow[])
    setWorkingHours((hoursRes.data ?? []) as WorkingHoursRow[])
    setTimeOff((timeOffRes.data ?? []) as TimeOffRow[])

    const byStaff: StaffServicesMap = {}
    for (const link of (linksRes.data ?? []) as {
      staff_id: string
      service_id: string
    }[]) {
      const list = byStaff[link.staff_id] ?? []
      list.push(link.service_id)
      byStaff[link.staff_id] = list
    }
    setStaffServices(byStaff)
  }, [accountId, isAgenda])

  useEffect(() => {
    if (!accountId || !isAgenda) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      await load()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, isAgenda, load])

  if (!account) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{T.config.loading}</p>
      </div>
    )
  }

  if (!isAgenda) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {T.config.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {T.config.subtitle}
          </p>
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {T.config.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {T.config.subtitle}
          </p>
        </div>
        <Button variant="outline" onClick={() => router.push('/agenda')}>
          <ArrowLeft className="h-4 w-4" />
          {T.config.backToAgenda}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {T.config.loading}
        </div>
      ) : failed ? (
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>{T.config.loadFailed}</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            onClick={() => {
              setLoading(true)
              void load().finally(() => setLoading(false))
            }}
          >
            {T.config.retry}
          </Button>
        </div>
      ) : (
        <Tabs defaultValue="business" className="space-y-4">
          {/* Con nueve pestañas la barra se desplaza en pantallas angostas. */}
          <div className="max-w-full overflow-x-auto pb-1">
            <TabsList>
              <TabsTrigger value="business">
                {T.config.tabs.business}
              </TabsTrigger>
              <TabsTrigger value="type">{T.config.tabs.type}</TabsTrigger>
              <TabsTrigger value="services">
                {capitalize(settings.labels.servicios)}
              </TabsTrigger>
              <TabsTrigger value="staff">
                {capitalize(settings.labels.profesionales)}
              </TabsTrigger>
              <TabsTrigger value="schedule">
                {T.config.tabs.schedule}
              </TabsTrigger>
              <TabsTrigger value="timeOff">
                {T.config.tabs.timeOff}
              </TabsTrigger>
              <TabsTrigger value="pieces">{T.config.tabs.pieces}</TabsTrigger>
              <TabsTrigger value="questions">
                {T.config.tabs.questions}
              </TabsTrigger>
              <TabsTrigger value="bot">{T.config.tabs.bot}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="business">
            <BusinessSection
              settings={settings}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="type">
            <BusinessTypeSection
              settings={settings}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="services">
            <ServicesSection
              services={services}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="staff">
            <StaffSection
              staff={staff}
              services={services}
              staffServices={staffServices}
              labels={settings.labels}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="schedule">
            <ScheduleSection
              staff={staff}
              labels={settings.labels}
              workingHours={workingHours}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="timeOff">
            <TimeOffSection
              staff={staff}
              labels={settings.labels}
              timeOff={timeOff}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="pieces">
            <PiecesSection
              settings={settings}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="questions">
            <QuestionsSection
              questions={questions}
              labels={settings.labels}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="bot">
            <BotSection
              settings={settings}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
