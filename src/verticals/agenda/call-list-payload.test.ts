import { describe, expect, it } from 'vitest'

import type { CallListRow } from './call-list'
import { callListRowFromPayload, callListRowToPayload } from './call-list-payload'

const ROW: CallListRow = {
  appointmentId: 'a1',
  startsAt: '2026-11-06T15:00:00.000Z',
  contactId: 'c1',
  patientName: 'Julián Pardo',
  contactName: 'Natalia Pardo',
  phone: '573104448899',
  staffName: 'Dra. Rojas',
  reason: 'robot_human',
  robotAttempts: 2,
  manualAttempts: 1,
  lastRobot: { outcome: 'human', status: 'completed', at: '2026-11-05T12:00:00.000Z' },
  lastManual: { outcome: 'no_response', status: 'no_answer', at: '2026-11-05T13:00:00.000Z' },
  robotInProgress: false,
  canRobotCall: true,
}

describe('call-list-payload', () => {
  it('ida y vuelta: la fila queda igual', () => {
    expect(callListRowFromPayload(callListRowToPayload(ROW))).toEqual(ROW)
  })

  it('las llamadas que faltan viajan como null', () => {
    const payload = callListRowToPayload({ ...ROW, lastRobot: null, lastManual: null })
    expect(payload.last_robot).toBeNull()
    expect(payload.last_manual).toBeNull()
    expect(callListRowFromPayload(payload)).toMatchObject({ lastRobot: null, lastManual: null })
  })

  it('descarta una fila rota en vez de romper la pantalla', () => {
    const good = callListRowToPayload(ROW)
    expect(callListRowFromPayload(null)).toBeNull()
    expect(callListRowFromPayload('texto')).toBeNull()
    expect(callListRowFromPayload({ ...good, appointment_id: '' })).toBeNull()
    expect(callListRowFromPayload({ ...good, starts_at: undefined })).toBeNull()
    expect(callListRowFromPayload({ ...good, reason: 'inventado' })).toBeNull()
  })

  it('una llamada anterior sin estado se ignora, la fila sigue', () => {
    const row = callListRowFromPayload({ ...callListRowToPayload(ROW), last_robot: { outcome: 'human' } })
    expect(row?.lastRobot).toBeNull()
    expect(row?.appointmentId).toBe('a1')
  })
})
