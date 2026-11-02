// ============================================================
// Interfaz entre el bot y la agenda de la clínica.
//
// El bot no sabe dónde viven las citas: la Agenda de Shift es una
// implementación (internal-backend.ts) y el software de la clínica será
// otra (Fase 4). El catálogo que ve el paciente sigue siendo local en
// ambos casos, así que aquí solo está lo que cambia según quién manda.
//
// Contrato de fallas (todo conector debe cumplirlo):
//   - `book` NO lanza por un fallo esperado: devuelve `slot_taken` si
//     alguien ganó la hora y `failed` si la cita no quedó creada.
//   - Las lecturas (`getDaySlots`, `getDaysWithSlots`, `isStaffFree`,
//     `findPatients`) lanzan si no pueden responder. Un conector nunca
//     debe contestar "libre" ni devolver horas cuando no pudo leer la
//     agenda: ofrecer una hora que no se sabe libre es peor que no
//     ofrecer ninguna. Tampoco "no hay pacientes" si no pudo leerlos:
//     el bot pediría el nombre y duplicaría a alguien que ya existe.
//   - `cancel`, `confirm` y `createPatient` lanzan si no se pudo: el bot
//     no dice "cancelada" ni "confirmada" sobre una cita que sigue como
//     estaba, ni sigue con un paciente que no quedó registrado.
//   - Un paciente es dato personal: ningún conector pone su nombre en un
//     mensaje de error ni en un log.
// ============================================================

import type { ClinicPatient } from '@/modules/clinica/patients'

import type { AnswerMap } from '../questions'
import type { MergedSlot } from './availability'
import type { ServiceInfo } from './db'

export interface SlotQuery {
  service: ServiceInfo
  /** Candidatos ya resueltos: el elegido o todos los que atienden el servicio. */
  staffIds: string[]
  /** Día local 'YYYY-MM-DD'. */
  dateKey: string
  now: Date
}

export interface DayRangeQuery {
  service: ServiceInfo
  staffIds: string[]
  fromKey: string
  days: number
  now: Date
}

export interface BookArgs {
  id: string
  contactId: string
  conversationId: string
  serviceId: string
  staffId: string
  /** Paciente y sede de la cita (módulo clínica). Sin ellos no se guardan. */
  patientId?: string | null
  locationId?: string | null
  startsAtIso: string
  endsAtIso: string
  confirmedAtIso: string
  rescheduledFrom?: string | null
  answers?: AnswerMap
}

export type BookResult =
  | { kind: 'ok' }
  /** Alguien ganó la hora: se ofrecen otras. */
  | { kind: 'slot_taken' }
  /** La cita NO quedó creada. */
  | { kind: 'failed'; message: string }

export interface ClinicBackend {
  getDaySlots(query: SlotQuery): Promise<MergedSlot[]>
  /** Días del rango con al menos una hora ofrecible, en orden. */
  getDaysWithSlots(query: DayRangeQuery): Promise<string[]>
  isStaffFree(args: { staffId: string; startIso: string; endIso: string }): Promise<boolean>
  /** Pacientes de ese contacto (un número puede tener varios). Lanza si no pudo leer. */
  findPatients(args: { contactId: string }): Promise<ClinicPatient[]>
  /** Registra a un paciente del contacto. Lanza si no se pudo guardar. */
  createPatient(args: { contactId: string; fullName: string }): Promise<ClinicPatient>
  book(args: BookArgs): Promise<BookResult>
  /** Lanza si no se pudo: el bot no puede decir "cancelada" si sigue viva. */
  cancel(args: { id: string; reason: string; cancelledAtIso: string }): Promise<void>
  /** Lanza si no se pudo. */
  confirm(args: { id: string; confirmedAtIso: string }): Promise<void>
}
