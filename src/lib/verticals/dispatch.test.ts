import { beforeEach, describe, expect, it, vi } from 'vitest'

// The dispatcher talks to Postgres through the service-role client with
// one shape only: from(table).select(...).eq(...)[.eq(...).gt(...)]
// .maybeSingle(). This stub answers exactly that chain, per table, so
// each test can set up the rows it needs.
const dbState = vi.hoisted(() => ({
  responses: {} as Record<string, { data: unknown; error: unknown }>,
  throwOn: null as string | null,
  handlerResult: { consumed: false } as { consumed: boolean },
  handlerThrows: false,
  handlerCalls: [] as Record<string, unknown>[],
  /** Simula una base sin la migración 053: pedir `modules` falla (42703). */
  modulesColumnMissing: false,
  /** Qué columnas de `accounts` pidió el dispatcher, en orden. */
  accountSelects: [] as string[],
  /** Tablas consultadas, en orden. */
  tablesRead: [] as string[],
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      dbState.tablesRead.push(table)
      let cols = ''
      const chain = {
        select: (c?: string) => {
          cols = c ?? ''
          if (table === 'accounts') dbState.accountSelects.push(cols)
          return chain
        },
        eq: () => chain,
        gt: () => chain,
        maybeSingle: async () => {
          if (dbState.throwOn === table) {
            throw new Error(`db down: ${table}`)
          }
          if (
            table === 'accounts' &&
            dbState.modulesColumnMissing &&
            cols.includes('modules')
          ) {
            return {
              data: null,
              error: {
                code: '42703',
                message: 'column accounts.modules does not exist',
              },
            }
          }
          return dbState.responses[table] ?? { data: null, error: null }
        },
      }
      return chain
    },
  }),
}))

// The registered barbería handler pulls in meta-send and the full
// booking controller; the dispatcher only needs to know it is wired
// and what result it reports.
vi.mock('@/verticals/agenda/agent', () => ({
  agendaInboundHandler: async (ctx: Record<string, unknown>) => {
    dbState.handlerCalls.push(ctx)
    if (dbState.handlerThrows) throw new Error('handler boom')
    return dbState.handlerResult
  },
}))

import { dispatchInboundToVertical } from './dispatch'

const baseArgs = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid-1',
}

const agendaAccount = { data: { vertical_key: 'agenda' }, error: null }
const legacyAgendaAccount = {
  data: { vertical_key: 'barberia' },
  error: null,
}
const openConversation = {
  data: { assigned_agent_id: null, ai_autoreply_disabled: false },
  error: null,
}

beforeEach(() => {
  dbState.responses = {}
  dbState.throwOn = null
  dbState.handlerResult = { consumed: false }
  dbState.handlerThrows = false
  dbState.handlerCalls = []
  dbState.modulesColumnMissing = false
  dbState.accountSelects = []
  dbState.tablesRead = []
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
      accounts: agendaAccount,
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
      accounts: agendaAccount,
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
    dbState.responses = { accounts: agendaAccount }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
  })

  it('consumes nothing when the handler declines and there is no active session', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: openConversation,
      booking_sessions: { data: null, error: null },
    }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
    expect(dbState.handlerCalls).toHaveLength(1)
  })

  it('claims the message while a booking session is active, even between handler invocations', async () => {
    dbState.responses = {
      accounts: agendaAccount,
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

  it('routes accounts still on the legacy barberia key to the agenda handler', async () => {
    dbState.responses = {
      accounts: legacyAgendaAccount,
      conversations: openConversation,
      booking_sessions: { data: null, error: null },
    }
    dbState.handlerResult = { consumed: true }

    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: true,
    })
    expect(dbState.handlerCalls).toHaveLength(1)
  })

  it('delegates to the registered agenda handler and honors its consume', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: openConversation,
      booking_sessions: { data: null, error: null },
    }
    dbState.handlerResult = { consumed: true }

    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: true,
    })
    expect(dbState.handlerCalls).toHaveLength(1)
    expect(dbState.handlerCalls[0]).toMatchObject({
      accountId: 'acc-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      configOwnerUserId: 'user-1',
      inboundMessageId: 'wamid-1',
      session: null,
    })
  })

  it('hands the fresh booking session to the handler', async () => {
    dbState.responses = {
      accounts: agendaAccount,
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
    await dispatchInboundToVertical(baseArgs)
    expect(dbState.handlerCalls[0].session).toEqual({
      id: 'sess-1',
      state: { step: 'pick_service' },
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
  })

  // D1: a human-owned thread still reaches the handler, flagged, so it
  // can answer reminder buttons (Confirmar / Cancelar / Reprogramar).
  it('a human-owned thread reaches the handler with humanOwned: true', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: {
        data: { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false },
        error: null,
      },
    }
    await dispatchInboundToVertical(baseArgs)
    expect(dbState.handlerCalls).toHaveLength(1)
    expect(dbState.handlerCalls[0].humanOwned).toBe(true)
  })

  it('a paused thread (ai_autoreply_disabled) is also flagged humanOwned', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: {
        data: { assigned_agent_id: null, ai_autoreply_disabled: true },
        error: null,
      },
    }
    await dispatchInboundToVertical(baseArgs)
    expect(dbState.handlerCalls[0].humanOwned).toBe(true)
  })

  it('an open thread is flagged humanOwned: false', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: openConversation,
      booking_sessions: { data: null, error: null },
    }
    await dispatchInboundToVertical(baseArgs)
    expect(dbState.handlerCalls[0].humanOwned).toBe(false)
  })

  it('on a human-owned thread an active session does NOT claim what the handler declined', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: {
        data: { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false },
        error: null,
      },
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
      consumed: false,
    })
  })

  it('on a human-owned thread a handler consume (reminder tap) is honored', async () => {
    dbState.responses = {
      accounts: agendaAccount,
      conversations: {
        data: { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false },
        error: null,
      },
    }
    dbState.handlerResult = { consumed: true }
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: true,
    })
  })

  describe('módulos combinables', () => {
    it('una cuenta con modules [agenda, ventas] sigue usando el bot de la agenda', async () => {
      dbState.responses = {
        accounts: {
          data: { modules: ['agenda', 'ventas'], vertical_key: null },
          error: null,
        },
        conversations: openConversation,
        booking_sessions: { data: null, error: null },
      }
      dbState.handlerResult = { consumed: true }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: true,
      })
      expect(dbState.handlerCalls).toHaveLength(1)
    })

    it('una cuenta solo con ventas (sin bot) no consume nada ni llama al bot', async () => {
      dbState.responses = {
        accounts: {
          data: { modules: ['ventas'], vertical_key: null },
          error: null,
        },
        conversations: openConversation,
        booking_sessions: { data: null, error: null },
      }
      dbState.handlerResult = { consumed: true }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: false,
      })
      expect(dbState.handlerCalls).toHaveLength(0)
    })

    it('con modules [agenda, ventas] un hilo con humano llega al bot como humanOwned y no reclama el resto', async () => {
      const humanThread = {
        data: { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false },
        error: null,
      }
      dbState.responses = {
        accounts: {
          data: { modules: ['agenda', 'ventas'], vertical_key: null },
          error: null,
        },
        conversations: humanThread,
        booking_sessions: {
          data: {
            id: 'sess-1',
            state: {},
            expires_at: '2099-01-01T00:00:00.000Z',
          },
          error: null,
        },
      }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: false,
      })
      expect(dbState.handlerCalls).toHaveLength(1)
      expect(dbState.handlerCalls[0].humanOwned).toBe(true)

      dbState.handlerResult = { consumed: true }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: true,
      })
    })

    it('una cuenta solo con ventas y un hilo con humano tampoco consume', async () => {
      dbState.responses = {
        accounts: {
          data: { modules: ['ventas'], vertical_key: null },
          error: null,
        },
        conversations: {
          data: { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false },
          error: null,
        },
      }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: false,
      })
      expect(dbState.handlerCalls).toHaveLength(0)
    })

    it('modules vacío cae a vertical_key', async () => {
      dbState.responses = {
        accounts: {
          data: { modules: [], vertical_key: 'barberia' },
          error: null,
        },
        conversations: openConversation,
        booking_sessions: { data: null, error: null },
      }
      dbState.handlerResult = { consumed: true }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: true,
      })
    })

    it('antes de la migración 053 (sin columna modules) el bot de la agenda sigue funcionando', async () => {
      dbState.modulesColumnMissing = true
      dbState.responses = {
        accounts: { data: { vertical_key: 'agenda' }, error: null },
        conversations: openConversation,
        booking_sessions: { data: null, error: null },
      }
      dbState.handlerResult = { consumed: true }
      await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
        consumed: true,
      })
      expect(dbState.accountSelects).toEqual([
        'modules, vertical_key',
        'vertical_key',
      ])
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

  it('swallows a handler failure and does not consume', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    dbState.responses = {
      accounts: agendaAccount,
      conversations: openConversation,
      booking_sessions: { data: null, error: null },
    }
    dbState.handlerThrows = true
    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
      consumed: false,
    })
    consoleError.mockRestore()
  })
})
