import { describe, expect, it } from 'vitest'

import { capitalize, DEFAULT_LABELS, LABEL_MAX, resolveLabels, sanitizeLabels } from './labels'

describe('sanitizeLabels', () => {
  it('acepta claves conocidas, recorta y descarta vacías', () => {
    const res = sanitizeLabels({ profesional: '  doctor ', citas: '', otra: 'x' })
    expect(res).toEqual({ ok: true, value: { profesional: 'doctor' } })
  })

  it('null o ausente es objeto vacío', () => {
    expect(sanitizeLabels(null)).toEqual({ ok: true, value: {} })
    expect(sanitizeLabels(undefined)).toEqual({ ok: true, value: {} })
  })

  it('rechaza no-objetos, no-texto y textos largos', () => {
    expect(sanitizeLabels([]).ok).toBe(false)
    expect(sanitizeLabels({ cita: 3 }).ok).toBe(false)
    expect(sanitizeLabels({ cita: 'x'.repeat(LABEL_MAX + 1) }).ok).toBe(false)
  })
})

describe('resolveLabels', () => {
  it('completa con los valores por defecto', () => {
    expect(resolveLabels({ profesional: 'técnico' })).toEqual({
      ...DEFAULT_LABELS,
      profesional: 'técnico',
    })
    expect(resolveLabels(null)).toEqual(DEFAULT_LABELS)
  })
})

describe('capitalize', () => {
  it('pone mayúscula inicial', () => {
    expect(capitalize('turno')).toBe('Turno')
    expect(capitalize('')).toBe('')
  })
})
