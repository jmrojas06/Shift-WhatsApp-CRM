import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { callRowFromDb, type CallAppointment } from './calls-repo'
import { applyOutboundEffect, notifyCallTeam, type EffectContext } from './effects'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// Efectos de la llamada de confirmación: confirmar, cancelar (con aviso al
// paciente), pasar al equipo y rendirse. Cada uno se aplica UNA vez por
// llamada: un reintento del webhook no repite nada.
// ============================================================

const ACCOUNT = 'acc-1'
const OWNER = 'owner-1'
const HANDOFF = 'agent-1'
const CALL_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-11-05T15:00:00.000Z')
/** Jueves 5 de noviembre, 3:30 p. m. en Bogotá. */
const STARTS_AT = '2026-11-05T20:30:00.000Z'

const APPOINTMENT: CallAppointment = {
  id: APPT,
  contactId: CONTACT,
  staffId: null,
  startsAt: new Date(STARTS_AT),
  status: 'confirmed',
  attendanceConfirmedAt: null,
}

function seed(extra: Record<string, Row[]> = {}): FakeDb {
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Clínica Sonrisa', owner_user_id: OWNER }],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        status: 'confirmed',
        starts_at: STARTS_AT,
        confirmed_at: '2026-11-01T10:00:00.000Z',
        attendance_confirmed_at: null,
        cancel_reason: null,
        cancelled_at: null,
      },
    ],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-10-01T00:00:00.000Z' }],
    ai_configs: [],
    notifications: [],
    booking_calls: [callRowSeed({ id: CALL_ID, appointment_id: APPT, contact_id: CONTACT, attempt: 1 })],
    ...extra,
  })
}

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? []).find((row) => row.id === CALL_ID) as Row
const appointmentOf = (db: FakeDb) => (db._tables.booking_appointments ?? [])[0] as Row

const notifyPatient = vi.fn()
const kickCalendar = vi.fn()

function ctx(db: FakeDb, overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    db: asDb(db),
    now: NOW,
    call: callRowFromDb(callOf(db)),
    appointment: APPOINTMENT,
    deps: { notifyPatient, kickCalendar },
    ...overrides,
  }
}

/** Corre lo que la ruta dejaría para después de responder. */
async function runDeferred(result: { deferred: (() => Promise<void>)[] }) {
  for (const task of result.deferred) await task()
}

beforeEach(() => {
  notifyPatient.mockReset()
  kickCalendar.mockReset()
  notifyPatient.mockResolvedValue({ sent: true, channel: 'text' })
  kickCalendar.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('confirm', () => {
  it('marca la asistencia confirmada y deja el resultado confirmed', async () => {
    const db = seed()
    const result = await applyOutboundEffect({ type: 'confirm' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(appointmentOf(db)).toMatchObject({
      status: 'confirmed',
      attendance_confirmed_at: NOW.toISOString(),
    })
    expect(callOf(db).outcome).toBe('confirmed')
  })

  it('es idempotente: un reintento no vuelve a tocar la cita', async () => {
    const db = seed()
    await applyOutboundEffect({ type: 'confirm' }, ctx(db))
    const later = new Date(NOW.getTime() + 60_000)
    const second = await applyOutboundEffect({ type: 'confirm' }, ctx(db, { now: later, call: callRowFromDb(callOf(db)) }))

    expect(second.failed).toBe(false)
    expect(appointmentOf(db).attendance_confirmed_at).toBe(NOW.toISOString())
  })

  it('en la llamada de prueba (sin cita) solo deja el resultado', async () => {
    const db = seed()
    const result = await applyOutboundEffect(
      { type: 'confirm' },
      ctx(db, { appointment: null, call: callRowFromDb(callOf(db)) }),
    )
    expect(result.failed).toBe(false)
    expect(callOf(db).outcome).toBe('confirmed')
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
  })

  it('si la base no deja confirmar, suelta el resultado y cae al equipo, sin prometer nada', async () => {
    const db = seed()
    db._failNext('update', 'booking_appointments', { message: 'boom' })

    const result = await applyOutboundEffect({ type: 'confirm' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
    expect(callOf(db).outcome).toBe('human')
    expect(String(callOf(db).error)).toMatch(/no se pudo guardar/i)
    expect(db._tables.notifications).toHaveLength(1)
  })
})

describe('cancel', () => {
  it('cancela la cita con motivo patient_call y deja el resultado cancelled', async () => {
    const db = seed()
    const result = await applyOutboundEffect({ type: 'cancel' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(appointmentOf(db)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'patient_call',
      cancelled_at: NOW.toISOString(),
    })
    expect(callOf(db).outcome).toBe('cancelled')
  })

  it('avisa al paciente (cancelada) y a Google Calendar DESPUÉS de responder, no antes', async () => {
    const db = seed()
    const result = await applyOutboundEffect({ type: 'cancel' }, ctx(db))

    expect(notifyPatient).not.toHaveBeenCalled()
    expect(kickCalendar).not.toHaveBeenCalled()
    expect(result.deferred).toHaveLength(2)

    await runDeferred(result)
    expect(notifyPatient).toHaveBeenCalledTimes(1)
    expect(notifyPatient.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      appointmentId: APPT,
      kind: 'cancelled',
      now: NOW,
    })
    expect(kickCalendar).toHaveBeenCalledWith(ACCOUNT)
  })

  it('es idempotente: un reintento ni cancela de nuevo ni avisa dos veces', async () => {
    const db = seed()
    const first = await applyOutboundEffect({ type: 'cancel' }, ctx(db))
    await runDeferred(first)

    const second = await applyOutboundEffect({ type: 'cancel' }, ctx(db, { call: callRowFromDb(callOf(db)) }))
    await runDeferred(second)

    expect(second.failed).toBe(false)
    expect(second.deferred).toHaveLength(0)
    expect(notifyPatient).toHaveBeenCalledTimes(1)
    expect(kickCalendar).toHaveBeenCalledTimes(1)
  })

  it('si el aviso por WhatsApp falla, la cita sigue cancelada y queda anotado en la llamada', async () => {
    notifyPatient.mockResolvedValue({ sent: false, error: 'La plantilla no está aprobada.' })
    const db = seed()
    const result = await applyOutboundEffect({ type: 'cancel' }, ctx(db))
    await runDeferred(result)

    expect(appointmentOf(db).status).toBe('cancelled')
    expect(String(callOf(db).error)).toContain('La plantilla no está aprobada.')
  })

  it('si el aviso lanza una excepción no rompe lo demás ni filtra su mensaje', async () => {
    notifyPatient.mockRejectedValue(new Error('573001112233 rechazado'))
    const db = seed()
    const result = await applyOutboundEffect({ type: 'cancel' }, ctx(db))
    await expect(runDeferred(result)).resolves.toBeUndefined()

    expect(kickCalendar).toHaveBeenCalledTimes(1)
    expect(String(callOf(db).error)).not.toContain('573001112233')
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).not.toContain('573001112233')
  })

  it('si la base no deja cancelar, no se avisa a nadie y la llamada cae al equipo', async () => {
    const db = seed()
    db._failNext('update', 'booking_appointments', { message: 'boom' })

    const result = await applyOutboundEffect({ type: 'cancel' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(result.deferred).toHaveLength(0)
    expect(appointmentOf(db).status).toBe('confirmed')
    expect(callOf(db).outcome).toBe('human')
  })

  it('en la llamada de prueba no toca ninguna cita ni avisa', async () => {
    const db = seed()
    const result = await applyOutboundEffect(
      { type: 'cancel' },
      ctx(db, { appointment: null, call: callRowFromDb(callOf(db)) }),
    )
    expect(result.deferred).toHaveLength(0)
    expect(callOf(db).outcome).toBe('cancelled')
    expect(appointmentOf(db).status).toBe('confirmed')
  })
})

describe('human', () => {
  it('deja el resultado human y avisa al agente de pase', async () => {
    const db = seed({ ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: HANDOFF }] })
    const result = await applyOutboundEffect({ type: 'human' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(callOf(db).outcome).toBe('human')
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: HANDOFF,
      conversation_id: CONVERSATION,
      contact_id: CONTACT,
    })
    expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:/)
    expect(String(db._tables.notifications[0].body)).toContain('Ana Pérez')
  })

  it('sin agente de pase, avisa al dueño', async () => {
    const db = seed()
    await applyOutboundEffect({ type: 'human' }, ctx(db))
    expect(db._tables.notifications[0]).toMatchObject({ user_id: OWNER })
  })

  it('un reintento no repite el aviso', async () => {
    const db = seed()
    await applyOutboundEffect({ type: 'human' }, ctx(db))
    await applyOutboundEffect({ type: 'human' }, ctx(db, { call: callRowFromDb(callOf(db)) }))
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('si el aviso no se puede guardar, igual queda el resultado y no lanza', async () => {
    const db = seed()
    db._failNext('insert', 'notifications', { message: 'boom' })
    const result = await applyOutboundEffect({ type: 'human' }, ctx(db))
    expect(result.failed).toBe(false)
    expect(callOf(db).outcome).toBe('human')
  })

  it('en la llamada de prueba no manda aviso al equipo', async () => {
    const db = seed()
    await applyOutboundEffect({ type: 'human' }, ctx(db, { appointment: null, call: callRowFromDb(callOf(db)) }))
    expect(callOf(db).outcome).toBe('human')
    expect(db._tables.notifications).toHaveLength(0)
  })
})

describe('no_response y dial', () => {
  it('no_response deja el resultado y no toca la cita', async () => {
    const db = seed()
    const result = await applyOutboundEffect({ type: 'no_response' }, ctx(db))
    expect(result.failed).toBe(false)
    expect(callOf(db).outcome).toBe('no_response')
    expect(appointmentOf(db)).toMatchObject({ status: 'confirmed', attendance_confirmed_at: null })
  })

  it('dial no cambia nada: el resultado lo pone dial-result', async () => {
    const db = seed()
    const result = await applyOutboundEffect({ type: 'dial' }, ctx(db))
    expect(result).toEqual({ failed: false, deferred: [] })
    expect(callOf(db).outcome).toBeNull()
  })
})

describe('notifyCallTeam', () => {
  it('sin a quién avisar no lanza', async () => {
    const db = makeCallDb({
      accounts: [{ id: ACCOUNT, name: 'x', owner_user_id: null }],
      ai_configs: [],
      notifications: [],
      conversations: [],
    })
    await expect(
      notifyCallTeam(asDb(db), { accountId: ACCOUNT, contactId: null, title: 't', body: 'b' }),
    ).resolves.toBeUndefined()
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('un contacto sin conversación deja el aviso igual, con conversation_id null', async () => {
    const db = makeCallDb({
      accounts: [{ id: ACCOUNT, name: 'x', owner_user_id: OWNER }],
      ai_configs: [],
      notifications: [],
      conversations: [],
    })
    await notifyCallTeam(asDb(db), { accountId: ACCOUNT, contactId: CONTACT, title: 't', body: 'b' })
    expect(db._tables.notifications[0]).toMatchObject({ user_id: OWNER, conversation_id: null, contact_id: CONTACT })
  })
})
