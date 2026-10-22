// ============================================================
// Cálculo de disponibilidad — puro y sin base de datos.
//
// El controlador junta las filas (horario semanal del barbero,
// time off, citas activas) y este módulo responde una sola
// pregunta: ¿qué horas se pueden ofrecer para un servicio, un
// día y unos barberos candidatos?
//
// Convenciones:
//   - Rejilla de 30 minutos alineada al inicio del bloque.
//   - Un servicio solo entra si cabe COMPLETO en el bloque.
//   - Margen de anticipación: nada dentro de los próximos 30
//     minutos (el barbero necesita un mínimo para prepararse).
//   - Intervalos semiabiertos [inicio, fin): una cita que
//     termina a las 10:00 no bloquea el slot de 10:00.
// ============================================================

import { formatTimeLabel } from './format'
import { AGENDA_TZ, weekdayOfKey, zonedTimeToUtc } from './time'

export interface WorkBlock {
  /** 0 = domingo … 6 = sábado. */
  weekday: number
  /** 'HH:MM:SS' como lo devuelve Postgres para `time`. */
  startTime: string
  /** 'HH:MM:SS'; siempre mayor que startTime. */
  endTime: string
}

export interface BusyInterval {
  startsAt: Date
  endsAt: Date
}

export interface DaySlot {
  startsAt: Date
  endsAt: Date
  /** '9:00 a. m.' — hora local ya formateada. */
  label: string
  /** 'YYYY-MM-DD' local. */
  dateKey: string
}

export const SLOT_STEP_MINUTES = 30
export const MIN_LEAD_MINUTES = 30

export interface ComputeDaySlotsArgs {
  /** Día local 'YYYY-MM-DD'. */
  dateKey: string
  durationMinutes: number
  /** Horarios semanales del barbero (cualquier weekday; se filtra aquí). */
  workBlocks: WorkBlock[]
  /** Citas activas + time off del barbero, como instantes UTC. */
  busy: BusyInterval[]
  now: Date
  tz?: string
  stepMinutes?: number
  leadMinutes?: number
}

const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

const toHHMM = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** Horas ofrecibles para un servicio en un día concreto. */
export function computeDaySlots(args: ComputeDaySlotsArgs): DaySlot[] {
  const { dateKey, durationMinutes, workBlocks, busy, now } = args
  const tz = args.tz ?? AGENDA_TZ
  const step = args.stepMinutes ?? SLOT_STEP_MINUTES
  const leadMs = (args.leadMinutes ?? MIN_LEAD_MINUTES) * 60_000

  const weekday = weekdayOfKey(dateKey)
  const earliest = now.getTime() + leadMs
  const durationMs = durationMinutes * 60_000
  const slots: DaySlot[] = []

  for (const block of workBlocks) {
    if (block.weekday !== weekday) continue
    const blockStart = toMinutes(block.startTime)
    const lastStart = toMinutes(block.endTime) - durationMinutes
    for (let m = blockStart; m <= lastStart; m += step) {
      const startsAt = zonedTimeToUtc(dateKey, toHHMM(m), tz)
      const endsAt = new Date(startsAt.getTime() + durationMs)
      if (startsAt.getTime() < earliest) continue
      const overlaps = busy.some(
        (b) => startsAt < b.endsAt && endsAt > b.startsAt,
      )
      if (overlaps) continue
      slots.push({
        startsAt,
        endsAt,
        label: formatTimeLabel({ hour: Math.floor(m / 60), minute: m % 60 }),
        dateKey,
      })
    }
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

export interface MergedSlot extends DaySlot {
  /** Barberos libres a esa hora, en el orden en que llegaron. */
  staffIds: string[]
}

/**
 * Une las rejillas de varios barberos ("Cualquiera") en una sola
 * lista: una hora por instante, con todos los barberos libres.
 */
export function mergeSlotsByStart(
  sets: { staffId: string; slots: DaySlot[] }[],
): MergedSlot[] {
  const byStart = new Map<number, MergedSlot>()
  for (const { staffId, slots } of sets) {
    for (const slot of slots) {
      const key = slot.startsAt.getTime()
      let merged = byStart.get(key)
      if (!merged) {
        merged = { ...slot, staffIds: [] }
        byStart.set(key, merged)
      }
      if (!merged.staffIds.includes(staffId)) merged.staffIds.push(staffId)
    }
  }
  return [...byStart.values()].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  )
}
