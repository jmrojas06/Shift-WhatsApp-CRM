import { describe, expect, it } from 'vitest'
import {
  getVerticalManifest,
  getVerticalNav,
  isAgendaVerticalKey,
  listVerticals,
  normalizeVerticalKey,
} from './registry'

describe('vertical registry', () => {
  it('resolves the agenda manifest', () => {
    const manifest = getVerticalManifest('agenda')
    expect(manifest).not.toBeNull()
    expect(manifest?.key).toBe('agenda')
  })

  it('returns null for unknown, empty, or absent keys', () => {
    expect(getVerticalManifest('salon')).toBeNull()
    expect(getVerticalManifest('')).toBeNull()
    expect(getVerticalManifest(null)).toBeNull()
    expect(getVerticalManifest(undefined)).toBeNull()
  })

  it('lists the installed verticals', () => {
    expect(listVerticals().map((v) => v.key)).toEqual(['agenda'])
  })

  it('exposes the nav entry only for the matching vertical key', () => {
    const nav = getVerticalNav('agenda')
    expect(nav).toHaveLength(1)
    expect(nav[0].href).toBe('/agenda')
    expect(nav[0].labelKey).toBe('agenda')

    expect(getVerticalNav('salon')).toEqual([])
    expect(getVerticalNav(null)).toEqual([])
  })
})

describe('alias de la agenda', () => {
  it('la clave vieja barberia resuelve a la agenda', () => {
    expect(normalizeVerticalKey('barberia')).toBe('agenda')
    expect(getVerticalManifest('barberia')?.key).toBe('agenda')
    expect(isAgendaVerticalKey('barberia')).toBe(true)
    expect(isAgendaVerticalKey('agenda')).toBe(true)
  })

  it('claves desconocidas o vacías no son agenda', () => {
    expect(normalizeVerticalKey('tienda')).toBeNull()
    expect(normalizeVerticalKey('constructor')).toBeNull()
    expect(normalizeVerticalKey('__proto__')).toBeNull()
    expect(isAgendaVerticalKey(null)).toBe(false)
    expect(isAgendaVerticalKey('')).toBe(false)
  })
})
