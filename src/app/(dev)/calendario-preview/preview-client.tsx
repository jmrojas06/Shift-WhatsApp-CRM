'use client'

// ============================================================
// Vista previa del calendario con datos de ejemplo (solo desarrollo).
//
// Usa el mismo CalendarWorkspace que /agenda/calendario, pero con una
// API y una fuente de contactos EN MEMORIA: no llama a la red, no lee
// Supabase y no escribe nada. Sirve para revisar el diseño con capturas
// sin tocar la base real.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CalendarWorkspace } from '@/app/(dashboard)/agenda/calendario/_components/calendar-workspace'
import { zonedParts, zonedTimeToUtc } from '@/verticals/agenda/agent/time'
import type { ApiResult, CalendarApi, SlotOption } from '@/verticals/agenda/calendar-api'
import type { CalendarView } from '@/verticals/agenda/calendar-columns'
import type { CalendarAppointment, ContactSource } from '@/verticals/agenda/calendar-data'
import { DEFAULT_LABELS, resolveLabels } from '@/verticals/agenda/labels'

import { PREVIEW_CONTACTS, PREVIEW_NOW, PREVIEW_TODAY, previewData } from './fake-data'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data })

interface PreviewProps {
  view: CalendarView
  clinic: boolean
  viewer: boolean
  dateKey: string
}

export function CalendarPreview({ view, clinic, viewer, dateKey }: PreviewProps) {
  const base = useMemo(() => previewData(clinic), [clinic])
  const [appointments, setAppointments] = useState<CalendarAppointment[]>(base.appointments)
  const apptsRef = useRef(appointments)
  useEffect(() => {
    apptsRef.current = appointments
  }, [appointments])

  const labels = useMemo(
    () => (clinic ? resolveLabels({ profesional: 'doctor', profesionales: 'doctores', cita: 'cita', citas: 'citas' }) : DEFAULT_LABELS),
    [clinic],
  )

  const api = useMemo<CalendarApi>(() => {
    const patch = (id: string, fn: (a: CalendarAppointment) => CalendarAppointment) =>
      setAppointments((list) => list.map((a) => (a.id === id ? fn(a) : a)))

    return {
      async listSlots({ serviceId, dateKey: day, staffId, excludeId }) {
        await wait(450)
        const service = base.services.find((s) => s.id === serviceId)
        const candidates = base.staff.filter(
          (s) =>
            (!staffId || s.id === staffId) &&
            base.staffServices.some((l) => l.staffId === s.id && l.serviceId === serviceId),
        )
        const slots: SlotOption[] = []
        for (let minute = 8 * 60; minute <= 17 * 60 + 30; minute += 30) {
          const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
          const startsAt = zonedTimeToUtc(day, time)
          const endsAt = new Date(startsAt.getTime() + (service?.durationMinutes ?? 30) * 60_000)
          if (startsAt.getTime() < PREVIEW_NOW.getTime() + 30 * 60_000) continue
          const free = candidates.filter(
            (s) =>
              !apptsRef.current.some(
                (a) =>
                  a.id !== excludeId &&
                  a.staffId === s.id &&
                  a.status !== 'cancelled' &&
                  a.startsAt < endsAt &&
                  a.endsAt > startsAt,
              ),
          )
          if (free.length > 0) slots.push({ startsAt: startsAt.toISOString(), staffIds: free.map((s) => s.id) })
        }
        return ok({ slots })
      },

      async create(input) {
        await wait(500)
        const startsAt = new Date(input.startsAtIso)
        const { hour } = zonedParts(startsAt)
        if (!input.outsideHoursOk && (hour < 7 || hour >= 19)) {
          return { ok: false, status: 409, code: 'outside_hours', error: 'Esa hora queda fuera del horario.' }
        }
        const service = base.services.find((s) => s.id === input.serviceId)
        const known = 'id' in input.contact ? PREVIEW_CONTACTS.find((c) => c.id === (input.contact as { id: string }).id) : null
        const id = `new-${Date.now()}`
        setAppointments((list) => [
          ...list,
          {
            id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + (service?.durationMinutes ?? 30) * 60_000),
            status: 'confirmed',
            staffId: input.staffId,
            serviceId: input.serviceId,
            serviceName: service?.name ?? null,
            contactId: known?.id ?? 'new',
            contactName: known?.name ?? ('name' in input.contact ? input.contact.name : null),
            contactPhone: known?.phone ?? null,
            patientName: input.patient ? ('name' in input.patient ? input.patient.name : (known?.patients.find((p) => p.id === (input.patient as { id: string }).id)?.fullName ?? null)) : null,
            conversationId: null,
            patientConfirmed: false,
          },
        ])
        return ok({ id, notified: input.notify, notifyError: null })
      },

      async move(id, input) {
        await wait(500)
        const current = apptsRef.current.find((a) => a.id === id)
        if (!current) return { ok: false, status: 404, code: 'not_found', error: 'La cita no existe.' }
        const startsAt = new Date(input.startsAtIso)
        patch(id, (a) => ({
          ...a,
          startsAt,
          endsAt: new Date(startsAt.getTime() + (a.endsAt.getTime() - a.startsAt.getTime())),
          staffId: input.staffId ?? a.staffId,
          patientConfirmed: false,
        }))
        return ok({ notified: input.notify, notifyError: null })
      },

      async cancel(id, input) {
        await wait(500)
        patch(id, (a) => ({ ...a, status: 'cancelled' }))
        return ok({ notified: input.notify, notifyError: null })
      },

      async setStatus(id, status) {
        await wait(400)
        patch(id, (a) => ({ ...a, status }))
        return ok(null)
      },
    }
  }, [base])

  const contacts = useMemo<ContactSource>(
    () => ({
      async search(query) {
        await wait(250)
        const q = query.toLowerCase()
        return PREVIEW_CONTACTS.filter(
          (c) => c.name?.toLowerCase().includes(q) || c.phone?.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§'),
        )
          .slice(0, 8)
          .map(({ id, name, phone }) => ({ id, name, phone }))
      },
      async patients(contactId) {
        await wait(250)
        return PREVIEW_CONTACTS.find((c) => c.id === contactId)?.patients ?? []
      },
    }),
    [],
  )

  const data = useMemo(() => ({ ...base, appointments }), [base, appointments])
  const noop = useCallback(() => {}, [])

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">Calendario</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Vista previa con datos de ejemplo. Nada de esto se guarda.
          </p>
        </div>
      </div>
      <CalendarWorkspace
        data={data}
        loading={false}
        loadError={null}
        labels={labels}
        clinic={clinic}
        canWrite={!viewer}
        api={api}
        contacts={contacts}
        fixedNow={PREVIEW_NOW}
        initialView={view}
        initialDateKey={dateKey || PREVIEW_TODAY}
        conversationHref={() => '#conversacion'}
        onRangeChange={noop}
        onChanged={noop}
        onRetry={noop}
      />
    </div>
  )
}
