import { describe, expect, it } from 'vitest'

import type { FakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import {
  dialableNumber,
  findCallBySid,
  findInboundAccount,
  findOrCreateInboundCall,
  loadNextAppointment,
} from './inbound-repo'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// Lecturas y escrituras de la llamada entrante: la cuenta por el número que
// se marcó, la fila de la llamada (sin duplicarla si Telnyx reintenta) y la
// próxima cita de quien llama.
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const STAFF = '44444444-4444-4444-8444-444444444444'
const PATIENT = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-11-05T15:00:00.000Z')

function seed(extra: Record<string, Record<string, unknown>[]> = {}): FakeDb {
  return makeCallDb({
    booking_call_settings: [
      { account_id: ACCOUNT, inbound_enabled: true, inbound_number: '+576015550000', advisor_phones: ['+573001110000'] },
      { account_id: OTHER_ACCOUNT, inbound_enabled: true, inbound_number: '+576015559999', advisor_phones: [] },
    ],
    booking_appointments: [
      { id: 'ap-late', account_id: ACCOUNT, contact_id: CONTACT, staff_id: null, patient_id: null, status: 'confirmed', starts_at: '2026-11-12T20:00:00.000Z' },
      { id: 'ap-soon', account_id: ACCOUNT, contact_id: CONTACT, staff_id: STAFF, patient_id: PATIENT, status: 'pending', starts_at: '2026-11-06T20:30:00.000Z' },
      { id: 'ap-cancelled', account_id: ACCOUNT, contact_id: CONTACT, staff_id: null, patient_id: null, status: 'cancelled', starts_at: '2026-11-05T22:00:00.000Z' },
      { id: 'ap-past', account_id: ACCOUNT, contact_id: CONTACT, staff_id: null, patient_id: null, status: 'confirmed', starts_at: '2026-11-04T20:00:00.000Z' },
      { id: 'ap-other-contact', account_id: ACCOUNT, contact_id: 'other', staff_id: null, patient_id: null, status: 'confirmed', starts_at: '2026-11-05T21:00:00.000Z' },
    ],
    booking_staff: [{ id: STAFF, account_id: ACCOUNT, name: 'Dra. Rojas' }],
    clinic_patients: [{ id: PATIENT, account_id: ACCOUNT, full_name: 'Ana Pérez' }],
    clinic_locations: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    ...extra,
  })
}

describe('findInboundAccount', () => {
  it('encuentra la cuenta por el número marcado y lee su configuración', async () => {
    const found = await findInboundAccount(asDb(seed()), '+576015550000')
    expect(found?.accountId).toBe(ACCOUNT)
    expect(found?.settings.inboundEnabled).toBe(true)
    expect(found?.settings.advisorPhones).toEqual(['+573001110000'])
  })

  it('un número que no es de ninguna cuenta (o no es válido) no encuentra nada', async () => {
    expect(await findInboundAccount(asDb(seed()), '+576010000000')).toBeNull()
    expect(await findInboundAccount(asDb(seed()), null)).toBeNull()
  })

  it('un fallo de lectura lanza: no es "este número no existe"', async () => {
    const db = seed()
    db._failNext('select', 'booking_call_settings', { message: 'boom' })
    await expect(findInboundAccount(asDb(db), '+576015550000')).rejects.toThrow(/configuración de llamadas/)
  })
})

describe('findOrCreateInboundCall', () => {
  const args = { accountId: ACCOUNT, sid: 'CA-1', from: '+573001112233', to: '+576015550000', contactId: CONTACT, now: NOW }

  it('crea la fila entrante del robot en curso, sin cita ni intento', async () => {
    const db = seed()
    const call = await findOrCreateInboundCall(asDb(db), args)
    expect(call).toMatchObject({
      accountId: ACCOUNT,
      direction: 'inbound',
      channel: 'robot',
      appointmentId: null,
      attempt: null,
      contactId: CONTACT,
      fromNumber: '+573001112233',
      toNumber: '+576015550000',
      status: 'in_progress',
      providerCallSid: 'CA-1',
      outcome: null,
      createdAt: NOW.toISOString(),
    })
    expect(call.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(db._tables.booking_calls).toHaveLength(1)
  })

  it('un reintento de Telnyx (mismo CallSid) devuelve la misma fila, sin duplicar', async () => {
    const db = seed()
    const first = await findOrCreateInboundCall(asDb(db), args)
    const again = await findOrCreateInboundCall(asDb(db), args)
    expect(again.id).toBe(first.id)
    expect(db._tables.booking_calls).toHaveLength(1)
  })

  it('el mismo CallSid en otra cuenta o en una saliente no cuenta como la misma llamada', async () => {
    const db = seed({
      booking_calls: [
        callRowSeed({ id: 'x-other-account', account_id: OTHER_ACCOUNT, direction: 'inbound', provider_call_sid: 'CA-1' }),
        callRowSeed({ id: 'x-outbound', account_id: ACCOUNT, direction: 'outbound', provider_call_sid: 'CA-1' }),
      ],
    })
    const call = await findOrCreateInboundCall(asDb(db), args)
    expect(call.id).not.toBe('x-other-account')
    expect(call.id).not.toBe('x-outbound')
    expect(db._tables.booking_calls).toHaveLength(3)
  })

  it('guarda null cuando quien llama no mostró un número válido', async () => {
    const db = seed()
    const call = await findOrCreateInboundCall(asDb(db), { ...args, from: null, contactId: null })
    expect(call.fromNumber).toBeNull()
    expect(call.contactId).toBeNull()
  })

  it('un CallSid larguísimo se recorta a 100 caracteres', async () => {
    const db = seed()
    const call = await findOrCreateInboundCall(asDb(db), { ...args, sid: 'C'.repeat(300) })
    expect(call.providerCallSid).toHaveLength(100)
  })

  it('si la base rechaza el insert lanza, sin el número en el mensaje', async () => {
    const db = seed()
    db._failNext('insert', 'booking_calls', { message: 'boom' })
    const error = await findOrCreateInboundCall(asDb(db), args).catch((err: Error) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/registrar la llamada/)
    expect((error as Error).message).not.toContain('573001112233')
  })
})

describe('findCallBySid', () => {
  it('encuentra la llamada entrante por su CallSid', async () => {
    const db = seed({ booking_calls: [callRowSeed({ id: 'c-in', direction: 'inbound', provider_call_sid: 'CA-9' })] })
    expect((await findCallBySid(asDb(db), 'CA-9'))?.id).toBe('c-in')
    expect(await findCallBySid(asDb(db), 'CA-0')).toBeNull()
    expect(await findCallBySid(asDb(db), '')).toBeNull()
  })

  it('no confunde una llamada saliente', async () => {
    const db = seed({ booking_calls: [callRowSeed({ id: 'c-out', direction: 'outbound', provider_call_sid: 'CA-9' })] })
    expect(await findCallBySid(asDb(db), 'CA-9')).toBeNull()
  })
})

describe('loadNextAppointment', () => {
  it('lee la próxima cita activa (pendiente o confirmada y futura) del contacto', async () => {
    const next = await loadNextAppointment(asDb(seed()), { accountId: ACCOUNT, contactId: CONTACT, clinic: false, now: NOW })
    expect(next?.id).toBe('ap-soon')
    expect(next?.speech).toEqual({
      patient: null,
      day: 'mañana',
      time: 'a las 3 y media de la tarde',
      staff: 'la doctora Rojas',
    })
  })

  it('en una clínica dice a nombre de quién es la cita', async () => {
    const next = await loadNextAppointment(asDb(seed()), { accountId: ACCOUNT, contactId: CONTACT, clinic: true, now: NOW })
    expect(next?.speech.patient).toBe('Ana Pérez')
  })

  it('sin citas activas devuelve null (canceladas, pasadas y de otro contacto no cuentan)', async () => {
    const db = seed()
    db._tables.booking_appointments = db._tables.booking_appointments.filter((row) => row.id !== 'ap-soon' && row.id !== 'ap-late')
    expect(await loadNextAppointment(asDb(db), { accountId: ACCOUNT, contactId: CONTACT, clinic: false, now: NOW })).toBeNull()
  })

  it('la cita de otra cuenta nunca aparece', async () => {
    expect(await loadNextAppointment(asDb(seed()), { accountId: OTHER_ACCOUNT, contactId: CONTACT, clinic: false, now: NOW })).toBeNull()
  })

  it('un fallo de lectura lanza: no es "no tienes citas"', async () => {
    const db = seed()
    db._failNext('select', 'booking_appointments', { message: 'boom' })
    await expect(
      loadNextAppointment(asDb(db), { accountId: ACCOUNT, contactId: CONTACT, clinic: false, now: NOW }),
    ).rejects.toThrow(/citas/)
  })

  it('sin el nombre del profesional ni del paciente igual lee la cita', async () => {
    const db = seed()
    db._tables.booking_staff = []
    db._tables.clinic_patients = []
    const next = await loadNextAppointment(asDb(db), { accountId: ACCOUNT, contactId: CONTACT, clinic: true, now: NOW })
    expect(next?.speech.staff).toBeNull()
    expect(typeof next?.speech.patient === 'string' || next?.speech.patient === null).toBe(true)
  })
})

describe('dialableNumber', () => {
  it('acepta E.164 con o sin formato', () => {
    expect(dialableNumber('+57 300 123 4567')).toBe('+573001234567')
    expect(dialableNumber('+573001234567')).toBe('+573001234567')
  })

  it('un celular colombiano de 10 dígitos sin indicativo se completa con +57', () => {
    expect(dialableNumber('300 123 4567')).toBe('+573001234567')
    expect(dialableNumber('3001234567')).toBe('+573001234567')
  })

  it('lo que no se puede marcar da null', () => {
    expect(dialableNumber(null)).toBeNull()
    expect(dialableNumber('')).toBeNull()
    expect(dialableNumber('llamar a Juan')).toBeNull()
    expect(dialableNumber('12345')).toBeNull()
  })
})
