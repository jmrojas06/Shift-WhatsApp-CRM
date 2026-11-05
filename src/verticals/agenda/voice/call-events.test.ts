import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { handleDialResult, handleStatusCallback, mapCallStatus } from './call-events'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// Lo que Telnyx avisa DESPUÉS de las instrucciones:
//   - dial-result: terminó el `Dial` a los asesores (compartido con las
//     llamadas entrantes de T14);
//   - status: terminó la llamada (completada, ocupado, sin respuesta, fallida).
// Los dos son idempotentes: un reintento no repite avisos ni cambia resultados.
// ============================================================

const ACCOUNT = 'acc-1'
const OWNER = 'owner-1'
const CALL_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-11-05T15:05:00.000Z')

function seed(call: Row = {}, extra: Record<string, Row[]> = {}): FakeDb {
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Clínica Sonrisa', owner_user_id: OWNER }],
    booking_call_settings: [{ account_id: ACCOUNT, voice: null }],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-10-01T00:00:00.000Z' }],
    ai_configs: [],
    notifications: [],
    booking_calls: [
      callRowSeed({
        id: CALL_ID,
        contact_id: CONTACT,
        from_number: '+576015550000',
        to_number: '+573001112233',
        ...call,
      }),
    ],
    ...extra,
  })
}

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? []).find((row) => row.id === CALL_ID) as Row
const said = (xml: string) => [...xml.matchAll(/<Say [^>]*>([^<]*)<\/Say>/g)].map((m) => m[1])

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('mapCallStatus', () => {
  it.each([
    ['completed', 'completed'],
    ['busy', 'busy'],
    ['no-answer', 'no_answer'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['cancelled', 'canceled'],
    ['in-progress', 'in_progress'],
    ['COMPLETED', 'completed'],
  ])('%s → %s', (raw, expected) => {
    expect(mapCallStatus(raw)).toBe(expected)
  })

  it.each([['ringing'], ['initiated'], ['queued'], [''], [undefined], ['otra-cosa']])(
    '%s no cambia el estado',
    (raw) => {
      expect(mapCallStatus(raw)).toBeNull()
    },
  )
})

describe('dial-result', () => {
  it('un asesor contestó: el resultado es advisor_connected y solo cuelga al terminar', async () => {
    const db = seed({ status: 'in_progress' })
    const { xml } = await handleDialResult({ db: asDb(db), callId: CALL_ID, form: { DialCallStatus: 'completed' }, now: NOW })

    expect(callOf(db).outcome).toBe('advisor_connected')
    expect(said(xml)).toEqual([])
    expect(xml).toContain('<Hangup/>')
    expect(db._tables.notifications).toHaveLength(0)
  })

  it.each([['no-answer'], ['busy'], ['failed'], ['canceled']])(
    'nadie contestó (%s): advisor_missed, aviso en la app y la frase del diseño',
    async (status) => {
      const db = seed({ status: 'in_progress' })
      const { xml } = await handleDialResult({ db: asDb(db), callId: CALL_ID, form: { DialCallStatus: status }, now: NOW })

      expect(callOf(db).outcome).toBe('advisor_missed')
      expect(said(xml)).toEqual([
        'En este momento no hay asesores disponibles. Le avisamos al equipo para que te llame.',
      ])
      expect(xml).toContain('<Hangup/>')
      expect(db._tables.notifications).toHaveLength(1)
      expect(db._tables.notifications[0]).toMatchObject({ user_id: OWNER, contact_id: CONTACT, conversation_id: 'conv-1' })
      expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:/)
      expect(String(db._tables.notifications[0].body)).toContain('Ana Pérez')
    },
  )

  it('es idempotente: un reintento no duplica el aviso ni cambia el resultado', async () => {
    const db = seed()
    const args = { db: asDb(db), callId: CALL_ID, form: { DialCallStatus: 'no-answer' }, now: NOW }
    const first = await handleDialResult(args)
    const second = await handleDialResult(args)

    expect(second.xml).toBe(first.xml)
    expect(db._tables.notifications).toHaveLength(1)
    expect(callOf(db).outcome).toBe('advisor_missed')
  })

  it('en una llamada entrante sin contacto, el aviso usa el número de quien llamó', async () => {
    const db = seed({ direction: 'inbound', contact_id: null, from_number: '+573009998877', to_number: '+576015550000' })
    await handleDialResult({ db: asDb(db), callId: CALL_ID, form: { DialCallStatus: 'no-answer' }, now: NOW })

    expect(db._tables.notifications).toHaveLength(1)
    expect(String(db._tables.notifications[0].body)).toContain('+573009998877')
    expect(db._tables.notifications[0].conversation_id).toBeNull()
  })

  it('pisa un no_response puesto por la señal final si esa llegó primero', async () => {
    const db = seed({ outcome: 'no_response', status: 'completed' })
    await handleDialResult({ db: asDb(db), callId: CALL_ID, form: { DialCallStatus: 'completed' }, now: NOW })
    expect(callOf(db).outcome).toBe('advisor_connected')
  })

  it.each(['info', 'out_of_hours'] as const)(
    'una llamada entrante que leyó el menú (%s) y luego pidió un asesor toma el resultado del asesor',
    async (earlier) => {
      const connected = seed({ direction: 'inbound', outcome: earlier })
      await handleDialResult({ db: asDb(connected), callId: CALL_ID, form: { DialCallStatus: 'completed' }, now: NOW })
      expect(callOf(connected).outcome).toBe('advisor_connected')

      const missed = seed({ direction: 'inbound', outcome: earlier })
      await handleDialResult({ db: asDb(missed), callId: CALL_ID, form: { DialCallStatus: 'no-answer' }, now: NOW })
      expect(callOf(missed).outcome).toBe('advisor_missed')
      expect(missed._tables.notifications).toHaveLength(1)
    },
  )

  it('no pisa otros resultados (p. ej. una confirmación)', async () => {
    const db = seed({ outcome: 'confirmed' })
    await handleDialResult({ db: asDb(db), callId: CALL_ID, form: { DialCallStatus: 'no-answer' }, now: NOW })
    expect(callOf(db).outcome).toBe('confirmed')
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('un estado desconocido se trata como "nadie contestó"', async () => {
    const db = seed()
    await handleDialResult({ db: asDb(db), callId: CALL_ID, form: {}, now: NOW })
    expect(callOf(db).outcome).toBe('advisor_missed')
  })

  it('una llamada que no existe cuelga sin decir nada', async () => {
    const db = seed()
    const { xml } = await handleDialResult({
      db: asDb(db),
      callId: '99999999-9999-4999-8999-999999999999',
      form: { DialCallStatus: 'completed' },
      now: NOW,
    })
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('si el aviso no se puede guardar, el resultado igual queda', async () => {
    const db = seed()
    db._failNext('insert', 'notifications', { message: 'boom' })
    await handleDialResult({ db: asDb(db), callId: CALL_ID, form: { DialCallStatus: 'busy' }, now: NOW })
    expect(callOf(db).outcome).toBe('advisor_missed')
  })
})

describe('status', () => {
  const hit = (db: FakeDb, form: Record<string, string>, now = NOW) =>
    handleStatusCallback({ db: asDb(db), callId: CALL_ID, form, now })

  it('completada: guarda estado, duración y hora de cierre; sin resultado queda no_response', async () => {
    const db = seed({ status: 'in_progress' })
    await hit(db, { CallStatus: 'completed', CallDuration: '42', CallSid: 'CA-1' })

    expect(callOf(db)).toMatchObject({
      status: 'completed',
      duration_seconds: 42,
      finished_at: NOW.toISOString(),
      outcome: 'no_response',
      provider_call_sid: 'CA-1',
    })
  })

  it('completada con un resultado ya puesto lo respeta', async () => {
    const db = seed({ status: 'in_progress', outcome: 'confirmed' })
    await hit(db, { CallStatus: 'completed', CallDuration: '30' })
    expect(callOf(db)).toMatchObject({ status: 'completed', outcome: 'confirmed' })
  })

  it.each([
    ['busy', 'busy'],
    ['no-answer', 'no_answer'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
  ])('%s → estado %s y no_response', async (raw, status) => {
    const db = seed({ status: 'calling' })
    await hit(db, { CallStatus: raw })
    expect(callOf(db)).toMatchObject({ status, outcome: 'no_response', finished_at: NOW.toISOString() })
  })

  it('in-progress solo sube una llamada que todavía no estaba en curso', async () => {
    const db = seed({ status: 'calling' })
    await hit(db, { CallStatus: 'in-progress' })
    expect(callOf(db).status).toBe('in_progress')
    expect(callOf(db).finished_at).toBeNull()
  })

  it('no baja una llamada ya terminada (un reintento tardío no la revive)', async () => {
    const db = seed({ status: 'completed', outcome: 'confirmed', finished_at: '2026-11-05T15:01:00.000Z' })
    await hit(db, { CallStatus: 'in-progress' })
    await hit(db, { CallStatus: 'busy', CallDuration: '5' })
    expect(callOf(db)).toMatchObject({
      status: 'completed',
      outcome: 'confirmed',
      finished_at: '2026-11-05T15:01:00.000Z',
    })
  })

  it('es idempotente con el mismo aviso repetido', async () => {
    const db = seed({ status: 'in_progress' })
    await hit(db, { CallStatus: 'completed', CallDuration: '42' })
    const after = { ...callOf(db) }
    await hit(db, { CallStatus: 'completed', CallDuration: '42' }, new Date(NOW.getTime() + 60_000))
    expect(callOf(db)).toEqual(after)
  })

  it('estados que no pedimos (ringing) no cambian nada', async () => {
    const db = seed({ status: 'calling' })
    await hit(db, { CallStatus: 'ringing' })
    expect(callOf(db).status).toBe('calling')
    expect(callOf(db).outcome).toBeNull()
  })

  it('la duración se acota a lo que acepta la base y lo ilegible se ignora', async () => {
    const huge = seed({ status: 'in_progress' })
    await hit(huge, { CallStatus: 'completed', CallDuration: '999999' })
    expect(callOf(huge).duration_seconds).toBe(86400)

    const junk = seed({ status: 'in_progress' })
    await hit(junk, { CallStatus: 'completed', CallDuration: 'abc' })
    expect(callOf(junk).duration_seconds).toBeNull()
  })

  it('una llamada que no existe no lanza', async () => {
    const db = seed()
    await expect(
      handleStatusCallback({
        db: asDb(db),
        callId: '99999999-9999-4999-8999-999999999999',
        form: { CallStatus: 'completed' },
        now: NOW,
      }),
    ).resolves.toBeUndefined()
  })
})
