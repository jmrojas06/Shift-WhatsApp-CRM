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

import { ContactOrders } from './contact-orders'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

function render(): string {
  return renderToStaticMarkup(
    React.createElement(ContactOrders, {
      contactId: '11111111-1111-4111-8111-111111111111',
      contactName: 'Valentina Restrepo',
      conversationId: null,
    }),
  )
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

  it('con Ventas y rol agent+: muestra el botón y los pedidos del contacto', () => {
    authState.account = { modules: ['agenda', 'ventas'] }
    authState.canSendMessages = true
    const html = render()
    expect(html).toContain(T.createOrder.open)
    expect(html).toContain(T.contactOrders.title)
    expect(html).toContain('href="/ventas"')
  })

  it('viewer: ve la sección pero no puede crear pedidos', () => {
    authState.account = { modules: ['ventas'] }
    authState.canSendMessages = false
    const html = render()
    expect(html).toContain(T.contactOrders.title)
    expect(html).not.toContain(T.createOrder.open)
  })
})
