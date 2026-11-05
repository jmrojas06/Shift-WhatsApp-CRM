import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StartCallArgs, StartCallResult, VoiceProvider } from '@/lib/voice/telnyx'
import { checkVoiceToken } from '@/lib/voice/tokens'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import {
  CANDIDATE_PAGE_SIZE,
  decideAttempt,
  MAX_CANDIDATE_PAGES,
  NO_CALL_TAG,
  runOutboundCalls,
  type CallHistoryItem,
} from './outbound-runner'
import { asDb, makeCallDb } from './testing/call-test-db'

// ============================================================
// El cron de llamadas de confirmación (§6.2): quién se llama y quién no.
//
// "Ahora" es el jueves 5 de noviembre de 2026, 10:00 en Bogotá. La cita de
// la cuenta es ese mismo día a las 4:00 p. m. (6 horas adelante) y su
// recordatorio de 24 h salió ayer a esa hora (hace 24 h).
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const APPT = '77777777-7777-4777-8777-777777777777'
const NOW = new Date('2026-11-05T15:00:00.000Z')
const STARTS_AT = '2026-11-05T21:00:00.000Z'
const REMINDER_AT = '2026-11-04T21:00:00.000Z'

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const minutesAhead = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()

interface SeedOptions {
  clinic?: boolean
  settings?: Row
  appointment?: Row
  appointments?: Row[]
  contact?: Row
  tags?: Row[]
  contactTags?: Row[]
  consents?: Row[]
  calls?: Row[]
  modules?: string[]
}

function seed(options: SeedOptions = {}): FakeDb {
  const clinic = options.clinic ?? false
  return makeCallDb({
    accounts: [
      {
        id: ACCOUNT,
        name: 'Clínica Sonrisa',
        owner_user_id: 'owner-1',
        modules: options.modules ?? (clinic ? ['agenda', 'clinica'] : ['agenda']),
        vertical_key: null,
      },
      { id: OTHER_ACCOUNT, name: 'Otra', owner_user_id: 'owner-2', modules: ['agenda'], vertical_key: null },
    ],
    booking_call_settings: [
      {
        account_id: ACCOUNT,
        outbound_enabled: true,
        inbound_enabled: false,
        inbound_number: '+576015550000',
        caller_id: null,
        advisor_phones: [],
        office_hours: {},
        call_after_minutes: 180,
        min_lead_minutes: 120,
        max_attempts: 2,
        retry_minutes: 90,
        window_start: '08:00',
        window_end: '19:00',
        call_saturday: true,
        monthly_limit: 300,
        voice: null,
        ...options.settings,
      },
      // Otra cuenta con las salientes apagadas: nunca se llama.
      { account_id: OTHER_ACCOUNT, outbound_enabled: false, inbound_number: '+576015559999' },
    ],
    booking_appointments: options.appointments ?? [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        status: 'confirmed',
        starts_at: STARTS_AT,
        reminder_sent_at: REMINDER_AT,
        attendance_confirmed_at: null,
        ...options.appointment,
      },
    ],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233', ...options.contact }],
    tags: options.tags ?? [],
    contact_tags: options.contactTags ?? [],
    clinic_consents: options.consents ?? [],
    booking_calls: options.calls ?? [],
  })
}

/** Una llamada ya hecha a la cita. */
function pastCall(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    account_id: ACCOUNT,
    direction: 'outbound',
    channel: 'robot',
    appointment_id: APPT,
    contact_id: CONTACT,
    attempt: 1,
    status: 'no_answer',
    outcome: 'no_response',
    created_at: minutesAgo(200),
    ...overrides,
  }
}

interface FakeProvider extends VoiceProvider {
  calls: StartCallArgs[]
}

function fakeProvider(respond: (args: StartCallArgs) => StartCallResult = () => ({ ok: true })): FakeProvider {
  const calls: StartCallArgs[] = []
  return {
    calls,
    async startCall(args) {
      calls.push(args)
      return respond(args)
    },
  }
}

const robotRows = (db: FakeDb) =>
  (db._tables.booking_calls ?? []).filter((row) => row.direction === 'outbound' && row.channel === 'robot')

async function run(db: FakeDb, options: { provider?: VoiceProvider | null; now?: Date; limit?: number } = {}) {
  const provider = options.provider === undefined ? fakeProvider() : options.provider
  return runOutboundCalls({ db: asDb(db), provider, now: options.now ?? NOW, limit: options.limit })
}

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', 'secreto-de-prueba-voz')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('la llamada, de punta a punta', () => {
  it('llama a la cita que cumple todo y guarda la fila en calling', async () => {
    const db = seed()
    const provider = fakeProvider()
    const summary = await run(db, { provider })

    expect(summary).toMatchObject({ accounts: 1, inWindow: 1, considered: 1, called: 1, failed: 0, claimedByOther: 0 })
    expect(summary.credentialsMissing).toEqual([])
    expect(provider.calls).toHaveLength(1)

    const rows = robotRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      account_id: ACCOUNT,
      appointment_id: APPT,
      contact_id: CONTACT,
      attempt: 1,
      status: 'calling',
      from_number: '+576015550000',
      to_number: '+573001112233',
      created_by: null,
    })
  })

  it('arma las URL firmadas con el id de la fila y el token de esa llamada', async () => {
    const db = seed()
    const provider = fakeProvider()
    await run(db, { provider })

    const callId = robotRows(db)[0].id as string
    const call = provider.calls[0]
    expect(call).toMatchObject({ to: '+573001112233', from: '+576015550000' })

    const url = new URL(call.url)
    expect(url.origin + url.pathname).toBe('https://crm.example.test/api/voice/telnyx/outbound')
    expect(url.searchParams.get('call')).toBe(callId)
    expect(url.searchParams.get('step')).toBe('menu')
    expect(url.searchParams.get('loop')).toBe('1')
    expect(checkVoiceToken(callId, url.searchParams.get('t'), url.searchParams)).toBe(true)

    const status = new URL(call.statusCallback)
    expect(status.pathname).toBe('/api/voice/telnyx/status')
    expect(status.searchParams.get('call')).toBe(callId)
    expect(checkVoiceToken(callId, status.searchParams.get('t'), status.searchParams)).toBe(true)
  })

  it('el número que marca es caller_id y, si no hay, el número de entrantes', async () => {
    const withCallerId = seed({ settings: { caller_id: '+576015551111' } })
    const provider = fakeProvider()
    await run(withCallerId, { provider })
    expect(provider.calls[0].from).toBe('+576015551111')
  })

  it('sin ningún número que marcar no llama y lo dice', async () => {
    const db = seed({ settings: { inbound_number: null, caller_id: null } })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.no_caller_id).toBe(1)
    expect(robotRows(db)).toHaveLength(0)
  })

  it('si Telnyx rechaza la llamada, la fila queda failed con el error y se sigue con las demás', async () => {
    const second = {
      id: '77777777-7777-4777-8777-777777777778',
      account_id: ACCOUNT,
      contact_id: CONTACT,
      status: 'pending',
      starts_at: '2026-11-05T22:00:00.000Z',
      reminder_sent_at: REMINDER_AT,
      attendance_confirmed_at: null,
    }
    const db = seed({
      appointments: [
        { id: APPT, account_id: ACCOUNT, contact_id: CONTACT, status: 'confirmed', starts_at: STARTS_AT, reminder_sent_at: REMINDER_AT, attendance_confirmed_at: null },
        second,
      ],
    })
    let n = 0
    const provider = fakeProvider(() => (++n === 1 ? { ok: false, error: 'Telnyx rechazó la llamada (400): 10015 Invalid parameter' } : { ok: true }))
    const summary = await run(db, { provider })

    expect(provider.calls).toHaveLength(2)
    expect(summary).toMatchObject({ called: 1, failed: 1 })
    const rows = robotRows(db)
    expect(rows.find((r) => r.appointment_id === APPT)).toMatchObject({
      status: 'failed',
      error: 'Telnyx rechazó la llamada (400): 10015 Invalid parameter',
    })
    expect(rows.find((r) => r.appointment_id === second.id)?.status).toBe('calling')
    expect(rows.find((r) => r.appointment_id === APPT)?.finished_at).toBeTruthy()
  })

  it('el error guardado cabe en la columna (300) aunque Telnyx hable de más', async () => {
    const db = seed()
    await run(db, { provider: fakeProvider(() => ({ ok: false, error: 'x'.repeat(900) })) })
    expect(String(robotRows(db)[0].error).length).toBeLessThanOrEqual(300)
  })

  it('no incluye el teléfono ni el nombre en el resumen ni en los logs', async () => {
    const db = seed()
    const summary = await run(db, { provider: fakeProvider(() => ({ ok: false, error: 'rechazada' })) })
    const text = JSON.stringify(summary) + vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(text).not.toContain('573001112233')
    expect(text).not.toContain('Ana')
  })
})

describe('credenciales y días cerrados', () => {
  it('sin credenciales no hace nada y dice cuáles faltan', async () => {
    const db = seed()
    const summary = await runOutboundCalls({
      db: asDb(db),
      provider: null,
      missingCredentials: ['TELNYX_API_KEY', 'VOICE_WEBHOOK_SECRET'],
      now: NOW,
    })
    expect(summary.credentialsMissing).toEqual(['TELNYX_API_KEY', 'VOICE_WEBHOOK_SECRET'])
    expect(summary.called).toBe(0)
    expect(robotRows(db)).toHaveLength(0)
  })

  it('el domingo no llama a nadie', async () => {
    const db = seed({ appointment: { starts_at: '2026-11-08T21:00:00.000Z' } })
    const provider = fakeProvider()
    // Domingo 8 de noviembre, 10:00 en Bogotá.
    const summary = await run(db, { provider, now: new Date('2026-11-08T15:00:00.000Z') })
    expect(summary.closedDay).toBe('sunday')
    expect(provider.calls).toHaveLength(0)
    expect(robotRows(db)).toHaveLength(0)
  })

  it('un festivo no llama a nadie', async () => {
    const db = seed({ appointment: { starts_at: '2026-11-16T21:00:00.000Z', reminder_sent_at: '2026-11-15T21:00:00.000Z' } })
    const provider = fakeProvider()
    // Lunes 16 de noviembre de 2026: la Independencia de Cartagena, corrida al lunes.
    const summary = await run(db, { provider, now: new Date('2026-11-16T15:00:00.000Z') })
    expect(summary.closedDay).toBe('holiday')
    expect(provider.calls).toHaveLength(0)
  })

  it('el sábado llama solo si call_saturday está prendido', async () => {
    const appointment = { starts_at: '2026-11-07T21:00:00.000Z', reminder_sent_at: '2026-11-06T21:00:00.000Z' }
    const saturday = new Date('2026-11-07T15:00:00.000Z')

    const off = seed({ appointment, settings: { call_saturday: false } })
    const noCalls = fakeProvider()
    const offSummary = await run(off, { provider: noCalls, now: saturday })
    expect(noCalls.calls).toHaveLength(0)
    expect(offSummary.inWindow).toBe(0)

    const on = seed({ appointment, settings: { call_saturday: true } })
    const calls = fakeProvider()
    await run(on, { provider: calls, now: saturday })
    expect(calls.calls).toHaveLength(1)
  })

  it('solo llama dentro de la ventana de la cuenta (inicio incluido, fin no)', async () => {
    const db = () => seed({ settings: { window_start: '09:00', window_end: '17:00' } })
    // 8:59, 9:00, 16:59 y 17:00 en Bogotá.
    const cases: [string, number][] = [
      ['2026-11-05T13:59:00.000Z', 0],
      ['2026-11-05T14:00:00.000Z', 1],
      ['2026-11-05T21:59:00.000Z', 1],
      ['2026-11-05T22:00:00.000Z', 0],
    ]
    for (const [iso, expected] of cases) {
      const provider = fakeProvider()
      // La cita queda lejos para que el margen mínimo no la saque.
      const d = db()
      d._tables.booking_appointments[0].starts_at = '2026-11-06T21:00:00.000Z'
      await run(d, { provider, now: new Date(iso) })
      expect(provider.calls, iso).toHaveLength(expected)
    }
  })

  it('una cuenta con las salientes apagadas, o sin el módulo agenda, nunca se llama', async () => {
    const off = seed({ settings: { outbound_enabled: false } })
    const noModule = seed({ modules: ['ventas'] })
    for (const db of [off, noModule]) {
      const provider = fakeProvider()
      await run(db, { provider })
      expect(provider.calls).toHaveLength(0)
    }
  })
})

describe('qué citas se llaman', () => {
  const cases: [string, Row][] = [
    ['ya confirmada por el paciente', { attendance_confirmed_at: minutesAgo(30) }],
    ['cancelada', { status: 'cancelled' }],
    ['completada', { status: 'completed' }],
    ['no_show', { status: 'no_show' }],
    ['ya empezó', { starts_at: minutesAgo(10) }],
    ['faltan menos de 2 horas (min_lead_minutes)', { starts_at: minutesAhead(119) }],
    ['sin recordatorio de 24 h', { reminder_sent_at: null }],
    ['el recordatorio salió hace menos de 180 minutos', { reminder_sent_at: minutesAgo(179) }],
  ]

  it.each(cases)('no llama a una cita %s', async (_name, appointment) => {
    const db = seed({ appointment })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(robotRows(db)).toHaveLength(0)
  })

  it('el margen exacto sí cuenta: 180 minutos desde el recordatorio y 2 horas antes de la cita', async () => {
    const db = seed({ appointment: { reminder_sent_at: minutesAgo(180), starts_at: minutesAhead(121) } })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(1)
  })

  it('respeta los minutos de la cuenta (call_after_minutes y min_lead_minutes)', async () => {
    const db = seed({
      settings: { call_after_minutes: 600, min_lead_minutes: 30 },
      appointment: { reminder_sent_at: minutesAgo(599), starts_at: minutesAhead(45) },
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
  })

  it('llama primero a las citas más cercanas', async () => {
    const appointments = [
      { id: 'late', account_id: ACCOUNT, contact_id: CONTACT, status: 'confirmed', starts_at: '2026-11-05T23:00:00.000Z', reminder_sent_at: REMINDER_AT, attendance_confirmed_at: null },
      { id: 'soon', account_id: ACCOUNT, contact_id: CONTACT, status: 'confirmed', starts_at: '2026-11-05T21:00:00.000Z', reminder_sent_at: REMINDER_AT, attendance_confirmed_at: null },
    ]
    const db = seed({ appointments })
    await run(db)
    expect(robotRows(db).map((r) => r.appointment_id)).toEqual(['soon', 'late'])
  })

  it('no mezcla citas de otras cuentas', async () => {
    const db = seed({
      appointments: [
        { id: 'foreign', account_id: OTHER_ACCOUNT, contact_id: CONTACT, status: 'confirmed', starts_at: STARTS_AT, reminder_sent_at: REMINDER_AT, attendance_confirmed_at: null },
      ],
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
  })
})

describe('intentos y reintentos', () => {
  it('no pasa de max_attempts', async () => {
    const db = seed({ calls: [pastCall({ attempt: 1, created_at: minutesAgo(400) }), pastCall({ attempt: 2, created_at: minutesAgo(250) })] })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.attempts).toBe(1)
  })

  it('con max_attempts 3 hace el tercer intento (attempt 3)', async () => {
    const db = seed({
      settings: { max_attempts: 3 },
      calls: [pastCall({ attempt: 1, created_at: minutesAgo(400) }), pastCall({ attempt: 2, created_at: minutesAgo(250) })],
    })
    await run(db)
    expect(robotRows(db).map((r) => r.attempt).sort()).toEqual([1, 2, 3])
  })

  it('espera retry_minutes entre intentos', async () => {
    const tooSoon = seed({ calls: [pastCall({ created_at: minutesAgo(89) })] })
    const waiting = fakeProvider()
    const summary = await run(tooSoon, { provider: waiting })
    expect(waiting.calls).toHaveLength(0)
    expect(summary.skipped.retry_wait).toBe(1)

    const ready = seed({ calls: [pastCall({ created_at: minutesAgo(90) })] })
    const calling = fakeProvider()
    await run(ready, { provider: calling })
    expect(calling.calls).toHaveLength(1)
    expect(robotRows(ready).map((r) => r.attempt).sort()).toEqual([1, 2])
  })

  it('no llama de nuevo mientras el intento anterior sigue en curso', async () => {
    const db = seed({
      settings: { retry_minutes: 1 },
      calls: [pastCall({ status: 'in_progress', outcome: null, created_at: minutesAgo(5) })],
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.in_flight).toBe(1)
  })

  it('un intento "en curso" de hace más de 15 minutos se da por terminado (se perdió la señal final)', async () => {
    const db = seed({
      settings: { retry_minutes: 1 },
      calls: [pastCall({ status: 'calling', outcome: null, created_at: minutesAgo(16) })],
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(1)
  })

  it.each(['human', 'advisor_missed', 'advisor_connected', 'cancelled', 'confirmed'])(
    'si la llamada anterior terminó en %s, una persona se encarga: no vuelve a llamar',
    async (outcome) => {
      const db = seed({ calls: [pastCall({ outcome, status: 'completed' })] })
      const provider = fakeProvider()
      const summary = await run(db, { provider })
      expect(provider.calls).toHaveLength(0)
      expect(summary.skipped.handled).toBe(1)
    },
  )

  it('una llamada a mano con número equivocado también frena al robot', async () => {
    const db = seed({
      calls: [pastCall({ channel: 'manual', attempt: null, status: 'completed', outcome: 'wrong_number', created_at: minutesAgo(300) })],
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
  })

  it('una llamada a mano reciente también hace esperar, pero no cuenta como intento', async () => {
    const recent = seed({
      calls: [pastCall({ channel: 'manual', attempt: null, status: 'completed', outcome: 'no_response', created_at: minutesAgo(10) })],
    })
    const waiting = fakeProvider()
    await run(recent, { provider: waiting })
    expect(waiting.calls).toHaveLength(0)

    const old = seed({
      calls: [pastCall({ channel: 'manual', attempt: null, status: 'completed', outcome: 'no_response', created_at: minutesAgo(300) })],
    })
    const calling = fakeProvider()
    await run(old, { provider: calling })
    expect(calling.calls).toHaveLength(1)
    expect(robotRows(old).find((r) => r.status === 'calling')?.attempt).toBe(1)
  })

  it('dos corridas seguidas no llaman dos veces a la misma cita', async () => {
    const db = seed()
    const provider = fakeProvider()
    await run(db, { provider })
    await run(db, { provider, now: new Date(NOW.getTime() + 10 * 60_000) })
    expect(provider.calls).toHaveLength(1)
  })

  it('si otra corrida reclamó el intento (23505), no llama y lo cuenta', async () => {
    const db = seed()
    db._failNext('insert', 'booking_calls', {
      code: '23505',
      message: 'duplicate key value violates unique constraint "idx_booking_calls_robot_attempt"',
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary).toMatchObject({ claimedByOther: 1, called: 0, failed: 0 })
  })

  it('el índice único de verdad: dos corridas que leen lo mismo solo hacen una llamada', async () => {
    const db = seed()
    const provider = fakeProvider()
    const [a, b] = await Promise.all([run(db, { provider }), run(db, { provider })])
    expect(provider.calls).toHaveLength(1)
    expect(a.called + b.called).toBe(1)
    expect(a.claimedByOther + b.claimedByOther).toBe(1)
  })
})

describe('tope del mes', () => {
  it('no llama si ya se usaron monthly_limit llamadas salientes del mes', async () => {
    const used = Array.from({ length: 2 }, (_, i) =>
      pastCall({ appointment_id: `other-${i}`, attempt: 1, created_at: '2026-11-02T15:00:00.000Z' }),
    )
    const db = seed({ settings: { monthly_limit: 2 }, calls: used })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.monthly_limit).toBe(1)
  })

  it('al llegar al tope en plena corrida lo cuenta UNA vez por cuenta, no una por cita que queda', async () => {
    const appointments = Array.from({ length: 5 }, (_, n) => appointmentAt(`appt-${n}`, n))
    const used = [pastCall({ appointment_id: 'old', attempt: 1, created_at: '2026-11-02T15:00:00.000Z' })]
    const db = seed({ appointments, settings: { monthly_limit: 3 }, calls: used })
    const provider = fakeProvider()
    const summary = await run(db, { provider })

    expect(provider.calls).toHaveLength(2)
    expect(summary.skipped.monthly_limit).toBe(1)
  })

  it('no pasa del tope aunque haya más citas: llama hasta completarlo', async () => {
    const startTimes = ['2026-11-05T21:00:00.000Z', '2026-11-05T22:00:00.000Z', '2026-11-05T23:00:00.000Z']
    const appointments = startTimes.map((startsAt, n) => ({
      id: `appt-${n}`,
      account_id: ACCOUNT,
      contact_id: CONTACT,
      status: 'confirmed',
      starts_at: startsAt,
      reminder_sent_at: REMINDER_AT,
      attendance_confirmed_at: null,
    }))
    const used = [pastCall({ appointment_id: 'old', attempt: 1, created_at: '2026-11-02T15:00:00.000Z' })]
    const db = seed({ appointments, settings: { monthly_limit: 3 }, calls: used })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(2)
  })

  it('las llamadas fallidas, las del mes pasado, las entrantes y las manuales no cuentan', async () => {
    const calls = [
      pastCall({ appointment_id: 'a', status: 'failed', created_at: '2026-11-02T15:00:00.000Z' }),
      pastCall({ appointment_id: 'b', created_at: '2026-10-31T15:00:00.000Z' }),
      pastCall({ appointment_id: null, attempt: null, direction: 'inbound', created_at: '2026-11-03T15:00:00.000Z' }),
      pastCall({ appointment_id: 'c', channel: 'manual', attempt: null, created_at: '2026-11-03T15:00:00.000Z' }),
    ]
    const db = seed({ settings: { monthly_limit: 1 }, calls })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(1)
  })

  it('el mes empieza el día 1 a la medianoche de Bogotá', async () => {
    // 1 de noviembre 00:30 en Bogotá = 05:30 UTC: ya es noviembre.
    const justIn = seed({
      settings: { monthly_limit: 1 },
      calls: [pastCall({ appointment_id: 'a', created_at: '2026-11-01T05:30:00.000Z' })],
    })
    const blocked = fakeProvider()
    await run(justIn, { provider: blocked })
    expect(blocked.calls).toHaveLength(0)

    // 31 de octubre 23:30 en Bogotá = 04:30 UTC del 1 de noviembre: todavía es octubre.
    const justOut = seed({
      settings: { monthly_limit: 1 },
      calls: [pastCall({ appointment_id: 'a', created_at: '2026-11-01T04:30:00.000Z' })],
    })
    const allowed = fakeProvider()
    await run(justOut, { provider: allowed })
    expect(allowed.calls).toHaveLength(1)
  })

  it('un tope en 0 apaga las salientes de esa cuenta', async () => {
    const db = seed({ settings: { monthly_limit: 0 } })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
  })
})

describe('a quién no se llama', () => {
  it('un contacto sin teléfono, o con uno inválido', async () => {
    for (const phone of [null, '', 'no es un número', '123']) {
      const db = seed({ contact: { phone } })
      const provider = fakeProvider()
      const summary = await run(db, { provider })
      expect(provider.calls, String(phone)).toHaveLength(0)
      expect(summary.skipped.no_phone).toBe(1)
      expect(robotRows(db)).toHaveLength(0)
    }
  })

  it('un teléfono con signos se limpia: "+57 300 111 2233" → +573001112233', async () => {
    const db = seed({ contact: { phone: '+57 300 111 2233' } })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls[0].to).toBe('+573001112233')
  })

  it('con la etiqueta no-llamar', async () => {
    const db = seed({
      tags: [{ id: 'tag-nc', account_id: ACCOUNT, name: NO_CALL_TAG }],
      contactTags: [{ contact_id: CONTACT, tag_id: 'tag-nc' }],
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(NO_CALL_TAG).toBe('no-llamar')
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.no_call).toBe(1)
  })

  it('con la etiqueta de baja de envíos', async () => {
    const db = seed({
      tags: [{ id: 'tag-baja', account_id: ACCOUNT, name: 'baja-envios' }],
      contactTags: [{ contact_id: CONTACT, tag_id: 'tag-baja' }],
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.opted_out).toBe(1)
  })

  it('una etiqueta cualquiera o la de otra persona no frena', async () => {
    const db = seed({
      tags: [
        { id: 'tag-vip', account_id: ACCOUNT, name: 'vip' },
        { id: 'tag-nc', account_id: ACCOUNT, name: NO_CALL_TAG },
      ],
      contactTags: [
        { contact_id: CONTACT, tag_id: 'tag-vip' },
        { contact_id: 'otro-contacto', tag_id: 'tag-nc' },
      ],
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(1)
  })

  it('en una clínica, con la autorización revocada', async () => {
    const db = seed({
      clinic: true,
      consents: [
        { account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: true, created_at: '2026-10-01T00:00:00.000Z' },
        { account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: false, created_at: '2026-10-20T00:00:00.000Z' },
      ],
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.skipped.consent_revoked).toBe(1)
  })

  it('en una clínica, la baja de envíos también frena', async () => {
    const db = seed({
      clinic: true,
      tags: [{ id: 'tag-baja', account_id: ACCOUNT, name: 'baja-envios' }],
      contactTags: [{ contact_id: CONTACT, tag_id: 'tag-baja' }],
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
  })

  it('en una clínica, autorizada o sin ninguna fila de autorización sí se llama', async () => {
    const granted = seed({
      clinic: true,
      consents: [{ account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: true, created_at: '2026-10-01T00:00:00.000Z' }],
    })
    const withNone = seed({ clinic: true })
    for (const db of [granted, withNone]) {
      const provider = fakeProvider()
      await run(db, { provider })
      expect(provider.calls).toHaveLength(1)
    }
  })

  it('fuera de una clínica la autorización no se mira', async () => {
    const db = seed({
      clinic: false,
      consents: [{ account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: false, created_at: '2026-10-20T00:00:00.000Z' }],
    })
    const provider = fakeProvider()
    await run(db, { provider })
    expect(provider.calls).toHaveLength(1)
  })

  it('si no se puede leer la autorización, no llama (no saber no es "puede")', async () => {
    const db = seed({ clinic: true })
    db._failNext('select', 'clinic_consents', { message: 'boom' })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(0)
    expect(summary.failed).toBe(1)
    expect(robotRows(db)).toHaveLength(0)
  })
})

/** Una cita llamable (con su recordatorio de 24 h ya enviado) que empieza `offsetMinutes` después de STARTS_AT. */
function appointmentAt(id: string, offsetMinutes: number, overrides: Row = {}): Row {
  return {
    id,
    account_id: ACCOUNT,
    contact_id: CONTACT,
    status: 'confirmed',
    starts_at: new Date(Date.parse(STARTS_AT) + offsetMinutes * 60_000).toISOString(),
    reminder_sent_at: REMINDER_AT,
    attendance_confirmed_at: null,
    ...overrides,
  }
}

/** Una llamada que deja la cita en manos de una persona: el robot la salta ('handled'). */
const handledCall = (appointmentId: string): Row =>
  pastCall({ id: crypto.randomUUID(), appointment_id: appointmentId, outcome: 'human', status: 'completed' })

describe('muchas citas saltadas no tapan a las que sí se llaman', () => {
  it('una cita llamable detrás de más de 100 saltadas se llama igual (se pasa de página)', async () => {
    const skipped = Array.from({ length: CANDIDATE_PAGE_SIZE + 5 }, (_, n) => appointmentAt(`skip-${String(n).padStart(3, '0')}`, n))
    const callable = appointmentAt('callable', 500)
    const db = seed({
      appointments: [...skipped, callable],
      calls: skipped.map((appointment) => handledCall(String(appointment.id))),
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })

    expect(provider.calls).toHaveLength(1)
    expect(robotRows(db).filter((row) => row.status === 'calling').map((row) => row.appointment_id)).toEqual(['callable'])
    expect(summary).toMatchObject({ called: 1, considered: skipped.length + 1 })
    expect(summary.skipped.handled).toBe(skipped.length)
  })

  it('con muchas citas a la MISMA hora, el desempate por id recorre todas (ninguna se repite ni se pierde)', async () => {
    const sameTime = Array.from({ length: CANDIDATE_PAGE_SIZE + 20 }, (_, n) => appointmentAt(`same-${String(n).padStart(3, '0')}`, 0))
    const callable = appointmentAt('same-999', 0)
    const db = seed({
      appointments: [...sameTime, callable],
      calls: sameTime.map((appointment) => handledCall(String(appointment.id))),
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })

    expect(provider.calls).toHaveLength(1)
    expect(robotRows(db).find((row) => row.status === 'calling')?.appointment_id).toBe('same-999')
    expect(summary.considered).toBe(sameTime.length + 1)
    expect(summary.skipped.handled).toBe(sameTime.length)
  })

  it('una página llena justo en 100 también sigue con la siguiente', async () => {
    const skipped = Array.from({ length: CANDIDATE_PAGE_SIZE }, (_, n) => appointmentAt(`skip-${String(n).padStart(3, '0')}`, n))
    const callable = [appointmentAt('c1', 200), appointmentAt('c2', 201), appointmentAt('c3', 202)]
    const db = seed({
      appointments: [...skipped, ...callable],
      calls: skipped.map((appointment) => handledCall(String(appointment.id))),
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider, limit: 2 })

    expect(summary.called).toBe(2)
    expect(robotRows(db).filter((row) => row.status === 'calling').map((row) => row.appointment_id)).toEqual(['c1', 'c2'])
  })

  it('al llegar al límite de llamadas no lee más páginas', async () => {
    const many = Array.from({ length: CANDIDATE_PAGE_SIZE * 3 }, (_, n) => appointmentAt(`many-${String(n).padStart(3, '0')}`, n))
    const db = seed({ appointments: many })
    const provider = fakeProvider()
    const summary = await run(db, { provider, limit: 1 })

    expect(summary.called).toBe(1)
    expect(summary.considered).toBe(CANDIDATE_PAGE_SIZE)
  })

  it('tiene un tope de páginas por corrida: más allá no se mira (para no tardar sin fin)', async () => {
    const total = CANDIDATE_PAGE_SIZE * MAX_CANDIDATE_PAGES
    const skipped = Array.from({ length: total + 5 }, (_, n) => appointmentAt(`skip-${String(n).padStart(4, '0')}`, n % 600, { id: `skip-${String(n).padStart(4, '0')}` }))
    const callable = appointmentAt('callable-too-far', 700)
    const db = seed({
      appointments: [...skipped, callable],
      settings: { monthly_limit: 100000 },
      calls: skipped.map((appointment) => handledCall(String(appointment.id))),
    })
    const provider = fakeProvider()
    const summary = await run(db, { provider })

    expect(summary.considered).toBe(total)
    expect(provider.calls).toHaveLength(0)
    expect(summary.errors).toEqual([])
  })

  it('las citas de otra cuenta o ya no llamables no cuentan como candidatas de relleno', async () => {
    const foreign = Array.from({ length: CANDIDATE_PAGE_SIZE + 1 }, (_, n) =>
      appointmentAt(`foreign-${String(n).padStart(3, '0')}`, n, { account_id: OTHER_ACCOUNT }),
    )
    const db = seed({ appointments: [...foreign, appointmentAt('mine', 300)] })
    const provider = fakeProvider()
    const summary = await run(db, { provider })
    expect(provider.calls).toHaveLength(1)
    expect(summary.considered).toBe(1)
  })
})

describe('límite por corrida', () => {
  it('llama como mucho `limit` citas por corrida; las demás esperan a la siguiente', async () => {
    const startTimes = ['2026-11-05T20:30:00.000Z', '2026-11-05T21:30:00.000Z', '2026-11-05T22:30:00.000Z']
    const appointments = startTimes.map((startsAt, n) => ({
      id: `appt-${n}`,
      account_id: ACCOUNT,
      contact_id: CONTACT,
      status: 'confirmed',
      starts_at: startsAt,
      reminder_sent_at: REMINDER_AT,
      attendance_confirmed_at: null,
    }))
    const db = seed({ appointments })
    const provider = fakeProvider()
    const summary = await run(db, { provider, limit: 2 })
    expect(provider.calls).toHaveLength(2)
    expect(summary.called).toBe(2)
  })
})

describe('decideAttempt (regla pura)', () => {
  const settings = { maxAttempts: 2, retryMinutes: 90 }
  const item = (overrides: Partial<CallHistoryItem> = {}): CallHistoryItem => ({
    direction: 'outbound',
    channel: 'robot',
    attempt: 1,
    status: 'no_answer',
    outcome: 'no_response',
    createdAt: minutesAgo(200),
    ...overrides,
  })

  it('sin historia es el intento 1', () => {
    expect(decideAttempt([], settings, NOW)).toEqual({ ok: true, attempt: 1 })
  })

  it('el siguiente intento es el mayor +1, aunque haya huecos', () => {
    expect(decideAttempt([item({ attempt: 1 })], settings, NOW)).toEqual({ ok: true, attempt: 2 })
    expect(decideAttempt([item({ attempt: 2 })], { ...settings, maxAttempts: 3 }, NOW)).toEqual({ ok: true, attempt: 3 })
  })

  it('las llamadas entrantes de la historia no cuentan', () => {
    expect(decideAttempt([item({ direction: 'inbound', attempt: null })], settings, NOW)).toEqual({ ok: true, attempt: 1 })
  })
})
