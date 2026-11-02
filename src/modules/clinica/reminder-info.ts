// ============================================================
// Datos del recordatorio de una clínica: a nombre de quién va la cita y en
// qué sede. El procedimiento NO viaja: el teléfono puede ser compartido y el
// texto pasa por Meta.
//
// Va en consultas aparte para que los demás negocios no lean columnas de la
// migración 055.
//
// El nombre del paciente es un dato personal: no va a logs, avisos ni notas.
// Los errores de este archivo solo llevan el mensaje de la base. Un fallo
// LANZA: un error de lectura no es "la cita no tiene paciente", y mandar un
// recordatorio con otro nombre u otra sede es peor que mandarlo en la próxima
// corrida.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAppointmentClinicLinks, loadContact } from '@/verticals/agenda/agent/db'

import { DEFAULT_LOCATION_NAME } from './texts'

export interface ClinicReminderInfo {
  patientName: string
  locationName: string
}

const FALLBACK_PATIENT = 'tu familiar'
// Como la sede que se crea sola: el recordatorio dice "sede {nombre}".
const FALLBACK_LOCATION = DEFAULT_LOCATION_NAME

const HAS_LETTER = /\p{L}/u

/**
 * Una sola línea y sin espacios de más: Meta rechaza una variable de la
 * plantilla con saltos de línea o tabulaciones. null si no queda nada.
 */
function tidy(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/gu, ' ').trim()
  return text === '' ? null : text
}

async function readName(
  db: SupabaseClient,
  args: {
    table: 'clinic_patients' | 'clinic_locations'
    column: 'full_name' | 'name'
    what: string
    accountId: string
    id: string
  },
): Promise<string | null> {
  const { data, error } = await db
    .from(args.table)
    .select(args.column)
    .eq('id', args.id)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer ${args.what} del recordatorio: ${error.message}`)
  return tidy((data as Record<string, string | null> | null)?.[args.column])
}

export async function loadClinicReminderInfo(
  db: SupabaseClient,
  args: { accountId: string; appointmentId: string; contactId: string },
): Promise<ClinicReminderInfo> {
  const links = await loadAppointmentClinicLinks(db, args.accountId, args.appointmentId)

  let patientName = links.patientId
    ? await readName(db, {
        table: 'clinic_patients',
        column: 'full_name',
        what: 'el paciente',
        accountId: args.accountId,
        id: links.patientId,
      })
    : null
  if (!patientName) {
    // Una cita de antes del módulo: el nombre del contacto, si es un nombre
    // (no un número ni un símbolo).
    const contactName = tidy((await loadContact(db, args.accountId, args.contactId))?.name)
    patientName = contactName && HAS_LETTER.test(contactName) ? contactName : null
  }

  const locationName = links.locationId
    ? await readName(db, {
        table: 'clinic_locations',
        column: 'name',
        what: 'la sede',
        accountId: args.accountId,
        id: links.locationId,
      })
    : null

  return {
    patientName: patientName ?? FALLBACK_PATIENT,
    locationName: locationName ?? FALLBACK_LOCATION,
  }
}
