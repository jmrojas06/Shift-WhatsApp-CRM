import { describe, expect, it } from 'vitest'

import {
  AGENDA_AGENT_TEXTS,
} from './texts'
import {
  BOT_TEXT_MAX_LENGTH,
  EDITABLE_BOT_TEXT_KEYS,
  botTextDefault,
  isEditableBotTextKey,
  mergeBotTexts,
  sanitizeBotTexts,
} from './bot-texts'

// ============================================================
// Textos del bot editables: saneo del jsonb que llega de la API o de
// la base, tope de longitud, "vacío = default" y merge sobre el copy
// del controlador. Puro: sin DB ni red.
// ============================================================

describe('sanitizeBotTexts', () => {
  it('tolera ausencia de fila/columna (null y undefined) y devuelve {}', () => {
    expect(sanitizeBotTexts(null)).toEqual({ ok: true, value: {} })
    expect(sanitizeBotTexts(undefined)).toEqual({ ok: true, value: {} })
  })

  it('rechaza arrays y escalares con mensaje claro', () => {
    for (const bad of [['welcome'], 'hola', 42, true]) {
      const result = sanitizeBotTexts(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('objeto')
    }
  })

  it('descarta claves desconocidas sin fallar (forward-compat)', () => {
    const result = sanitizeBotTexts({
      welcome: 'Hola 👋',
      somethingElse: 'de otra versión',
    })
    expect(result).toEqual({ ok: true, value: { welcome: 'Hola 👋' } })
  })

  it('recorta espacios y trata vacío/null como "volver al default"', () => {
    const result = sanitizeBotTexts({
      welcome: '  Hola 👋  ',
      retry: '',
      noServices: '   ',
      noDaysAvailable: null,
      handoff: undefined,
    })
    expect(result).toEqual({ ok: true, value: { welcome: 'Hola 👋' } })
  })

  it('rechaza valores que no son texto, nombrando el campo', () => {
    const result = sanitizeBotTexts({ handoff: 123 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Pase a un asesor')
      expect(result.message).toContain('texto')
    }
  })

  it(`deja pasar exactamente ${BOT_TEXT_MAX_LENGTH} caracteres y corta en ${BOT_TEXT_MAX_LENGTH + 1}`, () => {
    const atLimit = 'x'.repeat(BOT_TEXT_MAX_LENGTH)
    expect(sanitizeBotTexts({ welcome: atLimit })).toEqual({
      ok: true,
      value: { welcome: atLimit },
    })

    const overLimit = sanitizeBotTexts({
      welcome: 'x'.repeat(BOT_TEXT_MAX_LENGTH + 1),
    })
    expect(overLimit.ok).toBe(false)
    if (!overLimit.ok) {
      expect(overLimit.message).toContain('Bienvenida')
      expect(overLimit.message).toContain(String(BOT_TEXT_MAX_LENGTH))
    }
  })
})

describe('mergeBotTexts', () => {
  it('sin overrides devuelve el copy por defecto intacto', () => {
    const merged = mergeBotTexts({})
    expect(merged.serviceMenuBody).toBe(AGENDA_AGENT_TEXTS.serviceMenuBody)
    expect(merged.retry).toBe(AGENDA_AGENT_TEXTS.retry)
    expect(merged.noServices).toBe(AGENDA_AGENT_TEXTS.noServices)
    expect(merged.noDaysAvailable).toBe(AGENDA_AGENT_TEXTS.noDaysAvailable)
    expect(merged.handoff).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('aplica solo las claves sobreescritas y deja el resto por defecto', () => {
    const merged = mergeBotTexts({ welcome: '¡Hola de Don Pedro! 💈' })
    expect(merged.serviceMenuBody).toBe('¡Hola de Don Pedro! 💈')
    expect(merged.retry).toBe(AGENDA_AGENT_TEXTS.retry)
    // El resto del menú (botones, resumen…) nunca cambia por merge.
    expect(merged.serviceMenuButton).toBe(
      AGENDA_AGENT_TEXTS.serviceMenuButton,
    )
    expect(merged.summaryConfirm).toBe(AGENDA_AGENT_TEXTS.summaryConfirm)
  })

  it('aplica las cinco claves editables a la vez', () => {
    const merged = mergeBotTexts({
      welcome: 'w',
      retry: 'r',
      noServices: 'ns',
      noDaysAvailable: 'nd',
      handoff: 'h',
    })
    expect(merged.serviceMenuBody).toBe('w')
    expect(merged.retry).toBe('r')
    expect(merged.noServices).toBe('ns')
    expect(merged.noDaysAvailable).toBe('nd')
    expect(merged.handoff).toBe('h')
  })
})

describe('metadata de claves', () => {
  it('botTextDefault devuelve el texto base de cada clave', () => {
    expect(botTextDefault('welcome')).toBe(
      AGENDA_AGENT_TEXTS.serviceMenuBody,
    )
    expect(botTextDefault('handoff')).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('isEditableBotTextKey solo reconoce las cinco claves', () => {
    for (const key of EDITABLE_BOT_TEXT_KEYS) {
      expect(isEditableBotTextKey(key)).toBe(true)
    }
    expect(isEditableBotTextKey('summaryBody')).toBe(false)
    expect(isEditableBotTextKey('')).toBe(false)
  })
})
