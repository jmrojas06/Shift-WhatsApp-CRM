import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ============================================================
// GatedButton: mientras el rol carga, el botón no debe verse
// "de solo lectura" (deshabilitado + tooltip); solo ocupado.
// ============================================================

const auth = { profileLoading: false }

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: { action?: string }) =>
    values?.action ? `${key}:${values.action}` : key,
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }))

import { GatedButton, gateState } from './gated-button'

describe('gateState', () => {
  it('ready cuando el rol puede actuar', () => {
    expect(gateState({ canAct: true, profileLoading: false })).toBe('ready')
  })
  it('pending mientras el rol carga', () => {
    expect(gateState({ canAct: false, profileLoading: true })).toBe('pending')
  })
  it('blocked cuando el rol ya cargó y no puede actuar', () => {
    expect(gateState({ canAct: false, profileLoading: false })).toBe('blocked')
  })
  it('disabled del llamador gana siempre', () => {
    expect(gateState({ canAct: true, disabled: true, profileLoading: false })).toBe('disabled')
    expect(gateState({ canAct: false, disabled: true, profileLoading: true })).toBe('disabled')
  })
})

function render(canAct: boolean) {
  return renderToStaticMarkup(
    React.createElement(GatedButton, { canAct, gateReason: 'crear difusiones' }, 'Nueva difusión'),
  )
}

describe('<GatedButton />', () => {
  it('rol cargando: ocupado, sin tooltip y sin aspecto deshabilitado', () => {
    auth.profileLoading = true
    const html = render(false)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('title=')
    expect(html).not.toMatch(/\sdisabled=""/)
  })

  it('rol de solo lectura: deshabilitado con tooltip', () => {
    auth.profileLoading = false
    const html = render(false)
    expect(html).toContain('title="readOnly:crear difusiones"')
    expect(html).toMatch(/\sdisabled=""/)
    expect(html).not.toContain('aria-busy')
  })

  it('rol con permiso: botón normal', () => {
    auth.profileLoading = false
    const html = render(true)
    expect(html).not.toContain('title=')
    expect(html).not.toContain('aria-busy')
    expect(html).not.toMatch(/\sdisabled=""/)
  })
})
