'use client'

// ============================================================
// /barberia/configuracion — onboarding del vertical sin SQL.
//
// Solo para cuentas con `vertical_key = 'barberia'`. Lee toda la
// configuración con el cliente del usuario (RLS: los miembros
// leen) en una sola ronda de consultas y la reparte entre las
// pestañas. Las escrituras van por /api/verticals/barberia/*, que
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
import { BARBERIA_TEXTS as T } from '@/verticals/barberia/texts'

import { BotSection } from './_components/bot-section'
import { BusinessSection } from './_components/business-section'
import { ScheduleSection } from './_components/schedule-section'
import { ServicesSection } from './_components/services-section'
import { StaffSection } from './_components/staff-section'
import { TimeOffSection } from './_components/timeoff-section'
import {
  EMPTY_SETTINGS,
  type ServiceRow,
  type SettingsRow,
  type StaffRow,
  type StaffServicesMap,
  type TimeOffRow,
  type WorkingHoursRow,
} from './_components/types'

export default function BarberiaConfiguracionPage() {
  const { account, accountId, canEditSettings } = useAuth()
  const router = useRouter()
  const isBarberia = account?.vertical_key === 'barberia'

  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [settings, setSettings] = useState<SettingsRow>(EMPTY_SETTINGS)
  const [services, setServices] = useState<ServiceRow[]>([])
  const [staff, setStaff] = useState<StaffRow[]>([])
  const [staffServices, setStaffServices] = useState<StaffServicesMap>({})
  const [workingHours, setWorkingHours] = useState<WorkingHoursRow[]>([])
  const [timeOff, setTimeOff] = useState<TimeOffRow[]>([])

  const load = useCallback(async () => {
    if (!accountId || !isBarberia) return
    setFailed(false)

    const supabase = createClient()
    const [
      settingsRes,
      servicesRes,
      staffRes,
      linksRes,
      hoursRes,
      timeOffRes,
    ] = await Promise.all([
      supabase
        .from('booking_settings')
        .select('address, reminders_2h_enabled, bot_texts')
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
    ])

    if (
      settingsRes.error ||
      servicesRes.error ||
      staffRes.error ||
      linksRes.error ||
      hoursRes.error ||
      timeOffRes.error
    ) {
      setFailed(true)
      return
    }

    // La fila puede no existir (config idempotente: la primera
    // escritura la crea). bot_texts puede traer basura de versiones
    // anteriores: se normaliza a un objeto plano.
    const rawSettings = settingsRes.data as {
      address: string | null
      reminders_2h_enabled: boolean | null
      bot_texts: unknown
    } | null
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
    })

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
  }, [accountId, isBarberia])

  useEffect(() => {
    if (!accountId || !isBarberia) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      await load()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, isBarberia, load])

  if (!account) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{T.config.loading}</p>
      </div>
    )
  }

  if (!isBarberia) {
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
        <Button variant="outline" onClick={() => router.push('/barberia')}>
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
          <TabsList>
            <TabsTrigger value="business">
              {T.config.tabs.business}
            </TabsTrigger>
            <TabsTrigger value="services">
              {T.config.tabs.services}
            </TabsTrigger>
            <TabsTrigger value="staff">{T.config.tabs.staff}</TabsTrigger>
            <TabsTrigger value="schedule">
              {T.config.tabs.schedule}
            </TabsTrigger>
            <TabsTrigger value="timeOff">
              {T.config.tabs.timeOff}
            </TabsTrigger>
            <TabsTrigger value="bot">{T.config.tabs.bot}</TabsTrigger>
          </TabsList>

          <TabsContent value="business">
            <BusinessSection
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
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="schedule">
            <ScheduleSection
              staff={staff}
              workingHours={workingHours}
              canEdit={canEditSettings}
              reload={load}
            />
          </TabsContent>

          <TabsContent value="timeOff">
            <TimeOffSection
              staff={staff}
              timeOff={timeOff}
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
