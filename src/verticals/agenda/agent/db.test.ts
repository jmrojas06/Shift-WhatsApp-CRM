import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_LABELS } from '../labels'
import { DEFAULT_TOGGLES } from '../toggles'
import { loadBotSettings } from './db'

/** Cliente mínimo: solo la cadena que usa loadBotSettings. */
function stubClient(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => result }),
      }),
    }),
  } as unknown as SupabaseClient
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadBotSettings', () => {
  it('si la lectura falla (p. ej. migración sin aplicar) avisa en el log y cae a los defaults', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const settings = await loadBotSettings(
      stubClient({ data: null, error: { code: '42703', message: 'column booking_settings.labels does not exist' } }),
      'acc-1',
    )

    expect(settings).toEqual({
      botTexts: {},
      labels: DEFAULT_LABELS,
      toggles: DEFAULT_TOGGLES,
    })
    expect(spy).toHaveBeenCalledWith(
      '[agenda] loadBotSettings falló:',
      '42703',
      'column booking_settings.labels does not exist',
    )
  })

  it('una fila válida se lee completa', async () => {
    const settings = await loadBotSettings(
      stubClient({
        data: {
          bot_texts: { welcome: 'Hola' },
          labels: { profesional: 'doctor' },
          choose_staff: false,
        },
        error: null,
      }),
      'acc-1',
    )

    expect(settings.botTexts).toEqual({ welcome: 'Hola' })
    expect(settings.labels).toEqual({ ...DEFAULT_LABELS, profesional: 'doctor' })
    expect(settings.toggles).toEqual({ ...DEFAULT_TOGGLES, chooseStaff: false })
  })

  it('sin fila no hay error ni log: defaults', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const settings = await loadBotSettings(stubClient({ data: null, error: null }), 'acc-1')

    expect(settings.toggles).toEqual(DEFAULT_TOGGLES)
    expect(spy).not.toHaveBeenCalled()
  })
})
