import { describe, expect, it } from 'vitest'

import { validateStatusChange } from './appointments'

const NOW = new Date('2026-10-19T13:00:00Z')
const FUTURE = new Date('2026-10-19T14:00:00Z')
const PAST = new Date('2026-10-19T12:00:00Z')

function check(
  overrides: Partial<Parameters<typeof validateStatusChange>[0]> = {},
) {
  return validateStatusChange({
    currentStatus: 'confirmed',
    nextStatus: 'completed',
    startsAt: FUTURE,
    now: NOW,
    confirmPast: false,
    ...overrides,
  })
}

describe('validateStatusChange', () => {
  it('permite los cambios operativos desde confirmed', () => {
    expect(check({ nextStatus: 'completed' })).toEqual({
      ok: true,
      nextStatus: 'completed',
    })
    expect(check({ nextStatus: 'no_show' })).toEqual({
      ok: true,
      nextStatus: 'no_show',
    })
    expect(check({ nextStatus: 'cancelled' })).toEqual({
      ok: true,
      nextStatus: 'cancelled',
    })
  })

  it('permite confirmar una cita pendiente', () => {
    expect(
      check({ currentStatus: 'pending', nextStatus: 'confirmed' }),
    ).toEqual({ ok: true, nextStatus: 'confirmed' })
  })

  it('rechaza volver al mismo estado', () => {
    expect(check({ nextStatus: 'confirmed' })).toEqual({
      ok: false,
      code: 'invalid_transition',
    })
  })

  it('rechaza cambios desde estados terminales', () => {
    for (const currentStatus of [
      'cancelled',
      'completed',
      'no_show',
    ] as const) {
      expect(check({ currentStatus, nextStatus: 'completed' })).toEqual({
        ok: false,
        code: 'terminal_status',
      })
    }
  })

  it('rechaza estados desconocidos', () => {
    expect(check({ nextStatus: 'deleted' })).toEqual({
      ok: false,
      code: 'invalid_status',
    })
    expect(check({ nextStatus: null })).toEqual({
      ok: false,
      code: 'invalid_status',
    })
  })

  it('exige confirmación explícita para citas ya pasadas', () => {
    expect(check({ startsAt: PAST })).toEqual({
      ok: false,
      code: 'past_confirmation_required',
    })
    expect(check({ startsAt: PAST, confirmPast: true })).toEqual({
      ok: true,
      nextStatus: 'completed',
    })
  })

  it('no exige confirmación si la cita está justo ahora', () => {
    expect(check({ startsAt: NOW })).toEqual({
      ok: true,
      nextStatus: 'completed',
    })
  })
})
