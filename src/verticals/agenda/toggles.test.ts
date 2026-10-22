import { describe, expect, it } from 'vitest'

import { DEFAULT_TOGGLES, togglesFromRow, togglesToRow } from './toggles'

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
})

describe('togglesToRow', () => {
  it('escribe solo las piezas presentes, en snake_case', () => {
    expect(togglesToRow({ showPrice: false, allowReschedule: true })).toEqual({
      show_price: false,
      allow_reschedule: true,
    })
  })
})
