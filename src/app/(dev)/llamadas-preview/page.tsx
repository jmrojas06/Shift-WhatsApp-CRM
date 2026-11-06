import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CallListPreview, type PreviewState } from './preview-client'

// ============================================================
// /llamadas-preview — SOLO desarrollo.
//
// Muestra "Para llamar" y "Sin marcar" con datos de ejemplo en memoria, para
// revisar el diseño con capturas sin tocar la base de datos. En producción la
// ruta no existe (404). No pasa por el layout del panel ni lee Supabase.
//
//   ?viewer=1       un viewer: la lista sin botones de acción
//   ?robot=0        las llamadas del robot apagadas (sin "Llamar con el robot")
//   ?clinic=0       un negocio que no es clínica (sin nombre de paciente)
//   ?state=loading|error|empty|unavailable
// ============================================================

export const metadata: Metadata = {
  title: 'Vista previa de Para llamar',
  robots: { index: false, follow: false },
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

const STATES: readonly PreviewState[] = ['loading', 'error', 'empty', 'unavailable']

export default async function CallListPreviewPage({ searchParams }: PageProps) {
  if (process.env.NODE_ENV === 'production') notFound()

  const params = await searchParams
  const state = STATES.find((s) => s === first(params.state)) ?? 'normal'
  return (
    <CallListPreview
      viewer={first(params.viewer) === '1'}
      robot={first(params.robot) !== '0'}
      clinic={first(params.clinic) !== '0'}
      state={state}
    />
  )
}
