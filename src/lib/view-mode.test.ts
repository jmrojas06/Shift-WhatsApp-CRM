import { describe, expect, it } from 'vitest'

import { isRouteHidden, isSettingsSectionHidden, isShiftStaffEmail } from './view-mode'

const local = { simple: true, hasModules: true }
const shift = { simple: false, hasModules: true }

describe('isRouteHidden', () => {
  it('el local no ve lo técnico, con o sin subrutas', () => {
    for (const path of ['/agents', '/flows/abc', '/automations/new', '/broadcasts']) {
      expect(isRouteHidden(path, local)).toBe(true)
    }
  })

  it('el local sí ve su día a día', () => {
    for (const path of ['/dashboard', '/inbox', '/agenda', '/agenda/configuracion', '/ventas', '/contacts', '/settings']) {
      expect(isRouteHidden(path, local)).toBe(false)
    }
  })

  it('Shift ve todo', () => {
    expect(isRouteHidden('/agents', shift)).toBe(false)
    expect(isRouteHidden('/pipelines', shift)).toBe(false)
  })

  it('el Embudo se esconde solo si la cuenta ya tiene un módulo', () => {
    expect(isRouteHidden('/pipelines', local)).toBe(true)
    expect(isRouteHidden('/pipelines', { simple: true, hasModules: false })).toBe(false)
  })

  it('no confunde rutas que empiezan igual', () => {
    expect(isRouteHidden('/agentsx', local)).toBe(false)
  })
})

describe('isSettingsSectionHidden', () => {
  it('esconde al local lo que configura Shift', () => {
    expect(isSettingsSectionHidden('whatsapp', true)).toBe(true)
    expect(isSettingsSectionHidden('api', true)).toBe(true)
    expect(isSettingsSectionHidden('members', true)).toBe(false)
    expect(isSettingsSectionHidden('quick-replies', true)).toBe(false)
    expect(isSettingsSectionHidden('whatsapp', false)).toBe(false)
  })
})

describe('isShiftStaffEmail', () => {
  const list = ' Equipo@Shift.co, otro@gmail.com ,'

  it('reconoce los correos de la lista sin importar mayúsculas ni espacios', () => {
    expect(isShiftStaffEmail('equipo@shift.co', list)).toBe(true)
    expect(isShiftStaffEmail(' OTRO@gmail.com', list)).toBe(true)
  })

  it('cualquier otro correo es del local', () => {
    expect(isShiftStaffEmail('dueno@barberia.com', list)).toBe(false)
    expect(isShiftStaffEmail('', list)).toBe(false)
    expect(isShiftStaffEmail(null, list)).toBe(false)
  })

  it('sin lista configurada nadie es de Shift', () => {
    expect(isShiftStaffEmail('equipo@shift.co', undefined)).toBe(false)
    expect(isShiftStaffEmail('equipo@shift.co', '')).toBe(false)
  })
})
