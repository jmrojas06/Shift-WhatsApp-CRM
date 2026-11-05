import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import {
  activeAppointment,
  CONSENT_TEXT,
  CONTACT,
  CONVERSATION,
  FOREIGN_CONTACT,
  FOREIGN_SERVICE,
  FOREIGN_STAFF,
  INACTIVE_SERVICE,
  LOCATION,
  MON_10,
  MON_20,
  NEW_CONTACT,
  NOW,
  OTHER_PATIENT,
  PATIENT,
  seedPanelDb,
  SERVICE,
  STAFF,
  STAFF_NO_SERVICE,
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
// POST /api/verticals/agenda/appointments — la recepción crea una
// cita desde el panel. La ruta, el repositorio y las reglas corren de
// punta a punta contra el fake de PostgREST compartido; solo se
// falsean: el aviso al paciente (costura de T5), el aviso a Google, el
// alta de contactos nuevos (usa `like`, que el fake no tiene) y `after`.
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
  findOrCreateContact: vi.fn(),
  findExistingContact: vi.fn(),
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

vi.mock('@/lib/api/v1/contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/v1/contacts')>()),
  findOrCreateContact: (...args: unknown[]) => h.findOrCreateContact(...args),
}))

// La búsqueda de un contacto por teléfono usa `like`, que el fake no tiene.
vi.mock('@/lib/contacts/dedupe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/dedupe')>()),
  findExistingContact: (...args: unknown[]) => h.findExistingContact(...args),
}))

import { POST } from './route'

function boot(options: PanelSeedOptions = {}): FakeDb {
  const db = seedPanelDb(options)
  h.state.db = db
  return db
}

const body = (extra: Record<string, unknown> = {}) => ({
  contact_id: CONTACT,
  service_id: SERVICE,
  staff_id: STAFF,
  starts_at: MON_10,
  ...extra,
})

const post = async (payload: unknown) => (await POST(jsonRequest(payload))) as unknown as TestResponse

const rows = (db: FakeDb, table: string): Row[] => db._tables[table] ?? []

/** Copia de todas las tablas, para comprobar que una petición rechazada no escribió NADA. */
const snapshot = (db: FakeDb) => structuredClone(db._tables)

/** Corre lo que la ruta dejó para después de responder, como el runtime. */
const drainAfter = async () => {
  for (const cb of h.afterCallbacks.splice(0)) await cb()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.state.role = 'agent'
  h.afterCallbacks.length = 0
  h.notifyCalls.length = 0
  h.notifyOutcome = { notified: false, notify_error: 'sin aviso' }
  h.findExistingContact.mockReset()
  h.findExistingContact.mockResolvedValue(null)
  h.findOrCreateContact.mockReset()
  h.findOrCreateContact.mockImplementation(
    async (db: FakeDb, accountId: string, _userId: string, input: { phone: string; name: string }) => {
      db._tables.contacts.push({
        id: NEW_CONTACT,
        account_id: accountId,
        name: input.name,
        phone: parseInternationalPhone(input.phone),
      })
      return { id: NEW_CONTACT, created: true }
    },
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('permisos y cuenta', () => {
  it('un viewer no puede crear citas (403) y no se escribe nada', async () => {
    const db = boot()
    h.state.role = 'viewer'
    const res = await post(body())
    expect(res.status).toBe(403)
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  it('un agent sí puede', async () => {
    boot()
    expect((await post(body())).status).toBe(201)
  })

  it.each([
    ['el contacto', { contact_id: FOREIGN_CONTACT }, 'contact_not_found'],
    ['el servicio', { service_id: FOREIGN_SERVICE }, 'service_not_found'],
    ['el profesional', { staff_id: FOREIGN_STAFF }, 'staff_not_found'],
    ['un servicio desactivado', { service_id: INACTIVE_SERVICE }, 'service_not_found'],
  ])('si %s es de otra cuenta (o no sirve) responde 404 y no escribe', async (_name, extra, code) => {
    const db = boot()
    const res = await post(body(extra))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe(code)
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })
})

describe('cuerpo inválido', () => {
  it.each([
    ['sin contacto', { contact_id: undefined }],
    ['uuid malo', { service_id: 'no-es-uuid' }],
    ['hora sin zona', { starts_at: '2026-11-09T10:00:00' }],
    ['notify que no es booleano', { notify: 'si' }],
  ])('%s → 400', async (_name, extra) => {
    const db = boot()
    const res = await post(body(extra))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_body')
    expect(typeof res.body.error).toBe('string')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  it('un JSON roto → 400', async () => {
    boot()
    const res = (await POST(brokenJsonRequest())) as unknown as TestResponse
    expect(res.status).toBe(400)
  })

  it('contacto nuevo con teléfono inválido → 400 y no crea el contacto', async () => {
    const db = boot()
    const res = await post(
      body({ contact_id: undefined, new_contact: { name: 'Luis Gómez', phone: '3001234567' } }),
    )
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/tel[eé]fono/i)
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })
})

describe('crear una cita (cuenta sin clínica)', () => {
  it('guarda la cita confirmada, hecha desde el panel, y responde con su id', async () => {
    const db = boot()
    const res = await post(body())

    expect(res.status).toBe(201)
    const [appointment] = rows(db, 'booking_appointments')
    expect(res.body.id).toBe(appointment.id)
    expect(appointment).toMatchObject({
      account_id: TEST_ACCOUNT,
      contact_id: CONTACT,
      conversation_id: CONVERSATION,
      service_id: SERVICE,
      staff_id: STAFF,
      starts_at: MON_10,
      // La duración sale del servicio (30 minutos), no del cuerpo.
      ends_at: '2026-11-09T15:30:00.000Z',
      status: 'confirmed',
      created_via: 'dashboard',
      created_by: TEST_USER,
      confirmed_at: NOW.toISOString(),
    })
    // Sin clínica no hay paciente ni sede.
    expect('patient_id' in appointment).toBe(false)
    expect('location_id' in appointment).toBe(false)
  })

  it('con aviso pedido llama a la costura con el id de la cita guardada', async () => {
    const db = boot()
    h.notifyOutcome = { notified: true }
    const res = await post(body())

    const [appointment] = rows(db, 'booking_appointments')
    expect(h.notifyCalls).toEqual([
      {
        db: h.state.db,
        accountId: TEST_ACCOUNT,
        appointmentId: appointment.id,
        kind: 'booked',
        now: NOW,
      },
    ])
    expect(res.body).toEqual({ id: appointment.id, notified: true })
  })

  it('si el aviso falla, la cita queda guardada y el motivo viaja en notify_error', async () => {
    const db = boot()
    h.notifyOutcome = { notified: false, notify_error: 'Meta rechazó el mensaje.' }
    const res = await post(body())

    expect(res.status).toBe(201)
    expect(rows(db, 'booking_appointments')).toHaveLength(1)
    expect(res.body).toMatchObject({ notified: false, notify_error: 'Meta rechazó el mensaje.' })
  })

  it('con notify=false no avisa', async () => {
    boot()
    const res = await post(body({ notify: false }))
    expect(h.notifyCalls).toHaveLength(0)
    expect(res.body.notified).toBe(false)
    expect('notify_error' in res.body).toBe(false)
  })

  it('programa el aviso a Google con after() solo después de guardar', async () => {
    boot()
    await post(body())
    expect(h.kick).not.toHaveBeenCalled()
    await drainAfter()
    expect(h.kick).toHaveBeenCalledTimes(1)
    expect(h.kick).toHaveBeenCalledWith(TEST_ACCOUNT)
  })

  it('si el aviso a Google lanza, no se nota', async () => {
    boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.kick.mockRejectedValueOnce(new Error('Google caído'))
    await post(body())
    await expect(drainAfter()).resolves.toBeUndefined()
    spy.mockRestore()
  })

  it('un contacto sin conversación recibe una vacía de la cuenta, sin enviar nada', async () => {
    const db = boot({ extra: { conversations: [] } })
    const res = await post(body())

    expect(res.status).toBe(201)
    const [conversation] = rows(db, 'conversations')
    expect(conversation).toMatchObject({
      account_id: TEST_ACCOUNT,
      user_id: TEST_USER,
      contact_id: CONTACT,
    })
    expect(rows(db, 'booking_appointments')[0].conversation_id).toBe(conversation.id)
    expect(rows(db, 'messages')).toHaveLength(0)
  })

  it('un contacto nuevo se crea con el usuario de la sesión y se usa su conversación nueva', async () => {
    const db = boot()
    const res = await post(
      body({ contact_id: undefined, new_contact: { name: 'Luis Gómez', phone: '+57 300 123 4567' } }),
    )

    expect(res.status).toBe(201)
    expect(h.findOrCreateContact).toHaveBeenCalledWith(h.state.db, TEST_ACCOUNT, TEST_USER, {
      name: 'Luis Gómez',
      phone: '+57 300 123 4567',
    })
    const [appointment] = rows(db, 'booking_appointments')
    expect(appointment.contact_id).toBe(NEW_CONTACT)
    const created = rows(db, 'conversations').find((c) => c.contact_id === NEW_CONTACT)
    expect(created).toBeTruthy()
    expect(appointment.conversation_id).toBe(created?.id)
  })

  it('un fallo al crear el contacto da 500 genérico, sin datos', async () => {
    const db = boot()
    const { ContactError } = await import('@/lib/api/v1/contacts')
    h.findOrCreateContact.mockRejectedValueOnce(new ContactError('Failed to create contact', 500))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(
      body({ contact_id: undefined, new_contact: { name: 'Luis Gómez', phone: '+573001234567' } }),
    )
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('Luis')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })
})

describe('reglas de agenda', () => {
  it('hora pasada → 400 y no se escribe nada (ni contacto nuevo)', async () => {
    const db = boot()
    const res = await post(
      body({
        starts_at: '2026-11-04T15:00:00.000Z',
        contact_id: undefined,
        new_contact: { name: 'Luis Gómez', phone: '+573001234567' },
      }),
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('past')
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('un profesional que no atiende el servicio → 400', async () => {
    boot()
    const res = await post(body({ staff_id: STAFF_NO_SERVICE }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('staff_not_for_service')
  })

  it('fuera de horario → 409 outside_hours, con el texto para preguntar "¿Agendar igual?"', async () => {
    const db = boot()
    const res = await post(body({ starts_at: MON_20 }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('outside_hours')
    expect(String(res.body.error)).toMatch(/horario/)
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('fuera de horario con outside_hours_ok pasa', async () => {
    const db = boot()
    const res = await post(body({ starts_at: MON_20, outside_hours_ok: true }))
    expect(res.status).toBe(201)
    expect(rows(db, 'booking_appointments')[0].starts_at).toBe(MON_20)
  })

  it('un bloqueo del profesional también cuenta como fuera de horario', async () => {
    const db = boot({
      extra: {
        booking_time_off: [
          {
            account_id: TEST_ACCOUNT,
            staff_id: STAFF,
            starts_at: '2026-11-09T14:00:00.000Z',
            ends_at: '2026-11-09T16:00:00.000Z',
          },
        ],
      },
    })
    const blocked = await post(body())
    expect(blocked.status).toBe(409)
    expect(blocked.body.code).toBe('outside_hours')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
    expect((await post(body({ outside_hours_ok: true }))).status).toBe(201)
  })

  it('el bloqueo de otro profesional no estorba', async () => {
    boot({
      extra: {
        booking_time_off: [
          {
            account_id: TEST_ACCOUNT,
            staff_id: STAFF_NO_SERVICE,
            starts_at: '2026-11-09T14:00:00.000Z',
            ends_at: '2026-11-09T16:00:00.000Z',
          },
        ],
      },
    })
    expect((await post(body())).status).toBe(201)
  })

  it('choque con otra cita del profesional (23P01) → 409 slot_taken y no avisa', async () => {
    const db = boot()
    db._failNext('insert', 'booking_appointments', {
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint "booking_appointments_no_overlap"',
    })
    const res = await post(body())

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('slot_taken')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
    expect(h.notifyCalls).toHaveLength(0)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('otro error de la base → 500 genérico', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('insert', 'booking_appointments', { code: '23514', message: 'check violation' })
    const res = await post(body())
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('un horario que no se pudo leer no se confunde con "sin horario": falla cerrado', async () => {
    const db = boot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    db._failNext('select', 'booking_time_off', { message: 'caído' })
    const res = await post(body())
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  it('una cuenta sin clínica no mira sillones aunque haya sede con tope', async () => {
    boot({
      modules: ['agenda'],
      extra: {
        clinic_locations: [
          {
            id: LOCATION,
            account_id: TEST_ACCOUNT,
            name: 'Sede',
            is_active: true,
            chair_count: 1,
            created_at: '2026-10-01T00:00:00.000Z',
          },
        ],
        booking_appointments: [activeAppointment({ staff_id: STAFF_NO_SERVICE })],
      },
    })
    expect((await post(body())).status).toBe(201)
  })
})

describe('clínica', () => {
  const clinic = (options: PanelSeedOptions = {}) =>
    boot({ modules: ['agenda', 'clinica'], ...options })

  it('sillones llenos → 409 chairs_full, aunque el profesional esté libre', async () => {
    const db = clinic({
      chairCount: 1,
      extra: { booking_appointments: [activeAppointment({ staff_id: STAFF_NO_SERVICE })] },
    })
    const res = await post(body())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('chairs_full')
    expect(String(res.body.error)).toMatch(/sillones/)
    expect(rows(db, 'booking_appointments')).toHaveLength(1)
    expect(h.afterCallbacks).toHaveLength(0)
  })

  it('una cita cancelada no ocupa sillón', async () => {
    clinic({
      chairCount: 1,
      extra: {
        booking_appointments: [activeAppointment({ staff_id: STAFF_NO_SERVICE, status: 'cancelled' })],
      },
    })
    expect((await post(body())).status).toBe(201)
  })

  it('con un sillón libre guarda la cita con el paciente y la sede', async () => {
    const db = clinic({ chairCount: 2 })
    const res = await post(body({ new_patient_name: 'Luis Gómez' }))
    expect(res.status).toBe(201)
    const [patient] = rows(db, 'clinic_patients')
    expect(patient).toMatchObject({
      account_id: TEST_ACCOUNT,
      contact_id: CONTACT,
      full_name: 'Luis Gómez',
    })
    expect(rows(db, 'booking_appointments')[0]).toMatchObject({
      patient_id: patient.id,
      location_id: LOCATION,
    })
  })

  it('un paciente existente del contacto se usa tal cual', async () => {
    const db = clinic({
      extra: {
        clinic_patients: [
          { id: PATIENT, account_id: TEST_ACCOUNT, contact_id: CONTACT, full_name: 'Ana Pérez' },
        ],
      },
    })
    const res = await post(body({ patient_id: PATIENT }))
    expect(res.status).toBe(201)
    expect(rows(db, 'booking_appointments')[0].patient_id).toBe(PATIENT)
    expect(rows(db, 'clinic_patients')).toHaveLength(1)
  })

  it('un paciente de otro contacto → 404 y no se escribe nada', async () => {
    const db = clinic({
      extra: {
        clinic_patients: [
          { id: OTHER_PATIENT, account_id: TEST_ACCOUNT, contact_id: 'otro', full_name: 'Otro Paciente' },
        ],
      },
    })
    const res = await post(body({ patient_id: OTHER_PATIENT }))
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('patient_not_found')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  it('un contacto sin pacientes y sin nombre de paciente: se crea uno con el nombre del contacto', async () => {
    const db = clinic()
    const res = await post(body())
    expect(res.status).toBe(201)
    expect(rows(db, 'clinic_patients')).toEqual([
      expect.objectContaining({ contact_id: CONTACT, full_name: 'Ana Pérez' }),
    ])
    expect(rows(db, 'booking_appointments')[0].patient_id).toBe(rows(db, 'clinic_patients')[0].id)
  })

  it('un contacto sin nombre real (solo teléfono) pide el nombre del paciente', async () => {
    const db = clinic({
      extra: {
        contacts: [{ id: CONTACT, account_id: TEST_ACCOUNT, name: '573001112233', phone: '573001112233' }],
      },
    })
    const res = await post(body())
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('patient_required')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  it('un contacto que ya tiene pacientes debe elegir uno', async () => {
    const db = clinic({
      extra: {
        clinic_patients: [
          { id: PATIENT, account_id: TEST_ACCOUNT, contact_id: CONTACT, full_name: 'Ana Pérez' },
        ],
      },
    })
    const res = await post(body())
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('patient_required')
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  describe('el paciente se decide antes de escribir (sin contacto ni conversación sueltos)', () => {
    const newContact = { name: 'Luis Gómez', phone: '+573001234567' }
    const newContactBody = (extra: Record<string, unknown> = {}) =>
      body({ contact_id: undefined, new_contact: newContact, ...extra })

    it('contacto existente con pacientes y sin elegir → patient_required, nada escrito', async () => {
      const db = clinic({
        extra: {
          conversations: [],
          clinic_patients: [
            { id: PATIENT, account_id: TEST_ACCOUNT, contact_id: CONTACT, full_name: 'Ana Pérez' },
          ],
        },
      })
      const before = snapshot(db)
      const res = await post(body())
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('patient_required')
      expect(db._tables).toEqual(before)
      expect(rows(db, 'conversations')).toHaveLength(0)
    })

    it('contacto existente sin conversación y paciente de otro contacto → patient_not_found, nada escrito', async () => {
      const db = clinic({
        extra: {
          conversations: [],
          clinic_patients: [
            { id: OTHER_PATIENT, account_id: TEST_ACCOUNT, contact_id: 'otro', full_name: 'Otro Paciente' },
          ],
        },
      })
      const before = snapshot(db)
      const res = await post(body({ patient_id: OTHER_PATIENT }))
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('patient_not_found')
      expect(db._tables).toEqual(before)
    })

    it('contacto nuevo con un patient_id → patient_not_found y no se crea el contacto ni la conversación', async () => {
      const db = clinic({ extra: { conversations: [] } })
      const before = snapshot(db)
      const res = await post(newContactBody({ patient_id: PATIENT }))
      expect(res.status).toBe(404)
      expect(res.body.code).toBe('patient_not_found')
      expect(h.findOrCreateContact).not.toHaveBeenCalled()
      expect(db._tables).toEqual(before)
    })

    it('contacto nuevo cuyo nombre no sirve de paciente y sin nombre de paciente → patient_required, nada escrito', async () => {
      const db = clinic({ extra: { conversations: [] } })
      const before = snapshot(db)
      const res = await post(
        body({ contact_id: undefined, new_contact: { name: '12345', phone: '+573001234567' } }),
      )
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('patient_required')
      expect(h.findOrCreateContact).not.toHaveBeenCalled()
      expect(db._tables).toEqual(before)
    })

    it('contacto nuevo sin nombre de paciente: se crea con el nombre del contacto', async () => {
      const db = clinic()
      const res = await post(newContactBody())
      expect(res.status).toBe(201)
      expect(rows(db, 'clinic_patients')).toEqual([
        expect.objectContaining({ contact_id: NEW_CONTACT, full_name: 'Luis Gómez' }),
      ])
      expect(rows(db, 'booking_appointments')[0]).toMatchObject({
        contact_id: NEW_CONTACT,
        patient_id: rows(db, 'clinic_patients')[0].id,
      })
    })

    it('contacto nuevo con nombre de paciente propio: se crea ese paciente', async () => {
      const db = clinic()
      const res = await post(newContactBody({ new_patient_name: 'Sofía Gómez' }))
      expect(res.status).toBe(201)
      expect(rows(db, 'clinic_patients')).toEqual([
        expect.objectContaining({ contact_id: NEW_CONTACT, full_name: 'Sofía Gómez' }),
      ])
    })

    it('un "contacto nuevo" cuyo teléfono ya existe se decide con los pacientes de ese contacto', async () => {
      h.findExistingContact.mockResolvedValue({ id: CONTACT, phone: '573001112233', name: 'Ana Pérez' })
      const db = clinic({
        extra: {
          conversations: [],
          clinic_patients: [
            { id: PATIENT, account_id: TEST_ACCOUNT, contact_id: CONTACT, full_name: 'Ana Pérez' },
          ],
        },
      })
      h.findOrCreateContact.mockImplementation(async () => ({ id: CONTACT, created: false }))

      // Sin elegir paciente: ya tiene pacientes → hay que elegir, y no se escribe nada.
      const before = snapshot(db)
      const required = await post(newContactBody())
      expect(required.status).toBe(400)
      expect(required.body.code).toBe('patient_required')
      expect(h.findOrCreateContact).not.toHaveBeenCalled()
      expect(db._tables).toEqual(before)

      // Eligiendo uno de ese contacto: pasa.
      const ok = await post(newContactBody({ patient_id: PATIENT }))
      expect(ok.status).toBe(201)
      expect(rows(db, 'booking_appointments')[0]).toMatchObject({ contact_id: CONTACT, patient_id: PATIENT })
    })
  })

  it('una clínica sin configurar no agenda a ciegas', async () => {
    const db = clinic({ extra: { clinic_settings: [] } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(body())
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(rows(db, 'booking_appointments')).toHaveLength(0)
  })

  describe('autorización de recepción', () => {
    it('sin declaración de recepción NO inserta consentimiento', async () => {
      const db = clinic({ receptionDeclared: false })
      const res = await post(body())
      expect(res.status).toBe(201)
      expect(rows(db, 'clinic_consents')).toHaveLength(0)
    })

    it('con declaración inserta la autorización de origen recepción con el texto vigente', async () => {
      const db = clinic({ receptionDeclared: true })
      const res = await post(body())
      expect(res.status).toBe(201)
      expect(rows(db, 'clinic_consents')).toEqual([
        expect.objectContaining({
          account_id: TEST_ACCOUNT,
          contact_id: CONTACT,
          contact_ref: '573001112233',
          kind: 'datos_sensibles',
          granted: true,
          source: 'recepcion',
          text_version: 2,
          text_snapshot: CONSENT_TEXT,
          created_at: NOW.toISOString(),
        }),
      ])
    })

    it('si el contacto ya decidió (aunque dijera que no) no se le vuelve a autorizar', async () => {
      const db = clinic({
        receptionDeclared: true,
        extra: {
          clinic_consents: [
            {
              id: 'c-1',
              account_id: TEST_ACCOUNT,
              contact_id: CONTACT,
              kind: 'datos_sensibles',
              granted: false,
              created_at: '2026-10-20T00:00:00.000Z',
            },
          ],
        },
      })
      expect((await post(body())).status).toBe(201)
      expect(rows(db, 'clinic_consents')).toHaveLength(1)
    })

    it('si la cita no se pudo guardar, tampoco queda autorización', async () => {
      const db = clinic({ receptionDeclared: true })
      db._failNext('insert', 'booking_appointments', { code: '23P01', message: 'choque' })
      expect((await post(body())).status).toBe(409)
      expect(rows(db, 'clinic_consents')).toHaveLength(0)
    })

    it('si guardar la autorización falla, la cita igual queda guardada', async () => {
      const db = clinic({ receptionDeclared: true })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      db._failNext('insert', 'clinic_consents', { message: 'sin permiso' })
      const res = await post(body())
      expect(res.status).toBe(201)
      expect(rows(db, 'booking_appointments')).toHaveLength(1)
      expect(rows(db, 'clinic_consents')).toHaveLength(0)
      // El log no lleva el nombre ni el teléfono del paciente.
      const logged = JSON.stringify(spy.mock.calls)
      expect(logged).not.toContain('Ana')
      expect(logged).not.toContain('573001112233')
      spy.mockRestore()
    })
  })
})
