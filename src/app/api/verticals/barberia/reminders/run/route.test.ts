import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/ops/alert', () => ({ notifyAlert: async () => {} }))

import * as agendaRoute from '@/app/api/verticals/agenda/reminders/run/route'

import * as legacyRoute from './route'

describe('legacy /api/verticals/barberia/reminders/run alias', () => {
  it('exposes the same GET handler as the agenda route', () => {
    expect(legacyRoute.GET).toBe(agendaRoute.GET)
  })

  it('keeps the same maxDuration as the agenda route', () => {
    expect(legacyRoute.maxDuration).toBe(agendaRoute.maxDuration)
  })
})
