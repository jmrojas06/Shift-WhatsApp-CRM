// Postgres `foreign_key_violation`. Un contacto que es paciente de la
// clínica no se puede borrar: clinic_patients.contact_id no tiene cascada
// (migración 055), así que la base rechaza el DELETE con este código.
//
// Pero 23503 no es exclusivo de los pacientes: borrar un contacto también
// borra su conversación en cascada, y deals.conversation_id no tiene
// ON DELETE, así que un negocio enlazado a esa conversación da el mismo
// código. Por eso el mensaje de paciente exige además que el error nombre a
// clinic_patients; en lo demás se queda el texto genérico.
const FOREIGN_KEY_VIOLATION = '23503'
const PATIENTS_TABLE = 'clinic_patients'

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
  error: { code?: string | null; message?: string | null },
  bulk: boolean,
): ContactDeleteToastKey {
  if (error.code === FOREIGN_KEY_VIOLATION && error.message?.includes(PATIENTS_TABLE)) {
    return bulk ? 'toastBulkPatientContact' : 'toastPatientContact'
  }
  return bulk ? 'toastBulkFailedDelete' : 'toastFailedDelete'
}
