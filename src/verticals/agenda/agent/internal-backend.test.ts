import { describe, expect, it } from 'vitest'

import type { ServiceInfo } from './db'
import { createInternalBackend } from './internal-backend'
import { asClient, makeFakeDb } from './testing/fake-db'

const ACCOUNT = 'acc-1'
const STAFF = 'st-1'
/** Lunes 19 de octubre de 2026, 08:00 en Bogotá. */
const NOW = new Date('2026-10-19T13:00:00Z')
const service: ServiceInfo = {
  id: 'svc-1',
  name: 'Limpieza',
  description: null,
  durationMinutes: 30,
  price: 0,
}

const seed = () =>
  makeFakeDb({
    booking_working_hours: [
      { account_id: ACCOUNT, staff_id: STAFF, weekday: 1, start_time: '09:00:00', end_time: '10:00:00' },
    ],
    booking_appointments: [],
    booking_time_off: [],
  })

const bookArgs = {
  id: 'ap-1',
  contactId: 'ct-1',
  conversationId: 'cv-1',
  serviceId: 'svc-1',
  staffId: STAFF,
  startsAtIso: '2026-10-19T14:00:00.000Z',
  endsAtIso: '2026-10-19T14:30:00.000Z',
  confirmedAtIso: NOW.toISOString(),
}

describe('InternalBackend', () => {
  it('devuelve las horas del día y descuenta las ocupadas', async () => {
    const db = seed()
    db._tables.booking_appointments.push({
      account_id: ACCOUNT,
      staff_id: STAFF,
      status: 'confirmed',
      starts_at: '2026-10-19T14:00:00.000Z',
      ends_at: '2026-10-19T14:30:00.000Z',
    })
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: NOW,
    })
    expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
  })

  it('getDaysWithSlots solo trae días con cupo', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    const keys = await backend.getDaysWithSlots({
      service,
      staffIds: [STAFF],
      fromKey: '2026-10-19',
      days: 8,
      now: NOW,
    })
    expect(keys).toEqual(['2026-10-19', '2026-10-26'])
  })

  it('getDaySlots no ofrece horas pasadas', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    // 08:45 en Bogotá: las 9:00 caen dentro del margen de 30 minutos.
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: new Date('2026-10-19T13:45:00Z'),
    })
    expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
  })

  it('getDaysWithSlots descuenta el último día del rango', async () => {
    const db = seed()
    // Lunes 26, 9:00 a 10:00 en Bogotá: tapa todo el bloque de ese día.
    db._tables.booking_appointments.push({
      account_id: ACCOUNT,
      staff_id: STAFF,
      status: 'confirmed',
      starts_at: '2026-10-26T14:00:00.000Z',
      ends_at: '2026-10-26T15:00:00.000Z',
    })
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const keys = await backend.getDaysWithSlots({
      service,
      staffIds: [STAFF],
      fromKey: '2026-10-19',
      days: 8,
      now: NOW,
    })
    expect(keys).toEqual(['2026-10-19'])
  })

  it('getDaySlots solo cuenta como libre a quien trabaja ese día', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    // 'st-2' no tiene bloques de trabajo: no puede aparecer como libre.
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF, 'st-2'],
      dateKey: '2026-10-19',
      now: NOW,
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots[0].staffIds).toEqual([STAFF])
  })

  it('book distingue un choque de otro error', async () => {
    const db = seed()
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })

    db._failNext('insert', 'booking_appointments', { code: '23P01', message: 'overlap' })
    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'slot_taken' })

    db._failNext('insert', 'booking_appointments', { code: 'XX000', message: 'caída' })
    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'failed', message: 'caída' })

    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'ok' })
    expect(db._tables.booking_appointments).toHaveLength(1)
  })
})
