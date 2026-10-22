import { describe, expect, it } from 'vitest'

import { ConfigError } from './config'
import {
  createService,
  createStaff,
  createTimeOff,
  deleteTimeOff,
  listServiceIds,
  listStaffIds,
  reorderServices,
  reorderStaff,
  replaceWorkingHours,
  saveSettings,
  setStaffServices,
  updateAccountCurrency,
  updateService,
  updateStaff,
} from './config-repo'
import { listEligibleStaff, listServices } from './agent/db'
import { asClient, makeFakeDb, type FakeDb, type Row } from './agent/testing/fake-db'

// ============================================================
// Repositorio de configuración — fake de PostgREST.
//
// Cubre el contrato de datos: crear/editar/desactivar, aislamiento
// por cuenta (un id ajeno no se lee ni se escribe), nombres
// duplicados, actualización por DIFF (relación y horarios) e
// idempotencia de los ajustes.
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER = 'acc-2'
const USER = 'u-1'

function baseSeed(): Record<string, Row[]> {
  return {
    accounts: [
      {
        id: ACCOUNT,
        name: 'Barbería El Parche',
        default_currency: 'COP',
        owner_user_id: USER,
      },
      {
        id: OTHER,
        name: 'Otra Barbería',
        default_currency: 'USD',
        owner_user_id: 'u-2',
      },
    ],
    booking_services: [
      {
        id: 'svc-1',
        account_id: ACCOUNT,
        name: 'Corte clásico',
        description: null,
        duration_minutes: 30,
        price: 25000,
        is_active: true,
        position: 0,
      },
      {
        id: 'svc-2',
        account_id: ACCOUNT,
        name: 'Barba',
        description: null,
        duration_minutes: 20,
        price: 12000,
        is_active: true,
        position: 1,
      },
      {
        id: 'svc-other',
        account_id: OTHER,
        name: 'Corte clásico',
        description: null,
        duration_minutes: 30,
        price: 100,
        is_active: true,
        position: 0,
      },
    ],
    booking_staff: [
      {
        id: 'st-1',
        account_id: ACCOUNT,
        name: 'Andrés',
        bio: null,
        is_active: true,
        position: 0,
      },
      {
        id: 'st-other',
        account_id: OTHER,
        name: 'Ajeno',
        bio: null,
        is_active: true,
        position: 0,
      },
    ],
    booking_staff_services: [
      { account_id: ACCOUNT, staff_id: 'st-1', service_id: 'svc-1' },
    ],
    booking_working_hours: [
      {
        id: 'wh-1',
        account_id: ACCOUNT,
        staff_id: 'st-1',
        weekday: 1,
        start_time: '09:00:00',
        end_time: '12:00:00',
      },
    ],
    booking_time_off: [
      {
        id: 'to-1',
        account_id: ACCOUNT,
        staff_id: 'st-1',
        starts_at: '2026-11-02T13:00:00.000Z',
        ends_at: '2026-11-03T22:00:00.000Z',
        reason: 'Vacaciones',
      },
      {
        id: 'to-other',
        account_id: OTHER,
        staff_id: 'st-other',
        starts_at: '2026-11-02T13:00:00.000Z',
        ends_at: '2026-11-03T22:00:00.000Z',
        reason: null,
      },
    ],
    booking_settings: [],
  }
}

const rowsOf = (db: FakeDb, table: string): Row[] => db._tables[table]
const findRow = (db: FakeDb, table: string, id: string): Row | undefined =>
  rowsOf(db, table).find((row) => row.id === id)

describe('createService', () => {
  it('crea el servicio al final del orden, activo y con autor', async () => {
    const db = makeFakeDb(baseSeed())
    const service = await createService(asClient(db), ACCOUNT, USER, {
      name: 'Cejas',
      description: null,
      durationMinutes: 15,
      price: 8000,
      isActive: true,
    })

    expect(service.name).toBe('Cejas')
    expect(service.position).toBe(2)
    expect(service.isActive).toBe(true)

    const row = findRow(db, 'booking_services', service.id)
    expect(row?.account_id).toBe(ACCOUNT)
    expect(row?.created_by).toBe(USER)
    expect(rowsOf(db, 'booking_services')).toHaveLength(4)
  })

  it('rechaza un nombre repetido en la cuenta (case-insensitive) y no duplica', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      createService(asClient(db), ACCOUNT, USER, {
        name: 'corte CLÁSICO',
        description: null,
        durationMinutes: 30,
        price: 25000,
        isActive: true,
      }),
    ).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'duplicate_name',
    })
    expect(rowsOf(db, 'booking_services')).toHaveLength(3)
  })

  it('el mismo nombre en OTRA cuenta no es conflicto', async () => {
    const db = makeFakeDb(baseSeed())
    const service = await createService(asClient(db), OTHER, 'u-2', {
      name: 'Barba', // existe en ACCOUNT, no en OTHER
      description: null,
      durationMinutes: 20,
      price: 100,
      isActive: true,
    })
    expect(service.id).not.toBe('svc-other')
    expect(rowsOf(db, 'booking_services')).toHaveLength(4)
  })
})

describe('updateService', () => {
  it('edita precio y desactiva sin borrar (historial intacto)', async () => {
    const db = makeFakeDb(baseSeed())
    const updated = await updateService(asClient(db), ACCOUNT, 'svc-1', {
      price: 30000,
      isActive: false,
    })
    expect(updated.price).toBe(30000)
    expect(updated.isActive).toBe(false)
    expect(findRow(db, 'booking_services', 'svc-1')).toBeDefined()
  })

  it('un servicio desactivado desaparece del menú del bot', async () => {
    const db = makeFakeDb(baseSeed())
    await updateService(asClient(db), ACCOUNT, 'svc-1', { isActive: false })
    const services = await listServices(asClient(db), ACCOUNT)
    expect(services.map((s) => s.id)).toEqual(['svc-2'])
  })

  it('un id de otra cuenta se comporta como inexistente', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      updateService(asClient(db), ACCOUNT, 'svc-other', { price: 1 }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(findRow(db, 'booking_services', 'svc-other')?.price).toBe(100)
  })

  it('renombrar a un nombre existente es conflicto; a su propio nombre no', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      updateService(asClient(db), ACCOUNT, 'svc-1', { name: 'Barba' }),
    ).rejects.toMatchObject({ code: 'duplicate_name' })

    const same = await updateService(asClient(db), ACCOUNT, 'svc-1', {
      name: 'Corte clásico',
    })
    expect(same.name).toBe('Corte clásico')
  })

  it('cambiar la duración no toca citas ya guardadas', async () => {
    // La cita guarda starts_at/ends_at propios: la nueva duración solo
    // afecta el cálculo de disponibilidad futuro (computeDaySlots).
    const db = makeFakeDb({
      ...baseSeed(),
      booking_appointments: [
        {
          id: 'ap-1',
          account_id: ACCOUNT,
          service_id: 'svc-1',
          staff_id: 'st-1',
          starts_at: '2026-10-20T14:00:00.000Z',
          ends_at: '2026-10-20T14:30:00.000Z',
          status: 'confirmed',
        },
      ],
    })
    await updateService(asClient(db), ACCOUNT, 'svc-1', {
      durationMinutes: 60,
    })
    const appointment = findRow(db, 'booking_appointments', 'ap-1')
    expect(appointment?.starts_at).toBe('2026-10-20T14:00:00.000Z')
    expect(appointment?.ends_at).toBe('2026-10-20T14:30:00.000Z')
  })
})

describe('reorderServices', () => {
  it('renumera por la permutación y no toca filas ajenas', async () => {
    const db = makeFakeDb(baseSeed())
    await reorderServices(asClient(db), ACCOUNT, ['svc-2', 'svc-1'])
    expect(findRow(db, 'booking_services', 'svc-2')?.position).toBe(0)
    expect(findRow(db, 'booking_services', 'svc-1')?.position).toBe(1)

    await reorderServices(asClient(db), ACCOUNT, ['svc-other'])
    expect(findRow(db, 'booking_services', 'svc-other')?.position).toBe(0)
  })

  it('listServiceIds devuelve los ids en orden de presentación', async () => {
    const db = makeFakeDb(baseSeed())
    await reorderServices(asClient(db), ACCOUNT, ['svc-2', 'svc-1'])
    expect(await listServiceIds(asClient(db), ACCOUNT)).toEqual([
      'svc-2',
      'svc-1',
    ])
  })
})

describe('staff', () => {
  it('crea, edita y desactiva barberos con aislamiento por cuenta', async () => {
    const db = makeFakeDb(baseSeed())
    const staff = await createStaff(asClient(db), ACCOUNT, USER, {
      name: 'Camilo',
      bio: 'Fades',
    })
    expect(staff.position).toBe(1)
    expect(staff.isActive).toBe(true)
    expect(await listStaffIds(asClient(db), ACCOUNT)).toEqual([
      'st-1',
      staff.id,
    ])

    const updated = await updateStaff(asClient(db), ACCOUNT, staff.id, {
      isActive: false,
      bio: null,
    })
    expect(updated.isActive).toBe(false)
    expect(updated.bio).toBeNull()

    await expect(
      updateStaff(asClient(db), ACCOUNT, 'st-other', { isActive: false }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(findRow(db, 'booking_staff', 'st-other')?.is_active).toBe(true)
  })

  it('un barbero desactivado deja de ser elegible para el bot', async () => {
    const db = makeFakeDb(baseSeed())
    expect(
      (await listEligibleStaff(asClient(db), ACCOUNT, 'svc-1')).map((s) => s.id),
    ).toEqual(['st-1'])

    await updateStaff(asClient(db), ACCOUNT, 'st-1', { isActive: false })
    expect(await listEligibleStaff(asClient(db), ACCOUNT, 'svc-1')).toEqual([])
  })

  it('rechaza nombres de barbero repetidos', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      createStaff(asClient(db), ACCOUNT, USER, { name: '  andrés ', bio: null }),
    ).rejects.toMatchObject({ code: 'duplicate_name' })
  })

  it('reorderStaff renumera y filtra por cuenta', async () => {
    const db = makeFakeDb(baseSeed())
    const staff = await createStaff(asClient(db), ACCOUNT, USER, {
      name: 'Camilo',
      bio: null,
    })
    await reorderStaff(asClient(db), ACCOUNT, [staff.id, 'st-1'])
    expect(findRow(db, 'booking_staff', staff.id)?.position).toBe(0)
    expect(findRow(db, 'booking_staff', 'st-1')?.position).toBe(1)

    await reorderStaff(asClient(db), ACCOUNT, ['st-other'])
    expect(findRow(db, 'booking_staff', 'st-other')?.position).toBe(0)
  })
})

describe('setStaffServices', () => {
  it('agrega y quita por diff, y repetir la llamada no cambia nada', async () => {
    const db = makeFakeDb(baseSeed())
    const count = await setStaffServices(asClient(db), ACCOUNT, 'st-1', [
      'svc-1',
      'svc-2',
    ])
    expect(count).toBe(2)
    expect(
      rowsOf(db, 'booking_staff_services').filter((r) => r.staff_id === 'st-1'),
    ).toHaveLength(2)

    // Idempotente: mismo set otra vez, mismas filas.
    await setStaffServices(asClient(db), ACCOUNT, 'st-1', ['svc-1', 'svc-2'])
    expect(
      rowsOf(db, 'booking_staff_services').filter((r) => r.staff_id === 'st-1'),
    ).toHaveLength(2)

    await setStaffServices(asClient(db), ACCOUNT, 'st-1', ['svc-2'])
    const kept = rowsOf(db, 'booking_staff_services').filter(
      (r) => r.staff_id === 'st-1',
    )
    expect(kept.map((r) => r.service_id)).toEqual(['svc-2'])

    await setStaffServices(asClient(db), ACCOUNT, 'st-1', [])
    expect(
      rowsOf(db, 'booking_staff_services').filter((r) => r.staff_id === 'st-1'),
    ).toHaveLength(0)
  })

  it('rechaza servicios inexistentes o de otra cuenta', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      setStaffServices(asClient(db), ACCOUNT, 'st-1', ['nope']),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      setStaffServices(asClient(db), ACCOUNT, 'st-1', ['svc-other']),
    ).rejects.toMatchObject({ code: 'not_found' })
    // La relación original queda intacta tras los errores.
    expect(
      rowsOf(db, 'booking_staff_services').filter((r) => r.staff_id === 'st-1'),
    ).toHaveLength(1)
  })

  it('rechaza un barbero de otra cuenta', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      setStaffServices(asClient(db), ACCOUNT, 'st-other', ['svc-1']),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('replaceWorkingHours', () => {
  it('mantiene los bloques idénticos (HH:MM:SS vs HH:MM) y agrega los nuevos', async () => {
    const db = makeFakeDb(baseSeed())
    const count = await replaceWorkingHours(asClient(db), ACCOUNT, 'st-1', [
      { weekday: 1, startTime: '09:00', endTime: '12:00' },
      { weekday: 1, startTime: '13:00', endTime: '18:00' },
    ])
    expect(count).toBe(2)

    const rows = rowsOf(db, 'booking_working_hours').filter(
      (r) => r.staff_id === 'st-1',
    )
    expect(rows).toHaveLength(2)
    // El bloque original no se reescribió: conserva su id.
    expect(rows.find((r) => r.weekday === 1 && r.start_time === '09:00:00')?.id).toBe(
      'wh-1',
    )
  })

  it('borra los bloques que ya no están y permite vaciar el horario', async () => {
    const db = makeFakeDb(baseSeed())
    await replaceWorkingHours(asClient(db), ACCOUNT, 'st-1', [
      { weekday: 2, startTime: '10:00', endTime: '16:00' },
    ])
    expect(findRow(db, 'booking_working_hours', 'wh-1')).toBeUndefined()

    await replaceWorkingHours(asClient(db), ACCOUNT, 'st-1', [])
    expect(
      rowsOf(db, 'booking_working_hours').filter((r) => r.staff_id === 'st-1'),
    ).toHaveLength(0)
  })

  it('rechaza un barbero de otra cuenta sin tocar su horario', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      replaceWorkingHours(asClient(db), ACCOUNT, 'st-other', []),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('si el insert falla, lanza y conserva el horario anterior', async () => {
    const db = makeFakeDb(baseSeed())
    db._failNext('insert', 'booking_working_hours', { message: 'insert failed' })

    await expect(
      replaceWorkingHours(asClient(db), ACCOUNT, 'st-1', [
        { weekday: 2, startTime: '10:00', endTime: '16:00' },
      ]),
    ).rejects.toThrow('No se pudo guardar el horario')
    expect(findRow(db, 'booking_working_hours', 'wh-1')).toBeDefined()
  })

  it('si borrar los bloques viejos falla, lanza (no reporta guardado)', async () => {
    const db = makeFakeDb(baseSeed())
    db._failNext('delete', 'booking_working_hours', { message: 'delete failed' })

    await expect(
      replaceWorkingHours(asClient(db), ACCOUNT, 'st-1', [
        { weekday: 2, startTime: '10:00', endTime: '16:00' },
      ]),
    ).rejects.toThrow('No se pudo quitar los bloques viejos')
  })
})

describe('escrituras fallidas de configuración', () => {
  it('setStaffServices lanza si el insert o el delete fallan', async () => {
    const db = makeFakeDb(baseSeed())
    db._failNext('insert', 'booking_staff_services', { message: 'x' })
    await expect(
      setStaffServices(asClient(db), ACCOUNT, 'st-1', ['svc-1', 'svc-2']),
    ).rejects.toThrow('No se pudo asignar los servicios')

    db._failNext('delete', 'booking_staff_services', { message: 'x' })
    await expect(
      setStaffServices(asClient(db), ACCOUNT, 'st-1', []),
    ).rejects.toThrow('No se pudo quitar servicios')
  })

  it('reorderServices y reorderStaff lanzan si el update falla', async () => {
    const db = makeFakeDb(baseSeed())
    db._failNext('update', 'booking_services', { message: 'x' })
    await expect(
      reorderServices(asClient(db), ACCOUNT, ['svc-2', 'svc-1']),
    ).rejects.toThrow('No se pudo reordenar los servicios')

    db._failNext('update', 'booking_staff', { message: 'x' })
    await expect(
      reorderStaff(asClient(db), ACCOUNT, ['st-1']),
    ).rejects.toThrow('No se pudo reordenar los barberos')
  })
})

describe('time off', () => {
  it('crea un bloqueo para un barbero de la cuenta', async () => {
    const db = makeFakeDb(baseSeed())
    const block = await createTimeOff(asClient(db), ACCOUNT, USER, {
      staffId: 'st-1',
      startsAtIso: '2026-12-24T13:00:00.000Z',
      endsAtIso: '2026-12-26T22:00:00.000Z',
      reason: 'Navidad',
    })
    expect(block.reason).toBe('Navidad')
    expect(findRow(db, 'booking_time_off', block.id)?.account_id).toBe(ACCOUNT)
  })

  it('rechaza barberos de otra cuenta', async () => {
    const db = makeFakeDb(baseSeed())
    await expect(
      createTimeOff(asClient(db), ACCOUNT, USER, {
        staffId: 'st-other',
        startsAtIso: '2026-12-24T13:00:00.000Z',
        endsAtIso: '2026-12-26T22:00:00.000Z',
        reason: null,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('borra solo el bloqueo propio; uno ajeno es inexistente', async () => {
    const db = makeFakeDb(baseSeed())
    await deleteTimeOff(asClient(db), ACCOUNT, 'to-1')
    expect(findRow(db, 'booking_time_off', 'to-1')).toBeUndefined()

    await expect(
      deleteTimeOff(asClient(db), ACCOUNT, 'to-other'),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(findRow(db, 'booking_time_off', 'to-other')).toBeDefined()

    await expect(
      deleteTimeOff(asClient(db), ACCOUNT, 'to-1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('saveSettings', () => {
  it('crea la fila con defaults y actualiza por partes sin pisar el resto', async () => {
    const db = makeFakeDb(baseSeed())

    const created = await saveSettings(asClient(db), ACCOUNT, {
      address: 'Cra. 7 # 45-12',
    })
    expect(created).toEqual({
      address: 'Cra. 7 # 45-12',
      reminders2hEnabled: false,
      botTexts: {},
    })

    const toggled = await saveSettings(asClient(db), ACCOUNT, {
      reminders2hEnabled: true,
    })
    expect(toggled.address).toBe('Cra. 7 # 45-12')
    expect(toggled.reminders2hEnabled).toBe(true)

    const texts = await saveSettings(asClient(db), ACCOUNT, {
      botTexts: { welcome: '¡Hola de Don Pedro! 💈' },
    })
    expect(texts.address).toBe('Cra. 7 # 45-12')
    expect(texts.reminders2hEnabled).toBe(true)
    expect(texts.botTexts).toEqual({ welcome: '¡Hola de Don Pedro! 💈' })

    expect(rowsOf(db, 'booking_settings')).toHaveLength(1)
  })

  it('es idempotente: guardar dos veces lo mismo deja el mismo estado', async () => {
    const db = makeFakeDb(baseSeed())
    await saveSettings(asClient(db), ACCOUNT, {
      address: 'Calle 1',
      botTexts: { retry: 'No entendí, elige una opción 🙂' },
    })
    const first = JSON.stringify(db._tables.booking_settings)

    await saveSettings(asClient(db), ACCOUNT, {
      address: 'Calle 1',
      botTexts: { retry: 'No entendí, elige una opción 🙂' },
    })
    expect(JSON.stringify(db._tables.booking_settings)).toBe(first)
  })

  it('reemplaza los textos por completo (quitar un override = volver al default)', async () => {
    const db = makeFakeDb(baseSeed())
    await saveSettings(asClient(db), ACCOUNT, {
      botTexts: { welcome: 'Hola', retry: '¿Otra vez?' },
    })
    const replaced = await saveSettings(asClient(db), ACCOUNT, {
      botTexts: { welcome: 'Hola' },
    })
    expect(replaced.botTexts).toEqual({ welcome: 'Hola' })
  })
})

describe('updateAccountCurrency', () => {
  it('cambia la moneda de la cuenta y solo la suya', async () => {
    const db = makeFakeDb(baseSeed())
    const code = await updateAccountCurrency(asClient(db), ACCOUNT, 'USD')
    expect(code).toBe('USD')
    expect(
      db._tables.accounts.find((a) => a.id === ACCOUNT)?.default_currency,
    ).toBe('USD')
    expect(
      db._tables.accounts.find((a) => a.id === OTHER)?.default_currency,
    ).toBe('USD')
  })
})

describe('ConfigError', () => {
  it('el error de aislamiento lleva el mensaje en es-CO', async () => {
    const db = makeFakeDb(baseSeed())
    try {
      await updateService(asClient(db), ACCOUNT, 'svc-other', { price: 1 })
      throw new Error('debía lanzar')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).message).toBe('El servicio no existe.')
    }
  })
})
