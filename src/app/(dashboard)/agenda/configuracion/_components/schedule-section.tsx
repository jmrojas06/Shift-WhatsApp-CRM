'use client'

// ============================================================
// Pestaña "Horarios": editor semanal por integrante del equipo. Cada día admite
// varios bloques (turnos partidos: 9–12 y 13–18). Guardar reemplaza
// el horario completo por diff en el servidor; la disponibilidad se
// recalcula al vuelo y las citas confirmadas no se tocan.
// ============================================================

import { useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AgendaLabels } from '@/verticals/agenda/labels'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { StaffRow, WorkingHoursRow } from './types'

interface BlockDraft {
  key: string
  start: string
  end: string
}

let blockSeq = 0
const nextKey = () => {
  blockSeq += 1
  return `blk-${blockSeq}`
}

type DayBlocks = Record<number, BlockDraft[]>

function blocksFromRows(
  staffId: string,
  rows: WorkingHoursRow[],
): DayBlocks {
  const byDay: DayBlocks = {}
  for (const row of rows) {
    if (row.staff_id !== staffId) continue
    const list = byDay[row.weekday] ?? []
    list.push({
      key: `db-${row.id}`,
      start: row.start_time.slice(0, 5),
      end: row.end_time.slice(0, 5),
    })
    byDay[row.weekday] = list
  }
  return byDay
}

interface ScheduleSectionProps {
  staff: StaffRow[]
  workingHours: WorkingHoursRow[]
  labels: AgendaLabels
  canEdit: boolean
  reload: () => Promise<void>
}

export function ScheduleSection({
  staff,
  workingHours,
  labels,
  canEdit,
  reload,
}: ScheduleSectionProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{
    staffId: string
    blocks: DayBlocks
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const activeStaffId = useMemo(() => {
    if (staff.length === 0) return null
    return staff.some((s) => s.id === selectedId) ? selectedId : staff[0].id
  }, [staff, selectedId])

  // Borrador de la edición en curso, atado a la persona elegida. Sin cambios,
  // se muestra lo que hay en la base: se deriva en render (sin
  // efectos) para no disparar cascadas de setState.
  const baseBlocks = useMemo(
    () => (activeStaffId ? blocksFromRows(activeStaffId, workingHours) : {}),
    [activeStaffId, workingHours],
  )
  const blocks =
    draft && draft.staffId === activeStaffId ? draft.blocks : baseBlocks

  function editBlocks(updater: (prev: DayBlocks) => DayBlocks) {
    if (!activeStaffId) return
    const current =
      draft && draft.staffId === activeStaffId ? draft.blocks : baseBlocks
    setDraft({ staffId: activeStaffId, blocks: updater(current) })
    setSaved(false)
  }

  function updateBlock(
    weekday: number,
    key: string,
    patch: Partial<Pick<BlockDraft, 'start' | 'end'>>,
  ) {
    editBlocks((prev) => ({
      ...prev,
      [weekday]: (prev[weekday] ?? []).map((block) =>
        block.key === key ? { ...block, ...patch } : block,
      ),
    }))
  }

  function addBlock(weekday: number) {
    editBlocks((prev) => ({
      ...prev,
      [weekday]: [
        ...(prev[weekday] ?? []),
        { key: nextKey(), start: '09:00', end: '18:00' },
      ],
    }))
  }

  function removeBlock(weekday: number, key: string) {
    editBlocks((prev) => ({
      ...prev,
      [weekday]: (prev[weekday] ?? []).filter((block) => block.key !== key),
    }))
  }

  async function handleSave() {
    if (!activeStaffId) return

    const rows: { weekday: number; start_time: string; end_time: string }[] = []
    for (const [dayStr, list] of Object.entries(blocks)) {
      const weekday = Number(dayStr)
      for (const block of list) {
        const start = block.start.trim()
        const end = block.end.trim()
        // Fila vacía (agregada y no usada): se ignora.
        if (!start && !end) continue
        if (!start || !end) {
          setError(T.config.validation.incompleteHours)
          return
        }
        rows.push({ weekday, start_time: start, end_time: end })
      }
    }

    setSaving(true)
    setError(null)
    setSaved(false)
    const res = await agendaConfigApi.saveHours(activeStaffId, rows)
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setDraft(null)
    setSaved(true)
    await reload()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.config.schedule.title}</CardTitle>
        <CardDescription>{T.config.schedule.subtitle(labels)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {staff.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {T.config.schedule.pickStaffEmpty()}
          </p>
        ) : (
          <>
            <div className="max-w-xs space-y-2">
              <Label htmlFor="schedule-staff">
                {T.config.schedule.pickStaff(labels)}
              </Label>
              <Select
                value={activeStaffId ?? undefined}
                onValueChange={(value) => {
                  setSelectedId(value)
                  setDraft(null)
                }}
              >
                <SelectTrigger id="schedule-staff" className="w-full">
                  <SelectValue>
                    {(value: string | null) => {
                      const member = staff.find((s) => s.id === value)
                      if (!member) return T.config.schedule.pickStaff(labels)
                      return member.is_active
                        ? member.name
                        : `${member.name} (${T.config.staff.inactive})`
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {staff.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                      {!member.is_active && ` (${T.config.staff.inactive})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">
              {T.config.schedule.hint}
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {T.config.schedule.weekdays.map((label, weekday) => {
                const list = blocks[weekday] ?? []
                return (
                  <div
                    key={weekday}
                    className="space-y-3 rounded-md border border-border p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{label}</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => addBlock(weekday)}
                        disabled={!canEdit || saving}
                      >
                        <Plus className="h-4 w-4" />
                        {T.config.schedule.addBlock}
                      </Button>
                    </div>

                    {list.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {T.config.schedule.empty}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {list.map((block) => (
                          <div
                            key={block.key}
                            className="flex items-center gap-2"
                          >
                            <Input
                              type="time"
                              value={block.start}
                              onChange={(e) =>
                                updateBlock(weekday, block.key, {
                                  start: e.target.value,
                                })
                              }
                              disabled={!canEdit || saving}
                              aria-label={`${label} — inicio`}
                              className="w-28"
                            />
                            <span className="text-sm text-muted-foreground">
                              –
                            </span>
                            <Input
                              type="time"
                              value={block.end}
                              onChange={(e) =>
                                updateBlock(weekday, block.key, {
                                  end: e.target.value,
                                })
                              }
                              disabled={!canEdit || saving}
                              aria-label={`${label} — fin`}
                              className="w-28"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeBlock(weekday, block.key)}
                              disabled={!canEdit || saving}
                              aria-label={T.config.schedule.removeBlock}
                              title={T.config.schedule.removeBlock}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {saved && !error && (
              <Alert>
                <AlertDescription>{T.config.saved}</AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end">
              <Button
                onClick={() => void handleSave()}
                disabled={!canEdit || saving}
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? T.config.saving : T.config.schedule.save}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
