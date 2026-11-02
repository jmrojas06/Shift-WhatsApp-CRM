import { describe, expect, it } from 'vitest'

import { getAccountModules, getModulesNav, hasModule } from '@/lib/verticals/registry'

describe('módulo clínica', () => {
  it('convive con la agenda, en orden estable', () => {
    expect(getAccountModules({ modules: ['clinica', 'agenda'] })).toEqual(['agenda', 'clinica'])
    expect(hasModule({ modules: ['agenda', 'clinica'] }, 'clinica')).toBe(true)
  })

  it('no agrega una entrada al menú', () => {
    expect(getModulesNav({ modules: ['clinica'] })).toEqual([])
  })
})
