'use client'

// ============================================================
// Tarjeta "Llamadas" de Configuración (solo owner/admin; la página ni la
// monta para los demás roles).
//
// Qué deja hacer:
//   - Prender las llamadas de confirmación (salientes) y la atención de
//     llamadas entrantes. Si el servidor no tiene Telnyx, o Shift todavía no
//     asignó el número, el interruptor apagado queda deshabilitado y la
//     tarjeta dice por qué; todo lo demás sí se puede guardar.
//   - Ver los números que fija Shift (solo lectura) y poner hasta 3
//     teléfonos de asesores.
//   - Horario de atención por día, texto de horario y dirección, ventana de
//     las salientes, intentos y espera, y lo usado del tope del mes.
//   - "Probar llamada": llama a un número con un guion de ejemplo.
//
// Todo va por /api/verticals/agenda/call-settings (y calls/test): el
// navegador nunca toca la base. Solo se manda lo que cambió y jamás los
// campos de Shift. Diseño: paleta suave del CRM (tokens, sin colores
// nuevos), un solo acento, botones de 44 px en pantallas táctiles y
// movimiento apagado con reduced-motion.
// ============================================================

import { useEffect, useState } from 'react'
import {
  CircleCheck,
  Loader2,
  Lock,
  Phone,
  PhoneCall,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { cn } from '@/lib/utils'
import type { CallSettingsResponse } from '@/verticals/agenda/voice/call-settings-payload'
import {
  MAX_ADVISOR_PHONES,
  MAX_INFO_TEXT,
  toE164,
} from '@/verticals/agenda/voice/settings'

import { callSettingsApi } from './api'
import { buildPatch, checkPatch, draftFromSettings, type CallsDraft } from './calls-draft'
import { HoursEditor } from './calls-hours-editor'
import { CALLS_TEXTS as C } from './calls-texts'

// ------------------------------------------------------------
// Tarjeta (carga, guardado y prueba)
// ------------------------------------------------------------

type TestState =
  | { kind: 'idle' }
  | { kind: 'calling' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }

export function CallsSection() {
  const [data, setData] = useState<CallSettingsResponse | null>(null)
  const [draft, setDraft] = useState<CallsDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [testPhone, setTestPhone] = useState('')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await callSettingsApi.get()
      if (cancelled) return
      if (res.ok) {
        setData(res.data)
        setDraft(draftFromSettings(res.data.settings))
        setLoadError(null)
      } else {
        setLoadError(res.error)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const patch = data && draft ? buildPatch(data.settings, draft) : {}
  const dirty = Object.keys(patch).length > 0

  function changeDraft(next: CallsDraft) {
    setDraft(next)
    setSaved(false)
    setFormError(null)
  }

  async function save() {
    if (!data || !dirty) return
    // Mismo validador que el servidor: se avisa antes de salir.
    const message = checkPatch(patch)
    if (message) {
      setFormError(message)
      return
    }
    setSaving(true)
    setSaved(false)
    setFormError(null)
    const res = await callSettingsApi.save(patch)
    setSaving(false)
    if (!res.ok) {
      setFormError(res.error)
      return
    }
    setData(res.data)
    setDraft(draftFromSettings(res.data.settings))
    setSaved(true)
  }

  function discard() {
    if (!data) return
    setDraft(draftFromSettings(data.settings))
    setSaved(false)
    setFormError(null)
  }

  async function runTest() {
    const to = toE164(testPhone)
    if (!to) {
      setTest({ kind: 'error', message: C.testPhoneInvalid })
      return
    }
    setTest({ kind: 'calling' })
    const res = await callSettingsApi.test(to)
    if (!res.ok) {
      setTest({ kind: 'error', message: res.error })
      return
    }
    setTest({ kind: 'ok' })
    // La prueba es una llamada real: se vuelve a leer lo usado del mes. Solo
    // el uso, para no pisar lo que la persona esté editando.
    const fresh = await callSettingsApi.get()
    if (fresh.ok) {
      setData((current) => (current ? { ...current, usage: fresh.data.usage } : current))
    }
  }

  const anyOn = data !== null && (data.settings.outbound_enabled || data.settings.inbound_enabled)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl',
              anyOn ? 'bg-success/12 text-success' : 'bg-muted text-muted-foreground',
            )}
          >
            <Phone className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle>{C.title}</CardTitle>
            <CardDescription>{C.description}</CardDescription>
          </div>
          {data && (
            <Badge variant={!data.telnyx.configured ? 'warning' : anyOn ? 'success' : 'outline'}>
              {!data.telnyx.configured ? C.statusPending : anyOn ? C.statusActive : C.statusOff}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading ? (
          <div role="status" className="space-y-3">
            <span className="sr-only">{C.loading}</span>
            <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          </div>
        ) : loadError || !data || !draft ? (
          <div className="space-y-3">
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{loadError ?? C.loadFailed}</AlertDescription>
            </Alert>
            <Button
              variant="outline"
              onClick={() => {
                setLoading(true)
                setReloadKey((key) => key + 1)
              }}
            >
              {C.retry}
            </Button>
          </div>
        ) : (
          <CallsForm
            data={data}
            draft={draft}
            onDraftChange={changeDraft}
            dirty={dirty}
            saving={saving}
            saved={saved}
            formError={formError}
            onSave={() => void save()}
            onDiscard={discard}
            testPhone={testPhone}
            onTestPhoneChange={(value) => {
              setTestPhone(value)
              if (test.kind !== 'calling') setTest({ kind: 'idle' })
            }}
            test={test}
            onTest={() => void runTest()}
          />
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------
// Formulario
// ------------------------------------------------------------

export interface CallsFormProps {
  data: CallSettingsResponse
  draft: CallsDraft
  onDraftChange: (next: CallsDraft) => void
  dirty: boolean
  saving: boolean
  saved: boolean
  formError: string | null
  onSave: () => void
  onDiscard: () => void
  testPhone: string
  onTestPhoneChange: (value: string) => void
  test: TestState
  onTest: () => void
}

export function CallsForm({
  data,
  draft,
  onDraftChange,
  dirty,
  saving,
  saved,
  formError,
  onSave,
  onDiscard,
  testPhone,
  onTestPhoneChange,
  test,
  onTest,
}: CallsFormProps) {
  const { settings, usage, telnyx } = data
  const set = (change: Partial<CallsDraft>) => onDraftChange({ ...draft, ...change })

  // Apagado y sin lo que hace falta → no se puede prender. Si ya estaba
  // prendido (lo guardado), siempre se puede apagar.
  const outboundNumber = settings.caller_id ?? settings.inbound_number
  const outboundBlocked = settings.outbound_enabled
    ? null
    : !telnyx.configured
      ? C.notReadyTelnyx
      : !outboundNumber
        ? C.notReadyOutboundNumber
        : null
  const inboundBlocked = settings.inbound_enabled
    ? null
    : !telnyx.configured
      ? C.notReadyTelnyx
      : !settings.inbound_number
        ? C.notReadyInboundNumber
        : null

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Alert>
          <PhoneCall />
          <AlertDescription className="text-foreground">{C.costNotice}</AlertDescription>
        </Alert>
        {!telnyx.configured && (
          <Alert className="border-warning/40">
            <TriangleAlert className="text-warning" />
            <AlertDescription className="text-foreground">{C.telnyxMissing}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="space-y-5">
        <ToggleRow
          id="calls-outbound"
          title={C.outboundTitle}
          hint={C.outboundHint}
          checked={draft.outboundEnabled}
          blockedReason={outboundBlocked}
          disabled={outboundBlocked !== null || saving}
          onChange={(next) => set({ outboundEnabled: next })}
        />
        <ToggleRow
          id="calls-inbound"
          title={C.inboundTitle}
          hint={C.inboundHint}
          checked={draft.inboundEnabled}
          blockedReason={inboundBlocked}
          disabled={inboundBlocked !== null || saving}
          onChange={(next) => set({ inboundEnabled: next })}
        />
      </div>

      <Group titleId="calls-numbers-title" title={C.numbersTitle} hint={C.numbersHint}>
        <dl className="grid gap-4 sm:grid-cols-2">
          <ShiftNumber label={C.inboundNumber} value={settings.inbound_number} />
          <ShiftNumber label={C.callerId} value={outboundNumber} />
        </dl>
        <AdvisorPhones
          phones={draft.advisorPhones}
          disabled={saving}
          onChange={(advisorPhones) => set({ advisorPhones })}
        />
      </Group>

      <Group>
        <HoursEditor hours={draft.hours} disabled={saving} onChange={(hours) => set({ hours })} />
      </Group>

      <Group>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="calls-info">{C.infoLabel}</Label>
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              {C.infoCount([...draft.infoText].length, MAX_INFO_TEXT)}
            </span>
          </div>
          <Textarea
            id="calls-info"
            value={draft.infoText}
            maxLength={MAX_INFO_TEXT}
            rows={3}
            disabled={saving}
            placeholder={C.infoPlaceholder}
            aria-describedby="calls-info-hint"
            onChange={(e) => set({ infoText: e.target.value })}
          />
          <p id="calls-info-hint" className="max-w-[65ch] text-xs text-muted-foreground">
            {C.infoHint}
          </p>
        </div>
      </Group>

      <Group titleId="calls-outbound-title" title={C.outboundSectionTitle}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TimeField
            id="calls-window-start"
            label={C.windowStart}
            value={draft.windowStart}
            disabled={saving}
            onChange={(windowStart) => set({ windowStart })}
          />
          <TimeField
            id="calls-window-end"
            label={C.windowEnd}
            value={draft.windowEnd}
            disabled={saving}
            onChange={(windowEnd) => set({ windowEnd })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{C.windowHint}</p>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="calls-saturday" className="leading-snug">
            {C.saturday}
          </Label>
          <Switch
            id="calls-saturday"
            checked={draft.callSaturday}
            disabled={saving}
            onCheckedChange={(next) => set({ callSaturday: next })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="calls-attempts">{C.attempts}</Label>
            <Select
              value={draft.maxAttempts}
              onValueChange={(next) => {
                if (next) set({ maxAttempts: next })
              }}
              disabled={saving}
            >
              <SelectTrigger id="calls-attempts" className="w-full" aria-describedby="calls-attempts-hint">
                <SelectValue>
                  {(current: string | null) => C.attemptsOption(Number(current ?? draft.maxAttempts))}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {C.attemptsOption(count)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="calls-attempts-hint" className="text-xs text-muted-foreground">
              {C.attemptsHint}
            </p>
          </div>
          <MinutesField
            id="calls-retry"
            label={C.retryMinutes}
            hint={C.retryHint}
            value={draft.retryMinutes}
            disabled={saving}
            onChange={(retryMinutes) => set({ retryMinutes })}
          />
          <MinutesField
            id="calls-after"
            label={C.callAfterMinutes}
            hint={C.callAfterHint}
            value={draft.callAfterMinutes}
            disabled={saving}
            onChange={(callAfterMinutes) => set({ callAfterMinutes })}
          />
          <MinutesField
            id="calls-lead"
            label={C.minLeadMinutes}
            hint={C.minLeadHint}
            value={draft.minLeadMinutes}
            disabled={saving}
            onChange={(minLeadMinutes) => set({ minLeadMinutes })}
          />
        </div>

        <UsageMeter used={usage.used} limit={settings.monthly_limit} />
      </Group>

      <Group titleId="calls-test-title" title={C.testTitle} hint={C.testHint}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="calls-test-phone">{C.testLabel}</Label>
            <Input
              id="calls-test-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={testPhone}
              placeholder={C.testPlaceholder}
              disabled={!telnyx.configured || test.kind === 'calling'}
              aria-invalid={test.kind === 'error' ? true : undefined}
              aria-describedby="calls-test-status"
              onChange={(e) => onTestPhoneChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onTest()
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!telnyx.configured || test.kind === 'calling' || testPhone.trim() === ''}
            onClick={onTest}
          >
            {test.kind === 'calling' ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <PhoneCall />
            )}
            {test.kind === 'calling' ? C.testCalling : C.testButton}
          </Button>
        </div>
        <div id="calls-test-status" aria-live="polite" className="min-h-5 text-xs">
          {!telnyx.configured ? (
            <span className="text-muted-foreground">{C.testNeedsTelnyx}</span>
          ) : test.kind === 'ok' ? (
            <span className="inline-flex items-center gap-1.5 text-success">
              <CircleCheck className="size-3.5" aria-hidden="true" />
              {C.testSuccess}
            </span>
          ) : test.kind === 'error' ? (
            <span className="text-destructive">{test.message}</span>
          ) : null}
        </div>
      </Group>

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div aria-live="polite" className="min-h-5 text-sm">
          {formError ? (
            <span className="text-destructive">{formError}</span>
          ) : saved && !dirty ? (
            <span className="inline-flex items-center gap-1.5 text-success">
              <CircleCheck className="size-4" aria-hidden="true" />
              {C.saved}
            </span>
          ) : dirty ? (
            <span className="text-muted-foreground">{C.unsaved}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && (
            <Button type="button" variant="ghost" disabled={saving} onClick={onDiscard}>
              {C.discard}
            </Button>
          )}
          <Button type="button" disabled={!dirty || saving} onClick={onSave}>
            {saving && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {saving ? C.saving : C.save}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Piezas
// ------------------------------------------------------------

function Group({
  title,
  titleId,
  hint,
  children,
}: {
  title?: string
  titleId?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={title ? titleId : undefined} className="space-y-4 border-t border-border pt-5">
      {title && (
        <div className="space-y-1">
          <h3 id={titleId} className="font-heading text-sm font-medium">
            {title}
          </h3>
          {hint && <p className="max-w-[65ch] text-xs text-muted-foreground">{hint}</p>}
        </div>
      )}
      {children}
    </section>
  )
}

function ToggleRow({
  id,
  title,
  hint,
  checked,
  blockedReason,
  disabled,
  onChange,
}: {
  id: string
  title: string
  hint: string
  checked: boolean
  blockedReason: string | null
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p id={`${id}-title`} className="text-sm font-medium">
          {title}
        </p>
        <p id={`${id}-hint`} className="max-w-[65ch] text-xs text-muted-foreground">
          {hint}
        </p>
        {blockedReason && <p className="text-xs text-warning">{blockedReason}</p>}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
      />
    </div>
  )
}

/** Un número que fija Shift: se ve, no se edita. */
function ShiftNumber({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="size-3" aria-hidden="true" />
        {label}
      </dt>
      <dd className={cn('truncate text-sm', value ? 'font-medium' : 'text-muted-foreground')}>
        {value ?? C.numberPending}
      </dd>
    </div>
  )
}

function AdvisorPhones({
  phones,
  disabled,
  onChange,
}: {
  phones: string[]
  disabled: boolean
  onChange: (next: string[]) => void
}) {
  return (
    <div className="space-y-2">
      <p id="calls-advisors-label" className="text-sm leading-none font-medium">
        {C.advisorsLabel}
      </p>
      <p className="max-w-[65ch] text-xs text-muted-foreground">{C.advisorsHint}</p>
      <div role="group" aria-labelledby="calls-advisors-label" className="space-y-2">
        {phones.map((phone, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              placeholder={C.advisorPlaceholder}
              disabled={disabled}
              aria-label={C.advisorAria(index + 1)}
              className="max-w-xs"
              onChange={(e) => onChange(phones.map((p, i) => (i === index ? e.target.value : p)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={C.advisorRemove(index + 1)}
              onClick={() => onChange(phones.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
      {phones.length === 0 && <p className="text-xs text-muted-foreground">{C.advisorsEmpty}</p>}
      {phones.length < MAX_ADVISOR_PHONES && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...phones, ''])}
        >
          <Plus />
          {C.advisorAdd}
        </Button>
      )}
    </div>
  )
}

function TimeField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: string
  disabled: boolean
  onChange: (next: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="time"
        step={60}
        value={value}
        disabled={disabled}
        className="sm:max-w-40"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function MinutesField({
  id,
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  disabled: boolean
  onChange: (next: string) => void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        className="sm:max-w-40"
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}

/** Lo usado del tope del mes. El tope lo fija Shift: aquí solo se ve. */
export function UsageMeter({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, limit - used)
  const full = used >= limit
  const low = !full && left <= Math.max(1, Math.ceil(limit * 0.1))
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100

  return (
    <div className="space-y-2 rounded-lg bg-muted/60 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span id="calls-usage-label" className="text-sm font-medium">
          {C.usageTitle}
        </span>
        <span className="text-sm tabular-nums">{C.usageValue(used, limit)}</span>
      </div>
      <div
        role="progressbar"
        aria-labelledby="calls-usage-label"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={C.usageValue(used, limit)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className={cn('h-full rounded-full', full || low ? 'bg-warning' : 'bg-primary')}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className={cn('text-xs', full || low ? 'text-warning' : 'text-muted-foreground')}>
        {full ? C.usageFull : low ? C.usageLow(left) : C.usageHint}
      </p>
    </div>
  )
}
