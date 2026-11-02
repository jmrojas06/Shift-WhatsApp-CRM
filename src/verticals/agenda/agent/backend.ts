// ============================================================
// Interfaz entre el bot y la agenda de la clínica.
//
// El bot no sabe dónde viven las citas: la Agenda de Shift es una
// implementación (internal-backend.ts) y el software de la clínica será
// otra (Fase 4). El catálogo que ve el paciente sigue siendo local en
// ambos casos, así que aquí solo está lo que cambia según quién manda.
// ============================================================

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
  book(args: BookArgs): Promise<BookResult>
  /** Lanza si no se pudo: el bot no puede decir "cancelada" si sigue viva. */
  cancel(args: { id: string; reason: string; cancelledAtIso: string }): Promise<void>
  /** Lanza si no se pudo. */
  confirm(args: { id: string; confirmedAtIso: string }): Promise<void>
}
