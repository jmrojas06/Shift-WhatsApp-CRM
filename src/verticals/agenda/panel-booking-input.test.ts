import { describe, expect, it } from 'vitest'

import {
  CANCEL_REASON_DEFAULT,
  CANCEL_REASON_MAX,
  parseCancelBody,
  parseCreateBody,
  parseMoveBody,
} from './panel-booking-input'

const CONTACT = '11111111-1111-4111-8111-111111111111'
const PATIENT = '55555555-5555-4555-8555-555555555555'
const SERVICE = '33333333-3333-4333-8333-333333333333'
const STAFF = '44444444-4444-4444-8444-444444444444'
const STARTS = '2026-11-09T15:00:00.000Z'

const create = (extra: Record<string, unknown> = {}) => ({
  contact_id: CONTACT,
  service_id: SERVICE,
  staff_id: STAFF,
  starts_at: STARTS,
  ...extra,
})

const failure = (result: { ok: boolean }) => {
  expect(result.ok).toBe(false)
  return (result as { ok: false; message: string }).message
}

describe('parseCreateBody', () => {
  it('acepta un contacto existente con los valores por defecto', () => {
    const res = parseCreateBody(create())
    expect(res).toEqual({
      ok: true,
      value: {
        contact: { id: CONTACT },
        patientId: null,
        newPatientName: null,
        serviceId: SERVICE,
        staffId: STAFF,
        startsAt: new Date(STARTS),
        outsideHoursOk: false,
        notify: true,
      },
    })
  })

  it('acepta un contacto nuevo y limpia los espacios del nombre', () => {
    const res = parseCreateBody(
      create({ contact_id: undefined, new_contact: { name: '  Ana   Pérez ', phone: '+57 300 123 4567' } }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.contact).toEqual({ name: 'Ana Pérez', phone: '+57 300 123 4567' })
    }
  })

  it('acepta una hora con desfase en vez de Z', () => {
    const res = parseCreateBody(create({ starts_at: '2026-11-09T10:00:00-05:00' }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.startsAt.toISOString()).toBe(STARTS)
  })

  it('lee los interruptores y el paciente', () => {
    const res = parseCreateBody(
      create({ patient_id: PATIENT, notify: false, outside_hours_ok: true }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.patientId).toBe(PATIENT)
      expect(res.value.notify).toBe(false)
      expect(res.value.outsideHoursOk).toBe(true)
    }
  })

  it('acepta un paciente nuevo por nombre', () => {
    const res = parseCreateBody(create({ new_patient_name: ' Luis  Gómez ' }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.newPatientName).toBe('Luis Gómez')
  })

  it.each([null, undefined, 'texto', 42, [], true])('rechaza un cuerpo que es %j', (body) => {
    expect(failure(parseCreateBody(body))).toMatch(/solicitud/i)
  })

  it('exige un contacto: existente o nuevo, pero no los dos ni ninguno', () => {
    expect(failure(parseCreateBody(create({ contact_id: undefined })))).toMatch(/contacto/i)
    expect(
      failure(parseCreateBody(create({ new_contact: { name: 'Ana', phone: '+573001234567' } }))),
    ).toMatch(/contacto/i)
  })

  it.each([
    ['contact_id', 'no-es-uuid'],
    ['service_id', 'x'],
    ['staff_id', 123],
    ['patient_id', 'abc'],
  ])('rechaza %s inválido', (field, value) => {
    expect(parseCreateBody(create({ [field]: value })).ok).toBe(false)
  })

  it.each([undefined, null, 'mañana', '2026-13-45T10:00:00Z', 1_700_000_000, '2026-11-09T10:00:00'])(
    'rechaza una hora de inicio inválida o sin zona: %j',
    (starts_at) => {
      expect(parseCreateBody(create({ starts_at })).ok).toBe(false)
    },
  )

  it('un teléfono sin + o con letras da un mensaje en palabras simples', () => {
    for (const phone of ['3001234567', '+57abc', '', '   ', '+1'.repeat(20)]) {
      const message = failure(
        parseCreateBody(
          create({ contact_id: undefined, new_contact: { name: 'Ana', phone } }),
        ),
      )
      expect(message).toMatch(/tel[eé]fono/i)
    }
  })

  it('un contacto nuevo necesita nombre', () => {
    expect(
      failure(
        parseCreateBody(
          create({ contact_id: undefined, new_contact: { name: '  ', phone: '+573001234567' } }),
        ),
      ),
    ).toMatch(/nombre/i)
  })

  it('rechaza dar paciente existente y nuevo a la vez', () => {
    expect(
      failure(parseCreateBody(create({ patient_id: PATIENT, new_patient_name: 'Luis Gómez' }))),
    ).toMatch(/paciente/i)
  })

  it('rechaza un nombre de paciente vacío o larguísimo', () => {
    expect(parseCreateBody(create({ new_patient_name: '   ' })).ok).toBe(false)
    expect(parseCreateBody(create({ new_patient_name: 'a'.repeat(121) })).ok).toBe(false)
  })

  it.each(['notify', 'outside_hours_ok'])('rechaza %s que no es booleano', (field) => {
    expect(parseCreateBody(create({ [field]: 'si' })).ok).toBe(false)
    expect(parseCreateBody(create({ [field]: 1 })).ok).toBe(false)
  })
})

describe('parseMoveBody', () => {
  it('acepta solo la hora nueva', () => {
    expect(parseMoveBody({ action: 'move', starts_at: STARTS })).toEqual({
      ok: true,
      value: { startsAt: new Date(STARTS), staffId: null, notify: true, outsideHoursOk: false },
    })
  })

  it('acepta cambiar de profesional y los interruptores', () => {
    const res = parseMoveBody({
      action: 'move',
      starts_at: STARTS,
      staff_id: STAFF,
      notify: false,
      outside_hours_ok: true,
    })
    expect(res).toEqual({
      ok: true,
      value: { startsAt: new Date(STARTS), staffId: STAFF, notify: false, outsideHoursOk: true },
    })
  })

  it('un staff_id null significa "el mismo profesional"', () => {
    const res = parseMoveBody({ action: 'move', starts_at: STARTS, staff_id: null })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.staffId).toBeNull()
  })

  it('rechaza hora ausente, mala o sin zona, y staff_id inválido', () => {
    expect(parseMoveBody({ action: 'move' }).ok).toBe(false)
    expect(parseMoveBody({ action: 'move', starts_at: 'hoy' }).ok).toBe(false)
    expect(parseMoveBody({ action: 'move', starts_at: '2026-11-09T10:00:00' }).ok).toBe(false)
    expect(parseMoveBody({ action: 'move', starts_at: STARTS, staff_id: 'x' }).ok).toBe(false)
    expect(parseMoveBody({ action: 'move', starts_at: STARTS, notify: 'no' }).ok).toBe(false)
  })
})

describe('parseCancelBody', () => {
  it('por defecto el motivo es "clinic", avisa y no confirma el pasado', () => {
    expect(parseCancelBody({ action: 'cancel' })).toEqual({
      ok: true,
      value: { reason: CANCEL_REASON_DEFAULT, notify: true, confirmPast: false },
    })
    expect(CANCEL_REASON_DEFAULT).toBe('clinic')
  })

  it('acepta un motivo escrito y lo recorta', () => {
    const res = parseCancelBody({ action: 'cancel', reason: '  Paciente viaja  ', notify: false })
    expect(res).toEqual({
      ok: true,
      value: { reason: 'Paciente viaja', notify: false, confirmPast: false },
    })
  })

  it('un motivo vacío o null vuelve al de por defecto', () => {
    for (const reason of ['', '   ', null]) {
      const res = parseCancelBody({ action: 'cancel', reason })
      expect(res.ok && res.value.reason).toBe(CANCEL_REASON_DEFAULT)
    }
  })

  it('rechaza un motivo de más de 200 caracteres o que no es texto', () => {
    expect(parseCancelBody({ action: 'cancel', reason: 'a'.repeat(CANCEL_REASON_MAX + 1) }).ok).toBe(
      false,
    )
    expect(parseCancelBody({ action: 'cancel', reason: 'a'.repeat(CANCEL_REASON_MAX) }).ok).toBe(true)
    expect(parseCancelBody({ action: 'cancel', reason: 5 }).ok).toBe(false)
  })

  it('lee confirm_past y rechaza interruptores que no son booleanos', () => {
    const res = parseCancelBody({ action: 'cancel', confirm_past: true })
    expect(res.ok && res.value.confirmPast).toBe(true)
    expect(parseCancelBody({ action: 'cancel', notify: 'si' }).ok).toBe(false)
    expect(parseCancelBody({ action: 'cancel', confirm_past: 1 }).ok).toBe(false)
  })
})
