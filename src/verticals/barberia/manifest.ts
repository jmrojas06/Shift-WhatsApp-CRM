import { Scissors } from 'lucide-react'
import type { VerticalManifest } from '@/lib/verticals/types'

/**
 * Barbería — agenda de citas, catálogo de servicios y recordatorios
 * por WhatsApp para barberías y peluquerías.
 *
 * Phase 0 only declares the manifest (identity + sidebar entry). The
 * installer/seed (Phase 1) and the booking controller (Phase 2) land
 * inside this folder without changing the core seam.
 */
export const barberiaManifest: VerticalManifest = {
  key: 'barberia',
  name: 'Barbería',
  description:
    'Agenda de citas, catálogo de servicios y recordatorios por WhatsApp para barberías.',
  nav: {
    href: '/barberia',
    labelKey: 'barberia',
    icon: Scissors,
  },
}
