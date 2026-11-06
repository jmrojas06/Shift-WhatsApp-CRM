'use client'

// ============================================================
// Vista previa de "Para llamar" y "Sin marcar" con datos de ejemplo (solo
// desarrollo). Usa los mismos componentes que /agenda, pero con un cliente de
// la API EN MEMORIA: no llama a la red, no lee Supabase y no escribe nada.
// ============================================================

import { useMemo, useState } from 'react'

import { CallListSection } from '@/app/(dashboard)/agenda/_components/call-list-section'
import { UnmarkedSection } from '@/app/(dashboard)/agenda/_components/unmarked-section'
import type { ApiResult } from '@/verticals/agenda/calendar-api'
import type { CallListApi } from '@/verticals/agenda/call-list-api'
import type { CallListRow } from '@/verticals/agenda/call-list'
import { DEFAULT_LABELS, resolveLabels } from '@/verticals/agenda/labels'

import { PREVIEW_NOW, PREVIEW_UNMARKED, previewCallRows } from './fake-data'

export type PreviewState = 'normal' | 'loading' | 'error' | 'empty' | 'unavailable'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data })

interface PreviewProps {
  viewer: boolean
  robot: boolean
  clinic: boolean
  state: PreviewState
}

export function CallListPreview({ viewer, robot, clinic, state }: PreviewProps) {
  const [unmarked, setUnmarked] = useState(PREVIEW_UNMARKED)
  const [changingId, setChangingId] = useState<string | null>(null)

  const labels = useMemo(
    () =>
      clinic
        ? resolveLabels({ profesional: 'doctor', profesionales: 'doctores', cita: 'cita', citas: 'citas' })
        : DEFAULT_LABELS,
    [clinic],
  )

  // El "servidor" de ejemplo: la lista vive en esta variable y los métodos la cambian.
  const api = useMemo<CallListApi>(() => {
    const store: { rows: CallListRow[] } = { rows: state === 'empty' ? [] : previewCallRows(clinic) }
    const patch = (id: string, fn: (row: CallListRow) => CallListRow) => {
      store.rows = store.rows.map((row) => (row.appointmentId === id ? fn(row) : row))
    }

    return {
      async list() {
        // Nunca termina: para ver el esqueleto de carga.
        if (state === 'loading') return new Promise<ApiResult<never>>(() => {})
        await wait(350)
        if (state === 'error') return { ok: false, status: 500, code: null, error: 'Error interno.' }
        if (state === 'unavailable') {
          return { ok: false, status: 503, code: 'migration_missing', error: 'Falta actualizar la base de datos.' }
        }
        return ok({ rows: store.rows, outboundEnabled: robot })
      },

      async record({ appointmentId, outcome }) {
        await wait(500)
        if (outcome === 'confirmed' || outcome === 'cancelled') {
          store.rows = store.rows.filter((row) => row.appointmentId !== appointmentId)
          return ok({ recorded: true, note: null, notified: outcome === 'cancelled' ? true : null, notifyError: null })
        }
        patch(appointmentId, (row) => ({
          ...row,
          manualAttempts: row.manualAttempts + 1,
          lastManual: {
            outcome,
            status: outcome === 'no_response' ? 'no_answer' : 'completed',
            at: PREVIEW_NOW.toISOString(),
          },
        }))
        return ok({ recorded: true, note: null, notified: null, notifyError: null })
      },

      async robotCall(appointmentId) {
        await wait(600)
        patch(appointmentId, (row) => ({
          ...row,
          robotAttempts: row.robotAttempts + 1,
          robotInProgress: true,
          canRobotCall: false,
          lastRobot: { outcome: null, status: 'calling', at: PREVIEW_NOW.toISOString() },
        }))
        return ok({ attempt: 1 })
      },
    }
  }, [state, robot, clinic])

  return (
    <div className="mx-auto max-w-[800px] space-y-6 p-4 sm:p-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-foreground">Agenda</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Vista previa con datos de ejemplo. Nada de esto se guarda.
        </p>
      </div>

      <CallListSection api={api} labels={labels} canAct={!viewer} fixedNow={PREVIEW_NOW} />

      <UnmarkedSection
        items={state === 'empty' ? [] : unmarked}
        canAct={!viewer}
        changingId={changingId}
        serviceGone="Servicio eliminado"
        staffGone="Sin asignar"
        onMark={(id) => {
          setChangingId(id)
          void wait(500).then(() => {
            setUnmarked((list) => list.filter((item) => item.id !== id))
            setChangingId(null)
          })
        }}
      />
    </div>
  )
}
