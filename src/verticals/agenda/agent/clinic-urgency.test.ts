import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyAlert } from '@/lib/ops/alert'
import { buildClinicTexts, DEFAULT_URGENCY_ALARM_TEXT, DEFAULT_URGENCY_WORDS } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { AGENDA_AGENT_TEXTS } from '../texts'
import type { ClinicBackend } from './backend'
import { formatLongDate } from './format'
import { createInternalBackend } from './internal-backend'
import { newBookingState } from './state'
import { handleClinicChoice, type ClinicStepCtx } from './steps/clinic-steps'
import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  OWNER,
  SERVICE_LIMPIEZA,
  SERVICE_URGENCIA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import { asClient, type FakeDb, type Row } from './testing/fake-db'

// La alerta de respaldo no sale a ningún lado: solo se mira si se pidió.
vi.mock('@/lib/ops/alert', () => ({ notifyAlert: vi.fn(async () => {}) }))

beforeEach(() => {
  vi.mocked(notifyAlert).mockClear()
})

const texts = buildClinicTexts(DEFAULT_LABELS)

/** El texto de signos de alarma que trae la clínica de las pruebas. */
const ALARM_TEXT = 'Signos de alarma'

/** Sábado 24 de octubre: sin horario. */
const SATURDAY = new Date('2026-10-24T13:00:00Z')

/** Lunes 19, 13:00 en Bogotá: ya pasó el horario de la mañana (09:00 a 12:00). */
const AFTER_HOURS = new Date('2026-10-19T18:00:00Z')

const ALARM_BUTTONS = ['act:alarm_yes', 'act:alarm_no']
const AGENT = 'user-agent'

const session = (state: Record<string, unknown>): Row => ({
  id: 'ses-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: { mode: 'book', options: [], fails: 0, ...state },
})

const activeStates = (db: FakeDb) =>
  db._tables.booking_sessions
    .filter((s) => s.status === 'active')
    .map((s) => s.state as { step: string; fails: number; urgent?: boolean })

const activeSteps = (db: FakeDb) => activeStates(db).map((s) => s.step)

/** Los avisos de confirmación (más graves). El primero, al abrir los signos, es de clinic-urgency-notice.test.ts. */
const priorityNotifications = (db: FakeDb) =>
  db._tables.notifications.filter((n) => n.title === texts.urgencyNotificationTitle)

/** Todo lo que el bot dijo, sin repetir. */
const said = (rec: ReturnType<typeof makeRecorder>) => [...new Set(rec.calls.map((c) => c.bodyText))]

/** Abre los signos de alarma como lo haría un paciente. */
async function withAlarmQuestion(db = clinicDb()) {
  const rec = makeRecorder()
  await send(db, rec, { text: 'urgencia' })
  expect(last(rec).ids).toEqual(ALARM_BUTTONS)
  return { db, rec }
}

describe('urgencias', () => {
  it('va antes de la autorización: nadie con dolor se queda en un aviso legal', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Tengo mucho dolor' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
    expect(last(rec).bodyText).toContain('Signos de alarma')
    expect(last(rec).ids).toEqual(ALARM_BUTTONS)
    expect(activeSteps(db)).toEqual(['urgency'])
    // Ni se pidió la autorización ni se registró nada.
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('con signos de alarma manda a urgencias, pausa el bot y avisa con prioridad', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'urgencia' })
    await send(db, rec, { replyId: 'act:alarm_yes' })
    expect(last(rec).bodyText).toContain('ve a urgencias')
    // Sin una palabra de más: ni medicamentos ni diagnóstico.
    expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyNote)
    expect(priorityNotifications(db)).toMatchObject([
      {
        user_id: OWNER,
        conversation_id: CONVERSATION,
        title: '🚨 Posible urgencia',
        body: texts.urgencyNotificationBody('Marta Ruiz'),
      },
    ])
    expect(activeSteps(db)).toEqual([])
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it('el aviso prioritario le llega al agente de pase y al dueño', async () => {
    const db = clinicDb({ ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: AGENT }] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'urgencia' })
    await send(db, rec, { replyId: 'act:alarm_yes' })
    expect(priorityNotifications(db).map((n) => n.user_id).sort()).toEqual([AGENT, OWNER].sort())
  })

  describe('sin signos de alarma', () => {
    it('sin autorización, la pide y luego ofrece la hora de hoy', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
      await send(db, rec, { replyId: 'act:consent_yes' })
      expect(last(rec).bodyText).toContain('nombre y los apellidos')
      await send(db, rec, { text: 'Marta Ruiz' })
      expect(last(rec).ids.length).toBeGreaterThan(0)
      expect(last(rec).ids.every((id) => id.startsWith('slot:'))).toBe(true)
      // Todas son de hoy (lunes 19 de octubre).
      expect(last(rec).ids.every((id) => id.startsWith('slot:2026-10-19T'))).toBe(true)
      expect(db._tables.clinic_consents).toMatchObject([{ granted: true }])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('con autorización no la vuelve a pedir: sigue con el paciente', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
      expect(db._tables.clinic_consents).toHaveLength(1)
      await send(db, rec, { text: 'Marta Ruiz' })
      expect(last(rec).ids.every((id) => id.startsWith('slot:'))).toBe(true)
    })

    it('"ninguno" escrito descarta los signos, igual que el botón', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { text: 'ninguno' })
      expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    })

    it('rechazar la autorización pasa a una persona, con el aviso prioritario', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      await send(db, rec, { replyId: 'act:consent_no' })
      expect(db._tables.clinic_consents).toMatchObject([{ granted: false }])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyConsentDeclinedNote)
      expect(last(rec).bodyText).toBe(texts.consentDeclined)
      expect(priorityNotifications(db)).toMatchObject([
        {
          user_id: OWNER,
          title: texts.urgencyNotificationTitle,
          body: texts.urgencyNotificationBody('Marta Ruiz'),
        },
      ])
      expect(activeSteps(db)).toEqual([])
    })

    it('dejar la autorización sin responder también: a la segunda pasa con el aviso prioritario', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      await send(db, rec, { text: 'ok' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(priorityNotifications(db)).toHaveLength(0)
      await send(db, rec, { text: 'ok' })
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyConsentUnansweredNote)
      expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
      expect(priorityNotifications(db)).toMatchObject([
        { user_id: OWNER, title: texts.urgencyNotificationTitle },
      ])
    })

    it('si la autorización no se puede guardar dos veces, también pasa con el aviso prioritario', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      db._failNext('insert', 'clinic_consents', { message: 'boom' })
      await send(db, rec, { replyId: 'act:consent_yes' })
      expect(rec.calls.at(-2)?.bodyText).toBe(texts.consentError)
      db._failNext('insert', 'clinic_consents', { message: 'boom' })
      await send(db, rec, { replyId: 'act:consent_yes' })
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyConsentUnansweredNote)
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('fuera de una urgencia, rechazar o no responder la autorización sigue con el aviso de siempre', async () => {
      const declined = clinicDb()
      const rec = makeRecorder()
      await send(declined, rec, { text: 'Hola' })
      await send(declined, rec, { replyId: 'act:consent_no' })
      expect(declined._tables.conversations[0].ai_handoff_summary).toBe(texts.consentDeclinedNote)
      expect(priorityNotifications(declined)).toHaveLength(0)
      expect(declined._tables.notifications).toMatchObject([
        { title: AGENDA_AGENT_TEXTS.handoffNotificationTitle },
      ])

      const unanswered = clinicDb()
      await send(unanswered, makeRecorder(), { text: 'Hola' })
      await send(unanswered, makeRecorder(), { text: 'ok' })
      await send(unanswered, makeRecorder(), { text: 'ok' })
      expect(unanswered._tables.conversations[0].ai_handoff_summary).toBe(texts.consentUnansweredNote)
      expect(priorityNotifications(unanswered)).toHaveLength(0)
    })

    it('con pacientes registrados los ofrece y, al elegir, salta a las horas de hoy', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: [
          { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).ids).toEqual(['pat:pat-1', 'pat:new'])
      await send(db, rec, { replyId: 'pat:pat-1' })
      // Salta el menú de servicios y el de días: es la hora de hoy.
      expect(last(rec).ids.every((id) => id.startsWith('slot:2026-10-19T'))).toBe(true)
      expect(activeStates(db)).toMatchObject([{ step: 'pick_slot', urgent: true }])
    })

    it('la reserva de urgencia llega hasta la cita, con el servicio de urgencia', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: [
          { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      await send(db, rec, { replyId: 'pat:pat-1' })
      await send(db, rec, { replyId: last(rec).ids[0] })
      await send(db, rec, { replyId: 'act:confirm' })
      expect(db._tables.booking_appointments).toMatchObject([
        { service_id: SERVICE_URGENCIA, staff_id: STAFF_ANA, patient_id: 'pat-1' },
      ])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })
  })

  describe('sin cupo hoy', () => {
    const expectHandedToAPerson = (db: FakeDb, rec: ReturnType<typeof makeRecorder>) => {
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyOffHoursNote)
      expect(priorityNotifications(db)).toMatchObject([
        { user_id: OWNER, body: texts.urgencyNotificationBody('Marta Ruiz') },
      ])
      expect(activeSteps(db)).toEqual([])
      expect(last(rec).ids).toEqual([])
    }

    it('da el teléfono de turno y pasa a una persona', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' }, { now: SATURDAY })
      await send(db, rec, { replyId: 'act:alarm_no' }, { now: SATURDAY })
      expect(last(rec).bodyText).toContain('3001234567')
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })

    it('sin teléfono de turno, avisa que la clínica le escribe', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      db._tables.clinic_locations[0].on_call_phone = null
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' }, { now: SATURDAY })
      await send(db, rec, { replyId: 'act:alarm_no' }, { now: SATURDAY })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours(null))
      expectHandedToAPerson(db, rec)
    })

    it('cuando ya pasó el horario de hoy', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' }, { now: AFTER_HOURS })
      await send(db, rec, { replyId: 'act:alarm_no' }, { now: AFTER_HOURS })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })

    it('cuando la agenda de hoy está llena', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_appointments: [
          {
            id: 'appt-full',
            account_id: ACCOUNT,
            staff_id: STAFF_ANA,
            status: 'confirmed',
            starts_at: '2026-10-19T14:00:00.000Z',
            ends_at: '2026-10-19T17:00:00.000Z',
          },
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })

    it('sin un servicio de urgencia configurado', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      db._tables.clinic_settings[0].urgency_service_id = null
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })

    it('con un servicio de urgencia que ya no está activo', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      db._tables.booking_services[1].is_active = false
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })

    it('si no se pueden leer las horas, no se queda callado: pasa a una persona', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const backend: ClinicBackend = {
        ...createInternalBackend({ db: asClient(db), accountId: ACCOUNT }),
        getDaySlots: async () => {
          throw new Error('el conector no responde')
        },
      }
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' }, { backend })
      const result = await send(db, rec, { replyId: 'act:alarm_no' }, { backend })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })

    it('sin autorización, mira el cupo ANTES de pedirla: sin cupo no hay texto legal', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' }, { now: SATURDAY })
      await send(db, rec, { replyId: 'act:alarm_no' }, { now: SATURDAY })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expect(rec.calls.some((c) => c.ids.includes('act:consent_yes'))).toBe(false)
      expect(rec.calls.some((c) => c.bodyText === 'Texto de autorización')).toBe(false)
      expect(db._tables.clinic_consents).toHaveLength(0)
      expectHandedToAPerson(db, rec)
    })

    it('sin autorización y con cupo, la pide después', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      expect(last(rec).bodyText).toBe('Texto de autorización')
    })

    it('si el cupo se acaba mientras decide la autorización, pasa a una persona', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      db._tables.booking_appointments.push({
        id: 'appt-full',
        account_id: ACCOUNT,
        staff_id: STAFF_ANA,
        status: 'confirmed',
        starts_at: '2026-10-19T14:00:00.000Z',
        ends_at: '2026-10-19T17:00:00.000Z',
      })
      await send(db, rec, { replyId: 'act:consent_yes' })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expectHandedToAPerson(db, rec)
    })
  })

  describe('una reserva de urgencia en curso', () => {
    const PATIENT = { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' }
    const FULL_DAY = {
      id: 'appt-full',
      account_id: ACCOUNT,
      staff_id: STAFF_ANA,
      status: 'confirmed',
      starts_at: '2026-10-19T14:00:00.000Z',
      ends_at: '2026-10-19T17:00:00.000Z',
    }

    /** Sin signos, con paciente elegido: está viendo las horas de hoy. */
    async function atTodaysHours() {
      const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: [PATIENT] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      await send(db, rec, { replyId: 'pat:pat-1' })
      expect(last(rec).ids.every((id) => id.startsWith('slot:'))).toBe(true)
      return { db, rec }
    }

    const offeredDays = (rec: ReturnType<typeof makeRecorder>) =>
      rec.calls.some((c) => c.ids.some((id) => id.startsWith('day:')))

    it('si la hora elegida se ocupó y no queda ninguna hoy, pasa a una persona, no al menú de días', async () => {
      const { db, rec } = await atTodaysHours()
      const first = last(rec).ids[0]
      db._tables.booking_appointments.push(FULL_DAY)
      await send(db, rec, { replyId: first })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expect(offeredDays(rec)).toBe(false)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyOffHoursNote)
      expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
      expect(activeSteps(db)).toEqual([])
    })

    it('si la hora se ocupó pero quedan otras hoy, las vuelve a ofrecer', async () => {
      const { db, rec } = await atTodaysHours()
      const first = last(rec).ids[0]
      db._tables.booking_appointments.push({ ...FULL_DAY, ends_at: '2026-10-19T14:30:00.000Z' })
      await send(db, rec, { replyId: first })
      expect(last(rec).ids.every((id) => id.startsWith('slot:2026-10-19T'))).toBe(true)
      expect(last(rec).ids).not.toContain(first)
      expect(activeStates(db)).toMatchObject([{ step: 'pick_slot', urgent: true }])
    })

    it('"Cambiar hora" desde el resumen vuelve a las horas de hoy, no a los días', async () => {
      const { db, rec } = await atTodaysHours()
      await send(db, rec, { replyId: last(rec).ids[0] })
      expect(last(rec).ids).toContain('act:reschedule')
      await send(db, rec, { replyId: 'act:reschedule' })
      expect(last(rec).ids.every((id) => id.startsWith('slot:2026-10-19T'))).toBe(true)
      expect(offeredDays(rec)).toBe(false)
      expect(activeStates(db)).toMatchObject([{ step: 'pick_slot', urgent: true }])
    })

    it('"Cambiar hora" sin horas hoy pasa a una persona', async () => {
      const { db, rec } = await atTodaysHours()
      await send(db, rec, { replyId: last(rec).ids[0] })
      db._tables.booking_appointments.push(FULL_DAY)
      await send(db, rec, { replyId: 'act:reschedule' })
      expect(last(rec).bodyText).toBe(texts.urgencyOffHours('3001234567'))
      expect(offeredDays(rec)).toBe(false)
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it.each([
      ['escribe "asesor"', { text: 'asesor' }],
      ['toca "Hablar con una persona"', { replyId: 'act:human' }],
    ])('si %s, el aviso es el prioritario', async (_what, input) => {
      const { db, rec } = await atTodaysHours()
      await send(db, rec, input)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyBookingNote)
      expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
      expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
    })

    it('si falla dos veces, el aviso es el prioritario', async () => {
      const { db, rec } = await atTodaysHours()
      await send(db, rec, { text: 'mañana por la tarde' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      await send(db, rec, { text: 'otra cosa' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyBookingNote)
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('esperando la autorización, pedir una persona también es prioritario', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_no' })
      await send(db, rec, { text: 'asesor' })
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyBookingNote)
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('una reserva normal no cambia: pedir una persona sigue con el aviso de siempre', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: [PATIENT] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { replyId: 'pat:pat-1' })
      await send(db, rec, { text: 'asesor' })
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(AGENDA_AGENT_TEXTS.handoffNote)
      expect(priorityNotifications(db)).toHaveLength(0)
    })
  })

  describe('mientras responde los signos de alarma', () => {
    it('"no puedo respirar" termina en "ve a urgencias", con aviso prioritario', async () => {
      const { db, rec } = await withAlarmQuestion()
      await send(db, rec, { text: 'no puedo respirar' })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
    })

    it('una respuesta que no se entiende se repite con los botones, sin pasar todavía', async () => {
      const { db, rec } = await withAlarmQuestion()
      await send(db, rec, { text: 'tengo mucho dolor' })
      expect(rec.calls.at(-2)?.bodyText).toBe(AGENDA_AGENT_TEXTS.retry)
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeStates(db)).toMatchObject([{ step: 'urgency', fails: 1 }])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(priorityNotifications(db)).toHaveLength(0)
    })

    it('dos respuestas que no se entienden terminan con aviso prioritario y los signos de alarma', async () => {
      const { db, rec } = await withAlarmQuestion()
      await send(db, rec, { text: 'tengo mucho dolor' })
      await send(db, rec, { text: 'tengo mucho dolor' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyPendingNote)
      // No es el pase genérico: repite los signos de alarma.
      expect(last(rec).bodyText).toBe(texts.urgencyPending(ALARM_TEXT))
      expect(last(rec).bodyText).toContain(ALARM_TEXT)
      expect(last(rec).bodyText).not.toBe(AGENDA_AGENT_TEXTS.handoff)
      expect(priorityNotifications(db)).toMatchObject([
        {
          user_id: OWNER,
          conversation_id: CONVERSATION,
          title: texts.urgencyNotificationTitle,
          body: texts.urgencyNotificationBody('Marta Ruiz'),
        },
      ])
      expect(activeSteps(db)).toEqual([])
    })

    it.each(['no, solo me duele', 'no sé', 'no estoy seguro'])(
      'una negación sin un signo (%j) avisa con prioridad y repite los signos, sin decir "ve a urgencias"',
      async (text) => {
        const { db, rec } = await withAlarmQuestion()
        await send(db, rec, { text })
        expect(last(rec).bodyText).toBe(texts.urgencyPending(ALARM_TEXT))
        expect(last(rec).bodyText).not.toBe(texts.urgencyGoEr)
        expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyPendingNote)
        expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
        expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
      },
    )

    it.each(['no doctora', 'creo que no', 'no tengo ninguno de esos signos'])(
      'una negación de la lista (%j) descarta los signos',
      async (text) => {
        const { db, rec } = await withAlarmQuestion(clinicDb({ clinic_consents: [grantedConsent()] }))
        await send(db, rec, { text })
        expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
        expect(priorityNotifications(db)).toHaveLength(0)
      },
    )

    it('un toque de un botón viejo cuenta como respuesta que no se entiende', async () => {
      const { db, rec } = await withAlarmQuestion()
      await send(db, rec, { replyId: 'svc:viejo' })
      await send(db, rec, { replyId: 'svc:viejo' })
      expect(last(rec).bodyText).toBe(texts.urgencyPending(ALARM_TEXT))
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('pedir una persona también avisa con prioridad y repite los signos de alarma', async () => {
      const { db, rec } = await withAlarmQuestion()
      await send(db, rec, { text: 'quiero hablar con una persona' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(last(rec).bodyText).toBe(texts.urgencyPending(ALARM_TEXT))
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('las palabras de urgencia del propio mensaje no reabren los signos', async () => {
      const { db, rec } = await withAlarmQuestion()
      const before = rec.calls.length
      await send(db, rec, { text: 'tengo mucho dolor' })
      // Es la respuesta a los signos: no se entendió, se repite, no se reinicia.
      expect(rec.calls.length).toBe(before + 2)
      expect(activeStates(db)).toMatchObject([{ step: 'urgency', fails: 1 }])
    })

    describe('un botón de un menú viejo', () => {
      const open = () => clinicDb({ booking_sessions: [session({ step: 'urgency' })] })

      it.each(['act:book', 'act:faq'])('%s no se salta la pregunta: se repite', async (replyId) => {
        const db = open()
        const rec = makeRecorder()
        await send(db, rec, { replyId })
        expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
        expect(last(rec).ids).toEqual(ALARM_BUTTONS)
        expect(activeSteps(db)).toEqual(['urgency'])
        expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      })

      it('"Hablar con una persona" avisa con prioridad y repite los signos de alarma', async () => {
        const db = open()
        const rec = makeRecorder()
        await send(db, rec, { replyId: 'act:human' })
        expect(last(rec).bodyText).toBe(texts.urgencyPending(ALARM_TEXT))
        expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
        expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.urgencyPendingNote)
        expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
      })
    })
  })

  describe('un aviso no es una promesa falsa', () => {
    it('el mensaje de urgencia dice que no espere respuesta', () => {
      expect(texts.urgencyGoEr).toBe(
        'Por favor ve a urgencias ahora, sin esperar respuesta. También avisé a la clínica.',
      )
      expect(texts.urgencyOffHours('3001234567')).toContain('sin esperar respuesta')
      expect(texts.urgencyOffHours(null)).toContain('sin esperar respuesta')
      expect(texts.urgencyPending('Signos')).toContain('sin esperar respuesta')
    })

    it('si falla la pausa del bot, el mensaje de urgencia sale igual y se alerta', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { db, rec } = await withAlarmQuestion()
      db._failNext('update', 'conversations', { message: 'boom' })
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(priorityNotifications(db)).toHaveLength(1)
      expect(notifyAlert).toHaveBeenCalledTimes(1)
      expect(vi.mocked(notifyAlert).mock.calls[0][0]).toContain(CONVERSATION)
    })

    it('si falla el aviso en la app, el mensaje sale igual y se alerta, sin datos del paciente', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { db, rec } = await withAlarmQuestion()
      db._failNext('insert', 'notifications', { message: 'boom' })
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(priorityNotifications(db)).toHaveLength(0)
      expect(notifyAlert).toHaveBeenCalledTimes(1)
      const alert = vi.mocked(notifyAlert).mock.calls[0][0]
      expect(alert).toContain(CONVERSATION)
      expect(alert).not.toContain('Marta')
      expect(alert).not.toContain('573001112233')
    })

    it('si falla el cierre de la sesión, el mensaje de urgencia sale igual', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { db, rec } = await withAlarmQuestion()
      db._failNext('update', 'booking_sessions', { message: 'boom' })
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('con el aviso entregado no se alerta a nadie', async () => {
      const { db, rec } = await withAlarmQuestion()
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(notifyAlert).not.toHaveBeenCalled()
    })

    it('un pase normal sigue sin prometer una persona si no se pudo pausar', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      await send(db, makeRecorder(), { text: 'Hola' })
      db._failNext('update', 'conversations', { message: 'boom' })
      const rec = makeRecorder()
      await expect(send(db, rec, { replyId: 'act:human' })).rejects.toThrow('No se pudo pausar el bot')
      expect(rec.calls).toHaveLength(0)
      expect(notifyAlert).not.toHaveBeenCalled()
    })
  })

  describe('avisos repetidos', () => {
    const humanThread = () => {
      const db = clinicDb()
      db._tables.conversations[0].assigned_agent_id = AGENT
      return db
    }
    const at = (minutes: number) => ({
      humanOwned: true,
      now: new Date(Date.UTC(2026, 9, 19, 13, minutes, 0)),
    })

    it('en un hilo de una persona, un aviso de urgencia cada 10 minutos por conversación', async () => {
      const db = humanThread()
      await send(db, makeRecorder(), { text: 'tengo dolor' }, at(0))
      await send(db, makeRecorder(), { text: 'me sigue doliendo, dolor' }, at(3))
      await send(db, makeRecorder(), { text: 'dolor otra vez' }, at(9))
      expect(priorityNotifications(db)).toHaveLength(1)
      await send(db, makeRecorder(), { text: 'dolor' }, at(11))
      expect(priorityNotifications(db)).toHaveLength(2)
    })

    it('cuenta también el aviso con el que el bot pasó el hilo', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'urgencia' })
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(priorityNotifications(db)).toHaveLength(1)
      await send(db, makeRecorder(), { text: 'dolor, ayuda' }, at(4))
      expect(priorityNotifications(db)).toHaveLength(1)
      await send(db, makeRecorder(), { text: 'dolor, ayuda' }, at(12))
      expect(priorityNotifications(db)).toHaveLength(2)
    })

    it('otra conversación no cuenta', async () => {
      const db = humanThread()
      db._tables.notifications.push({
        id: 'n-0',
        account_id: ACCOUNT,
        user_id: AGENT,
        conversation_id: 'cv-otra',
        title: texts.urgencyNotificationTitle,
        created_at: '2026-10-19T13:00:00.000Z',
      })
      await send(db, makeRecorder(), { text: 'dolor' }, at(1))
      expect(priorityNotifications(db)).toHaveLength(2)
    })
  })

  describe('los botones viejos de los signos de alarma', () => {
    it('"Sí, tengo alguno" vale sin sesión y sin autorización', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
    })

    it('"Sí, tengo alguno" vale en cualquier otro paso y cierra la sesión', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_sessions: [session({ step: 'pick_slot', serviceId: SERVICE_LIMPIEZA, staffId: STAFF_ANA })],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(db._tables.booking_sessions[0].status).toBe('cancelled')
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('"No, ninguno" viejo no descarta nada: vuelve a mostrar los signos', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:alarm_no' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeSteps(db)).toEqual(['urgency'])
      expect(db._tables.clinic_consents).toHaveLength(1)
    })

    it('en un hilo de una persona solo avisa a quien lo lleva', async () => {
      const db = clinicDb()
      db._tables.conversations[0].assigned_agent_id = AGENT
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:alarm_yes' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(priorityNotifications(db)).toMatchObject([{ user_id: AGENT }])
      expect(db._tables.conversations[0].assigned_agent_id).toBe(AGENT)
    })

    it('con la configuración de la clínica caída también es una urgencia', async () => {
      const db = clinicDb({ clinic_settings: [] })
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:alarm_yes' })
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableUrgentNote)
      expect(priorityNotifications(db)).toHaveLength(1)
    })

    it('en una cuenta sin el módulo no pasa nada', async () => {
      const db = clinicDb()
      const result = await send(db, makeRecorder(), { replyId: 'act:alarm_yes' }, { modules: ['agenda'] })
      expect(result).toEqual({ consumed: false })
      expect(db._tables.notifications).toHaveLength(0)
    })
  })

  describe('cuánto dura la sesión', () => {
    const expiresAt = (db: ReturnType<typeof clinicDb>) =>
      db._tables.booking_sessions.find((s) => s.status === 'active')?.expires_at as string

    it('en los signos de alarma dura 2 horas, no 15 minutos', async () => {
      const { db, rec } = await withAlarmQuestion()
      expect(expiresAt(db)).toBe('2026-10-19T15:00:00.000Z')
      // Cada mensaje la refresca.
      await send(db, rec, { text: 'tengo mucho dolor' }, { now: new Date('2026-10-19T13:30:00Z') })
      expect(expiresAt(db)).toBe('2026-10-19T15:30:00.000Z')
    })

    it('los demás pasos siguen en 15 minutos', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      await send(db, makeRecorder(), { text: 'Hola' })
      expect(expiresAt(db)).toBe('2026-10-19T13:15:00.000Z')
    })

    it('a casi 2 horas la sesión de los signos sigue viva', async () => {
      const { db, rec } = await withAlarmQuestion()
      const later = { now: new Date('2026-10-19T14:50:00Z') }
      await send(db, rec, { replyId: 'act:alarm_yes' }, later)
      expect(last(rec).bodyText).toBe(texts.urgencyGoEr)
    })
  })

  describe('el toque "Tengo una urgencia"', () => {
    it('sin sesión y con autorización también', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:urgent' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeSteps(db)).toEqual(['urgency'])
    })

    it('mientras escribe el nombre abre los signos, no responde "Necesito nombre y apellidos"', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { replyId: 'act:urgent' })
      expect(rec.calls.some((c) => c.bodyText === texts.patientNameRetry)).toBe(false)
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(activeStates(db)).toMatchObject([{ step: 'urgency', fails: 0 }])
    })

    describe.each([
      ['pick_patient', { step: 'pick_patient', options: [{ id: 'pat:pat-1', title: 'Marta Ruiz' }] }],
      ['new_patient_name', { step: 'new_patient_name' }],
      ['pick_service', { step: 'pick_service', options: [{ id: 'svc:svc-limpieza', title: 'Limpieza' }] }],
      ['pick_staff', { step: 'pick_staff', serviceId: SERVICE_LIMPIEZA }],
      ['pick_day', { step: 'pick_day', serviceId: SERVICE_LIMPIEZA, staffId: STAFF_ANA }],
      ['pick_slot', { step: 'pick_slot', serviceId: SERVICE_LIMPIEZA, staffId: STAFF_ANA, dateKey: '2026-10-19' }],
      ['ask_question', { step: 'ask_question', questionId: 'q-1' }],
      ['summary', { step: 'summary', serviceId: SERVICE_LIMPIEZA, staffId: STAFF_ANA }],
      ['clinic_menu', { step: 'clinic_menu' }],
      ['faq_open', { step: 'faq_open' }],
      ['consent', { step: 'consent', consentText: 'Texto de autorización', consentVersion: 2 }],
    ])('en %s', (_step, state) => {
      it('abre los signos de alarma, sin "No entendí" y sin registrar nada', async () => {
        const db = clinicDb({
          clinic_consents: [grantedConsent()],
          booking_sessions: [session(state)],
        })
        const rec = makeRecorder()
        const result = await send(db, rec, { replyId: 'act:urgent' })
        expect(result).toEqual({ consumed: true })
        expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
        expect(last(rec).ids).toEqual(ALARM_BUTTONS)
        expect(rec.calls.some((c) => c.bodyText === AGENDA_AGENT_TEXTS.retry)).toBe(false)
        expect(activeSteps(db)).toEqual(['urgency'])
        expect(db._tables.clinic_consents).toHaveLength(1)
      })
    })

    it('sin sesión y sin autorización muestra los signos de alarma', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:urgent' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(activeSteps(db)).toEqual(['urgency'])
    })

    it('con el menú abierto, igual', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:urgent' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeSteps(db)).toEqual(['urgency'])
    })

    it('con la autorización en pantalla, la urgencia va primero', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
      await send(db, rec, { replyId: 'act:urgent' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeSteps(db)).toEqual(['urgency'])
      expect(db._tables.clinic_consents).toHaveLength(0)
    })

    it('tocarlo otra vez vuelve a mostrar los signos sin contarlo como fallo', async () => {
      const { db, rec } = await withAlarmQuestion()
      const before = rec.calls.length
      await send(db, rec, { replyId: 'act:urgent' })
      expect(rec.calls.length).toBe(before + 1)
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeStates(db)).toMatchObject([{ step: 'urgency', fails: 0 }])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('tampoco lo detiene escribir un nombre o una respuesta: es un toque deliberado', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_sessions: [session({ step: 'new_patient_name' })],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:urgent' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
    })
  })

  describe('reemplaza lo que estuviera abierto', () => {
    it('una reserva a medias', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_sessions: [
          session({
            step: 'pick_slot',
            serviceId: SERVICE_LIMPIEZA,
            staffId: STAFF_ANA,
            dateKey: '2026-10-19',
            options: [{ id: 'slot:2026-10-19T14:00:00.000Z', title: '9:00 a. m.' }],
          }),
        ],
      })
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'tengo mucho dolor de muela' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      // La misma sesión, con el estado nuevo: no quedan dos abiertas.
      expect(db._tables.booking_sessions).toHaveLength(1)
      expect(db._tables.booking_sessions[0].id).toBe('ses-1')
      expect(activeStates(db)).toEqual([expect.objectContaining({ step: 'urgency', fails: 0 })])
      expect(activeStates(db)[0]).not.toHaveProperty('serviceId')
    })

    it('la autorización sin responder', async () => {
      const db = clinicDb({
        booking_sessions: [
          session({
            step: 'consent',
            consentText: 'Texto de autorización',
            consentVersion: 2,
            options: [
              { id: 'act:consent_yes', title: texts.consentAccept },
              { id: 'act:consent_no', title: texts.consentDecline },
            ],
          }),
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'tengo dolor' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(activeSteps(db)).toEqual(['urgency'])
      expect(db._tables.clinic_consents).toHaveLength(0)
    })

    it('el menú principal y la duda abierta', async () => {
      for (const step of ['clinic_menu', 'faq_open']) {
        const db = clinicDb({
          clinic_consents: [grantedConsent()],
          booking_sessions: [session({ step })],
        })
        const rec = makeRecorder()
        await send(db, rec, { text: 'tengo dolor' })
        expect(last(rec).ids).toEqual(ALARM_BUTTONS)
        expect(activeSteps(db)).toEqual(['urgency'])
      }
    })

    it('va antes de pedir una persona', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'quiero un asesor, tengo dolor' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })
  })

  describe('lo que no abre la urgencia', () => {
    it('escribir el nombre "Dolores" no abre la urgencia', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { text: 'Dolores Ruiz' })
      expect(db._tables.clinic_patients[0].full_name).toBe('Dolores Ruiz')
      expect(priorityNotifications(db)).toHaveLength(0)
    })

    it('pero una palabra entera de urgencia sí, también escrita como nombre', async () => {
      for (const text of ['Dolor Pérez', 'no puedo respirar', 'me ahogo']) {
        const db = clinicDb({ clinic_consents: [grantedConsent()] })
        const rec = makeRecorder()
        await send(db, rec, { text: 'Hola' })
        await send(db, rec, { replyId: 'act:book' })
        await send(db, rec, { text })
        // Nadie queda registrado como paciente con una emergencia por nombre.
        expect(db._tables.clinic_patients).toHaveLength(0)
        expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
        expect(activeSteps(db)).toEqual(['urgency'])
      }
    })

    it('también la respuesta de texto a una pregunta extra', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_questions: [
          {
            id: 'q-motivo',
            account_id: ACCOUNT,
            label: '¿Motivo de la visita?',
            kind: 'texto',
            required: true,
            options: [],
            position: 0,
            is_active: true,
          },
        ],
        booking_sessions: [
          session({
            step: 'ask_question',
            questionId: 'q-motivo',
            serviceId: SERVICE_LIMPIEZA,
            staffId: STAFF_ANA,
            dateKey: '2026-10-19',
            slotStartsAt: '2026-10-19T14:00:00.000Z',
          }),
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Tengo dolor de muela' })
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(activeSteps(db)).toEqual(['urgency'])
    })

    it('una pregunta extra de opciones sí: ahí un texto libre no es la respuesta', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_questions: [
          {
            id: 'q-sede',
            account_id: ACCOUNT,
            label: '¿En qué sede?',
            kind: 'opcion',
            required: true,
            options: ['Centro', 'Norte'],
            position: 0,
            is_active: true,
          },
        ],
        booking_sessions: [
          session({
            step: 'ask_question',
            questionId: 'q-sede',
            options: [
              { id: 'ans:q-sede:0', title: 'Centro' },
              { id: 'ans:q-sede:1', title: 'Norte' },
            ],
          }),
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'tengo mucho dolor' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
    })

    it('una foto, un audio o un sticker no abren nada', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      const result = await send(db, rec, { text: '[Unsupported message type: audio]' })
      // No abre los signos: recibe el aviso de que no se leen audios, y el menú.
      expect(result).toEqual({ consumed: true })
      expect(rec.calls[0].bodyText).toBe(texts.nonTextNotice)
      expect(activeSteps(db)).toEqual(['clinic_menu'])
      expect(priorityNotifications(db)).toHaveLength(0)
    })

    it('un texto sin palabras de urgencia sigue su camino', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      expect(last(rec).ids).toEqual(['act:book', 'act:mine', 'act:faq', 'act:urgent', 'act:human'])
    })
  })

  describe('el piso fijo', () => {
    it.each([
      'me ahogo',
      'no respiro bien',
      'tengo una hemorragia',
      'se me está hinchando la cara',
      'tengo el cachete inchado',
      'tengo un flemón',
      'tengo una infección en la encía',
      'mi hijo se golpeó la boca',
      'a mi hijo se le partió un diente',
      'tengo una muela rota',
      // Las palabras de siempre ya no dependen de la lista de la clínica.
      'me duele una muela',
      'me duelen las muelas',
      'tengo mucho dolor',
      'no puedo tragar',
      'es urgente',
      'tengo una urgencia',
      'esto es una emergencia',
    ])('abre los signos aunque la clínica deje su lista vacía: %j', async (text) => {
      const db = clinicDb()
      db._tables.clinic_settings[0].urgency_words = []
      const rec = makeRecorder()
      await send(db, rec, { text })
      expect(last(rec).bodyText).toBe(texts.urgencyBody(ALARM_TEXT))
      expect(activeSteps(db)).toEqual(['urgency'])
    })

    it('en un hilo de una persona también avisa', async () => {
      const db = clinicDb()
      db._tables.clinic_settings[0].urgency_words = []
      db._tables.conversations[0].assigned_agent_id = AGENT
      await send(db, makeRecorder(), { text: 'tengo un flemón' }, { humanOwned: true })
      expect(priorityNotifications(db)).toMatchObject([{ user_id: AGENT }])
    })
  })

  describe('las palabras de la clínica', () => {
    it('usa las que la clínica configuró, no las de siempre', async () => {
      const db = clinicDb()
      db._tables.clinic_settings[0].urgency_words = ['ayuda']
      const rec = makeRecorder()
      await send(db, rec, { text: 'tengo una fractura' })
      expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
      await send(db, rec, { text: 'ayuda' })
      expect(last(rec).ids).toEqual(ALARM_BUTTONS)
    })

    it('con las palabras por defecto reconoce los casos de una clínica dental', async () => {
      for (const text of ['me sangran las encías', 'se me quebró un diente', 'tengo la cara inflamada']) {
        const db = clinicDb()
        db._tables.clinic_settings[0].urgency_words = [...DEFAULT_URGENCY_WORDS]
        const rec = makeRecorder()
        await send(db, rec, { text })
        expect(last(rec).ids).toEqual(ALARM_BUTTONS)
      }
    })
  })

  describe('en un hilo de una persona', () => {
    const humanThread = (assigned: string | null = AGENT, extra: Record<string, Row[]> = {}) => {
      const db = clinicDb(extra)
      db._tables.conversations[0].assigned_agent_id = assigned
      if (!assigned) db._tables.conversations[0].ai_autoreply_disabled = true
      return db
    }

    it('el bot no responde y avisa a quien lo lleva', async () => {
      const db = humanThread()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'me duele, tengo dolor' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.notifications).toMatchObject([
        {
          user_id: AGENT,
          conversation_id: CONVERSATION,
          title: '🚨 Posible urgencia',
          body: texts.urgencyNotificationBody('Marta Ruiz'),
        },
      ])
      expect(activeSteps(db)).toEqual([])
    })

    it('si nadie lo lleva, avisa al dueño', async () => {
      const db = humanThread(null)
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'tengo dolor' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.notifications).toMatchObject([{ user_id: OWNER, title: '🚨 Posible urgencia' }])
    })

    it('sin una palabra de urgencia no avisa a nadie', async () => {
      const db = humanThread()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'gracias doctora' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      expect(db._tables.notifications).toHaveLength(0)
    })

    it('un toque en "Tengo una urgencia" de un menú viejo también avisa', async () => {
      const db = humanThread()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:urgent' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.notifications).toMatchObject([{ user_id: AGENT }])
    })

    it('otro toque de un menú viejo no avisa', async () => {
      const db = humanThread()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:book' }, { humanOwned: true })
      expect(db._tables.notifications).toHaveLength(0)
    })

    it('si la configuración falta o no se pudo leer, igual avisa, con las palabras de siempre', async () => {
      const missing = humanThread(AGENT, { clinic_settings: [] })
      await send(missing, makeRecorder(), { text: 'me sangran las encías' }, { humanOwned: true })
      expect(priorityNotifications(missing)).toMatchObject([{ user_id: AGENT }])

      const unreadable = humanThread()
      unreadable._failNext('select', 'clinic_settings', { message: 'timeout' })
      await send(unreadable, makeRecorder(), { text: 'me sangran las encías' }, { humanOwned: true })
      expect(priorityNotifications(unreadable)).toMatchObject([{ user_id: AGENT }])
    })

    it('si no se puede leer a quién avisar, no se rompe el mensaje', async () => {
      const db = humanThread()
      db._failNext('select', 'conversations', { message: 'timeout' })
      const result = await send(db, makeRecorder(), { text: 'tengo dolor' }, { humanOwned: true })
      expect(result).toEqual({ consumed: false })
      // Sin saber quién lo lleva, el aviso va al dueño.
      expect(db._tables.notifications).toMatchObject([{ user_id: OWNER, title: texts.urgencyNotificationTitle }])
    })

    it('una cuenta sin el módulo no avisa nada', async () => {
      const db = humanThread()
      const rec = makeRecorder()
      const result = await send(
        db,
        rec,
        { text: 'tengo dolor' },
        { humanOwned: true, modules: ['agenda'] },
      )
      expect(result).toEqual({ consumed: false })
      expect(db._tables.notifications).toHaveLength(0)
    })

    it('un recordatorio contestado en un hilo de una persona sigue su camino', async () => {
      const db = humanThread()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'rem:confirm' }, { humanOwned: true })
      expect(priorityNotifications(db)).toHaveLength(0)
    })
  })

  describe('una cuenta sin el módulo no conoce las urgencias', () => {
    it('un texto', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'tengo dolor' }, { modules: ['agenda'] })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.booking_sessions).toHaveLength(0)
    })

    it('un toque de "Tengo una urgencia"', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:urgent' }, { modules: ['agenda'] })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.booking_sessions).toHaveLength(0)
    })
  })

  describe('la clínica no está disponible', () => {
    it('un toque de "Tengo una urgencia" también usa el aviso prioritario', async () => {
      const db = clinicDb({ clinic_settings: [] })
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: 'act:urgent' })
      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableUrgentNote)
      expect(priorityNotifications(db)).toMatchObject([{ user_id: OWNER }])
    })
  })

  describe('lo que se le dice al paciente', () => {
    it('sale solo de los textos del sistema y de la configuración de la clínica', async () => {
      const allowed = new Set([
        texts.urgencyBody(ALARM_TEXT),
        texts.urgencyGoEr,
        texts.urgencyOffHours('3001234567'),
        texts.urgencyPending(ALARM_TEXT),
        texts.patientNamePrompt,
        texts.consentDeclined,
        AGENDA_AGENT_TEXTS.retry,
        AGENDA_AGENT_TEXTS.slotMenuBody(formatLongDate('2026-10-19')),
        'Texto de autorización',
      ])
      const everything = new Set<string>()
      const run = async (
        steps: { text?: string; replyId?: string }[],
        opts: Parameters<typeof send>[3] = {},
        extra: Record<string, Row[]> = {},
      ) => {
        const db = clinicDb(extra)
        const rec = makeRecorder()
        for (const step of steps) await send(db, rec, step, opts)
        for (const line of said(rec)) everything.add(line)
      }

      await run([{ text: 'urgencia' }, { replyId: 'act:alarm_yes' }])
      await run([{ text: 'urgencia' }, { text: 'no puedo respirar' }])
      await run([{ text: 'urgencia' }, { text: 'dolor' }, { text: 'dolor' }])
      await run([{ text: 'urgencia' }, { replyId: 'act:alarm_no' }, { replyId: 'act:consent_yes' }, { text: 'Marta Ruiz' }])
      await run([{ text: 'urgencia' }, { replyId: 'act:alarm_no' }, { replyId: 'act:consent_no' }])
      await run(
        [{ text: 'urgencia' }, { replyId: 'act:alarm_no' }],
        { now: SATURDAY },
        { clinic_consents: [grantedConsent()] },
      )

      expect(everything.size).toBeGreaterThanOrEqual(allowed.size - 1)
      expect([...everything].filter((line) => !allowed.has(line))).toEqual([])
    })
  })
})

describe('el menú principal', () => {
  const ctx = { texts } as ClinicStepCtx

  it('"Tengo una urgencia" lleva a los signos de alarma, sin fallo', async () => {
    const outcome = await handleClinicChoice(ctx, newBookingState('clinic_menu'), {
      kind: 'act',
      value: 'urgent',
    })
    expect(outcome).toMatchObject({ kind: 'next', state: { step: 'urgency', fails: 0 } })
  })
})

describe('textos de urgencia', () => {
  const ADVICE =
    /ibuprofeno|acetaminof[eé]n|paracetamol|naproxeno|aspirina|analg[eé]sic|antibi[oó]tic|antiinflamatori|medicament|medicina|pastilla|pomada|tome|toma\s|enjuag|hielo|compresa|infecci[oó]n|diagn[oó]stic|probablemente|seguramente|puede ser/i

  it('no traen medicamentos ni diagnóstico', () => {
    const patientFacing = [
      texts.urgencyBody(DEFAULT_URGENCY_ALARM_TEXT),
      texts.urgencyYes,
      texts.urgencyNo,
      texts.urgencyGoEr,
      texts.urgencyOffHours('3001234567'),
      texts.urgencyOffHours(null),
      texts.urgencyPending(DEFAULT_URGENCY_ALARM_TEXT),
    ]
    for (const line of patientFacing) expect(line).not.toMatch(ADVICE)
  })

  it('el aviso de dos respuestas confusas repite los signos de alarma de la clínica', () => {
    expect(texts.urgencyPending('Signos de la clínica')).toContain('Signos de la clínica')
    expect(texts.urgencyPendingNote).toMatch(/^Paciente:/)
  })
})
