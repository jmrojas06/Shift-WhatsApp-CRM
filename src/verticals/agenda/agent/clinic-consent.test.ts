import { describe, expect, it } from 'vitest'

import { buildClinicTexts } from '@/modules/clinica/texts'
import { AGENDA_AGENT_TEXTS } from '../texts'
import { DEFAULT_LABELS } from '../labels'

import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  OWNER,
  SERVICE_LIMPIEZA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'

const texts = buildClinicTexts(DEFAULT_LABELS)

const CONSENT_BUTTONS = ['act:consent_yes', 'act:consent_no']
const MENU_IDS = ['act:book', 'act:mine', 'act:faq', 'act:urgent', 'act:human']

describe('autorización de datos', () => {
  it('el primer mensaje pide autorización antes que nada', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe('Texto de autorización')
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    expect(last(rec).titles).toEqual([texts.consentAccept, texts.consentDecline])
  })

  it('sin autorización, ni una pregunta le llega a la IA', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('sin autorización, un toque de un menú viejo tampoco llega a la IA', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('aceptar guarda la autorización con su versión y abre el menú', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toMatchObject([
      {
        account_id: ACCOUNT,
        contact_id: CONTACT,
        contact_ref: '573001112233',
        kind: 'datos_sensibles',
        granted: true,
        text_version: 2,
        text_snapshot: 'Texto de autorización',
        source: 'whatsapp',
      },
    ])
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(last(rec).bodyText).toBe(texts.menuBody)
  })

  it('guarda el texto que vio la persona, no el que la clínica puso mientras tanto', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    // La clínica edita el texto después de que el paciente lo recibió y antes de que responda.
    db._tables.clinic_settings[0].consent_text = 'Texto nuevo'
    db._tables.clinic_settings[0].consent_version = 3
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents[0]).toMatchObject({
      text_version: 2,
      text_snapshot: 'Texto de autorización',
    })
  })

  it('si lo vuelve a recibir, guarda el texto nuevo que ve ahora', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._tables.clinic_settings[0].consent_text = 'Texto nuevo'
    db._tables.clinic_settings[0].consent_version = 3
    await send(db, rec, { text: 'acepto' })
    expect(last(rec).bodyText).toBe('Texto nuevo')
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents[0]).toMatchObject({
      text_version: 3,
      text_snapshot: 'Texto nuevo',
    })
  })

  it('sin teléfono, la autorización guarda el identificador de WhatsApp del titular', async () => {
    const db = clinicDb({
      contacts: [
        {
          id: CONTACT,
          account_id: ACCOUNT,
          name: 'Marta Ruiz',
          phone: '',
          wa_user_id: 'US.13491208655302741918',
        },
      ],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents[0].contact_ref).toBe('US.13491208655302741918')
  })

  it('sin teléfono ni identificador no hay a nombre de quién guardar: no se registra nada', async () => {
    const db = clinicDb({
      contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Marta Ruiz', phone: '' }],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(rec.calls.some((c) => c.bodyText === texts.consentError)).toBe(true)
    // Vuelve a ofrecer los botones y no abre el menú ni pausa el hilo.
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('si la base rechaza el registro, no hay autorización y se avisa', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(rec.calls.some((c) => c.bodyText === texts.consentError)).toBe(true)
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('no aceptar registra la negativa y deja el hilo con una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_no' })
    expect(db._tables.clinic_consents[0].granted).toBe(false)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentDeclinedNote)
    expect(last(rec).bodyText).toBe(texts.consentDeclined)
    expect(db._tables.booking_sessions.every((s) => s.status !== 'active')).toBe(true)
  })

  it('escribir "acepto" no autoriza nada: vuelve a mostrar los botones', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    const result = await send(db, rec, { text: 'acepto' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).bodyText).toBe('Texto de autorización')
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('escribir "acepto" dos veces seguidas pasa el hilo a una persona, sin autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto' })
    await send(db, rec, { text: 'sí, acepto' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('la nota de ese pase dice que la autorización quedó sin responder, no que pidió una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto' })
    await send(db, rec, { text: 'sí, acepto' })
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentUnansweredNote)
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(AGENDA_AGENT_TEXTS.handoffNote)
  })

  it('un texto raro y luego el toque sí autoriza', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: true }])
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('si la base rechaza el registro dos veces seguidas, pasa a una persona (no repite "intenta de nuevo")', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentUnansweredNote)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('un fallo al guardar y luego un texto raro también pasa a una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { text: 'acepto' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('un fallo al guardar que se arregla en el segundo toque deja la autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: true }])
    expect(last(rec).ids).toEqual(MENU_IDS)
  })

  it.each(['act:consent_yes', 'act:consent_no'])(
    'un segundo toque (%s) con el menú ya abierto se ignora en silencio',
    async (replyId) => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:consent_yes' })
      const sent = rec.calls.length
      const result = await send(db, rec, { replyId })
      expect(result).toEqual({ consumed: true })
      // Ni mensaje, ni fallo, ni otro registro, ni pase a una persona.
      expect(rec.calls).toHaveLength(sent)
      expect(db._tables.clinic_consents).toHaveLength(1)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      const open = db._tables.booking_sessions.filter((s) => s.status === 'active')
      expect(open.map((s) => (s.state as { step: string; fails: number }).step)).toEqual(['clinic_menu'])
      expect((open[0].state as { fails: number }).fails).toBe(0)
    },
  )

  it('el toque del menú sigue valiendo después de un doble toque', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { replyId: 'act:book' })
    // Sin pacientes registrados, "Agendar" pide primero el nombre.
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
  })

  it.each(['1', '2', '2.'])(
    'escribir el número "%s" no registra nada: ni acepta ni rechaza',
    async (typed) => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { text: typed })
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    },
  )

  it('escribir que no acepta sí queda como negativa', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'no acepto' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: false }])
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('un "acepto, no hay problema" tampoco autoriza', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto, no hay problema' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: false }])
  })

  it('con autorización, un saludo abre el menú sin volver a pedirla', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(db._tables.clinic_consents).toHaveLength(1)
  })

  it('si el paciente la rechazó antes y el hilo se reabre, la vuelve a pedir', async () => {
    const db = clinicDb({
      clinic_consents: [{ ...grantedConsent(), granted: false }],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('"Hablar con una persona" pasa el hilo a un asesor', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:human' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('una cuenta sin el módulo no pide autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).ids[0]).toMatch(/^svc:/)
  })

  it('una cuenta sin el módulo no lee la configuración de la clínica', async () => {
    // Sin el módulo, ni la fila que falta ni un fallo de lectura cambian nada.
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids[0]).toMatch(/^svc:/)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })
})

describe('la clínica no está disponible', () => {
  const urgencyNotification = (db: ReturnType<typeof clinicDb>) =>
    db._tables.notifications.find((n) => n.title === texts.urgencyNotificationTitle)

  it('sin configuración, el bot consume el mensaje y lo deja con una persona', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableNote)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
    // Sin configuración tampoco se sabe qué autorización pedir.
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
  })

  it('si la configuración no se pudo leer, igual: consume y pasa a una persona', async () => {
    const db = clinicDb()
    db._failNext('select', 'clinic_settings', { message: 'connection reset' })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableNote)
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('una configuración sin textos tampoco se usa', async () => {
    const db = clinicDb({
      clinic_settings: [
        {
          account_id: ACCOUNT,
          consent_text: '   ',
          consent_version: 1,
          urgency_words: [],
          urgency_alarm_text: 'Signos de alarma',
          urgency_service_id: null,
          offer_days: 30,
        },
      ],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(rec.calls.every((c) => c.bodyText !== '   ')).toBe(true)
  })

  it('aunque el paciente ya haya autorizado, no sigue sin saber cómo está configurada la clínica', async () => {
    const db = clinicDb({ clinic_settings: [], clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Atienden hoy?' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('un toque de un menú viejo también queda con una persona', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('avisa al dueño con el aviso normal de un asesor', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({
      user_id: OWNER,
      conversation_id: CONVERSATION,
      title: AGENDA_AGENT_TEXTS.handoffNotificationTitle,
    })
    expect(urgencyNotification(db)).toBeUndefined()
  })

  it('si el mensaje trae una palabra de urgencia, usa el aviso prioritario', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Tengo mucho dolor de muela' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableUrgentNote)
    expect(db._tables.notifications).toHaveLength(1)
    expect(urgencyNotification(db)).toMatchObject({
      user_id: OWNER,
      body: texts.urgencyNotificationBody('Marta Ruiz'),
    })
  })

  describe('quién recibe el aviso cuando el dueño también es el agente de pase', () => {
    const AGENT = 'user-agent'
    const withAgent = (agentId: string) =>
      clinicDb({
        clinic_settings: [],
        ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: agentId }],
      })
    const titlesFor = (db: ReturnType<typeof clinicDb>, userId: string) =>
      db._tables.notifications.filter((n) => n.user_id === userId).map((n) => n.title)

    it('el aviso de urgencia le llega al dueño aunque sea quien atiende', async () => {
      const db = withAgent(OWNER)
      await send(db, makeRecorder(), { text: 'Tengo mucho dolor de muela' })
      expect(db._tables.conversations[0].assigned_agent_id).toBe(OWNER)
      expect(titlesFor(db, OWNER)).toEqual([texts.urgencyNotificationTitle])
    })

    it('si el agente es otra persona, los dos reciben el aviso de urgencia', async () => {
      const db = withAgent(AGENT)
      await send(db, makeRecorder(), { text: 'Tengo mucho dolor de muela' })
      expect(titlesFor(db, OWNER)).toEqual([texts.urgencyNotificationTitle])
      expect(titlesFor(db, AGENT)).toEqual([texts.urgencyNotificationTitle])
    })

    it('un pase normal sigue como antes: si el dueño es el agente, lo avisa la asignación', async () => {
      const db = withAgent(OWNER)
      await send(db, makeRecorder(), { text: 'Hola' })
      expect(db._tables.notifications).toHaveLength(0)
    })

    it('un pase normal con otro agente solo avisa al dueño', async () => {
      const db = withAgent(AGENT)
      await send(db, makeRecorder(), { text: 'Hola' })
      expect(titlesFor(db, OWNER)).toEqual([AGENDA_AGENT_TEXTS.handoffNotificationTitle])
      expect(titlesFor(db, AGENT)).toEqual([])
    })
  })

  it('las palabras de urgencia son las de siempre, no las de una configuración que no se pudo leer', async () => {
    const db = clinicDb()
    db._failNext('select', 'clinic_settings', { message: 'timeout' })
    const rec = makeRecorder()
    await send(db, rec, { text: 'me sangran las encías' })
    expect(urgencyNotification(db)).toBeDefined()
  })

  it('una sesión a medias se cierra al pasar a la persona', async () => {
    const db = clinicDb({
      clinic_settings: [],
      booking_sessions: [
        {
          id: 'ses-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'active',
          expires_at: '2026-10-19T13:10:00.000Z',
          state: { step: 'pick_service', mode: 'book', options: [], fails: 0 },
        },
      ],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it('los toques de un recordatorio se siguen atendiendo', async () => {
    const db = clinicDb({
      clinic_settings: [],
      booking_appointments: [
        {
          id: 'ap-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          service_id: SERVICE_LIMPIEZA,
          staff_id: STAFF_ANA,
          starts_at: '2026-10-20T15:00:00.000Z',
          ends_at: '2026-10-20T15:30:00.000Z',
          status: 'pending',
          answers: {},
        },
      ],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'rem:confirm' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(last(rec).bodyText).toContain('Queda confirmado')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('si una persona ya tiene el hilo, no lo toca ni repite el aviso', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' }, { humanOwned: true })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('en una cuenta sin el módulo, una clínica sin configurar no cambia nada', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(db._tables.notifications).toHaveLength(0)
  })
})
