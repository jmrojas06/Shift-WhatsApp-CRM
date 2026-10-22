import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TOGGLES,
  TOGGLE_COLUMNS,
  TOGGLE_KEYS,
  togglesFromRow,
  togglesToRow,
} from './toggles'

describe('togglesFromRow', () => {
  it('fila ausente o columnas nulas = todo prendido', () => {
    expect(togglesFromRow(null)).toEqual(DEFAULT_TOGGLES)
    expect(togglesFromRow({ choose_staff: null })).toEqual(DEFAULT_TOGGLES)
  })

  it('solo false apaga una pieza', () => {
    expect(
      togglesFromRow({ choose_staff: false, show_price: true, reminders_enabled: false }),
    ).toEqual({ ...DEFAULT_TOGGLES, chooseStaff: false, remindersEnabled: false })
  })

  it('"false" en texto y 0 cuentan como prendidos', () => {
    expect(togglesFromRow({ choose_staff: 'false', show_price: 0 })).toEqual(DEFAULT_TOGGLES)
  })
})

describe('togglesToRow', () => {
  it('escribe solo las piezas presentes, en snake_case', () => {
    expect(togglesToRow({ showPrice: false, allowReschedule: true })).toEqual({
      show_price: false,
      allow_reschedule: true,
    })
  })

  it('ignora valores que no son booleanos', () => {
    expect(togglesToRow({ showPrice: 'x' as never })).toEqual({})
  })

  it('sin piezas devuelve un objeto vacío', () => {
    expect(togglesToRow({})).toEqual({})
  })

  it('ida y vuelta de las cinco piezas', () => {
    const off = {
      chooseStaff: false,
      showPrice: false,
      showDuration: false,
      remindersEnabled: false,
      allowReschedule: false,
    }
    expect(togglesFromRow(togglesToRow(off))).toEqual(off)
    expect(togglesFromRow(togglesToRow(DEFAULT_TOGGLES))).toEqual(DEFAULT_TOGGLES)
  })
})

describe('DEFAULT_TOGGLES y columnas', () => {
  it('DEFAULT_TOGGLES está congelado', () => {
    expect(Object.isFrozen(DEFAULT_TOGGLES)).toBe(true)
  })

  it('cada pieza tiene una columna distinta', () => {
    expect(new Set(Object.values(TOGGLE_COLUMNS)).size).toBe(TOGGLE_KEYS.length)
    expect(TOGGLE_KEYS).toHaveLength(5)
  })
})
