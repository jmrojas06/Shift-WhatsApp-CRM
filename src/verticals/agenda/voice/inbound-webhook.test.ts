import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkVoiceToken } from '@/lib/voice/tokens'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { handleDialResult } from './call-events'
import { MAX_LOOPS } from './inbound-flow'
import { handleInboundWebhook } from './inbound-webhook'
import * as scripts from './scripts'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// El webhook de la llamada entrante, de punta a punta con una base falsa:
// encuentra la cuenta por el número marcado, crea la fila de la llamada, corre
// la máquina de pasos y aplica el efecto. Aquí se prueba cada rama del menú,
// el horario (fuera de horario, domingo, festivo), la falta de asesores, el
// número desconocido, la atención entrante apagada y la idempotencia.
//
// "Ahora" es el jueves 5 de noviembre de 2026, 10:00 en Bogotá (en horario).
// La cita de quien llama es el viernes 6 a las 3:30 p. m.
// ============================================================

const ACCOUNT = 'acc-1'
const OWNER = 'owner-1'
const CALL_ID = '99999999-9999-4999-8999-aaaaaaaaaaaa'
const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const STAFF = '44444444-4444-4444-8444-444444444444'
const PATIENT = '55555555-5555-4555-8555-555555555555'
const INBOUND = '+576015550000'
const CALLER = '+573001112233'
const NOW = new Date('2026-11-05T15:00:00.000Z') // jueves, 10:00 en Bogotá
const NIGHT = new Date('2026-11-06T01:00:00.000Z') // jueves, 8:00 p. m.
const SUNDAY = new Date('2026-11-08T15:00:00.000Z')
const HOLIDAY = new Date('2026-11-16T15:00:00.000Z') // lunes festivo
const STARTS_AT = '2026-11-06T20:30:00.000Z'
const OFFICE_HOURS = {
  1: [['08:00', '18:00']],
  2: [['08:00', '18:00']],
  3: [['08:00', '18:00']],
  4: [['08:00', '18:00']],
  5: [['08:00', '18:00']],
  6: [['08:00', '13:00']],
}

interface SeedOptions {
  clinic?: boolean
  settings?: Row
  call?: Row | null
  appointment?: Row | null
  location?: Row | null
  noContact?: boolean
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
        inbound_enabled: true,
        inbound_number: INBOUND,
        advisor_phones: ['+573001110000', '+573002220000'],
        office_hours: OFFICE_HOURS,
        info_text: 'Estamos en la Calle 10 # 5-20, Bogotá.',
        voice: null,
        ...options.settings,
      },
    ],
    clinic_settings: clinic
      ? [
          {
            account_id: ACCOUNT,
            consent_text: 'texto',
            consent_version: 1,
            urgency_words: [],
            urgency_alarm_text: 'Fiebre alta, hinchazón en la cara o sangrado que no para',
            urgency_service_id: null,
            offer_days: 30,
          },
        ]
      : [],
    clinic_locations:
      clinic && options.location !== null
        ? [
            {
              id: 'loc-1',
              account_id: ACCOUNT,
              name: 'Sede Norte',
              address: null,
              latitude: null,
              longitude: null,
              on_call_phone: '300 999 8877',
              is_active: true,
              created_at: '2026-10-01T00:00:00.000Z',
              ...options.location,
            },
          ]
        : [],
    booking_appointments:
      options.appointment === null
        ? []
        : [
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
    contacts: options.noContact ? [] : [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-10-01T00:00:00.000Z' }],
    ai_configs: [],
    notifications: [],
    booking_calls:
      options.call === null
        ? []
        : [
            callRowSeed({
              id: CALL_ID,
              direction: 'inbound',
              status: 'in_progress',
              contact_id: options.noContact ? null : CONTACT,
              from_number: CALLER,
              to_number: INBOUND,
              provider_call_sid: 'CA-1',
              ...options.call,
            }),
          ],
  })
}

const calls = (db: FakeDb) => db._tables.booking_calls ?? []
const callOf = (db: FakeDb) => calls(db).find((row) => row.id === CALL_ID) as Row
const appointmentOf = (db: FakeDb) => (db._tables.booking_appointments ?? [])[0] as Row

const notifyPatient = vi.fn()
const kickCalendar = vi.fn()
const sendBookingLink = vi.fn()
const ensureCaller = vi.fn()
const findContact = vi.fn()
const deps = { notifyPatient, kickCalendar, sendBookingLink, ensureCaller, findContact }

/** Un pedido de Telnyx a la ruta: el primero (sin `call`) o uno del menú. */
async function hit(
  db: FakeDb,
  options: { first?: boolean; query?: Record<string, string>; form?: Record<string, string>; now?: Date } = {},
) {
  // Con otra hora, la llamada empezó a esa hora (si no, el límite de 10 minutos la cortaría).
  const row = calls(db).find((candidate) => candidate.id === CALL_ID)
  if (options.now && row && row.created_at === NOW.toISOString()) row.created_at = options.now.toISOString()
  const query = new URLSearchParams(options.first ? {} : { call: CALL_ID, ...options.query })
  const result = await handleInboundWebhook({
    db: asDb(db),
    query,
    form: { CallSid: 'CA-1', From: CALLER, To: INBOUND, ...options.form },
    now: options.now ?? NOW,
    deps,
  })
  for (const task of result.deferred) await task()
  return result
}

/** Marca una tecla en un paso del menú. */
const press = (db: FakeDb, digits: string, options: { now?: Date; query?: Record<string, string> } = {}) =>
  hit(db, { form: { Digits: digits }, now: options.now, query: options.query })

/** Lo que dice cada `<Say>`, sin escapes. */
const said = (xml: string) =>
  [...xml.matchAll(/<Say [^>]*>([^<]*)<\/Say>/g)].map((m) =>
    m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  )
const hangsUp = (xml: string) => xml.includes('<Hangup/>')
const dialOf = (xml: string) => /<Dial [^>]*>.*<\/Dial>/.exec(xml)?.[0]
const urlOf = (xml: string, tag: 'Gather' | 'Redirect') => {
  const raw = tag === 'Gather' ? /<Gather action="([^"]*)"/.exec(xml)?.[1] : /<Redirect[^>]*>([^<]*)<\/Redirect>/.exec(xml)?.[1]
  return raw ? new URL(raw.replace(/&amp;/g, '&')) : null
}

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', 'secreto-de-prueba-voz')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
  for (const mock of [notifyPatient, kickCalendar, sendBookingLink, ensureCaller, findContact]) mock.mockReset()
  notifyPatient.mockResolvedValue({ sent: true, channel: 'template' })
  kickCalendar.mockResolvedValue(undefined)
  sendBookingLink.mockResolvedValue({ sent: true, channel: 'template' })
  ensureCaller.mockResolvedValue({ contactId: CONTACT, conversationId: 'conv-1' })
  // Como `findExistingContact`: busca entre los contactos de la base falsa.
  findContact.mockImplementation(async (db: FakeDb, accountId: string, phone: string) => {
    const found = (db._tables.contacts ?? []).find((c) => c.account_id === accountId && `+${c.phone}` === phone)
    return found ? { id: found.id } : null
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ------------------------------------------------------------
// Primer pedido
// ------------------------------------------------------------

describe('primer pedido', () => {
  it('saluda y dice el menú de una clínica (urgencia primero)', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { first: true })

    expect(said(xml)).toEqual([
      scripts.inboundGreeting({ business: 'Clínica Sonrisa' }),
      scripts.inboundMenu({ clinic: true }),
    ])
    expect(said(xml)[1]).toMatch(/^Si es una urgencia, marca 9\./)
    expect(hangsUp(xml)).toBe(false)
    expect(xml).toContain('voice="Polly.Mia-Neural"')
  })

  it('otro negocio no ofrece la urgencia', async () => {
    const db = seed({ call: null, clinic: false })
    const { xml } = await hit(db, { first: true })
    expect(said(xml)[1]).toBe(scripts.inboundMenu({ clinic: false }))
    expect(said(xml)[1]).not.toContain('marca 9')
  })

  it('crea la fila entrante del robot, con el contacto del número si ya existe', async () => {
    const db = seed({ call: null })
    await hit(db, { first: true })

    expect(calls(db)).toHaveLength(1)
    expect(calls(db)[0]).toMatchObject({
      account_id: ACCOUNT,
      direction: 'inbound',
      channel: 'robot',
      appointment_id: null,
      attempt: null,
      contact_id: CONTACT,
      from_number: CALLER,
      to_number: INBOUND,
      status: 'in_progress',
      provider_call_sid: 'CA-1',
      outcome: null,
    })
  })

  it('las URL del menú llevan el id de la llamada y su token, y el estado en la query', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { first: true })
    const id = String(calls(db)[0].id)

    const gather = urlOf(xml, 'Gather')!
    expect(gather.pathname).toBe('/api/voice/telnyx/inbound')
    expect(gather.searchParams.get('call')).toBe(id)
    expect(gather.searchParams.get('step')).toBe('menu')
    expect(gather.searchParams.get('loop')).toBe('1')
    expect(checkVoiceToken(id, gather.searchParams.get('t'), gather.searchParams)).toBe(true)

    const redirect = urlOf(xml, 'Redirect')!
    expect(redirect.searchParams.get('loop')).toBe('2')
    expect(checkVoiceToken(id, redirect.searchParams.get('t'), redirect.searchParams)).toBe(true)
  })

  it('si Telnyx reintenta el primer pedido (mismo CallSid) no duplica la llamada', async () => {
    const db = seed({ call: null })
    const first = await hit(db, { first: true })
    const retry = await hit(db, { first: true })

    expect(calls(db)).toHaveLength(1)
    expect(retry.xml).toBe(first.xml)
  })

  it('un número desconocido (sin contacto) crea la fila sin contacto y no crea ningún contacto', async () => {
    const db = seed({ call: null, noContact: true })
    await hit(db, { first: true })
    expect(calls(db)[0].contact_id).toBeNull()
    expect(ensureCaller).not.toHaveBeenCalled()
  })

  it('una llamada privada (sin número válido) igual se atiende, sin guardar el número', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { first: true, form: { From: 'anonymous' } })
    expect(said(xml)[0]).toBe(scripts.inboundGreeting({ business: 'Clínica Sonrisa' }))
    expect(calls(db)[0]).toMatchObject({ from_number: null, contact_id: null })
    expect(findContact).not.toHaveBeenCalled()
  })

  it('usa la voz configurada de la cuenta', async () => {
    const db = seed({ call: null, settings: { voice: 'Azure.es-CO-SalomeNeural' } })
    const { xml } = await hit(db, { first: true })
    expect(xml).toContain('voice="Azure.es-CO-SalomeNeural"')
    expect(xml).toContain('language="es-CO"')
  })
})

describe('número no disponible', () => {
  it('un número que no es de ninguna cuenta: lo dice, cuelga y no crea nada', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { first: true, form: { To: '+576019999999' } })
    expect(said(xml)).toEqual([scripts.numberUnavailable()])
    expect(hangsUp(xml)).toBe(true)
    expect(calls(db)).toHaveLength(0)
  })

  it('sin To en el formulario, igual', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { first: true, form: { To: '' } })
    expect(said(xml)).toEqual([scripts.numberUnavailable()])
    expect(calls(db)).toHaveLength(0)
  })

  it('con la atención entrante apagada: lo dice, cuelga y no crea nada', async () => {
    const db = seed({ call: null, settings: { inbound_enabled: false } })
    const { xml } = await hit(db, { first: true })
    expect(said(xml)).toEqual([scripts.numberUnavailable()])
    expect(hangsUp(xml)).toBe(true)
    expect(calls(db)).toHaveLength(0)
  })

  it('apagarla en medio de una llamada corta el menú', async () => {
    const db = seed({ settings: { inbound_enabled: false } })
    const { xml } = await press(db, '1')
    expect(said(xml)).toEqual([scripts.numberUnavailable()])
    expect(sendBookingLink).not.toHaveBeenCalled()
  })

  it('el número se encuentra tal cual lo manda Telnyx, con formato', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { first: true, form: { To: '+57 601 555 0000' } })
    expect(said(xml)[0]).toBe(scripts.inboundGreeting({ business: 'Clínica Sonrisa' }))
  })
})

// ------------------------------------------------------------
// 9: urgencia
// ------------------------------------------------------------

describe('9: urgencia', () => {
  const alarm = scripts.urgencyAlarm({ alarmText: 'Fiebre alta, hinchazón en la cara o sangrado que no para' })

  it('en horario lee los signos de alarma y pasa la llamada a los asesores con el número de la clínica', async () => {
    const db = seed()
    const { xml } = await press(db, '9')

    expect(said(xml)).toEqual([alarm, scripts.advisorConnecting()])
    const dial = dialOf(xml)!
    expect(dial).toContain(`callerId="${INBOUND}"`)
    expect(dial).toContain('<Number>+573001110000</Number><Number>+573002220000</Number>')
    expect(dial).toContain('timeout="25"')
    expect(dial).toContain('timeLimit="1800"')
    expect(dial).toContain('/api/voice/telnyx/dial-result?call=' + CALL_ID)
    expect(callOf(db)).toMatchObject({ menu_path: '9', digits: '9', outcome: null })
  })

  it('usa el número "que marca" de la cuenta si lo tiene', async () => {
    const db = seed({ settings: { caller_id: '+576017770000' } })
    const { xml } = await press(db, '9')
    expect(dialOf(xml)).toContain('callerId="+576017770000"')
  })

  it('fuera de horario pasa al teléfono de turno de la sede', async () => {
    const db = seed()
    const { xml } = await press(db, '9', { now: NIGHT })

    expect(said(xml)).toEqual([alarm, scripts.urgencyOnCall()])
    const dial = dialOf(xml)!
    expect(dial).toContain('<Number>+573009998877</Number>')
    expect(dial).not.toContain('+573001110000')
    expect(dial).toContain(`callerId="${INBOUND}"`)
  })

  it('un domingo y un festivo también son fuera de horario', async () => {
    for (const day of [SUNDAY, HOLIDAY]) {
      const { xml } = await press(seed(), '9', { now: day })
      expect(said(xml)[1]).toBe(scripts.urgencyOnCall())
    }
  })

  it('sin asesores configurados en horario, pasa al teléfono de turno', async () => {
    const db = seed({ settings: { advisor_phones: [] } })
    const { xml } = await press(db, '9')
    expect(dialOf(xml)).toContain('<Number>+573009998877</Number>')
  })

  it('sin teléfono de turno y fuera de horario: avisa al equipo con un aviso prioritario y cuelga', async () => {
    const db = seed({ location: { on_call_phone: null } })
    const { xml } = await press(db, '9', { now: NIGHT })

    expect(said(xml)).toEqual([alarm, scripts.urgencyNoOne()])
    expect(hangsUp(xml)).toBe(true)
    expect(dialOf(xml)).toBeUndefined()
    expect(callOf(db).outcome).toBe('urgency')
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({ account_id: ACCOUNT, user_id: OWNER, contact_id: CONTACT })
    expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:.*urgencia/i)
  })

  it('un teléfono de turno que no se puede marcar se trata como que no hay', async () => {
    const db = seed({ location: { on_call_phone: 'llamar a Juan' } })
    const { xml } = await press(db, '9', { now: NIGHT })
    expect(said(xml)[1]).toBe(scripts.urgencyNoOne())
  })

  it('un reintento de la urgencia sin a quién pasar repite la frase y no repite el aviso', async () => {
    const db = seed({ location: { on_call_phone: null } })
    await press(db, '9', { now: NIGHT })
    const retry = await press(db, '9', { now: NIGHT })
    expect(said(retry.xml)).toEqual([scripts.urgencyNoOne()])
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('otro negocio no tiene el 9: es una tecla inválida', async () => {
    const db = seed({ clinic: false })
    const { xml } = await press(db, '9')
    expect(said(xml)[0]).toBe(scripts.notUnderstood())
    expect(dialOf(xml)).toBeUndefined()
  })
})

// ------------------------------------------------------------
// 1: agendar por WhatsApp
// ------------------------------------------------------------

describe('1: agendar por WhatsApp', () => {
  it('manda el enlace al número que llamó, lo dice y cuelga', async () => {
    const db = seed()
    const { xml } = await press(db, '1')

    expect(ensureCaller).toHaveBeenCalledWith(expect.anything(), { accountId: ACCOUNT, phone: CALLER })
    expect(sendBookingLink).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, contactId: CONTACT, conversationId: 'conv-1', now: NOW }),
    )
    expect(said(xml)).toEqual([scripts.bookingLinkSent(), scripts.goodbye()])
    expect(hangsUp(xml)).toBe(true)
    expect(callOf(db)).toMatchObject({ outcome: 'booking_link_sent', menu_path: '1', digits: '1' })
  })

  it('con un número desconocido crea el contacto con el número que llamó', async () => {
    const db = seed({ noContact: true })
    ensureCaller.mockResolvedValue({ contactId: 'nuevo', conversationId: 'conv-nueva' })
    await press(db, '1')

    expect(ensureCaller).toHaveBeenCalledWith(expect.anything(), { accountId: ACCOUNT, phone: CALLER })
    expect(sendBookingLink).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'nuevo', conversationId: 'conv-nueva' }))
    expect(callOf(db).contact_id).toBe('nuevo')
  })

  it('si el envío falla lo dice, cuelga y deja anotado el motivo', async () => {
    sendBookingLink.mockResolvedValue({ sent: false, error: 'La plantilla no está aprobada.' })
    const db = seed()
    const { xml } = await press(db, '1')

    expect(said(xml)).toEqual([scripts.bookingLinkFailed(), scripts.goodbye()])
    expect(hangsUp(xml)).toBe(true)
    expect(callOf(db).outcome).toBeNull()
    expect(String(callOf(db).error)).toContain('La plantilla no está aprobada.')
  })

  it('con una llamada privada (sin número) no puede enviar y lo dice', async () => {
    const db = seed({ call: { from_number: null, contact_id: null } })
    const { xml } = await press(db, '1')
    expect(said(xml)).toEqual([scripts.bookingLinkFailed(), scripts.goodbye()])
    expect(sendBookingLink).not.toHaveBeenCalled()
  })

  it('un reintento del mismo pedido no manda el WhatsApp dos veces y repite lo dicho', async () => {
    const db = seed()
    const first = await press(db, '1')
    const retry = await press(db, '1')

    expect(sendBookingLink).toHaveBeenCalledTimes(1)
    expect(said(retry.xml)).toEqual(said(first.xml))
  })
})

// ------------------------------------------------------------
// 2: mi cita
// ------------------------------------------------------------

describe('2: mi cita', () => {
  // Solo el día y la hora: jamás el paciente ni el profesional (el teléfono se comparte o se falsifica).
  const reading = () => scripts.myAppointment({ day: 'mañana', time: 'a las 3 y media de la tarde' })

  it('lee la próxima cita activa y lleva su id en la URL', async () => {
    const db = seed()
    const { xml } = await press(db, '2')

    expect(said(xml)).toEqual([reading()])
    const gather = urlOf(xml, 'Gather')!
    expect(gather.searchParams.get('step')).toBe('appt')
    expect(gather.searchParams.get('appt')).toBe(APPT)
    expect(gather.searchParams.get('path')).toBe('2')
    expect(checkVoiceToken(CALL_ID, gather.searchParams.get('t'), gather.searchParams)).toBe(true)
    expect(callOf(db).menu_path).toBe('2')
    // Aún no cambió nada.
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
  })

  it('no nombra el procedimiento', async () => {
    const { xml } = await press(seed(), '2')
    expect(xml).not.toMatch(/blanqueamiento/i)
  })

  it.each([[true], [false]])('no nombra al paciente ni al profesional (clínica: %s)', async (clinic) => {
    const db = seed({ clinic })
    const { xml } = await press(db, '2')
    expect(said(xml)).toEqual([reading()])
    expect(xml).not.toMatch(/\bAna\b|Pérez|Rojas|[Dd]octor/)
  })

  it('1 confirma la cita', async () => {
    const db = seed()
    const { xml } = await press(db, '1', { query: { step: 'appt', loop: '1', path: '2', appt: APPT } })

    expect(said(xml)).toEqual([scripts.appointmentConfirmed()])
    expect(hangsUp(xml)).toBe(true)
    expect(appointmentOf(db)).toMatchObject({ status: 'confirmed', attendance_confirmed_at: NOW.toISOString() })
    expect(callOf(db)).toMatchObject({ outcome: 'confirmed', menu_path: '2>1' })
  })

  it('confirmar es idempotente ante un reintento', async () => {
    const db = seed()
    const query = { step: 'appt', loop: '1', path: '2', appt: APPT }
    await press(db, '1', { query })
    const retry = await press(db, '1', { query, now: new Date(NOW.getTime() + 30_000) })

    expect(said(retry.xml)).toEqual([scripts.appointmentConfirmed()])
    expect(appointmentOf(db).attendance_confirmed_at).toBe(NOW.toISOString())
  })

  it('2 pide la doble confirmación y no cancela todavía', async () => {
    const db = seed()
    const { xml } = await press(db, '2', { query: { step: 'appt', loop: '1', path: '2', appt: APPT } })

    expect(said(xml)).toEqual([scripts.cancelConfirmAsk()])
    expect(urlOf(xml, 'Gather')!.searchParams.get('step')).toBe('cancel')
    expect(urlOf(xml, 'Gather')!.searchParams.get('appt')).toBe(APPT)
    expect(appointmentOf(db).status).toBe('confirmed')
  })

  it('cancelar con un sí: cancela, avisa por WhatsApp y a Google DESPUÉS de responder', async () => {
    const db = seed()
    const result = await handleInboundWebhook({
      db: asDb(db),
      query: new URLSearchParams({ call: CALL_ID, step: 'cancel', loop: '1', path: '2>2', appt: APPT }),
      form: { CallSid: 'CA-1', From: CALLER, To: INBOUND, Digits: '1' },
      now: NOW,
      deps,
    })

    expect(said(result.xml)).toEqual([scripts.appointmentCancelled()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(appointmentOf(db)).toMatchObject({ status: 'cancelled', cancel_reason: 'patient_call' })
    expect(callOf(db)).toMatchObject({ outcome: 'cancelled', menu_path: '2>2>1' })
    // Lo lento va aparte, para no dejar a quien llama en silencio.
    expect(notifyPatient).not.toHaveBeenCalled()
    expect(result.deferred).toHaveLength(2)
    for (const task of result.deferred) await task()
    expect(notifyPatient).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: APPT, kind: 'cancelled' }))
    expect(kickCalendar).toHaveBeenCalledWith(ACCOUNT)
  })

  it('cancelar con un no: vuelve al menú y la cita queda como estaba', async () => {
    const db = seed()
    const { xml } = await press(db, '2', { query: { step: 'cancel', loop: '1', path: '2>2', appt: APPT } })

    expect(said(xml)).toEqual([scripts.inboundMenu({ clinic: true })])
    expect(urlOf(xml, 'Gather')!.searchParams.get('step')).toBe('menu')
    expect(appointmentOf(db)).toMatchObject({ status: 'confirmed', cancel_reason: null })
    expect(callOf(db).outcome).toBeNull()
  })

  it('0 en el submenú vuelve al menú', async () => {
    const db = seed()
    const { xml } = await press(db, '0', { query: { step: 'appt', loop: '1', path: '2', appt: APPT } })
    expect(said(xml)).toEqual([scripts.inboundMenu({ clinic: true })])
    expect(callOf(db).menu_path).toBe('2>0')
  })

  it('sin citas lo dice y ofrece agendar', async () => {
    const db = seed({ appointment: null })
    const { xml } = await press(db, '2')
    expect(said(xml)).toEqual([scripts.noAppointments()])
    expect(hangsUp(xml)).toBe(false)
    expect(urlOf(xml, 'Gather')!.searchParams.get('step')).toBe('menu')
  })

  it('con un número desconocido no hay citas que leer', async () => {
    const db = seed({ noContact: true })
    const { xml } = await press(db, '2')
    expect(said(xml)).toEqual([scripts.noAppointments()])
  })

  it('una cita cancelada o pasada no cuenta', async () => {
    for (const appointment of [{ status: 'cancelled' }, { starts_at: '2026-11-04T20:00:00.000Z' }]) {
      const { xml } = await press(seed({ appointment }), '2')
      expect(said(xml)).toEqual([scripts.noAppointments()])
    }
  })

  it('si la cita se canceló mientras sonaba el submenú, lo dice y no hace nada', async () => {
    const db = seed({ appointment: { status: 'cancelled' } })
    const { xml } = await press(db, '1', { query: { step: 'appt', loop: '1', path: '2', appt: APPT } })

    expect(said(xml)).toEqual([scripts.appointmentInactive()])
    expect(hangsUp(xml)).toBe(true)
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
    expect(callOf(db).outcome).toBeNull()
  })

  it('una cita de otro contacto (URL alterada) nunca se toca', async () => {
    const db = seed({ appointment: { contact_id: 'otro-contacto' } })
    const { xml } = await press(db, '2', { query: { step: 'cancel', loop: '1', path: '2>2', appt: APPT } })

    expect(said(xml)).toEqual([scripts.appointmentInactive()])
    expect(appointmentOf(db).status).toBe('confirmed')
    expect(notifyPatient).not.toHaveBeenCalled()
  })

  it('un paso de cita sin id en la URL no hace nada', async () => {
    const db = seed()
    const { xml } = await press(db, '1', { query: { step: 'appt', loop: '1', path: '2' } })
    expect(said(xml)).toEqual([scripts.appointmentInactive()])
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
  })

  it('si la base no deja confirmar, no promete: avisa al equipo y lo dice', async () => {
    const db = seed()
    db._failNext('update', 'booking_appointments', { message: 'boom' })
    const { xml } = await press(db, '1', { query: { step: 'appt', loop: '1', path: '2', appt: APPT } })

    expect(said(xml)).toEqual([scripts.humanFollowUp()])
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
    expect(callOf(db).outcome).toBe('human')
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('si no se pueden leer las citas la ruta lanza (no dice "no tienes citas")', async () => {
    const db = seed()
    db._failNext('select', 'booking_appointments', { message: 'boom' })
    await expect(press(db, '2')).rejects.toThrow()
  })
})

// ------------------------------------------------------------
// 3: horario y dirección
// ------------------------------------------------------------

describe('3: horario y dirección', () => {
  it('lee el texto del negocio, vuelve al menú y deja el resultado info', async () => {
    const db = seed()
    const { xml } = await press(db, '3')

    expect(said(xml)).toEqual([
      scripts.officeInfo({ infoText: 'Estamos en la Calle 10 # 5-20, Bogotá.', officeHours: {} }),
      scripts.inboundMenu({ clinic: true }),
    ])
    expect(said(xml)[0]).toBe('Estamos en la Calle 10 número 5-20, Bogotá.')
    expect(hangsUp(xml)).toBe(false)
    expect(callOf(db)).toMatchObject({ outcome: 'info', menu_path: '3' })
  })

  it('sin texto lee el horario de atención generado', async () => {
    const db = seed({ settings: { info_text: '' } })
    const { xml } = await press(db, '3')
    expect(said(xml)[0]).toBe(
      'Atendemos de lunes a viernes de 8 de la mañana a 6 de la tarde y los sábados de 8 de la mañana a 1 de la tarde.',
    )
  })

  it('leer el horario y luego confirmar la cita deja confirmed, no info', async () => {
    const db = seed()
    await press(db, '3')
    expect(callOf(db).outcome).toBe('info')
    await press(db, '1', { query: { step: 'appt', loop: '1', path: '3>2', appt: APPT } })
    expect(callOf(db).outcome).toBe('confirmed')
    expect(appointmentOf(db).attendance_confirmed_at).toBe(NOW.toISOString())
  })
})

// ------------------------------------------------------------
// 0: asesor
// ------------------------------------------------------------

describe('0: asesor', () => {
  it('en horario dice "Te comunico" y marca a los asesores a la vez, con el número de la clínica', async () => {
    const db = seed()
    const { xml } = await press(db, '0')

    expect(said(xml)).toEqual([scripts.advisorConnecting()])
    const dial = dialOf(xml)!
    expect(dial).toContain(`callerId="${INBOUND}"`)
    expect(dial).toContain('<Number>+573001110000</Number><Number>+573002220000</Number>')
    expect(dial).toContain('timeout="25"')
    expect(dial).toContain('timeLimit="1800"')
    expect(dial).toContain('method="POST"')
    // El resultado lo recibe la ruta compartida dial-result, con el id de la llamada.
    expect(dial).toContain(`/api/voice/telnyx/dial-result?call=${CALL_ID}`)
    expect(callOf(db)).toMatchObject({ menu_path: '0', outcome: null })
  })

  it('fuera de horario dice el horario y vuelve al menú (resultado out_of_hours)', async () => {
    const db = seed()
    const { xml } = await press(db, '0', { now: NIGHT })

    expect(said(xml)).toEqual([
      scripts.outOfHours({ officeHours: OFFICE_HOURS as never }),
      scripts.inboundMenu({ clinic: true }),
    ])
    expect(said(xml)[0]).toContain('Atendemos de lunes a viernes de 8 de la mañana a 6 de la tarde')
    expect(dialOf(xml)).toBeUndefined()
    expect(hangsUp(xml)).toBe(false)
    expect(callOf(db).outcome).toBe('out_of_hours')
  })

  it('un domingo es fuera de horario', async () => {
    const { xml } = await press(seed(), '0', { now: SUNDAY })
    expect(said(xml)[0]).toContain('fuera del horario de atención')
    expect(dialOf(xml)).toBeUndefined()
  })

  it('un festivo es fuera de horario aunque el día tenga horario', async () => {
    const db = seed()
    const { xml } = await press(db, '0', { now: HOLIDAY })
    expect(said(xml)[0]).toContain('fuera del horario de atención')
    expect(dialOf(xml)).toBeUndefined()
    expect(callOf(db).outcome).toBe('out_of_hours')
  })

  it('el sábado dentro de su horario sí pasa la llamada', async () => {
    const saturday = new Date('2026-11-07T15:00:00.000Z') // sábado, 10:00
    const { xml } = await press(seed(), '0', { now: saturday })
    expect(dialOf(xml)).toBeDefined()
  })

  it('sin horario configurado nunca pasa la llamada', async () => {
    const db = seed({ settings: { office_hours: {} } })
    const { xml } = await press(db, '0')
    expect(dialOf(xml)).toBeUndefined()
    expect(said(xml)[0]).toBe(scripts.outOfHours({ officeHours: {} }))
  })

  it('si nadie contesta el Dial: advisor_missed, aviso al equipo y se lo dice a quien llama', async () => {
    const db = seed()
    await press(db, '3') // leyó el horario antes: el resultado de paso se reemplaza
    await press(db, '0')
    expect(callOf(db).outcome).toBe('info')

    // Telnyx avisa a la ruta compartida dial-result, con el id de la llamada.
    const { xml } = await handleDialResult({
      db: asDb(db),
      callId: CALL_ID,
      form: { CallSid: 'CA-1', DialCallStatus: 'no-answer' },
      now: NOW,
    })
    expect(said(xml)).toEqual([scripts.advisorMissed()])
    expect(hangsUp(xml)).toBe(true)
    expect(callOf(db).outcome).toBe('advisor_missed')
    expect(db._tables.notifications).toHaveLength(1)
    expect(String(db._tables.notifications[0].body)).toContain('Ana Pérez')
  })

  it('si el asesor contesta el Dial: advisor_connected y solo se cuelga al terminar', async () => {
    const db = seed()
    await press(db, '0')
    const { xml } = await handleDialResult({
      db: asDb(db),
      callId: CALL_ID,
      form: { CallSid: 'CA-1', DialCallStatus: 'completed' },
      now: NOW,
    })
    expect(said(xml)).toEqual([])
    expect(callOf(db).outcome).toBe('advisor_connected')
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('en horario pero sin asesores: avisa al equipo, lo dice y cuelga', async () => {
    const db = seed({ settings: { advisor_phones: [] } })
    const { xml } = await press(db, '0')

    expect(said(xml)).toEqual([scripts.advisorMissed()])
    expect(hangsUp(xml)).toBe(true)
    expect(dialOf(xml)).toBeUndefined()
    expect(callOf(db).outcome).toBe('advisor_missed')
    expect(db._tables.notifications).toHaveLength(1)
    expect(String(db._tables.notifications[0].title)).toMatch(/^Llamada:/)
    expect(String(db._tables.notifications[0].body)).toContain('Ana Pérez')
  })

  it('un reintento sin asesores no repite el aviso', async () => {
    const db = seed({ settings: { advisor_phones: [] } })
    await press(db, '0')
    const retry = await press(db, '0')
    expect(said(retry.xml)).toEqual([scripts.advisorMissed()])
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('pedir un asesor fuera de horario y luego agendar deja booking_link_sent', async () => {
    const db = seed()
    await press(db, '0', { now: NIGHT })
    await press(db, '1', { now: NIGHT })
    expect(callOf(db).outcome).toBe('booking_link_sent')
  })
})

// ------------------------------------------------------------
// Repeticiones, teclas malas y límites
// ------------------------------------------------------------

describe('sin respuesta y teclas inválidas', () => {
  it('se repite el menú hasta dos veces y luego se despide', async () => {
    const db = seed()
    for (const loop of [2, 3]) {
      const { xml } = await hit(db, { query: { step: 'menu', loop: String(loop) } })
      expect(said(xml)).toEqual([scripts.inboundMenu({ clinic: true })])
      expect(urlOf(xml, 'Redirect')!.searchParams.get('loop')).toBe(String(loop + 1))
    }
    const end = await hit(db, { query: { step: 'menu', loop: String(MAX_LOOPS + 1) } })
    expect(said(end.xml)).toEqual([scripts.thanksGoodbye()])
    expect(hangsUp(end.xml)).toBe(true)
    expect(callOf(db).outcome).toBe('no_response')
  })

  it('una vuelta mayor que el máximo en la URL se acota', async () => {
    const db = seed()
    const { xml } = await hit(db, { query: { step: 'menu', loop: '9999' } })
    expect(said(xml)).toEqual([scripts.thanksGoodbye()])
  })

  it('una tecla inválida dice "No entendí" y repite; no toca nada', async () => {
    const db = seed()
    const { xml } = await press(db, '7')
    expect(said(xml)).toEqual([scripts.notUnderstood(), scripts.inboundMenu({ clinic: true })])
    expect(callOf(db)).toMatchObject({ digits: '7', outcome: null })
    expect(sendBookingLink).not.toHaveBeenCalled()
  })

  it('después de varias teclas malas se despide', async () => {
    const db = seed()
    const { xml } = await press(db, '7', { query: { step: 'menu', loop: String(MAX_LOOPS) } })
    expect(said(xml)).toEqual([scripts.notUnderstood(), scripts.thanksGoodbye()])
    expect(hangsUp(xml)).toBe(true)
  })

  it('un paso desconocido en la URL cae al menú', async () => {
    const { xml } = await hit(seed(), { query: { step: 'borrar-todo', loop: '2' } })
    expect(said(xml)).toEqual([scripts.inboundMenu({ clinic: true })])
  })

  it('el camino del menú se guarda y nunca pasa de 60 caracteres', async () => {
    const db = seed()
    const path = Array.from({ length: 30 }, () => '3').join('>')
    await press(db, '3', { query: { step: 'menu', loop: '1', path } })
    expect(String(callOf(db).menu_path).length).toBeLessThanOrEqual(60)
    // Un camino alterado en la URL (no son teclas) se ignora.
    await press(db, '3', { query: { step: 'menu', loop: '1', path: "<script>'; drop" } })
    expect(callOf(db).menu_path).toBe('3')
  })
})

describe('límite de 10 minutos del robot', () => {
  const created = new Date(NOW.getTime() - 11 * 60 * 1000).toISOString()

  it('pasado el límite, en horario, pasa la llamada al asesor', async () => {
    const db = seed({ call: { created_at: created } })
    const { xml } = await press(db, '3')
    expect(said(xml)).toEqual([scripts.advisorConnecting()])
    expect(dialOf(xml)).toBeDefined()
  })

  it('pasado el límite, fuera de horario, se despide y cuelga', async () => {
    const db = seed({ call: { created_at: new Date(NIGHT.getTime() - 11 * 60 * 1000).toISOString() } })
    const { xml } = await press(db, '3', { now: NIGHT })
    expect(said(xml)).toEqual([scripts.thanksGoodbye()])
    expect(hangsUp(xml)).toBe(true)
  })

  it('antes de los 10 minutos sigue el menú', async () => {
    const db = seed({ call: { created_at: new Date(NOW.getTime() - 9 * 60 * 1000).toISOString() } })
    const { xml } = await press(db, '3')
    expect(dialOf(xml)).toBeUndefined()
  })
})

// ------------------------------------------------------------
// Estado de la llamada
// ------------------------------------------------------------

describe('llamadas que no se atienden', () => {
  it('un id de llamada que no existe cuelga sin decir nada', async () => {
    const db = seed({ call: null })
    const { xml } = await hit(db, { query: { call: '88888888-8888-4888-8888-888888888888' } })
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('un id que no es uuid nunca llega a la base', async () => {
    const db = seed()
    const { xml } = await hit(db, { query: { call: 'no-es-uuid' } })
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('una llamada saliente no se atiende como entrante', async () => {
    const db = seed({ call: { direction: 'outbound', appointment_id: APPT, attempt: 1 } })
    const { xml } = await press(db, '1')
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
    expect(sendBookingLink).not.toHaveBeenCalled()
  })

  it('una llamada ya terminada no revive', async () => {
    const db = seed({ call: { status: 'completed' } })
    const { xml } = await press(db, '1')
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
    expect(sendBookingLink).not.toHaveBeenCalled()
  })
})

describe('el CallSid ata la llamada a una sola llamada de Telnyx', () => {
  const HANGUP_ONLY = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
  const confirmArgs = { query: { step: 'appt', loop: '1', path: '2', appt: APPT } }

  it('un pedido del menú con otro CallSid cuelga y no cambia nada, aunque confirme', async () => {
    const db = seed()
    const before = { call: { ...callOf(db) }, appointment: { ...appointmentOf(db) } }

    const { xml } = await hit(db, { form: { CallSid: 'CA-AJENO', Digits: '1' }, ...confirmArgs })

    expect(xml).toBe(HANGUP_ONLY)
    expect(callOf(db)).toEqual(before.call)
    expect(appointmentOf(db)).toEqual(before.appointment)
    expect(notifyPatient).not.toHaveBeenCalled()
  })

  it('un pedido sin CallSid, con la llamada ya atada, tampoco pasa', async () => {
    const db = seed()
    const { xml } = await hit(db, { form: { CallSid: '', Digits: '1' }, ...confirmArgs })
    expect(xml).toBe(HANGUP_ONLY)
    expect(callOf(db).outcome).toBeNull()
  })

  it('con el CallSid de la llamada todo sigue igual', async () => {
    const db = seed()
    const { xml } = await hit(db, { form: { CallSid: 'CA-1', Digits: '1' }, ...confirmArgs })
    expect(said(xml)).toEqual([scripts.appointmentConfirmed()])
    expect(callOf(db).outcome).toBe('confirmed')
  })

  it('una llamada sin CallSid guardado se ata al del primer pedido del menú que lo trae', async () => {
    const db = seed({ call: { provider_call_sid: null } })
    await hit(db, { form: { CallSid: 'CA-7', Digits: '3' } })
    expect(callOf(db).provider_call_sid).toBe('CA-7')
    const other = await hit(db, { form: { CallSid: 'CA-8', Digits: '3' } })
    expect(other.xml).toBe(HANGUP_ONLY)
  })

  it('un CallSid que ya es de otra llamada (23505) se rechaza sin efectos', async () => {
    const db = seed({ call: { provider_call_sid: null } })
    db._tables.booking_calls.push(callRowSeed({ id: 'x-otra', direction: 'inbound', provider_call_sid: 'CA-DE-OTRA' }))
    const { xml } = await hit(db, { form: { CallSid: 'CA-DE-OTRA', Digits: '1' }, ...confirmArgs })
    expect(xml).toBe(HANGUP_ONLY)
    expect(callOf(db)).toMatchObject({ provider_call_sid: null, outcome: null })
    expect(appointmentOf(db).attendance_confirmed_at).toBeNull()
  })

  it('el primer pedido reintentado por Telnyx (mismo CallSid) sigue encontrando su fila', async () => {
    const db = seed({ call: null })
    await hit(db, { first: true })
    const retry = await hit(db, { first: true })
    expect(retry.xml).toContain('<Gather')
    expect(calls(db)).toHaveLength(1)
  })
})

describe('reintentos: un resultado final se repite sin efectos', () => {
  it.each([
    ['confirmed', scripts.appointmentConfirmed()],
    ['cancelled', scripts.appointmentCancelled()],
    ['advisor_missed', scripts.advisorMissed()],
    ['urgency', scripts.urgencyNoOne()],
  ] as const)('%s', async (outcome, phrase) => {
    const db = seed({ call: { outcome } })
    const { xml } = await press(db, '1')
    expect(said(xml)).toContain(phrase)
    expect(hangsUp(xml)).toBe(true)
    expect(sendBookingLink).not.toHaveBeenCalled()
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('un resultado de paso (info) deja seguir el menú', async () => {
    const db = seed({ call: { outcome: 'info' } })
    const { xml } = await press(db, '1')
    expect(sendBookingLink).toHaveBeenCalledTimes(1)
    expect(said(xml)).toEqual([scripts.bookingLinkSent(), scripts.goodbye()])
  })
})

// ------------------------------------------------------------
// Privacidad
// ------------------------------------------------------------

describe('privacidad', () => {
  it('ningún log lleva el número ni el nombre de quien llama, ni siquiera cuando algo falla', async () => {
    const db = seed()
    ensureCaller.mockRejectedValue(new Error('error con 573001112233 y Ana Pérez'))
    sendBookingLink.mockResolvedValue({ sent: false, error: 'Falló.' })
    await press(db, '1')
    notifyPatient.mockRejectedValue(new Error('573001112233 Ana Pérez'))
    await press(db, '1', { query: { step: 'cancel', loop: '1', path: '2>2', appt: APPT } })

    const logged = [console.error, console.log, console.warn]
      .flatMap((fn) => vi.mocked(fn).mock.calls)
      .flat()
      .join(' ')
    expect(logged).not.toContain('573001112233')
    expect(logged).not.toContain('Ana Pérez')
  })
})
