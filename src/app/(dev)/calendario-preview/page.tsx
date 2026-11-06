import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { CalendarPreview } from './preview-client'

// ============================================================
// /calendario-preview — SOLO desarrollo.
//
// Muestra el calendario con datos de ejemplo en memoria, para revisar el
// diseño con capturas sin tocar la base de datos. En producción la ruta
// no existe (404). No pasa por el layout del panel ni lee Supabase.
//
//   ?view=day|week   ?clinic=0|1   ?viewer=1   ?date=YYYY-MM-DD
// ============================================================

export const metadata: Metadata = {
  title: 'Vista previa del calendario',
  robots: { index: false, follow: false },
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

export default async function CalendarPreviewPage({ searchParams }: PageProps) {
  if (process.env.NODE_ENV === 'production') notFound()

  const params = await searchParams
  const date = first(params.date)
  return (
    <CalendarPreview
      view={first(params.view) === 'week' ? 'week' : 'day'}
      clinic={first(params.clinic) !== '0'}
      viewer={first(params.viewer) === '1'}
      dateKey={date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''}
    />
  )
}
