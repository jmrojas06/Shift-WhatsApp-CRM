import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { AGENDA_AGENT_TEXTS } from '../texts'
import { patId, svcId } from './state'
import {
  ACCOUNT,
  CONTACT,
  LOCATION,
  SERVICE_LIMPIEZA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
  type Recorder,
} from './testing/clinic-harness'
import type { FakeDb, Row } from './testing/fake-db'

const texts = buildClinicTexts(DEFAULT_LABELS)

const OTHER_CONTACT = 'ct-2'
const OTHER_ACCOUNT = 'acc-2'

const family = (): Row[] => [
  { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
  { id: 'pat-2', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil' },
]

/** Pacientes que existen pero NO son de este contacto en esta cuenta. */
const strangers = (): Row[] => [
  { id: 'pat-ajeno', account_id: ACCOUNT, contact_id: OTHER_CONTACT, full_name: 'Ajeno Gil' },
  { id: 'pat-otra-cuenta', account_id: OTHER_ACCOUNT, contact_id: CONTACT, full_name: 'Otra Cuenta' },
]

const session = (state: Record<string, unknown>): Row => ({
  id: 'ses-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: { mode: 'book', options: [], fails: 0, ...state },
})

const sessionState = (db: FakeDb) =>
  db._tables.booking_sessions.find((s) => s.status === 'active')?.state as
    | { step: string; fails: number; patientId?: string }
    | undefined

/** Del menú a "Agendar" y, con el paciente ya elegido, hasta confirmar. */
async function confirmBooking(db: FakeDb, rec: Recorder) {
  await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
  await send(db, rec, { replyId: last(rec).ids[0] }) // día
  await send(db, rec, { replyId: last(rec).ids[0] }) // hora
  await send(db, rec, { replyId: 'act:confirm' })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pacientes por número', () => {
  it('sin pacientes pide el nombre y lo registra', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    expect(last(rec).bodyText).toContain('nombre y los apellidos')
    expect(sessionState(db)?.step).toBe('new_patient_name')

    await send(db, rec, { text: 'Tomás Gil Ruiz' })
    expect(db._tables.clinic_patients).toMatchObject([
      { account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil Ruiz' },
    ])
    expect(last(rec).ids).toContain(svcId(SERVICE_LIMPIEZA))
    expect(sessionState(db)).toMatchObject({
      step: 'pick_service',
      fails: 0,
      patientId: db._tables.clinic_patients[0].id,
    })
  })

  it('un nombre incompleto se vuelve a pedir, y al segundo fallo pasa a una persona', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })

    await send(db, rec, { text: 'Juan' })
    expect(rec.calls.at(-2)?.bodyText).toBe(texts.patientNameRetry)
    expect(rec.calls.at(-2)?.bodyText).toContain('Necesito nombre y apellidos')
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 1 })

    await send(db, rec, { text: 'Juan' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
    expect(db._tables.clinic_patients).toHaveLength(0)
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it('un fallo seguido de un nombre completo no deja huella: nace con 0 fallos', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { text: 'Juan' })
    await send(db, rec, { text: 'Juan Pérez' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(sessionState(db)).toMatchObject({ step: 'pick_service', fails: 0 })
  })

  it('con varios pacientes los ofrece junto a "Otra persona"', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).bodyText).toBe(texts.patientMenuBody)
    expect(last(rec).titles).toEqual(['Marta Ruiz', 'Tomás Gil', texts.patientOther])
    expect(last(rec).ids).toEqual([patId('pat-1'), patId('pat-2'), patId('new')])
  })

  it('solo ofrece los pacientes de este contacto en esta cuenta', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: [...family(), ...strangers()],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).titles).toEqual(['Marta Ruiz', 'Tomás Gil', texts.patientOther])
  })

  it('con muchos pacientes caben en la lista junto a "Otra persona"', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `pat-${String(i).padStart(2, '0')}`,
      account_id: ACCOUNT,
      contact_id: CONTACT,
      full_name: `Paciente ${String.fromCharCode(65 + i)} Gil`,
    }))
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: many })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).kind).toBe('list')
    expect(last(rec).ids).toHaveLength(10)
    expect(last(rec).ids.at(-1)).toBe(patId('new'))
  })

  it('la cita queda a nombre del paciente elegido, en la sede de la clínica', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { replyId: patId('pat-2') })
    await confirmBooking(db, rec)
    expect(db._tables.booking_appointments).toMatchObject([
      { patient_id: 'pat-2', location_id: LOCATION, contact_id: CONTACT },
    ])
  })

  it('también se puede elegir escribiendo el nombre o el número', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { text: 'tomas gil' })
    expect(sessionState(db)).toMatchObject({ step: 'pick_service', patientId: 'pat-2' })

    const db2 = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec2 = makeRecorder()
    await send(db2, rec2, { text: 'Hola' })
    await send(db2, rec2, { replyId: 'act:book' })
    await send(db2, rec2, { text: '1' })
    expect(sessionState(db2)).toMatchObject({ step: 'pick_service', patientId: 'pat-1' })
  })

  it('"Otra persona" pide el nombre, la registra y la cita queda a su nombre', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { replyId: patId('new') })
    expect(last(rec).bodyText).toBe(texts.patientNamePrompt)

    await send(db, rec, { text: 'Lucía Gil Ruiz' })
    const created = db._tables.clinic_patients.find((p) => p.full_name === 'Lucía Gil Ruiz')
    expect(created).toMatchObject({ account_id: ACCOUNT, contact_id: CONTACT })
    await confirmBooking(db, rec)
    expect(db._tables.booking_appointments).toMatchObject([{ patient_id: created?.id }])
  })

  it('un fallo en el menú de personas no se arrastra al nombre', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { text: 'no sé' })
    expect(sessionState(db)).toMatchObject({ step: 'pick_patient', fails: 1 })

    await send(db, rec, { replyId: patId('new') })
    expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 0 })

    // Un solo nombre malo no debe pasar a una persona.
    await send(db, rec, { text: 'Juan' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 1 })

    // El segundo sí.
    await send(db, rec, { text: 'Juan' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('elegir a alguien del menú olvida los fallos anteriores', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { text: 'no sé' })
    await send(db, rec, { replyId: patId('pat-1') })
    expect(sessionState(db)).toMatchObject({ step: 'pick_service', fails: 0, patientId: 'pat-1' })
  })

  describe('un paciente solo se elige si es de este contacto y de esta cuenta', () => {
    it('un id que no está en el menú no se puede elegir', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: [...family(), ...strangers()],
      })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { replyId: patId('ajeno') })
      expect(last(rec).titles).toContain(texts.patientOther)
      expect(sessionState(db)).toMatchObject({ step: 'pick_patient', fails: 1 })
      expect(sessionState(db)?.patientId).toBeUndefined()
    })

    it.each(['pat-ajeno', 'pat-otra-cuenta', 'pat-no-existe'])(
      'aunque el menú guardado lo traiga (%s), la base manda',
      async (id) => {
        const db = clinicDb({
          clinic_consents: [grantedConsent()],
          clinic_patients: [...family(), ...strangers()],
          booking_sessions: [
            session({
              step: 'pick_patient',
              options: [
                { id: patId(id), title: 'Intruso' },
                { id: patId('new'), title: texts.patientOther },
              ],
            }),
          ],
        })
        const rec = makeRecorder()
        await send(db, rec, { replyId: patId(id) })
        expect(sessionState(db)?.patientId).toBeUndefined()
        expect(sessionState(db)).toMatchObject({ step: 'pick_patient', fails: 1 })
        // Vuelve a mostrar solo a las personas de este contacto.
        expect(last(rec).titles).toEqual(['Marta Ruiz', 'Tomás Gil', texts.patientOther])
        expect(db._tables.booking_appointments).toHaveLength(0)
      },
    )

    it('un paciente que dejó de ser de este contacto no se agenda aunque el menú siga abierto', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        clinic_patients: [family()[0]],
        booking_sessions: [
          session({
            step: 'pick_patient',
            options: [
              { id: patId('pat-1'), title: 'Marta Ruiz' },
              { id: patId('pat-2'), title: 'Tomás Gil' },
              { id: patId('new'), title: texts.patientOther },
            ],
          }),
        ],
      })
      const rec = makeRecorder()
      await send(db, rec, { replyId: patId('pat-2') })
      expect(sessionState(db)?.patientId).toBeUndefined()
      expect(last(rec).titles).toEqual(['Marta Ruiz', texts.patientOther])
    })
  })

  describe('mientras escribe el nombre no cuentan las palabras de otros temas', () => {
    it.each(['Paz Documento', 'Camila Pago Receta', 'Dolor Pérez', 'Ana Queja Gil', 'Rosa Factura'])(
      '"%s" es un nombre: no pasa a una persona, ni por documentos ni por urgencia',
      async (name) => {
        const db = clinicDb({ clinic_consents: [grantedConsent()] })
        const rec = makeRecorder()
        await send(db, rec, { text: 'Hola' })
        await send(db, rec, { replyId: 'act:book' })
        const result = await send(db, rec, { text: name })

        expect(result).toEqual({ consumed: true })
        expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
        expect(db._tables.notifications).toHaveLength(0)
        expect(db._tables.clinic_patients).toMatchObject([{ full_name: name }])
        expect(last(rec).ids).toContain(svcId(SERVICE_LIMPIEZA))
      },
    )

    it('un nombre con "persona" o "humano" tampoco es un pedido de asesor', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { text: 'Ana Persona Humano' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(db._tables.clinic_patients).toMatchObject([{ full_name: 'Ana Persona Humano' }])
    })

    it('pero pedir un asesor, solo, sigue pasando a una persona', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { text: 'asesor' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.clinic_patients).toHaveLength(0)
    })

    it('fuera del paso del nombre, esas mismas palabras sí pasan a una persona', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { text: 'Necesito mi documento' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    })
  })

  describe('lo que no es un nombre', () => {
    it.each(['[Unsupported message type: sticker]', '[Unsupported message type: image]', '', '12345 678'])(
      'no se registra como paciente: %j',
      async (text) => {
        const db = clinicDb({ clinic_consents: [grantedConsent()] })
        const rec = makeRecorder()
        await send(db, rec, { text: 'Hola' })
        await send(db, rec, { replyId: 'act:book' })
        await send(db, rec, { text })
        expect(db._tables.clinic_patients).toHaveLength(0)
        expect(rec.calls.at(-2)?.bodyText).toBe(texts.patientNameRetry)
        expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 1 })
      },
    )

    it('un toque viejo de un botón no se toma como nombre', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
      expect(db._tables.clinic_patients).toHaveLength(0)
      expect(rec.calls.at(-2)?.bodyText).toBe(texts.patientNameRetry)
      expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 1 })
    })

    it('un botón del menú tampoco es un nombre: empieza de nuevo, sin contar fallo', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { replyId: 'act:book' })
      expect(db._tables.clinic_patients).toHaveLength(0)
      expect(rec.calls.some((c) => c.bodyText === texts.patientNameRetry)).toBe(false)
      expect(last(rec).bodyText).toBe(texts.patientNamePrompt)
      expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 0 })
    })

    it('"Tengo una urgencia" mientras escribe el nombre abre los signos, no pide el nombre otra vez', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { replyId: 'act:urgent' })
      expect(rec.calls.some((c) => c.bodyText === texts.patientNameRetry)).toBe(false)
      expect(last(rec).bodyText).toBe(texts.urgencyBody('Signos de alarma'))
      expect(sessionState(db)).toMatchObject({ step: 'urgency' })
    })
  })

  describe('si no se pudo guardar', () => {
    it('avisa, no crea al paciente y deja volver a intentar', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })

      db._failNext('insert', 'clinic_patients', { message: 'caída' })
      await send(db, rec, { text: 'Tomás Gil Ruiz' })
      expect(rec.calls.at(-2)?.bodyText).toBe(texts.patientSaveError)
      expect(db._tables.clinic_patients).toHaveLength(0)
      expect(sessionState(db)).toMatchObject({ step: 'new_patient_name', fails: 1 })

      await send(db, rec, { text: 'Tomás Gil Ruiz' })
      expect(db._tables.clinic_patients).toMatchObject([{ full_name: 'Tomás Gil Ruiz' }])
      expect(sessionState(db)).toMatchObject({ step: 'pick_service', fails: 0 })
    })

    it('si falla dos veces seguidas pasa a una persona', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      db._failNext('insert', 'clinic_patients', { message: 'caída' })
      db._failNext('insert', 'clinic_patients', { message: 'caída' })
      await send(db, rec, { text: 'Tomás Gil Ruiz' })
      await send(db, rec, { text: 'Tomás Gil Ruiz' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      expect(db._tables.clinic_patients).toHaveLength(0)
    })
  })

  describe('el nombre del paciente no sale en logs, avisos ni notas', () => {
    const NAME = 'Eleuterio Zambrano Quintero'

    const everythingLogged = (spies: { mock: { calls: unknown[][] } }[]) =>
      JSON.stringify(
        spies.flatMap((spy) =>
          spy.mock.calls.map((args) =>
            args.map((arg) => (arg instanceof Error ? arg.message : arg)),
          ),
        ),
      )

    it('ni cuando se registra, ni cuando se agenda', async () => {
      const spies = [
        vi.spyOn(console, 'error').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'info').mockImplementation(() => {}),
      ]
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { text: NAME })
      await confirmBooking(db, rec)
      expect(db._tables.booking_appointments).toHaveLength(1)
      expect(everythingLogged(spies)).not.toContain('Zambrano')
    })

    it('ni cuando la base falla al guardarlo', async () => {
      const spies = [
        vi.spyOn(console, 'error').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
      ]
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      db._failNext('insert', 'clinic_patients', { message: 'caída' })
      await send(db, rec, { text: NAME })
      expect(spies[0]).toHaveBeenCalled()
      expect(everythingLogged(spies)).not.toContain('Zambrano')
      expect(everythingLogged(spies)).not.toContain('Eleuterio')
    })

    it('ni en el aviso ni en la nota cuando el nombre falla y pasa a una persona', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:book' })
      await send(db, rec, { text: 'Eleuterio' })
      await send(db, rec, { text: 'Eleuterio' })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
      const written = JSON.stringify([
        db._tables.notifications,
        db._tables.conversations,
        db._tables.booking_events,
      ])
      expect(written).not.toContain('Eleuterio')
    })
  })
})

describe('la cita conserva al paciente', () => {
  const oldAppointment = (extra: Row = {}): Row => ({
    id: 'ap-old',
    account_id: ACCOUNT,
    contact_id: CONTACT,
    service_id: SERVICE_LIMPIEZA,
    staff_id: STAFF_ANA,
    starts_at: '2026-10-20T15:00:00.000Z',
    ends_at: '2026-10-20T15:30:00.000Z',
    status: 'confirmed',
    answers: {},
    ...extra,
  })

  async function reschedule(db: FakeDb) {
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'rem:reschedule' })
    await send(db, rec, { replyId: last(rec).ids[0] }) // día
    await send(db, rec, { replyId: last(rec).ids[0] }) // hora
    await send(db, rec, { replyId: 'act:confirm' })
    return rec
  }

  it('al reprogramar, la cita nueva es del mismo paciente', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: family(),
      booking_appointments: [oldAppointment({ patient_id: 'pat-2' })],
    })
    await reschedule(db)
    const [old, fresh] = db._tables.booking_appointments
    expect(old).toMatchObject({ id: 'ap-old', status: 'cancelled' })
    expect(fresh).toMatchObject({
      patient_id: 'pat-2',
      location_id: LOCATION,
      rescheduled_from: 'ap-old',
      status: 'confirmed',
    })
  })

  it('una cita sin paciente (anterior al módulo) se reprograma sin inventarle uno', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: family(),
      booking_appointments: [oldAppointment()],
    })
    await reschedule(db)
    const fresh = db._tables.booking_appointments[1]
    expect(fresh).toMatchObject({ rescheduled_from: 'ap-old', status: 'confirmed' })
    expect('patient_id' in fresh).toBe(false)
  })
})

describe('una cuenta sin clínica no cambia', () => {
  it('la cita no lleva paciente ni sede, y no se toca la tabla de pacientes', async () => {
    const db = clinicDb({ clinic_patients: family() })
    const rec = makeRecorder()
    const agenda = { modules: ['agenda' as const] }
    await send(db, rec, { text: 'Hola' }, agenda)
    expect(last(rec).ids[0]).toBe(svcId(SERVICE_LIMPIEZA))
    await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) }, agenda)
    await send(db, rec, { replyId: last(rec).ids[0] }, agenda) // día
    await send(db, rec, { replyId: last(rec).ids[0] }, agenda) // hora
    await send(db, rec, { replyId: 'act:confirm' }, agenda)

    expect(db._tables.booking_appointments).toHaveLength(1)
    const row = db._tables.booking_appointments[0]
    expect('patient_id' in row).toBe(false)
    expect('location_id' in row).toBe(false)
    expect(db._tables.clinic_patients).toEqual(family())
  })
})
