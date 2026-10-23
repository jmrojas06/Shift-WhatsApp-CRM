import { ShoppingBag } from 'lucide-react'
import type { VerticalManifest } from '@/lib/verticals/types'

/**
 * Ventas — pedidos hechos por WhatsApp: se crean desde la conversación,
 * se siguen en /ventas y el cliente recibe avisos de cada estado.
 *
 * Sin bot propio: no tiene handler en `dispatch.ts`, solo menú.
 */
export const ventasManifest: VerticalManifest = {
  key: 'ventas',
  name: 'Ventas',
  description: 'Pedidos por WhatsApp, seguimiento de estados y avisos al cliente.',
  nav: {
    href: '/ventas',
    labelKey: 'ventas',
    icon: ShoppingBag,
  },
}
