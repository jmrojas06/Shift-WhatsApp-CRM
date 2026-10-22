import { describe, expect, it } from 'vitest'

import {
  capitalize,
  DEFAULT_LABELS,
  LABEL_MAX,
  readLabels,
  resolveLabels,
  sanitizeLabels,
} from './labels'

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

  it('el tope es de 24 caracteres: 24 entra, 25 no', () => {
    expect(sanitizeLabels({ cita: 'x'.repeat(LABEL_MAX) })).toEqual({
      ok: true,
      value: { cita: 'x'.repeat(LABEL_MAX) },
    })
    expect(sanitizeLabels({ cita: 'x'.repeat(LABEL_MAX + 1) }).ok).toBe(false)
  })

  it('cuenta código por código: un emoji vale 1', () => {
    expect(sanitizeLabels({ cita: '😀'.repeat(LABEL_MAX) }).ok).toBe(true)
    expect(sanitizeLabels({ cita: '😀'.repeat(LABEL_MAX + 1) }).ok).toBe(false)
  })

  it('descarta valores solo con espacios', () => {
    expect(sanitizeLabels({ cita: '   \n\t ' })).toEqual({ ok: true, value: {} })
  })

  it('descarta claves conocidas en null', () => {
    expect(sanitizeLabels({ cita: null })).toEqual({ ok: true, value: {} })
  })

  it('ignora __proto__ y claves desconocidas sin ensuciar el prototipo', () => {
    const input = JSON.parse('{"__proto__":{"cita":"x"},"constructor":"y"}')
    expect(sanitizeLabels(input)).toEqual({ ok: true, value: {} })
    expect(({} as Record<string, unknown>).cita).toBeUndefined()
  })

  it('colapsa saltos de línea y espacios internos a un espacio', () => {
    expect(sanitizeLabels({ servicio: 'corte\n   de  pelo' })).toEqual({
      ok: true,
      value: { servicio: 'corte de pelo' },
    })
  })

  it('rechaza caracteres de control o formato (zero-width space)', () => {
    const res = sanitizeLabels({ cita: 'cita​' })
    expect(res).toEqual({ ok: false, message: '"cita" tiene caracteres no permitidos.' })
  })

  it('rechaza a propósito los emoji compuestos con ZWJ (persona + símbolo)', () => {
    const compuesto = '\u{1F468}‍⚕️'
    expect(sanitizeLabels({ profesional: compuesto }).ok).toBe(false)
    // un emoji simple sí entra
    expect(sanitizeLabels({ profesional: '\u{1FA7A}' }).ok).toBe(true)
  })

  it('rechaza sustitutos sueltos y caracteres de uso privado', () => {
    expect(sanitizeLabels({ cita: 'ci\uD800ta' }).ok).toBe(false)
    expect(sanitizeLabels({ cita: 'ci\uE000ta' }).ok).toBe(false)
  })

  it('un texto muy largo se rechaza antes de contar puntos de código', () => {
    const res = sanitizeLabels({ cita: 'x'.repeat(LABEL_MAX * 2 + 1) })
    expect(res).toEqual({ ok: false, message: `"cita" no puede pasar de ${LABEL_MAX} caracteres.` })
  })

  it('rechaza marcas de formato de WhatsApp: * _ ~ y backtick', () => {
    for (const bad of ['*cita*', '_cita_', '~cita~', '`cita`']) {
      expect(sanitizeLabels({ cita: bad }).ok).toBe(false)
    }
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

  it('ignora valores no texto o en blanco y mantiene el default', () => {
    expect(resolveLabels({ cita: null, citas: 3, servicio: '' })).toEqual(DEFAULT_LABELS)
  })

  it('acepta undefined', () => {
    expect(resolveLabels(undefined)).toEqual(DEFAULT_LABELS)
  })
})

describe('readLabels', () => {
  it('nunca falla: una palabra inválida vuelve al default y el resto se conserva', () => {
    expect(
      readLabels({ cita: 'consulta', citas: 'x'.repeat(LABEL_MAX + 5), servicio: 'corte' }),
    ).toEqual({ ...DEFAULT_LABELS, cita: 'consulta', servicio: 'corte' })
  })

  it('una clave con caracteres prohibidos vuelve al default', () => {
    expect(readLabels({ cita: '*cita*', citas: 'turnos' })).toEqual({
      ...DEFAULT_LABELS,
      citas: 'turnos',
    })
  })

  it('entrada que no es objeto da los valores por defecto', () => {
    expect(readLabels('nope')).toEqual(DEFAULT_LABELS)
    expect(readLabels([])).toEqual(DEFAULT_LABELS)
    expect(readLabels(null)).toEqual(DEFAULT_LABELS)
  })
})

describe('DEFAULT_LABELS', () => {
  it('está congelado', () => {
    expect(Object.isFrozen(DEFAULT_LABELS)).toBe(true)
  })
})

describe('capitalize', () => {
  it('pone mayúscula inicial', () => {
    expect(capitalize('turno')).toBe('Turno')
    expect(capitalize('')).toBe('')
  })
})
