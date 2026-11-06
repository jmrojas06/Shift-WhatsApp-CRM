import type { VerticalManifest } from '@/lib/verticals/types'

/**
 * Clínica — capa sobre la Agenda para clínicas odontológicas: pacientes,
 * autorización de datos, urgencias y recordatorios sin procedimiento.
 *
 * Sin bot propio ni menú: el bot sigue siendo el de la Agenda y este
 * módulo prende sus pasos clínicos.
 */
export const clinicaManifest: VerticalManifest = {
  key: 'clinica',
  name: 'Clínica',
  description: 'Pacientes, autorización de datos y urgencias sobre la agenda.',
}
