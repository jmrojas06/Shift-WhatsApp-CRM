import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyAlert } from '@/lib/ops/alert'
import { followupPayload, ratingPayload } from '@/modules/clinica/followups'
import { buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  LOCATION,
  OWNER,
  SERVICE_LIMPIEZA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import type { FakeDb, Row } from './testing/fake-db'

// ============================================================
// Respuestas del bot a los botones de los seguimientos (§7.4 del diseño de
// las Fases 2 y 3): `fu:<acción>:<id>` y `rt:<valor>:<id>`. Son la respuesta a
// un mensaje del sistema: se atienden aunque una persona lleve el hilo, y un id
// que no es de la cuenta o del contacto se ignora sin responder.
// ============================================================

vi.mock('@/lib/ai/config', () => ({ loadAiConfig: vi.fn() }))
vi.mock('@/lib/ops/alert', () => ({ notifyAlert: vi.fn(async () => {}) }))

beforeEach(() => {
  vi.mocked(notifyAlert).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const texts = buildClinicTexts(DEFAULT_LABELS)
const AGENT = 'user-agent'
const APPT = 'ap-1'
const REVIEW_URL = 'https://g.page/r/clinica-sonrisa/review'

const FU_CARE = '11111111-1111-4111-8111-111111111111'
const FU_HOW = '22222222-2222-4222-8222-222222222222'
const FU_RATE = '33333333-3333-4333-8333-333333333333'
const FU_OTHER_ACCOUNT = '44444444-4444-4444-8444-444444444444'
const FU_OTHER_CONTACT = '55555555-5555-4555-8555-555555555555'

const followup = (over: Row): Row => ({
  account_id: ACCOUNT,
  appointment_id: APPT,
  contact_id: CONTACT,
  due_at: '2026-10-18T15:00:00.000Z',
  status: 'sent',
  attempts: 1,
  skip_reason: null,
  response: null,
  sent_at: '2026-10-18T15:00:00.000Z',
  responded_at: null,
  created_at: '2026-10-17T15:00:00.000Z',
  ...over,
})

const appointment = (over: Row = {}): Row => ({
  id: APPT,
  account_id: ACCOUNT,
  contact_id: CONTACT,
  service_id: SERVICE_LIMPIEZA,
  staff_id: STAFF_ANA,
  location_id: LOCATION,
  starts_at: '2026-10-17T15:00:00.000Z',
  ends_at: '2026-10-17T15:30:00.000Z',
  status: 'completed',
  answers: {},
  ...over,
})

/** Una clínica con una visita atendida y sus tres seguimientos enviados. */
function visitDb(extra: Record<string, Row[]> = {}): FakeDb {
  const db = clinicDb({
    clinic_consents: [grantedConsent()],
    booking_appointments: [appointment()],
    clinic_followups: [
      followup({ id: FU_CARE, kind: 'cuidados' }),
      followup({ id: FU_HOW, kind: 'como_sigues' }),
      followup({ id: FU_RATE, kind: 'calificacion' }),
      // De otra cuenta y de otro contacto de esta misma cuenta.
      followup({ id: FU_OTHER_ACCOUNT, kind: 'como_sigues', account_id: 'acc-2' }),
      followup({ id: FU_OTHER_CONTACT, kind: 'como_sigues', contact_id: 'ct-2' }),
    ],
    clinic_ratings: [],
    ...extra,
  })
  db._tables.booking_services[0].aftercare_instructions = 'No comas por 2 horas.'
  return db
}

/** Una persona lleva el hilo: asignado a un agente y con el bot en pausa. */
function humanThread(db: FakeDb, assignee: string | null = AGENT) {
  db._tables.conversations[0].assigned_agent_id = assignee
  db._tables.conversations[0].ai_autoreply_disabled = true
}

const row = (db: FakeDb, id: string) =>
  db._tables.clinic_followups.find((r) => r.id === id) as Row
const conversation = (db: FakeDb) => db._tables.conversations[0]
const bodies = (rec: ReturnType<typeof makeRecorder>) => rec.calls.map((c) => c.bodyText)

/** Nada se escribió ni se avisó: el toque se ignoró en silencio. */
function expectIgnored(db: FakeDb, rec: ReturnType<typeof makeRecorder>, result: unknown) {
  expect(result).toEqual({ consumed: true })
  expect(rec.calls).toEqual([])
  expect(db._tables.clinic_ratings).toEqual([])
  expect(db._tables.notifications).toEqual([])
  expect(conversation(db).ai_autoreply_disabled).toBe(false)
  for (const r of db._tables.clinic_followups) {
    expect(r.response).toBeNull()
    expect(r.responded_at).toBeNull()
  }
}

describe('fu:cuidados', () => {
  it('manda las instrucciones de cuidado del servicio de esa visita', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('cuidados', FU_CARE) })

    expect(result).toEqual({ consumed: true })
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].kind).toBe('text')
    expect(rec.calls[0].bodyText).toBe(texts.followupCareReply('No comas por 2 horas.'))
    expect(rec.calls[0].bodyText).toContain('No comas por 2 horas.')
    // Ver las recomendaciones no es contestar nada: no se guarda ni se avisa.
    expect(row(db, FU_CARE).response).toBeNull()
    expect(db._tables.notifications).toEqual([])
    expect(conversation(db).ai_autoreply_disabled).toBe(false)
  })

  it('el servicio sin instrucciones (se borraron después) no deja al paciente sin respuesta', async () => {
    const db = visitDb()
    db._tables.booking_services[0].aftercare_instructions = null
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('cuidados', FU_CARE) })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)).toEqual([texts.followupCareNone])
    expect(conversation(db).ai_autoreply_disabled).toBe(false)
  })

  it('instrucciones de otro servicio u otra cuenta no se mezclan', async () => {
    const db = visitDb()
    db._tables.booking_services[1].aftercare_instructions = 'Esto es de Urgencia.'
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('cuidados', FU_CARE) })

    expect(rec.calls[0].bodyText).not.toContain('Urgencia')
  })
})

describe('fu:bien', () => {
  it('agradece, guarda la respuesta y no avisa a nadie', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)).toEqual(['¡Qué bueno! Cualquier cosa, escríbenos por aquí.'])
    expect(row(db, FU_HOW)).toMatchObject({ response: 'bien', responded_at: '2026-10-19T13:00:00.000Z' })
    expect(db._tables.notifications).toEqual([])
    // El bot no se pausa: sigue atendiendo.
    expect(conversation(db).ai_autoreply_disabled).toBe(false)
  })

  it('sigue siendo "bien" si se toca dos veces', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })
    await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })

    expect(row(db, FU_HOW).response).toBe('bien')
    expect(rec.calls).toHaveLength(2)
  })
})

describe.each([['molestias'], ['ayuda']] as const)('fu:%s', (action) => {
  it('guarda la respuesta, pasa el hilo a una persona y avisa al dueño', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload(action, FU_HOW) })

    expect(result).toEqual({ consumed: true })
    expect(row(db, FU_HOW)).toMatchObject({ response: action, responded_at: '2026-10-19T13:00:00.000Z' })
    // El mismo pase que "Hablar con una persona": bot en pausa, nota y etiqueta.
    expect(conversation(db)).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_summary: texts.followupTroubleNote,
    })
    expect(db._tables.tags.map((t) => t.name)).toContain('quiere-humano')
    expect(db._tables.notifications).toMatchObject([
      {
        user_id: OWNER,
        conversation_id: CONVERSATION,
        contact_id: CONTACT,
        title: texts.followupTroubleNotificationTitle,
        body: texts.followupTroubleNotificationBody('Marta Ruiz'),
      },
    ])
  })

  it('le dice que se avisó al equipo y le repite los signos de alarma de la clínica', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload(action, FU_HOW) })

    expect(bodies(rec)).toEqual([
      'Le avisamos al equipo para que te contacten pronto.\n\nSignos de alarma',
    ])
  })

  it('con agente de pase configurado, se lo asigna y le llega el aviso también', async () => {
    const db = visitDb({ ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: AGENT }] })
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload(action, FU_HOW) })

    expect(conversation(db).assigned_agent_id).toBe(AGENT)
    expect(db._tables.notifications.map((n) => n.user_id).sort()).toEqual([AGENT, OWNER].sort())
    for (const n of db._tables.notifications) {
      expect(n.title).toBe(texts.followupTroubleNotificationTitle)
    }
  })

  it('aunque no se pueda guardar la respuesta, el paciente y el equipo se enteran', async () => {
    const db = visitDb()
    const rec = makeRecorder()
    db._failNext('update', 'clinic_followups', { message: 'base caída' })

    const result = await send(db, rec, { replyId: followupPayload(action, FU_HOW) })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)[0]).toContain('Le avisamos al equipo')
    expect(conversation(db).ai_autoreply_disabled).toBe(true)
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('sin la configuración de la clínica usa los signos de alarma de siempre', async () => {
    const db = visitDb()
    db._tables.clinic_settings.length = 0
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload(action, FU_HOW) })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)[0]).toContain('Ve a urgencias ahora si tienes dificultad para respirar')
    expect(conversation(db).ai_autoreply_disabled).toBe(true)
  })
})

describe('una respuesta que cambia', () => {
  it('"bien" y después "molestias": queda la peor, y el equipo se entera', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })
    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })

    expect(row(db, FU_HOW).response).toBe('molestias')
    expect(conversation(db).ai_autoreply_disabled).toBe(true)
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('"molestias" y después "ayuda": sube a ayuda', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })
    await send(db, rec, { replyId: followupPayload('ayuda', FU_HOW) }, { humanOwned: true })

    expect(row(db, FU_HOW).response).toBe('ayuda')
  })

  it('"molestias" y después "bien": no se borra la queja', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })
    await send(db, rec, { replyId: followupPayload('bien', FU_HOW) }, { humanOwned: true })

    expect(row(db, FU_HOW).response).toBe('molestias')
    // Igual se le agradece.
    expect(bodies(rec).at(-1)).toBe(texts.followupWellReply)
  })
})

describe('rt:<valor>', () => {
  it.each(['bien', 'regular', 'mal'] as const)('"%s": guarda la calificación con su visita y sede', async (value) => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: ratingPayload(value, FU_RATE) })

    expect(result).toEqual({ consumed: true })
    expect(db._tables.clinic_ratings).toMatchObject([
      {
        account_id: ACCOUNT,
        appointment_id: APPT,
        contact_id: CONTACT,
        location_id: LOCATION,
        value,
        followup_id: FU_RATE,
      },
    ])
    expect(db._tables.clinic_ratings[0].id).toEqual(expect.any(String))
    expect(row(db, FU_RATE).responded_at).toBe('2026-10-19T13:00:00.000Z')
    // La calificación no usa `response` ("bien" | "molestias" | "ayuda").
    expect(row(db, FU_RATE).response).toBeNull()
    // Es una calificación: el bot no se pausa.
    expect(conversation(db).ai_autoreply_disabled).toBe(false)
  })

  it('sin enlace de Google, solo agradece', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })

    expect(bodies(rec)).toEqual(['¡Gracias por contarnos!'])
  })

  it.each(['bien', 'regular', 'mal'] as const)(
    'con enlace de Google, se lo manda a todos, también a quien calificó "%s"',
    async (value) => {
      const db = visitDb()
      db._tables.clinic_locations[0].google_review_url = `  ${REVIEW_URL}  `
      const rec = makeRecorder()

      await send(db, rec, { replyId: ratingPayload(value, FU_RATE) })

      expect(bodies(rec)).toEqual([
        `¡Gracias por contarnos! Si quieres, déjanos tu opinión en Google: ${REVIEW_URL}`,
      ])
    },
  )

  it('el enlace es el de la sede de la visita, no el de otra', async () => {
    const db = visitDb()
    db._tables.clinic_locations[0].google_review_url = null
    db._tables.clinic_locations.push({
      id: 'loc-2',
      account_id: ACCOUNT,
      name: 'Norte',
      is_active: true,
      created_at: '2026-02-01T00:00:00.000Z',
      google_review_url: 'https://g.page/r/otra-sede',
    })
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })

    expect(bodies(rec)).toEqual(['¡Gracias por contarnos!'])
  })

  it('una visita sin sede usa la sede activa de la clínica', async () => {
    const db = visitDb()
    db._tables.booking_appointments[0].location_id = null
    db._tables.clinic_locations[0].google_review_url = REVIEW_URL
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })

    expect(bodies(rec)).toEqual([
      `¡Gracias por contarnos! Si quieres, déjanos tu opinión en Google: ${REVIEW_URL}`,
    ])
    expect(db._tables.clinic_ratings[0].location_id).toBeNull()
  })

  it.each(['pendiente', 'N/A', 'javascript:alert(1)', '   '])(
    'un enlace que no es una dirección web ("%s") no se manda',
    async (url) => {
      const db = visitDb()
      db._tables.clinic_locations[0].google_review_url = url
      const rec = makeRecorder()

      await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })

      expect(bodies(rec)).toEqual(['¡Gracias por contarnos!'])
    },
  )

  it('una calificación repetida se guarda una sola vez, pero se agradece igual', async () => {
    const db = visitDb()
    db._tables.clinic_locations[0].google_review_url = REVIEW_URL
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })
    const again = await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })

    expect(again).toEqual({ consumed: true })
    // La primera manda: ni se duplica ni se cambia.
    expect(db._tables.clinic_ratings).toHaveLength(1)
    expect(db._tables.clinic_ratings[0].value).toBe('bien')
    expect(bodies(rec)).toHaveLength(2)
    expect(bodies(rec)[1]).toBe(bodies(rec)[0])
  })

  it('si la calificación no se pudo guardar, no se da por guardada ni se agradece', async () => {
    const db = visitDb()
    const rec = makeRecorder()
    db._failNext('upsert', 'clinic_ratings', { message: 'base caída' })

    await expect(send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })).rejects.toThrow()

    expect(db._tables.clinic_ratings).toEqual([])
    expect(rec.calls).toEqual([])
    expect(db._tables.notifications).toEqual([])
    expect(row(db, FU_RATE).responded_at).toBeNull()
  })
})

describe('Regular y Mal avisan al dueño', () => {
  it.each(['regular', 'mal'] as const)('"%s": aviso al dueño para que alguien llame', async (value) => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload(value, FU_RATE) })

    expect(db._tables.notifications).toMatchObject([
      {
        user_id: OWNER,
        conversation_id: CONVERSATION,
        contact_id: CONTACT,
        title: texts.followupLowRatingNotificationTitle(value),
        body: texts.followupLowRatingNotificationBody('Marta Ruiz', value),
      },
    ])
    // Solo avisa: el hilo sigue con el bot.
    expect(conversation(db).ai_autoreply_disabled).toBe(false)
  })

  it('"bien" no avisa a nadie', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })

    expect(db._tables.notifications).toEqual([])
  })

  it('la calificación repetida no vuelve a avisar', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })
    await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })

    expect(db._tables.notifications).toHaveLength(1)
    expect(bodies(rec)).toHaveLength(2)
  })

  it('si el aviso no se puede guardar, igual se agradece y la calificación queda', async () => {
    const db = visitDb()
    const rec = makeRecorder()
    db._failNext('insert', 'notifications', { message: 'base caída' })

    const result = await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)).toEqual(['¡Gracias por contarnos!'])
    expect(db._tables.clinic_ratings).toHaveLength(1)
  })
})

describe('un hilo que lleva una persona', () => {
  it('fu:cuidados se atiende', async () => {
    const db = visitDb()
    humanThread(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('cuidados', FU_CARE) }, { humanOwned: true })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)).toEqual([texts.followupCareReply('No comas por 2 horas.')])
  })

  it('fu:bien se atiende', async () => {
    const db = visitDb()
    humanThread(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('bien', FU_HOW) }, { humanOwned: true })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)).toEqual([texts.followupWellReply])
    expect(row(db, FU_HOW).response).toBe('bien')
  })

  it('rt:mal se atiende: se guarda, se agradece y se avisa al dueño', async () => {
    const db = visitDb()
    humanThread(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) }, { humanOwned: true })

    expect(result).toEqual({ consumed: true })
    expect(db._tables.clinic_ratings).toHaveLength(1)
    expect(bodies(rec)).toEqual(['¡Gracias por contarnos!'])
    expect(db._tables.notifications.map((n) => n.user_id)).toEqual([OWNER])
  })

  it('fu:molestias avisa al asignado y al dueño, sin quitarle el hilo a la persona', async () => {
    const db = visitDb({ ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: 'user-otro' }] })
    humanThread(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) }, { humanOwned: true })

    expect(result).toEqual({ consumed: true })
    expect(row(db, FU_HOW).response).toBe('molestias')
    // El hilo sigue con quien lo llevaba: no se reasigna al agente de pase.
    expect(conversation(db).assigned_agent_id).toBe(AGENT)
    expect(db._tables.notifications.map((n) => n.user_id).sort()).toEqual([AGENT, OWNER].sort())
    for (const n of db._tables.notifications) {
      expect(n).toMatchObject({
        conversation_id: CONVERSATION,
        contact_id: CONTACT,
        title: texts.followupTroubleNotificationTitle,
        body: texts.followupTroubleNotificationBody('Marta Ruiz'),
      })
    }
    expect(bodies(rec)).toEqual(['Le avisamos al equipo para que te contacten pronto.\n\nSignos de alarma'])
  })

  it('fu:ayuda con el bot en pausa y nadie asignado avisa al dueño', async () => {
    const db = visitDb()
    humanThread(db, null)
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('ayuda', FU_HOW) }, { humanOwned: true })

    expect(db._tables.notifications.map((n) => n.user_id)).toEqual([OWNER])
    expect(row(db, FU_HOW).response).toBe('ayuda')
  })

  it('si la persona es también el dueño, recibe un solo aviso', async () => {
    const db = visitDb()
    humanThread(db, OWNER)
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) }, { humanOwned: true })

    expect(db._tables.notifications).toHaveLength(1)
  })

  it('un paciente que insiste no llena la bandeja: un aviso cada 10 minutos, pero siempre la respuesta', async () => {
    const db = visitDb()
    humanThread(db)
    const rec = makeRecorder()
    const tap = { replyId: followupPayload('ayuda', FU_HOW) }

    await send(db, rec, tap, { humanOwned: true })
    await send(db, rec, tap, { humanOwned: true, now: new Date('2026-10-19T13:05:00Z') })
    expect(db._tables.notifications).toHaveLength(2) // dueño + asignado, una sola vez
    expect(bodies(rec)).toHaveLength(2)

    // Pasados los 10 minutos, vuelve a avisar.
    await send(db, rec, tap, { humanOwned: true, now: new Date('2026-10-19T13:20:00Z') })
    expect(db._tables.notifications).toHaveLength(4)
    expect(bodies(rec)).toHaveLength(3)
  })

  it('si el aviso no se puede guardar, el paciente igual recibe la respuesta y se alerta al equipo técnico', async () => {
    const db = visitDb()
    humanThread(db, null)
    const rec = makeRecorder()
    db._failNext('insert', 'notifications', { message: 'base caída' })

    const result = await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) }, { humanOwned: true })

    expect(result).toEqual({ consumed: true })
    expect(bodies(rec)[0]).toContain('Le avisamos al equipo')
    expect(notifyAlert).toHaveBeenCalledTimes(1)
    const alert = vi.mocked(notifyAlert).mock.calls[0][0]
    expect(alert).toContain(ACCOUNT)
    expect(alert).toContain(CONVERSATION)
    expect(alert).not.toContain('Marta')
    expect(alert).not.toContain('573001112233')
  })
})

describe('un seguimiento que no es de este paciente se ignora en silencio', () => {
  const taps: [string, (id: string) => string][] = [
    ['fu:cuidados', (id) => followupPayload('cuidados', id)],
    ['fu:bien', (id) => followupPayload('bien', id)],
    ['fu:molestias', (id) => followupPayload('molestias', id)],
    ['fu:ayuda', (id) => followupPayload('ayuda', id)],
    ['rt:bien', (id) => ratingPayload('bien', id)],
    ['rt:mal', (id) => ratingPayload('mal', id)],
  ]

  describe.each(taps)('%s', (_name, payload) => {
    it.each([
      ['de otra cuenta', FU_OTHER_ACCOUNT],
      ['de otro contacto de la misma cuenta', FU_OTHER_CONTACT],
      ['que no existe', '99999999-9999-4999-8999-999999999999'],
      ['con un id que ni siquiera es un uuid', 'no-es-un-uuid'],
    ])('%s', async (_label, id) => {
      const db = visitDb()
      const rec = makeRecorder()

      const result = await send(db, rec, { replyId: payload(id) })

      expectIgnored(db, rec, result)
    })

    it('también en un hilo que lleva una persona', async () => {
      const db = visitDb()
      const rec = makeRecorder()

      const result = await send(db, rec, { replyId: payload(FU_OTHER_CONTACT) }, { humanOwned: true })

      expect(result).toEqual({ consumed: true })
      expect(rec.calls).toEqual([])
      expect(db._tables.notifications).toEqual([])
      expect(db._tables.clinic_ratings).toEqual([])
    })
  })

  it('un seguimiento de otro tipo (un botón de "¿cómo sigues?" con el id de la calificación) tampoco cuenta', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('molestias', FU_RATE) })

    expectIgnored(db, rec, result)
  })

  it('ni una calificación con el id del "¿cómo sigues?"', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: ratingPayload('mal', FU_HOW) })

    expectIgnored(db, rec, result)
  })

  it('un error al leer el seguimiento no se confunde con "no es de este paciente"', async () => {
    const db = visitDb()
    const rec = makeRecorder()
    db._failNext('select', 'clinic_followups', { message: 'base caída' })

    await expect(send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })).rejects.toThrow()

    expect(rec.calls).toEqual([])
  })
})

describe('cuentas sin el módulo clínica', () => {
  it('un id fu:/rt: no es nada: el mensaje no se consume ni se escribe', async () => {
    const db = visitDb()
    const rec = makeRecorder()

    const result = await send(
      db,
      rec,
      { replyId: ratingPayload('mal', FU_RATE) },
      { modules: ['agenda'] },
    )

    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toEqual([])
    expect(db._tables.clinic_ratings).toEqual([])
  })
})

describe('con una sesión de reserva abierta', () => {
  it('"bien" no la toca', async () => {
    const db = visitDb()
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:book' })
    expect(db._tables.booking_sessions.filter((s) => s.status === 'active')).toHaveLength(1)

    await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })

    expect(db._tables.booking_sessions.filter((s) => s.status === 'active')).toHaveLength(1)
    expect(bodies(rec).at(-1)).toBe(texts.followupWellReply)
  })

  it('"molestias" la cierra: el hilo pasa a una persona', async () => {
    const db = visitDb()
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:book' })

    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })

    expect(db._tables.booking_sessions.filter((s) => s.status === 'active')).toHaveLength(0)
    expect(conversation(db).ai_autoreply_disabled).toBe(true)
  })
})

// ============================================================
// Autorización de datos: la calificación y la respuesta de "¿cómo sigues?" son datos
// de salud ligados a una visita. Con un NO vigente (rechazó o revocó), o sin poder
// leer la decisión, no se guarda nada; el paciente recibe su respuesta igual, y quien
// reporta molestias o pide ayuda llega a una persona.
// ============================================================

/** Reemplaza las autorizaciones de la cuenta de prueba por estas. */
function setConsents(db: FakeDb, rows: Row[]) {
  db._tables.clinic_consents.splice(0, db._tables.clinic_consents.length, ...rows)
}

/** Una autorización de datos sensibles de la cuenta de prueba, con estos cambios. */
const consent = (over: Row): Row => ({ ...grantedConsent(), ...over })

const NO_STORING_CASES: [string, (db: FakeDb) => void][] = [
  [
    'la revocó después de aceptar',
    (db) =>
      setConsents(db, [
        grantedConsent(),
        consent({ id: 'cons-2', granted: false, created_at: '2026-10-10T00:00:00.000Z' }),
      ]),
  ],
  [
    'la rechazó desde el principio',
    (db) => setConsents(db, [{ ...grantedConsent(), granted: false }]),
  ],
  [
    'no se pudo leer la decisión',
    (db) => db._failNext('select', 'clinic_consents', { message: 'base caída' }),
  ],
]

/** Nada del paciente quedó guardado: ni calificación, ni respuesta, ni marca de respondido. */
function expectNothingStored(db: FakeDb) {
  expect(db._tables.clinic_ratings).toEqual([])
  for (const r of db._tables.clinic_followups) {
    expect(r.response).toBeNull()
    expect(r.responded_at).toBeNull()
  }
}

describe.each(NO_STORING_CASES)('sin autorización para guardar: %s', (_label, setup) => {
  it('rt:mal no se guarda ni avisa al dueño, pero se agradece con el enlace de Google', async () => {
    const db = visitDb()
    db._tables.clinic_locations[0].google_review_url = REVIEW_URL
    setup(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })

    expect(result).toEqual({ consumed: true })
    expectNothingStored(db)
    // Ni siquiera el aviso de una calificación baja: llevaría el nombre y lo que contestó.
    expect(db._tables.notifications).toEqual([])
    expect(conversation(db).ai_autoreply_disabled).toBe(false)
    expect(bodies(rec)).toEqual([
      `¡Gracias por contarnos! Si quieres, déjanos tu opinión en Google: ${REVIEW_URL}`,
    ])
  })

  it('rt:bien tampoco se guarda y, sin enlace de Google, solo agradece', async () => {
    const db = visitDb()
    setup(db)
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })

    expectNothingStored(db)
    expect(bodies(rec)).toEqual(['¡Gracias por contarnos!'])
  })

  it('fu:bien se contesta, pero no se guarda', async () => {
    const db = visitDb()
    setup(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })

    expect(result).toEqual({ consumed: true })
    expectNothingStored(db)
    expect(bodies(rec)).toEqual([texts.followupWellReply])
    expect(db._tables.notifications).toEqual([])
  })

  it('fu:cuidados manda las instrucciones igual (no guarda nada)', async () => {
    const db = visitDb()
    setup(db)
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: followupPayload('cuidados', FU_CARE) })

    expect(result).toEqual({ consumed: true })
    expectNothingStored(db)
    expect(bodies(rec)).toEqual([texts.followupCareReply('No comas por 2 horas.')])
  })

  describe.each([['molestias'], ['ayuda']] as const)('fu:%s', (action) => {
    it('no guarda la respuesta, pero pasa el hilo a una persona y avisa al dueño', async () => {
      const db = visitDb()
      setup(db)
      const rec = makeRecorder()

      const result = await send(db, rec, { replyId: followupPayload(action, FU_HOW) })

      expect(result).toEqual({ consumed: true })
      expectNothingStored(db)
      expect(conversation(db)).toMatchObject({
        ai_autoreply_disabled: true,
        ai_handoff_summary: texts.followupTroubleNote,
      })
      expect(db._tables.tags.map((t) => t.name)).toContain('quiere-humano')
      expect(db._tables.notifications).toMatchObject([
        {
          user_id: OWNER,
          conversation_id: CONVERSATION,
          title: texts.followupTroubleNotificationTitle,
          body: texts.followupTroubleNotificationBody('Marta Ruiz'),
        },
      ])
      // Y le dice que se avisó al equipo, con los signos de alarma.
      expect(bodies(rec)).toEqual([
        'Le avisamos al equipo para que te contacten pronto.\n\nSignos de alarma',
      ])
    })

    it('en un hilo que lleva una persona, se le avisa a ella y al dueño sin guardar nada', async () => {
      const db = visitDb()
      humanThread(db)
      setup(db)
      const rec = makeRecorder()

      const tap = { replyId: followupPayload(action, FU_HOW) }

      const result = await send(db, rec, tap, { humanOwned: true })

      expect(result).toEqual({ consumed: true })
      expectNothingStored(db)
      expect(conversation(db).assigned_agent_id).toBe(AGENT)
      expect(db._tables.notifications.map((n) => n.user_id).sort()).toEqual([AGENT, OWNER].sort())
      expect(bodies(rec)).toEqual([
        'Le avisamos al equipo para que te contacten pronto.\n\nSignos de alarma',
      ])
    })
  })
})

describe('la lectura de la autorización', () => {
  it('si falla, se registra sin datos del paciente', async () => {
    const db = visitDb()
    db._failNext('select', 'clinic_consents', { message: 'base caída' })
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('mal', FU_RATE) })

    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('autorización')
    expect(logged).not.toContain('Marta')
    expect(logged).not.toContain('573001112233')
  })

  it('una nueva aceptación después de revocar vuelve a permitir guardar', async () => {
    const db = visitDb()
    setConsents(db, [
      grantedConsent(),
      consent({ id: 'cons-2', granted: false, created_at: '2026-10-10T00:00:00.000Z' }),
      consent({ id: 'cons-3', granted: true, created_at: '2026-10-12T00:00:00.000Z' }),
    ])
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('bien', FU_RATE) })
    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })

    expect(db._tables.clinic_ratings).toHaveLength(1)
    expect(row(db, FU_HOW).response).toBe('molestias')
  })

  it('el NO de otro contacto o de mercadeo no es el NO de este paciente', async () => {
    const db = visitDb()
    setConsents(db, [
      grantedConsent(),
      consent({
        id: 'cons-2',
        contact_id: 'ct-2',
        granted: false,
        created_at: '2026-10-10T00:00:00.000Z',
      }),
      consent({
        id: 'cons-3',
        kind: 'mercadeo',
        granted: false,
        created_at: '2026-10-11T00:00:00.000Z',
      }),
    ])
    const rec = makeRecorder()

    await send(db, rec, { replyId: followupPayload('bien', FU_HOW) })

    expect(row(db, FU_HOW).response).toBe('bien')
  })

  it('sin ninguna fila (visita sin autorización declarada) no es un NO: se guarda como siempre', async () => {
    const db = visitDb()
    setConsents(db, [])
    const rec = makeRecorder()

    await send(db, rec, { replyId: ratingPayload('regular', FU_RATE) })
    await send(db, rec, { replyId: followupPayload('molestias', FU_HOW) })

    expect(db._tables.clinic_ratings).toHaveLength(1)
    expect(row(db, FU_HOW).response).toBe('molestias')
  })
})
