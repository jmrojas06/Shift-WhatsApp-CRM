import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Envío real de los seguimientos — contrato con el runner.
//
// El runner revierte el reclamo (y reintenta) cuando el envío LANZA. Por eso aquí
// se fija: si Meta ya aceptó el mensaje y solo falla el registro en `messages`, el
// envío NO lanza (si no, el paciente recibiría el mismo mensaje dos veces).
// Además: las instrucciones de cuidado nunca viajan en una plantilla, y los
// botones llevan el id del seguimiento.
// ============================================================

type Row = Record<string, unknown>

const state: {
  contact: Row | null
  messagesInsertError: { message: string } | null
  inserted: { table: string; row: Row }[]
  updated: { table: string; row: Row }[]
} = { contact: null, messagesInsertError: null, inserted: [], updated: [] }

/** Fake mínimo de Supabase para la rama de plantilla. */
function fakeDb() {
  return {
    from(table: string) {
      let updating: Row | null = null
      const api = {
        select: () => api,
        eq: () => api,
        update: (row: Row) => {
          updating = row
          return api
        },
        maybeSingle: async () =>
          table === 'contacts'
            ? { data: state.contact, error: null }
            : { data: null, error: null },
        insert: async (row: Row) => {
          if (table === 'messages' && state.messagesInsertError) {
            return { error: state.messagesInsertError }
          }
          state.inserted.push({ table, row })
          return { error: null }
        },
        then: (resolve: (v: { data: null; error: null }) => unknown) => {
          if (updating) state.updated.push({ table, row: updating })
          return Promise.resolve(resolve({ data: null, error: null }))
        },
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
const sendText = vi.fn()
const createAgendaSender = vi.fn()
vi.mock('@/verticals/agenda/agent/index', () => ({
  createAgendaSender: (...args: unknown[]) => {
    createAgendaSender(...args)
    return {
      sendText: (...a: unknown[]) => sendText(...a),
      sendList: vi.fn(),
      sendButtons: (...a: unknown[]) => sendButtons(...a),
    }
  },
}))

import { MessagePersistAfterSendError } from '@/lib/flows/meta-send'
import { DEFAULT_LABELS } from '@/verticals/agenda/labels'

import type { FollowupDelivery, FollowupKind } from './followups'
import { sendClinicFollowup } from './followups-send'

function delivery(over: Partial<FollowupDelivery> = {}): FollowupDelivery {
  return {
    followupId: 'fu-1',
    appointmentId: 'ap-1',
    kind: 'como_sigues',
    accountId: 'acc-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    ownerUserId: 'u-owner',
    channel: 'text',
    businessName: 'Clínica Sonrisa',
    patientName: 'Tomás Gil',
    aftercare: null,
    labels: DEFAULT_LABELS,
    ...over,
  }
}

beforeEach(() => {
  state.contact = { id: 'ct-1', phone: '573001112233', wa_user_id: null }
  state.messagesInsertError = null
  state.inserted = []
  state.updated = []
  sendButtons.mockReset()
  sendText.mockReset()
  createAgendaSender.mockReset()
  sendTemplateMessage.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendClinicFollowup — mensaje libre', () => {
  it('"¿cómo sigues?" sale con tres botones amarrados al seguimiento', async () => {
    sendButtons.mockResolvedValue(undefined)

    await sendClinicFollowup(delivery())

    expect(createAgendaSender).toHaveBeenCalledWith({
      accountId: 'acc-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      configOwnerUserId: 'u-owner',
    })
    const args = sendButtons.mock.calls[0][0] as {
      bodyText: string
      buttons: { id: string; title: string }[]
    }
    expect(args.bodyText).toContain('Tomás Gil')
    expect(args.buttons).toEqual([
      { id: 'fu:bien:fu-1', title: 'Bien' },
      { id: 'fu:molestias:fu-1', title: 'Tengo molestias' },
      { id: 'fu:ayuda:fu-1', title: 'Necesito ayuda' },
    ])
    expect(sendText).not.toHaveBeenCalled()
  })

  it('la calificación sale con Bien / Regular / Mal', async () => {
    sendButtons.mockResolvedValue(undefined)

    await sendClinicFollowup(delivery({ kind: 'calificacion' }))

    const args = sendButtons.mock.calls[0][0] as { buttons: { id: string }[] }
    expect(args.buttons.map((b) => b.id)).toEqual([
      'rt:bien:fu-1',
      'rt:regular:fu-1',
      'rt:mal:fu-1',
    ])
  })

  it('los cuidados salen como texto con las instrucciones del servicio', async () => {
    sendText.mockResolvedValue(undefined)

    await sendClinicFollowup(
      delivery({ kind: 'cuidados', aftercare: 'No comas por 2 horas.' }),
    )

    expect(sendText).toHaveBeenCalledTimes(1)
    const { text } = sendText.mock.calls[0][0] as { text: string }
    expect(text).toContain('No comas por 2 horas.')
    expect(text).toContain('Tomás Gil')
    expect(sendButtons).not.toHaveBeenCalled()
  })

  it('si Meta lo envió pero falla el registro, no lanza (el runner no reenvía)', async () => {
    sendButtons.mockRejectedValue(
      new MessagePersistAfterSendError('No se pudo guardar el mensaje', 'wamid-ok'),
    )

    await expect(sendClinicFollowup(delivery())).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no se reenvía'),
      expect.any(String),
    )
  })

  it('lo mismo con los cuidados en texto', async () => {
    sendText.mockRejectedValue(
      new MessagePersistAfterSendError('No se pudo guardar el mensaje', 'wamid-ok'),
    )

    await expect(
      sendClinicFollowup(delivery({ kind: 'cuidados', aftercare: 'Cuidados' })),
    ).resolves.toBeUndefined()
  })

  it('si Meta rechaza el envío, lanza para que el runner revierta y reintente', async () => {
    sendButtons.mockRejectedValue(new Error('(#131047) Re-engagement message'))

    await expect(sendClinicFollowup(delivery())).rejects.toThrow('131047')
  })

  it('el aviso de un envío ya entregado no lleva el nombre del paciente', async () => {
    sendButtons.mockRejectedValue(
      new MessagePersistAfterSendError('No se pudo guardar el mensaje', 'wamid-ok'),
    )

    await sendClinicFollowup(delivery())

    const logged = JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls)
    expect(logged).not.toContain('Tomás')
    expect(logged).not.toContain('573001112233')
  })
})

describe('sendClinicFollowup — plantilla', () => {
  beforeEach(() => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })
  })

  it.each<[FollowupKind, string, string[]]>([
    ['cuidados', 'cuidados_cita_clinica', ['fu:cuidados:fu-1']],
    [
      'como_sigues',
      'como_sigues_clinica',
      ['fu:bien:fu-1', 'fu:molestias:fu-1', 'fu:ayuda:fu-1'],
    ],
    [
      'calificacion',
      'calificacion_visita_clinica',
      ['rt:bien:fu-1', 'rt:regular:fu-1', 'rt:mal:fu-1'],
    ],
  ])('%s usa %s con negocio y paciente, y los payloads del seguimiento', async (kind, name, payloads) => {
    await sendClinicFollowup(delivery({ kind, channel: 'template' }))

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(sendTemplateMessage.mock.calls[0][0]).toStrictEqual({
      phoneNumberId: 'pn-1',
      accessToken: 'token',
      to: '573001112233',
      templateName: name,
      language: 'es',
      params: ['Clínica Sonrisa', 'Tomás Gil'],
      quickReplyPayloads: payloads,
    })
  })

  it('las instrucciones de cuidado no viajan en la plantilla ni se guardan como si lo hubieran hecho', async () => {
    await sendClinicFollowup(
      delivery({ kind: 'cuidados', channel: 'template', aftercare: 'No comas por 2 horas.' }),
    )

    expect(JSON.stringify(sendTemplateMessage.mock.calls)).not.toContain('No comas')
    const saved = state.inserted.find((i) => i.table === 'messages')
    expect(String(saved?.row.content_text)).not.toContain('No comas')
  })

  it('camino feliz: registra el saliente y actualiza la conversación', async () => {
    await sendClinicFollowup(delivery({ channel: 'template' }))

    const saved = state.inserted.find((i) => i.table === 'messages')
    expect(saved?.row).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'template',
      template_name: 'como_sigues_clinica',
      message_id: 'wamid-tpl',
      status: 'sent',
    })
    expect(String(saved?.row.content_text)).toContain('Tomás Gil')
    expect(state.updated.some((u) => u.table === 'conversations')).toBe(true)
  })

  it('si Meta lo envió pero falla el insert en messages, no lanza', async () => {
    state.messagesInsertError = { message: 'insert failed' }

    await expect(
      sendClinicFollowup(delivery({ channel: 'template' })),
    ).resolves.toBeUndefined()
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('si Meta rechaza la plantilla, lanza', async () => {
    sendTemplateMessage.mockRejectedValue(new Error('(#132001) Template does not exist'))

    await expect(
      sendClinicFollowup(delivery({ channel: 'template' })),
    ).rejects.toThrow('132001')
  })

  it('reintenta con las otras formas del teléfono y guarda la que funcionó', async () => {
    sendTemplateMessage
      .mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValue({ messageId: 'wamid-2' })

    await sendClinicFollowup(delivery({ channel: 'template' }))

    expect(sendTemplateMessage).toHaveBeenCalledTimes(2)
    const first = (sendTemplateMessage.mock.calls[0][0] as { to: string }).to
    const second = (sendTemplateMessage.mock.calls[1][0] as { to: string }).to
    expect(first).toBe('573001112233')
    expect(second).not.toBe(first)
    expect(state.updated).toContainEqual({ table: 'contacts', row: { phone: second } })
  })

  it('un contacto sin número de WhatsApp lanza (no hay a quién enviar)', async () => {
    state.contact = { id: 'ct-1', phone: '', wa_user_id: null }

    await expect(
      sendClinicFollowup(delivery({ channel: 'template' })),
    ).rejects.toThrow('número de WhatsApp')
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('un contacto que no está en la cuenta lanza', async () => {
    state.contact = null

    await expect(
      sendClinicFollowup(delivery({ channel: 'template' })),
    ).rejects.toThrow('contacto no encontrado')
  })

  it('un error del contacto no lleva el nombre ni el número del paciente', async () => {
    state.contact = { id: 'ct-1', phone: '', wa_user_id: null }

    const err = await sendClinicFollowup(delivery({ channel: 'template' })).catch((e: Error) => e)

    expect((err as Error).message).not.toContain('Tomás')
    expect((err as Error).message).not.toContain('5730')
  })
})
