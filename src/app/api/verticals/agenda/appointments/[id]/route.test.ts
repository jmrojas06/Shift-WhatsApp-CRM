import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import {
  activeAppointment,
  APPOINTMENT,
  FOREIGN_APPOINTMENT,
  FOREIGN_STAFF,
  MON_10,
  MON_11,
  NOW,
  OTHER_ACCOUNT,
  OTHER_APPOINTMENT,
  seedPanelDb,
  STAFF,
  STAFF_B,
  STAFF_NO_SERVICE,
  type PanelSeedOptions,
} from '@/verticals/agenda/agent/testing/panel-fixtures'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  type TestResponse,
} from '../../_lib/route-testing'

// ============================================================
// PATCH /api/verticals/agenda/appointments/[id] — el cambio de
// estado de siempre, más mover y cancelar desde el panel. La ruta, el
// repositorio y las reglas corren de punta a punta contra el fake de
// PostgREST compartido; solo se falsean el aviso al paciente (costura
// de T5), el aviso a Google y `after`.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
  afterCallbacks: [] as (() => unknown)[],
  kick: vi.fn(),
  notifyCalls: [] as Record<string, unknown>[],
  notifyOutcome: { notified: false, notify_error: 'sin aviso' } as {
    notified: boolean
    notify_error?: string
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return { ...nextServerMock(), after: (cb: () => unknown) => void h.afterCallbacks.push(cb) }
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

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

import { PATCH } from './route'

function boot(appointments: Row[] = [activeAppointment()], options: PanelSeedOptions = {}): FakeDb {
  const db = seedPanelDb({
    ...options,
    extra: {
      booking_appointments: [
        ...appointments,
        activeAppointment({
          id: FOREIGN_APPOINTMENT,
          account_id: OTHER_ACCOUNT,
          staff_id: 'otro-staff',
        }),
      ],
      ...options.extra,
    },
  })
  h.state.db = db
  return db
}

const patch = async (payload: unknown, id = APPOINTMENT) =>
  (await PATCH(jsonRequest(payload), { params: Promise.resolve({ id }) })) as unknown as TestResponse

const row = (db: FakeDb, id = APPOINTMENT) =>
  db._tables.booking_appointments.find((r) => r.id === id) as Row

const drainAfter = async () => {
  for (const cb of h.afterCallbacks.splice(0)) await cb()
}

/**
 * Simula que otra persona toca la cita entre la lectura y la escritura de la
 * ruta: justo después de la primera lectura de la cita, cambia `changes`.
 */
function touchAfterRead(db: FakeDb, changes: Row, id = APPOINTMENT) {
  const realFrom = db.from.bind(db)
  let touched = false
  db.from = (table: string) => {
    const query = realFrom(table) as { maybeSingle: () => Promise<unknown> }
    if (table !== 'booking_appointments') return query
    const original = query.maybeSingle.bind(query)
    query.maybeSingle = async () => {
      const result = await original()
      if (!touched) {
        touched = true
        Object.assign(row(db, id), changes)
      }
      return result
    }
    return query
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.state.role = 'agent'
  h.afterCallbacks.length = 0
  h.notifyCalls.length = 0
  h.notifyOutcome = { notified: false, notify_error: 'sin aviso' }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('permisos y cuenta', () => {
  it.each([
    ['cambio de estado', { status: 'completed' }],
    ['mover', { action: 'move', starts_at: MON_11 }],
    ['cancelar', { action: 'cancel' }],
  ])('un viewer no puede (%s) → 403 y no se toca la cita', async (_name, payload) => {
    const db = boot()
    h.state.role = 'viewer'
    const before = { ...row(db) }
    expect((await patch(payload)).status).toBe(403)
    expect(row(db)).toEqual(before)
  })

  it.each([
    ['cambio de estado', { status: 'completed' }],
    ['mover', { action: 'move', starts_at: MON_11 }],
    ['cancelar', { action: 'cancel' }],
  ])('una cita de otra cuenta → 404 (%s) y no se toca', async (_name, payload) => {
    const db = boot()
    const before = { ...row(db, FOREIGN_APPOINTMENT) }
    const res = await patch(payload, FOREIGN_APPOINTMENT)
    expect(res.status).toBe(404)
    expect(row(db, FOREIGN_APPOINTMENT)).toEqual(before)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it.each([
    ['cambio de estado', { status: 'completed' }],
    ['mover', { action: 'move', starts_at: MON_11 }],
    ['cancelar', { action: 'cancel' }],
  ])('un id que no es uuid → 404 (%s) sin llegar a la base', async (_name, payload) => {
    const db = boot()
    const before = { ...row(db) }
    const from = vi.spyOn(db, 'from')
    for (const id of ['no-es-un-uuid', '123', "77777777-7777-4777-8777-77777777777'", '']) {
      const res = await patch(payload, id)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('not_found')
      expect(res.body.error).toBe('La cita no existe.')
    }
    expect(from).not.toHaveBeenCalled()
    expect(row(db)).toEqual(before)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('una acción desconocida → 400', async () => {
    boot()
    const res = await patch({ action: 'borrar' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_action')
  })

  it('un JSON roto sigue dando 400', async () => {
    boot()
    const res = (await PATCH(brokenJsonRequest(), {
      params: Promise.resolve({ id: APPOINTMENT }),
    })) as unknown as TestResponse
    expect(res.status).toBe(400)
  })
})

describe('cambio de estado (sin cambios)', () => {
  it('pending → confirmed responde {appointment} como siempre y avisa a Google', async () => {
    const db = boot([activeAppointment({ status: 'pending' })])
    const res = await patch({ status: 'confirmed' })
    expect(res.status).toBe(200)
    // (El fake no recorta columnas como PostgREST; la forma {appointment} es lo que importa.)
    expect(res.body).toMatchObject({ appointment: { id: APPOINTMENT, status: 'confirmed' } })
    expect(Object.keys(res.body)).toEqual(['appointment'])
    expect(row(db).status).toBe('confirmed')
    // No manda aviso al paciente: el cambio de estado no lo ofrece.
    expect(h.notifyCalls).toHaveLength(0)
    await drainAfter()
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it('cancelar por estado conserva su motivo de siempre ("equipo")', async () => {
    const db = boot()
    const res = await patch({ status: 'cancelled' })
    expect(res.status).toBe(200)
    expect(row(db)).toMatchObject({ status: 'cancelled', cancel_reason: 'equipo' })
  })

  it('{status, action: null} se trata como cambio de estado (null = sin acción)', async () => {
    const db = boot()
    const res = await patch({ status: 'completed', action: null, confirm_past: null })
    expect(res.status).toBe(200)
    expect(row(db).status).toBe('completed')
    await drainAfter()
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it('{action: null} sin estado sigue dando invalid_status', async () => {
    boot()
    const res = await patch({ action: null })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_status')
  })

  it('un estado inválido → 400 sin tocar nada ni avisar a Google', async () => {
    const db = boot()
    const res = await patch({ status: 'volando' })
    expect(res.status).toBe(400)
    expect(row(db).status).toBe('confirmed')
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('una cita ya pasada pide confirmación (409) y no avisa a Google', async () => {
    const db = boot([
      activeAppointment({ starts_at: '2026-11-01T15:00:00.000Z', ends_at: '2026-11-01T15:30:00.000Z' }),
    ])
    const res = await patch({ status: 'completed' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('past_confirmation_required')
    expect(row(db).status).toBe('confirmed')
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('si alguien más cambió el estado en medio → 409 stale', async () => {
    const db = boot()
    touchAfterRead(db, { status: 'no_show' })
    const res = await patch({ status: 'completed' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('stale')
    expect(h.afterCallbacks).toHaveLength(0)
  })

  // Un error de la base puede traer la fila (details/hint): al log solo va el código y el mensaje.
  const dbError = {
    code: '57014',
    message: 'timeout al leer',
    details: 'Key (name)=(Marta Gómez) 573001112233',
    hint: 'Marta Gómez',
  }
  const loggedText = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.flat().map(String).join(' ')

  it('si no se puede leer la cita → 500, y el log lleva el código y el mensaje, no la fila', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('select', 'booking_appointments', dbError)
    const res = await patch({ status: 'completed' })
    const logged = loggedText(spy)
    spy.mockRestore()

    expect(res.status).toBe(500)
    expect(logged).toContain('57014')
    expect(logged).toContain('timeout al leer')
    expect(logged).not.toContain('Marta')
    expect(logged).not.toContain('573001112233')
    expect(row(db).status).toBe('confirmed')
  })

  it('si no se puede guardar el cambio → 500, y el log lleva el código y el mensaje, no la fila', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('update', 'booking_appointments', dbError)
    const res = await patch({ status: 'completed' })
    const logged = loggedText(spy)
    spy.mockRestore()

    expect(res.status).toBe(500)
    expect(logged).toContain('57014')
    expect(logged).toContain('timeout al leer')
    expect(logged).not.toContain('Marta')
    expect(logged).not.toContain('573001112233')
    expect(row(db).status).toBe('confirmed')
  })
})

describe('mover', () => {
  it('cambia la hora en la misma fila, conserva la duración y borra las marcas de aviso', async () => {
    const db = boot([
      activeAppointment({ ends_at: '2026-11-09T15:45:00.000Z' }), // 45 minutos
    ])
    const res = await patch({ action: 'move', starts_at: MON_11 })

    expect(res.status).toBe(200)
    expect(db._tables.booking_appointments.filter((r) => r.account_id === TEST_ACCOUNT)).toHaveLength(1)
    expect(row(db)).toMatchObject({
      id: APPOINTMENT,
      status: 'confirmed',
      staff_id: STAFF,
      starts_at: MON_11,
      ends_at: '2026-11-09T16:45:00.000Z',
      reminder_sent_at: null,
      reminder_2h_sent_at: null,
      attendance_confirmed_at: null,
    })
    expect(res.body).toMatchObject({
      appointment: { id: APPOINTMENT, status: 'confirmed', starts_at: MON_11 },
      notified: false,
    })
  })

  it('con aviso pedido llama a la costura (moved) con la cita; notify=false no', async () => {
    boot()
    h.notifyOutcome = { notified: true }
    const sent = await patch({ action: 'move', starts_at: MON_11 })
    expect(h.notifyCalls).toEqual([
      { db: h.state.db, accountId: TEST_ACCOUNT, appointmentId: APPOINTMENT, kind: 'moved', now: NOW },
    ])
    expect(sent.body.notified).toBe(true)

    h.notifyCalls.length = 0
    const quiet = await patch({ action: 'move', starts_at: '2026-11-09T17:00:00.000Z', notify: false })
    expect(quiet.status).toBe(200)
    expect(h.notifyCalls).toHaveLength(0)
  })

  it('si el aviso falla la cita igual se movió y viaja notify_error', async () => {
    const db = boot()
    h.notifyOutcome = { notified: false, notify_error: 'Meta rechazó el mensaje.' }
    const res = await patch({ action: 'move', starts_at: MON_11 })
    expect(res.status).toBe(200)
    expect(row(db).starts_at).toBe(MON_11)
    expect(res.body).toMatchObject({ notified: false, notify_error: 'Meta rechazó el mensaje.' })
  })

  it('avisa a Google solo después de guardar', async () => {
    boot()
    await patch({ action: 'move', starts_at: MON_11 })
    expect(h.kick).not.toHaveBeenCalled()
    await drainAfter()
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it('cambia de profesional si el otro atiende y trabaja ese día', async () => {
    const db = boot()
    const res = await patch({
      action: 'move',
      starts_at: '2026-11-10T15:00:00.000Z', // martes 10:00
      staff_id: STAFF_B,
    })
    expect(res.status).toBe(200)
    expect(row(db)).toMatchObject({ staff_id: STAFF_B, starts_at: '2026-11-10T15:00:00.000Z' })
  })

  it('un profesional que no atiende el servicio → 400', async () => {
    const db = boot()
    const res = await patch({ action: 'move', starts_at: MON_11, staff_id: STAFF_NO_SERVICE })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('staff_not_for_service')
    expect(row(db).starts_at).toBe(MON_10)
  })

  it('un profesional de otra cuenta → 404', async () => {
    const db = boot()
    const res = await patch({ action: 'move', starts_at: MON_11, staff_id: FOREIGN_STAFF })
    expect(res.status).toBe(404)
    expect(row(db).starts_at).toBe(MON_10)
  })

  it('un profesional que ese día no trabaja → 409 outside_hours', async () => {
    const db = boot()
    const res = await patch({ action: 'move', starts_at: MON_11, staff_id: STAFF_B })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('outside_hours')
    expect(row(db).staff_id).toBe(STAFF)
  })

  it('una cita sin servicio (se borró del catálogo) se puede mover con el mismo profesional', async () => {
    const db = boot([activeAppointment({ service_id: null })])
    expect((await patch({ action: 'move', starts_at: MON_11 })).status).toBe(200)
    expect(row(db).starts_at).toBe(MON_11)
  })

  it('una cita sin servicio no deja cambiar de profesional (no se sabe si atiende)', async () => {
    boot([activeAppointment({ service_id: null })])
    const res = await patch({ action: 'move', starts_at: '2026-11-10T15:00:00.000Z', staff_id: STAFF_B })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('staff_not_for_service')
  })

  it('una cita sin profesional necesita que se elija uno', async () => {
    boot([activeAppointment({ staff_id: null })])
    const res = await patch({ action: 'move', starts_at: MON_11 })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('staff_required')
  })

  it('fuera de horario → 409 outside_hours, y con outside_hours_ok pasa', async () => {
    const db = boot()
    const blocked = await patch({ action: 'move', starts_at: '2026-11-10T01:00:00.000Z' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.code).toBe('outside_hours')
    expect(row(db).starts_at).toBe(MON_10)
    expect(h.afterCallbacks).toHaveLength(0)

    const forced = await patch({
      action: 'move',
      starts_at: '2026-11-10T01:00:00.000Z',
      outside_hours_ok: true,
    })
    expect(forced.status).toBe(200)
    expect(row(db).starts_at).toBe('2026-11-10T01:00:00.000Z')
  })

  it('una hora pasada → 400', async () => {
    const db = boot()
    const res = await patch({ action: 'move', starts_at: '2026-11-04T15:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('past')
    expect(row(db).starts_at).toBe(MON_10)
  })

  it.each([
    ['cancelada', { status: 'cancelled' }],
    ['atendida', { status: 'completed' }],
    ['no vino', { status: 'no_show' }],
    [
      'ya pasada',
      { starts_at: '2026-11-01T15:00:00.000Z', ends_at: '2026-11-01T15:30:00.000Z' },
    ],
  ])('una cita %s no se puede mover → 409 not_editable', async (_name, changes) => {
    const db = boot([activeAppointment(changes)])
    const before = { ...row(db) }
    const res = await patch({ action: 'move', starts_at: MON_11 })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('not_editable')
    expect(row(db)).toEqual(before)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('choque con otra cita del profesional (23P01) → 409 slot_taken', async () => {
    const db = boot()
    db._failNext('update', 'booking_appointments', { code: '23P01', message: 'choque' })
    const res = await patch({ action: 'move', starts_at: MON_11 })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('slot_taken')
    expect(row(db).starts_at).toBe(MON_10)
    expect(h.notifyCalls).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('otro error de la base → 500 genérico', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('update', 'booking_appointments', { code: '23514', message: 'check' })
    const res = await patch({ action: 'move', starts_at: MON_11 })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('bloqueo optimista: si la cita cambió mientras se editaba → 409 stale y no se pisa', async () => {
    const db = boot()
    touchAfterRead(db, { updated_at: '2026-11-05T14:59:00.000000+00:00', notes: 'otro cambió esto' })
    const res = await patch({ action: 'move', starts_at: MON_11 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('stale')
    expect(String(res.body.error)).toMatch(/recarga/i)
    expect(row(db)).toMatchObject({ starts_at: MON_10, reminder_sent_at: '2026-11-08T15:00:00.000Z' })
    expect(h.notifyCalls).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('un cuerpo inválido → 400', async () => {
    const db = boot()
    for (const payload of [
      { action: 'move' },
      { action: 'move', starts_at: '2026-11-09T10:00:00' },
      { action: 'move', starts_at: MON_11, staff_id: 'x' },
    ]) {
      const res = await patch(payload)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('invalid_body')
    }
    expect(row(db).starts_at).toBe(MON_10)
  })

  it('un horario que no se pudo leer no se confunde con "sin horario": falla cerrado', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('select', 'booking_time_off', { message: 'caído' })
    const res = await patch({ action: 'move', starts_at: MON_11 })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(row(db).starts_at).toBe(MON_10)
  })

  describe('en una clínica', () => {
    const CLINIC: PanelSeedOptions = { modules: ['agenda', 'clinica'], chairCount: 1 }

    it('la propia cita no ocupa el sillón de la hora a la que se mueve', async () => {
      // Un solo sillón y la única cita activa es esta: mover 15 minutos
      // (la hora nueva se cruza con la vieja) tiene que poder.
      const db = boot([activeAppointment()], CLINIC)
      const res = await patch({ action: 'move', starts_at: '2026-11-09T15:15:00.000Z' })
      expect(res.status).toBe(200)
      expect(row(db).starts_at).toBe('2026-11-09T15:15:00.000Z')
    })

    it('sillones llenos con otra cita en la hora nueva → 409 chairs_full', async () => {
      const db = boot(
        [
          activeAppointment(),
          activeAppointment({
            id: OTHER_APPOINTMENT,
            staff_id: STAFF_NO_SERVICE,
            starts_at: MON_11,
            ends_at: '2026-11-09T16:30:00.000Z',
          }),
        ],
        CLINIC,
      )
      const res = await patch({ action: 'move', starts_at: MON_11 })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('chairs_full')
      expect(row(db).starts_at).toBe(MON_10)
    })

    it('con dos sillones y una cita ajena en esa hora, la propia no estorba', async () => {
      boot(
        [
          activeAppointment(),
          activeAppointment({
            id: OTHER_APPOINTMENT,
            staff_id: STAFF_NO_SERVICE,
            starts_at: MON_11,
            ends_at: '2026-11-09T16:30:00.000Z',
          }),
        ],
        { modules: ['agenda', 'clinica'], chairCount: 2 },
      )
      expect((await patch({ action: 'move', starts_at: MON_11 })).status).toBe(200)
    })
  })

  it('una cuenta sin clínica no mira sillones', async () => {
    boot(
      [
        activeAppointment(),
        activeAppointment({
          id: OTHER_APPOINTMENT,
          staff_id: STAFF_NO_SERVICE,
          starts_at: MON_11,
          ends_at: '2026-11-09T16:30:00.000Z',
        }),
      ],
      {
        extra: {
          clinic_locations: [
            { id: 'l', account_id: TEST_ACCOUNT, is_active: true, chair_count: 1, created_at: 'x' },
          ],
        },
      },
    )
    expect((await patch({ action: 'move', starts_at: MON_11 })).status).toBe(200)
  })
})

describe('cancelar', () => {
  it('pasa a cancelled con la hora y el motivo por defecto "clinic"', async () => {
    const db = boot()
    const res = await patch({ action: 'cancel' })
    expect(res.status).toBe(200)
    expect(row(db)).toMatchObject({
      status: 'cancelled',
      cancelled_at: NOW.toISOString(),
      cancel_reason: 'clinic',
    })
    expect(res.body).toMatchObject({ appointment: { id: APPOINTMENT, status: 'cancelled' }, notified: false })
  })

  it('guarda el motivo escrito (recortado)', async () => {
    const db = boot()
    await patch({ action: 'cancel', reason: '  El paciente viaja  ' })
    expect(row(db).cancel_reason).toBe('El paciente viaja')
  })

  it('un motivo de más de 200 caracteres → 400 y no se cancela', async () => {
    const db = boot()
    const res = await patch({ action: 'cancel', reason: 'a'.repeat(201) })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_body')
    expect(row(db).status).toBe('confirmed')
  })

  it('con aviso pedido llama a la costura (cancelled); notify=false no', async () => {
    boot([activeAppointment(), activeAppointment({ id: OTHER_APPOINTMENT, staff_id: STAFF_B })])
    h.notifyOutcome = { notified: true }
    const sent = await patch({ action: 'cancel' })
    expect(h.notifyCalls).toEqual([
      { db: h.state.db, accountId: TEST_ACCOUNT, appointmentId: APPOINTMENT, kind: 'cancelled', now: NOW },
    ])
    expect(sent.body.notified).toBe(true)

    h.notifyCalls.length = 0
    const quiet = await patch({ action: 'cancel', notify: false }, OTHER_APPOINTMENT)
    expect(quiet.status).toBe(200)
    expect(h.notifyCalls).toHaveLength(0)
  })

  it('si el aviso falla la cita igual queda cancelada y viaja notify_error', async () => {
    const db = boot()
    h.notifyOutcome = { notified: false, notify_error: 'Fuera de la ventana de 24 horas.' }
    const res = await patch({ action: 'cancel' })
    expect(res.status).toBe(200)
    expect(row(db).status).toBe('cancelled')
    expect(res.body).toMatchObject({ notified: false, notify_error: 'Fuera de la ventana de 24 horas.' })
  })

  it('avisa a Google solo después de guardar', async () => {
    boot()
    await patch({ action: 'cancel' })
    expect(h.kick).not.toHaveBeenCalled()
    await drainAfter()
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it.each(['cancelled', 'completed', 'no_show'])('una cita %s ya no se puede cancelar → 409', async (status) => {
    const db = boot([activeAppointment({ status })])
    const res = await patch({ action: 'cancel' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('terminal_status')
    expect(row(db).status).toBe(status)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('una cita pasada pide confirmación, y con confirm_past se cancela', async () => {
    const db = boot([
      activeAppointment({ starts_at: '2026-11-01T15:00:00.000Z', ends_at: '2026-11-01T15:30:00.000Z' }),
    ])
    const asked = await patch({ action: 'cancel' })
    expect(asked.status).toBe(409)
    expect(asked.body.code).toBe('past_confirmation_required')
    expect(row(db).status).toBe('confirmed')

    const done = await patch({ action: 'cancel', confirm_past: true })
    expect(done.status).toBe(200)
    expect(row(db).status).toBe('cancelled')
  })

  it('si alguien más cambió el estado en medio → 409 stale y no avisa', async () => {
    const db = boot()
    touchAfterRead(db, { status: 'completed' })
    const res = await patch({ action: 'cancel' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('stale')
    expect(row(db).status).toBe('completed')
    expect(h.notifyCalls).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('un error de la base → 500 genérico', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('update', 'booking_appointments', { message: 'caído' })
    const res = await patch({ action: 'cancel' })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(row(db).status).toBe('confirmed')
  })
})
