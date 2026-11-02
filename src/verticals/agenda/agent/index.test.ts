import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModuleKey, VerticalInboundContext } from '@/lib/verticals/types'

import { ACCOUNT, CONTACT, CONVERSATION, OWNER, clinicDb } from './testing/clinic-harness'
import { asClient } from './testing/fake-db'

const mocks = vi.hoisted(() => ({
  notifyAlert: vi.fn<(text: string) => Promise<void>>(async () => {}),
  sendText: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendButtons: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendList: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
}))

vi.mock('@/lib/ops/alert', () => ({ notifyAlert: mocks.notifyAlert }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: mocks.sendText,
  engineSendInteractiveButtons: mocks.sendButtons,
  engineSendInteractiveList: mocks.sendList,
}))

import { agendaInboundHandler } from './index'

/** Una base que se cae en cuanto el bot la toca. */
const brokenDb = {
  from() {
    throw new Error('base caída')
  },
} as unknown as SupabaseClient

function context(
  db: SupabaseClient,
  modules: readonly ModuleKey[] | undefined,
): VerticalInboundContext {
  return {
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    db,
    session: null,
    modules,
  }
}

describe('agendaInboundHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('en una cuenta con clínica, un error inesperado consume el mensaje y avisa', async () => {
    const result = await agendaInboundHandler(context(brokenDb, ['agenda', 'clinica']))

    // Consumido: la IA no ve el chat de un paciente cuando el bot falló.
    expect(result).toEqual({ consumed: true })
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    const text = mocks.notifyAlert.mock.calls[0][0]
    expect(text).toContain(ACCOUNT)
    expect(text).toContain(CONVERSATION)
    expect(text).toContain('base caída')
    expect(console.error).toHaveBeenCalled()
  })

  it('en una cuenta sin clínica, el error sigue subiendo como antes', async () => {
    await expect(agendaInboundHandler(context(brokenDb, ['agenda']))).rejects.toThrow('base caída')
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })

  it('si el contexto no trae módulos, tampoco se traga el error', async () => {
    await expect(agendaInboundHandler(context(brokenDb, undefined))).rejects.toThrow('base caída')
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })

  it('el aviso no lleva el teléfono ni el identificador de WhatsApp que traiga el error', async () => {
    // Un error de la base puede repetir la fila que no pudo guardar.
    const leaky = {
      from() {
        throw new Error(
          'duplicate key (573001112233) for +57 300 111 2233, user US.13491208655302741918, wa 3001112233',
        )
      },
    } as unknown as SupabaseClient
    await agendaInboundHandler(context(leaky, ['clinica']))
    const text = mocks.notifyAlert.mock.calls[0][0]
    expect(text).not.toMatch(/\d{4,}/)
    expect(text).not.toContain('300 111')
    expect(text).toContain('duplicate key')
    expect(text).toContain('#')
  })

  it('el aviso corta un error larguísimo', async () => {
    const long = {
      from() {
        throw new Error(`falló ${'x'.repeat(2000)}`)
      },
    } as unknown as SupabaseClient
    await agendaInboundHandler(context(long, ['clinica']))
    expect(mocks.notifyAlert.mock.calls[0][0].length).toBeLessThan(700)
  })

  it('sin fallos, devuelve lo que decide el bot y no avisa nada', async () => {
    // Una cuenta con clínica que aún no autorizó: el bot pide la autorización
    // por el envío real (aquí, el simulado del motor de flujos).
    const result = await agendaInboundHandler(
      context(asClient(clinicDb()), ['agenda', 'clinica']),
    )
    expect(result).toEqual({ consumed: true })
    expect(mocks.sendButtons).toHaveBeenCalledTimes(1)
    expect(mocks.sendButtons.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      bodyText: 'Texto de autorización',
    })
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })
})
