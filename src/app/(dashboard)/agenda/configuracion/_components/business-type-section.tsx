'use client'

// ============================================================
// Pestaña "Tipo de negocio": punto de partida + palabras.
//
// Cambiar de tipo pasa por POST /setup (única vía: PATCH /config no
// acepta el tipo) y pide confirmación. Aplicar un tipo fija las
// palabras y cómo se muestran los servicios, y AGREGA lo que falte
// (servicios, horario de ejemplo, preguntas); nunca borra ni
// desactiva nada del dueño. Las palabras se guardan aparte con
// PATCH /config: una palabra vacía vuelve a la de por defecto.
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DEFAULT_LABELS,
  LABEL_KEYS,
  LABEL_MAX,
} from '@/verticals/agenda/labels'
import {
  buildLabelsPayload,
  checkLabelDrafts,
  labelDraftMessage,
  labelDrafts,
  presetConfirmCopy,
  savedLabelDrafts,
  type LabelDrafts,
  type PresetConfirmCopy,
} from '@/verticals/agenda/panel'
import { AGENDA_PRESETS, type PresetKey } from '@/verticals/agenda/presets'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { PresetCards } from '../../_components/preset-cards'
import { agendaConfigApi } from './api'
import type { SettingsRow } from './types'

interface BusinessTypeSectionProps {
  settings: SettingsRow
  canEdit: boolean
  reload: () => Promise<void>
}

export function BusinessTypeSection({
  settings,
  canEdit,
  reload,
}: BusinessTypeSectionProps) {
  const [drafts, setDrafts] = useState<LabelDrafts>(() =>
    labelDrafts(settings.labels, DEFAULT_LABELS),
  )
  // El diálogo conserva el último tipo y su texto al cerrarse: así no se
  // queda en blanco durante la animación de salida.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pending, setPending] = useState<PresetKey | null>(null)
  const [confirm, setConfirm] = useState<PresetConfirmCopy | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [savingWords, setSavingWords] = useState(false)
  const [wordsError, setWordsError] = useState<string | null>(null)
  const [wordsSaved, setWordsSaved] = useState(false)

  function choose(key: PresetKey) {
    setApplyError(null)
    setNotice(null)
    setPending(key)
    setConfirm(presetConfirmCopy(settings.preset_key, key, settings.labels))
    setDialogOpen(true)
  }

  async function applyPreset(key: PresetKey) {
    setApplying(true)
    setApplyError(null)
    const res = await agendaConfigApi.installPreset(key)
    setApplying(false)
    if (!res.ok) {
      setApplyError(res.error)
      return
    }
    // Volver a aplicar el tipo actual no toca las palabras; cambiar de tipo sí.
    if (settings.preset_key !== key) {
      setDrafts(labelDrafts(AGENDA_PRESETS[key].labels, DEFAULT_LABELS))
      setWordsError(null)
      setWordsSaved(false)
    }
    setDialogOpen(false)
    setNotice(T.config.type.applied(AGENDA_PRESETS[key].name))
    await reload()
  }

  async function saveWords() {
    setWordsSaved(false)
    const check = checkLabelDrafts(drafts)
    if (!check.ok) {
      setWordsError(labelDraftMessage(check))
      return
    }
    setSavingWords(true)
    setWordsError(null)
    const res = await agendaConfigApi.patchConfig({
      labels: buildLabelsPayload(drafts),
    })
    setSavingWords(false)
    if (!res.ok) {
      setWordsError(res.error)
      return
    }
    // El formulario muestra lo que quedó guardado (palabras normalizadas y
    // las de por defecto otra vez vacías).
    setDrafts(savedLabelDrafts(drafts))
    setWordsSaved(true)
    await reload()
  }

  const busy = applying || savingWords

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{T.config.type.title}</CardTitle>
          <CardDescription>{T.config.type.hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PresetCards
            currentKey={settings.preset_key}
            disabled={!canEdit || busy}
            disabledReason={T.readOnly(T.config.type.viewerGate)}
            onSelect={choose}
          />
          {!canEdit && (
            <p className="text-xs text-muted-foreground">
              {T.wizard.readOnlyNote}
            </p>
          )}
          {notice && (
            <Alert role="status">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{T.config.type.wordsTitle}</CardTitle>
          <CardDescription>{T.config.type.wordsHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {LABEL_KEYS.map((key) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`label-${key}`}>
                  {T.config.type.words[key]}
                </Label>
                <Input
                  id={`label-${key}`}
                  value={drafts[key]}
                  placeholder={DEFAULT_LABELS[key]}
                  // El tope real son LABEL_MAX caracteres (un emoji cuenta 1);
                  // el input cuenta unidades UTF-16, así que deja el doble y
                  // el aviso de arriba hace cumplir el límite exacto.
                  maxLength={LABEL_MAX * 2}
                  disabled={!canEdit || busy}
                  onChange={(e) => {
                    // Editar vuelve a dejar los cambios sin guardar.
                    setWordsSaved(false)
                    setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                  }}
                />
              </div>
            ))}
          </div>

          {wordsError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{wordsError}</AlertDescription>
            </Alert>
          )}
          {wordsSaved && !wordsError && (
            <Alert role="status">
              <AlertDescription>{T.config.saved}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end">
            <Button
              onClick={() => void saveWords()}
              disabled={!canEdit || busy}
              title={canEdit ? undefined : T.readOnly(T.config.viewerGate)}
            >
              {savingWords && <Loader2 className="h-4 w-4 animate-spin" />}
              {savingWords ? T.config.saving : T.config.type.saveWords}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && !applying) setDialogOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.body}</DialogDescription>
          </DialogHeader>
          {applyError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{applyError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={applying}
            >
              {T.config.type.cancel}
            </Button>
            <Button
              onClick={() => pending && void applyPreset(pending)}
              disabled={applying}
            >
              {applying && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirm?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
