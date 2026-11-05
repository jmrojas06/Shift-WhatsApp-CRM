import { describe, expect, it } from 'vitest'

import { chairsFreeAt, loadChairContext } from './chairs'
import { asClient, makeFakeDb, type Row } from './testing/fake-db'

const ACCOUNT = 'acc-1'

const at = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00.000Z`)
const range = (from: string, to: string) => ({ startsAt: at(from), endsAt: at(to) })

describe('chairsFreeAt', () => {
  it('sin cupo puesto (null), siempre hay silla', () => {
    expect(
      chairsFreeAt({
        ...range('14:00', '14:30'),
        chairCount: null,
        active: [range('14:00', '14:30'), range('14:00', '14:30'), range('14:00', '14:30')],
      }),
    ).toBe(true)
  })

  it('con menos citas cruzadas que sillas, hay silla', () => {
    expect(
      chairsFreeAt({
        ...range('14:00', '14:30'),
        chairCount: 2,
        active: [range('14:00', '14:30')],
      }),
    ).toBe(true)
  })

  it('con tantas citas cruzadas como sillas, no hay silla', () => {
    expect(
      chairsFreeAt({
        ...range('14:00', '14:30'),
        chairCount: 2,
        active: [range('14:00', '14:30'), range('14:00', '15:00')],
      }),
    ).toBe(false)
  })

  it('un cruce parcial también ocupa la silla', () => {
    const active = [range('13:45', '14:15'), range('14:15', '14:45')]
    expect(chairsFreeAt({ ...range('14:00', '14:30'), chairCount: 2, active })).toBe(false)
    expect(chairsFreeAt({ ...range('14:00', '14:30'), chairCount: 3, active })).toBe(true)
  })

  it('una cita que termina justo cuando empieza la hora (o empieza cuando termina) no cruza', () => {
    const active = [range('13:30', '14:00'), range('14:30', '15:00')]
    expect(chairsFreeAt({ ...range('14:00', '14:30'), chairCount: 1, active })).toBe(true)
  })

  it('las citas lejanas no cuentan', () => {
    expect(
      chairsFreeAt({
        ...range('14:00', '14:30'),
        chairCount: 1,
        active: [range('09:00', '09:30'), range('16:00', '16:30')],
      }),
    ).toBe(true)
  })

  it('sin citas, hay silla con cualquier cupo', () => {
    expect(chairsFreeAt({ ...range('14:00', '14:30'), chairCount: 1, active: [] })).toBe(true)
  })
})

describe('loadChairContext', () => {
  const FROM = '2026-10-19T05:00:00.000Z'
  const TO = '2026-10-20T05:00:00.000Z'

  const location = (extra: Row = {}): Row => ({
    id: 'loc-1',
    account_id: ACCOUNT,
    name: 'Centro',
    chair_count: 2,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  })

  const appointment = (id: string, startsAt: string, endsAt: string, extra: Row = {}): Row => ({
    id,
    account_id: ACCOUNT,
    staff_id: 'st-1',
    status: 'pending',
    starts_at: startsAt,
    ends_at: endsAt,
    ...extra,
  })

  it('lee el cupo de la sede activa y las citas activas de toda la cuenta', async () => {
    const db = makeFakeDb({
      clinic_locations: [location()],
      booking_appointments: [
        appointment('a-1', '2026-10-19T14:00:00.000Z', '2026-10-19T14:30:00.000Z', {
          status: 'confirmed',
        }),
        // Otro profesional: igual ocupa una silla.
        appointment('a-2', '2026-10-19T15:00:00.000Z', '2026-10-19T15:30:00.000Z', {
          staff_id: 'st-2',
        }),
      ],
    })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context.chairCount).toBe(2)
    expect(context.active).toEqual([
      { startsAt: new Date('2026-10-19T14:00:00.000Z'), endsAt: new Date('2026-10-19T14:30:00.000Z') },
      { startsAt: new Date('2026-10-19T15:00:00.000Z'), endsAt: new Date('2026-10-19T15:30:00.000Z') },
    ])
  })

  it('una cita cancelada no cuenta', async () => {
    const db = makeFakeDb({
      clinic_locations: [location({ chair_count: 1 })],
      booking_appointments: [
        appointment('a-1', '2026-10-19T14:00:00.000Z', '2026-10-19T14:30:00.000Z', {
          status: 'cancelled',
        }),
        appointment('a-2', '2026-10-19T15:00:00.000Z', '2026-10-19T15:30:00.000Z', {
          status: 'completed',
        }),
      ],
    })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context.active).toEqual([])
    expect(
      chairsFreeAt({
        startsAt: new Date('2026-10-19T14:00:00.000Z'),
        endsAt: new Date('2026-10-19T14:30:00.000Z'),
        ...context,
      }),
    ).toBe(true)
  })

  it('deja fuera las citas de otra cuenta y las que están fuera del rango', async () => {
    const db = makeFakeDb({
      clinic_locations: [location()],
      booking_appointments: [
        appointment('a-ajena', '2026-10-19T14:00:00.000Z', '2026-10-19T14:30:00.000Z', {
          account_id: 'acc-2',
        }),
        appointment('a-antes', '2026-10-19T03:00:00.000Z', '2026-10-19T04:00:00.000Z'),
        appointment('a-despues', '2026-10-20T06:00:00.000Z', '2026-10-20T07:00:00.000Z'),
        appointment('a-dentro', '2026-10-19T16:00:00.000Z', '2026-10-19T16:30:00.000Z'),
      ],
    })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context.active).toEqual([
      { startsAt: new Date('2026-10-19T16:00:00.000Z'), endsAt: new Date('2026-10-19T16:30:00.000Z') },
    ])
  })

  it('una cita que cruza el borde del rango sí cuenta', async () => {
    const db = makeFakeDb({
      clinic_locations: [location()],
      booking_appointments: [
        appointment('a-borde', '2026-10-19T04:30:00.000Z', '2026-10-19T05:30:00.000Z'),
      ],
    })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context.active).toHaveLength(1)
  })

  it('toma la primera sede activa de la cuenta, no las inactivas ni las de otra cuenta', async () => {
    const db = makeFakeDb({
      clinic_locations: [
        location({ id: 'loc-vieja', chair_count: 9, is_active: false, created_at: '2025-01-01T00:00:00.000Z' }),
        location({ id: 'loc-ajena', chair_count: 8, account_id: 'acc-2', created_at: '2025-06-01T00:00:00.000Z' }),
        location({ id: 'loc-2', chair_count: 4, created_at: '2026-05-01T00:00:00.000Z' }),
        location({ id: 'loc-1', chair_count: 3, created_at: '2026-01-01T00:00:00.000Z' }),
      ],
      booking_appointments: [],
    })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context.chairCount).toBe(3)
  })

  it('sin cupo puesto devuelve null y no lee las citas', async () => {
    const db = makeFakeDb({
      clinic_locations: [location({ chair_count: null })],
      booking_appointments: [
        appointment('a-1', '2026-10-19T14:00:00.000Z', '2026-10-19T14:30:00.000Z'),
      ],
    })
    // Si lo intentara, esta falla saldría: no hay cupo que comparar.
    db._failNext('select', 'booking_appointments', { message: 'no debería leerse' })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context).toEqual({ chairCount: null, active: [] })
  })

  it('sin ninguna sede activa devuelve null (sin límite)', async () => {
    const db = makeFakeDb({
      clinic_locations: [location({ is_active: false })],
      booking_appointments: [],
    })
    const context = await loadChairContext(asClient(db), ACCOUNT, FROM, TO)
    expect(context).toEqual({ chairCount: null, active: [] })
  })

  it('si no puede leer la sede, lanza: nunca contesta "hay silla"', async () => {
    const db = makeFakeDb({ clinic_locations: [location()], booking_appointments: [] })
    db._failNext('select', 'clinic_locations', { message: 'se cayó la base' })
    await expect(loadChairContext(asClient(db), ACCOUNT, FROM, TO)).rejects.toThrow(
      'No se pudo leer el cupo de sillones',
    )
  })

  it('si no puede leer las citas, lanza', async () => {
    const db = makeFakeDb({ clinic_locations: [location()], booking_appointments: [] })
    db._failNext('select', 'booking_appointments', { message: 'se cayó la base' })
    await expect(loadChairContext(asClient(db), ACCOUNT, FROM, TO)).rejects.toThrow(
      'No se pudieron leer las citas',
    )
  })
})
