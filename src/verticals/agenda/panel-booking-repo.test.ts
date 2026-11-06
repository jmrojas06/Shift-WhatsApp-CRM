import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { TEST_ACCOUNT } from '@/app/api/verticals/agenda/_lib/route-testing'

import { asClient, type FakeDb } from './agent/testing/fake-db'
import {
  activeAppointment,
  CONTACT,
  CONVERSATION,
  seedPanelDb,
  STAFF,
} from './agent/testing/panel-fixtures'
import { ensureConversation, loadSlotContext } from './panel-booking-repo'

const client = (db: FakeDb): SupabaseClient => asClient(db)

describe('ensureConversation', () => {
  const args = { accountId: TEST_ACCOUNT, contactId: CONTACT, userId: 'user-1' }

  it('usa la conversación que el contacto ya tiene y no crea otra', async () => {
    const db = seedPanelDb()
    expect(await ensureConversation(client(db), args)).toBe(CONVERSATION)
    expect(db._tables.conversations).toHaveLength(1)
  })

  it('si hay varias, usa la más antigua', async () => {
    const db = seedPanelDb({
      extra: {
        conversations: [
          { id: 'nueva', account_id: TEST_ACCOUNT, contact_id: CONTACT, created_at: '2026-10-05T00:00:00.000Z' },
          { id: 'vieja', account_id: TEST_ACCOUNT, contact_id: CONTACT, created_at: '2026-09-05T00:00:00.000Z' },
        ],
      },
    })
    expect(await ensureConversation(client(db), args)).toBe('vieja')
  })

  it('no mira conversaciones de otra cuenta con el mismo contacto', async () => {
    const db = seedPanelDb({
      extra: {
        conversations: [
          { id: 'ajena', account_id: 'acc-2', contact_id: CONTACT, created_at: '2026-09-05T00:00:00.000Z' },
        ],
      },
    })
    const id = await ensureConversation(client(db), args)
    expect(id).not.toBe('ajena')
    expect(db._tables.conversations).toHaveLength(2)
  })

  it('si otra petición la creó al mismo tiempo (23505), usa la ganadora', async () => {
    const db = seedPanelDb({ extra: { conversations: [] } })
    db._failNext('insert', 'conversations', { code: '23505', message: 'duplicate key' })
    const realFrom = db.from.bind(db)
    db.from = (table: string) => {
      const query = realFrom(table) as { insert: (row: unknown) => unknown }
      if (table === 'conversations') {
        const insert = query.insert.bind(query)
        query.insert = (row: unknown) => {
          // La otra petición llegó primero.
          db._tables.conversations.push({
            id: 'ganadora',
            account_id: TEST_ACCOUNT,
            contact_id: CONTACT,
            created_at: '2026-11-05T00:00:00.000Z',
          })
          return insert(row)
        }
      }
      return query
    }
    expect(await ensureConversation(client(db), args)).toBe('ganadora')
  })

  it('otro error de la base lanza (no se inventa una conversación)', async () => {
    const db = seedPanelDb({ extra: { conversations: [] } })
    db._failNext('insert', 'conversations', { code: '42501', message: 'sin permiso' })
    await expect(ensureConversation(client(db), args)).rejects.toThrow(/conversaci/i)
  })
})

describe('loadSlotContext', () => {
  const startsAt = new Date('2026-11-09T15:00:00.000Z')
  const endsAt = new Date('2026-11-09T15:30:00.000Z')
  const base = { accountId: TEST_ACCOUNT, staffId: STAFF, startsAt, endsAt }

  it('sin clínica no lee sillones', async () => {
    const db = seedPanelDb()
    const slot = await loadSlotContext(client(db), { ...base, clinic: false })
    expect(slot.chairs).toBeNull()
    expect(slot.workBlocks).toHaveLength(5)
    expect(slot.timeOff).toEqual([])
  })

  it('solo trae los bloqueos de ese profesional que tocan la franja', async () => {
    const db = seedPanelDb({
      extra: {
        booking_time_off: [
          { account_id: TEST_ACCOUNT, staff_id: STAFF, starts_at: '2026-11-09T14:00:00.000Z', ends_at: '2026-11-09T15:10:00.000Z' },
          { account_id: TEST_ACCOUNT, staff_id: STAFF, starts_at: '2026-11-09T15:30:00.000Z', ends_at: '2026-11-09T17:00:00.000Z' },
          { account_id: TEST_ACCOUNT, staff_id: 'otro', starts_at: '2026-11-09T14:00:00.000Z', ends_at: '2026-11-09T17:00:00.000Z' },
        ],
      },
    })
    const slot = await loadSlotContext(client(db), { ...base, clinic: false })
    expect(slot.timeOff).toEqual([
      { startsAt: new Date('2026-11-09T14:00:00.000Z'), endsAt: new Date('2026-11-09T15:10:00.000Z') },
    ])
  })

  it('en una clínica descuenta UNA sola cita con la franja de la propia (si hay otra igual, sigue contando)', async () => {
    const db = seedPanelDb({
      modules: ['agenda', 'clinica'],
      chairCount: 3,
      extra: {
        booking_appointments: [
          activeAppointment({ id: 'a' }),
          activeAppointment({ id: 'b', staff_id: 'otro-1' }),
        ],
      },
    })
    const slot = await loadSlotContext(client(db), {
      ...base,
      clinic: true,
      ignore: { startsAt, endsAt },
    })
    expect(slot.chairs?.chairCount).toBe(3)
    expect(slot.chairs?.active).toHaveLength(1)
  })

  it('en una clínica sin cupo puesto no hay límite ni lectura de citas', async () => {
    const db = seedPanelDb({ modules: ['agenda', 'clinica'], chairCount: null })
    const slot = await loadSlotContext(client(db), { ...base, clinic: true })
    expect(slot.chairs).toEqual({ chairCount: null, active: [] })
  })
})
