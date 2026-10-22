import { CalendarDays } from 'lucide-react'
import type { VerticalManifest } from '@/lib/verticals/types'

/**
 * Agenda — citas por WhatsApp para cualquier negocio (barbería, salón,
 * consultorio, taller, clases…). Cada cuenta elige su punto de partida y
 * sus palabras en /agenda/configuracion.
 */
export const agendaManifest: VerticalManifest = {
  key: 'agenda',
  name: 'Agenda',
  description: 'Citas por WhatsApp, servicios, equipo y recordatorios para tu negocio.',
  nav: {
    href: '/agenda',
    labelKey: 'agenda',
    icon: CalendarDays,
  },
}
