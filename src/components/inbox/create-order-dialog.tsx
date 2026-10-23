'use client'

// ============================================================
// "Crear pedido" desde el inbox (Ventas A, diseño §3.3).
//
// Líneas (producto, cantidad, precio), envío, total de muestra, datos de
// entrega, cédula opcional, notas y "¿ya pagó?". El nombre y el teléfono
// salen del contacto en la base: no se piden. La validación es la del
// servidor (order-form.ts → validateOrderCreate) y el total que se ve es
// solo de muestra: el servidor lo recalcula.
//
// Tras guardar se muestra el pedido creado y, con calma, el resultado del
// aviso de pago al cliente (si nació pagado y el aviso está prendido).
// ============================================================

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { OrderStatusBadges } from '@/components/ventas/order-badges'
import { NoticeResultAlert } from '@/components/ventas/notice-result'
import { cn } from '@/lib/utils'
import { ventasApi, type OrderMutationResponse } from '@/modules/ventas/api-client'
import {
  addDraftLine,
  buildOrderRequest,
  draftTotals,
  emptyOrderDraft,
  removeDraftLine,
  updateDraftLine,
  type OrderDraft,
  type OrderFormField,
} from '@/modules/ventas/order-form'
import { ORDER_LIMITS } from '@/modules/ventas/orders'
import { noticeResult } from '@/modules/ventas/panel'
import { VENTAS_TEXTS, formatMoney } from '@/modules/ventas/texts'

const T = VENTAS_TEXTS.createOrder

/** Alto cómodo para el dedo en móvil (44 px) y compacto en escritorio. */
const FIELD = 'h-11 sm:h-9'
const BUTTON = 'h-11 sm:h-9'

interface FormError {
  message: string
  field?: OrderFormField
  line?: number
}

// ------------------------------------------------------------
// Formulario
// ------------------------------------------------------------

export interface CreateOrderFormProps {
  contactId: string
  contactName: string
  conversationId: string | null
  currency: string
  /** Para pruebas y para "crear otro" con datos de partida. */
  initialDraft?: OrderDraft
  onSaved: (result: OrderMutationResponse) => void
  onCancel: () => void
  onBusyChange?: (busy: boolean) => void
}

export function CreateOrderForm({
  contactId,
  contactName,
  conversationId,
  currency,
  initialDraft,
  onSaved,
  onCancel,
  onBusyChange,
}: CreateOrderFormProps) {
  const uid = useId()
  const [draft, setDraft] = useState<OrderDraft>(() => initialDraft ?? emptyOrderDraft())
  const [error, setError] = useState<FormError | null>(null)
  const [saving, setSaving] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const focusAfterRender = useRef<string | null>(null)

  const fieldId = (field: string, key?: string) =>
    key ? `${uid}-${key}-${field}` : `${uid}-${field}`
  const errorId = `${uid}-error`
  const amountHintId = `${uid}-amount-hint`

  // Enfoca lo que pidió el último cambio (línea nueva, campo con error…).
  useEffect(() => {
    const target = focusAfterRender.current
    if (!target) return
    focusAfterRender.current = null
    const el = formRef.current?.ownerDocument.getElementById(target)
    el?.focus()
  })

  const totals = draftTotals(draft)
  const atMax = draft.lines.length >= ORDER_LIMITS.itemsMax

  const setField = <K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const invalid = (field: OrderFormField, line?: number) =>
    error?.field === field && (line === undefined || error.line === line)

  const describedBy = (field: OrderFormField, line?: number, ...extra: string[]) =>
    [invalid(field, line) ? errorId : null, ...extra].filter(Boolean).join(' ') || undefined

  function addLine() {
    const next = addDraftLine(draft)
    if (next === draft) return
    const added = next.lines[next.lines.length - 1]
    focusAfterRender.current = fieldId('name', added.key)
    setDraft(next)
  }

  function removeLine(key: string, index: number) {
    const next = removeDraftLine(draft, key)
    if (next === draft) return
    const neighbour = next.lines[Math.max(0, index - 1)]
    focusAfterRender.current = neighbour ? fieldId('name', neighbour.key) : null
    if (error?.line !== undefined) setError(null)
    setDraft(next)
  }

  function focusError(err: FormError) {
    if (err.field === undefined) {
      focusAfterRender.current = errorId
      return
    }
    if (err.field === 'lines') {
      focusAfterRender.current = fieldId('name', draft.lines[0]?.key)
      return
    }
    if (err.line !== undefined) {
      const key = draft.lines[err.line]?.key
      if (key) focusAfterRender.current = fieldId(err.field, key)
      return
    }
    focusAfterRender.current = fieldId(err.field)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const request = buildOrderRequest(draft, contactId, conversationId)
    if (!request.ok) {
      const err: FormError = { message: request.message, field: request.field, line: request.line }
      setError(err)
      focusError(err)
      return
    }
    setError(null)
    setSaving(true)
    onBusyChange?.(true)
    const res = await ventasApi.createOrder(request.value)
    setSaving(false)
    onBusyChange?.(false)
    if (!res.ok) {
      const err: FormError = { message: res.message }
      setError(err)
      focusAfterRender.current = errorId
      return
    }
    onSaved(res.data)
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="grid gap-5" aria-busy={saving}>
      <DialogHeader>
        <DialogTitle>{T.title}</DialogTitle>
        <DialogDescription>{T.description(contactName)}</DialogDescription>
      </DialogHeader>

      {/* Productos */}
      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium text-foreground">{T.itemsTitle}</legend>
        <ul className="grid gap-3">
          {draft.lines.map((line, index) => {
            const first = index === 0
            // En escritorio las etiquetas se ven solo en la primera fila
            // (encabezado de columna); en las demás quedan para el lector.
            const labelClass = cn('text-xs text-muted-foreground', !first && 'sm:sr-only')
            return (
              <li
                key={line.key}
                role="group"
                aria-label={T.lineLabel(index + 1)}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-end gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_5rem_9rem_auto] sm:border-0 sm:p-0"
              >
                <div className="col-span-3 grid gap-1.5 sm:col-span-1">
                  <Label htmlFor={fieldId('name', line.key)} className={labelClass}>
                    {T.productLabel}
                  </Label>
                  <Input
                    id={fieldId('name', line.key)}
                    name={`items.${index}.name`}
                    value={line.name}
                    maxLength={ORDER_LIMITS.nameMax}
                    placeholder={first ? T.productPlaceholder : undefined}
                    autoComplete="off"
                    className={FIELD}
                    aria-invalid={invalid('name', index) || undefined}
                    aria-describedby={describedBy('name', index)}
                    onChange={(e) =>
                      setDraft((prev) => updateDraftLine(prev, line.key, { name: e.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={fieldId('quantity', line.key)} className={labelClass}>
                    {T.quantityLabel}
                  </Label>
                  <Input
                    id={fieldId('quantity', line.key)}
                    name={`items.${index}.quantity`}
                    value={line.quantity}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    placeholder={T.quantityPlaceholder}
                    className={cn(FIELD, 'tabular-nums')}
                    aria-invalid={invalid('quantity', index) || undefined}
                    aria-describedby={describedBy('quantity', index)}
                    onChange={(e) =>
                      setDraft((prev) => updateDraftLine(prev, line.key, { quantity: e.target.value }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={fieldId('unitPrice', line.key)} className={labelClass}>
                    {T.unitPriceLabel}
                  </Label>
                  <Input
                    id={fieldId('unitPrice', line.key)}
                    name={`items.${index}.unitPrice`}
                    value={line.unitPrice}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={T.pricePlaceholder}
                    className={cn(FIELD, 'tabular-nums')}
                    aria-invalid={invalid('unitPrice', index) || undefined}
                    aria-describedby={describedBy('unitPrice', index, amountHintId)}
                    onChange={(e) =>
                      setDraft((prev) => updateDraftLine(prev, line.key, { unitPrice: e.target.value }))
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 text-muted-foreground hover:text-destructive sm:size-9"
                  disabled={draft.lines.length <= ORDER_LIMITS.itemsMin}
                  aria-label={T.removeLine(index + 1)}
                  title={T.removeLine(index + 1)}
                  onClick={() => removeLine(line.key, index)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className={BUTTON}
            onClick={addLine}
            disabled={atMax}
          >
            <Plus aria-hidden="true" />
            {T.addLine}
          </Button>
          {atMax && (
            <p className="text-xs text-muted-foreground" role="status">
              {T.linesLimit(ORDER_LIMITS.itemsMax)}
            </p>
          )}
        </div>
        <p id={amountHintId} className="text-xs text-muted-foreground">
          {T.amountHint}
        </p>
      </fieldset>

      {/* Envío y total */}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start">
        <div className="grid gap-1.5">
          <Label htmlFor={fieldId('shipping')}>{T.shippingLabel}</Label>
          <Input
            id={fieldId('shipping')}
            name="shipping"
            value={draft.shipping}
            inputMode="decimal"
            autoComplete="off"
            placeholder={T.pricePlaceholder}
            className={cn(FIELD, 'tabular-nums')}
            aria-invalid={invalid('shipping') || undefined}
            aria-describedby={describedBy('shipping', undefined, amountHintId)}
            onChange={(e) => setField('shipping', e.target.value)}
          />
        </div>
        <div className="rounded-lg bg-muted/60 p-3">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{T.subtotalLabel}</dt>
            <dd className="text-right tabular-nums">{formatMoney(totals.subtotal, currency)}</dd>
            <dt className="text-muted-foreground">{T.shippingLabel}</dt>
            <dd className="text-right tabular-nums">{formatMoney(totals.shipping, currency)}</dd>
            <dt className="mt-1 border-t border-border pt-1.5 font-medium text-foreground">
              {T.totalLabel}
            </dt>
            <dd
              className="mt-1 border-t border-border pt-1.5 text-right text-base font-semibold tabular-nums text-foreground"
              aria-live="polite"
              aria-atomic="true"
              data-testid="order-total"
            >
              {formatMoney(totals.total, currency)}
            </dd>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{T.totalHint}</p>
        </div>
      </div>

      {/* Entrega */}
      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium text-foreground">{T.deliveryTitle}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId('city')}>{T.cityLabel}</Label>
            <Input
              id={fieldId('city')}
              name="city"
              value={draft.city}
              maxLength={ORDER_LIMITS.cityMax}
              autoComplete="address-level2"
              className={FIELD}
              aria-invalid={invalid('city') || undefined}
              aria-describedby={describedBy('city')}
              onChange={(e) => setField('city', e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId('address')}>{T.addressLabel}</Label>
            <Input
              id={fieldId('address')}
              name="address"
              value={draft.address}
              maxLength={ORDER_LIMITS.addressMax}
              autoComplete="street-address"
              className={FIELD}
              aria-invalid={invalid('address') || undefined}
              aria-describedby={describedBy('address')}
              onChange={(e) => setField('address', e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-1.5 sm:max-w-[calc(50%-0.375rem)]">
          <Label htmlFor={fieldId('idNumber')}>{T.idNumberLabel}</Label>
          <Input
            id={fieldId('idNumber')}
            name="idNumber"
            spellCheck={false}
            value={draft.idNumber}
            maxLength={ORDER_LIMITS.idNumberMax}
            autoComplete="off"
            inputMode="text"
            className={FIELD}
            aria-invalid={invalid('idNumber') || undefined}
            aria-describedby={describedBy('idNumber', undefined, fieldId('idNumber-hint'))}
            onChange={(e) => setField('idNumber', e.target.value)}
          />
          <p id={fieldId('idNumber-hint')} className="text-xs text-muted-foreground">
            {T.idNumberHint}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={fieldId('notes')}>{T.notesLabel}</Label>
          <Textarea
            id={fieldId('notes')}
            name="notes"
            value={draft.notes}
            maxLength={ORDER_LIMITS.notesMax}
            rows={2}
            aria-invalid={invalid('notes') || undefined}
            aria-describedby={describedBy('notes')}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </div>
      </fieldset>

      {/* ¿Ya pagó? */}
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <Label id={fieldId('paid-label')} htmlFor={fieldId('paid')}>
            {T.paidLabel}
          </Label>
          <p id={fieldId('paid-hint')} className="mt-1 text-xs text-muted-foreground">
            {T.paidHint}
          </p>
        </div>
        {/* El área táctil del interruptor llega a 44 px con el margen negativo. */}
        <span className="-m-3 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center p-3">
          <Switch
            id={fieldId('paid')}
            checked={draft.paid}
            onCheckedChange={(next) => setField('paid', Boolean(next))}
            aria-labelledby={fieldId('paid-label')}
            aria-describedby={fieldId('paid-hint')}
          />
        </span>
      </div>

      {error && (
        <Alert variant="destructive" id={errorId} tabIndex={-1} className="outline-none">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" className={BUTTON} onClick={onCancel} disabled={saving}>
          {T.cancel}
        </Button>
        <Button type="submit" className={BUTTON} disabled={saving}>
          {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
          {saving ? T.saving : T.submit}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ------------------------------------------------------------
// Pedido creado
// ------------------------------------------------------------

export function CreateOrderSuccess({
  result,
  onDone,
  onCreateAnother,
}: {
  result: OrderMutationResponse
  onDone: () => void
  onCreateAnother: () => void
}) {
  const { order, notice } = result
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle ref={headingRef} tabIndex={-1} className="outline-none">
          {T.created(order.number)}
        </DialogTitle>
        <DialogDescription>
          {VENTAS_TEXTS.detail.total}: {formatMoney(Number(order.total), order.currency)}
        </DialogDescription>
      </DialogHeader>
      <OrderStatusBadges order={order} />
      <NoticeResultAlert result={noticeResult(notice, order)} />
      <DialogFooter>
        <Button type="button" variant="outline" className={BUTTON} onClick={onCreateAnother}>
          {T.createAnother}
        </Button>
        <Button type="button" className={BUTTON} onClick={onDone}>
          {T.done}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ------------------------------------------------------------
// Diálogo
// ------------------------------------------------------------

export interface CreateOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
  conversationId: string | null
  currency: string
  onCreated?: (result: OrderMutationResponse) => void
}

export function CreateOrderDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  conversationId,
  currency,
  onCreated,
}: CreateOrderDialogProps) {
  const [result, setResult] = useState<OrderMutationResponse | null>(null)
  const [busy, setBusy] = useState(false)
  // Cambia para empezar un formulario limpio ("crear otro" o al reabrir).
  const [formKey, setFormKey] = useState(0)

  function handleOpenChange(next: boolean) {
    // Mientras se guarda no se cierra: el pedido podría quedar a medias de cara a la persona.
    if (!next && busy) return
    onOpenChange(next)
    if (!next) {
      setResult(null)
      setFormKey((k) => k + 1)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-2xl">
        {result ? (
          <CreateOrderSuccess
            result={result}
            onDone={() => handleOpenChange(false)}
            onCreateAnother={() => {
              setResult(null)
              setFormKey((k) => k + 1)
            }}
          />
        ) : (
          <CreateOrderForm
            key={formKey}
            contactId={contactId}
            contactName={contactName}
            conversationId={conversationId}
            currency={currency}
            onBusyChange={setBusy}
            onCancel={() => handleOpenChange(false)}
            onSaved={(saved) => {
              setResult(saved)
              onCreated?.(saved)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
