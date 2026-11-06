import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyAlert } from '@/lib/ops/alert'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { callRowFromDb, type CallRow } from './calls-repo'
import { applyInboundEffect, type InboundEffectContext, type InboundEffectResult } from './inbound-effects'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// Efectos de la llamada entrante: lo que cambia en la base (o sale por
// WhatsApp) por la tecla que marcó quien llama. Cada efecto se aplica UNA sola
// vez por llamada, aunque Telnyx reintente el pedido.
// ============================================================

const ACCOUNT = 'acc-1'
const OWNER = 'owner-1'
const HANDOFF = 'agent-7'
const CALL_ID = '99999999-9999-4999-8999-aaaaaaaaaaaa'
const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = 'conv-1'
const NOW = new Date('2026-11-05T15:00:00.000Z')
const STARTS_AT = '2026-11-05T20:30:00.000Z'
const FROM = '+573001112233'

vi.mock('@/lib/ops/alert', () => ({ notifyAlert: vi.fn(async () => {}) }))

const notifyPatient = vi.fn()
const kickCalendar = vi.fn()
const sendBookingLink = vi.fn()
const ensureCaller = vi.fn()
const findContact = vi.fn()

function seed(extra: Record<string, Row[]> = {}, callOverrides: Row = {}): FakeDb {
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Clínica Sonrisa', owner_user_id: OWNER, modules: ['agenda', 'clinica'] }],
    ai_configs: [],
    notifications: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-10-01T00:00:00.000Z' }],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        staff_id: null,
        status: 'confirmed',
        starts_at: STARTS_AT,
        attendance_confirmed_at: null,
        confirmed_at: '2026-11-01T10:00:00.000Z',
        cancel_reason: null,
        cancelled_at: null,
      },
    ],
    booking_calls: [
      callRowSeed({
        id: CALL_ID,
        direction: 'inbound',
        status: 'in_progress',
        contact_id: CONTACT,
        from_number: FROM,
        to_number: '+576015550000',
        provider_call_sid: 'CA-1',
        ...callOverrides,
      }),
    ],
    ...extra,
  })
}

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? []).find((row) => row.id === CALL_ID) as Row
const appointmentOf = (db: FakeDb) => (db._tables.booking_appointments ?? [])[0] as Row

function ctx(db: FakeDb, overrides: Partial<InboundEffectContext> = {}): InboundEffectContext {
  const call: CallRow = callRowFromDb(callOf(db))
  return {
    db: asDb(db),
    now: NOW,
    call,
    appointment: {
      id: APPT,
      contactId: CONTACT,
      staffId: null,
      startsAt: new Date(STARTS_AT),
      status: 'confirmed',
      attendanceConfirmedAt: null,
    },
    deps: { notifyPatient, kickCalendar, sendBookingLink, ensureCaller, findContact },
    ...overrides,
  }
}

async function runDeferred(result: InboundEffectResult) {
  for (const task of result.deferred) await task()
}

beforeEach(() => {
  vi.mocked(notifyAlert).mockClear()
  for (const mock of [notifyPatient, kickCalendar, sendBookingLink, ensureCaller, findContact]) mock.mockReset()
  notifyPatient.mockResolvedValue({ sent: true, channel: 'template' })
  kickCalendar.mockResolvedValue(undefined)
  sendBookingLink.mockResolvedValue({ sent: true, channel: 'template' })
  ensureCaller.mockResolvedValue({ contactId: CONTACT, conversationId: CONVERSATION })
  findContact.mockResolvedValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('send_link: agendar por WhatsApp', () => {
  it('prepara el contacto con el número que llamó, manda el enlace y deja el resultado', async () => {
    const db = seed({}, { contact_id: null })
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(ensureCaller).toHaveBeenCalledWith(expect.anything(), { accountId: ACCOUNT, phone: FROM })
    expect(sendBookingLink).toHaveBeenCalledWith({
      db: expect.anything(),
      accountId: ACCOUNT,
      contactId: CONTACT,
      conversationId: CONVERSATION,
      now: NOW,
    })
    expect(callOf(db)).toMatchObject({ outcome: 'booking_link_sent', contact_id: CONTACT, error: null })
  })

  it('un reintento (mismo pedido) no manda el WhatsApp dos veces', async () => {
    const db = seed()
    await applyInboundEffect({ type: 'send_link' }, ctx(db))
    const again = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(again.failed).toBe(false)
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
    expect(ensureCaller).toHaveBeenCalledTimes(1)
  })

  it('reemplaza un resultado de paso (leyó el horario antes de pedir el enlace)', async () => {
    const db = seed({}, { outcome: 'info' })
    await applyInboundEffect({ type: 'send_link' }, ctx(db))
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
    expect(callOf(db).outcome).toBe('booking_link_sent')
  })

  it('si Meta no lo manda, falla: suelta el resultado, anota por qué y no lo repite como enviado', async () => {
    sendBookingLink.mockResolvedValue({ sent: false, error: 'La plantilla no está aprobada.' })
    const db = seed()
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(callOf(db).outcome).toBeNull()
    expect(String(callOf(db).error)).toContain('La plantilla no está aprobada.')
  })

  it('un nuevo intento después de un fallo vuelve a mandar', async () => {
    sendBookingLink.mockResolvedValueOnce({ sent: false, error: 'No se pudo.' })
    const db = seed()
    await applyInboundEffect({ type: 'send_link' }, ctx(db))
    const retry = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(retry.failed).toBe(false)
    expect(sendBookingLink).toHaveBeenCalledTimes(2)
    expect(callOf(db).outcome).toBe('booking_link_sent')
  })

  it('si no se pudo preparar el contacto falla sin filtrar el número', async () => {
    ensureCaller.mockRejectedValue(new Error('duplicate key 573001112233'))
    const db = seed()
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(callOf(db).outcome).toBeNull()
    expect(String(callOf(db).error)).not.toContain('573001112233')
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('573001112233')
  })

  it('si la llamada no trae un número válido no manda nada', async () => {
    const db = seed({}, { from_number: null, contact_id: null })
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(ensureCaller).not.toHaveBeenCalled()
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(callOf(db).outcome).toBeNull()
    expect(String(callOf(db).error)).toMatch(/número/)
  })
})

describe('send_link: límites contra el abuso del webhook', () => {
  const OTHER = '+573009990000'
  const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

  /** Una llamada entrante anterior a la que ya se le mandó el enlace (de verdad). */
  const earlier = (n: number, overrides: Row = {}): Row =>
    callRowSeed({
      id: uuid(n),
      direction: 'inbound',
      channel: 'robot',
      status: 'completed',
      outcome: 'booking_link_sent',
      from_number: FROM,
      to_number: '+576015550000',
      created_at: minutesAgo(5),
      ...overrides,
    })

  /** La base de siempre, con estas llamadas anteriores además de la actual. */
  function seedWith(rows: Row[], callOverrides: Row = {}): FakeDb {
    const db = seed({}, callOverrides)
    db._tables.booking_calls.push(...rows)
    return db
  }

  it('el mismo número ya recibió el enlace hace 5 minutos: no manda otro, lo dice y lo deja anotado', async () => {
    const db = seedWith([earlier(1)])
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result).toMatchObject({ failed: false, repeated: true })
    expect(ensureCaller).not.toHaveBeenCalled()
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(callOf(db)).toMatchObject({ outcome: 'booking_link_sent' })
    expect(String(callOf(db).error)).toMatch(/no se repitió/i)
    expect(String(callOf(db).error)).not.toContain('573001112233')
    expect(notifyAlert).not.toHaveBeenCalled()
  })

  it('pasados 10 minutos el mismo número puede pedirlo otra vez', async () => {
    const db = seedWith([earlier(1, { created_at: minutesAgo(11) })])
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(result.repeated).toBeUndefined()
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
    expect(callOf(db).error).toBeNull()
  })

  it('otro número, otra cuenta, otra tecla o una llamada saliente no cuentan', async () => {
    const db = seedWith([
      earlier(1, { from_number: OTHER }),
      earlier(2, { account_id: 'acc-2' }),
      earlier(3, { outcome: 'info' }),
      earlier(4, { direction: 'outbound', from_number: null, to_number: FROM }),
    ])
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.repeated).toBeUndefined()
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
  })

  it('un aviso que no se repitió no alarga la espera: cuenta el último envío de verdad', async () => {
    const db = seedWith([
      earlier(1, { created_at: minutesAgo(12) }),
      earlier(2, { created_at: minutesAgo(4), error: 'No se repitió el WhatsApp para agendar.' }),
    ])
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.repeated).toBeUndefined()
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
  })

  it('un envío que falló (sin resultado) no bloquea al número', async () => {
    const db = seedWith([earlier(1, { outcome: null, error: 'No se pudo enviar el WhatsApp para agendar: x' })])
    await applyInboundEffect({ type: 'send_link' }, ctx(db))
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
  })

  it('dos llamadas casi a la vez del mismo número: solo la posterior se frena', async () => {
    // La otra llamada empezó DESPUÉS de esta (y ya reclamó su resultado): esta sí manda.
    const db = seedWith([earlier(1, { created_at: new Date(NOW.getTime() + 1_000).toISOString() })])
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.repeated).toBeUndefined()
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
  })

  it('un reintento de la llamada que no se repitió tampoco manda nada', async () => {
    const db = seedWith([earlier(1)])
    await applyInboundEffect({ type: 'send_link' }, ctx(db))
    const again = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(again.failed).toBe(false)
    expect(sendBookingLink).not.toHaveBeenCalled()
  })

  /** `count` llamadas de números distintos a las que ya se les mandó el enlace hace `minutes`. */
  const otherNumbers = (count: number, minutes = 20): Row[] =>
    Array.from({ length: count }, (_, i) =>
      earlier(100 + i, { from_number: `+57300000${String(i).padStart(4, '0')}`, created_at: minutesAgo(minutes) }),
    )

  it('con 29 enlaces en la última hora todavía manda el 30', async () => {
    const db = seedWith(otherNumbers(29))
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
    expect(notifyAlert).not.toHaveBeenCalled()
  })

  it('con 30 enlaces en la última hora no manda más, suelta el resultado y avisa a operaciones', async () => {
    const db = seedWith(otherNumbers(30))
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(ensureCaller).not.toHaveBeenCalled()
    expect(callOf(db).outcome).toBeNull()
    expect(String(callOf(db).error)).toMatch(/límite/)
    // La alerta sale después de responder (deferred), sin números de teléfono.
    expect(notifyAlert).not.toHaveBeenCalled()
    await runDeferred(result)
    expect(notifyAlert).toHaveBeenCalledTimes(1)
    const text = vi.mocked(notifyAlert).mock.calls[0][0]
    expect(text).toContain(ACCOUNT)
    expect(text).not.toMatch(/\d{8,}/)
  })

  it('el aviso a operaciones sale una sola vez por hora', async () => {
    const db = seedWith(otherNumbers(30))
    const first = await applyInboundEffect({ type: 'send_link' }, ctx(db))
    await runDeferred(first)

    // Otra llamada, un minuto después, también topada.
    const later = new Date(NOW.getTime() + 60_000)
    const row = callRowSeed({
      id: uuid(900),
      direction: 'inbound',
      status: 'in_progress',
      from_number: OTHER,
      created_at: later.toISOString(),
    })
    db._tables.booking_calls.push(row)
    const second = await applyInboundEffect({ type: 'send_link' }, { ...ctx(db), now: later, call: callRowFromDb(row) })
    await runDeferred(second)

    expect(second.failed).toBe(true)
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(notifyAlert).toHaveBeenCalledTimes(1)
  })

  it('los enlaces de hace más de una hora no cuentan para el tope', async () => {
    const db = seedWith(otherNumbers(30, 61))
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
  })

  it('el tope es por cuenta: los enlaces de otra cuenta no cuentan', async () => {
    const db = seedWith(otherNumbers(30).map((row) => ({ ...row, account_id: 'acc-2' })))
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
  })

  it('si no se pueden leer las llamadas anteriores falla sin mandar nada y suelta el resultado', async () => {
    const db = seedWith([])
    db._failNext('select', 'booking_calls', { code: '57014', message: 'timeout para 573001112233' })
    const result = await applyInboundEffect({ type: 'send_link' }, ctx(db))

    expect(result.failed).toBe(true)
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(callOf(db).outcome).toBeNull()
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('573001112233')
    expect(String(callOf(db).error)).not.toContain('573001112233')
  })
})

describe('confirm', () => {
  it('confirma la cita y deja el resultado confirmed', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'confirm', appointmentId: APPT }, ctx(db))

    expect(result).toEqual({ failed: false, deferred: [] })
    expect(appointmentOf(db)).toMatchObject({
      status: 'confirmed',
      attendance_confirmed_at: NOW.toISOString(),
    })
    expect(callOf(db).outcome).toBe('confirmed')
  })

  it('es idempotente: un reintento no confirma otra vez', async () => {
    const db = seed()
    await applyInboundEffect({ type: 'confirm', appointmentId: APPT }, ctx(db))
    const later = new Date(NOW.getTime() + 60_000)
    const second = await applyInboundEffect({ type: 'confirm', appointmentId: APPT }, ctx(db, { now: later }))

    expect(second.failed).toBe(false)
    expect(appointmentOf(db).attendance_confirmed_at).toBe(NOW.toISOString())
  })

  it('reemplaza un resultado de paso (leyó el horario y luego confirmó)', async () => {
    const db = seed({}, { outcome: 'info' })
    await applyInboundEffect({ type: 'confirm', appointmentId: APPT }, ctx(db))
    expect(appointmentOf(db).attendance_confirmed_at).toBe(NOW.toISOString())
    expect(callOf(db).outcome).toBe('confirmed')
  })

  it('no confirma una cita distinta de la que se leyó', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'confirm', appointmentId: 'otra-cita' }, ctx(db))
    expect(result.failed).toBe(true)
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
    expect(callOf(db).outcome).not.toBe('confirmed')
  })

  it('sin la cita cargada no confirma nada', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'confirm', appointmentId: APPT }, ctx(db, { appointment: null }))
    expect(result.failed).toBe(true)
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
  })

  it('si la base no deja confirmar, cae al equipo con un aviso y no promete nada', async () => {
    const db = seed({ ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: HANDOFF }] })
    db._failNext('update', 'booking_appointments', { message: 'boom' })
    const result = await applyInboundEffect({ type: 'confirm', appointmentId: APPT }, ctx(db))

    expect(result.failed).toBe(true)
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
    expect(callOf(db).outcome).toBe('human')
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({ user_id: HANDOFF, contact_id: CONTACT })
    expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:/)
  })
})

describe('cancel', () => {
  it('cancela la cita con el motivo patient_call y deja el resultado cancelled', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))

    expect(result.failed).toBe(false)
    expect(appointmentOf(db)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'patient_call',
      cancelled_at: NOW.toISOString(),
    })
    expect(callOf(db).outcome).toBe('cancelled')
  })

  it('avisa al paciente (cancelada) y a Google Calendar DESPUÉS de responder', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))

    expect(notifyPatient).not.toHaveBeenCalled()
    expect(kickCalendar).not.toHaveBeenCalled()
    expect(result.deferred).toHaveLength(2)

    await runDeferred(result)
    expect(notifyPatient).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, appointmentId: APPT, kind: 'cancelled', now: NOW }),
    )
    expect(kickCalendar).toHaveBeenCalledWith(ACCOUNT)
  })

  it('es idempotente: un reintento ni cancela de nuevo ni avisa dos veces', async () => {
    const db = seed()
    const first = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))
    await runDeferred(first)
    const second = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))
    await runDeferred(second)

    expect(second.deferred).toHaveLength(0)
    expect(notifyPatient).toHaveBeenCalledTimes(1)
    expect(kickCalendar).toHaveBeenCalledTimes(1)
  })

  it('si el aviso por WhatsApp falla, la cita sigue cancelada y queda anotado', async () => {
    notifyPatient.mockResolvedValue({ sent: false, error: 'La plantilla no está aprobada.' })
    const db = seed()
    const result = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))
    await runDeferred(result)

    expect(appointmentOf(db).status).toBe('cancelled')
    expect(String(callOf(db).error)).toContain('La plantilla no está aprobada.')
  })

  it('si el aviso lanza una excepción no filtra su mensaje', async () => {
    notifyPatient.mockRejectedValue(new Error('573001112233 rechazado'))
    const db = seed()
    const result = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))
    await expect(runDeferred(result)).resolves.toBeUndefined()

    expect(kickCalendar).toHaveBeenCalledTimes(1)
    expect(String(callOf(db).error)).not.toContain('573001112233')
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('573001112233')
  })

  it('si la base no deja cancelar, no avisa a nadie y la llamada cae al equipo', async () => {
    const db = seed()
    db._failNext('update', 'booking_appointments', { message: 'boom' })
    const result = await applyInboundEffect({ type: 'cancel', appointmentId: APPT }, ctx(db))

    expect(result.failed).toBe(true)
    expect(result.deferred).toHaveLength(0)
    expect(appointmentOf(db).status).toBe('confirmed')
    expect(callOf(db).outcome).toBe('human')
  })

  it('no cancela una cita de otro contacto', async () => {
    const db = seed()
    const result = await applyInboundEffect(
      { type: 'cancel', appointmentId: APPT },
      ctx(db, {
        appointment: {
          id: APPT,
          contactId: 'otro-contacto',
          staffId: null,
          startsAt: new Date(STARTS_AT),
          status: 'confirmed',
          attendanceConfirmedAt: null,
        },
      }),
    )
    expect(result.failed).toBe(true)
    expect(appointmentOf(db).status).toBe('confirmed')
  })
})

describe('urgencia sin atender', () => {
  it('deja el resultado urgency y avisa al agente de pase con un aviso prioritario', async () => {
    const db = seed({ ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: HANDOFF }] })
    const result = await applyInboundEffect({ type: 'urgency_unattended' }, ctx(db))

    expect(result).toEqual({ failed: false, deferred: [] })
    expect(callOf(db).outcome).toBe('urgency')
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: HANDOFF,
      conversation_id: CONVERSATION,
      contact_id: CONTACT,
    })
    expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:.*urgencia/i)
    expect(String(db._tables.notifications[0].body)).toContain('Ana Pérez')
  })

  it('con un número desconocido avisa con el número', async () => {
    const db = seed({}, { contact_id: null })
    await applyInboundEffect({ type: 'urgency_unattended' }, ctx(db))
    expect(String(db._tables.notifications[0].body)).toContain(FROM)
    expect(db._tables.notifications[0]).toMatchObject({ user_id: OWNER, contact_id: null })
  })

  it('un reintento no repite el aviso', async () => {
    const db = seed()
    await applyInboundEffect({ type: 'urgency_unattended' }, ctx(db))
    await applyInboundEffect({ type: 'urgency_unattended' }, ctx(db))
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('si el aviso no se puede guardar, igual queda el resultado y no lanza', async () => {
    const db = seed()
    db._failNext('insert', 'notifications', { message: 'boom' })
    const result = await applyInboundEffect({ type: 'urgency_unattended' }, ctx(db))
    expect(result.failed).toBe(false)
    expect(callOf(db).outcome).toBe('urgency')
  })
})

describe('asesor sin teléfonos', () => {
  it('deja advisor_missed y avisa al equipo para que le llame', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'advisor_unavailable' }, ctx(db))

    expect(result.failed).toBe(false)
    expect(callOf(db).outcome).toBe('advisor_missed')
    expect(db._tables.notifications).toHaveLength(1)
    expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:/)
    expect(String(db._tables.notifications[0].body)).toContain('Ana Pérez')
  })

  it('un reintento no repite el aviso', async () => {
    const db = seed()
    await applyInboundEffect({ type: 'advisor_unavailable' }, ctx(db))
    await applyInboundEffect({ type: 'advisor_unavailable' }, ctx(db))
    expect(db._tables.notifications).toHaveLength(1)
  })
})

describe('resultados de paso (info, out_of_hours, no_response)', () => {
  it('info y out_of_hours se reemplazan entre sí', async () => {
    const db = seed()
    await applyInboundEffect({ type: 'out_of_hours' }, ctx(db))
    expect(callOf(db).outcome).toBe('out_of_hours')
    await applyInboundEffect({ type: 'info' }, ctx(db))
    expect(callOf(db).outcome).toBe('info')
  })

  it('no pisan un resultado final', async () => {
    const db = seed({}, { outcome: 'booking_link_sent' })
    await applyInboundEffect({ type: 'info' }, ctx(db))
    await applyInboundEffect({ type: 'out_of_hours' }, ctx(db))
    expect(callOf(db).outcome).toBe('booking_link_sent')
  })

  it('no_response solo se queda si no había ningún resultado', async () => {
    const empty = seed()
    await applyInboundEffect({ type: 'no_response' }, ctx(empty))
    expect(callOf(empty).outcome).toBe('no_response')

    const withInfo = seed({}, { outcome: 'info' })
    await applyInboundEffect({ type: 'no_response' }, ctx(withInfo))
    expect(callOf(withInfo).outcome).toBe('info')
  })

  it('dial no cambia nada: el resultado lo pone dial-result', async () => {
    const db = seed()
    const result = await applyInboundEffect({ type: 'dial' }, ctx(db))
    expect(result).toEqual({ failed: false, deferred: [] })
    expect(callOf(db).outcome).toBeNull()
  })
})
