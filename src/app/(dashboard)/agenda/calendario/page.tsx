'use client'

// ============================================================
// /agenda/calendario — el calendario de la recepción.
//
// Lee citas, equipo, horarios, bloqueos, contactos y pacientes con el
// cliente del navegador (RLS: los miembros de la cuenta leen) y escribe
// SOLO por las rutas de la API (crear, mover, cancelar). Visible para
// cuentas con el módulo agenda; con el módulo clínica suma el paciente.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { hasModule } from '@/lib/verticals/registry'
import { createCalendarApi } from '@/verticals/agenda/calendar-api'
import {
  CalendarLoadError,
  listContactPatients,
  loadCalendarData,
  searchContacts,
  type CalendarData,
  type ContactSource,
} from '@/verticals/agenda/calendar-data'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import { parseCalendarUrl, type CalendarUrlState } from '@/verticals/agenda/calendar-url'
import { DEFAULT_LABELS, readLabels, type AgendaLabels } from '@/verticals/agenda/labels'
import { AGENDA_TEXTS } from '@/verticals/agenda/texts'

import { ModuleNotEnabled } from '../_components/module-not-enabled'
import { CalendarWorkspace } from './_components/calendar-workspace'

interface Range {
  fromKey: string
  toKey: string
}

export default function CalendarPage() {
  const { account, accountId, canSendMessages } = useAuth()
  const supabase = createClient()

  const isAgenda = hasModule(account, 'agenda')
  const clinic = hasModule(account, 'clinica')

  // Lo que dice la dirección al abrir (vista, día, profesional). La página solo
  // pinta el calendario cuando ya hay cuenta, o sea siempre en el navegador.
  const [initial] = useState<CalendarUrlState>(() =>
    typeof window === 'undefined' ? {} : parseCalendarUrl(window.location.search),
  )

  const [range, setRange] = useState<Range | null>(null)
  const [data, setData] = useState<CalendarData | null>(null)
  const [labels, setLabels] = useState<AgendaLabels>({ ...DEFAULT_LABELS })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'generic' | 'migration' | null>(null)
  // Si el usuario cambia de día antes de que llegue una respuesta, la vieja se descarta.
  const requestSeq = useRef(0)

  const api = useMemo(() => createCalendarApi(), [])
  const contacts = useMemo<ContactSource>(
    () => ({
      search: (query) => searchContacts(supabase, accountId ?? '', query),
      patients: (contactId) => listContactPatients(supabase, accountId ?? '', contactId),
    }),
    [supabase, accountId],
  )

  const load = useCallback(async () => {
    if (!accountId || !isAgenda || !range) return
    const seq = ++requestSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const [loaded, settings] = await Promise.all([
        loadCalendarData(supabase, { accountId, fromKey: range.fromKey, toKey: range.toKey, clinic }),
        supabase.from('booking_settings').select('labels').eq('account_id', accountId).maybeSingle(),
      ])
      if (seq !== requestSeq.current) return
      setData(loaded)
      // Lectura tolerante: una palabra mala en la base vuelve a la de por defecto.
      setLabels(readLabels((settings.data as { labels: unknown } | null)?.labels))
    } catch (err) {
      if (seq !== requestSeq.current) return
      setLoadError(err instanceof CalendarLoadError && err.migrationMissing ? 'migration' : 'generic')
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [accountId, isAgenda, range, clinic, supabase])

  useEffect(() => {
    void load()
  }, [load])

  if (!account) {
    return <p className="text-sm text-muted-foreground">{AGENDA_TEXTS.loading}</p>
  }

  if (!isAgenda) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{T.title}</h1>
        </div>
        <ModuleNotEnabled />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">{T.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{T.subtitle(labels)}</p>
        </div>
        {/* Navegación: un enlace de verdad (se abre en otra pestaña, mantener pulsado en el celular). */}
        <Link href="/agenda" className={buttonVariants({ variant: 'outline' })}>
          <ArrowLeft aria-hidden="true" />
          {T.backToAgenda}
        </Link>
      </div>

      <CalendarWorkspace
        data={data}
        loading={loading}
        loadError={loadError}
        labels={labels}
        clinic={clinic}
        canWrite={canSendMessages}
        api={api}
        contacts={contacts}
        initialView={initial.view}
        initialDateKey={initial.dateKey}
        initialStaffId={initial.staffId}
        syncUrl
        onRangeChange={setRange}
        onChanged={() => void load()}
        onRetry={() => void load()}
      />
    </div>
  )
}
