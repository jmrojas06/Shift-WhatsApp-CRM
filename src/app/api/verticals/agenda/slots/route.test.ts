import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import {
  activeAppointment,
  APPOINTMENT,
  FOREIGN_SERVICE,
  FOREIGN_STAFF,
  INACTIVE_SERVICE,
  LOCATION,
  MON_10,
  NOW,
  OTHER_ACCOUNT,
  OTHER_APPOINTMENT,
  seedPanelDb,
  SERVICE,
  STAFF,
  STAFF_B,
  STAFF_NO_SERVICE,
  type PanelSeedOptions,
} from '@/verticals/agenda/agent/testing/panel-fixtures'

import { TEST_ACCOUNT, type TestResponse } from '../_lib/route-testing'

// ============================================================
// GET /api/verticals/agenda/slots — las horas libres que el panel
// ofrece al crear o mover una cita. La ruta, el repositorio y el
// cálculo de disponibilidad (el mismo del bot) corren de punta a punta
// contra el fake de PostgREST compartido.
//
// Fixtures: la Dra. Rojas (STAFF) trabaja lunes a viernes de 9 a 18; la
// Dra. Vega (STAFF_B) de martes a viernes. Las dos atienden SERVICE (30
// min). "Ahora" es el jueves 5 de noviembre, 10:00 en Bogotá.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return { ...nextServerMock(), after: () => {} }
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

vi.mock('@/verticals/agenda/calendar-kick', () => ({
  kickCalendarSync: async () => {},
}))

import { GET } from './route'

const MONDAY = '2026-11-09'
const TUESDAY = '2026-11-10'
/** Lunes 9 de noviembre, 9:00 y 9:30 en Bogotá. */
const MON_9 = '2026-11-09T14:00:00.000Z'
const MON_9_30 = '2026-11-09T14:30:00.000Z'
const MON_10_30 = '2026-11-09T15:30:00.000Z'
const MON_11 = '2026-11-09T16:00:00.000Z'

function boot(options: PanelSeedOptions = {}): FakeDb {
  const db = seedPanelDb(options)
  h.state.db = db
  return db
}

/** GET con la query armada como lo hace la pantalla. */
const get = async (query: Record<string, string>) =>
  (await GET(
    new Request(`http://localhost/api/verticals/agenda/slots?${new URLSearchParams(query)}`),
  )) as unknown as TestResponse

interface SlotsBody {
  slots: { starts_at: string; staff_ids: string[] }[]
}
const slotsOf = (res: TestResponse) => (res.body as unknown as SlotsBody).slots
const startsOf = (res: TestResponse) => slotsOf(res).map((s) => s.starts_at)

/** Una cita activa de STAFF el lunes a las 10:00 (la de las fixtures), con lo que se quiera cambiar. */
const appointmentAt = (overrides: Row = {}): Row =>
  activeAppointment({ ends_at: MON_10_30, ...overrides })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.state.role = 'agent'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/verticals/agenda/slots: permisos', () => {
  it('un viewer no puede pedir horas (403)', async () => {
    boot()
    h.state.role = 'viewer'
    const res = await get({ service_id: SERVICE, date: MONDAY })
    expect(res.status).toBe(403)
  })

  it.each(['agent', 'admin', 'owner'] as const)('un %s sí puede', async (role) => {
    boot()
    h.state.role = role
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/verticals/agenda/slots: horas de un profesional', () => {
  it('devuelve la rejilla del día del profesional, en ISO UTC y con quién está libre', async () => {
    boot()
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(res.status).toBe(200)
    const slots = slotsOf(res)
    // 9:00 a 17:30 cada 30 minutos: 18 horas.
    expect(slots).toHaveLength(18)
    expect(slots[0]).toEqual({ starts_at: MON_9, staff_ids: [STAFF] })
    expect(slots[1].starts_at).toBe(MON_9_30)
    expect(slots[17]).toEqual({ starts_at: '2026-11-09T22:30:00.000Z', staff_ids: [STAFF] })
  })

  it('no ofrece la hora de una cita activa del profesional', async () => {
    const db = boot()
    db._tables.booking_appointments.push(appointmentAt())
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).not.toContain(MON_10)
    expect(startsOf(res)).toContain(MON_9_30)
    expect(startsOf(res)).toContain(MON_10_30)
  })

  it('una cita cancelada no tapa la hora', async () => {
    const db = boot()
    db._tables.booking_appointments.push(appointmentAt({ status: 'cancelled' }))
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).toContain(MON_10)
  })

  it('la cita de otra cuenta no tapa nada', async () => {
    const db = boot()
    db._tables.booking_appointments.push(appointmentAt({ account_id: OTHER_ACCOUNT }))
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).toContain(MON_10)
  })

  it('un bloqueo (time off) del profesional quita sus horas', async () => {
    const db = boot()
    db._tables.booking_time_off.push({
      account_id: TEST_ACCOUNT,
      staff_id: STAFF,
      starts_at: '2026-11-09T14:00:00.000Z',
      ends_at: '2026-11-09T22:00:00.000Z',
    })
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    // Quedan solo las 17:00 y las 17:30 (22:00Z en adelante).
    expect(startsOf(res)).toEqual(['2026-11-09T22:00:00.000Z', '2026-11-09T22:30:00.000Z'])
  })

  it('un día en que no trabaja no tiene horas', async () => {
    boot()
    // La Dra. Vega no trabaja los lunes.
    const res = await get({ service_id: SERVICE, staff_id: STAFF_B, date: MONDAY })
    expect(res.status).toBe(200)
    expect(slotsOf(res)).toEqual([])
  })

  it('un día pasado no tiene horas, y hoy solo las que faltan con el margen de 30 minutos', async () => {
    boot()
    const past = await get({ service_id: SERVICE, staff_id: STAFF, date: '2026-11-04' })
    expect(slotsOf(past)).toEqual([])
    // Hoy jueves son las 10:00: la primera hora es las 10:30.
    const today = await get({ service_id: SERVICE, staff_id: STAFF, date: '2026-11-05' })
    expect(startsOf(today)[0]).toBe('2026-11-05T15:30:00.000Z')
  })
})

describe('GET /api/verticals/agenda/slots: "Cualquiera"', () => {
  it('une las horas de todos los que atienden el servicio y dice quién está libre en cada una', async () => {
    boot()
    const res = await get({ service_id: SERVICE, date: TUESDAY })
    const slots = slotsOf(res)
    expect(slots).toHaveLength(18)
    expect(slots[0].staff_ids).toEqual([STAFF, STAFF_B])
  })

  it('si no se puede leer quién atiende el servicio, responde 500 y no "no hay horas"', async () => {
    const db = boot()
    db._failNext('select', 'booking_staff_services', { message: 'timeout' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await get({ service_id: SERVICE, date: TUESDAY })
    expect(res.status).toBe(500)
  })

  it('si no se puede leer el equipo, responde 500', async () => {
    const db = boot()
    db._failNext('select', 'booking_staff', { message: 'timeout' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await get({ service_id: SERVICE, date: TUESDAY })
    expect(res.status).toBe(500)
  })

  it('en un día donde solo uno trabaja, solo ese aparece', async () => {
    boot()
    const res = await get({ service_id: SERVICE, date: MONDAY })
    expect(slotsOf(res).length).toBeGreaterThan(0)
    expect(slotsOf(res).every((s) => s.staff_ids.length === 1 && s.staff_ids[0] === STAFF)).toBe(
      true,
    )
  })

  it('si uno está ocupado a esa hora, aparece el otro', async () => {
    const db = boot()
    db._tables.booking_appointments.push(
      appointmentAt({
        staff_id: STAFF,
        starts_at: '2026-11-10T15:00:00.000Z',
        ends_at: '2026-11-10T15:30:00.000Z',
      }),
    )
    const res = await get({ service_id: SERVICE, date: TUESDAY })
    const ten = slotsOf(res).find((s) => s.starts_at === '2026-11-10T15:00:00.000Z')
    expect(ten?.staff_ids).toEqual([STAFF_B])
  })

  it('un profesional inactivo no entra, aunque atienda el servicio', async () => {
    const db = boot()
    db._tables.booking_staff.find((s) => s.id === STAFF_B)!.is_active = false
    const res = await get({ service_id: SERVICE, date: TUESDAY })
    expect(slotsOf(res)[0].staff_ids).toEqual([STAFF])
  })

  it('un servicio que nadie atiende devuelve lista vacía', async () => {
    const db = boot()
    db._tables.booking_staff_services = []
    const res = await get({ service_id: SERVICE, date: MONDAY })
    expect(res.status).toBe(200)
    expect(slotsOf(res)).toEqual([])
  })
})

describe('GET /api/verticals/agenda/slots: mover una cita (exclude)', () => {
  it('sin exclude, la propia cita tapa su hora; con exclude, queda libre', async () => {
    const db = boot()
    db._tables.booking_appointments.push(appointmentAt())

    const without = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(without)).not.toContain(MON_10)

    const withExclude = await get({
      service_id: SERVICE,
      staff_id: STAFF,
      date: MONDAY,
      exclude: APPOINTMENT,
    })
    expect(startsOf(withExclude)).toContain(MON_10)
  })

  it('exclude solo libera esa cita: las demás siguen ocupando', async () => {
    const db = boot()
    db._tables.booking_appointments.push(
      appointmentAt(),
      appointmentAt({ id: OTHER_APPOINTMENT, starts_at: MON_10_30, ends_at: MON_11 }),
    )
    const res = await get({
      service_id: SERVICE,
      staff_id: STAFF,
      date: MONDAY,
      exclude: APPOINTMENT,
    })
    expect(startsOf(res)).toContain(MON_10)
    expect(startsOf(res)).not.toContain(MON_10_30)
  })

  it('exclude no libera un bloqueo', async () => {
    const db = boot()
    db._tables.booking_time_off.push({
      account_id: TEST_ACCOUNT,
      staff_id: STAFF,
      starts_at: MON_10,
      ends_at: MON_10_30,
    })
    const res = await get({
      service_id: SERVICE,
      staff_id: STAFF,
      date: MONDAY,
      exclude: APPOINTMENT,
    })
    expect(startsOf(res)).not.toContain(MON_10)
  })
})

describe('GET /api/verticals/agenda/slots: sillones de la clínica', () => {
  /** Una cita de otro profesional a las 10:00 ocupa un sillón. */
  const otherDentistAtTen = (): Row => appointmentAt({ id: OTHER_APPOINTMENT, staff_id: STAFF_B })

  it('en una clínica con el cupo lleno, la hora no se ofrece aunque el profesional esté libre', async () => {
    const db = boot({ modules: ['agenda', 'clinica'], chairCount: 1 })
    db._tables.booking_appointments.push(otherDentistAtTen())
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).not.toContain(MON_10)
    expect(startsOf(res)).toContain(MON_9_30)
  })

  it('con una silla de sobra, la hora se ofrece', async () => {
    const db = boot({ modules: ['agenda', 'clinica'], chairCount: 2 })
    db._tables.booking_appointments.push(otherDentistAtTen())
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).toContain(MON_10)
  })

  it('sin cupo puesto en la sede, no se limita', async () => {
    const db = boot({ modules: ['agenda', 'clinica'], chairCount: null })
    db._tables.booking_appointments.push(otherDentistAtTen())
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).toContain(MON_10)
  })

  it('al mover, la propia cita no ocupa el sillón que va a usar', async () => {
    const db = boot({ modules: ['agenda', 'clinica'], chairCount: 1 })
    db._tables.booking_appointments.push(appointmentAt({ staff_id: STAFF_B }))

    const without = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(without)).not.toContain(MON_10)

    const withExclude = await get({
      service_id: SERVICE,
      staff_id: STAFF,
      date: MONDAY,
      exclude: APPOINTMENT,
    })
    expect(startsOf(withExclude)).toContain(MON_10)
  })

  it('"Cualquiera" con el cupo lleno: la hora no sale con ningún profesional', async () => {
    const db = boot({ modules: ['agenda', 'clinica'], chairCount: 1 })
    db._tables.booking_appointments.push(
      appointmentAt({
        id: OTHER_APPOINTMENT,
        staff_id: STAFF_B,
        starts_at: '2026-11-10T15:00:00.000Z',
        ends_at: '2026-11-10T15:30:00.000Z',
      }),
    )
    const res = await get({ service_id: SERVICE, date: TUESDAY })
    expect(startsOf(res)).not.toContain('2026-11-10T15:00:00.000Z')
    expect(startsOf(res)).toContain('2026-11-10T14:30:00.000Z')
  })

  it('una cuenta sin el módulo clínica ignora los sillones, aunque haya una sede', async () => {
    const db = boot({
      modules: ['agenda'],
      extra: {
        clinic_locations: [
          {
            id: LOCATION,
            account_id: TEST_ACCOUNT,
            is_active: true,
            chair_count: 1,
            created_at: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    })
    db._tables.booking_appointments.push(otherDentistAtTen())
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(startsOf(res)).toContain(MON_10)
  })

  it('si no se puede leer el cupo, falla en vez de ofrecer horas (500 sin detalles)', async () => {
    const db = boot({ modules: ['agenda', 'clinica'], chairCount: 1 })
    db._failNext('select', 'clinic_locations', { message: 'se cayó la base' })
    const res = await get({ service_id: SERVICE, staff_id: STAFF, date: MONDAY })
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('cayó')
  })
})

describe('GET /api/verticals/agenda/slots: parámetros', () => {
  it.each([
    ['falta el servicio', { date: MONDAY }],
    ['servicio que no es uuid', { service_id: 'x', date: MONDAY }],
    ['profesional que no es uuid', { service_id: SERVICE, staff_id: 'x', date: MONDAY }],
    ['falta el día', { service_id: SERVICE }],
    ['día con otro formato', { service_id: SERVICE, date: '09/11/2026' }],
    ['día que no existe', { service_id: SERVICE, date: '2026-02-30' }],
    ['cita a excluir que no es uuid', { service_id: SERVICE, date: MONDAY, exclude: 'x' }],
  ])('400 invalid_query: %s', async (_name, query) => {
    boot()
    const res = await get(query)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'invalid_query' })
    expect(typeof res.body.error).toBe('string')
  })

  it('404 service_not_found: servicio inactivo o de otra cuenta', async () => {
    boot()
    for (const service_id of [INACTIVE_SERVICE, FOREIGN_SERVICE]) {
      const res = await get({ service_id, date: MONDAY })
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ code: 'service_not_found' })
    }
  })

  it('404 staff_not_found: profesional de otra cuenta', async () => {
    boot()
    const res = await get({ service_id: SERVICE, staff_id: FOREIGN_STAFF, date: MONDAY })
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: 'staff_not_found' })
  })

  it('400 staff_not_for_service: el profesional no atiende ese servicio', async () => {
    boot()
    const res = await get({ service_id: SERVICE, staff_id: STAFF_NO_SERVICE, date: MONDAY })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'staff_not_for_service' })
  })

  it('un error de la base no se filtra (500 genérico)', async () => {
    const db = boot()
    db._failNext('select', 'booking_services', { message: 'detalle interno' })
    const res = await get({ service_id: SERVICE, date: MONDAY })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Error interno.' })
  })
})
