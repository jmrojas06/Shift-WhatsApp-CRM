import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Envío real del recordatorio — contrato con el runner.
//
// El runner revierte la marca (y reintenta) cuando el envío LANZA.
// Por eso aquí se fija: si Meta ya aceptó el mensaje y solo falla el
// registro en `messages`, el envío NO lanza — de lo contrario el
// cliente recibiría el mismo recordatorio dos veces.
// ============================================================

type Row = Record<string, unknown>

const state: {
  messagesInsertError: { message: string } | null
  inserted: Row[]
} = { messagesInsertError: null, inserted: [] }

/** Fake mínimo de Supabase para la rama de plantilla. */
function fakeDb() {
  return {
    from(table: string) {
      const api = {
        select: () => api,
        eq: () => api,
        update: () => api,
        maybeSingle: async () =>
          table === 'contacts'
            ? { data: { id: 'ct-1', phone: '573001112233', wa_user_id: null }, error: null }
            : { data: null, error: null },
        insert: async (row: Row) => {
          if (table === 'messages' && state.messagesInsertError) {
            return { error: state.messagesInsertError }
          }
          state.inserted.push(row)
          return { error: null }
        },
        then: (resolve: (v: { data: null; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: null, error: null })),
      }
      return api
    },
  }
}

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fakeDb() }))

const sendTemplateMessage = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
}))

vi.mock('@/lib/flows/meta-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/flows/meta-send')>()),
  loadAccountMetaCredentials: async () => ({
    phoneNumberId: 'pn-1',
    accessToken: 'token',
  }),
}))

const sendButtons = vi.fn()
vi.mock('./index', () => ({
  createBarberiaSender: () => ({
    sendText: vi.fn(),
    sendList: vi.fn(),
    sendButtons: (...args: unknown[]) => sendButtons(...args),
  }),
}))

import { MessagePersistAfterSendError } from '@/lib/flows/meta-send'

import { sendBarberiaReminder } from './reminders-send'
import type { ReminderDelivery } from './reminders'

function delivery(channel: 'text' | 'template'): ReminderDelivery {
  return {
    appointmentId: 'ap-1',
    accountId: 'acc-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    ownerUserId: 'u-owner',
    kind: 'h24',
    channel,
    businessName: 'Barbería El Parche',
    serviceName: 'Corte clásico',
    staffName: 'Andrés',
    startsAtIso: '2026-10-20T12:00:00.000Z',
    dateLabel: 'martes 20 de octubre de 2026',
    timeLabel: '7:00 a. m.',
  }
}

beforeEach(() => {
  state.messagesInsertError = null
  state.inserted = []
  sendButtons.mockReset()
  sendTemplateMessage.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendBarberiaReminder — mensaje libre', () => {
  it('si Meta lo envió pero falla el registro, no lanza (el runner no reenvía)', async () => {
    sendButtons.mockRejectedValue(
      new MessagePersistAfterSendError('No se pudo guardar el mensaje', 'wamid-ok'),
    )

    await expect(sendBarberiaReminder(delivery('text'))).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no se reenvía'),
      expect.any(String),
    )
  })

  it('si Meta rechaza el envío, lanza para que el runner revierta y reintente', async () => {
    sendButtons.mockRejectedValue(new Error('(#131047) Re-engagement message'))

    await expect(sendBarberiaReminder(delivery('text'))).rejects.toThrow('131047')
  })
})

describe('sendBarberiaReminder — plantilla', () => {
  it('si Meta lo envió pero falla el insert en messages, no lanza', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })
    state.messagesInsertError = { message: 'insert failed' }

    await expect(
      sendBarberiaReminder(delivery('template')),
    ).resolves.toBeUndefined()
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('camino feliz: envía la plantilla y la registra', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })

    await sendBarberiaReminder(delivery('template'))

    expect(state.inserted[0]).toMatchObject({
      conversation_id: 'cv-1',
      content_type: 'template',
      template_name: 'recordatorio_cita',
      message_id: 'wamid-tpl',
    })
  })

  it('si Meta rechaza la plantilla, lanza', async () => {
    sendTemplateMessage.mockRejectedValue(new Error('(#132001) Template does not exist'))

    await expect(sendBarberiaReminder(delivery('template'))).rejects.toThrow('132001')
  })
})
