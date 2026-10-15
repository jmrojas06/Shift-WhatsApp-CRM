import { describe, expect, it } from 'vitest'
import { getVerticalManifest, getVerticalNav, listVerticals } from './registry'

describe('vertical registry', () => {
  it('resolves the barberia manifest', () => {
    const manifest = getVerticalManifest('barberia')
    expect(manifest).not.toBeNull()
    expect(manifest?.key).toBe('barberia')
  })

  it('returns null for unknown, empty, or absent keys', () => {
    expect(getVerticalManifest('salon')).toBeNull()
    expect(getVerticalManifest('')).toBeNull()
    expect(getVerticalManifest(null)).toBeNull()
    expect(getVerticalManifest(undefined)).toBeNull()
  })

  it('lists the installed verticals', () => {
    expect(listVerticals().map((v) => v.key)).toEqual(['barberia'])
  })

  it('exposes the nav entry only for the matching vertical key', () => {
    const nav = getVerticalNav('barberia')
    expect(nav).toHaveLength(1)
    expect(nav[0].href).toBe('/barberia')
    expect(nav[0].labelKey).toBe('barberia')

    expect(getVerticalNav('salon')).toEqual([])
    expect(getVerticalNav(null)).toEqual([])
  })
})
