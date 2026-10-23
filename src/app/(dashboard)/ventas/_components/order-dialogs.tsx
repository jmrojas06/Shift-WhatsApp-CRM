'use client'

// ============================================================
// Diálogos de acción de /ventas:
//   - ShipOrderDialog: transportadora y guía (y ciudad / dirección si el
//     pedido no las tiene; es lo que exige applyOrderAction para enviar).
//   - CancelOrderDialog: confirmación antes de cancelar.
// El cambio lo hace la página (PATCH /api/modules/ventas/orders/[id]);
// los errores de datos (400) se muestran aquí, junto al campo.
// ============================================================

import { useId, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

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
import { ORDER_LIMITS } from '@/modules/ventas/orders'
import { missingShippingPlace, type PanelOrder } from '@/modules/ventas/panel'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

const TOUCH = 'h-11 sm:h-9'

/** Resultado de la acción: null = salió bien; texto = error para mostrar en el diálogo. */
export type DialogSubmitResult = string | null

export interface ShipExtra {
  carrier: string
  tracking_number: string
  city?: string
  address?: string
}

// ------------------------------------------------------------
// Marcar enviado
// ------------------------------------------------------------

function ShipForm({
  order,
  onSubmit,
  onCancel,
  onBusyChange,
}: {
  order: PanelOrder
  onSubmit: (extra: ShipExtra) => Promise<DialogSubmitResult>
  onCancel: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const uid = useId()
  const missing = missingShippingPlace(order)
  const [carrier, setCarrier] = useState(order.carrier ?? '')
  const [tracking, setTracking] = useState(order.tracking_number ?? '')
  const [city, setCity] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const errorId = `${uid}-error`

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    onBusyChange(true)
    setError(null)
    const result = await onSubmit({
      carrier,
      tracking_number: tracking,
      ...(missing.city ? { city } : {}),
      ...(missing.address ? { address } : {}),
    })
    setSaving(false)
    onBusyChange(false)
    if (result) setError(result)
  }

  const errorProps = error ? { 'aria-describedby': errorId } : {}

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-4" aria-busy={saving}>
      <DialogHeader>
        <DialogTitle>{T.shipDialog.title}</DialogTitle>
        <DialogDescription>
          {T.detail.title(order.number)} · {order.customer_name}. {T.shipDialog.body}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-carrier`}>{T.shipDialog.carrierLabel}</Label>
        <Input
          id={`${uid}-carrier`}
          name="carrier"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          placeholder={T.shipDialog.carrierPlaceholder}
          maxLength={ORDER_LIMITS.carrierMax}
          autoComplete="off"
          required
          className={TOUCH}
          {...errorProps}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-tracking`}>{T.shipDialog.trackingLabel}</Label>
        <Input
          id={`${uid}-tracking`}
          name="tracking_number"
          spellCheck={false}
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          maxLength={ORDER_LIMITS.trackingMax}
          autoComplete="off"
          required
          className={TOUCH}
          {...errorProps}
        />
      </div>

      {(missing.city || missing.address) && (
        <div className="grid gap-3 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{T.shipDialog.placeHint}</p>
          {missing.city && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-city`}>{T.shipDialog.cityLabel}</Label>
              <Input
                id={`${uid}-city`}
                name="city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                maxLength={ORDER_LIMITS.cityMax}
                autoComplete="address-level2"
                required
                className={TOUCH}
                {...errorProps}
              />
            </div>
          )}
          {missing.address && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${uid}-address`}>{T.shipDialog.addressLabel}</Label>
              <Input
                id={`${uid}-address`}
                name="address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                maxLength={ORDER_LIMITS.addressMax}
                autoComplete="street-address"
                required
                className={TOUCH}
                {...errorProps}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive" id={errorId}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" className={TOUCH} onClick={onCancel} disabled={saving}>
          {T.shipDialog.cancel}
        </Button>
        <Button type="submit" className={TOUCH} disabled={saving}>
          {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
          {saving ? T.actions.working : T.shipDialog.submit}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function ShipOrderDialog({
  order,
  onClose,
  onSubmit,
}: {
  /** Pedido a enviar; null = cerrado. */
  order: PanelOrder | null
  onClose: () => void
  onSubmit: (order: PanelOrder, extra: ShipExtra) => Promise<DialogSubmitResult>
}) {
  // Mientras se guarda no se cierra (igual que cancelar): la respuesta
  // todavía puede traer un error que se muestra aquí.
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={order !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-md">
        {order && (
          <ShipForm
            key={order.id}
            order={order}
            onCancel={onClose}
            onBusyChange={setBusy}
            onSubmit={(extra) => onSubmit(order, extra)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------
// Cancelar
// ------------------------------------------------------------

export function CancelOrderDialog({
  order,
  onClose,
  onConfirm,
}: {
  order: PanelOrder | null
  onClose: () => void
  onConfirm: (order: PanelOrder) => Promise<DialogSubmitResult>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!order || saving) return
    setSaving(true)
    setError(null)
    const result = await onConfirm(order)
    setSaving(false)
    if (result) setError(result)
  }

  return (
    <Dialog
      open={order !== null}
      onOpenChange={(open) => {
        if (open || saving) return
        setError(null)
        onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        {order && (
          <>
            <DialogHeader>
              <DialogTitle>{T.cancelDialog.title(order.number)}</DialogTitle>
              <DialogDescription>{T.cancelDialog.body}</DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className={TOUCH}
                onClick={() => {
                  setError(null)
                  onClose()
                }}
                disabled={saving}
              >
                {T.cancelDialog.keep}
              </Button>
              <Button
                type="button"
                variant="destructive"
                className={TOUCH}
                onClick={() => void confirm()}
                disabled={saving}
              >
                {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
                {T.cancelDialog.confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
