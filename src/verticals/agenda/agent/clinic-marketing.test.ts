import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { patId, svcId } from './state'
import {
  ACCOUNT,
  CONTACT,
  SERVICE_LIMPIEZA,
  STAFF_ANA,
  answeredMarketing,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
  type Recorder,
} from './testing/clinic-harness'
import type { FakeDb } from './testing/fake-db'

const texts = buildClinicTexts(DEFAULT_LABELS)

const patients = () => [
  { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
]

/** Un paciente con autorización de datos y sin respuesta a los avisos de control. */
const newPatientDb = (extra: Record<string, never[]> = {}) =>
  clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: patients(), ...extra })

/** Del saludo a la cita confirmada. */
async function bookOnce(db: FakeDb, rec: Recorder) {
  await send(db, rec, { text: 'Hola' })
  await send(db, rec, { replyId: 'act:book' })
  await send(db, rec, { replyId: patId('pat-1') })
  await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
  await send(db, rec, { replyId: last(rec).ids[0] }) // día
  await send(db, rec, { replyId: last(rec).ids[0] }) // hora
  await send(db, rec, { replyId: 'act:confirm' })
}

const marketingRows = (db: FakeDb) => db._tables.clinic_consents.filter((c) => c.kind === 'mercadeo')

const activeSteps = (db: FakeDb) =>
  db._tables.booking_sessions
    .filter((s) => s.status === 'active')
    .map((s) => (s.state as { step: string }).step)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('permiso para avisos de control', () => {
  it('después de agendar confirma la cita y pregunta, con dos botones', async () => {
    const db = newPatientDb()
    const rec = makeRecorder()
    await bookOnce(db, rec)

    expect(rec.calls.at(-2)?.bodyText).toContain('Quedó agendado')
    expect(last(rec).bodyText).toBe(texts.marketingBody)
    expect(last(rec).ids).toEqual(['act:mkt_yes', 'act:mkt_no'])
    expect(last(rec).titles).toEqual([texts.marketingYes, texts.marketingNo])
    expect(activeSteps(db)).toEqual(['marketing_consent'])
    // Preguntar no guarda nada todavía.
    expect(marketingRows(db)).toHaveLength(0)
  })

  it('al tocar "Sí, avísame" guarda la respuesta aparte, con el texto que vio', async () => {
    const db = newPatientDb()
    const rec = makeRecorder()
    await bookOnce(db, rec)

    await send(db, rec, { replyId: 'act:mkt_yes' })

    expect(marketingRows(db)).toMatchObject([
      {
        account_id: ACCOUNT,
        contact_id: CONTACT,
        contact_ref: '573001112233',
        kind: 'mercadeo',
        granted: true,
        text_version: 2,
        text_snapshot: '¿Quieres que te avisemos cuando te toque tu próximo control o limpieza?',
        source: 'whatsapp',
        message_id: expect.stringMatching(/^wamid-/),
      },
    ])
    // La autorización de datos sigue siendo la suya, aparte.
    expect(db._tables.clinic_consents.filter((c) => c.kind === 'datos_sensibles')).toHaveLength(1)
    expect(last(rec).bodyText).toBe(texts.marketingThanksYes)
    expect(activeSteps(db)).toEqual([])
  })

  it('al tocar "No, gracias" guarda el rechazo', async () => {
    const db = newPatientDb()
    const rec = makeRecorder()
    await bookOnce(db, rec)

    await send(db, rec, { replyId: 'act:mkt_no' })

    expect(marketingRows(db)).toMatchObject([
      { kind: 'mercadeo', granted: false, text_snapshot: texts.marketingBody },
    ])
    expect(last(rec).bodyText).toBe(texts.marketingThanksNo)
    expect(activeSteps(db)).toEqual([])
  })

  it('escribir "No, gracias" también es un rechazo', async () => {
    const db = newPatientDb()
    const rec = makeRecorder()
    await bookOnce(db, rec)

    await send(db, rec, { text: 'No, gracias' })

    expect(marketingRows(db)).toMatchObject([{ granted: false }])
  })

  describe('el sí llega solo por el toque del botón', () => {
    it.each(['sí', 'si', 'Sí, avísame', 'acepto', 'claro', 'dale', '1', 'ok'])(
      'escribir %j no autoriza nada',
      async (text) => {
        const db = newPatientDb()
        const rec = makeRecorder()
        await bookOnce(db, rec)

        await send(db, rec, { text })

        expect(marketingRows(db)).toHaveLength(0)
      },
    )

    it('un toque viejo, sin la pregunta abierta, no autoriza nada', async () => {
      const db = newPatientDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' }) // el menú, sin pregunta

      await send(db, rec, { replyId: 'act:mkt_yes' })
      expect(marketingRows(db)).toHaveLength(0)

      // Sin ninguna sesión abierta tampoco.
      const closed = newPatientDb()
      const rec2 = makeRecorder()
      await send(closed, rec2, { replyId: 'act:mkt_yes' })
      expect(marketingRows(closed)).toHaveLength(0)
      expect(rec2.calls.at(-2)?.bodyText).toBe(texts.optionExpired)
    })
  })

  // La pregunta es opcional: quien escribe otra cosa ("gracias", una duda) no recibe un
  // "no entendí", y dos mensajes así no pasan la conversación a una persona.
  describe('si no la contesta', () => {
    async function afterQuestion() {
      const db = newPatientDb()
      const rec = makeRecorder()
      await bookOnce(db, rec)
      return { db, rec, callsBefore: rec.calls.length }
    }

    it.each(['gracias', 'ok', 'sí', 'perfecto, muchas gracias'])(
      'escribir %j la deja sin responder, sin registrar nada y sigue su camino',
      async (text) => {
        const { db, rec, callsBefore } = await afterQuestion()

        const result = await send(db, rec, { text })

        expect(marketingRows(db)).toHaveLength(0)
        expect(activeSteps(db)).toEqual([])
        expect(rec.calls).toHaveLength(callsBefore)
        // No lo contesta el bot: el mensaje sigue su camino (a la IA), y se avisa que la
        // sesión se soltó. Sin `released` el despachador lo reclamaría por la sesión
        // que leyó antes y nadie lo contestaría.
        expect(result).toEqual({ consumed: false, released: true })
      },
    )

    it.each([
      'no voy a poder asistir a la cita',
      'no puedo ir a la cita',
      '¿no hay parqueadero?',
      'no sé',
      'no, gracias por todo',
    ])('una negación dentro de otra frase (%j) no registra un rechazo', async (text) => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { text })

      // Registrarlo perdería el aviso para siempre: la pregunta no se vuelve a hacer.
      expect(marketingRows(db)).toHaveLength(0)
      expect(activeSteps(db)).not.toContain('marketing_consent')
      expect(rec.calls.some((c) => c.bodyText === texts.marketingThanksNo)).toBe(false)
    })

    it('"no voy a poder asistir a la cita" sigue su camino: se le muestran sus citas', async () => {
      const { db, rec } = await afterQuestion()

      const result = await send(db, rec, { text: 'no voy a poder asistir a la cita' })

      expect(result).toEqual({ consumed: true })
      expect(rec.calls.some((c) => c.bodyText.includes('Marta') || c.bodyText === texts.noUpcoming)).toBe(true)
    })

    it.each(['no', 'No.', 'no gracias', 'Mejor no', 'no señor', 'no señora'])(
      'un no completo (%j) sí es el rechazo',
      async (text) => {
        const { db, rec } = await afterQuestion()

        const result = await send(db, rec, { text })

        expect(result).toEqual({ consumed: true })
        expect(marketingRows(db)).toMatchObject([{ granted: false }])
      },
    )

    it('dos mensajes seguidos no pasan la conversación a una persona', async () => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { text: 'gracias' })
      await send(db, rec, { text: 'ok' })

      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(rec.calls.some((c) => c.bodyText.includes('asesor humano'))).toBe(false)
      expect(rec.calls.some((c) => c.bodyText.includes('No entendí'))).toBe(false)
    })

    it('una duda va a la IA, como si no hubiera pregunta', async () => {
      const { db, rec, callsBefore } = await afterQuestion()

      const result = await send(db, rec, { text: '¿a qué hora debo llegar?' })

      expect(result).toEqual({ consumed: false, released: true })
      expect(rec.calls).toHaveLength(callsBefore)
      expect(activeSteps(db)).toEqual([])
    })

    it('un saludo vuelve al menú', async () => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { text: 'Hola' })

      expect(last(rec).ids).toContain('act:book')
      expect(activeSteps(db)).toEqual(['clinic_menu'])
      expect(marketingRows(db)).toHaveLength(0)
    })

    it('una foto o un audio reciben el aviso de siempre y el menú', async () => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { text: '[Unsupported message type: image]' })

      expect(rec.calls.at(-2)?.bodyText).toBe(texts.nonTextNotice)
      expect(last(rec).ids).toContain('act:book')
    })

    it('el toque de un menú que ya no está activo se dice, no se confunde con la pregunta', async () => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })

      expect(rec.calls.at(-2)?.bodyText).toBe(texts.optionExpired)
      expect(marketingRows(db)).toHaveLength(0)
    })

    it('una urgencia gana sobre la pregunta', async () => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { text: 'tengo mucho dolor' })

      expect(last(rec).bodyText).toContain('Signos de alarma')
      expect(activeSteps(db)).toEqual(['urgency'])
      expect(marketingRows(db)).toHaveLength(0)
    })

    it('pedir una persona sigue pasando la conversación a una persona', async () => {
      const { db, rec } = await afterQuestion()

      await send(db, rec, { text: 'quiero hablar con un asesor' })

      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    })

    it('contestar con el botón después de otro mensaje ya no cuenta: la pregunta se cerró', async () => {
      const { db, rec } = await afterQuestion()
      await send(db, rec, { text: 'gracias' })

      await send(db, rec, { replyId: 'act:mkt_yes' })

      expect(marketingRows(db)).toHaveLength(0)
      expect(rec.calls.at(-2)?.bodyText).toBe(texts.optionExpired)
    })
  })

  describe('solo se pregunta una vez', () => {
    it.each([
      ['dijo que sí', true],
      ['dijo que no', false],
    ])('si ya respondió (%s), no vuelve a preguntar', async (_label, granted) => {
      const db = clinicDb({
        clinic_consents: [grantedConsent(), answeredMarketing(granted)],
        clinic_patients: patients(),
      })
      const rec = makeRecorder()
      await bookOnce(db, rec)

      expect(last(rec).bodyText).toContain('Quedó agendado')
      expect(activeSteps(db)).toEqual([])
    })

    it('tras responder, la siguiente cita ya no lo pregunta', async () => {
      const db = newPatientDb()
      const rec = makeRecorder()
      await bookOnce(db, rec)
      await send(db, rec, { replyId: 'act:mkt_no' })

      await bookOnce(db, rec)

      expect(last(rec).bodyText).toContain('Quedó agendado')
      expect(marketingRows(db)).toHaveLength(1)
    })
  })

  describe('cuándo no se pregunta', () => {
    it('no en una reserva de urgencia: primero la urgencia', async () => {
      const db = newPatientDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      await send(db, rec, { replyId: 'pat:pat-1' })
      await send(db, rec, { replyId: last(rec).ids[0] }) // hora de hoy
      await send(db, rec, { replyId: 'act:confirm' })

      expect(db._tables.booking_appointments).toHaveLength(1)
      expect(last(rec).bodyText).toContain('Quedó agendado')
      expect(activeSteps(db)).toEqual([])
      expect(marketingRows(db)).toHaveLength(0)
    })

    it('no tras reprogramar', async () => {
      const db = newPatientDb({
        booking_appointments: [
          {
            id: 'ap-old',
            account_id: ACCOUNT,
            contact_id: CONTACT,
            service_id: SERVICE_LIMPIEZA,
            staff_id: STAFF_ANA,
            patient_id: 'pat-1',
            starts_at: '2026-10-20T15:00:00.000Z',
            ends_at: '2026-10-20T15:30:00.000Z',
            status: 'confirmed',
            answers: {},
          },
        ] as never[],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'rem:reschedule' })
      await send(db, rec, { replyId: last(rec).ids[0] }) // día
      await send(db, rec, { replyId: last(rec).ids[0] }) // hora
      await send(db, rec, { replyId: 'act:confirm' })

      expect(last(rec).bodyText).toContain('Quedó reprogramado')
      expect(activeSteps(db)).toEqual([])
      expect(marketingRows(db)).toHaveLength(0)
    })

    it('una cuenta sin el módulo no pregunta ni guarda nada', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const agenda = { modules: ['agenda' as const] }
      await send(db, rec, { text: 'Hola' }, agenda)
      await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) }, agenda)
      await send(db, rec, { replyId: last(rec).ids[0] }, agenda)
      await send(db, rec, { replyId: last(rec).ids[0] }, agenda)
      await send(db, rec, { replyId: 'act:confirm' }, agenda)

      expect(last(rec).bodyText).toContain('Quedó agendado')
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(activeSteps(db)).toEqual([])
    })
  })

  describe('si algo falla', () => {
    it('un "sí" que no se pudo guardar no promete avisos: se vuelve a pedir', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = newPatientDb()
      const rec = makeRecorder()
      await bookOnce(db, rec)

      db._failNext('insert', 'clinic_consents', { message: 'timeout' })
      await send(db, rec, { replyId: 'act:mkt_yes' })

      expect(marketingRows(db)).toHaveLength(0)
      expect(rec.calls.some((c) => c.bodyText === texts.marketingThanksYes)).toBe(false)
      expect(rec.calls.at(-2)?.bodyText).toBe(texts.consentError)
      expect(last(rec).bodyText).toBe(texts.marketingBody)
      expect(activeSteps(db)).toEqual(['marketing_consent'])

      // Otro toque, ya sin el fallo, sí queda.
      await send(db, rec, { replyId: 'act:mkt_yes' })
      expect(marketingRows(db)).toMatchObject([{ granted: true }])
      expect(last(rec).bodyText).toBe(texts.marketingThanksYes)
    })

    it('un "no" que no se pudo guardar no cambia nada: sin permiso no se le escribe', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = newPatientDb()
      const rec = makeRecorder()
      await bookOnce(db, rec)

      db._failNext('insert', 'clinic_consents', { message: 'timeout' })
      await send(db, rec, { replyId: 'act:mkt_no' })

      expect(marketingRows(db)).toHaveLength(0)
      expect(last(rec).bodyText).toBe(texts.marketingThanksNo)
      expect(activeSteps(db)).toEqual([])
    })

    it('si la pregunta no se puede enviar, la cita sigue y no queda una sesión colgada', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = newPatientDb()
      const rec = makeRecorder()
      const sendButtons = rec.sender.sendButtons
      rec.sender.sendButtons = async (args) => {
        if (args.bodyText === texts.marketingBody) throw new Error('Meta rechazó el envío')
        return sendButtons(args)
      }

      await bookOnce(db, rec)

      expect(db._tables.booking_appointments).toHaveLength(1)
      expect(last(rec).bodyText).toContain('Quedó agendado')
      expect(activeSteps(db)).toEqual([])
    })
  })
})
