import { describe, expect, it, vi, beforeEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ============================================================
// Banner de IA / bot por conversación.
//
// Regresión: una barbería sin IA auto-reply quedaba sin forma de
// reactivar el bot de reservas tras un handoff (el banner solo existía
// con IA activa). Se renderiza a HTML estático: el primer render ya
// debe mostrar el estado pausado, sin esperar el fetch de /api/ai/config.
// ============================================================

const authState: {
  account: { vertical_key?: string | null; modules?: string[] } | null
} = {
  account: null,
}

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1', account: authState.account }),
}))

// Las claves se devuelven tal cual para afirmar qué copy se eligió.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AiThreadBanner, resolveAiBannerMode, resolvePausedCopy } from './ai-thread-banner'

function render(props: { disabled: boolean; assignedAgentId?: string | null }) {
  return renderToStaticMarkup(
    React.createElement(AiThreadBanner, {
      conversationId: 'cv-1',
      handoffSummary: 'El cliente pidió hablar con una persona.',
      ...props,
    }),
  )
}

describe('resolveAiBannerMode', () => {
  it('sin IA y sin vertical no muestra nada', () => {
    expect(
      resolveAiBannerMode({ autoReplyOn: false, hasVertical: false, paused: true }),
    ).toBe('hidden')
  })

  it('con vertical y sin IA muestra el estado pausado', () => {
    expect(
      resolveAiBannerMode({ autoReplyOn: false, hasVertical: true, paused: true }),
    ).toBe('paused')
  })

  it('con vertical, sin IA y sin pausa no muestra nada (no hay IA que tomar)', () => {
    expect(
      resolveAiBannerMode({ autoReplyOn: false, hasVertical: true, paused: false }),
    ).toBe('hidden')
  })

  it('con IA activa conserva el comportamiento de siempre', () => {
    expect(
      resolveAiBannerMode({ autoReplyOn: true, hasVertical: false, paused: true }),
    ).toBe('paused')
    expect(
      resolveAiBannerMode({ autoReplyOn: true, hasVertical: false, paused: false }),
    ).toBe('active')
    expect(
      resolveAiBannerMode({
        autoReplyOn: true,
        hasVertical: false,
        paused: false,
        assignedAgentId: 'user-1',
      }),
    ).toBe('hidden')
  })

  it('mientras carga el estado de IA, un hilo pausado con vertical ya se muestra', () => {
    expect(
      resolveAiBannerMode({ autoReplyOn: null, hasVertical: true, paused: true }),
    ).toBe('paused')
  })
})

describe('resolvePausedCopy', () => {
  it('sin IA (false) usa el copy del bot', () => {
    expect(resolvePausedCopy({ autoReplyOn: false })).toEqual({
      titleKey: 'botPausedTitle',
      buttonKey: 'resumeBot',
    })
  })

  it('con IA activa usa el copy de la IA', () => {
    expect(resolvePausedCopy({ autoReplyOn: true })).toEqual({
      titleKey: 'pausedTitle',
      buttonKey: 'resume',
    })
  })

  it('mientras carga (null) no parpadea copy de bot en una cuenta con IA', () => {
    expect(resolvePausedCopy({ autoReplyOn: null })).toEqual({
      titleKey: 'pausedTitle',
      buttonKey: 'resume',
    })
  })
})

describe('<AiThreadBanner /> render', () => {
  beforeEach(() => {
    authState.account = null
  })

  it('cuenta con vertical y sin IA: muestra el bot en pausa y el botón para reanudarlo', () => {
    authState.account = { vertical_key: 'agenda' }

    // El render estático no corre efectos: `autoReplyOn` sigue en null
    // (cargando), así que sale el copy neutral de IA. El copy de bot
    // se elige solo cuando el fetch ya resolvió `false`, cubierto en
    // resolvePausedCopy.
    const html = render({ disabled: true, assignedAgentId: 'user-agent' })

    expect(html).toContain('pausedTitle')
    expect(html).toContain('resume')
    expect(html).toContain('<button')
    expect(html).toContain('El cliente pidió hablar con una persona.')
  })

  it('cuenta con la agenda en modules: muestra el bot en pausa', () => {
    authState.account = { modules: ['agenda', 'ventas'], vertical_key: null }

    // Mientras carga el estado de la IA sale el copy neutral (ver arriba).
    const html = render({ disabled: true, assignedAgentId: 'user-agent' })

    expect(html).toContain('pausedTitle')
    expect(html).toContain('<button')
  })

  it('cuenta solo con ventas (sin bot) y sin IA: no renderiza nada', () => {
    authState.account = { modules: ['ventas'], vertical_key: null }

    expect(render({ disabled: true })).toBe('')
  })

  it('cuenta sin vertical y sin IA: no renderiza nada', () => {
    authState.account = { vertical_key: null }

    expect(render({ disabled: true })).toBe('')
  })

  it('cuenta con vertical y conversación activa: no renderiza nada', () => {
    authState.account = { vertical_key: 'agenda' }

    expect(render({ disabled: false })).toBe('')
  })
})
