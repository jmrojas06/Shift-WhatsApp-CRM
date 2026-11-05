// ============================================================
// Datos de prueba compartidos por las rutas del panel que crean,
// mueven y cancelan citas. Un negocio con un profesional que atiende
// un servicio de 30 minutos, lunes a viernes de 9 a 18 (hora de
// Bogotá), y, si se pide, la clínica con 2 sillones.
//
// No importa `vitest`: se carga desde cualquier test.
// ============================================================

import { TEST_ACCOUNT } from '@/app/api/verticals/agenda/_lib/route-testing'

import { makeFakeDb, type FakeDb, type Row } from './fake-db'

export const OTHER_ACCOUNT = 'acc-2'

export const CONTACT = '11111111-1111-4111-8111-111111111111'
export const FOREIGN_CONTACT = '99999999-9999-4999-8999-999999999999'
export const NEW_CONTACT = '12121212-1212-4212-8212-121212121212'
export const CONVERSATION = '22222222-2222-4222-8222-222222222222'
export const SERVICE = '33333333-3333-4333-8333-333333333333'
export const INACTIVE_SERVICE = '33333333-3333-4333-8333-333333333334'
export const FOREIGN_SERVICE = '33333333-3333-4333-8333-333333333335'
export const STAFF = '44444444-4444-4444-8444-444444444444'
/** Activo pero sin atender el servicio. */
export const STAFF_NO_SERVICE = '44444444-4444-4444-8444-444444444445'
/** Atiende el servicio pero no trabaja los lunes. */
export const STAFF_B = '44444444-4444-4444-8444-444444444446'
export const FOREIGN_STAFF = '44444444-4444-4444-8444-444444444447'
export const PATIENT = '55555555-5555-4555-8555-555555555555'
export const OTHER_PATIENT = '55555555-5555-4555-8555-555555555556'
export const LOCATION = '66666666-6666-4666-8666-666666666666'
export const APPOINTMENT = '77777777-7777-4777-8777-777777777777'
export const OTHER_APPOINTMENT = '77777777-7777-4777-8777-777777777778'
export const FOREIGN_APPOINTMENT = '77777777-7777-4777-8777-777777777779'

/** Jueves 5 de noviembre de 2026, 10:00 en Bogotá. */
export const NOW = new Date('2026-11-05T15:00:00.000Z')
/** Lunes 9 de noviembre, 10:00 en Bogotá. */
export const MON_10 = '2026-11-09T15:00:00.000Z'
export const MON_11 = '2026-11-09T16:00:00.000Z'
/** Lunes 9 de noviembre, 20:00 en Bogotá: pasadas las 18:00 del horario. */
export const MON_20 = '2026-11-10T01:00:00.000Z'

export const CONSENT_TEXT = 'Autorizo el tratamiento de mis datos de salud.'

export interface PanelSeedOptions {
  /** Módulos de la cuenta; con 'clinica' se siembra la clínica. */
  modules?: string[]
  /** Sillones de la sede (null = sin tope). */
  chairCount?: number | null
  /** La clínica declaró que recibe el permiso en recepción. */
  receptionDeclared?: boolean
  extra?: Record<string, Row[]>
}

export function seedPanelDb(options: PanelSeedOptions = {}): FakeDb {
  const modules = options.modules ?? ['agenda']
  const clinic = modules.includes('clinica')

  const tables: Record<string, Row[]> = {
    accounts: [{ id: TEST_ACCOUNT, modules, vertical_key: null }],
    booking_settings: [{ account_id: TEST_ACCOUNT, labels: {} }],
    booking_services: [
      { id: SERVICE, account_id: TEST_ACCOUNT, name: 'Limpieza', duration_minutes: 30, is_active: true },
      { id: INACTIVE_SERVICE, account_id: TEST_ACCOUNT, name: 'Vieja', duration_minutes: 30, is_active: false },
      { id: FOREIGN_SERVICE, account_id: OTHER_ACCOUNT, name: 'Ajena', duration_minutes: 30, is_active: true },
    ],
    booking_staff: [
      { id: STAFF, account_id: TEST_ACCOUNT, name: 'Dra. Rojas', is_active: true },
      { id: STAFF_NO_SERVICE, account_id: TEST_ACCOUNT, name: 'Dr. Mora', is_active: true },
      { id: STAFF_B, account_id: TEST_ACCOUNT, name: 'Dra. Vega', is_active: true },
      { id: FOREIGN_STAFF, account_id: OTHER_ACCOUNT, name: 'Ajeno', is_active: true },
    ],
    booking_staff_services: [
      { account_id: TEST_ACCOUNT, staff_id: STAFF, service_id: SERVICE },
      { account_id: TEST_ACCOUNT, staff_id: STAFF_B, service_id: SERVICE },
    ],
    booking_working_hours: [
      // Lunes (1) a viernes (5), 9 a 18.
      ...[1, 2, 3, 4, 5].map((weekday) => ({
        account_id: TEST_ACCOUNT,
        staff_id: STAFF,
        weekday,
        start_time: '09:00:00',
        end_time: '18:00:00',
      })),
      // La Dra. Vega trabaja martes a viernes: los lunes no.
      ...[2, 3, 4, 5].map((weekday) => ({
        account_id: TEST_ACCOUNT,
        staff_id: STAFF_B,
        weekday,
        start_time: '09:00:00',
        end_time: '18:00:00',
      })),
    ],
    booking_time_off: [],
    booking_appointments: [],
    contacts: [
      { id: CONTACT, account_id: TEST_ACCOUNT, name: 'Ana Pérez', phone: '573001112233' },
      { id: FOREIGN_CONTACT, account_id: OTHER_ACCOUNT, name: 'Ajena', phone: '573009998877' },
    ],
    conversations: [
      {
        id: CONVERSATION,
        account_id: TEST_ACCOUNT,
        contact_id: CONTACT,
        created_at: '2026-10-01T00:00:00.000Z',
      },
    ],
  }

  if (clinic) {
    tables.clinic_settings = [
      {
        account_id: TEST_ACCOUNT,
        consent_text: CONSENT_TEXT,
        consent_version: 2,
        reception_consent_declared_at: options.receptionDeclared ? '2026-11-01T00:00:00.000Z' : null,
        urgency_words: [],
        urgency_alarm_text: 'Si es una urgencia, llama ya.',
        urgency_service_id: null,
        offer_days: 30,
      },
    ]
    tables.clinic_locations = [
      {
        id: LOCATION,
        account_id: TEST_ACCOUNT,
        name: 'Sede Centro',
        is_active: true,
        chair_count: options.chairCount === undefined ? 2 : options.chairCount,
        created_at: '2026-10-01T00:00:00.000Z',
      },
    ]
    tables.clinic_patients = []
    tables.clinic_consents = []
  }

  return makeFakeDb({ ...tables, ...options.extra })
}

/** Una cita activa del profesional (para chocar o llenar sillones). */
export function activeAppointment(overrides: Row = {}): Row {
  return {
    id: APPOINTMENT,
    account_id: TEST_ACCOUNT,
    contact_id: CONTACT,
    conversation_id: CONVERSATION,
    service_id: SERVICE,
    staff_id: STAFF,
    starts_at: MON_10,
    ends_at: '2026-11-09T15:30:00.000Z',
    status: 'confirmed',
    reminder_sent_at: '2026-11-08T15:00:00.000Z',
    reminder_2h_sent_at: '2026-11-09T13:00:00.000Z',
    attendance_confirmed_at: '2026-11-08T16:00:00.000Z',
    updated_at: '2026-11-04T12:00:00.123456+00:00',
    ...overrides,
  }
}
