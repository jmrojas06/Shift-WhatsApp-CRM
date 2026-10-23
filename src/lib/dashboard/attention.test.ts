import { describe, expect, it } from 'vitest'

import { summarizeAppointments, whatsappHealthFrom } from './attention'

describe('whatsappHealthFrom', () => {
  it('reads a healthy connection', () => {
    expect(whatsappHealthFrom({ connected: true })).toBe('connected')
  })

  it('separates "never set up" from "needs reconnecting"', () => {
    expect(whatsappHealthFrom({ connected: false, reason: 'no_config' })).toBe('not_configured')
    expect(whatsappHealthFrom({ connected: false, reason: 'token_corrupted' })).toBe('needs_attention')
    expect(whatsappHealthFrom({ connected: false, reason: 'meta_api_error' })).toBe('needs_attention')
  })

  it('never raises an alarm for lookup failures or junk', () => {
    expect(whatsappHealthFrom({ connected: false, reason: 'db_error' })).toBe('unknown')
    expect(whatsappHealthFrom({ connected: false, reason: 'no_account' })).toBe('unknown')
    expect(whatsappHealthFrom(null)).toBe('unknown')
    expect(whatsappHealthFrom('nope')).toBe('unknown')
  })
})

describe('summarizeAppointments', () => {
  const names = {
    services: new Map([['s1', 'Corte clásico']]),
    staff: new Map([['p1', 'Andrés']]),
    contacts: new Map([['c1', 'Laura M.']]),
  }
  const row = (id: string, startsAt: string, status: string) => ({
    id,
    starts_at: startsAt,
    status,
    service_id: 's1',
    staff_id: 'p1',
    contact_id: 'c1',
  })
  const now = new Date('2026-10-22T15:00:00Z')

  it('counts every non-cancelled appointment of the day', () => {
    const result = summarizeAppointments(
      [
        row('a', '2026-10-22T14:00:00Z', 'completed'),
        row('b', '2026-10-22T16:00:00Z', 'confirmed'),
        row('c', '2026-10-22T17:00:00Z', 'cancelled'),
      ],
      names,
      now,
    )
    expect(result.total).toBe(2)
  })

  it('lists only open appointments still ahead, soonest first, with names', () => {
    const result = summarizeAppointments(
      [
        row('late', '2026-10-22T20:00:00Z', 'pending'),
        row('past', '2026-10-22T13:00:00Z', 'confirmed'),
        row('soon', '2026-10-22T16:00:00Z', 'confirmed'),
        row('done', '2026-10-22T18:00:00Z', 'no_show'),
      ],
      names,
      now,
    )
    expect(result.upcoming.map((a) => a.id)).toEqual(['soon', 'late'])
    expect(result.upcoming[0]).toMatchObject({
      service: 'Corte clásico',
      staff: 'Andrés',
      contact: 'Laura M.',
    })
  })

  it('caps the list', () => {
    const rows = ['1', '2', '3', '4'].map((h) => row(h, `2026-10-22T1${h}:30:00Z`, 'pending'))
    expect(summarizeAppointments(rows, names, new Date('2026-10-22T00:00:00Z'), 2).upcoming).toHaveLength(2)
  })
})
