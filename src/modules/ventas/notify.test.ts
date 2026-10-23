import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessagePersistAfterSendError } from '@/lib/flows/meta-send'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { phoneVariants } from '@/lib/whatsapp/phone-utils'
import { asClient, makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { NOTICE_ERRORS, sendOrderNotice, type NoticeDeps } from './notify'
import type { OrderRow } from './repo'

// ============================================================
// Avisos al cliente contra el fake de PostgREST y senders falsos:
// ningún test toca la red, Meta ni una base real.
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const OWNER = 'user-owner'
const CONTACT = 'ct-1'
const CONVERSATION = 'cv-1'
const ORDER_ID = 'ord-1'
const PHONE = '573001234567'
const NOW = new Date('2026-10-22T15:00:00.000Z')
const HOURS = 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_ID,
    account_id: ACCOUNT,
    number: 1001,
    contact_id: CONTACT,
    customer_name: 'Laura',
    customer_phone: PHONE,
    conversation_id: CONVERSATION,
    deal_id: null,
    subtotal: 100000,
    shipping: 10000,
    total: 110000,
    currency: 'COP',
    payment_status: 'paid',
    status: 'new',
    city: null,
    address: null,
    id_number: null,
    carrier: null,
    tracking_number: null,
    notes: null,
    last_notice: null,
    last_notice_error: null,
    created_by: OWNER,
    paid_at: null,
    shipped_at: null,
    delivered_at: null,
    cancelled_at: null,
    created_at: ago(2 * HOURS),
    updated_at: ago(2 * HOURS),
    ...overrides,
  }
}

function seed(extra: Record<string, Row[]> = {}, row: OrderRow = order()): FakeDb {
  return makeFakeDb({
    accounts: [{ id: ACCOUNT, name: 'Águila Dorada', owner_user_id: OWNER }],
    whatsapp_config: [{ account_id: ACCOUNT, phone_number_id: 'pn-1' }],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, phone: PHONE, wa_user_id: null }],
    conversations: [{ id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT, last_message_at: ago(HOURS) }],
    messages: [],
    orders: [{ ...row } as unknown as Row],
    ...extra,
  })
}

/** El cliente escribió hace `ms` en la conversación. */
const customerMessage = (ms: number, conversation = CONVERSATION): Row => ({
  id: `m-${ms}`,
  conversation_id: conversation,
  sender_type: 'customer',
  created_at: ago(ms),
})

function fakes() {
  const sendText = vi.fn(async () => ({ whatsapp_message_id: 'wamid-text' }))
  const sendTemplate = vi.fn(async () => ({ messageId: 'wamid-tpl' }))
  const loadCredentials = vi.fn(async () => ({ phoneNumberId: 'pn-1', accessToken: 'token-falso' }))
  const deps: NoticeDeps = {
    now: () => NOW,
    sendText: sendText as unknown as NoticeDeps['sendText'],
    sendTemplate: sendTemplate as unknown as NoticeDeps['sendTemplate'],
    loadCredentials: loadCredentials as unknown as NoticeDeps['loadCredentials'],
  }
  return { sendText, sendTemplate, loadCredentials, deps }
}

const storedOrder = (db: FakeDb, id = ORDER_ID) =>
  db._tables.orders.find((o) => o.id === id && o.account_id === ACCOUNT)!

const metaError = (code: number, message = `(#${code}) fallo`) =>
  new MetaApiError(message, { code, httpStatus: 400 })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('sendOrderNotice — ventana de 24 h abierta (texto libre)', () => {
  it('manda el texto exacto por el sender del bot y registra last_notice sin error', async () => {
    const db = seed({ messages: [customerMessage(2 * HOURS)] })
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendTemplate).not.toHaveBeenCalled()
    expect(f.sendText).toHaveBeenCalledTimes(1)
    expect(f.sendText).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      userId: OWNER,
      conversationId: CONVERSATION,
      contactId: CONTACT,
      text: '¡Recibimos tu pago! Tu pedido #1001 está confirmado. Te avisamos cuando salga. 🙌',
    })
    expect(storedOrder(db)).toMatchObject({ last_notice: 'paid', last_notice_error: null })
  })

  it('el aviso de envío lleva transportadora y guía del pedido', async () => {
    const db = seed({ messages: [customerMessage(HOURS)] })
    const f = fakes()

    await sendOrderNotice(
      asClient(db),
      order({ carrier: 'Servientrega', tracking_number: 'GU123' }),
      'shipped',
      f.deps,
    )

    expect(f.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Tu pedido #1001 salió 📦. Transportadora: Servientrega. Guía: GU123.',
      }),
    )
    expect(storedOrder(db).last_notice).toBe('shipped')
  })

  it('borra el error de un intento anterior al enviar bien', async () => {
    const db = seed(
      { messages: [customerMessage(HOURS)] },
      order({ last_notice: 'paid', last_notice_error: 'Plantilla no aprobada en Meta' }),
    )
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(storedOrder(db).last_notice_error).toBeNull()
  })

  it('un mensaje justo dentro de la ventana (23 h 59 min) todavía cuenta', async () => {
    const db = seed({ messages: [customerMessage(24 * HOURS - 60_000)] })
    const f = fakes()
    await sendOrderNotice(asClient(db), order(), 'delivered', f.deps)
    expect(f.sendText).toHaveBeenCalledTimes(1)
    expect(f.sendTemplate).not.toHaveBeenCalled()
  })

  it('si Meta lo aceptó y solo falló guardarlo en messages, cuenta como enviado', async () => {
    const db = seed({ messages: [customerMessage(HOURS)] })
    const f = fakes()
    f.sendText.mockRejectedValueOnce(new MessagePersistAfterSendError('no se guardó', 'wamid-ok'))

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(storedOrder(db)).toMatchObject({ last_notice: 'paid', last_notice_error: null })
  })

  it('si el envío falla devuelve failed y deja el motivo en el pedido', async () => {
    const db = seed({ messages: [customerMessage(HOURS)] })
    const f = fakes()
    f.sendText.mockRejectedValueOnce(metaError(190))

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('failed')
    expect(storedOrder(db)).toMatchObject({
      last_notice: 'paid',
      last_notice_error: 'Error de WhatsApp: 190',
    })
  })

  it('Meta responde 131047 al texto: el mismo aviso sale por plantilla y se registra ese resultado', async () => {
    const db = seed(
      { messages: [customerMessage(23 * HOURS)] },
      order({ last_notice: 'paid', last_notice_error: 'viejo' }),
    )
    const f = fakes()
    f.sendText.mockRejectedValueOnce(metaError(131047))

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendText).toHaveBeenCalledTimes(1)
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
    expect(f.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'pedido_pagado', params: ['Águila Dorada', '1001'] }),
    )
    expect(db._tables.messages.at(-1)).toMatchObject({ content_type: 'template', template_name: 'pedido_pagado' })
    expect(storedOrder(db)).toMatchObject({ last_notice: 'paid', last_notice_error: null })
  })

  it('131047 en el texto y la plantilla también falla: failed con el motivo de la plantilla', async () => {
    const db = seed({ messages: [customerMessage(23 * HOURS)] })
    const f = fakes()
    f.sendText.mockRejectedValueOnce(metaError(131047))
    f.sendTemplate.mockRejectedValue(metaError(132001))

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('failed')
    expect(storedOrder(db).last_notice_error).toBe('Plantilla no aprobada en Meta')
  })

  it('otro error del texto NO cae a la plantilla', async () => {
    const db = seed({ messages: [customerMessage(HOURS)] })
    const f = fakes()
    f.sendText.mockRejectedValueOnce(metaError(131026))

    expect(await sendOrderNotice(asClient(db), order(), 'paid', f.deps)).toBe('failed')
    expect(f.sendTemplate).not.toHaveBeenCalled()
    expect(storedOrder(db).last_notice_error).toBe(NOTICE_ERRORS.undeliverable)
  })

  it('el mensaje de OTRA conversación no abre la ventana', async () => {
    const db = seed({ messages: [customerMessage(HOURS, 'cv-otra')] })
    const f = fakes()
    await sendOrderNotice(asClient(db), order(), 'paid', f.deps)
    expect(f.sendText).not.toHaveBeenCalled()
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
  })

  it('un mensaje del bot o del agente no abre la ventana', async () => {
    const db = seed({
      messages: [{ id: 'm-bot', conversation_id: CONVERSATION, sender_type: 'bot', created_at: ago(HOURS) }],
    })
    const f = fakes()
    await sendOrderNotice(asClient(db), order(), 'paid', f.deps)
    expect(f.sendText).not.toHaveBeenCalled()
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
  })
})

describe('sendOrderNotice — ventana cerrada (plantilla de Meta)', () => {
  const closed = () => seed({ messages: [customerMessage(30 * HOURS)] })

  it('pagado: pedido_pagado en español con negocio y número', async () => {
    const db = closed()
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendText).not.toHaveBeenCalled()
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
    expect(f.sendTemplate).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'token-falso',
      to: PHONE,
      templateName: 'pedido_pagado',
      language: 'es',
      params: ['Águila Dorada', '1001'],
    })
    expect(f.loadCredentials).toHaveBeenCalledWith(expect.anything(), ACCOUNT)
    expect(storedOrder(db)).toMatchObject({ last_notice: 'paid', last_notice_error: null })
  })

  it('enviado: pedido_enviado con número, transportadora y guía', async () => {
    const db = closed()
    const f = fakes()

    await sendOrderNotice(
      asClient(db),
      order({ number: 1002, carrier: 'Coordinadora', tracking_number: 'ABC-99' }),
      'shipped',
      f.deps,
    )

    expect(f.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'pedido_enviado',
        language: 'es',
        params: ['1002', 'Coordinadora', 'ABC-99'],
      }),
    )
  })

  it('el texto guardado de cada plantilla es el cuerpo documentado con sus variables', async () => {
    const cases: [Parameters<typeof sendOrderNotice>[2], Partial<OrderRow>, string][] = [
      ['paid', {}, '¡Hola! Águila Dorada recibió tu pago. Tu pedido #1001 está confirmado y te avisamos cuando salga. 🙌'],
      [
        'shipped',
        { carrier: 'Coordinadora', tracking_number: 'ABC-99' },
        'Tu pedido #1001 salió 📦. Transportadora: Coordinadora. Guía: ABC-99.',
      ],
      ['delivered', {}, 'Tu pedido #1001 fue entregado. ¡Gracias por comprarnos! 🙌'],
    ]
    for (const [kind, over, body] of cases) {
      const db = closed()
      const f = fakes()
      await sendOrderNotice(asClient(db), order(over), kind, f.deps)
      expect(db._tables.messages.at(-1)).toMatchObject({ content_type: 'template', content_text: body })
      expect(String(db._tables.messages.at(-1)?.content_text)).not.toContain('{{')
    }
  })

  it('enviado sin guía: manda "-" (Meta rechaza variables vacías)', async () => {
    const db = closed()
    const f = fakes()
    await sendOrderNotice(asClient(db), order({ carrier: 'Envía', tracking_number: null }), 'shipped', f.deps)
    expect(f.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ params: ['1001', 'Envía', '-'] }))
  })

  it('entregado: pedido_entregado con el número', async () => {
    const db = closed()
    const f = fakes()
    await sendOrderNotice(asClient(db), order(), 'delivered', f.deps)
    expect(f.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'pedido_entregado', params: ['1001'] }),
    )
  })

  it('sin ningún mensaje del cliente también va por plantilla', async () => {
    const db = seed()
    const f = fakes()
    await sendOrderNotice(asClient(db), order(), 'paid', f.deps)
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
  })

  it('guarda el saliente como plantilla y actualiza la conversación (como la agenda)', async () => {
    const db = closed()
    const f = fakes()

    await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(db._tables.messages.at(-1)).toMatchObject({
      conversation_id: CONVERSATION,
      sender_type: 'bot',
      content_type: 'template',
      // Lo que el cliente recibió: el cuerpo de la plantilla con sus variables.
      content_text: '¡Hola! Águila Dorada recibió tu pago. Tu pedido #1001 está confirmado y te avisamos cuando salga. 🙌',
      template_name: 'pedido_pagado',
      message_id: 'wamid-tpl',
      status: 'sent',
    })
    expect(db._tables.conversations[0]).toMatchObject({
      last_message_text: '¡Hola! Águila Dorada recibió tu pago. Tu pedido #1001 está confirmado y te avisamos cuando salga. 🙌',
      last_message_at: NOW.toISOString(),
    })
  })

  it('si Meta ya lo aceptó y falla guardar el saliente, sigue siendo sent', async () => {
    const db = closed()
    db._failNext('insert', 'messages', { message: 'disco lleno' })
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
    expect(storedOrder(db)).toMatchObject({ last_notice: 'paid', last_notice_error: null })
  })

  it('reintenta con la variante de teléfono cuando Meta dice "not in allowed list"', async () => {
    const db = closed()
    const f = fakes()
    const variants = phoneVariants(PHONE)
    expect(variants.length).toBeGreaterThan(1)
    f.sendTemplate.mockRejectedValueOnce(
      metaError(131030, '(#131030) Recipient phone number not in allowed list'),
    )

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendTemplate.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to)).toEqual([
      variants[0],
      variants[1],
    ])
    expect(db._tables.contacts[0].phone).toBe(variants[1])
  })

  it('un contacto con solo wa_user_id (BSUID) recibe la plantilla sin variantes', async () => {
    const db = closed()
    db._tables.contacts[0] = { id: CONTACT, account_id: ACCOUNT, phone: '', wa_user_id: 'CO.13491208655302741918' }
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
    expect(f.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'CO.13491208655302741918' }))
  })
})

describe('sendOrderNotice — errores de Meta', () => {
  const closed = () => seed({ messages: [customerMessage(30 * HOURS)] })

  const cases: [string, unknown, string][] = [
    ['132001 (plantilla inexistente)', metaError(132001), 'Plantilla no aprobada en Meta'],
    ['132015 (plantilla pausada)', metaError(132015), 'Plantilla no aprobada en Meta'],
    ['132016 (plantilla deshabilitada)', metaError(132016), 'Plantilla no aprobada en Meta'],
    ['132000 (variables distintas)', metaError(132000), NOTICE_ERRORS.templateParams],
    ['132005 (texto demasiado largo)', metaError(132005), NOTICE_ERRORS.templateParams],
    ['132007 (contenido contra la política)', metaError(132007), NOTICE_ERRORS.templateParams],
    ['132012 (formato de variable)', metaError(132012), NOTICE_ERRORS.templateParams],
    ['131047 (fuera de las 24 h) en la plantilla', metaError(131047), NOTICE_ERRORS.windowClosed],
    ['131026 (no entregable)', metaError(131026), NOTICE_ERRORS.undeliverable],
    ['131030 en todas las variantes', metaError(131030, '(#131030) not in allowed list'), NOTICE_ERRORS.notAllowed],
    ['otro código de Meta', metaError(100), 'Error de WhatsApp: 100'],
    ['un fallo de red sin código', new Error('fetch failed'), NOTICE_ERRORS.generic],
  ]

  for (const [label, error, reason] of cases) {
    it(`${label} → failed con motivo en el pedido`, async () => {
      const db = closed()
      const f = fakes()
      f.sendTemplate.mockRejectedValue(error)

      const outcome = await sendOrderNotice(asClient(db), order(), 'shipped', f.deps)

      expect(outcome).toBe('failed')
      expect(storedOrder(db)).toMatchObject({ last_notice: 'shipped', last_notice_error: reason })
      expect(db._tables.messages).toHaveLength(1) // solo el del cliente: nada se guardó como saliente
    })
  }

  it('el motivo de "plantilla no aprobada" es exactamente el texto de la pantalla', async () => {
    const db = closed()
    const f = fakes()
    f.sendTemplate.mockRejectedValue(metaError(132001))
    await sendOrderNotice(asClient(db), order(), 'paid', f.deps)
    expect(storedOrder(db).last_notice_error).toBe('Plantilla no aprobada en Meta')
  })
})

describe('sendOrderNotice — sin a quién avisar', () => {
  it('pedido sin conversación y contacto sin conversaciones → failed "sin conversación"', async () => {
    const db = seed({ conversations: [] })
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order({ conversation_id: null }), 'paid', f.deps)

    expect(outcome).toBe('failed')
    expect(f.sendText).not.toHaveBeenCalled()
    expect(f.sendTemplate).not.toHaveBeenCalled()
    expect(storedOrder(db)).toMatchObject({
      last_notice: 'paid',
      last_notice_error: NOTICE_ERRORS.noConversation,
    })
  })

  it('contacto borrado (contact_id nulo) y sin conversación → failed', async () => {
    const db = seed({ conversations: [] })
    const f = fakes()
    const outcome = await sendOrderNotice(
      asClient(db),
      order({ contact_id: null, conversation_id: null }),
      'paid',
      f.deps,
    )
    expect(outcome).toBe('failed')
    expect(storedOrder(db).last_notice_error).toBe(NOTICE_ERRORS.noConversation)
  })

  it('sin conversation_id usa la conversación más reciente del contacto en la cuenta', async () => {
    const db = seed({
      conversations: [
        { id: 'cv-vieja', account_id: ACCOUNT, contact_id: CONTACT, last_message_at: ago(48 * HOURS) },
        { id: 'cv-nueva', account_id: ACCOUNT, contact_id: CONTACT, last_message_at: ago(HOURS) },
        { id: 'cv-ajena', account_id: OTHER_ACCOUNT, contact_id: CONTACT, last_message_at: ago(1000) },
      ],
      messages: [customerMessage(HOURS, 'cv-nueva')],
    })
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order({ conversation_id: null }), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendText).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'cv-nueva' }))
  })

  it('una conversación sin mensajes (last_message_at nulo) no le gana a la que sí tiene', async () => {
    const db = seed({
      conversations: [
        { id: 'cv-vacia', account_id: ACCOUNT, contact_id: CONTACT, last_message_at: null },
        { id: 'cv-con-mensajes', account_id: ACCOUNT, contact_id: CONTACT, last_message_at: ago(48 * HOURS) },
      ],
    })
    const f = fakes()

    await sendOrderNotice(asClient(db), order({ conversation_id: null }), 'paid', f.deps)

    expect(db._tables.messages.at(-1)).toMatchObject({ conversation_id: 'cv-con-mensajes' })
  })

  it('si todas las conversaciones están vacías igual elige una', async () => {
    const db = seed({
      conversations: [{ id: 'cv-vacia', account_id: ACCOUNT, contact_id: CONTACT, last_message_at: null }],
    })
    const f = fakes()
    expect(await sendOrderNotice(asClient(db), order({ conversation_id: null }), 'paid', f.deps)).toBe('sent')
    expect(db._tables.messages.at(-1)).toMatchObject({ conversation_id: 'cv-vacia' })
  })

  it('una conversation_id de OTRA cuenta no se usa: cae a la del contacto', async () => {
    const db = seed({
      conversations: [
        { id: 'cv-ajena', account_id: OTHER_ACCOUNT, contact_id: CONTACT, last_message_at: ago(1000) },
        { id: CONVERSATION, account_id: ACCOUNT, contact_id: CONTACT, last_message_at: ago(HOURS) },
      ],
    })
    const f = fakes()
    await sendOrderNotice(asClient(db), order({ conversation_id: 'cv-ajena' }), 'paid', f.deps)
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
    expect(db._tables.messages.at(-1)).toMatchObject({ conversation_id: CONVERSATION })
  })

  it('contacto sin teléfono válido ni BSUID → "no tiene WhatsApp vinculado"', async () => {
    const db = seed()
    db._tables.contacts[0] = { id: CONTACT, account_id: ACCOUNT, phone: '123', wa_user_id: null }
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('failed')
    expect(f.sendText).not.toHaveBeenCalled()
    expect(f.sendTemplate).not.toHaveBeenCalled()
    expect(storedOrder(db).last_notice_error).toBe('El cliente no tiene WhatsApp vinculado')
  })

  const noCredentialsCases: [string, Row[]][] = [
    ['ventana cerrada (plantilla)', []],
    ['ventana abierta (texto)', [customerMessage(HOURS)]],
  ]
  for (const [label, messages] of noCredentialsCases) {
    it(`sin credenciales (no conectado o token ilegible), ${label}: mismo motivo y sin enviar`, async () => {
      const db = seed({ messages })
      const f = fakes()
      f.loadCredentials.mockRejectedValue(new Error('bad decrypt'))

      const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

      expect(outcome).toBe('failed')
      expect(f.sendText).not.toHaveBeenCalled()
      expect(f.sendTemplate).not.toHaveBeenCalled()
      expect(storedOrder(db)).toMatchObject({
        last_notice: 'paid',
        last_notice_error: NOTICE_ERRORS.notConfigured,
      })
    })
  }
})

describe('sendOrderNotice — registro en el pedido', () => {
  it('escribe solo last_notice y last_notice_error, solo en el pedido de la cuenta', async () => {
    const mine = order()
    const theirs = order({ account_id: OTHER_ACCOUNT, last_notice: 'delivered', last_notice_error: 'viejo' })
    const db = seed({ messages: [customerMessage(HOURS)] }, mine)
    db._tables.orders.push({ ...theirs } as unknown as Row)
    const f = fakes()

    await sendOrderNotice(asClient(db), mine, 'paid', f.deps)

    const own = db._tables.orders.find((o) => o.account_id === ACCOUNT)!
    const foreign = db._tables.orders.find((o) => o.account_id === OTHER_ACCOUNT)!
    expect(own).toMatchObject({ last_notice: 'paid', last_notice_error: null, status: 'new', total: 110000 })
    expect(foreign).toMatchObject({ last_notice: 'delivered', last_notice_error: 'viejo' })
  })

  it('si no se puede guardar el resultado, igual devuelve el del envío', async () => {
    const db = seed({ messages: [customerMessage(HOURS)] })
    db._failNext('update', 'orders', { message: 'caído' })
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[ventas notice]'),
      expect.anything(),
    )
  })
})

describe('sendOrderNotice — nunca lanza', () => {
  it('una base que revienta en cualquier consulta → failed', async () => {
    const f = fakes()
    const broken = {
      from: () => {
        throw new Error('la base se cayó')
      },
    }

    await expect(
      sendOrderNotice(broken as never, order(), 'paid', f.deps),
    ).resolves.toBe('failed')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[ventas notice]'),
      expect.any(Error),
    )
  })

  it('un sender que lanza algo que no es un Error → failed', async () => {
    const db = seed({ messages: [customerMessage(HOURS)] })
    const f = fakes()
    f.sendText.mockRejectedValue('texto suelto')
    await expect(sendOrderNotice(asClient(db), order(), 'paid', f.deps)).resolves.toBe('failed')
    expect(storedOrder(db).last_notice_error).toBe(NOTICE_ERRORS.generic)
  })

  it('los logs llevan el prefijo [ventas notice]', async () => {
    const db = seed({ conversations: [] })
    const f = fakes()
    await sendOrderNotice(asClient(db), order({ conversation_id: null }), 'paid', f.deps)
    const calls = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(String(call[0])).toContain('[ventas notice]')
  })
})

describe('sendOrderNotice — WHATSAPP_TEMPLATES_DRY_RUN', () => {
  // En este código esa variable solo gobierna el envío de plantillas A
  // REVISIÓN de Meta (/api/whatsapp/templates/*). Ningún envío de
  // mensajes la mira (ni flujos ni recordatorios de la agenda), así que
  // los avisos tampoco: se comportan igual con la variable prendida.
  it('no cambia el envío de avisos (solo afecta la creación de plantillas)', async () => {
    vi.stubEnv('WHATSAPP_TEMPLATES_DRY_RUN', 'true')
    const db = seed({ messages: [customerMessage(30 * HOURS)] })
    const f = fakes()

    const outcome = await sendOrderNotice(asClient(db), order(), 'paid', f.deps)

    expect(outcome).toBe('sent')
    expect(f.sendTemplate).toHaveBeenCalledTimes(1)
  })
})
