// ============================================================
// Datos de ejemplo para la vista previa del calendario (solo
// desarrollo). Todo vive en memoria: no se lee ni se escribe en
// ninguna base. Los nombres son inventados.
//
// La semana de ejemplo es la del martes 10 de noviembre de 2026, y "hoy"
// es ese martes a las 10:20 (hora de Bogotá), para que las capturas sean
// siempre iguales.
// ============================================================

import type { AppointmentStatus } from '@/verticals/agenda/appointments'
import type {
  CalendarAppointment,
  CalendarData,
  ContactOption,
  PatientOption,
} from '@/verticals/agenda/calendar-data'

export const PREVIEW_TODAY = '2026-11-10'
/** 10:20 a. m. en Bogotá (UTC-5). */
export const PREVIEW_NOW = new Date('2026-11-10T10:20:00-05:00')

const bog = (dateKey: string, time: string): Date => new Date(`${dateKey}T${time}:00-05:00`)

const S1 = '00000000-0000-4000-8000-0000000000a1'
const S2 = '00000000-0000-4000-8000-0000000000a2'
const S3 = '00000000-0000-4000-8000-0000000000a3'
const V1 = '00000000-0000-4000-8000-0000000000b1'
const V2 = '00000000-0000-4000-8000-0000000000b2'
const V3 = '00000000-0000-4000-8000-0000000000b3'
const V4 = '00000000-0000-4000-8000-0000000000b4'
const V5 = '00000000-0000-4000-8000-0000000000b5'

const SERVICES = [
  { id: V1, name: 'Valoración inicial', durationMinutes: 30, isActive: true },
  { id: V2, name: 'Limpieza dental', durationMinutes: 30, isActive: true },
  { id: V3, name: 'Control de ortodoncia', durationMinutes: 30, isActive: true },
  { id: V4, name: 'Endodoncia', durationMinutes: 60, isActive: true },
  { id: V5, name: 'Blanqueamiento', durationMinutes: 60, isActive: true },
]

const serviceName = (id: string): string => SERVICES.find((s) => s.id === id)?.name ?? ''

export const PREVIEW_CONTACTS: (ContactOption & { patients: PatientOption[] })[] = [
  { id: 'c01', name: 'Sofía Londoño', phone: '+573001112233', patients: [{ id: 'p01', fullName: 'Sofía Londoño' }] },
  {
    id: 'c02',
    name: 'Natalia Pardo',
    phone: '+573104448899',
    patients: [
      { id: 'p02', fullName: 'Julián Pardo' },
      { id: 'p03', fullName: 'Emilia Pardo' },
    ],
  },
  { id: 'c03', name: 'Mariana Gómez', phone: '+573205550123', patients: [{ id: 'p04', fullName: 'Mariana Gómez Cortés' }] },
  { id: 'c04', name: 'Esteban Rincón', phone: '+573157771100', patients: [{ id: 'p05', fullName: 'Esteban Rincón' }] },
  { id: 'c05', name: 'Laura Beltrán', phone: '+573012223344', patients: [{ id: 'p06', fullName: 'Laura Beltrán' }] },
  { id: 'c06', name: 'Camilo Arango', phone: '+573223334455', patients: [{ id: 'p07', fullName: 'Camilo Arango' }] },
  { id: 'c07', name: 'Daniela Cifuentes', phone: '+573184445566', patients: [{ id: 'p08', fullName: 'Daniela Cifuentes' }] },
  { id: 'c08', name: 'Tomás Quintero', phone: '+573135556677', patients: [{ id: 'p09', fullName: 'Tomás Quintero' }] },
  { id: 'c09', name: 'Valeria Mejía', phone: '+573046667788', patients: [{ id: 'p10', fullName: 'Valeria Mejía' }] },
  { id: 'c10', name: 'Santiago Zapata', phone: '+573167778899', patients: [{ id: 'p11', fullName: 'Santiago Zapata' }] },
  { id: 'c11', name: 'Isabella Cárdenas', phone: '+573208889900', patients: [{ id: 'p12', fullName: 'Isabella Cárdenas' }] },
  { id: 'c12', name: 'Mateo Villegas', phone: '+573119990011', patients: [{ id: 'p13', fullName: 'Mateo Villegas' }] },
]

const contact = (id: string) => PREVIEW_CONTACTS.find((c) => c.id === id)!

/** [día, inicio, fin, profesional, servicio, contacto, paciente, estado, confirmó] */
type Row = [string, string, string, string, string, string, string, AppointmentStatus, boolean?]

const ROWS: Row[] = [
  // Lunes 9
  ['2026-11-09', '08:00', '08:30', S1, V2, 'c05', 'p06', 'completed'],
  ['2026-11-09', '09:00', '10:00', S2, V5, 'c06', 'p07', 'completed'],
  ['2026-11-09', '10:00', '10:30', S1, V1, 'c07', 'p08', 'no_show'],
  ['2026-11-09', '15:00', '15:30', S2, V2, 'c08', 'p09', 'completed'],
  // Martes 10 (hoy)
  [PREVIEW_TODAY, '08:00', '08:30', S1, V2, 'c01', 'p01', 'completed'],
  [PREVIEW_TODAY, '08:30', '09:30', S1, V4, 'c05', 'p06', 'completed'],
  [PREVIEW_TODAY, '09:30', '10:00', S1, V1, 'c02', 'p02', 'no_show'],
  [PREVIEW_TODAY, '10:30', '11:00', S1, V3, 'c03', 'p04', 'confirmed', true],
  [PREVIEW_TODAY, '11:00', '12:00', S1, V4, 'c04', 'p05', 'pending'],
  [PREVIEW_TODAY, '14:00', '14:30', S1, V2, 'c09', 'p10', 'confirmed'],
  [PREVIEW_TODAY, '14:30', '15:00', S1, V1, 'c10', 'p11', 'cancelled'],
  [PREVIEW_TODAY, '15:00', '15:30', S1, V3, 'c11', 'p12', 'confirmed', true],
  [PREVIEW_TODAY, '16:30', '17:30', S1, V4, 'c12', 'p13', 'confirmed'],
  [PREVIEW_TODAY, '09:00', '09:30', S2, V2, 'c06', 'p07', 'completed'],
  [PREVIEW_TODAY, '10:00', '10:30', S2, V1, 'c08', 'p09', 'confirmed', true],
  [PREVIEW_TODAY, '10:30', '11:30', S2, V5, 'c07', 'p08', 'confirmed'],
  [PREVIEW_TODAY, '11:30', '12:00', S2, V2, 'c10', 'p11', 'confirmed'],
  [PREVIEW_TODAY, '14:00', '14:30', S2, V2, 'c01', 'p01', 'confirmed'],
  [PREVIEW_TODAY, '16:00', '16:30', S2, V1, 'c04', 'p05', 'pending'],
  [PREVIEW_TODAY, '08:00', '08:30', S3, V1, 'c09', 'p10', 'completed'],
  [PREVIEW_TODAY, '09:00', '10:00', S3, V4, 'c12', 'p13', 'confirmed'],
  [PREVIEW_TODAY, '11:30', '12:00', S3, V3, 'c11', 'p12', 'confirmed', true],
  [PREVIEW_TODAY, '13:00', '13:30', S3, V1, 'c03', 'p04', 'pending'],
  // Miércoles 11
  ['2026-11-11', '08:30', '09:00', S1, V2, 'c01', 'p01', 'confirmed'],
  ['2026-11-11', '10:00', '11:00', S1, V4, 'c06', 'p07', 'confirmed', true],
  ['2026-11-11', '10:00', '10:30', S2, V1, 'c10', 'p11', 'confirmed'],
  ['2026-11-11', '14:00', '15:00', S1, V4, 'c07', 'p08', 'pending'],
  ['2026-11-11', '15:30', '16:00', S2, V2, 'c05', 'p06', 'confirmed'],
  // Jueves 12
  ['2026-11-12', '08:00', '08:30', S3, V3, 'c04', 'p05', 'confirmed'],
  ['2026-11-12', '09:00', '09:30', S1, V2, 'c08', 'p09', 'confirmed'],
  ['2026-11-12', '09:30', '10:30', S2, V5, 'c12', 'p13', 'confirmed', true],
  ['2026-11-12', '11:00', '11:30', S3, V1, 'c02', 'p03', 'pending'],
  ['2026-11-12', '14:30', '15:00', S1, V3, 'c03', 'p04', 'confirmed'],
  // Viernes 13
  ['2026-11-13', '08:00', '09:00', S1, V4, 'c09', 'p10', 'confirmed'],
  ['2026-11-13', '10:30', '11:00', S2, V2, 'c11', 'p12', 'confirmed'],
  ['2026-11-13', '16:00', '16:30', S1, V1, 'c01', 'p01', 'pending'],
  // Sábado 14
  ['2026-11-14', '09:00', '09:30', S1, V2, 'c05', 'p06', 'confirmed'],
  ['2026-11-14', '10:00', '10:30', S3, V3, 'c06', 'p07', 'confirmed'],
]

/** Citas de ejemplo; sin `clinic`, el nombre es el del contacto (no hay paciente). */
export function previewAppointments(clinic: boolean): CalendarAppointment[] {
  return ROWS.map(([day, from, to, staffId, serviceId, contactId, patientId, status, confirmed], i) => {
    const c = contact(contactId)
    const patient = c.patients.find((p) => p.id === patientId)
    return {
      id: `a${String(i + 1).padStart(3, '0')}`,
      startsAt: bog(day, from),
      endsAt: bog(day, to),
      status,
      staffId,
      serviceId,
      serviceName: serviceName(serviceId),
      contactId,
      contactName: c.name,
      contactPhone: c.phone,
      patientName: clinic ? (patient?.fullName ?? null) : null,
      conversationId: `conv-${contactId}`,
      patientConfirmed: confirmed === true,
    }
  })
}

export function previewData(clinic: boolean): CalendarData {
  const weekdays = [1, 2, 3, 4, 5]
  const block = (staffId: string, weekday: number, startTime: string, endTime: string) => ({
    staffId,
    weekday,
    startTime: `${startTime}:00`,
    endTime: `${endTime}:00`,
  })
  return {
    services: SERVICES,
    staff: [
      { id: S1, name: 'Dra. Camila Restrepo', isActive: true },
      { id: S2, name: 'Dr. Andrés Salazar', isActive: true },
      { id: S3, name: 'Dra. Valentina Ospina', isActive: true },
    ],
    staffServices: [
      ...[V1, V2, V3, V4].map((serviceId) => ({ staffId: S1, serviceId })),
      ...[V1, V2, V5].map((serviceId) => ({ staffId: S2, serviceId })),
      ...[V1, V3, V4].map((serviceId) => ({ staffId: S3, serviceId })),
    ],
    workBlocks: [
      ...weekdays.flatMap((d) => [block(S1, d, '08:00', '12:00'), block(S1, d, '14:00', '18:00')]),
      block(S1, 6, '08:00', '13:00'),
      ...weekdays.map((d) => block(S2, d, '09:00', '17:00')),
      ...[2, 4].map((d) => block(S3, d, '08:00', '14:00')),
      block(S3, 6, '08:00', '13:00'),
    ],
    timeOff: [
      { id: 't1', staffId: S2, startsAt: bog(PREVIEW_TODAY, '12:30'), endsAt: bog(PREVIEW_TODAY, '13:30'), reason: 'Almuerzo' },
      { id: 't2', staffId: S2, startsAt: bog('2026-11-12', '15:00'), endsAt: bog('2026-11-12', '17:00'), reason: 'Capacitación' },
      { id: 't3', staffId: S3, startsAt: bog('2026-11-11', '00:00'), endsAt: bog('2026-11-12', '00:00'), reason: 'Congreso' },
    ],
    appointments: previewAppointments(clinic),
  }
}
