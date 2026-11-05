import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import {
  activeAppointment,
  APPOINTMENT,
  CONTACT,
  FOREIGN_APPOINTMENT,
  NOW,
  OTHER_ACCOUNT,
  PATIENT,
  seedPanelDb,
  type PanelSeedOptions,
} from '@/verticals/agenda/agent/testing/panel-fixtures'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  TEST_USER,
  type TestResponse,
} from '../_lib/route-testing'

// ============================================================
// /api/verticals/agenda/calls — la lista "Para llamar" (GET) y lo que la
// recepción anota después de llamar (POST). La ruta, el armado de la lista y
// las escrituras corren de punta a punta contra el fake de PostgREST; solo se
// falsean el aviso al paciente, el aviso a Google y `after`.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
  afterCallbacks: [] as (() => unknown)[],
  kick: vi.fn(),
  notifyCalls: [] as Record<string, unknown>[],
  notifyOutcome: { notified: true } as { notified: boolean; notify_error?: string },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return { ...nextServerMock(), after: (cb: () => unknown) => void h.afterCallbacks.push(cb) }
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

// El service role de la ruta es el mismo fake que ve el usuario en el test.
vi.mock('@/lib/verticals/admin-client', () => ({
  supabaseAdmin: () => h.state.db,
}))

vi.mock('@/verticals/agenda/calendar-kick', () => ({
  kickCalendarSync: (...args: unknown[]) => h.kick(...args),
}))

vi.mock('@/verticals/agenda/panel-notify', () => ({
  notifyIfRequested: async (notify: boolean, makeArgs: () => Record<string, unknown>) => {
    if (!notify) return { notified: false }
    h.notifyCalls.push(makeArgs())
    return h.notifyOutcome
  },
}))

import { GET, POST } from './route'

/** Mañana a esta hora (NOW es jueves 5 de noviembre, 10:00 en Bogotá). */
const TOMORROW = '2026-11-06T15:00:00.000Z'
/** El recordatorio salió hace 5 horas. */
const REMINDER = '2026-11-05T10:00:00.000Z'

function ownAppointment(overrides: Row = {}): Row {
  return activeAppointment({
    starts_at: TOMORROW,
    ends_at: '2026-11-06T15:30:00.000Z',
    reminder_sent_at: REMINDER,
    attendance_confirmed_at: null,
    ...overrides,
  })
}

function boot(options: PanelSeedOptions & { appointments?: Row[]; settings?: Row[] } = {}): FakeDb {
  const { appointments, settings, ...seed } = options
  const db = seedPanelDb({
    ...seed,
    extra: {
      booking_appointments: appointments ?? [ownAppointment()],
      booking_call_settings: settings ?? [
        { account_id: TEST_ACCOUNT, outbound_enabled: true, call_after_minutes: 180 },
      ],
      booking_calls: [],
      tags: [],
      contact_tags: [],
      ...seed.extra,
    },
  })
  h.state.db = db
  return db
}

const rows = (db: FakeDb, table: string): Row[] => db._tables[table] ?? []
const get = async () => (await GET()) as unknown as TestResponse
const post = async (payload: unknown) => (await POST(jsonRequest(payload))) as unknown as TestResponse
const drainAfter = async () => {
  for (const cb of h.afterCallbacks.splice(0)) await cb()
}

const body = (extra: Record<string, unknown> = {}) => ({
  appointment_id: APPOINTMENT,
  outcome: 'confirmed',
  ...extra,
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.state.role = 'agent'
  h.afterCallbacks.length = 0
  h.notifyCalls.length = 0
  h.notifyOutcome = { notified: true }
  h.kick.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------

describe('GET: la lista Para llamar', () => {
  it('devuelve las filas armadas, en snake_case, y si las llamadas salientes están prendidas', async () => {
    boot()
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.outbound_enabled).toBe(true)
    expect(res.body.rows).toEqual([
      {
        appointment_id: APPOINTMENT,
        starts_at: TOMORROW,
        contact_id: CONTACT,
        patient_name: null,
        contact_name: 'Ana Pérez',
        phone: '573001112233',
        staff_name: 'Dra. Rojas',
        reason: 'reminder_unanswered',
        robot_attempts: 0,
        manual_attempts: 0,
        last_robot: null,
        last_manual: null,
        robot_in_progress: false,
        can_robot_call: true,
      },
    ])
  })

  it('un viewer puede leerla', async () => {
    boot()
    h.state.role = 'viewer'
    const res = await get()
    expect(res.status).toBe(200)
    expect((res.body.rows as unknown[]).length).toBe(1)
  })

  it('sin configuración de llamadas: usa los valores por defecto y las salientes quedan apagadas', async () => {
    boot({ settings: [] })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.outbound_enabled).toBe(false)
    expect((res.body.rows as unknown[]).length).toBe(1)
  })

  it('no mezcla cuentas: una cita de otra cuenta no sale', async () => {
    boot({
      appointments: [
        ownAppointment({ id: FOREIGN_APPOINTMENT, account_id: OTHER_ACCOUNT }),
      ],
    })
    const res = await get()
    expect(res.body.rows).toEqual([])
  })

  it('muestra el último resultado del robot y los intentos manuales', async () => {
    boot({
      extra: {
        booking_calls: [
          {
            id: 'k1', account_id: TEST_ACCOUNT, appointment_id: APPOINTMENT, direction: 'outbound',
            channel: 'robot', attempt: 1, status: 'completed', outcome: 'human', created_at: '2026-11-05T12:00:00.000Z',
          },
          {
            id: 'k2', account_id: TEST_ACCOUNT, appointment_id: APPOINTMENT, direction: 'outbound',
            channel: 'manual', attempt: 1, status: 'no_answer', outcome: 'no_response', created_at: '2026-11-05T13:00:00.000Z',
          },
        ],
      },
    })
    const [row] = (await get()).body.rows as Record<string, unknown>[]
    expect(row).toMatchObject({
      reason: 'robot_human',
      robot_attempts: 1,
      manual_attempts: 1,
      last_robot: { outcome: 'human', status: 'completed', at: '2026-11-05T12:00:00.000Z' },
      last_manual: { outcome: 'no_response', status: 'no_answer', at: '2026-11-05T13:00:00.000Z' },
    })
  })

  it('un contacto con la etiqueta no-llamar no sale', async () => {
    boot({
      extra: {
        tags: [{ id: 't1', account_id: TEST_ACCOUNT, name: 'no-llamar' }],
        contact_tags: [{ contact_id: CONTACT, tag_id: 't1' }],
      },
    })
    expect((await get()).body.rows).toEqual([])
  })

  it('en una clínica trae el nombre del paciente', async () => {
    boot({
      modules: ['agenda', 'clinica'],
      appointments: [ownAppointment({ patient_id: PATIENT })],
      extra: {
        clinic_patients: [
          { id: PATIENT, account_id: TEST_ACCOUNT, contact_id: CONTACT, full_name: 'Julián Pardo' },
        ],
      },
    })
    const [row] = (await get()).body.rows as Record<string, unknown>[]
    expect(row).toMatchObject({ patient_name: 'Julián Pardo', contact_name: 'Ana Pérez' })
  })

  it('si a la base le falta la 056 responde 503 migration_missing (la pantalla no avisa de error)', async () => {
    const db = boot()
    db._failNext('select', 'booking_appointments', { message: 'column does not exist', code: '42703' })
    const res = await get()
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('migration_missing')
  })

  it('cualquier otra lectura que falla es un 500 sin datos del paciente', async () => {
    const db = boot()
    db._failNext('select', 'booking_calls', { message: 'boom Ana Pérez 573001112233' })
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('Ana')
    expect(JSON.stringify(res.body)).not.toContain('5730011')
  })
})

// ------------------------------------------------------------
// POST: permisos y cuerpo
// ------------------------------------------------------------

describe('POST: permisos y cuerpo', () => {
  it('un viewer no puede anotar llamadas (403) y no se escribe nada', async () => {
    const db = boot()
    h.state.role = 'viewer'
    const res = await post(body())
    expect(res.status).toBe(403)
    expect(rows(db, 'booking_calls')).toHaveLength(0)
    expect(rows(db, 'booking_appointments')[0].attendance_confirmed_at).toBeNull()
  })

  it.each([
    ['sin cita', { appointment_id: undefined }],
    ['cita que no es uuid', { appointment_id: 'no-es-uuid' }],
    ['sin resultado', { outcome: undefined }],
    ['resultado que no existe', { outcome: 'human' }],
    ['notify que no es booleano', { outcome: 'cancelled', notify: 'si' }],
  ])('%s → 400 y no escribe', async (_name, extra) => {
    const db = boot()
    const res = await post(body(extra))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_body')
    expect(typeof res.body.error).toBe('string')
    expect(rows(db, 'booking_calls')).toHaveLength(0)
  })

  it('un JSON roto → 400', async () => {
    boot()
    const res = (await POST(brokenJsonRequest())) as unknown as TestResponse
    expect(res.status).toBe(400)
  })

  it('una cita de otra cuenta → 404 y no escribe', async () => {
    const db = boot({
      appointments: [ownAppointment({ id: FOREIGN_APPOINTMENT, account_id: OTHER_ACCOUNT })],
    })
    const res = await post(body({ appointment_id: FOREIGN_APPOINTMENT }))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(rows(db, 'booking_calls')).toHaveLength(0)
    expect(rows(db, 'booking_appointments')[0].attendance_confirmed_at).toBeNull()
  })

  it('una cita que no existe → 404', async () => {
    boot({ appointments: [] })
    expect((await post(body())).status).toBe(404)
  })

  it.each(['cancelled', 'completed', 'no_show'])('una cita %s ya no está activa (409) y no escribe', async (status) => {
    const db = boot({ appointments: [ownAppointment({ status })] })
    const res = await post(body())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('not_active')
    expect(rows(db, 'booking_calls')).toHaveLength(0)
    expect(rows(db, 'booking_appointments')[0].status).toBe(status)
  })

  it('una cita que ya empezó ya no está activa (409)', async () => {
    const db = boot({ appointments: [ownAppointment({ starts_at: '2026-11-05T14:00:00.000Z' })] })
    const res = await post(body())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('not_active')
    expect(rows(db, 'booking_calls')).toHaveLength(0)
  })
})

// ------------------------------------------------------------
// POST: Confirmó
// ------------------------------------------------------------

describe('POST confirmed', () => {
  it('marca la cita como confirmada por el paciente y anota la llamada a nombre de quien la hizo', async () => {
    const db = boot({ appointments: [ownAppointment({ status: 'pending' })] })
    const res = await post(body())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, recorded: true, attempt: 1 })

    const appointment = rows(db, 'booking_appointments')[0]
    expect(appointment.status).toBe('confirmed')
    expect(appointment.attendance_confirmed_at).toBe(NOW.toISOString())
    expect(appointment.confirmed_at).toBe(NOW.toISOString())

    expect(rows(db, 'booking_calls')).toEqual([
      expect.objectContaining({
        account_id: TEST_ACCOUNT,
        appointment_id: APPOINTMENT,
        contact_id: CONTACT,
        direction: 'outbound',
        channel: 'manual',
        attempt: 1,
        status: 'completed',
        outcome: 'confirmed',
        created_by: TEST_USER,
        finished_at: NOW.toISOString(),
      }),
    ])
  })

  it('avisa a Google Calendar después de responder', async () => {
    boot()
    await post(body())
    expect(h.afterCallbacks).toHaveLength(1)
    await drainAfter()
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it('no avisa al paciente (confirmar no manda nada)', async () => {
    boot()
    const res = await post(body())
    expect(h.notifyCalls).toHaveLength(0)
    expect(res.body.notified).toBeUndefined()
  })

  it('si el paciente ya había confirmado → 409 already_confirmed y no repite', async () => {
    const db = boot({ appointments: [ownAppointment({ attendance_confirmed_at: '2026-11-05T11:00:00.000Z' })] })
    const res = await post(body())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('already_confirmed')
    expect(rows(db, 'booking_calls')).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('si la cita cambió entre leerla y escribirla (la cancelaron) → 409 stale y no la revive', async () => {
    const db = boot()
    // La lectura la ve activa; justo después alguien la cancela.
    const original = db.from.bind(db)
    let firstRead = true
    ;(db as { from: (t: string) => unknown }).from = (table: string) => {
      const query = original(table) as { maybeSingle: () => Promise<unknown> }
      if (table === 'booking_appointments' && firstRead) {
        const maybeSingle = query.maybeSingle.bind(query)
        query.maybeSingle = async () => {
          const result = await maybeSingle()
          firstRead = false
          rows(db, 'booking_appointments')[0].status = 'cancelled'
          return result
        }
      }
      return query
    }
    const res = await post(body())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('stale')
    expect(rows(db, 'booking_appointments')[0].status).toBe('cancelled')
    expect(rows(db, 'booking_appointments')[0].attendance_confirmed_at).toBeNull()
    expect(rows(db, 'booking_calls')).toHaveLength(0)
  })
})

// ------------------------------------------------------------
// POST: Canceló
// ------------------------------------------------------------

describe('POST cancelled', () => {
  it('cancela la cita con el motivo patient_call, avisa al paciente y anota la llamada', async () => {
    const db = boot()
    const res = await post(body({ outcome: 'cancelled' }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, recorded: true, attempt: 1, notified: true })

    const appointment = rows(db, 'booking_appointments')[0]
    expect(appointment).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'patient_call',
      cancelled_at: NOW.toISOString(),
    })
    expect(rows(db, 'booking_calls')[0]).toMatchObject({ channel: 'manual', outcome: 'cancelled', status: 'completed' })

    expect(h.notifyCalls).toEqual([
      expect.objectContaining({ accountId: TEST_ACCOUNT, appointmentId: APPOINTMENT, kind: 'cancelled' }),
    ])
    await drainAfter()
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it('con notify=false no avisa al paciente', async () => {
    const db = boot()
    const res = await post(body({ outcome: 'cancelled', notify: false }))
    expect(res.status).toBe(200)
    expect(res.body.notified).toBe(false)
    expect(h.notifyCalls).toHaveLength(0)
    expect(rows(db, 'booking_appointments')[0].status).toBe('cancelled')
  })

  it('si el aviso falla, la cita queda cancelada y la respuesta lo dice', async () => {
    const db = boot()
    h.notifyOutcome = { notified: false, notify_error: 'La plantilla no está aprobada.' }
    const res = await post(body({ outcome: 'cancelled' }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ notified: false, notify_error: 'La plantilla no está aprobada.' })
    expect(rows(db, 'booking_appointments')[0].status).toBe('cancelled')
  })

  it('una cita que ya no está activa no se cancela otra vez ni avisa', async () => {
    boot({ appointments: [ownAppointment({ status: 'cancelled' })] })
    const res = await post(body({ outcome: 'cancelled' }))
    expect(res.status).toBe(409)
    expect(h.notifyCalls).toHaveLength(0)
  })
})

// ------------------------------------------------------------
// POST: No contestó / Número equivocado
// ------------------------------------------------------------

describe('POST no_response y wrong_number', () => {
  it('No contestó: solo anota la llamada, la cita no cambia', async () => {
    const db = boot()
    const before = structuredClone(rows(db, 'booking_appointments'))
    const res = await post(body({ outcome: 'no_response' }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, recorded: true, attempt: 1 })
    expect(rows(db, 'booking_appointments')).toEqual(before)
    expect(rows(db, 'booking_calls')[0]).toMatchObject({
      channel: 'manual',
      direction: 'outbound',
      attempt: 1,
      status: 'no_answer',
      outcome: 'no_response',
      created_by: TEST_USER,
    })
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('Número equivocado: queda como llamada completada con ese resultado', async () => {
    const db = boot()
    const res = await post(body({ outcome: 'wrong_number' }))
    expect(res.status).toBe(200)
    expect(rows(db, 'booking_calls')[0]).toMatchObject({ status: 'completed', outcome: 'wrong_number' })
  })

  it('los intentos manuales suben de uno en uno (1, 2, 3)', async () => {
    boot()
    const attempts: unknown[] = []
    for (let i = 0; i < 3; i++) attempts.push((await post(body({ outcome: 'no_response' }))).body.attempt)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('los intentos del robot no cuentan para el tope de los manuales', async () => {
    const db = boot({
      extra: {
        booking_calls: [
          { id: 'r1', account_id: TEST_ACCOUNT, appointment_id: APPOINTMENT, direction: 'outbound', channel: 'robot', attempt: 1, status: 'completed', outcome: 'no_response', created_at: '2026-11-05T12:00:00.000Z' },
          { id: 'r2', account_id: TEST_ACCOUNT, appointment_id: APPOINTMENT, direction: 'outbound', channel: 'robot', attempt: 2, status: 'completed', outcome: 'no_response', created_at: '2026-11-05T13:00:00.000Z' },
        ],
      },
    })
    const res = await post(body({ outcome: 'no_response' }))
    expect(res.body).toMatchObject({ recorded: true, attempt: 1 })
    expect(rows(db, 'booking_calls')).toHaveLength(3)
  })

  it('con 3 llamadas manuales ya anotadas, la 4ª no se inserta (tope de la base): 200 con aviso', async () => {
    const db = boot()
    for (let i = 0; i < 3; i++) await post(body({ outcome: 'no_response' }))
    const res = await post(body({ outcome: 'no_response' }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, recorded: false, attempt: null })
    expect(typeof res.body.note).toBe('string')
    expect(rows(db, 'booking_calls')).toHaveLength(3)
  })

  it('si no se puede guardar la llamada, es un error (no hay nada más que hacer)', async () => {
    const db = boot()
    db._failNext('insert', 'booking_calls', { message: 'permission denied', code: '42501' })
    const res = await post(body({ outcome: 'no_response' }))
    expect(res.status).toBe(500)
    expect(rows(db, 'booking_calls')).toHaveLength(0)
  })
})

// ------------------------------------------------------------
// POST: el tope de 3 no frena lo que sí cambia la cita
// ------------------------------------------------------------

describe('POST con el tope de llamadas manuales lleno', () => {
  const fullHistory = (): Row[] =>
    [1, 2, 3].map((attempt) => ({
      id: `m${attempt}`,
      account_id: TEST_ACCOUNT,
      appointment_id: APPOINTMENT,
      direction: 'outbound',
      channel: 'manual',
      attempt,
      status: 'no_answer',
      outcome: 'no_response',
      created_at: `2026-11-05T1${attempt}:00:00.000Z`,
    }))

  it('Confirmó igual confirma la cita, sin insertar, y avisa', async () => {
    const db = boot({ extra: { booking_calls: fullHistory() } })
    const res = await post(body())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, recorded: false })
    expect(typeof res.body.note).toBe('string')
    expect(rows(db, 'booking_appointments')[0].attendance_confirmed_at).toBe(NOW.toISOString())
    expect(rows(db, 'booking_calls')).toHaveLength(3)
  })

  it('Canceló igual cancela la cita y avisa al paciente', async () => {
    const db = boot({ extra: { booking_calls: fullHistory() } })
    const res = await post(body({ outcome: 'cancelled' }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ recorded: false, notified: true })
    expect(rows(db, 'booking_appointments')[0].status).toBe('cancelled')
    expect(rows(db, 'booking_calls')).toHaveLength(3)
  })

  it('si la cita ya cambió pero la llamada no se pudo guardar, responde 200 con recorded=false', async () => {
    const db = boot()
    db._failNext('insert', 'booking_calls', { message: 'boom', code: 'XX000' })
    const res = await post(body())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, recorded: false })
    expect(rows(db, 'booking_appointments')[0].attendance_confirmed_at).toBe(NOW.toISOString())
  })
})
