import { CalendarCheck, CalendarX, Check, CheckCheck, Clock, UserX, type LucideIcon } from 'lucide-react'

import type { AppointmentStatus } from '@/verticals/agenda/appointments'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'

// ============================================================
// Cómo se ve cada estado de la cita en el calendario.
//
// El color nunca es la única señal: cada estado lleva además un ícono,
// su nombre escrito y un borde distinto (sólido, punteado). Los colores
// salen de los tokens del CRM (modo claro y oscuro).
// ============================================================

export interface StatusVisual {
  label: string
  Icon: LucideIcon
  badge: 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'
  /** Color del borde izquierdo (la "cinta" de la cita). */
  rail: string
  /** Clases del bloque dentro de la cuadrícula. */
  block: string
}

const BLOCK_BASE = 'border-l-[3px]'

export const STATUS_VISUAL: Record<AppointmentStatus, StatusVisual> = {
  confirmed: {
    label: T.status.confirmed,
    Icon: CalendarCheck,
    badge: 'success',
    rail: 'border-l-primary',
    block: `${BLOCK_BASE} border-l-primary bg-primary-soft-2 text-foreground`,
  },
  pending: {
    label: T.status.pending,
    Icon: Clock,
    badge: 'warning',
    rail: 'border-l-warning',
    block: `${BLOCK_BASE} border-l-warning bg-warning/12 text-foreground`,
  },
  completed: {
    label: T.status.completed,
    Icon: Check,
    badge: 'secondary',
    rail: 'border-l-muted-foreground/50',
    block: `${BLOCK_BASE} border-l-muted-foreground/50 bg-muted text-muted-foreground`,
  },
  no_show: {
    label: T.status.no_show,
    Icon: UserX,
    badge: 'destructive',
    rail: 'border-l-destructive/70',
    block: `${BLOCK_BASE} border-l-destructive/70 bg-muted text-muted-foreground`,
  },
  cancelled: {
    label: T.status.cancelled,
    Icon: CalendarX,
    badge: 'outline',
    rail: 'border-l-border',
    block:
      'border border-dashed border-border bg-transparent text-muted-foreground line-through decoration-muted-foreground/60',
  },
}

/**
 * El ícono que va junto al nombre: "confirmó que va" gana sobre "confirmada".
 * Es un componente (y no una función que devuelve el ícono) para poder usarlo
 * dentro de otros sin crear componentes mientras se dibuja.
 */
export function StatusIcon({
  status,
  patientConfirmed,
  className,
}: {
  status: AppointmentStatus
  patientConfirmed: boolean
  className?: string
}) {
  const confirmedByPatient = patientConfirmed && (status === 'confirmed' || status === 'pending')
  const Icon = confirmedByPatient ? CheckCheck : STATUS_VISUAL[status].Icon
  return <Icon className={className} aria-hidden="true" />
}
