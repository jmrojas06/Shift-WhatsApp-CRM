// Postgres `foreign_key_violation`. Un contacto que es paciente de la
// clínica no se puede borrar: clinic_patients.contact_id no tiene cascada
// (migración 055), así que la base rechaza el DELETE con este código.
// Las demás tablas que apuntan a contacts lo dejan en NULL o lo borran en
// cascada, por lo que aquí no aparece por otra causa.
const FOREIGN_KEY_VIOLATION = '23503'

export type ContactDeleteToastKey =
  | 'toastFailedDelete'
  | 'toastBulkFailedDelete'
  | 'toastPatientContact'
  | 'toastBulkPatientContact'

/**
 * Qué texto mostrar cuando falla un DELETE sobre `contacts`. `bulk` es el
 * borrado de varios a la vez (una sola sentencia: si uno es paciente, no se
 * borra ninguno).
 */
export function contactDeleteToastKey(
  error: { code?: string | null },
  bulk: boolean,
): ContactDeleteToastKey {
  if (error.code === FOREIGN_KEY_VIOLATION) {
    return bulk ? 'toastBulkPatientContact' : 'toastPatientContact'
  }
  return bulk ? 'toastBulkFailedDelete' : 'toastFailedDelete'
}
