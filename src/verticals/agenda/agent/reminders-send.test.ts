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
  createAgendaSender: () => ({
    sendText: vi.fn(),
    sendList: vi.fn(),
    sendButtons: (...args: unknown[]) => sendButtons(...args),
  }),
}))

import { MessagePersistAfterSendError } from '@/lib/flows/meta-send'

import { sendAgendaReminder } from './reminders-send'
import { DEFAULT_LABELS } from '../labels'
import { isReminderTemplateName, type ReminderDelivery } from './reminders'

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
    labels: DEFAULT_LABELS,
    allowReschedule: true,
  }
}

beforeEach(() => {
  state.messagesInsertError = null
  state.inserted = []
  sendButtons.mockReset()
  sendTemplateMessage.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendAgendaReminder — mensaje libre', () => {
  it('si Meta lo envió pero falla el registro, no lanza (el runner no reenvía)', async () => {
    sendButtons.mockRejectedValue(
      new MessagePersistAfterSendError('No se pudo guardar el mensaje', 'wamid-ok'),
    )

    await expect(sendAgendaReminder(delivery('text'))).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no se reenvía'),
      expect.any(String),
    )
  })

  it('con reprogramar/cancelar apagado solo ofrece el botón Confirmar', async () => {
    sendButtons.mockResolvedValue(undefined)

    await sendAgendaReminder({ ...delivery('text'), allowReschedule: false })

    const args = sendButtons.mock.calls[0][0] as { buttons: { id: string }[] }
    expect(args.buttons.map((b) => b.id)).toEqual(['rem:confirm'])
  })

  it('si Meta rechaza el envío, lanza para que el runner revierta y reintente', async () => {
    sendButtons.mockRejectedValue(new Error('(#131047) Re-engagement message'))

    await expect(sendAgendaReminder(delivery('text'))).rejects.toThrow('131047')
  })
})

describe('sendAgendaReminder — plantilla', () => {
  it('si Meta lo envió pero falla el insert en messages, no lanza', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })
    state.messagesInsertError = { message: 'insert failed' }

    await expect(
      sendAgendaReminder(delivery('template')),
    ).resolves.toBeUndefined()
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })

  it('camino feliz: envía la plantilla y la registra', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })

    await sendAgendaReminder(delivery('template'))

    expect(state.inserted[0]).toMatchObject({
      conversation_id: 'cv-1',
      content_type: 'template',
      template_name: 'recordatorio_cita',
      message_id: 'wamid-tpl',
    })
  })

  it('si Meta rechaza la plantilla, lanza', async () => {
    sendTemplateMessage.mockRejectedValue(new Error('(#132001) Template does not exist'))

    await expect(sendAgendaReminder(delivery('template'))).rejects.toThrow('132001')
  })
})

// ------------------------------------------------------------
// Clínica: paciente y sede en el mensaje, nunca el procedimiento, y botones
// amarrados a la cita. Las cuentas sin clínica envían lo mismo que antes.
// ------------------------------------------------------------

function clinicDelivery(
  channel: 'text' | 'template',
  over: Partial<ReminderDelivery> = {},
): ReminderDelivery {
  return {
    ...delivery(channel),
    serviceName: 'Endodoncia',
    staffName: 'Dra. Ana',
    clinic: { patientName: 'Tomás Gil', locationName: 'Centro' },
    ...over,
  }
}

const CLINIC_PAYLOADS = ['rem:confirm:ap-1', 'rem:reschedule:ap-1', 'rem:cancel:ap-1']

describe('sendAgendaReminder — clínica, plantilla', () => {
  beforeEach(() => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })
  })

  it('usa la plantilla clínica con seis variables y los payloads de la cita', async () => {
    await sendAgendaReminder(clinicDelivery('template'))

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    expect(sendTemplateMessage.mock.calls[0][0]).toStrictEqual({
      phoneNumberId: 'pn-1',
      accessToken: 'token',
      to: '573001112233',
      templateName: 'recordatorio_cita_clinica',
      language: 'es',
      params: [
        'Tomás Gil',
        'Barbería El Parche',
        'Centro',
        'Dra. Ana',
        'martes 20 de octubre de 2026',
        '7:00 a. m.',
      ],
      quickReplyPayloads: CLINIC_PAYLOADS,
    })
  })

  it('con reprogramar apagado los payloads siguen el orden de los tres botones aprobados', async () => {
    await sendAgendaReminder(clinicDelivery('template', { allowReschedule: false }))

    const args = sendTemplateMessage.mock.calls[0][0] as { quickReplyPayloads: string[] }
    // La plantilla de Meta tiene siempre Confirmar / Reprogramar / Cancelar:
    // quitar uno correría "cancelar" al índice del botón de reprogramar.
    expect(args.quickReplyPayloads).toEqual(CLINIC_PAYLOADS)
  })

  it('guarda la plantilla clínica y un texto sin el procedimiento', async () => {
    await sendAgendaReminder(clinicDelivery('template'))

    expect(state.inserted[0]).toMatchObject({
      conversation_id: 'cv-1',
      content_type: 'template',
      template_name: 'recordatorio_cita_clinica',
      message_id: 'wamid-tpl',
    })
    // El controlador solo acepta la etiqueta "Confirmar" si responde a una plantilla suya.
    expect(isReminderTemplateName(state.inserted[0].template_name as string)).toBe(true)
    expect(state.inserted[0].content_text).toContain('Tomás Gil')
    expect(state.inserted[0].content_text).toContain('Centro')
    expect(state.inserted[0].content_text).not.toContain('Endodoncia')
  })

  it('el procedimiento no viaja a Meta ni a la base', async () => {
    await sendAgendaReminder(clinicDelivery('template'))

    expect(JSON.stringify(sendTemplateMessage.mock.calls)).not.toContain('Endodoncia')
    expect(JSON.stringify(state.inserted)).not.toContain('Endodoncia')
  })

  it('si Meta rechaza la plantilla, lanza para que el runner reintente', async () => {
    sendTemplateMessage.mockRejectedValue(new Error('(#132001) Template does not exist'))

    await expect(sendAgendaReminder(clinicDelivery('template'))).rejects.toThrow('132001')
  })
})

describe('sendAgendaReminder — clínica, mensaje libre', () => {
  beforeEach(() => {
    sendButtons.mockResolvedValue(undefined)
  })

  it('nombra al paciente y la sede, y los botones llevan el id de la cita', async () => {
    await sendAgendaReminder(clinicDelivery('text'))

    const args = sendButtons.mock.calls[0][0] as {
      bodyText: string
      buttons: { id: string }[]
    }
    expect(args.bodyText).toContain('Tomás Gil')
    expect(args.bodyText).toContain('sede Centro')
    expect(args.bodyText).not.toContain('Endodoncia')
    expect(args.buttons.map((b) => b.id)).toEqual(CLINIC_PAYLOADS)
  })

  it('con reprogramar apagado solo queda Confirmar, con el id de la cita', async () => {
    await sendAgendaReminder(clinicDelivery('text', { allowReschedule: false }))

    const args = sendButtons.mock.calls[0][0] as { buttons: { id: string }[] }
    expect(args.buttons.map((b) => b.id)).toEqual(['rem:confirm:ap-1'])
  })
})

describe('sendAgendaReminder — sin clínica no cambia nada', () => {
  it('plantilla: recordatorio_cita, las mismas cinco variables y sin botones nuevos', async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-tpl' })

    await sendAgendaReminder(delivery('template'))

    // toStrictEqual: ni siquiera una clave quickReplyPayloads con undefined.
    expect(sendTemplateMessage.mock.calls[0][0]).toStrictEqual({
      phoneNumberId: 'pn-1',
      accessToken: 'token',
      to: '573001112233',
      templateName: 'recordatorio_cita',
      language: 'es',
      params: [
        'Barbería El Parche',
        'Corte clásico',
        'Andrés',
        'martes 20 de octubre de 2026',
        '7:00 a. m.',
      ],
    })
    expect(state.inserted[0]).toMatchObject({ template_name: 'recordatorio_cita' })
    expect(state.inserted[0].content_text).toContain('Corte clásico')
  })

  it('mensaje libre: los botones de siempre, sin id de cita, y el servicio en el texto', async () => {
    sendButtons.mockResolvedValue(undefined)

    await sendAgendaReminder(delivery('text'))

    const args = sendButtons.mock.calls[0][0] as {
      bodyText: string
      buttons: { id: string }[]
    }
    expect(args.buttons.map((b) => b.id)).toEqual(['rem:confirm', 'rem:reschedule', 'rem:cancel'])
    expect(args.bodyText).toContain('Corte clásico')
  })
})
