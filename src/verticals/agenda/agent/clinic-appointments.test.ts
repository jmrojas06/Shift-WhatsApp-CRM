import { describe, expect, it } from 'vitest'

import { buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { apptId, remId } from './state'
import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  SERVICE_LIMPIEZA,
  SERVICE_URGENCIA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  seedTemplateMessage,
  send,
} from './testing/clinic-harness'
import type { Row } from './testing/fake-db'

const texts = buildClinicTexts(DEFAULT_LABELS)

const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=4.6,-74.08'

const appointment = (id: string, patientId: string, startsAt: string, extra: Row = {}): Row => ({
  id,
  account_id: ACCOUNT,
  contact_id: CONTACT,
  conversation_id: CONVERSATION,
  service_id: SERVICE_LIMPIEZA,
  staff_id: STAFF_ANA,
  patient_id: patientId,
  starts_at: startsAt,
  ends_at: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
  status: 'pending',
  answers: {},
  ...extra,
})

const family = (): Row[] => [
  { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
  { id: 'pat-2', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil' },
]

/** Martes 20 de octubre, 9:00 y 10:00 en Bogotá: dos citas del mismo número, a una hora de distancia. */
const FIRST = '2026-10-20T14:00:00.000Z'
const SECOND = '2026-10-20T15:00:00.000Z'

const twoAppointments = (extra: Record<string, Row[]> = {}) =>
  clinicDb({
    clinic_consents: [grantedConsent()],
    clinic_patients: family(),
    booking_appointments: [
      appointment('ap-1', 'pat-1', FIRST),
      appointment('ap-2', 'pat-2', SECOND),
    ],
    ...extra,
  })

type Db = ReturnType<typeof clinicDb>

const statuses = (db: Db) =>
  Object.fromEntries(db._tables.booking_appointments.map((a) => [a.id, a.status]))

const activeStates = (db: Db) =>
  db._tables.booking_sessions
    .filter((s) => s.status === 'active')
    .map((s) => s.state as Record<string, unknown>)

const BOTH = [apptId('ap-1'), apptId('ap-2')]

describe('varias citas en un número', () => {
  it('Mis citas lista las citas con el nombre de cada paciente', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:mine' })
    expect(last(rec).ids).toEqual(BOTH)
    expect(last(rec).bodyText).toContain('Marta Ruiz')
    expect(last(rec).bodyText).toContain('Tomás Gil')
    expect(last(rec).titles[1]).toContain('Tomás')
  })

  it('con una sola cita va directo a gestionarla', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: family(),
      booking_appointments: [appointment('ap-1', 'pat-1', FIRST)],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:mine' })
    expect(last(rec).ids).toContain('act:reschedule')
    expect(activeStates(db)[0]).toMatchObject({ step: 'manage_menu', appointmentId: 'ap-1' })
  })

  it('sin citas lo dice y vuelve al menú', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:mine' })
    expect(rec.calls.at(-2)?.bodyText).toBe(texts.noUpcoming)
    expect(rec.calls.at(-2)?.bodyText).toContain('Por ahora no hay citas a tu nombre')
    expect(last(rec).ids[0]).toBe('act:book')
  })

  it('solo lista las citas activas y futuras de este número', async () => {
    const db = twoAppointments({
      booking_appointments: [
        appointment('ap-1', 'pat-1', FIRST),
        appointment('ap-2', 'pat-2', SECOND),
        appointment('ap-cancelada', 'pat-1', '2026-10-21T14:00:00.000Z', { status: 'cancelled' }),
        appointment('ap-pasada', 'pat-1', '2026-10-18T14:00:00.000Z'),
        appointment('ap-ajena', 'pat-1', '2026-10-22T14:00:00.000Z', { contact_id: 'ct-otro' }),
        appointment('ap-otra-cuenta', 'pat-1', '2026-10-23T14:00:00.000Z', {
          account_id: 'acc-otra',
        }),
      ],
    })
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:mine' })
    expect(last(rec).ids).toEqual(BOTH)
  })

  it('una cita sin paciente se lista con su fecha', async () => {
    const db = twoAppointments({
      booking_appointments: [
        appointment('ap-1', 'pat-1', FIRST),
        appointment('ap-2', 'pat-borrado', SECOND, { patient_id: null }),
      ],
    })
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:mine' })
    expect(last(rec).ids).toEqual(BOTH)
    expect(last(rec).bodyText).toContain('• Marta Ruiz: ')
    expect(last(rec).bodyText).toContain('• mar 20 oct, 10:00 a. m.')
  })

  describe('los títulos de la lista son siempre distintos', () => {
    const DAY2 = '2026-10-21T14:00:00.000Z'
    const patientsWith = (...names: string[]): Row[] =>
      names.map((full_name, i) => ({
        id: `pat-${i + 1}`,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        full_name,
      }))

    /** Abre "Mis citas" con estas citas y devuelve lo que se mostró y lo que quedó guardado. */
    async function listFor(patientNames: string[], appts: Row[]) {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: patientsWith(...patientNames),
        booking_appointments: appts,
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:mine' })
      const stored = (activeStates(db)[0] as { options: { title: string }[] }).options.map((o) => o.title)
      return { db, rec, shown: last(rec).titles, stored, body: last(rec).bodyText }
    }

    const expectDistinct = (titles: string[]) => {
      expect(new Set(titles).size).toBe(titles.length)
      for (const title of titles) expect(title.length).toBeLessThanOrEqual(20)
    }

    it('la misma persona en dos días: se distinguen por la fecha, sin numerar', async () => {
      const { shown, stored } = await listFor(
        ['Marta Ruiz'],
        [appointment('ap-1', 'pat-1', FIRST), appointment('ap-2', 'pat-1', DAY2)],
      )
      expect(shown).toEqual(['20 oct Marta', '21 oct Marta'])
      expect(stored).toEqual(shown)
    })

    it('la misma persona dos veces el mismo día: se numeran', async () => {
      const { shown, stored, body } = await listFor(
        ['Marta Ruiz'],
        [appointment('ap-1', 'pat-1', FIRST), appointment('ap-2', 'pat-1', SECOND)],
      )
      expect(shown).toEqual(['1. 20 oct Marta', '2. 20 oct Marta'])
      expect(stored).toEqual(shown)
      // El cuerpo las numera igual, con la hora completa: así se sabe cuál es cuál.
      expect(body).toContain('1. Marta Ruiz: mar 20 oct, 9:00 a. m.')
      expect(body).toContain('2. Marta Ruiz: mar 20 oct, 10:00 a. m.')
    })

    it('dos personas con el mismo nombre de pila el mismo día', async () => {
      const { shown } = await listFor(
        ['Marta Ruiz', 'Marta Gil'],
        [appointment('ap-1', 'pat-1', FIRST), appointment('ap-2', 'pat-2', SECOND)],
      )
      expectDistinct(shown)
      expect(shown[0]).toMatch(/^1\. /)
    })

    it('un nombre largo no hace chocar dos títulos al recortarse', async () => {
      const { shown, stored } = await listFor(
        ['Guillermina-Ana Pérez', 'Guillermina-Eva Gil'],
        [appointment('ap-1', 'pat-1', FIRST), appointment('ap-2', 'pat-2', FIRST)],
      )
      // Distintos sin recortar, pero al tope de 20 los dos quedarían "20 oct Guillermina-…".
      expectDistinct(shown)
      expectDistinct(stored)
      expect(shown[0]).toMatch(/^1\. /)
    })

    it('citas sin paciente se distinguen por la fecha y la hora', async () => {
      const { shown } = await listFor(
        [],
        [
          appointment('ap-1', 'pat-x', FIRST, { patient_id: null }),
          appointment('ap-2', 'pat-x', SECOND, { patient_id: null }),
          appointment('ap-3', 'pat-x', DAY2, { patient_id: null }),
        ],
      )
      expectDistinct(shown)
      expect(shown[0]).toBe('20 oct 9:00 a. m.')
    })

    it('con diez citas de la misma persona siguen siendo distintos', async () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        appointment(`ap-${i + 1}`, 'pat-1', new Date(Date.parse(FIRST) + i * 15 * 60_000).toISOString()),
      )
      const { shown, stored } = await listFor(['Marta Ruiz'], many)
      expect(shown).toHaveLength(10)
      expectDistinct(shown)
      expectDistinct(stored)
    })

    it('el número del título elige esa cita', async () => {
      const { db, rec } = await listFor(
        ['Marta Ruiz'],
        [appointment('ap-1', 'pat-1', FIRST), appointment('ap-2', 'pat-1', SECOND)],
      )
      await send(db, rec, { text: '2' })
      expect(activeStates(db)[0]).toMatchObject({ step: 'manage_menu', appointmentId: 'ap-2' })
    })
  })

  describe('escribir en la lista de citas', () => {
    const DAY2 = '2026-10-21T14:00:00.000Z'
    const open = () =>
      clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: family(),
        booking_appointments: [
          appointment('ap-1', 'pat-1', FIRST),
          appointment('ap-2', 'pat-1', DAY2),
          appointment('ap-3', 'pat-2', DAY2),
        ],
      })

    it('un nombre que es de varias citas no elige la primera: cuenta como fallo', async () => {
      const db = open()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:mine' })

      await send(db, rec, { text: 'Marta' })

      expect(activeStates(db)[0]).toMatchObject({ step: 'pick_appointment', fails: 1 })
      expect(rec.calls.some((c) => c.bodyText.includes('No entendí'))).toBe(true)
      // Nada se abrió: sigue la lista.
      expect(last(rec).ids).toEqual([apptId('ap-1'), apptId('ap-2'), apptId('ap-3')])
    })

    it('a la segunda vez pasa a una persona, como cualquier menú', async () => {
      const db = open()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:mine' })
      await send(db, rec, { text: 'Marta' })
      await send(db, rec, { text: 'Marta' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    })

    it('un nombre que es de una sola cita la elige', async () => {
      const db = open()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:mine' })

      await send(db, rec, { text: 'Tomás' })

      expect(activeStates(db)[0]).toMatchObject({ step: 'manage_menu', appointmentId: 'ap-3' })
    })

    it('el toque sigue eligiendo la cita exacta', async () => {
      const db = open()
      const rec = makeRecorder()
      await send(db, rec, { replyId: 'act:mine' })

      await send(db, rec, { replyId: apptId('ap-2') })

      expect(activeStates(db)[0]).toMatchObject({ step: 'manage_menu', appointmentId: 'ap-2' })
    })
  })

  it('elegir una cita de la lista abre su gestión', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:mine' })
    await send(db, rec, { replyId: apptId('ap-2') })
    expect(last(rec).ids).toContain('act:cancel')
    expect(activeStates(db)[0]).toMatchObject({ step: 'manage_menu', appointmentId: 'ap-2' })
  })

  it('una cita que ya no está activa no se gestiona: se repite la lista actual', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:mine' })
    db._tables.booking_appointments[1].status = 'cancelled'
    await send(db, rec, { replyId: apptId('ap-2') })
    expect(last(rec).ids).toEqual([apptId('ap-1')])
    expect(activeStates(db)[0]).toMatchObject({ step: 'pick_appointment', fails: 1 })
  })

  it('"Nueva cita" desde la gestión pregunta primero quién va a asistir', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: family(),
      booking_appointments: [appointment('ap-1', 'pat-1', FIRST)],
    })
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:mine' })
    await send(db, rec, { replyId: 'act:new' })
    expect(last(rec).bodyText).toBe(texts.patientMenuBody)
    expect(last(rec).ids).toEqual(['pat:pat-1', 'pat:pat-2', 'pat:new'])
    expect(activeStates(db)[0]).toMatchObject({ step: 'pick_patient' })
  })

  describe('un toque del recordatorio', () => {
    it('con el id confirma esa cita y no la otra', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-2') })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'confirmed' })
    })

    it('sin id y con dos citas cercanas pregunta cuál, y nada cambia hasta que elige', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: remId('confirm') })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(BOTH)
      expect(last(rec).bodyText).toContain('Marta Ruiz')
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
      expect(activeStates(db)[0]).toMatchObject({ step: 'pick_appointment', reminderAction: 'confirm' })

      await send(db, rec, { replyId: apptId('ap-2') })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'confirmed' })
      expect(db._tables.booking_sessions.map((s) => s.status)).toEqual(['completed'])
    })

    it.each(['recordatorio_cita', 'recordatorio_cita_clinica'])(
      'la etiqueta "Confirmar" que responde a %s también pregunta cuál',
      async (templateName) => {
        const db = twoAppointments()
        const rec = makeRecorder()
        const replyTo = seedTemplateMessage(db, templateName)
        await send(db, rec, { replyId: 'Confirmar', replyTo })
        expect(last(rec).ids).toEqual(BOTH)
        expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })

        await send(db, rec, { replyId: apptId('ap-1') })
        expect(statuses(db)).toEqual({ 'ap-1': 'confirmed', 'ap-2': 'pending' })
      },
    )

    it('la etiqueta de otra plantilla no pregunta ni toca nada', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      const replyTo = seedTemplateMessage(db, 'promo_noviembre')
      const result = await send(db, rec, { replyId: 'Confirmar', replyTo })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
    })

    it('si la segunda cita queda lejos, la cercana es la del toque y no pregunta', async () => {
      const db = twoAppointments({
        booking_appointments: [
          appointment('ap-1', 'pat-1', FIRST),
          appointment('ap-2', 'pat-2', '2026-10-30T15:00:00.000Z'),
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      expect(statuses(db)).toEqual({ 'ap-1': 'confirmed', 'ap-2': 'pending' })
    })

    it('Cancelar sin id pregunta cuál y solo cancela la que se elige', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('cancel') })
      expect(last(rec).ids).toEqual(BOTH)
      await send(db, rec, { replyId: apptId('ap-2') })
      expect(last(rec).ids).toEqual(['act:cancel_yes', 'act:back'])
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
      await send(db, rec, { replyId: 'act:cancel_yes' })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'cancelled' })
    })

    it('Reprogramar sin id pregunta cuál y sigue con el paciente de esa cita', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('reschedule') })
      await send(db, rec, { replyId: apptId('ap-2') })
      expect(activeStates(db)[0]).toMatchObject({
        step: 'pick_day',
        mode: 'reschedule',
        appointmentId: 'ap-2',
        patientId: 'pat-2',
      })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
    })

    it('con una sola cita cercana no pregunta', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: family(),
        booking_appointments: [appointment('ap-1', 'pat-1', FIRST)],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      expect(statuses(db)).toEqual({ 'ap-1': 'confirmed' })
    })

    it('si una de las dos ya no está activa, la que queda es la del toque', async () => {
      const db = twoAppointments({
        booking_appointments: [
          appointment('ap-1', 'pat-1', FIRST, { status: 'cancelled' }),
          appointment('ap-2', 'pat-2', SECOND),
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      expect(statuses(db)).toEqual({ 'ap-1': 'cancelled', 'ap-2': 'confirmed' })
    })

    it('sin ninguna cita activa dice que ya no está activo', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      expect(last(rec).bodyText).toContain('ya no está activo')
    })

    describe('con el id de una cita que no se puede tocar', () => {
      const cases: [string, Row][] = [
        ['de otro número', appointment('ap-x', 'pat-1', FIRST, { contact_id: 'ct-otro' })],
        ['de otra cuenta', appointment('ap-x', 'pat-1', FIRST, { account_id: 'acc-otra' })],
        ['cancelada', appointment('ap-x', 'pat-1', FIRST, { status: 'cancelled' })],
        ['ya pasada', appointment('ap-x', 'pat-1', '2026-10-18T14:00:00.000Z')],
      ]

      it.each(cases)('%s dice que ya no está activo y no cambia nada', async (_name, row) => {
        const db = twoAppointments()
        db._tables.booking_appointments.push(row)
        const before = statuses(db)
        const rec = makeRecorder()
        for (const action of ['confirm', 'reschedule', 'cancel'] as const) {
          await send(db, rec, { replyId: remId(action, 'ap-x') })
          expect(last(rec).bodyText).toContain('ya no está activo')
        }
        expect(statuses(db)).toEqual(before)
        expect(activeStates(db)).toEqual([])
      })

      it('que no existe dice que ya no está activo', async () => {
        const db = twoAppointments()
        const rec = makeRecorder()
        await send(db, rec, { replyId: remId('confirm', 'ap-ajena') })
        expect(last(rec).bodyText).toContain('ya no está activo')
        expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
      })
    })

    it('elegir una cita que ya no está activa avisa y no la toca', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('cancel') })
      db._tables.booking_appointments[1].status = 'cancelled'
      await send(db, rec, { replyId: apptId('ap-2') })
      expect(last(rec).ids).toEqual([apptId('ap-1')])
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'cancelled' })
    })

    it('elegir una cita que empezó mientras tanto no la toca', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      // Pasa un día: la primera cita ya empezó (9:00 en Bogotá), la segunda todavía no.
      const later = new Date('2026-10-20T14:30:00.000Z')
      db._tables.booking_sessions[0].expires_at = '2026-10-20T15:00:00.000Z'
      await send(db, rec, { replyId: apptId('ap-1') }, { now: later })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
    })
  })

  describe('al confirmar', () => {
    it('manda las instrucciones y el mapa de la sede', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(rec.calls.at(-2)?.bodyText).toContain('Queda confirmado')
      expect(last(rec).bodyText).toContain('Cepíllate antes de venir.')
      expect(last(rec).bodyText).toContain('Calle 1 # 2-3')
      expect(last(rec).bodyText).toContain('google.com/maps')
    })

    it('el mensaje es solo lo que escribió la clínica, la dirección y el mapa', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(last(rec).bodyText).toBe(
        texts.prepInfo({ prep: 'Cepíllate antes de venir.', address: 'Calle 1 # 2-3', mapUrl: MAP_URL }),
      )
      expect(last(rec).bodyText).not.toContain('Marta')
    })

    it('sin instrucciones del servicio manda la dirección y el mapa', async () => {
      const db = twoAppointments({
        booking_appointments: [appointment('ap-1', 'pat-1', FIRST, { service_id: SERVICE_URGENCIA })],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(last(rec).bodyText).toBe(
        texts.prepInfo({ prep: null, address: 'Calle 1 # 2-3', mapUrl: MAP_URL }),
      )
    })

    it('sin nada que decir no manda un segundo mensaje', async () => {
      const db = twoAppointments({
        booking_appointments: [appointment('ap-1', 'pat-1', FIRST, { service_id: SERVICE_URGENCIA })],
        clinic_locations: [
          {
            id: 'loc-1',
            account_id: ACCOUNT,
            name: 'Centro',
            address: null,
            latitude: null,
            longitude: null,
            on_call_phone: null,
            is_active: true,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(rec.calls).toHaveLength(1)
      expect(last(rec).bodyText).toContain('Queda confirmado')
    })

    it('confirmar al elegir de la lista también las manda', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      await send(db, rec, { replyId: apptId('ap-2') })
      expect(rec.calls.at(-2)?.bodyText).toContain('Queda confirmado')
      expect(last(rec).bodyText).toContain('Cepíllate antes de venir.')
    })

    it('una cuenta sin clínica no manda nada de eso', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') }, { modules: ['agenda'] })
      expect(rec.calls).toHaveLength(1)
      expect(last(rec).bodyText).toContain('Queda confirmado')
      expect(rec.calls.some((c) => c.bodyText.includes('Cepíllate'))).toBe(false)
    })
  })

  // El teléfono puede ser compartido: lo que se le responde a un toque de Confirmar
  // nombra al paciente, pero no el procedimiento.
  describe('la respuesta a Confirmar no nombra el procedimiento', () => {
    const confirmedFor = (patient: string | null) =>
      texts.reminderConfirmed({
        patient,
        staff: 'Dra. Ana',
        date: 'martes 20 de octubre de 2026',
        time: '9:00 a. m.',
      })

    it('dice paciente, doctor, fecha y hora', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(rec.calls.at(-2)?.bodyText).toBe(confirmedFor('Marta Ruiz'))
      expect(rec.calls.some((c) => c.bodyText.includes('Limpieza'))).toBe(false)
    })

    it('es el paciente de esa cita, no el de la otra', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-2') })
      expect(rec.calls.at(-2)?.bodyText).toContain('Tomás Gil')
      expect(rec.calls.at(-2)?.bodyText).not.toContain('Marta Ruiz')
      expect(rec.calls.at(-2)?.bodyText).toContain('10:00 a. m.')
    })

    it('al elegir la cita de la lista también', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      await send(db, rec, { replyId: apptId('ap-2') })
      expect(rec.calls.at(-2)?.bodyText).toContain('Queda confirmado')
      expect(rec.calls.some((c) => c.bodyText.includes('Limpieza'))).toBe(false)
    })

    it('con la etiqueta de la plantilla clínica también', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: family(),
        booking_appointments: [appointment('ap-1', 'pat-1', FIRST)],
      })
      const rec = makeRecorder()
      const replyTo = seedTemplateMessage(db, 'recordatorio_cita_clinica')
      await send(db, rec, { replyId: 'Confirmar', replyTo })
      expect(rec.calls.at(-2)?.bodyText).toBe(confirmedFor('Marta Ruiz'))
    })

    it('una cita sin paciente se confirma sin esa línea', async () => {
      const db = twoAppointments({
        booking_appointments: [appointment('ap-1', 'pat-borrado', FIRST, { patient_id: null })],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(rec.calls.at(-2)?.bodyText).toBe(confirmedFor(null))
    })

    it('si no se pueden leer los pacientes, se confirma igual y sin el nombre', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      const failing = {
        ...db,
        from(table: string) {
          if (table === 'clinic_patients') throw new Error('boom')
          return db.from(table)
        },
      } as typeof db
      await send(failing, rec, { replyId: remId('confirm', 'ap-1') })
      expect(statuses(db)['ap-1']).toBe('confirmed')
      expect(rec.calls.at(-2)?.bodyText).toBe(confirmedFor(null))
    })

    it('con el módulo activo pero sin su configuración tampoco', async () => {
      const db = twoAppointments({ clinic_settings: [] })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-1') })
      expect(statuses(db)['ap-1']).toBe('confirmed')
      expect(last(rec).bodyText).toContain('Queda confirmado')
      expect(rec.calls.some((c) => c.bodyText.includes('Limpieza'))).toBe(false)
    })

    it('una cuenta sin clínica sigue con el servicio en la respuesta', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') }, { modules: ['agenda'] })
      expect(last(rec).bodyText).toContain('📌 Limpieza')
      expect(last(rec).bodyText).not.toContain('Paciente')
    })
  })

  describe('una cuenta sin clínica', () => {
    it('sigue con la próxima cita activa y no pregunta cuál', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') }, { modules: ['agenda'] })
      expect(statuses(db)).toEqual({ 'ap-1': 'confirmed', 'ap-2': 'pending' })
      expect(activeStates(db)).toEqual([])
    })

    it('ignora el id del botón, como antes', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-2') }, { modules: ['agenda'] })
      expect(statuses(db)).toEqual({ 'ap-1': 'confirmed', 'ap-2': 'pending' })
    })
  })

  describe('una clínica sin configuración usable', () => {
    it('con una sola cita la confirma, sin instrucciones', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_settings: [],
        booking_appointments: [appointment('ap-1', 'pat-1', FIRST)],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm') })
      expect(statuses(db)).toEqual({ 'ap-1': 'confirmed' })
      expect(rec.calls).toHaveLength(1)
    })

    it('con el id confirma esa cita', async () => {
      const db = twoAppointments({ clinic_settings: [] })
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('confirm', 'ap-2') })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'confirmed' })
    })

    it('con dos citas cercanas y sin id no adivina: pasa a una persona', async () => {
      const db = twoAppointments({ clinic_settings: [] })
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: remId('confirm') })
      expect(result).toEqual({ consumed: true })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableNote)
    })
  })

  describe('en un hilo que lleva una persona', () => {
    const human = { humanOwned: true }

    it('el toque sin id pregunta cuál y la elección se atiende', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      const asked = await send(db, rec, { replyId: remId('confirm') }, human)
      expect(asked).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(BOTH)

      const chosen = await send(db, rec, { replyId: apptId('ap-2') }, human)
      expect(chosen).toEqual({ consumed: true })
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'confirmed' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('reprogramar elegida de la lista avisa a la persona en vez de abrir el flujo', async () => {
      const db = twoAppointments()
      const rec = makeRecorder()
      await send(db, rec, { replyId: remId('reschedule') }, human)
      await send(db, rec, { replyId: apptId('ap-1') }, human)
      expect(statuses(db)).toEqual({ 'ap-1': 'pending', 'ap-2': 'pending' })
      expect(activeStates(db)).toEqual([])
    })

    it('la lista de "Mis citas" abierta antes de que la persona tomara el hilo no se atiende', async () => {
      const db = twoAppointments({
        booking_sessions: [
          {
            id: 'ses-1',
            account_id: ACCOUNT,
            contact_id: CONTACT,
            status: 'active',
            expires_at: '2026-10-19T13:10:00.000Z',
            state: {
              step: 'pick_appointment',
              mode: 'book',
              fails: 0,
              options: BOTH.map((id) => ({ id, title: id })),
            },
          },
        ],
      })
      const rec = makeRecorder()
      const result = await send(db, rec, { replyId: apptId('ap-1') }, human)
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
    })
  })
})

describe('texto libre que pide cambiar o cancelar una cita', () => {
  const PHRASES = [
    'quiero cancelar mi cita',
    'no puedo ir a la cita',
    '¿puedo cancelar mi cita?',
    'quiero cambiar mi cita',
    'necesito reprogramar',
    'quiero mover mi cita',
  ]

  it.each(PHRASES)('sin sesión, %j lista las citas', async (text) => {
    const db = twoAppointments()
    const rec = makeRecorder()
    const result = await send(db, rec, { text })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(BOTH)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it.each(PHRASES)('con el menú abierto, %j lista las citas', async (text) => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    const result = await send(db, rec, { text })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(BOTH)
  })

  it('esperando una duda, también', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:faq' })
    const result = await send(db, rec, { text: 'quiero cancelar mi cita' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(BOTH)
  })

  it('con una sola cita va directo a gestionarla', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: family(),
      booking_appointments: [appointment('ap-1', 'pat-1', FIRST)],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'quiero cancelar mi cita' })
    expect(last(rec).ids).toContain('act:cancel')
    expect(statuses(db)).toEqual({ 'ap-1': 'pending' })
  })

  it('sin autorización, primero la autorización', async () => {
    const db = twoAppointments({ clinic_consents: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'quiero cancelar mi cita' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
    expect(rec.calls.some((c) => c.ids.includes(apptId('ap-1')))).toBe(false)
  })

  it('una duda sobre la política de cancelación sigue yendo a la IA', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿cuánto cuesta cancelar una cita?' })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })

  it('una queja por la cita sigue yendo a una persona', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { text: 'quiero poner una queja por mi cita' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('una cuenta sin clínica no cambia: abre la gestión de su próxima cita, sin lista', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'quiero cancelar mi cita' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(['act:new', 'act:reschedule', 'act:cancel'])
    expect(activeStates(db)[0]).toMatchObject({ step: 'manage_menu', appointmentId: 'ap-1' })
  })
})
