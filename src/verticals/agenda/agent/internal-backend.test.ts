import { describe, expect, it } from 'vitest'

import type { ServiceInfo } from './db'
import { createInternalBackend } from './internal-backend'
import { asClient, makeFakeDb } from './testing/fake-db'

const ACCOUNT = 'acc-1'
const STAFF = 'st-1'
/** Lunes 19 de octubre de 2026, 08:00 en Bogotá. */
const NOW = new Date('2026-10-19T13:00:00Z')
const service: ServiceInfo = {
  id: 'svc-1',
  name: 'Limpieza',
  description: null,
  durationMinutes: 30,
  price: 0,
}

const seed = () =>
  makeFakeDb({
    booking_working_hours: [
      { account_id: ACCOUNT, staff_id: STAFF, weekday: 1, start_time: '09:00:00', end_time: '10:00:00' },
    ],
    booking_appointments: [],
    booking_time_off: [],
  })

const bookArgs = {
  id: 'ap-1',
  contactId: 'ct-1',
  conversationId: 'cv-1',
  serviceId: 'svc-1',
  staffId: STAFF,
  startsAtIso: '2026-10-19T14:00:00.000Z',
  endsAtIso: '2026-10-19T14:30:00.000Z',
  confirmedAtIso: NOW.toISOString(),
}

describe('InternalBackend', () => {
  it('devuelve las horas del día y descuenta las ocupadas', async () => {
    const db = seed()
    db._tables.booking_appointments.push({
      account_id: ACCOUNT,
      staff_id: STAFF,
      status: 'confirmed',
      starts_at: '2026-10-19T14:00:00.000Z',
      ends_at: '2026-10-19T14:30:00.000Z',
    })
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: NOW,
    })
    expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
  })

  it('getDaysWithSlots solo trae días con cupo', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    const keys = await backend.getDaysWithSlots({
      service,
      staffIds: [STAFF],
      fromKey: '2026-10-19',
      days: 8,
      now: NOW,
    })
    expect(keys).toEqual(['2026-10-19', '2026-10-26'])
  })

  it('getDaySlots no ofrece horas pasadas', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    // 08:45 en Bogotá: las 9:00 caen dentro del margen de 30 minutos.
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: new Date('2026-10-19T13:45:00Z'),
    })
    expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
  })

  it('getDaySlots con excludeAppointmentId no cuenta esa cita como ocupada (mover la propia cita)', async () => {
    const db = seed()
    db._tables.booking_appointments.push({
      id: 'ap-propia',
      account_id: ACCOUNT,
      staff_id: STAFF,
      status: 'confirmed',
      starts_at: '2026-10-19T14:00:00.000Z',
      ends_at: '2026-10-19T14:30:00.000Z',
    })
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const query = { service, staffIds: [STAFF], dateKey: '2026-10-19', now: NOW }

    const without = await backend.getDaySlots(query)
    const withExclude = await backend.getDaySlots({ ...query, excludeAppointmentId: 'ap-propia' })

    expect(without.map((s) => s.label)).toEqual(['9:30 a. m.'])
    expect(withExclude.map((s) => s.label)).toEqual(['9:00 a. m.', '9:30 a. m.'])
  })

  it('getDaySlots con excludeAppointmentId sigue contando las demás citas', async () => {
    const db = seed()
    db._tables.booking_appointments.push(
      {
        id: 'ap-propia',
        account_id: ACCOUNT,
        staff_id: STAFF,
        status: 'confirmed',
        starts_at: '2026-10-19T14:00:00.000Z',
        ends_at: '2026-10-19T14:30:00.000Z',
      },
      {
        id: 'ap-otra',
        account_id: ACCOUNT,
        staff_id: STAFF,
        status: 'confirmed',
        starts_at: '2026-10-19T14:30:00.000Z',
        ends_at: '2026-10-19T15:00:00.000Z',
      },
    )
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: NOW,
      excludeAppointmentId: 'ap-propia',
    })
    expect(slots.map((s) => s.label)).toEqual(['9:00 a. m.'])
  })

  it('getDaysWithSlots descuenta el último día del rango', async () => {
    const db = seed()
    // Lunes 26, 9:00 a 10:00 en Bogotá: tapa todo el bloque de ese día.
    db._tables.booking_appointments.push({
      account_id: ACCOUNT,
      staff_id: STAFF,
      status: 'confirmed',
      starts_at: '2026-10-26T14:00:00.000Z',
      ends_at: '2026-10-26T15:00:00.000Z',
    })
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const keys = await backend.getDaysWithSlots({
      service,
      staffIds: [STAFF],
      fromKey: '2026-10-19',
      days: 8,
      now: NOW,
    })
    expect(keys).toEqual(['2026-10-19'])
  })

  it('getDaySlots solo cuenta como libre a quien trabaja ese día', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    // 'st-2' no tiene bloques de trabajo: no puede aparecer como libre.
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF, 'st-2'],
      dateKey: '2026-10-19',
      now: NOW,
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots[0].staffIds).toEqual([STAFF])
  })

  it('book distingue un choque de otro error', async () => {
    const db = seed()
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })

    db._failNext('insert', 'booking_appointments', { code: '23P01', message: 'overlap' })
    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'slot_taken' })

    db._failNext('insert', 'booking_appointments', { code: 'XX000', message: 'caída' })
    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'failed', message: 'caída' })

    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'ok' })
    expect(db._tables.booking_appointments).toHaveLength(1)
  })

  it('book guarda el paciente y la sede solo si vienen', async () => {
    const db = seed()
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })

    await backend.book({ ...bookArgs, id: 'ap-1' })
    await backend.book({ ...bookArgs, id: 'ap-2', patientId: 'pat-1', locationId: 'loc-1' })

    const [plain, withPatient] = db._tables.booking_appointments
    expect('patient_id' in plain).toBe(false)
    expect('location_id' in plain).toBe(false)
    expect(withPatient).toMatchObject({ patient_id: 'pat-1', location_id: 'loc-1' })
  })

  describe('pacientes', () => {
    const patientRows = () => [
      { id: 'pat-2', account_id: ACCOUNT, contact_id: 'ct-1', full_name: 'Tomás Gil' },
      { id: 'pat-1', account_id: ACCOUNT, contact_id: 'ct-1', full_name: 'Marta Ruiz' },
      { id: 'pat-3', account_id: ACCOUNT, contact_id: 'ct-2', full_name: 'Ajeno Gil' },
      { id: 'pat-4', account_id: 'acc-2', contact_id: 'ct-1', full_name: 'Otra Cuenta' },
    ]

    it('findPatients trae solo los de ese contacto en la cuenta del backend', async () => {
      const db = makeFakeDb({ clinic_patients: patientRows() })
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
      expect(await backend.findPatients({ contactId: 'ct-1' })).toEqual([
        { id: 'pat-1', fullName: 'Marta Ruiz' },
        { id: 'pat-2', fullName: 'Tomás Gil' },
      ])
    })

    it('createPatient lo guarda en la cuenta del backend, no en otra', async () => {
      const db = makeFakeDb({ clinic_patients: [] })
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
      const created = await backend.createPatient({ contactId: 'ct-1', fullName: 'Lucía Gil Ruiz' })
      expect(created.fullName).toBe('Lucía Gil Ruiz')
      expect(db._tables.clinic_patients).toMatchObject([
        { id: created.id, account_id: ACCOUNT, contact_id: 'ct-1', full_name: 'Lucía Gil Ruiz' },
      ])
    })
  })

  describe('listUpcoming', () => {
    const appointment = (id: string, startsAt: string, extra: Record<string, unknown> = {}) => ({
      id,
      account_id: ACCOUNT,
      contact_id: 'ct-1',
      status: 'pending',
      patient_id: 'pat-1',
      starts_at: startsAt,
      ...extra,
    })

    const seedUpcoming = () =>
      makeFakeDb({
        clinic_patients: [
          { id: 'pat-1', account_id: ACCOUNT, contact_id: 'ct-1', full_name: 'Marta Ruiz' },
          { id: 'pat-2', account_id: ACCOUNT, contact_id: 'ct-1', full_name: 'Tomás Gil' },
        ],
        booking_appointments: [
          appointment('ap-late', '2026-10-22T14:00:00.000Z', { patient_id: 'pat-2' }),
          appointment('ap-soon', '2026-10-20T14:00:00.000Z', { status: 'confirmed' }),
          appointment('ap-no-patient', '2026-10-21T14:00:00.000Z', { patient_id: null }),
          appointment('ap-gone-patient', '2026-10-21T15:00:00.000Z', { patient_id: 'pat-borrado' }),
          appointment('ap-cancelled', '2026-10-20T15:00:00.000Z', { status: 'cancelled' }),
          appointment('ap-past', '2026-10-18T14:00:00.000Z'),
          appointment('ap-other-contact', '2026-10-20T16:00:00.000Z', { contact_id: 'ct-2' }),
          appointment('ap-other-account', '2026-10-20T17:00:00.000Z', { account_id: 'acc-2' }),
        ],
      })

    it('trae las citas activas y futuras de ese contacto, en orden, con su paciente', async () => {
      const backend = createInternalBackend({ db: asClient(seedUpcoming()), accountId: ACCOUNT })
      const upcoming = await backend.listUpcoming({ contactId: 'ct-1', nowIso: NOW.toISOString() })
      expect(upcoming).toEqual([
        { id: 'ap-soon', startsAt: new Date('2026-10-20T14:00:00.000Z'), patientName: 'Marta Ruiz' },
        { id: 'ap-no-patient', startsAt: new Date('2026-10-21T14:00:00.000Z'), patientName: null },
        { id: 'ap-gone-patient', startsAt: new Date('2026-10-21T15:00:00.000Z'), patientName: null },
        { id: 'ap-late', startsAt: new Date('2026-10-22T14:00:00.000Z'), patientName: 'Tomás Gil' },
      ])
    })

    it('una cita que empieza justo ahora ya no es próxima', async () => {
      const backend = createInternalBackend({ db: asClient(seedUpcoming()), accountId: ACCOUNT })
      const upcoming = await backend.listUpcoming({
        contactId: 'ct-1',
        nowIso: '2026-10-20T14:00:00.000Z',
      })
      expect(upcoming.map((a) => a.id)).not.toContain('ap-soon')
    })

    it('sin citas devuelve una lista vacía', async () => {
      const backend = createInternalBackend({ db: asClient(seedUpcoming()), accountId: ACCOUNT })
      expect(await backend.listUpcoming({ contactId: 'ct-9', nowIso: NOW.toISOString() })).toEqual([])
    })

    it('si no puede leer las citas, lanza: nunca contesta "no hay"', async () => {
      const db = seedUpcoming()
      db._failNext('select', 'booking_appointments', { message: 'se cayó la base' })
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
      await expect(
        backend.listUpcoming({ contactId: 'ct-1', nowIso: NOW.toISOString() }),
      ).rejects.toThrow('No se pudieron leer las citas')
    })

    it('si no puede leer los pacientes, lanza en vez de listar citas sin nombre', async () => {
      const db = seedUpcoming()
      db._failNext('select', 'clinic_patients', { message: 'se cayó la base' })
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
      await expect(
        backend.listUpcoming({ contactId: 'ct-1', nowIso: NOW.toISOString() }),
      ).rejects.toThrow('No se pudieron leer los pacientes')
    })
  })

  describe('cupo de sillones', () => {
    const OTHER = 'st-2'
    // 9:00 a. m. en Bogotá, lunes 19 de octubre: la única hora de 30 min que tapa la cita de abajo.
    const NINE = '2026-10-19T14:00:00.000Z'
    const NINE_THIRTY = '2026-10-19T14:30:00.000Z'

    /** Dos profesionales con el mismo horario (lunes 9:00 a 10:00) y una cita del otro a las 9:00. */
    const seedChairs = (chairCount: number | null) => {
      const db = makeFakeDb({
        booking_working_hours: [
          { account_id: ACCOUNT, staff_id: STAFF, weekday: 1, start_time: '09:00:00', end_time: '10:00:00' },
          { account_id: ACCOUNT, staff_id: OTHER, weekday: 1, start_time: '09:00:00', end_time: '10:00:00' },
        ],
        booking_appointments: [
          {
            account_id: ACCOUNT,
            staff_id: OTHER,
            status: 'confirmed',
            starts_at: NINE,
            ends_at: NINE_THIRTY,
          },
        ],
        booking_time_off: [],
        clinic_locations: [
          {
            id: 'loc-1',
            account_id: ACCOUNT,
            chair_count: chairCount,
            is_active: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      return db
    }

    const dayQuery = {
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: NOW,
    }

    it('con la bandera y el cupo lleno, no ofrece la hora aunque su profesional esté libre', async () => {
      const backend = createInternalBackend({
        db: asClient(seedChairs(1)),
        accountId: ACCOUNT,
        clinic: true,
      })
      const slots = await backend.getDaySlots(dayQuery)
      expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
    })

    it('con la bandera y una silla de sobra, ofrece la hora', async () => {
      const backend = createInternalBackend({
        db: asClient(seedChairs(2)),
        accountId: ACCOUNT,
        clinic: true,
      })
      const slots = await backend.getDaySlots(dayQuery)
      expect(slots.map((s) => s.label)).toEqual(['9:00 a. m.', '9:30 a. m.'])
    })

    it('con la bandera pero sin cupo puesto, no limita nada', async () => {
      const backend = createInternalBackend({
        db: asClient(seedChairs(null)),
        accountId: ACCOUNT,
        clinic: true,
      })
      const slots = await backend.getDaySlots(dayQuery)
      expect(slots.map((s) => s.label)).toEqual(['9:00 a. m.', '9:30 a. m.'])
    })

    it('con excludeAppointmentId, la propia cita tampoco ocupa silla', async () => {
      const db = seedChairs(1)
      db._tables.booking_appointments[0].id = 'ap-propia'
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT, clinic: true })
      const slots = await backend.getDaySlots({ ...dayQuery, excludeAppointmentId: 'ap-propia' })
      expect(slots.map((s) => s.label)).toEqual(['9:00 a. m.', '9:30 a. m.'])
    })

    it('una cita cancelada no ocupa silla', async () => {
      const db = seedChairs(1)
      db._tables.booking_appointments[0].status = 'cancelled'
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT, clinic: true })
      const slots = await backend.getDaySlots(dayQuery)
      expect(slots.map((s) => s.label)).toEqual(['9:00 a. m.', '9:30 a. m.'])
    })

    it('"Cualquiera": una hora sin silla no se ofrece con ningún profesional', async () => {
      const backend = createInternalBackend({
        db: asClient(seedChairs(1)),
        accountId: ACCOUNT,
        clinic: true,
      })
      const slots = await backend.getDaySlots({ ...dayQuery, staffIds: [STAFF, OTHER] })
      expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
      expect(slots[0].staffIds).toEqual([STAFF, OTHER])
    })

    it('getDaysWithSlots descarta el día cuya única hora se quedó sin silla', async () => {
      const db = seedChairs(1)
      // Cada lunes tiene una sola hora (9:00) y en los dos la silla está llena con la cita del otro profesional.
      db._tables.booking_working_hours = [
        { account_id: ACCOUNT, staff_id: STAFF, weekday: 1, start_time: '09:00:00', end_time: '09:30:00' },
        { account_id: ACCOUNT, staff_id: OTHER, weekday: 1, start_time: '09:00:00', end_time: '09:30:00' },
      ]
      db._tables.booking_appointments.push({
        account_id: ACCOUNT,
        staff_id: OTHER,
        status: 'pending',
        starts_at: '2026-10-26T14:00:00.000Z',
        ends_at: '2026-10-26T14:30:00.000Z',
      })
      const query = { service, staffIds: [STAFF], fromKey: '2026-10-19', days: 8, now: NOW }

      const plain = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
      expect(await plain.getDaysWithSlots(query)).toEqual(['2026-10-19', '2026-10-26'])

      const clinic = createInternalBackend({ db: asClient(db), accountId: ACCOUNT, clinic: true })
      expect(await clinic.getDaysWithSlots(query)).toEqual([])
    })

    it('carga el cupo una sola vez por rango, no una por día', async () => {
      const db = seedChairs(2)
      const reads: string[] = []
      const from = db.from
      db.from = (table: string) => {
        reads.push(table)
        return from(table)
      }
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT, clinic: true })
      await backend.getDaysWithSlots({ service, staffIds: [STAFF], fromKey: '2026-10-19', days: 8, now: NOW })
      expect(reads.filter((t) => t === 'clinic_locations')).toHaveLength(1)
      // Una lectura es la del profesional (listBusy) y otra la de toda la cuenta.
      expect(reads.filter((t) => t === 'booking_appointments')).toHaveLength(2)
    })

    it('sin la bandera no hace la lectura extra ni limita por sillas', async () => {
      const db = seedChairs(1)
      const reads: string[] = []
      const from = db.from
      db.from = (table: string) => {
        reads.push(table)
        return from(table)
      }
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
      const slots = await backend.getDaySlots(dayQuery)
      expect(slots.map((s) => s.label)).toEqual(['9:00 a. m.', '9:30 a. m.'])
      expect(reads).not.toContain('clinic_locations')
      expect(reads.filter((t) => t === 'booking_appointments')).toHaveLength(1)
    })

    it('con la bandera, si no puede leer el cupo, lanza en vez de ofrecer horas', async () => {
      const db = seedChairs(1)
      db._failNext('select', 'clinic_locations', { message: 'se cayó la base' })
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT, clinic: true })
      await expect(backend.getDaySlots(dayQuery)).rejects.toThrow('No se pudo leer el cupo de sillones')
    })

    it('confirm marca la asistencia del paciente', async () => {
      const db = seedChairs(1)
      db._tables.booking_appointments[0].id = 'ap-1'
      const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT, clinic: true })
      await backend.confirm({ id: 'ap-1', confirmedAtIso: NOW.toISOString() })
      expect(db._tables.booking_appointments[0]).toMatchObject({
        status: 'confirmed',
        confirmed_at: NOW.toISOString(),
        attendance_confirmed_at: NOW.toISOString(),
      })
    })
  })
})
