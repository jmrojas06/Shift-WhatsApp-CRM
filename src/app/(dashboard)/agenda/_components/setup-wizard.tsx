'use client'

// ============================================================
// Asistente de arranque de /agenda (cuenta sin plantilla): el dueño
// elige su tipo de negocio y se aplica ese punto de partida con
// POST /api/verticals/agenda/setup. Al terminar, la página muestra el
// reporte de instalación y el botón "Ir a Configuración".
// ============================================================

import { useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { AGENDA_PRESETS, type PresetKey } from '@/verticals/agenda/presets'
import type { AgendaInstallReport } from '@/verticals/agenda/seed'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from '../configuracion/_components/api'
import { PresetCards } from './preset-cards'

interface SetupWizardProps {
  /** Owner/admin: los demás ven las tarjetas deshabilitadas. */
  canEdit: boolean
  /** Se llama con el reporte cuando la instalación terminó bien. */
  onInstalled: (report: AgendaInstallReport) => void | Promise<void>
}

export function SetupWizard({ canEdit, onInstalled }: SetupWizardProps) {
  const [busyKey, setBusyKey] = useState<PresetKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(key: PresetKey) {
    setBusyKey(key)
    setError(null)
    const res = await agendaConfigApi.installPreset(key)
    if (!res.ok) {
      setBusyKey(null)
      setError(res.error || T.installFailed)
      return
    }
    await onInstalled(res.data.report)
    setBusyKey(null)
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">{T.wizard.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{T.wizard.hint}</p>
      </div>

      <PresetCards
        currentKey={null}
        disabled={!canEdit || busyKey !== null}
        busyKey={busyKey}
        disabledReason={T.readOnly(T.wizard.viewerGate)}
        onSelect={(key) => void choose(key)}
      />

      {busyKey && (
        <p className="text-sm text-muted-foreground" role="status">
          {T.wizard.installingNamed(AGENDA_PRESETS[busyKey].name)}
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
