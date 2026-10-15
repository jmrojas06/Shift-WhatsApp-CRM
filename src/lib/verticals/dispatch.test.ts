import { beforeEach, describe, expect, it, vi } from 'vitest'

// The dispatcher talks to Postgres through the service-role client with
// one shape only: from(table).select(...).eq(...)[.eq(...).gt(...)]
// .maybeSingle(). This stub answers exactly that chain, per table, so
// each test can set up the rows it needs.
const dbState = vi.hoisted(() => ({
  responses: {} as Record<string, { data: unknown; error: unknown }>,
  throwOn: null as string | null,
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        maybeSingle: async () => {
          if (dbState.throwOn === table) {
            throw new Error(`db down: ${table}`)
          }
          return dbState.responses[table] ?? { data: null, error: null }
        },
      }
      return chain
    },
  }),
}))

import { dispatchInboundToVertical } from './dispatch'

const baseArgs = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid-1',
}

const barberiaAccount = { data: { vertical_key: 'barberia' }, error: null }
const openConversation = {
  data: { assigned_agent_id: null, ai_autoreply_disabled: false },
  error: null,
}

beforeEach(() => {
  dbState.responses = {}
  dbState.throwOn = null
})

describe('dispatchInboundToVertical', () => {
  it('stays out when the account has no vertical installed', async () => {
    dbState.responses = {
      accounts: { data: { vertical_key: null }, error: null },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('stays out when the account row is missing', async () => {
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('stays out on unknown vertical keys', async () => {
    dbState.responses = {
      accounts: { data: { vertical_key: 'salon' }, error: null },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('stands down when a human owns the conversation', async () => {
    dbState.responses = {
      accounts: barberiaAccount,
      conversations: {
        data: { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false },
        error: null,
      },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('stands down when AI auto-reply was disabled for the conversation', async () => {
    dbState.responses = {
      accounts: barberiaAccount,
      conversations: {
        data: { assigned_agent_id: null, ai_autoreply_disabled: true },
        error: null,
      },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('stays out when the conversation is gone', async () => {
    dbState.responses = { accounts: barberiaAccount }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('consumes nothing when there is no active booking session', async () => {
    dbState.responses = {
      accounts: barberiaAccount,
      conversations: openConversation,
      booking_sessions: { data: null, error: null },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('claims the message while a booking session is active', async () => {
    dbState.responses = {
      accounts: barberiaAccount,
      conversations: openConversation,
      booking_sessions: {
        data: {
          id: 'sess-1',
          state: { step: 'pick_service' },
          expires_at: '2099-01-01T00:00:00.000Z',
        },
        error: null,
      },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: true,
    })
  })

  it('never throws when the lookup fails', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    dbState.throwOn = 'accounts'
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
    consoleError.mockRestore()
  })
})
