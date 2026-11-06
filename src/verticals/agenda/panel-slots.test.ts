import { describe, expect, it } from 'vitest'

import type { MergedSlot } from './agent/availability'
import { parseSlotsQuery, toPanelSlots } from './panel-slots'

const SERVICE = '33333333-3333-4333-8333-333333333333'
const STAFF = '44444444-4444-4444-8444-444444444444'
const APPOINTMENT = '77777777-7777-4777-8777-777777777777'

const params = (entries: Record<string, string>) => new URLSearchParams(entries)

const failure = (result: { ok: boolean }) => {
  expect(result.ok).toBe(false)
  return (result as { ok: false; message: string }).message
}

describe('parseSlotsQuery', () => {
  it('acepta servicio y día; el profesional y la cita a excluir son opcionales', () => {
    expect(parseSlotsQuery(params({ service_id: SERVICE, date: '2026-11-09' }))).toEqual({
      ok: true,
      value: {
        serviceId: SERVICE,
        staffId: null,
        dateKey: '2026-11-09',
        excludeAppointmentId: null,
      },
    })
  })

  it('lee el profesional y la cita a excluir', () => {
    expect(
      parseSlotsQuery(
        params({ service_id: SERVICE, staff_id: STAFF, date: '2026-11-09', exclude: APPOINTMENT }),
      ),
    ).toEqual({
      ok: true,
      value: {
        serviceId: SERVICE,
        staffId: STAFF,
        dateKey: '2026-11-09',
        excludeAppointmentId: APPOINTMENT,
      },
    })
  })

  it('un profesional o una cita vacíos cuentan como "sin elegir" ("Cualquiera")', () => {
    const res = parseSlotsQuery(
      params({ service_id: SERVICE, staff_id: '', date: '2026-11-09', exclude: '' }),
    )
    expect(res).toMatchObject({ ok: true, value: { staffId: null, excludeAppointmentId: null } })
  })

  it('pide la atención cuando falta o no es un uuid', () => {
    expect(failure(parseSlotsQuery(params({ date: '2026-11-09' })))).toBe('Elige la atención.')
    expect(
      failure(parseSlotsQuery(params({ service_id: 'no-es-uuid', date: '2026-11-09' }))),
    ).toBe('Elige la atención.')
  })

  it('rechaza un profesional o una cita que no son uuid', () => {
    expect(
      failure(parseSlotsQuery(params({ service_id: SERVICE, staff_id: 'x', date: '2026-11-09' }))),
    ).toBe('Elige quién atiende.')
    expect(
      failure(parseSlotsQuery(params({ service_id: SERVICE, date: '2026-11-09', exclude: 'x' }))),
    ).toBe('La cita elegida no es válida.')
  })

  it('exige un día con formato AAAA-MM-DD que exista de verdad', () => {
    const message = 'Elige un día válido.'
    for (const date of ['', '09/11/2026', '2026-11-9', '2026-13-01', '2026-02-30', '2026-11-09T00:00', 'hoy']) {
      expect(failure(parseSlotsQuery(params({ service_id: SERVICE, date })))).toBe(message)
    }
    expect(failure(parseSlotsQuery(params({ service_id: SERVICE })))).toBe(message)
    // 29 de febrero solo en año bisiesto.
    expect(parseSlotsQuery(params({ service_id: SERVICE, date: '2028-02-29' })).ok).toBe(true)
    expect(parseSlotsQuery(params({ service_id: SERVICE, date: '2027-02-29' })).ok).toBe(false)
  })
})

describe('toPanelSlots', () => {
  const slot = (iso: string, staffIds: string[]): MergedSlot => ({
    startsAt: new Date(iso),
    endsAt: new Date(new Date(iso).getTime() + 30 * 60_000),
    label: '9:00 a. m.',
    dateKey: '2026-11-09',
    staffIds,
  })

  it('devuelve solo la hora de inicio (ISO) y quiénes están libres', () => {
    expect(
      toPanelSlots([
        slot('2026-11-09T14:00:00.000Z', [STAFF]),
        slot('2026-11-09T14:30:00.000Z', [STAFF, 'otro']),
      ]),
    ).toEqual([
      { starts_at: '2026-11-09T14:00:00.000Z', staff_ids: [STAFF] },
      { starts_at: '2026-11-09T14:30:00.000Z', staff_ids: [STAFF, 'otro'] },
    ])
  })

  it('sin horas libres, lista vacía', () => {
    expect(toPanelSlots([])).toEqual([])
  })
})
