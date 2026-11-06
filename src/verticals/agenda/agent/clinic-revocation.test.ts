import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { AGENDA_AGENT_TEXTS } from '../texts'
import {
  ACCOUNT,
  CONTACT,
  OWNER,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import type { FakeDb, Row } from './testing/fake-db'

const texts = buildClinicTexts(DEFAULT_LABELS)

const session = (state: Record<string, unknown>): Row => ({
  id: 'ses-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: { mode: 'book', options: [], fails: 0, ...state },
})

/** Un paciente con la autorización vigente. */
const authorized = (extra: Record<string, Row[]> = {}) =>
  clinicDb({ clinic_consents: [grantedConsent()], ...extra })

const revocations = (db: FakeDb) =>
  db._tables.clinic_consents.filter((c) => c.kind === 'datos_sensibles' && c.granted === false)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('revocar la autorización escribiendo', () => {
  it.each([
    'no acepto',
    'ya no acepto',
    'ya no autorizo el uso de mis datos',
    'revoco mi autorización',
  ])('%j la registra, pausa el bot y pasa a una persona', async (text) => {
    const db = authorized()
    const rec = makeRecorder()

    const result = await send(db, rec, { text })

    expect(result).toEqual({ consumed: true })
    expect(revocations(db)).toMatchObject([
      {
        account_id: ACCOUNT,
        contact_id: CONTACT,
        contact_ref: '573001112233',
        kind: 'datos_sensibles',
        granted: false,
        text_version: 2,
        text_snapshot: 'Texto de autorización',
        source: 'whatsapp',
        message_id: expect.stringMatching(/^wamid-/),
      },
    ])
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentRevokedNote)
    expect(last(rec).bodyText).toBe(texts.consentDeclined)
  })

  it('quien pide borrar sus datos: la nota dice que hay que atenderlo a mano', async () => {
    const db = authorized()
    const rec = makeRecorder()

    await send(db, rec, { text: 'quiero que borren mis datos' })

    expect(revocations(db)).toHaveLength(1)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentRevokedDeleteNote)
    expect(texts.consentRevokedDeleteNote).toContain('borren sus datos')
    expect(texts.consentRevokedDeleteNote).toContain('a mano')
    // El bot no borra nada.
    expect(db._tables.clinic_patients).toHaveLength(0)
  })

  it('si no se pudo registrar, la nota dice que hay que hacerlo a mano y el chat pasa igual', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = authorized()
    const rec = makeRecorder()
    db._failNext('insert', 'clinic_consents', { message: 'timeout' })

    await send(db, rec, { text: 'ya no autorizo' })

    expect(revocations(db)).toHaveLength(0)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentRevokedUnsavedNote)
  })

  it('si pidió borrar y no se pudo registrar, la nota dice las dos cosas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = authorized()
    db._failNext('insert', 'clinic_consents', { message: 'timeout' })

    await send(db, makeRecorder(), { text: 'borren mis datos' })

    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentRevokedDeleteUnsavedNote)
  })

  describe('en cualquier paso', () => {
    it.each([
      ['el menú', { step: 'clinic_menu' }],
      ['la duda abierta', { step: 'faq_open' }],
      ['elegir el servicio', { step: 'pick_service' }],
      ['elegir la hora', { step: 'pick_slot', serviceId: 'svc-limpieza', staffId: 'any', dateKey: '2026-10-19' }],
      ['el resumen', { step: 'summary', serviceId: 'svc-limpieza', slotStartsAt: '2026-10-19T15:00:00.000Z' }],
      ['escribir el nombre', { step: 'new_patient_name' }],
      ['elegir al paciente', { step: 'pick_patient' }],
      ['la lista de citas', { step: 'pick_appointment' }],
      ['la pregunta de avisos de control', { step: 'marketing_consent' }],
    ])('%s', async (_label, state) => {
      const db = authorized({ booking_sessions: [session(state)] })
      const rec = makeRecorder()

      const result = await send(db, rec, { text: 'ya no autorizo el uso de mis datos' })

      expect(result).toEqual({ consumed: true })
      expect(revocations(db)).toHaveLength(1)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      // La reserva a medias se cierra: quien retiró su autorización no sigue agendando.
      expect(db._tables.booking_sessions.every((s) => s.status !== 'active')).toBe(true)
    })

    it('menos mientras responde los signos de alarma: ahí manda la urgencia', async () => {
      const db = authorized({ booking_sessions: [session({ step: 'urgency' })] })
      const rec = makeRecorder()

      await send(db, rec, { text: 'no acepto' })

      expect(revocations(db)).toHaveLength(0)
      expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.consentRevokedNote)
    })
  })

  describe('lo que NO es una revocación sigue su camino', () => {
    it.each(['no acepto esa hora', 'no acepto tarjeta', 'borré el mensaje'])(
      '%j no registra nada ni pausa el bot',
      async (text) => {
        const db = authorized()
        const rec = makeRecorder()

        const result = await send(db, rec, { text })

        // Va a la IA, como cualquier duda.
        expect(result).toEqual({ consumed: false })
        expect(revocations(db)).toHaveLength(0)
        expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      },
    )
  })

  describe('sin una autorización vigente no hay nada que revocar', () => {
    it('sin ninguna respuesta, pide la autorización como siempre', async () => {
      const db = clinicDb()
      const rec = makeRecorder()

      await send(db, rec, { text: 'ya no autorizo el uso de mis datos' })

      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(last(rec).bodyText).toBe('Texto de autorización')
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('si ya la había rechazado o revocado, no se registra otra vez', async () => {
      const db = clinicDb({
        clinic_consents: [
          grantedConsent(),
          { ...grantedConsent(), id: 'cons-no', granted: false, created_at: '2026-10-05T00:00:00.000Z' },
        ],
      })

      await send(db, makeRecorder(), { text: 'revoco mi autorización' })

      expect(db._tables.clinic_consents).toHaveLength(2)
    })
  })

  describe('en un hilo que lleva una persona', () => {
    const humanThread = () => {
      const db = authorized()
      db._tables.conversations[0].assigned_agent_id = 'agent-1'
      return db
    }

    it('solo registra: no le escribe al paciente ni toca el hilo', async () => {
      const db = humanThread()
      const rec = makeRecorder()

      const result = await send(db, rec, { text: 'ya no autorizo el uso de mis datos' }, { humanOwned: true })

      expect(result).toEqual({ consumed: true })
      expect(revocations(db)).toHaveLength(1)
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.conversations[0].ai_handoff_summary).toBeNull()
      expect(db._tables.conversations[0].assigned_agent_id).toBe('agent-1')
    })

    it('si pidió borrar sus datos, avisa a quien lleva el hilo', async () => {
      const db = humanThread()

      await send(db, makeRecorder(), { text: 'quiero que borren mis datos' }, { humanOwned: true })

      expect(revocations(db)).toHaveLength(1)
      expect(db._tables.notifications).toMatchObject([
        {
          user_id: 'agent-1',
          title: texts.consentDeletionRequestTitle,
          body: texts.consentDeletionRequestBody('Marta Ruiz'),
        },
      ])
    })

    it('sin pedir borrar, no manda avisos si se registró', async () => {
      const db = humanThread()

      await send(db, makeRecorder(), { text: 'revoco mi autorización' }, { humanOwned: true })

      expect(db._tables.notifications).toHaveLength(0)
    })

    it('si no se pudo registrar, avisa a quien lo lleva para que lo haga a mano', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = humanThread()
      db._failNext('insert', 'clinic_consents', { message: 'timeout' })

      await send(db, makeRecorder(), { text: 'revoco mi autorización' }, { humanOwned: true })

      expect(revocations(db)).toHaveLength(0)
      expect(db._tables.notifications).toMatchObject([
        { user_id: 'agent-1', title: texts.consentRevokeFailedTitle },
      ])
    })

    it('un mensaje que no revoca sigue sin contestarse', async () => {
      const db = humanThread()
      const rec = makeRecorder()

      const result = await send(db, rec, { text: 'no acepto esa hora' }, { humanOwned: true })

      expect(result).toEqual({ consumed: false })
      expect(revocations(db)).toHaveLength(0)
      expect(rec.calls).toHaveLength(0)
    })

    it('sin autorización vigente tampoco registra nada', async () => {
      const db = clinicDb()
      db._tables.conversations[0].assigned_agent_id = 'agent-1'

      const result = await send(db, makeRecorder(), { text: 'ya no autorizo' }, { humanOwned: true })

      expect(result).toEqual({ consumed: false })
      expect(db._tables.clinic_consents).toHaveLength(0)
    })
  })

  it('una cuenta sin clínica no cambia: no registra ni pausa nada', async () => {
    const db = authorized()
    const rec = makeRecorder()

    await send(db, rec, { text: 'ya no autorizo el uso de mis datos' }, { modules: ['agenda'] })

    expect(db._tables.clinic_consents).toHaveLength(1)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('el dueño de la cuenta no cambia: sigue siendo quien recibe los avisos sin agente', async () => {
    const db = authorized()
    db._tables.conversations[0].assigned_agent_id = null
    await send(db, makeRecorder(), { text: 'borren mis datos' }, { humanOwned: true })
    expect(db._tables.notifications).toMatchObject([{ user_id: OWNER }])
  })
})

describe('Reprogramar desde un recordatorio, tras revocar la autorización', () => {
  const appointment = (): Row => ({
    id: 'ap-1',
    account_id: ACCOUNT,
    contact_id: CONTACT,
    service_id: 'svc-limpieza',
    staff_id: 'st-ana',
    patient_id: null,
    starts_at: '2026-10-20T14:00:00.000Z',
    ends_at: '2026-10-20T14:30:00.000Z',
    status: 'pending',
    answers: {},
  })
  const revoked = (): Row => ({
    ...grantedConsent(),
    id: 'cons-no',
    granted: false,
    created_at: '2026-10-05T00:00:00.000Z',
  })
  const activeSteps = (db: FakeDb) =>
    db._tables.booking_sessions.filter((s) => s.status === 'active').map((s) => (s.state as { step: string }).step)

  it('no abre el flujo: lo atiende una persona, que recibe un aviso', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent(), revoked()],
      booking_appointments: [appointment()],
    })
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:reschedule:ap-1' })

    expect(activeSteps(db)).toEqual([])
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.rescheduleHandedToHuman)
    expect(db._tables.notifications).toMatchObject([
      { user_id: OWNER, title: AGENDA_AGENT_TEXTS.rescheduleRequestNotificationTitle },
    ])
    expect(db._tables.booking_appointments[0].status).toBe('pending')
  })

  it('con la autorización vigente abre el flujo de siempre', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_appointments: [appointment()],
    })

    await send(db, makeRecorder(), { replyId: 'rem:reschedule:ap-1' })

    expect(activeSteps(db)).toEqual(['pick_day'])
  })

  it('sin ninguna autorización registrada (cita anterior al módulo) también', async () => {
    const db = clinicDb({ booking_appointments: [appointment()] })

    await send(db, makeRecorder(), { replyId: 'rem:reschedule:ap-1' })

    expect(activeSteps(db)).toEqual(['pick_day'])
  })

  it('Confirmar y Cancelar no cambian', async () => {
    const confirm = clinicDb({
      clinic_consents: [grantedConsent(), revoked()],
      booking_appointments: [appointment()],
    })
    await send(confirm, makeRecorder(), { replyId: 'rem:confirm:ap-1' })
    expect(confirm._tables.booking_appointments[0].status).toBe('confirmed')

    const cancel = clinicDb({
      clinic_consents: [grantedConsent(), revoked()],
      booking_appointments: [appointment()],
    })
    await send(cancel, makeRecorder(), { replyId: 'rem:cancel:ap-1' })
    expect(activeSteps(cancel)).toEqual(['manage_cancel_confirm'])
  })

  it('una cuenta sin clínica no mira la autorización', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent(), revoked()],
      booking_appointments: [appointment()],
    })

    await send(db, makeRecorder(), { replyId: 'rem:reschedule' }, { modules: ['agenda'] })

    expect(activeSteps(db)).toEqual(['pick_day'])
  })
})
