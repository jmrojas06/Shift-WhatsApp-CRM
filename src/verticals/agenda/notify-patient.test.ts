import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessagePersistAfterSendError } from '@/lib/flows/meta-send'
import { TEST_ACCOUNT } from '@/app/api/verticals/agenda/_lib/route-testing'

import { asClient, type FakeDb } from './agent/testing/fake-db'
import {
  APPOINTMENT,
  CONTACT,
  CONVERSATION,
  LOCATION,
  NOW,
  PATIENT,
  activeAppointment,
  seedPanelDb,
} from './agent/testing/panel-fixtures'
import {
  notifyPatient,
  sendBookingLink,
  type NotifyPatientDeps,
  type NotifyPatientKind,
} from './notify-patient'

// ============================================================
// Aviso al paciente desde el panel (T5) y enlace para agendar tras una
// llamada. La base es el fake de las rutas del panel; el envío de WhatsApp
// (mensaje libre y plantilla) es un grabador: nada toca la red.
// ============================================================

const HOURS = 60 * 60 * 1000

function fakeSend() {
  const sender = {
    sendText: vi.fn<(args: { text: string }) => Promise<void>>().mockResolvedValue(undefined),
    sendButtons: vi
      .fn<(args: { bodyText: string; buttons: { id: string; title: string }[] }) => Promise<void>>()
      .mockResolvedValue(undefined),
    sendList: vi.fn().mockResolvedValue(undefined),
  }
  const createSender = vi.fn<(ctx: unknown) => typeof sender>().mockReturnValue(sender)
  const loadCredentials = vi
    .fn<() => Promise<{ phoneNumberId: string; accessToken: string }>>()
    .mockResolvedValue({ phoneNumberId: 'pn-1', accessToken: 'tok' })
  const sendTemplate = vi
    .fn<(args: Record<string, unknown>) => Promise<{ messageId: string }>>()
    .mockResolvedValue({ messageId: 'wamid-tpl-1' })
  const deps = { createSender, loadCredentials, sendTemplate } as unknown as NotifyPatientDeps
  return { sender, createSender, loadCredentials, sendTemplate, deps }
}

type Send = ReturnType<typeof fakeSend>

interface World {
  db: FakeDb
  send: Send
}

/** Cuenta de agenda (o clínica) con una cita el lunes 9 a las 10:00 en Bogotá. */
function world(options: { clinic?: boolean; appointment?: Record<string, unknown> } = {}): World {
  const clinic = options.clinic === true
  const db = seedPanelDb({ modules: clinic ? ['agenda', 'clinica'] : ['agenda'] })
  Object.assign(db._tables.accounts[0], { name: 'Sonrisa Sur', owner_user_id: 'u-owner' })
  db._tables.booking_appointments.push(
    activeAppointment({
      ...(clinic ? { patient_id: PATIENT, location_id: LOCATION } : {}),
      ...options.appointment,
    }),
  )
  if (clinic) {
    db._tables.clinic_patients.push({
      id: PATIENT,
      account_id: TEST_ACCOUNT,
      contact_id: CONTACT,
      full_name: 'Marta Ruiz',
    })
  }
  db._tables.messages = []
  return { db, send: fakeSend() }
}

/** El paciente escribió hace `hoursAgo` horas. */
function customerWrote(db: FakeDb, hoursAgo: number, conversationId = CONVERSATION) {
  db._tables.messages.push({
    id: `m-${db._tables.messages.length}`,
    conversation_id: conversationId,
    sender_type: 'customer',
    created_at: new Date(NOW.getTime() - hoursAgo * HOURS).toISOString(),
  })
}

const call = (
  w: World,
  kind: NotifyPatientKind,
  overrides: { appointmentId?: string; accountId?: string } = {},
) =>
  notifyPatient(
    {
      db: asClient(w.db),
      accountId: overrides.accountId ?? TEST_ACCOUNT,
      appointmentId: overrides.appointmentId ?? APPOINTMENT,
      kind,
      now: NOW,
    },
    w.send.deps,
  )

const templateArgs = (w: World) => w.send.sendTemplate.mock.calls[0][0] as {
  templateName: string
  language: string
  params: string[]
  quickReplyPayloads?: string[]
  to: string
}

const savedMessage = (w: World) =>
  w.db._tables.messages.find((m) => m.sender_type === 'bot') as Record<string, unknown>

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('ventana de 24 h abierta: mensaje libre', () => {
  it('agendada: texto con negocio, servicio, profesional, fecha y hora', async () => {
    const w = world()
    customerWrote(w.db, 2)

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: true, channel: 'text' })
    expect(w.send.sendTemplate).not.toHaveBeenCalled()
    expect(w.send.sender.sendButtons).not.toHaveBeenCalled()
    const text = w.send.sender.sendText.mock.calls[0][0].text
    for (const part of ['Sonrisa Sur', 'Limpieza', 'Dra. Rojas', 'lunes 9 de noviembre de 2026', '10:00 a. m.']) {
      expect(text).toContain(part)
    }
    expect(w.send.createSender).toHaveBeenCalledWith({
      accountId: TEST_ACCOUNT,
      conversationId: CONVERSATION,
      contactId: CONTACT,
      configOwnerUserId: 'u-owner',
    })
  })

  it('movida: avisa que cambió la hora y trae la nueva', async () => {
    const w = world()
    customerWrote(w.db, 2)

    const result = await call(w, 'moved')

    expect(result).toEqual({ sent: true, channel: 'text' })
    const text = w.send.sender.sendText.mock.calls[0][0].text
    expect(text).toMatch(/cambiamos/i)
    expect(text).toContain('lunes 9 de noviembre de 2026')
    expect(text).toContain('10:00 a. m.')
  })

  it('cancelada: texto con el botón "Agendar otra" (book:again)', async () => {
    const w = world()
    customerWrote(w.db, 2)

    const result = await call(w, 'cancelled')

    expect(result).toEqual({ sent: true, channel: 'text' })
    expect(w.send.sender.sendText).not.toHaveBeenCalled()
    const args = w.send.sender.sendButtons.mock.calls[0][0]
    expect(args.bodyText).toContain('Sonrisa Sur')
    expect(args.bodyText).toContain('10:00 a. m.')
    expect(args.buttons).toEqual([{ id: 'book:again', title: 'Agendar otra' }])
  })

  it('usa las palabras del negocio ("turno" en lugar de "cita")', async () => {
    const w = world()
    Object.assign(w.db._tables.booking_settings[0], { labels: { cita: 'turno', citas: 'turnos' } })
    customerWrote(w.db, 2)

    await call(w, 'booked')

    expect(w.send.sender.sendText.mock.calls[0][0].text).toContain('turno')
  })

  it('un mensaje del paciente de hace más de 24 h no abre la ventana', async () => {
    const w = world()
    customerWrote(w.db, 25)

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: true, channel: 'template' })
    expect(w.send.sender.sendText).not.toHaveBeenCalled()
  })

  it('lo que escribió el equipo no abre la ventana', async () => {
    const w = world()
    w.db._tables.messages.push({
      conversation_id: CONVERSATION,
      sender_type: 'agent',
      created_at: new Date(NOW.getTime() - HOURS).toISOString(),
    })

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: true, channel: 'template' })
  })

  it('si Meta ya lo aceptó y solo falló guardarlo, cuenta como enviado', async () => {
    const w = world()
    customerWrote(w.db, 2)
    w.send.sender.sendText.mockRejectedValue(
      new MessagePersistAfterSendError('No se pudo guardar', 'wamid-ok'),
    )

    expect(await call(w, 'booked')).toEqual({ sent: true, channel: 'text' })
  })

  it('un envío rechazado devuelve "no se envió" con el motivo y no lanza', async () => {
    const w = world()
    customerWrote(w.db, 2)
    w.send.sender.sendText.mockRejectedValue(new Error('(#131026) Message undeliverable'))

    const result = await call(w, 'booked')

    expect(result.sent).toBe(false)
    expect((result as { error: string }).error).toMatch(/whatsapp/i)
  })
})

describe('ventana cerrada: plantilla', () => {
  it('agendada: cita_agendada con las cinco variables en orden y sin botón', async () => {
    const w = world()

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: true, channel: 'template' })
    const args = templateArgs(w)
    expect(args.templateName).toBe('cita_agendada')
    expect(args.language).toBe('es')
    expect(args.params).toEqual([
      'Sonrisa Sur',
      'Limpieza',
      'Dra. Rojas',
      'lunes 9 de noviembre de 2026',
      '10:00 a. m.',
    ])
    expect(args).not.toHaveProperty('quickReplyPayloads')
    expect(args.to).toBe('573001112233')
  })

  it('movida: usa cita_agendada con la nueva hora', async () => {
    const w = world({ appointment: { starts_at: '2026-11-10T20:30:00.000Z' } })

    await call(w, 'moved')

    const args = templateArgs(w)
    expect(args.templateName).toBe('cita_agendada')
    expect(args.params.slice(3)).toEqual(['martes 10 de noviembre de 2026', '3:30 p. m.'])
  })

  it('cancelada: cita_cancelada (negocio, fecha, hora) con el payload book:again', async () => {
    const w = world()

    await call(w, 'cancelled')

    const args = templateArgs(w)
    expect(args.templateName).toBe('cita_cancelada')
    expect(args.params).toEqual(['Sonrisa Sur', 'lunes 9 de noviembre de 2026', '10:00 a. m.'])
    expect(args.quickReplyPayloads).toEqual(['book:again'])
  })

  it('guarda el equivalente legible en messages y actualiza la conversación', async () => {
    const w = world()
    w.db._tables.conversations[0].last_message_text = null

    await call(w, 'booked')

    const saved = savedMessage(w)
    expect(saved).toMatchObject({
      conversation_id: CONVERSATION,
      sender_type: 'bot',
      content_type: 'template',
      template_name: 'cita_agendada',
      message_id: 'wamid-tpl-1',
      status: 'sent',
    })
    expect(saved.content_text).toContain('Limpieza')
    expect(saved.content_text).toContain('10:00 a. m.')
    expect(w.db._tables.conversations[0].last_message_text).toBe(saved.content_text)
    expect(w.db._tables.conversations[0].last_message_at).toBe(NOW.toISOString())
  })

  it('un servicio o profesional que ya no existe usa las palabras de respaldo', async () => {
    const w = world({ appointment: { service_id: null, staff_id: null } })

    await call(w, 'booked')

    expect(templateArgs(w).params.slice(1, 3)).toEqual(['tu servicio', 'Cualquiera'])
  })

  it('las variables van en una sola línea (Meta rechaza saltos de línea)', async () => {
    const w = world()
    Object.assign(w.db._tables.accounts[0], { name: '  Sonrisa\nSur  ' })

    await call(w, 'booked')

    expect(templateArgs(w).params[0]).toBe('Sonrisa Sur')
  })

  it('reintenta con las variantes del teléfono y guarda la que funcionó', async () => {
    const w = world()
    w.send.sendTemplate
      .mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid-2' })

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: true, channel: 'template' })
    expect(w.send.sendTemplate).toHaveBeenCalledTimes(2)
    const [first, second] = w.send.sendTemplate.mock.calls.map((c) => c[0].to)
    expect(second).not.toBe(first)
    expect(w.db._tables.contacts[0].phone).toBe(second)
    expect(savedMessage(w).message_id).toBe('wamid-2')
  })

  it('si Meta lo envió pero falla guardar el mensaje, sigue contando como enviado', async () => {
    const w = world()
    w.db._failNext('insert', 'messages', { message: 'insert failed' })

    expect(await call(w, 'booked')).toEqual({ sent: true, channel: 'template' })
  })

  it('plantilla inexistente: el error nombra la plantilla y no lanza', async () => {
    const w = world()
    w.send.sendTemplate.mockRejectedValue(
      new Error('(#132001) Template name does not exist in the translation'),
    )

    const result = await call(w, 'cancelled')

    expect(result.sent).toBe(false)
    expect((result as { error: string }).error).toContain('cita_cancelada')
  })

  it.each([
    ['(#132000) Number of parameters does not match the expected number', /no coinciden con la plantilla "cita_agendada"/],
    ['(#131030) Recipient phone number not in allowed list', /lista de números de prueba/],
    ['(#131026) Message undeliverable', /no parece tener WhatsApp/],
    ['(#131047) Re-engagement message', /24 horas/],
    ['(#190) Access token has expired', /código 190/],
  ])('el error de Meta %s se explica sin repetir el mensaje', async (raw, expected) => {
    const w = world()
    w.send.sendTemplate.mockRejectedValue(new Error(raw))

    const result = (await call(w, 'booked')) as { sent: false; error: string }

    expect(result.sent).toBe(false)
    expect(result.error).toMatch(expected)
    expect(result.error).not.toContain(raw)
  })

  it('un error sin código conocido da la frase general, sin el mensaje crudo', async () => {
    const w = world()
    w.send.sendTemplate.mockRejectedValue(new Error('socket hang up con Ana'))

    expect(await call(w, 'booked')).toEqual({
      sent: false,
      error: 'No se pudo enviar el aviso por WhatsApp.',
    })
  })

  it('el error no filtra teléfonos ni nombres', async () => {
    const w = world()
    w.send.sendTemplate.mockRejectedValue(
      new Error('Fallo raro con 573001112233 de Ana Pérez, número +57 300 111 2233'),
    )

    const result = (await call(w, 'booked')) as { sent: false; error: string }

    expect(result.sent).toBe(false)
    expect(result.error).not.toMatch(/\d{5,}/)
    expect(result.error).not.toContain('Ana')
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('573001112233')
  })
})

describe('clínica', () => {
  it('agendada por plantilla: paciente, negocio, sede, doctor, fecha y hora; nunca el procedimiento', async () => {
    const w = world({ clinic: true })

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: true, channel: 'template' })
    const args = templateArgs(w)
    expect(args.templateName).toBe('cita_agendada_clinica')
    expect(args.params).toEqual([
      'Marta Ruiz',
      'Sonrisa Sur',
      'Sede Centro',
      'Dra. Rojas',
      'lunes 9 de noviembre de 2026',
      '10:00 a. m.',
    ])
    expect(args).not.toHaveProperty('quickReplyPayloads')
    expect(JSON.stringify([args, savedMessage(w)])).not.toContain('Limpieza')
  })

  it('movida por plantilla: cita_agendada_clinica con la nueva hora', async () => {
    const w = world({ clinic: true, appointment: { starts_at: '2026-11-10T20:30:00.000Z' } })

    await call(w, 'moved')

    const args = templateArgs(w)
    expect(args.templateName).toBe('cita_agendada_clinica')
    expect(args.params.slice(4)).toEqual(['martes 10 de noviembre de 2026', '3:30 p. m.'])
  })

  it('cancelada por plantilla: cita_cancelada_clinica con el payload book:again', async () => {
    const w = world({ clinic: true })

    await call(w, 'cancelled')

    const args = templateArgs(w)
    expect(args.templateName).toBe('cita_cancelada_clinica')
    expect(args.params).toEqual([
      'Marta Ruiz',
      'Sonrisa Sur',
      'lunes 9 de noviembre de 2026',
      '10:00 a. m.',
    ])
    expect(args.quickReplyPayloads).toEqual(['book:again'])
    expect(JSON.stringify([args, savedMessage(w)])).not.toContain('Limpieza')
  })

  it('con la ventana abierta el texto nombra al paciente y la sede, y nunca el procedimiento', async () => {
    const w = world({ clinic: true })
    customerWrote(w.db, 1)

    for (const kind of ['booked', 'moved', 'cancelled'] as const) {
      w.send.sender.sendText.mockClear()
      w.send.sender.sendButtons.mockClear()
      expect(await call(w, kind)).toEqual({ sent: true, channel: 'text' })
      const body =
        kind === 'cancelled'
          ? w.send.sender.sendButtons.mock.calls[0][0].bodyText
          : w.send.sender.sendText.mock.calls[0][0].text
      expect(body).toContain('Marta Ruiz')
      expect(body).not.toContain('Limpieza')
      if (kind !== 'cancelled') expect(body).toContain('Sede Centro')
    }
    expect(w.send.sender.sendButtons.mock.calls[0][0].buttons).toEqual([
      { id: 'book:again', title: 'Agendar otra' },
    ])
  })

  it('ni siquiera lee el servicio de la cita', async () => {
    const w = world({ clinic: true })
    const read: string[] = []
    const from = w.db.from.bind(w.db)
    w.db.from = (table: string) => {
      read.push(table)
      return from(table)
    }

    expect(await call(w, 'booked')).toEqual({ sent: true, channel: 'template' })
    expect(read).not.toContain('booking_services')
  })

  it('una cita sin paciente ni sede usa el nombre del contacto y la sede de respaldo', async () => {
    const w = world({ clinic: true, appointment: { patient_id: null, location_id: null } })

    await call(w, 'booked')

    const params = templateArgs(w).params
    expect(params[0]).toBe('Ana Pérez')
    expect(params[2]).toBe('Principal')
  })

  it('si no se puede leer el paciente, no se envía nada y el error no lleva datos', async () => {
    const w = world({ clinic: true })
    w.db._failNext('select', 'clinic_patients', { message: 'boom' })

    const result = await call(w, 'booked')

    expect(result.sent).toBe(false)
    expect(w.send.sendTemplate).not.toHaveBeenCalled()
    expect(w.send.sender.sendText).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('Marta')
  })
})

describe('casos que no se pueden enviar', () => {
  it('una cita que no existe', async () => {
    const w = world()

    const result = await call(w, 'booked', { appointmentId: '00000000-0000-4000-8000-000000000000' })

    expect(result).toEqual({ sent: false, error: expect.stringMatching(/cita/i) })
    expect(w.send.sendTemplate).not.toHaveBeenCalled()
  })

  it('una cita de otra cuenta no se avisa', async () => {
    const w = world({ appointment: { account_id: 'acc-2' } })

    const result = await call(w, 'booked')

    expect(result.sent).toBe(false)
    expect(w.send.sendTemplate).not.toHaveBeenCalled()
  })

  it('un contacto sin número de WhatsApp: no intenta enviar y no menciona el número', async () => {
    const w = world()
    Object.assign(w.db._tables.contacts[0], { phone: null, wa_user_id: null })
    customerWrote(w.db, 1)

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: false, error: expect.stringMatching(/número de WhatsApp/i) })
    expect(w.send.sender.sendText).not.toHaveBeenCalled()
    expect(w.send.sendTemplate).not.toHaveBeenCalled()
  })

  it('sin conversación en la cita usa la más reciente del contacto', async () => {
    const w = world({ appointment: { conversation_id: null } })
    customerWrote(w.db, 1)

    expect(await call(w, 'booked')).toEqual({ sent: true, channel: 'text' })
    expect(w.send.createSender.mock.calls[0][0]).toMatchObject({ conversationId: CONVERSATION })
  })

  it('sin ninguna conversación del contacto', async () => {
    const w = world({ appointment: { conversation_id: null } })
    w.db._tables.conversations.length = 0

    const result = await call(w, 'booked')

    expect(result).toEqual({ sent: false, error: expect.stringMatching(/conversación/i) })
  })

  it('WhatsApp sin configurar en la cuenta', async () => {
    const w = world()
    w.send.loadCredentials.mockRejectedValue(new Error('WhatsApp no está configurado'))

    const result = await call(w, 'booked')

    expect(result.sent).toBe(false)
  })

  it('nunca lanza, ni siquiera si la base falla', async () => {
    const w = world()
    w.db._failNext('select', 'booking_appointments', { message: 'connection lost to host 10.0.0.1' })

    const result = await call(w, 'booked')

    expect(result.sent).toBe(false)
    expect(JSON.stringify(result)).not.toContain('10.0.0.1')
  })
})

describe('sendBookingLink', () => {
  const link = (w: World) =>
    sendBookingLink(
      {
        db: asClient(w.db),
        accountId: TEST_ACCOUNT,
        contactId: CONTACT,
        conversationId: CONVERSATION,
        now: NOW,
      },
      w.send.deps,
    )

  it('con la ventana abierta manda un texto con el botón "Agendar" (book:again)', async () => {
    const w = world()
    customerWrote(w.db, 1)

    const result = await link(w)

    expect(result).toEqual({ sent: true, channel: 'text' })
    const args = w.send.sender.sendButtons.mock.calls[0][0]
    expect(args.bodyText).toContain('Sonrisa Sur')
    expect(args.buttons).toEqual([{ id: 'book:again', title: 'Agendar' }])
  })

  it('con la ventana cerrada manda agendar_por_llamada con el nombre del negocio', async () => {
    const w = world()

    const result = await link(w)

    expect(result).toEqual({ sent: true, channel: 'template' })
    const args = templateArgs(w)
    expect(args.templateName).toBe('agendar_por_llamada')
    expect(args.params).toEqual(['Sonrisa Sur'])
    expect(args.quickReplyPayloads).toEqual(['book:again'])
    expect(savedMessage(w)).toMatchObject({
      content_type: 'template',
      template_name: 'agendar_por_llamada',
    })
    expect(String(savedMessage(w).content_text)).toContain('Sonrisa Sur')
  })

  it('si el envío falla devuelve "no se envió" y no lanza', async () => {
    const w = world()
    w.send.sendTemplate.mockRejectedValue(new Error('(#132001) Template name does not exist'))

    const result = await link(w)

    expect(result.sent).toBe(false)
    expect((result as { error: string }).error).toContain('agendar_por_llamada')
  })

  it('un contacto de otra cuenta no recibe nada', async () => {
    const w = world()

    const result = await sendBookingLink(
      {
        db: asClient(w.db),
        accountId: TEST_ACCOUNT,
        contactId: '99999999-9999-4999-8999-999999999999',
        conversationId: CONVERSATION,
        now: NOW,
      },
      w.send.deps,
    )

    expect(result.sent).toBe(false)
    expect(w.send.sendTemplate).not.toHaveBeenCalled()
  })
})
