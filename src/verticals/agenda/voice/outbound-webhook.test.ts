import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkVoiceToken, voiceToken } from '@/lib/voice/tokens'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { handleOutboundWebhook } from './outbound-webhook'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// El webhook de la llamada de confirmación, de punta a punta con una base
// falsa: carga la llamada y la cita, corre la máquina de pasos y aplica el
// efecto. Aquí se prueba cada camino de teclas y la idempotencia.
//
// "Ahora" es el jueves 5 de noviembre de 2026, 10:00 en Bogotá.
// La cita es ese mismo día a las 3:30 p. m.
// ============================================================

const ACCOUNT = 'acc-1'
const OWNER = 'owner-1'
const CALL_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const STAFF = '44444444-4444-4444-8444-444444444444'
const PATIENT = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-11-05T15:00:00.000Z')
const STARTS_AT = '2026-11-05T20:30:00.000Z'
const OFFICE_HOURS = { 1: [['08:00', '18:00']], 2: [['08:00', '18:00']], 3: [['08:00', '18:00']], 4: [['08:00', '18:00']], 5: [['08:00', '18:00']] }

interface SeedOptions {
  clinic?: boolean
  settings?: Row
  appointment?: Row
  call?: Row
  noAppointment?: boolean
}

function seed(options: SeedOptions = {}): FakeDb {
  const clinic = options.clinic ?? true
  return makeCallDb({
    accounts: [
      {
        id: ACCOUNT,
        name: 'Clínica Sonrisa',
        owner_user_id: OWNER,
        modules: clinic ? ['agenda', 'clinica'] : ['agenda'],
        vertical_key: null,
      },
    ],
    booking_call_settings: [
      {
        account_id: ACCOUNT,
        outbound_enabled: true,
        inbound_number: '+576015550000',
        advisor_phones: ['+573001110000', '+573002220000'],
        office_hours: OFFICE_HOURS,
        voice: null,
        ...options.settings,
      },
    ],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        staff_id: STAFF,
        service_id: 'svc-1',
        patient_id: clinic ? PATIENT : null,
        location_id: null,
        status: 'confirmed',
        starts_at: STARTS_AT,
        attendance_confirmed_at: null,
        confirmed_at: '2026-11-01T10:00:00.000Z',
        cancel_reason: null,
        cancelled_at: null,
        ...options.appointment,
      },
    ],
    booking_services: [{ id: 'svc-1', account_id: ACCOUNT, name: 'Blanqueamiento dental' }],
    booking_staff: [{ id: STAFF, account_id: ACCOUNT, name: 'Dra. Rojas' }],
    clinic_patients: [{ id: PATIENT, account_id: ACCOUNT, full_name: 'Ana Pérez' }],
    clinic_locations: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-10-01T00:00:00.000Z' }],
    ai_configs: [],
    notifications: [],
    booking_calls: [
      callRowSeed({
        id: CALL_ID,
        appointment_id: options.noAppointment ? null : APPT,
        contact_id: options.noAppointment ? null : CONTACT,
        attempt: options.noAppointment ? null : 1,
        from_number: '+576015550000',
        to_number: '+573001112233',
        status: 'calling',
        ...options.call,
      }),
    ],
  })
}

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? []).find((row) => row.id === CALL_ID) as Row
const appointmentOf = (db: FakeDb) => (db._tables.booking_appointments ?? [])[0] as Row

const notifyPatient = vi.fn()
const kickCalendar = vi.fn()

async function hit(
  db: FakeDb,
  options: { query?: Record<string, string>; form?: Record<string, string>; now?: Date } = {},
) {
  const query = new URLSearchParams({ call: CALL_ID, ...options.query })
  query.set('t', voiceToken(CALL_ID, query))
  const result = await handleOutboundWebhook({
    db: asDb(db),
    callId: CALL_ID,
    query,
    form: { CallSid: 'CA-123', ...options.form },
    now: options.now ?? NOW,
    deps: { notifyPatient, kickCalendar },
  })
  for (const task of result.deferred) await task()
  return result
}

/** Lo que dice cada `<Say>`, sin escapes. */
const said = (xml: string) => [...xml.matchAll(/<Say [^>]*>([^<]*)<\/Say>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
const allSpeech = (xml: string) => said(xml).join(' ')
const gatherAction = (xml: string) => new URL(/<Gather action="([^"]*)"/.exec(xml)![1].replace(/&amp;/g, '&'))

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', 'secreto-de-prueba-voz')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
  notifyPatient.mockReset()
  kickCalendar.mockReset()
  notifyPatient.mockResolvedValue({ sent: true, channel: 'template' })
  kickCalendar.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('primer pedido: el menú', () => {
  it('saluda al paciente con el negocio, el día, la hora y el profesional', async () => {
    const db = seed()
    const { xml } = await hit(db)

    const speech = allSpeech(xml)
    expect(speech).toContain('asistente virtual de Clínica Sonrisa')
    expect(speech).toContain('Ana Pérez')
    expect(speech).toContain('para hoy a las 3 y media de la tarde')
    expect(speech).toContain('la doctora Rojas')
    expect(speech).toContain('marca 1')
  })

  it('una cita de otro día dice el día completo', async () => {
    const db = seed({ appointment: { starts_at: '2026-11-10T20:30:00.000Z' } })
    expect(allSpeech((await hit(db)).xml)).toContain('para el martes 10 de noviembre a las 3 y media de la tarde')
  })

  it('NUNCA nombra el procedimiento', async () => {
    const db = seed()
    const { xml } = await hit(db)
    expect(xml).not.toMatch(/blanqueamiento/i)
    expect(xml).not.toMatch(/dental/i)
  })

  it('una cuenta que no es clínica dice "tu cita" sin nombre', async () => {
    const db = seed({ clinic: false })
    const speech = allSpeech((await hit(db)).xml)
    expect(speech).toContain('tu cita')
    expect(speech).not.toContain('Ana Pérez')
  })

  it('si el nombre del paciente no se puede leer, igual saluda con "tu cita"', async () => {
    const db = seed()
    db._failNext('select', 'clinic_patients', { message: 'boom' })
    const speech = allSpeech((await hit(db)).xml)
    expect(speech).toContain('tu cita')
    expect(speech).not.toContain('Ana Pérez')
  })

  it('el Gather vuelve a la misma ruta con la llamada, el paso, la vuelta y un token válido', async () => {
    const db = seed()
    const { xml } = await hit(db)
    const action = gatherAction(xml)
    expect(action.origin + action.pathname).toBe('https://crm.example.test/api/voice/telnyx/outbound')
    expect(action.searchParams.get('call')).toBe(CALL_ID)
    expect(action.searchParams.get('step')).toBe('menu')
    expect(action.searchParams.get('loop')).toBe('1')
    expect(checkVoiceToken(CALL_ID, action.searchParams.get('t'), action.searchParams)).toBe(true)
  })

  it('guarda el CallSid la primera vez y pasa la fila a in_progress', async () => {
    const db = seed()
    await hit(db, { form: { CallSid: 'CA-777' } })
    expect(callOf(db)).toMatchObject({ provider_call_sid: 'CA-777', status: 'in_progress' })

    // Un segundo pedido (otra vuelta) con el mismo CallSid sigue y no lo cambia.
    const again = await hit(db, { form: { CallSid: 'CA-777' }, query: { loop: '2' } })
    expect(again.xml).toContain('<Gather')
    expect(callOf(db).provider_call_sid).toBe('CA-777')
  })

  it('usa la voz de la cuenta y, sin ella, la de la plataforma', async () => {
    const own = seed({ settings: { voice: 'Azure.es-CO-SalomeNeural' } })
    expect((await hit(own)).xml).toContain('voice="Azure.es-CO-SalomeNeural"')
    const def = seed()
    expect((await hit(def)).xml).toContain('voice="Polly.Mia-Neural"')
  })
})

describe('el CallSid ata la llamada a una sola llamada de Telnyx', () => {
  const HANGUP_ONLY = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'

  it('un pedido con otro CallSid cuelga y no cambia nada, aunque marque 1', async () => {
    const db = seed({ call: { provider_call_sid: 'CA-777', status: 'in_progress' } })
    const before = { call: { ...callOf(db) }, appointment: { ...appointmentOf(db) } }

    const { xml } = await hit(db, { form: { CallSid: 'CA-AJENO', Digits: '1' } })

    expect(xml).toBe(HANGUP_ONLY)
    expect(callOf(db)).toEqual(before.call)
    expect(appointmentOf(db)).toEqual(before.appointment)
    expect(notifyPatient).not.toHaveBeenCalled()
    expect(kickCalendar).not.toHaveBeenCalled()
  })

  it('un pedido sin CallSid, con la llamada ya atada, tampoco pasa', async () => {
    const db = seed({ call: { provider_call_sid: 'CA-777' } })
    const { xml } = await hit(db, { form: { CallSid: '', Digits: '1' } })
    expect(xml).toBe(HANGUP_ONLY)
    expect(callOf(db).outcome).toBeNull()
    expect(callOf(db).digits).toBeNull()
  })

  it('no repite la despedida de una llamada terminada a quien trae otro CallSid', async () => {
    const db = seed({ call: { provider_call_sid: 'CA-777', outcome: 'confirmed' } })
    const mine = await hit(db, { form: { CallSid: 'CA-777' } })
    expect(allSpeech(mine.xml)).toContain('quedó confirmada')
    const other = await hit(db, { form: { CallSid: 'CA-AJENO' } })
    expect(other.xml).toBe(HANGUP_ONLY)
  })

  it('con el CallSid correcto todo sigue igual en cada vuelta', async () => {
    const db = seed({ call: { provider_call_sid: 'CA-777', status: 'in_progress' } })
    const { xml } = await hit(db, { form: { CallSid: 'CA-777', Digits: '1' } })
    expect(allSpeech(xml)).toContain('quedó confirmada')
    expect(callOf(db)).toMatchObject({ outcome: 'confirmed', provider_call_sid: 'CA-777' })
  })

  it('un CallSid que ya es de otra llamada (23505) se rechaza sin efectos', async () => {
    const db = seed()
    db._failNext('update', 'booking_calls', { code: '23505', message: 'duplicate key value violates unique constraint' })
    const { xml } = await hit(db, { form: { CallSid: 'CA-DE-OTRA', Digits: '1' } })

    expect(xml).toBe(HANGUP_ONLY)
    expect(callOf(db)).toMatchObject({ provider_call_sid: null, outcome: null, digits: null, status: 'calling' })
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
  })

  it('dos primeros pedidos a la vez con CallSid distintos: solo uno sigue', async () => {
    const db = seed()
    const [a, b] = await Promise.all([
      hit(db, { form: { CallSid: 'CA-A', Digits: '1' } }),
      hit(db, { form: { CallSid: 'CA-B', Digits: '1' } }),
    ])
    expect([a.xml, b.xml].filter((xml) => xml === HANGUP_ONLY)).toHaveLength(1)
    expect(['CA-A', 'CA-B']).toContain(callOf(db).provider_call_sid)
    expect(appointmentOf(db).attendance_confirmed_at).not.toBeNull()
  })
})

describe('teclas del menú', () => {
  it('1 confirma la cita, dice la despedida y deja el camino', async () => {
    const db = seed()
    const { xml } = await hit(db, { form: { Digits: '1' } })

    expect(allSpeech(xml)).toContain('quedó confirmada')
    expect(xml).toContain('<Hangup/>')
    expect(appointmentOf(db)).toMatchObject({ status: 'confirmed', attendance_confirmed_at: NOW.toISOString() })
    expect(callOf(db)).toMatchObject({ outcome: 'confirmed', digits: '1', menu_path: '1' })
  })

  it('2 pregunta antes de cancelar y no cambia la cita', async () => {
    const db = seed()
    const { xml } = await hit(db, { form: { Digits: '2' } })

    expect(allSpeech(xml)).toContain('¿Seguro que quieres cancelarla?')
    const action = gatherAction(xml)
    expect(action.searchParams.get('step')).toBe('cancel')
    expect(action.searchParams.get('path')).toBe('2')
    expect(appointmentOf(db).status).toBe('confirmed')
    expect(callOf(db).outcome).toBeNull()
    expect(callOf(db).menu_path).toBe('2')
  })

  it('2 y luego 1 cancela, avisa al paciente y a Google, y deja cancelled', async () => {
    const db = seed()
    const { xml } = await hit(db, { query: { step: 'cancel', loop: '1', path: '2' }, form: { Digits: '1' } })

    expect(allSpeech(xml)).toContain('quedó cancelada')
    expect(appointmentOf(db)).toMatchObject({ status: 'cancelled', cancel_reason: 'patient_call' })
    expect(callOf(db)).toMatchObject({ outcome: 'cancelled', menu_path: '2>1' })
    expect(notifyPatient).toHaveBeenCalledTimes(1)
    expect(notifyPatient.mock.calls[0][0]).toMatchObject({ appointmentId: APPT, kind: 'cancelled' })
    expect(kickCalendar).toHaveBeenCalledWith(ACCOUNT)
  })

  it('2 y luego 2 (no) vuelve al menú y la cita queda como estaba', async () => {
    const db = seed()
    const { xml } = await hit(db, { query: { step: 'cancel', loop: '1', path: '2' }, form: { Digits: '2' } })

    expect(allSpeech(xml)).toContain('Para confirmar tu cita, marca 1')
    expect(gatherAction(xml).searchParams.get('step')).toBe('menu')
    expect(appointmentOf(db).status).toBe('confirmed')
    expect(callOf(db).outcome).toBeNull()
    expect(notifyPatient).not.toHaveBeenCalled()
  })

  it('marcar 2 y colgar sin confirmar no cancela nada', async () => {
    const db = seed()
    await hit(db, { form: { Digits: '2' } })
    // No hay más pedidos: Telnyx cierra con el estado final.
    expect(appointmentOf(db).status).toBe('confirmed')
    expect(notifyPatient).not.toHaveBeenCalled()
  })

  it('3 en horario de atención con asesores los marca a todos a la vez', async () => {
    const db = seed()
    const { xml } = await hit(db, { form: { Digits: '3' } })

    expect(allSpeech(xml)).toContain('Te comunico con un asesor')
    expect(xml).toContain('<Number>+573001110000</Number><Number>+573002220000</Number>')
    expect(xml).toContain('callerId="+576015550000"')
    expect(xml).toMatch(/<Dial action="https:\/\/crm\.example\.test\/api\/voice\/telnyx\/dial-result\?call=[^"]*t=/)
    // El resultado lo pone dial-result: todavía no hay.
    expect(callOf(db).outcome).toBeNull()
    expect(callOf(db).menu_path).toBe('3')
  })

  it('3 fuera de horario deja human, avisa al dueño y cuelga', async () => {
    const db = seed({ appointment: { starts_at: '2026-11-07T20:30:00.000Z' } })
    // Sábado 7 de noviembre, 10:00 en Bogotá: la oficina solo abre de lunes a viernes.
    const { xml } = await hit(db, { form: { Digits: '3' }, now: new Date('2026-11-07T15:00:00.000Z') })

    expect(allSpeech(xml)).toContain('alguien del equipo te va a contactar')
    expect(xml).not.toContain('<Dial')
    expect(xml).toContain('<Hangup/>')
    expect(callOf(db).outcome).toBe('human')
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({ user_id: OWNER, contact_id: CONTACT })
  })

  it('3 sin asesores configurados deja human aunque sea horario de atención', async () => {
    const db = seed({ settings: { advisor_phones: [] } })
    const { xml } = await hit(db, { form: { Digits: '3' } })
    expect(xml).not.toContain('<Dial')
    expect(callOf(db).outcome).toBe('human')
  })

  it('un festivo cuenta como cerrado para pasar con un asesor', async () => {
    const db = seed({ appointment: { starts_at: '2026-11-16T20:30:00.000Z' } })
    // Lunes 16 de noviembre de 2026: festivo (la Independencia de Cartagena, corrida al lunes).
    const { xml } = await hit(db, { form: { Digits: '3' }, now: new Date('2026-11-16T15:00:00.000Z') })
    expect(xml).not.toContain('<Dial')
    expect(callOf(db).outcome).toBe('human')
  })

  it('otra tecla dice "No entendí" y repite sin tocar nada', async () => {
    const db = seed()
    const { xml } = await hit(db, { form: { Digits: '9' } })
    expect(allSpeech(xml)).toContain('No entendí')
    expect(gatherAction(xml).searchParams.get('loop')).toBe('2')
    expect(callOf(db).outcome).toBeNull()
    expect(callOf(db).digits).toBe('9')
    expect(appointmentOf(db).status).toBe('confirmed')
  })

  it('sin tecla en la segunda vuelta repite el menú corto; pasadas las vueltas cuelga y queda no_response', async () => {
    const db = seed()
    const second = await hit(db, { query: { loop: '2' } })
    expect(allSpeech(second.xml)).toContain('Para confirmar tu cita, marca 1')

    const third = await hit(db, { query: { loop: '3' } })
    expect(allSpeech(third.xml)).toContain('No recibimos respuesta')
    expect(third.xml).toContain('<Hangup/>')
    expect(callOf(db).outcome).toBe('no_response')
    expect(appointmentOf(db).status).toBe('confirmed')
  })

  it('ignora un camino (path) que no sea de teclas y un loop descabellado', async () => {
    const db = seed()
    const { xml } = await hit(db, { query: { path: '<script>', loop: '-5' } })
    expect(gatherAction(xml).searchParams.get('path')).toBeNull()
    expect(gatherAction(xml).searchParams.get('loop')).toBe('1')
  })
})

describe('idempotencia ante reintentos de Telnyx', () => {
  it('el mismo "1" dos veces confirma una sola vez y responde igual', async () => {
    const db = seed()
    const first = await hit(db, { form: { Digits: '1' } })
    const second = await hit(db, { form: { Digits: '1' }, now: new Date(NOW.getTime() + 60_000) })

    expect(second.xml).toBe(first.xml)
    expect(appointmentOf(db).attendance_confirmed_at).toBe(NOW.toISOString())
  })

  it('el mismo "sí, cancelar" dos veces cancela y avisa una sola vez', async () => {
    const db = seed()
    const args = { query: { step: 'cancel', loop: '1', path: '2' }, form: { Digits: '1' } }
    const first = await hit(db, args)
    const second = await hit(db, args)

    expect(second.xml).toBe(first.xml)
    expect(allSpeech(second.xml)).toContain('quedó cancelada')
    expect(notifyPatient).toHaveBeenCalledTimes(1)
    expect(kickCalendar).toHaveBeenCalledTimes(1)
  })

  it('pedir el menú otra vez después de terminar repite la despedida, no el menú', async () => {
    const db = seed()
    await hit(db, { form: { Digits: '1' } })
    const again = await hit(db)
    expect(allSpeech(again.xml)).toContain('quedó confirmada')
    expect(again.xml).not.toContain('<Gather')
  })

  it('un segundo "3" que no contestó no duplica el aviso al equipo', async () => {
    const db = seed({ settings: { advisor_phones: [] } })
    await hit(db, { form: { Digits: '3' } })
    await hit(db, { form: { Digits: '3' } })
    expect(db._tables.notifications).toHaveLength(1)
  })
})

describe('la cita ya no está activa', () => {
  it.each([
    ['cancelada', { status: 'cancelled' }],
    ['completada', { status: 'completed' }],
    ['ya empezó', { starts_at: '2026-11-05T14:00:00.000Z' }],
  ])('si está %s dice que ya no está activa y no cambia nada', async (_name, appointment) => {
    const db = seed({ appointment })
    const before = { ...appointmentOf(db) }
    const { xml } = await hit(db, { form: { Digits: '1' } })

    expect(allSpeech(xml)).toContain('Esta cita ya no está activa')
    expect(xml).toContain('<Hangup/>')
    expect(appointmentOf(db)).toEqual(before)
    expect(callOf(db).outcome).toBeNull()
    expect(String(callOf(db).error)).toMatch(/ya no estaba activa/)
    expect(notifyPatient).not.toHaveBeenCalled()
  })

  it('una cita que desapareció se trata igual', async () => {
    const db = seed()
    db._tables.booking_appointments.length = 0
    const { xml } = await hit(db)
    expect(allSpeech(xml)).toContain('Esta cita ya no está activa')
  })
})

describe('llamada de prueba (sin cita)', () => {
  it('abre diciendo que es una prueba y saluda con datos de ejemplo', async () => {
    const db = seed({ noAppointment: true })
    const { xml } = await hit(db)
    const speech = said(xml)
    expect(speech[0]).toBe('Esta es una llamada de prueba. No se va a cambiar ninguna cita.')
    expect(speech.join(' ')).toContain('asistente virtual de Clínica Sonrisa')
    expect(speech.join(' ')).toContain('tu cita')
  })

  it('las teclas funcionan pero no tocan ninguna cita ni avisan a nadie', async () => {
    const db = seed({ noAppointment: true })
    await hit(db, { form: { Digits: '1' } })
    expect(callOf(db).outcome).toBe('confirmed')
    expect(appointmentOf(db)).toMatchObject({ status: 'confirmed', attendance_confirmed_at: null })
  })

  it('3 no marca a los asesores de verdad en una prueba', async () => {
    const db = seed({ noAppointment: true })
    const { xml } = await hit(db, { form: { Digits: '3' } })
    expect(xml).not.toContain('<Dial')
    expect(callOf(db).outcome).toBe('human')
    expect(db._tables.notifications).toHaveLength(0)
  })
})

describe('casos raros', () => {
  it('una llamada que no existe cuelga sin decir nada', async () => {
    const db = seed()
    db._tables.booking_calls.length = 0
    const { xml } = await hit(db)
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('una llamada entrante no se atiende por esta ruta', async () => {
    const db = seed({ call: { direction: 'inbound' } })
    const { xml } = await hit(db)
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('si no se puede guardar lo marcado, no promete nada: dice que alguien lo contactará', async () => {
    const db = seed()
    db._failNext('update', 'booking_appointments', { message: 'boom' })
    const { xml } = await hit(db, { form: { Digits: '1' } })

    expect(allSpeech(xml)).toContain('alguien del equipo te va a contactar')
    expect(allSpeech(xml)).not.toContain('quedó confirmada')
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
    expect(callOf(db).outcome).toBe('human')
  })

  it('no loguea el nombre ni el teléfono del paciente', async () => {
    const db = seed()
    db._failNext('update', 'booking_appointments', { message: 'boom' })
    await hit(db, { form: { Digits: '1' } })
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).not.toContain('Ana')
    expect(logged).not.toContain('573001112233')
  })
})
