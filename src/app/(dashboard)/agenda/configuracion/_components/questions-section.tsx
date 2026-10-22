'use client'

// ============================================================
// Pestaña "Preguntas": lo que el bot pregunta después de elegir la
// hora y antes del resumen (dirección, placa, motivo…). Máximo
// MAX_QUESTIONS activas. Editar reemplaza la definición completa;
// quitar solo desactiva (las citas guardan sus respuestas por id).
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircleQuestion, Pencil, Plus, Trash2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { AgendaLabels } from '@/verticals/agenda/labels'
import {
  buildQuestionBody,
  draftFromQuestion,
  EMPTY_QUESTION_DRAFT,
  questionLabelLength,
  questionsRemaining,
  type QuestionDraft,
} from '@/verticals/agenda/panel'
import {
  QUESTION_KINDS,
  QUESTION_LABEL_MAX,
  validateQuestionCreate,
  type QuestionKind,
} from '@/verticals/agenda/questions'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { QuestionRow } from './types'

interface QuestionsSectionProps {
  questions: QuestionRow[]
  labels: AgendaLabels
  canEdit: boolean
  reload: () => Promise<void>
}

export function QuestionsSection({
  questions,
  labels,
  canEdit,
  reload,
}: QuestionsSectionProps) {
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_QUESTION_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // El diálogo de quitar conserva la última pregunta al cerrarse (sin texto en blanco).
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState<QuestionRow | null>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  // Cada clic en "Editar" cuenta, aunque sea la misma pregunta.
  const [editRequest, setEditRequest] = useState(0)

  const remaining = questionsRemaining(questions.length)
  const editing = draft.id !== null
  // Editar una existente siempre se puede; agregar solo si queda cupo.
  const showForm = editing || remaining > 0
  const busy = saving || busyId !== null

  // Al empezar a editar, el formulario queda a la vista y con el foco en la pregunta.
  useEffect(() => {
    if (editRequest === 0) return
    const input = labelRef.current
    if (!input) return
    input.focus()
    input.scrollIntoView({ block: 'nearest' })
  }, [editRequest])

  function startEdit(question: QuestionRow) {
    setFormError(null)
    setDraft(draftFromQuestion(question))
    setEditRequest((n) => n + 1)
  }

  function resetForm() {
    setFormError(null)
    setDraft(EMPTY_QUESTION_DRAFT)
  }

  async function save() {
    const check = validateQuestionCreate(buildQuestionBody(draft))
    if (!check.ok) {
      setFormError(check.message)
      return
    }
    setSaving(true)
    setFormError(null)
    // El PATCH reemplaza la definición completa: siempre van todos los campos.
    const res = draft.id
      ? await agendaConfigApi.updateQuestion(draft.id, check.value)
      : await agendaConfigApi.createQuestion(check.value)
    setSaving(false)
    if (!res.ok) {
      setFormError(res.error)
      return
    }
    setDraft(EMPTY_QUESTION_DRAFT)
    await reload()
  }

  async function remove(question: QuestionRow) {
    setBusyId(question.id)
    setListError(null)
    const res = await agendaConfigApi.deleteQuestion(question.id)
    setBusyId(null)
    setRemoveOpen(false)
    if (!res.ok) {
      setListError(res.error)
      return
    }
    if (draft.id === question.id) setDraft(EMPTY_QUESTION_DRAFT)
    await reload()
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{T.config.questions.title}</CardTitle>
          <CardDescription>{T.config.questions.hint(labels)}</CardDescription>
          <CardAction>
            <Badge variant="outline">
              {T.config.questions.count(questions.length)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {listError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{listError}</AlertDescription>
            </Alert>
          )}

          {questions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <MessageCircleQuestion className="mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {T.config.questions.empty}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {questions.map((question) => (
                <li
                  key={question.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 break-words">
                    <p className="text-sm font-medium">{question.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {T.config.questions.kinds[question.kind]} ·{' '}
                      {question.required
                        ? T.config.questions.required
                        : T.config.questions.optional}
                      {question.kind === 'opcion' &&
                        ` · ${question.options.join(', ')}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(question)}
                      disabled={!canEdit || busy}
                      aria-label={`${T.config.questions.edit}: ${question.label}`}
                      title={T.config.questions.edit}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        setRemoving(question)
                        setRemoveOpen(true)
                      }}
                      disabled={!canEdit || busy}
                      aria-label={`${T.config.questions.remove}: ${question.label}`}
                      title={T.config.questions.remove}
                    >
                      {busyId === question.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            {T.config.questions.remaining(remaining)}
          </p>
        </CardContent>
      </Card>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>
              {editing
                ? T.config.questions.editTitle
                : T.config.questions.addTitle}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="question-label">
                {T.config.questions.label}
              </Label>
              <Input
                id="question-label"
                ref={labelRef}
                value={draft.label}
                placeholder={T.config.questions.labelPlaceholder}
                // El tope real son QUESTION_LABEL_MAX caracteres (un emoji
                // cuenta 1); el validador de abajo hace cumplir el límite exacto.
                maxLength={QUESTION_LABEL_MAX * 2}
                disabled={!canEdit || busy}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, label: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {T.config.questions.labelHint(questionLabelLength(draft.label))}
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="question-kind">{T.config.questions.kind}</Label>
                <Select
                  value={draft.kind}
                  onValueChange={(value) => {
                    if (value) {
                      setDraft((prev) => ({
                        ...prev,
                        kind: value as QuestionKind,
                      }))
                    }
                  }}
                  disabled={!canEdit || busy}
                >
                  <SelectTrigger id="question-kind" className="w-full">
                    <SelectValue>
                      {(value: string | null) =>
                        value
                          ? T.config.questions.kinds[value as QuestionKind]
                          : ''
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {QUESTION_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {T.config.questions.kinds[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="question-required">
                  {T.config.questions.required}
                </Label>
                <div className="flex h-8 items-center gap-3">
                  <Switch
                    id="question-required"
                    checked={draft.required}
                    onCheckedChange={(next) =>
                      setDraft((prev) => ({ ...prev, required: next }))
                    }
                    aria-describedby="question-required-hint"
                    disabled={!canEdit || busy}
                  />
                  <span
                    id="question-required-hint"
                    className="text-xs text-muted-foreground"
                  >
                    {T.config.questions.requiredHint}
                  </span>
                </div>
              </div>
            </div>

            {draft.kind === 'opcion' && (
              <div className="space-y-2">
                <Label htmlFor="question-options">
                  {T.config.questions.options}
                </Label>
                <Textarea
                  id="question-options"
                  rows={4}
                  value={draft.optionsText}
                  placeholder={T.config.questions.optionsPlaceholder}
                  aria-describedby="question-options-hint"
                  disabled={!canEdit || busy}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      optionsText: e.target.value,
                    }))
                  }
                />
                <p
                  id="question-options-hint"
                  className="text-xs text-muted-foreground"
                >
                  {T.config.questions.optionsHint}
                </p>
              </div>
            )}

            {formError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {editing && (
                <Button
                  variant="outline"
                  onClick={resetForm}
                  disabled={busy}
                >
                  {T.config.questions.cancel}
                </Button>
              )}
              <Button
                onClick={() => void save()}
                disabled={!canEdit || busy}
                title={canEdit ? undefined : T.readOnly(T.config.questions.viewerGate)}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  !editing && <Plus className="h-4 w-4" />
                )}
                {saving
                  ? T.config.saving
                  : editing
                    ? T.config.questions.saveEdit
                    : T.config.questions.save}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Confirmación para quitar: no hay botón para reactivar una pregunta. */}
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!open && busyId === null) setRemoveOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{T.config.questions.removeTitle}</DialogTitle>
            <DialogDescription className="break-words">
              {removing &&
                `"${removing.label}". ${T.config.questions.removeBody}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveOpen(false)}
              disabled={busyId !== null}
            >
              {T.config.questions.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => removing && void remove(removing)}
              disabled={busyId !== null}
            >
              {busyId !== null && <Loader2 className="h-4 w-4 animate-spin" />}
              {T.config.questions.removeYes}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
