import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ============================================================
// Ventas en el panel del contacto: quién ve qué.
//   - Sin el módulo Ventas: nada (ni el separador).
//   - Con el módulo y rol agent o más: "Crear pedido".
//   - Viewer: la lista sí, el botón no.
// Render estático (como ai-thread-banner.test.tsx): los efectos no
// corren, así que no se toca Supabase.
// ============================================================

const authState: {
  account: { modules?: string[]; vertical_key?: string | null; default_currency?: string } | null
  canSendMessages: boolean
} = { account: null, canSendMessages: false }

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    accountId: 'acc-1',
    account: authState.account,
    canSendMessages: authState.canSendMessages,
    defaultCurrency: 'COP',
  }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('no se debe consultar la base en un render estático')
  },
}))

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { ContactOrders, salesLinkForContact } from './contact-orders'
import { MobileOrdersButton } from './mobile-orders-button'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

const PROPS = {
  contactId: '11111111-1111-4111-8111-111111111111',
  contactName: 'Valentina Restrepo',
  contactPhone: '+57 300 123 4567',
  conversationId: null,
}

function render(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(React.createElement(ContactOrders, { ...PROPS, ...extra }))
}

function renderMobile(): string {
  return renderToStaticMarkup(React.createElement(MobileOrdersButton, PROPS))
}

describe('<ContactOrders />', () => {
  beforeEach(() => {
    authState.account = null
    authState.canSendMessages = false
  })

  it('cuenta sin el módulo Ventas: no renderiza nada', () => {
    authState.account = { modules: ['agenda'] }
    authState.canSendMessages = true
    expect(render()).toBe('')
  })

  it('cuenta clásica (sin módulos): no renderiza nada', () => {
    authState.account = { modules: [], vertical_key: null }
    authState.canSendMessages = true
    expect(render()).toBe('')
  })

  it('con Ventas y rol agent+: muestra el botón, el título y el enlace a Ventas filtrado por el contacto', () => {
    authState.account = { modules: ['agenda', 'ventas'] }
    authState.canSendMessages = true
    const html = render()
    expect(html).toContain(T.createOrder.open)
    expect(html).toContain(T.contactOrders.title)
    expect(html).toContain('href="/ventas?q=%2B57%20300%20123%204567"')
    // Antes de que responda la base (los efectos no corren aquí) se ve "cargando".
    expect(html).toContain(T.loading)
  })

  it('en la hoja móvil va sin separador propio', () => {
    authState.account = { modules: ['ventas'] }
    authState.canSendMessages = true
    expect(render()).toContain('my-4 border-t border-border')
    expect(render({ withDivider: false })).not.toContain('my-4 border-t border-border')
  })

  it('viewer: ve la sección pero no puede crear pedidos', () => {
    authState.account = { modules: ['ventas'] }
    authState.canSendMessages = false
    const html = render()
    expect(html).toContain(T.contactOrders.title)
    expect(html).not.toContain(T.createOrder.open)
  })
})

describe('salesLinkForContact', () => {
  it('con teléfono: /ventas buscando ese teléfono', () => {
    expect(salesLinkForContact('+57 300 123 4567')).toBe('/ventas?q=%2B57%20300%20123%204567')
  })

  it('sin teléfono (solo usuario de WhatsApp): /ventas a secas', () => {
    expect(salesLinkForContact(null)).toBe('/ventas')
    expect(salesLinkForContact('  ')).toBe('/ventas')
  })
})

describe('<MobileOrdersButton />: entrada a Ventas en el celular', () => {
  beforeEach(() => {
    authState.account = null
    authState.canSendMessages = false
  })

  it('con Ventas y rol agent+: botón "Pedido" solo en móvil, de 44 px', () => {
    authState.account = { modules: ['ventas'] }
    authState.canSendMessages = true
    const html = renderMobile()
    expect(html).toContain(T.mobileOrders.open)
    expect(html).toContain(`aria-label="${T.mobileOrders.openLabel('Valentina Restrepo')}"`)
    expect(html).toContain('lg:hidden')
    expect(html).toContain('h-11')
  })

  it('sin el módulo o como viewer: nada', () => {
    authState.account = { modules: ['agenda'] }
    authState.canSendMessages = true
    expect(renderMobile()).toBe('')

    authState.account = { modules: ['ventas'] }
    authState.canSendMessages = false
    expect(renderMobile()).toBe('')
  })
})
