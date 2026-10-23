'use client'

// ============================================================
// "Pedido" en el encabezado de la conversación — solo móvil (< lg).
//
// En móvil el panel lateral del contacto no existe, y quien vende por
// WhatsApp trabaja desde el celular. Este botón abre una hoja con lo
// mismo que el panel de escritorio (ContactOrders: pedidos del contacto
// y "Crear pedido"); no repite lógica. Visible con el módulo Ventas y
// rol agent o más.
// ============================================================

import { useState } from 'react'
import { ShoppingBag } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useAuth } from '@/hooks/use-auth'
import { hasModule } from '@/lib/verticals/registry'
import { VENTAS_TEXTS } from '@/modules/ventas/texts'

import { ContactOrders } from './contact-orders'

const T = VENTAS_TEXTS.mobileOrders

export interface MobileOrdersButtonProps {
  contactId: string
  contactName: string
  conversationId: string | null
}

export function MobileOrdersButton({
  contactId,
  contactName,
  conversationId,
}: MobileOrdersButtonProps) {
  const { account, canSendMessages } = useAuth()
  const [open, setOpen] = useState(false)

  if (!hasModule(account, 'ventas') || !canSendMessages) return null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        // 44 px de alto sin agrandar el encabezado (los márgenes negativos
        // devuelven el espacio extra). Solo en móvil: en escritorio está el panel.
        className="-my-1 h-11 gap-1.5 px-2.5 lg:hidden"
        aria-label={T.openLabel(contactName)}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ShoppingBag aria-hidden="true" />
        <span className="hidden min-[400px]:inline">{T.open}</span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader>
            <SheetTitle>{T.title}</SheetTitle>
            <SheetDescription>{T.description(contactName)}</SheetDescription>
          </SheetHeader>
          <div className="px-4">
            <ContactOrders
              key={contactId}
              contactId={contactId}
              contactName={contactName}
              conversationId={conversationId}
              withDivider={false}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
