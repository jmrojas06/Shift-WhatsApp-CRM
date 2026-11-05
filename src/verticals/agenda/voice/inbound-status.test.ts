import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { handleInboundStatus, inboundCallNote } from './inbound-status'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// El aviso de fin de una llamada ENTRANTE. Telnyx lo manda a la URL fija de la
// app de TeXML (no sabe el id de nuestra fila), así que la llamada se encuentra
// por su CallSid. Cierra la fila y, si quien llamó es un contacto, deja la nota
// "Llamó: …" en su ficha. Es idempotente: un reintento no repite la nota.
// ============================================================

const ACCOUNT = 'acc-1'
const OWNER = 'owner-1'
const CALL_ID = '99999999-9999-4999-8999-aaaaaaaaaaaa'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-11-05T15:05:00.000Z')

function seed(call: Row = {}): FakeDb {
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Clínica Sonrisa', owner_user_id: OWNER }],
    whatsapp_config: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    contact_notes: [],
    booking_calls: [
      callRowSeed({
        id: CALL_ID,
        direction: 'inbound',
        status: 'in_progress',
        contact_id: CONTACT,
        from_number: '+573001112233',
        to_number: '+576015550000',
        provider_call_sid: 'CA-1',
        ...call,
      }),
    ],
  })
}

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? []).find((row) => row.id === CALL_ID) as Row
const hit = (db: FakeDb, form: Record<string, string>) =>
  handleInboundStatus({ db: asDb(db), form: { CallSid: 'CA-1', ...form }, now: NOW })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('cierre de la llamada entrante', () => {
  it('la encuentra por el CallSid y guarda estado, duración y hora; sin resultado queda no_response', async () => {
    const db = seed()
    await hit(db, { CallStatus: 'completed', CallDuration: '42' })

    expect(callOf(db)).toMatchObject({
      status: 'completed',
      duration_seconds: 42,
      finished_at: NOW.toISOString(),
      outcome: 'no_response',
    })
  })

  it('respeta el resultado que dejó el menú', async () => {
    const db = seed({ outcome: 'booking_link_sent' })
    await hit(db, { CallStatus: 'completed', CallDuration: '30' })
    expect(callOf(db)).toMatchObject({ status: 'completed', outcome: 'booking_link_sent' })
  })

  it('un CallSid que no es de ninguna llamada entrante no cambia nada (ni lanza)', async () => {
    const db = seed({ direction: 'outbound' })
    const before = JSON.stringify(db._tables)
    await expect(hit(db, { CallStatus: 'completed' })).resolves.toBeUndefined()
    await expect(hit(db, { CallSid: '', CallStatus: 'completed' })).resolves.toBeUndefined()
    expect(JSON.stringify(db._tables)).toBe(before)
  })

  it('estados que no pedimos (ringing) no cierran ni anotan', async () => {
    const db = seed()
    await hit(db, { CallStatus: 'ringing' })
    expect(callOf(db).status).toBe('in_progress')
    expect(db._tables.contact_notes).toHaveLength(0)
  })
})

describe('nota "Llamó: …" en la ficha del contacto', () => {
  it('deja una nota con el resultado, a nombre del dueño de la cuenta', async () => {
    const db = seed({ outcome: 'booking_link_sent' })
    await hit(db, { CallStatus: 'completed' })

    expect(db._tables.contact_notes).toHaveLength(1)
    expect(db._tables.contact_notes[0]).toMatchObject({
      contact_id: CONTACT,
      account_id: ACCOUNT,
      user_id: OWNER,
    })
    expect(String(db._tables.contact_notes[0].note_text)).toMatch(/^Llamó: /)
    expect(String(db._tables.contact_notes[0].note_text)).toContain('agendar')
  })

  it('una llamada sin resultado anota que colgó sin elegir', async () => {
    const db = seed()
    await hit(db, { CallStatus: 'completed' })
    expect(db._tables.contact_notes[0].note_text).toBe('Llamó: colgó sin elegir una opción')
  })

  it('un reintento del aviso no repite la nota', async () => {
    const db = seed({ outcome: 'confirmed' })
    await hit(db, { CallStatus: 'completed' })
    await hit(db, { CallStatus: 'completed' })
    expect(db._tables.contact_notes).toHaveLength(1)
  })

  it('un número desconocido (sin contacto) no deja nota', async () => {
    const db = seed({ contact_id: null, outcome: 'info' })
    await hit(db, { CallStatus: 'completed' })
    expect(db._tables.contact_notes).toHaveLength(0)
  })

  it('no manda nada al paciente: no toca mensajes ni conversaciones', async () => {
    const db = seed({ outcome: 'confirmed' })
    db._tables.messages = []
    db._tables.conversations = []
    await hit(db, { CallStatus: 'completed' })
    expect(db._tables.messages).toHaveLength(0)
    expect(db._tables.conversations).toHaveLength(0)
  })

  it('si la nota no se puede guardar, la llamada igual queda cerrada y no lanza', async () => {
    const db = seed({ outcome: 'confirmed' })
    db._failNext('insert', 'contact_notes', { message: 'boom 573001112233' })
    await expect(hit(db, { CallStatus: 'completed' })).resolves.toBeUndefined()
    expect(callOf(db).status).toBe('completed')
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('573001112233')
  })

  it('sin dueño de la cuenta no hay a nombre de quién: no anota y no lanza', async () => {
    const db = seed({ outcome: 'confirmed' })
    db._tables.accounts = [{ id: ACCOUNT, name: 'x', owner_user_id: null }]
    await expect(hit(db, { CallStatus: 'completed' })).resolves.toBeUndefined()
    expect(db._tables.contact_notes).toHaveLength(0)
  })
})

describe('inboundCallNote', () => {
  it.each([
    ['confirmed', 'Llamó: confirmó su cita'],
    ['cancelled', 'Llamó: canceló su cita'],
    ['advisor_connected', 'Llamó: habló con un asesor'],
    ['advisor_missed', 'Llamó: pidió un asesor y nadie contestó'],
    ['out_of_hours', 'Llamó: pidió un asesor fuera del horario de atención'],
    ['info', 'Llamó: pidió el horario y la dirección'],
    ['urgency', 'Llamó: urgencia, y no había a quién pasar la llamada'],
    ['no_response', 'Llamó: colgó sin elegir una opción'],
  ] as const)('%s', (outcome, text) => {
    expect(inboundCallNote(outcome)).toBe(text)
  })

  it('cada resultado tiene su frase, empieza por "Llamó: " y no nombra a nadie', () => {
    const outcomes = [
      'confirmed', 'cancelled', 'human', 'no_response', 'wrong_number', 'booking_link_sent',
      'advisor_connected', 'advisor_missed', 'out_of_hours', 'info', 'urgency',
    ] as const
    for (const outcome of outcomes) {
      const text = inboundCallNote(outcome)
      expect(text.startsWith('Llamó: ')).toBe(true)
      expect(text.length).toBeLessThan(120)
    }
  })
})
