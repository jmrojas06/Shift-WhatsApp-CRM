// ============================================================
// Datos de ejemplo para la vista previa de "Para llamar" y "Sin marcar"
// (solo desarrollo). Todo vive en memoria: no se lee ni se escribe en ninguna
// base. Los nombres y teléfonos son inventados.
//
// "Hoy" es el martes 10 de noviembre de 2026 a las 10:20 (hora de Bogotá), igual
// que en la vista previa del calendario, para que las capturas sean iguales.
// ============================================================

import type { CallListRow } from '@/verticals/agenda/call-list'
import type { UnmarkedItem } from '@/app/(dashboard)/agenda/_components/unmarked-section'

export const PREVIEW_NOW = new Date('2026-11-10T10:20:00-05:00')

const bog = (day: string, time: string): string => new Date(`${day}T${time}:00-05:00`).toISOString()
const ago = (minutes: number): string => new Date(PREVIEW_NOW.getTime() - minutes * 60_000).toISOString()

const base = {
  patientName: null,
  robotAttempts: 0,
  manualAttempts: 0,
  lastRobot: null,
  lastManual: null,
  robotInProgress: false,
  canRobotCall: true,
} satisfies Partial<CallListRow>

/** Siete filas: con las cinco primeras visibles se ve también "Ver las 2 que faltan". */
export function previewCallRows(clinic: boolean): CallListRow[] {
  const patient = (name: string): string | null => (clinic ? name : null)
  return [
    {
      ...base,
      appointmentId: 'r1',
      startsAt: bog('2026-11-10', '11:30'),
      contactId: 'c1',
      contactName: 'Sofía Londoño',
      phone: '573001112233',
      staffName: 'Dra. Rojas',
      reason: 'robot_human',
      robotAttempts: 1,
      lastRobot: { outcome: 'human', status: 'completed', at: ago(25) },
    },
    {
      ...base,
      appointmentId: 'r2',
      startsAt: bog('2026-11-10', '14:00'),
      contactId: 'c2',
      patientName: patient('Julián Pardo'),
      contactName: 'Natalia Pardo',
      phone: '573104448899',
      staffName: 'Dr. Mejía',
      reason: 'reminder_unanswered',
    },
    {
      ...base,
      appointmentId: 'r3',
      startsAt: bog('2026-11-10', '16:30'),
      contactId: 'c3',
      patientName: patient('Mariana Gómez Cortés'),
      contactName: 'Mariana Gómez',
      phone: '573205550123',
      staffName: 'Dra. Rojas',
      reason: 'robot_no_response',
      robotAttempts: 2,
      manualAttempts: 1,
      lastRobot: { outcome: 'no_response', status: 'no_answer', at: ago(65) },
      lastManual: { outcome: 'no_response', status: 'no_answer', at: ago(20) },
    },
    {
      ...base,
      appointmentId: 'r4',
      startsAt: bog('2026-11-11', '08:00'),
      contactId: 'c4',
      contactName: 'Esteban Rincón',
      phone: '573157771100',
      staffName: 'Dr. Mejía',
      reason: 'robot_failed',
      robotAttempts: 1,
      lastRobot: { outcome: null, status: 'failed', at: ago(5) },
    },
    {
      ...base,
      appointmentId: 'r5',
      startsAt: bog('2026-11-11', '09:30'),
      contactId: 'c5',
      contactName: 'Laura Beltrán',
      phone: '573012223344',
      staffName: 'Dra. Rojas',
      reason: 'reminder_unanswered',
      robotAttempts: 1,
      robotInProgress: true,
      canRobotCall: false,
      lastRobot: { outcome: null, status: 'calling', at: ago(1) },
    },
    {
      ...base,
      appointmentId: 'r6',
      startsAt: bog('2026-11-11', '11:00'),
      contactId: 'c6',
      contactName: 'Camilo Arango',
      phone: '573223334455',
      staffName: 'Dr. Mejía',
      reason: 'robot_advisor_missed',
      robotAttempts: 1,
      lastRobot: { outcome: 'advisor_missed', status: 'completed', at: ago(140) },
    },
    {
      ...base,
      appointmentId: 'r7',
      startsAt: bog('2026-11-11', '15:00'),
      contactId: 'c7',
      contactName: 'Daniela Cifuentes',
      phone: null,
      staffName: 'Dra. Rojas',
      reason: 'reminder_unanswered',
      robotAttempts: 3,
      canRobotCall: false,
      lastRobot: { outcome: 'no_response', status: 'no_answer', at: ago(300) },
    },
  ]
}

export const PREVIEW_UNMARKED: UnmarkedItem[] = [
  {
    id: 'u1',
    startsAt: bog('2026-11-10', '08:30'),
    serviceName: 'Limpieza dental',
    staffName: 'Dra. Rojas',
    personLabel: 'Tomás Quintero',
  },
  {
    id: 'u2',
    startsAt: bog('2026-11-10', '09:00'),
    serviceName: 'Control de ortodoncia',
    staffName: 'Dr. Mejía',
    personLabel: 'Valentina Ospina',
  },
  {
    id: 'u3',
    startsAt: bog('2026-11-10', '09:45'),
    serviceName: 'Valoración inicial',
    staffName: 'Dra. Rojas',
    personLabel: 'Andrés Valencia',
  },
]
