import { describe, expect, it } from 'vitest'

import { buildCalendarSearch, parseCalendarUrl } from './calendar-url'

const STAFF = '33333333-3333-4333-8333-333333333333'

describe('parseCalendarUrl', () => {
  it('lee vista, día y profesional', () => {
    expect(parseCalendarUrl(`?vista=semana&dia=2026-11-10&profesional=${STAFF}`)).toEqual({
      view: 'week',
      dateKey: '2026-11-10',
      staffId: STAFF,
    })
  })

  it('sin parámetros no inventa nada', () => {
    expect(parseCalendarUrl('')).toEqual({})
    expect(parseCalendarUrl('?')).toEqual({})
  })

  it('"dia" es la vista de día', () => {
    expect(parseCalendarUrl('?vista=dia')).toEqual({ view: 'day' })
  })

  it('descarta lo que no es válido', () => {
    expect(parseCalendarUrl('?vista=mes&dia=2026-02-30&profesional=abc')).toEqual({})
    expect(parseCalendarUrl('?dia=10/11/2026')).toEqual({})
  })

  it('acepta la cadena con o sin el signo ?', () => {
    expect(parseCalendarUrl('vista=semana')).toEqual({ view: 'week' })
  })
})

describe('buildCalendarSearch', () => {
  const today = '2026-11-10'

  it('lo de siempre (día, hoy, todos) no escribe nada', () => {
    expect(buildCalendarSearch({ view: 'day', dateKey: today, staffId: null }, today)).toBe('')
  })

  it('escribe solo lo que cambia', () => {
    expect(buildCalendarSearch({ view: 'week', dateKey: today, staffId: null }, today)).toBe('?vista=semana')
    expect(buildCalendarSearch({ view: 'day', dateKey: '2026-11-12', staffId: null }, today)).toBe('?dia=2026-11-12')
    expect(buildCalendarSearch({ view: 'day', dateKey: today, staffId: STAFF }, today)).toBe(
      `?profesional=${STAFF}`,
    )
  })

  it('todo junto', () => {
    expect(buildCalendarSearch({ view: 'week', dateKey: '2026-11-12', staffId: STAFF }, today)).toBe(
      `?vista=semana&dia=2026-11-12&profesional=${STAFF}`,
    )
  })

  it('lo que se escribe se lee igual', () => {
    const state = { view: 'week' as const, dateKey: '2026-12-01', staffId: STAFF }
    expect(parseCalendarUrl(buildCalendarSearch(state, today))).toEqual(state)
  })
})
