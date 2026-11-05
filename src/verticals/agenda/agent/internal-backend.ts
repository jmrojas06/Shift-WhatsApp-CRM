// ============================================================
// ClinicBackend sobre las tablas booking_*: la Agenda de Shift.
//
// Es el camino de todo negocio con agenda propia, barberías incluidas.
// Solo mueve aquí lo que antes vivía en el controlador, sin cambiar
// conducta: controller.test.ts es la garantía.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { insertPatient, listPatients } from '@/modules/clinica/patients'

import { computeDaySlots, mergeSlotsByStart, type MergedSlot } from './availability'
import type { ClinicBackend, DayRangeQuery, SlotQuery } from './backend'
import { chairsFreeAt, loadChairContext, type ChairContext } from './chairs'
import {
  cancelAppointment,
  insertAppointment,
  isStaffFree,
  listBusy,
  listWorkBlocks,
  markAppointmentConfirmed,
  type BusyRow,
  type WorkBlockRow,
} from './db'
import { addDaysToKey, startOfZonedDay } from './time'

interface DayData {
  blocks: WorkBlockRow[]
  busy: BusyRow[]
  /** Solo en una clínica: el cupo de sillones y las citas de toda la cuenta en el rango. */
  chairs: ChairContext | null
}

export function createInternalBackend(args: {
  db: SupabaseClient
  accountId: string
  /**
   * La cuenta tiene el módulo de clínica: una hora sin silla libre no se
   * ofrece, aunque el profesional esté libre. Sin la bandera (barberías y
   * demás) la disponibilidad es la de siempre y no se lee nada de más.
   */
  clinic?: boolean
}): ClinicBackend {
  const { db, accountId } = args
  const clinic = args.clinic === true

  async function loadRange(staffIds: string[], fromKey: string, days: number): Promise<DayData> {
    const fromIso = startOfZonedDay(fromKey).toISOString()
    const toIso = startOfZonedDay(addDaysToKey(fromKey, days)).toISOString()
    // El cupo se lee una vez por rango, no una por día.
    const [blocks, busy, chairs] = await Promise.all([
      listWorkBlocks(db, accountId, staffIds),
      listBusy(db, accountId, staffIds, fromIso, toIso),
      clinic ? loadChairContext(db, accountId, fromIso, toIso) : Promise.resolve(null),
    ])
    return { blocks, busy, chairs }
  }

  function slotsForDay(
    query: Pick<SlotQuery, 'service' | 'staffIds' | 'now'>,
    data: DayData,
    dateKey: string,
  ): MergedSlot[] {
    const sets = query.staffIds.map((staffId) => ({
      staffId,
      slots: computeDaySlots({
        dateKey,
        durationMinutes: query.service.durationMinutes,
        workBlocks: data.blocks.filter((b) => b.staffId === staffId),
        busy: data.busy.filter((b) => b.staffId === staffId),
        now: query.now,
      }),
    }))
    const merged = mergeSlotsByStart(sets)
    const { chairs } = data
    if (!chairs) return merged
    return merged.filter((slot) =>
      chairsFreeAt({
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        chairCount: chairs.chairCount,
        active: chairs.active,
      }),
    )
  }

  return {
    async getDaySlots(query: SlotQuery) {
      const data = await loadRange(query.staffIds, query.dateKey, 1)
      return slotsForDay(query, data, query.dateKey)
    },

    async getDaysWithSlots(query: DayRangeQuery) {
      const data = await loadRange(query.staffIds, query.fromKey, query.days)
      const keys: string[] = []
      for (let i = 0; i < query.days; i += 1) {
        const key = addDaysToKey(query.fromKey, i)
        if (slotsForDay(query, data, key).length) keys.push(key)
      }
      return keys
    },

    isStaffFree: ({ staffId, startIso, endIso }) =>
      isStaffFree(db, accountId, staffId, startIso, endIso),

    findPatients: ({ contactId }) => listPatients(db, { accountId, contactId }),

    createPatient: ({ contactId, fullName }) =>
      insertPatient(db, { accountId, contactId, fullName }),

    async listUpcoming({ contactId, nowIso }) {
      const { data, error } = await db
        .from('booking_appointments')
        .select('id, starts_at, patient_id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .in('status', ['pending', 'confirmed'])
        .gt('starts_at', nowIso)
        .order('starts_at')
      if (error) throw new Error(`No se pudieron leer las citas: ${error.message}`)
      const rows = (data ?? []) as { id: string; starts_at: string; patient_id: string | null }[]
      if (!rows.length) return []
      const patients = await listPatients(db, { accountId, contactId })
      const names = new Map(patients.map((p) => [p.id, p.fullName]))
      return rows.map((row) => ({
        id: row.id,
        startsAt: new Date(row.starts_at),
        patientName: row.patient_id ? (names.get(row.patient_id) ?? null) : null,
      }))
    },

    async book(book) {
      const { error } = await insertAppointment(db, {
        ...book,
        accountId,
        status: 'confirmed',
        createdVia: 'bot',
      })
      if (!error) return { kind: 'ok' }
      if (error.code === '23P01') return { kind: 'slot_taken' }
      return { kind: 'failed', message: error.message ?? 'error desconocido' }
    },

    cancel: (cancel) => cancelAppointment(db, { accountId, ...cancel }),

    confirm: (confirm) => markAppointmentConfirmed(db, { accountId, ...confirm }),
  }
}
