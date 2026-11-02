import { describe, expect, it } from 'vitest'

import { CLINIC_HUMAN_WORDS, buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { AGENDA_AGENT_TEXTS } from '../texts'
import {
  ACCOUNT,
  CONTACT,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'

const texts = buildClinicTexts(DEFAULT_LABELS)

const MENU_IDS = ['act:book', 'act:mine', 'act:faq', 'act:urgent', 'act:human']
const CONSENT_BUTTONS = ['act:consent_yes', 'act:consent_no']

const session = (state: Record<string, unknown>) => ({
  id: 'ses-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: { mode: 'book', options: [], fails: 0, ...state },
})

const authorized = () => clinicDb({ clinic_consents: [grantedConsent()] })

/** Abre el menú como lo haría un paciente: con un saludo. */
async function withMenuOpen() {
  const db = authorized()
  const rec = makeRecorder()
  await send(db, rec, { text: 'Hola' })
  return { db, rec, sent: rec.calls.length }
}

/** Abre el menú y entra a "Precios y dudas". */
async function withFaqOpen() {
  const { db, rec } = await withMenuOpen()
  await send(db, rec, { replyId: 'act:faq' })
  return { db, rec, sent: rec.calls.length }
}

const activeSteps = (db: ReturnType<typeof clinicDb>) =>
  db._tables.booking_sessions
    .filter((s) => s.status === 'active')
    .map((s) => (s.state as { step: string }).step)

describe('sin sesión', () => {
  describe('con autorización', () => {
    it.each([
      'quiero una cita',
      'necesito cita para mi hijo',
      'cita',
      'agendar',
      '¿me das una cita?',
      '¿puedo agendar una cita para mañana?',
      'Qué pena, necesito una cita',
      'Tienen citas disponibles',
      'quiero una cita para una radiografía',
      'quiero agendar, ya hice el pago',
      'hola',
      'buenas',
      'Buenos días',
      'buen día',
      'buenas tardes',
    ])('abre el menú: %j', async (text) => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(MENU_IDS)
    })

    it.each([
      'cuánto vale una cita',
      'dónde es la cita',
      '¿Cuánto vale una cita de valoración?',
      'cuánto vale una limpieza',
      '¿aceptan tarjeta?',
      '¿puedo pagar con tarjeta?',
      '¿dónde quedan?',
      'gracias, buenas noches',
      'excelente, no tengo ninguna queja',
      'muchas gracias por la receta',
      'Buenos días, ¿cuánto vale la limpieza?',
    ])('va a la IA: %j', async (text) => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it.each([
      'quiero pagar',
      'tengo una queja',
      'el saldo',
      'documento de identidad',
      'necesito mi historia clínica',
    ])('pasa a una persona: %j', async (text) => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.humanTopicNote)
      expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
    })

    it('usa la palabra que la clínica le da a la cita', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_settings: [
          {
            account_id: ACCOUNT,
            bot_texts: {},
            labels: { cita: 'turno', citas: 'turnos' },
            choose_staff: true,
            show_price: false,
            show_duration: false,
            reminders_enabled: true,
            allow_reschedule: true,
          },
        ],
      })
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'cuándo tienen turnos para el viernes' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(MENU_IDS)
    })

    it('una foto, un audio o un tipo no soportado no se enruta: va a la IA', async () => {
      for (const text of ['', '[Unsupported message type: audio]']) {
        const db = authorized()
        const rec = makeRecorder()
        const result = await send(db, rec, { text })
        expect(result).toEqual({ consumed: false })
        expect(rec.calls).toHaveLength(0)
      }
    })

    it('"gracias por la atención" no abre el menú aunque la clínica llame "atención" a su servicio', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_settings: [
          {
            account_id: ACCOUNT,
            bot_texts: {},
            labels: { servicio: 'atención', servicios: 'atenciones' },
            choose_staff: true,
            show_price: false,
            show_duration: false,
            reminders_enabled: true,
            allow_reschedule: true,
          },
        ],
      })
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'Muchas gracias por la atención' })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
    })
  })

  describe('sin autorización', () => {
    it.each(['quiero una cita', 'hola', '¿cuánto vale una limpieza?', 'gracias'])(
      'lo demás pide la autorización antes de nada: %j',
      async (text) => {
        const db = clinicDb()
        const rec = makeRecorder()
        const result = await send(db, rec, { text })
        expect(result).toEqual({ consumed: true })
        expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
      },
    )

    it('una queja, un pago o un documento no la esperan: nadie se queda atascado en un aviso legal', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'Tengo una queja de mi última cita' })
      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(db._tables.booking_sessions).toHaveLength(0)
      expect(rec.calls.every((c) => !c.ids.includes('act:consent_yes'))).toBe(true)
    })
  })

  describe('quejas, pagos y documentos', () => {
    it('la lista tiene lo que pide la spec, sin tildes', () => {
      expect([...CLINIC_HUMAN_WORDS]).toEqual([
        'queja',
        'reclamo',
        'pqr',
        'pqrs',
        'factura',
        'pago',
        'pagar',
        'abono',
        'saldo',
        'certificado',
        'incapacidad',
        'historia clinica',
        'radiografia',
        'receta',
        'documento',
        'documentos',
      ])
    })

    it.each([
      'Tengo una queja del servicio',
      'Quiero poner un reclamo',
      'Necesito radicar una PQR',
      'Una pqrs por favor',
      'Necesito mi factura',
      'Quiero hacer el pago',
      'Voy a pagar hoy',
      'Hice un abono ayer',
      'Quiero saber mi saldo',
      'Necesito un certificado',
      'Necesito la incapacidad',
      'Mi historia clínica, por favor',
      'Necesito la radiografía de mi hijo',
      'Necesito una receta',
      'Envíenme el documento',
      'Documentos para el seguro',
      'Hola, quiero pagar mi factura',
    ])('un pedido pasa a una persona: %j', async (text) => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.humanTopicNote)
    })

    it.each([
      '¿Cuánto cuesta el certificado?',
      '¿Puedo pagar con tarjeta?',
      'cómo pago',
      'qué documentos piden para el primer día',
      'dónde recojo mi factura',
      '¿Me das el certificado?',
      'no tengo ninguna queja',
      'gracias por la factura',
    ])('una duda, una negación o un agradecimiento va a la IA: %j', async (text) => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: false })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(rec.calls).toHaveLength(0)
    })

    it('no confunde una palabra más larga: "pagado" no es "pago"', async () => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'ya está pagado, quiero una cita' })
      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('un toque de un botón no es texto y no dispara nada', async () => {
      const db = authorized()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:book' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('en una cuenta sin clínica no cambia nada', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'Necesito mi factura' }, { modules: ['agenda'] })
      expect(result).toEqual({ consumed: false })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('un hilo que ya es de una persona no se toca', async () => {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'Necesito mi factura' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
    })
  })
})

describe('con el menú abierto', () => {
  it('pedir una cita elige "Agendar" sin pasar por "No entendí"', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { text: 'necesito una cita para mañana' })
    expect(result).toEqual({ consumed: true })
    // Sin pacientes registrados, "Agendar" pide el nombre de quien va a asistir.
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    expect(activeSteps(db)).toEqual(['new_patient_name'])
    expect(rec.calls.some((c) => c.bodyText === AGENDA_AGENT_TEXTS.retry)).toBe(false)
  })

  it('un saludo vuelve a mostrar el menú sin contarlo como fallo', async () => {
    const { db, rec, sent } = await withMenuOpen()
    for (let i = 0; i < 3; i += 1) {
      const result = await send(db, rec, { text: 'hola' })
      expect(result).toEqual({ consumed: true })
    }
    expect(rec.calls).toHaveLength(sent + 3)
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(rec.calls.some((c) => c.bodyText === AGENDA_AGENT_TEXTS.retry)).toBe(false)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    const open = db._tables.booking_sessions.filter((s) => s.status === 'active')
    expect((open[0].state as { fails: number }).fails).toBe(0)
  })

  it('una queja, un pago o un documento pasa a una persona y cierra la sesión', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { text: 'quiero pagar' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.humanTopicNote)
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it.each([
    '¿Cuánto vale una limpieza?',
    'qué precio tiene la limpieza',
    'cuánto vale una cita',
    'me duele una muela y no sé qué hacer',
  ])('lo demás se suelta a la IA y cierra la sesión: %j', async (text) => {
    const { db, rec, sent } = await withMenuOpen()
    const result = await send(db, rec, { text })
    // `released` le dice al despachador que no la reclame por tener sesión.
    expect(result).toEqual({ consumed: false, released: true })
    expect(rec.calls).toHaveLength(sent)
    expect(activeSteps(db)).toEqual([])
    expect(db._tables.booking_sessions[0].status).toBe('completed')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('una foto o un audio sigue el camino de siempre: se vuelve a preguntar', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { text: '[Unsupported message type: audio]' })
    expect(result).toEqual({ consumed: true })
    expect(rec.calls.some((c) => c.bodyText === AGENDA_AGENT_TEXTS.retry)).toBe(true)
    expect(activeSteps(db)).toEqual(['clinic_menu'])
  })

  it('un toque del menú sigue su camino', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
  })
})

describe('esperando la duda ("Precios y dudas")', () => {
  it('deja la sesión esperando y invita a preguntar', async () => {
    const { db, rec } = await withFaqOpen()
    expect(last(rec).bodyText).toBe(texts.faqPrompt)
    expect(activeSteps(db)).toEqual(['faq_open'])
  })

  it('el siguiente texto se suelta a la IA, aunque diga "cita" o "pago"', async () => {
    for (const text of [
      'cuánto vale la cita de valoración',
      'quiero saber cuánto vale',
      'quiero pagar',
      'tengo una queja',
      'hola',
    ]) {
      const { db, rec, sent } = await withFaqOpen()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: false, released: true })
      expect(rec.calls).toHaveLength(sent)
      expect(activeSteps(db)).toEqual([])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    }
  })

  it('pedir una cita elige "Agendar"', async () => {
    const { db, rec } = await withFaqOpen()
    const result = await send(db, rec, { text: 'quiero una cita para mañana' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    expect(activeSteps(db)).toEqual(['new_patient_name'])
  })

  it.each(['', '[Unsupported message type: audio]', '   '])(
    'una foto, un audio o un tipo no soportado (%j) no cierra la sesión',
    async (text) => {
      const { db, rec, sent } = await withFaqOpen()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: true })
      expect(activeSteps(db)).toEqual(['faq_open'])
      // Se vuelve a invitar a escribir la duda, sin contarlo como fallo.
      expect(rec.calls).toHaveLength(sent + 1)
      expect(last(rec).bodyText).toBe(texts.faqPrompt)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    },
  )

  it('pedir una persona sigue ganando', async () => {
    const { db, rec } = await withFaqOpen()
    const result = await send(db, rec, { text: 'mejor quiero hablar con una persona' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })
})

describe('el menú sigue vivo', () => {
  it('sin sesión y con autorización, "Agendar" funciona', async () => {
    const db = authorized()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    expect(activeSteps(db)).toEqual(['new_patient_name'])
  })

  it('sin sesión, "Precios y dudas" invita a preguntar', async () => {
    const db = authorized()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:faq' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe(texts.faqPrompt)
    expect(activeSteps(db)).toEqual(['faq_open'])
  })

  it('sin sesión, "Hablar con una persona" pasa el hilo', async () => {
    const db = authorized()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:human' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it.each(['act:mine', 'act:urgent'])('sin sesión, %s también lo atiende el bot', async (replyId) => {
    const db = authorized()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId })
    expect(result).toEqual({ consumed: true })
    expect(rec.calls.length).toBeGreaterThan(0)
  })

  it('sin sesión y sin IA, "Precios y dudas" pasa a una persona', async () => {
    const db = authorized()
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:faq' }, { aiOn: false })
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.aiOffNote)
  })

  it('sin autorización, el toque muestra la autorización', async () => {
    for (const replyId of ['act:book', 'act:faq', 'act:human']) {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    }
  })

  it('un toque que no es del menú sigue sin arrancar nada', async () => {
    for (const replyId of ['svc:svc-limpieza', 'day:2026-10-20', 'act:confirm', 'pat:abc']) {
      const db = authorized()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
    }
  })

  it('desde "Precios y dudas", "Agendar" funciona', async () => {
    const { db, rec } = await withFaqOpen()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    expect(activeSteps(db)).toEqual(['new_patient_name'])
    expect(rec.calls.some((c) => c.bodyText === AGENDA_AGENT_TEXTS.retry)).toBe(false)
  })

  it('desde "Precios y dudas", "Hablar con una persona" pasa el hilo', async () => {
    const { db, rec } = await withFaqOpen()
    await send(db, rec, { replyId: 'act:human' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it('desde "Precios y dudas", tocar "Precios y dudas" otra vez vuelve a invitar', async () => {
    const { db, rec, sent } = await withFaqOpen()
    await send(db, rec, { replyId: 'act:faq' })
    expect(rec.calls).toHaveLength(sent + 1)
    expect(last(rec).bodyText).toBe(texts.faqPrompt)
    expect(activeSteps(db)).toEqual(['faq_open'])
  })

  it('una cuenta sin clínica no cambia: un toque sin sesión no arranca nada', async () => {
    const db = authorized()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:book' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })
})

describe('si la IA está apagada', () => {
  it('una duda con el menú abierto pasa a una persona, no queda en silencio', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' }, { aiOn: false })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.aiOffNote)
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('lo que se escribe esperando la duda también', async () => {
    const { db, rec } = await withFaqOpen()
    const result = await send(db, rec, { text: 'cuánto vale la limpieza' }, { aiOn: false })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.aiOffNote)
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it('"Precios y dudas" no promete una respuesta que nadie va a dar', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { replyId: 'act:faq' }, { aiOn: false })
    expect(result).toEqual({ consumed: true })
    expect(rec.calls.some((c) => c.bodyText === texts.faqPrompt)).toBe(false)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.aiOffNote)
    expect(activeSteps(db)).toEqual([])
  })

  it('si no se pudo leer la configuración de la IA, cuenta como apagada', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(
      db,
      rec,
      { text: '¿Cuánto vale una limpieza?' },
      { aiOn: () => Promise.reject(new Error('no se pudo descifrar la llave')) },
    )
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.aiOffNote)
  })

  it('con la IA prendida nada cambia', async () => {
    const { db, rec } = await withMenuOpen()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' }, { aiOn: true })
    expect(result).toEqual({ consumed: false, released: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('lo que no es para la IA no la consulta: pedir una cita, un saludo, una queja', async () => {
    for (const text of ['necesito una cita', 'hola', 'quiero pagar']) {
      let asked = 0
      const { db, rec } = await withMenuOpen()
      await send(db, rec, { text }, { aiOn: async () => (asked += 1) > 0 })
      expect(asked).toBe(0)
    }
  })

  it('se consulta una sola vez por mensaje', async () => {
    let asked = 0
    const { db, rec } = await withMenuOpen()
    await send(db, rec, { text: '¿Cuánto vale?' }, { aiOn: async () => (asked += 1) > 0 })
    expect(asked).toBe(1)
  })

  it('sin sesión no cambia: el mensaje queda en la bandeja para quien lo atienda', async () => {
    const db = authorized()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' }, { aiOn: false })
    expect(result).toEqual({ consumed: false })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })
})

describe('las palabras de quejas, pagos y documentos solo valen sin sesión y con el menú abierto', () => {
  it('no en la autorización: "no acepto dar mis documentos" es un rechazo registrado', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'no acepto dar mis documentos' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: false }])
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentDeclinedNote)
  })

  it('no en la autorización, aunque sea un pedido: "quiero pagar" no la salta', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'quiero pagar' })
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.humanTopicNote)
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it.each([
    ['pick_service', { step: 'pick_service' }],
    ['pick_day', { step: 'pick_day', serviceId: 'svc-limpieza', staffId: 'any' }],
    ['summary', { step: 'summary' }],
    ['ask_question', { step: 'ask_question', questionId: 'q-1' }],
    ['new_patient_name', { step: 'new_patient_name' }],
    ['manage_menu', { step: 'manage_menu' }],
  ])('no en %s', async (_name, state) => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session(state)],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Voy a pagar con tarjeta, documento listo' })
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.humanTopicNote)
  })
})
