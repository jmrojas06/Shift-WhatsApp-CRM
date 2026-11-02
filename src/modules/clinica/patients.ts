// ============================================================
// Pacientes de un contacto. Un número de WhatsApp puede tener varios:
// una mamá agenda a sus hijos desde el suyo. La autorización la da el
// contacto; la cita es del paciente.
//
// El nombre de un paciente es un dato personal: no va a logs, avisos ni
// notas. Los errores de este archivo solo llevan el mensaje de la base.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ClinicPatient {
  id: string
  fullName: string
}

/** Como el CHECK de clinic_patients.full_name. */
export const PATIENT_NAME_MAX = 120

/**
 * Lo que puede tener un nombre: letras de cualquier idioma, tildes sueltas
 * (marcas), espacios, apóstrofo, guion y punto ("O'Brien", "Jean-Pierre",
 * "Ma. Fernanda"). Deja fuera números, emojis, símbolos, caracteres de control
 * e invisibles, y el aviso "[Unsupported message type: …]" con que llega una
 * foto o un sticker.
 */
const NAME_CHARS = /^[\p{L}\p{M}' ’.-]+$/u
const HAS_LETTER = /\p{L}/u

/** Nombre y apellidos: dos palabras o más, solo letras y signos de nombre. */
export function validatePatientName(raw: string): { ok: true; value: string } | { ok: false } {
  const value = raw.replace(/\s+/gu, ' ').trim()
  if ([...value].length > PATIENT_NAME_MAX) return { ok: false }
  if (!NAME_CHARS.test(value)) return { ok: false }
  const words = value.split(' ')
  if (words.length < 2) return { ok: false }
  // Un guion o un punto solos no son una palabra.
  if (words.some((word) => !HAS_LETTER.test(word))) return { ok: false }
  return { ok: true, value }
}

/** Pacientes de ese contacto en esa cuenta, por nombre. */
export async function listPatients(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<ClinicPatient[]> {
  const { data, error } = await db
    .from('clinic_patients')
    .select('id, full_name')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .order('full_name')
  if (error) throw new Error(`No se pudieron leer los pacientes: ${error.message}`)
  return ((data ?? []) as { id: string; full_name: string }[]).map((row) => ({
    id: row.id,
    fullName: row.full_name,
  }))
}

/** Lanza si no se pudo guardar: sin paciente no hay a nombre de quién agendar. */
export async function insertPatient(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; fullName: string },
): Promise<ClinicPatient> {
  const id = crypto.randomUUID()
  const { error } = await db.from('clinic_patients').insert({
    id,
    account_id: args.accountId,
    contact_id: args.contactId,
    full_name: args.fullName,
  })
  if (error) throw new Error(`No se pudo registrar al paciente: ${error.message}`)
  return { id, fullName: args.fullName }
}
