import { describe, expect, it } from 'vitest'
import {
  getAccountModules,
  getModulesNav,
  getVerticalManifest,
  getVerticalNav,
  hasModule,
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
    expect(listVerticals().map((v) => v.key)).toEqual(['agenda', 'ventas'])
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

describe('getAccountModules', () => {
  it('lee la columna modules', () => {
    expect(getAccountModules({ modules: ['agenda'] })).toEqual(['agenda'])
    expect(getAccountModules({ modules: ['ventas'] })).toEqual(['ventas'])
  })

  it('cae a vertical_key cuando modules viene vacío, nulo o ausente', () => {
    expect(getAccountModules({ modules: [], vertical_key: 'agenda' })).toEqual([
      'agenda',
    ])
    expect(getAccountModules({ modules: null, vertical_key: 'agenda' })).toEqual([
      'agenda',
    ])
    expect(getAccountModules({ vertical_key: 'agenda' })).toEqual(['agenda'])
  })

  it('la clave vieja barberia cuenta como agenda (en modules y en vertical_key)', () => {
    expect(getAccountModules({ vertical_key: 'barberia' })).toEqual(['agenda'])
    expect(getAccountModules({ modules: ['barberia'] })).toEqual(['agenda'])
  })

  it('modules manda sobre vertical_key cuando trae algo', () => {
    expect(
      getAccountModules({ modules: ['ventas'], vertical_key: 'agenda' }),
    ).toEqual(['ventas'])
  })

  it('ignora claves desconocidas y no hereda propiedades del prototipo', () => {
    expect(
      getAccountModules({ modules: ['crm', '__proto__', 'ventas', 'toString'] }),
    ).toEqual(['ventas'])
    expect(getAccountModules({ modules: ['salon'], vertical_key: null })).toEqual(
      [],
    )
  })

  it('quita duplicados y devuelve un orden estable (agenda, ventas)', () => {
    expect(
      getAccountModules({ modules: ['ventas', 'agenda', 'ventas', 'barberia'] }),
    ).toEqual(['agenda', 'ventas'])
  })

  it('sin módulos: cuenta nula, vacía o sin clave', () => {
    expect(getAccountModules(null)).toEqual([])
    expect(getAccountModules(undefined)).toEqual([])
    expect(getAccountModules({})).toEqual([])
    expect(getAccountModules({ modules: [], vertical_key: null })).toEqual([])
    expect(getAccountModules({ vertical_key: 'tienda' })).toEqual([])
  })
})

describe('hasModule', () => {
  it('responde por módulo, con ambas columnas', () => {
    expect(hasModule({ modules: ['agenda', 'ventas'] }, 'ventas')).toBe(true)
    expect(hasModule({ vertical_key: 'barberia' }, 'agenda')).toBe(true)
    expect(hasModule({ vertical_key: 'barberia' }, 'ventas')).toBe(false)
    expect(hasModule(null, 'agenda')).toBe(false)
  })
})

describe('getModulesNav', () => {
  it('una entrada de menú por módulo activo, en orden estable', () => {
    const nav = getModulesNav({ modules: ['ventas', 'agenda'] })
    expect(nav.map((n) => n.href)).toEqual(['/agenda', '/ventas'])
    expect(nav.map((n) => n.labelKey)).toEqual(['agenda', 'ventas'])
  })

  it('cuenta clásica o solo con vertical_key', () => {
    expect(getModulesNav({})).toEqual([])
    expect(getModulesNav(null)).toEqual([])
    expect(getModulesNav({ vertical_key: 'agenda' }).map((n) => n.href)).toEqual([
      '/agenda',
    ])
  })
})

describe('manifest de ventas', () => {
  it('está registrado con su entrada de menú', () => {
    const manifest = getVerticalManifest('ventas')
    expect(manifest?.key).toBe('ventas')
    expect(manifest?.name).toBe('Ventas')
    expect(manifest?.nav?.href).toBe('/ventas')
    expect(manifest?.nav?.labelKey).toBe('ventas')
    expect(manifest?.nav?.icon).toBeDefined()
  })
})
