import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { eventIdForAppointment } from '@/lib/google/calendar-api'

import { asClient, makeFakeDb, type FakeDb, type Row } from './agent/testing/fake-db'

// ============================================================
// Sincronización de citas con Google Calendar (T10).
//
// Base falsa en memoria + un Google falso con estado (eventos vivos,
// cancelados y "quemados"): jamás se toca la red ni la base real.
// ============================================================

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (text: string) => {
    if (text === 'roto') throw new Error('descifrado fallido')
    return `plano-${text}`
  },
}))

const admin = vi.hoisted(() => ({ client: null as unknown, failCreate: false }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    if (admin.failCreate) throw new Error('sin variables de entorno')
    return admin.client
  },
}))

import {
  CALENDAR_SYNC_TEXTS,
  buildEventText,
  kickCalendarSyncNow,
  runCalendarSync,
  syncAccountCalendar,
} from './calendar-sync'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222'
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STAFF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SERVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CONTACT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PATIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const DEFAULT_CAL = 'general@group.calendar.google.com'
const STAFF_CAL = 'dra-paula@group.calendar.google.com'
const OLD_CAL = 'anterior@group.calendar.google.com'

const NOW = new Date('2026-11-05T15:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const PHONE = '+573001112233'
const PRIVATE_NOTE = 'Alergia a la penicilina, llamar al 3009998877'

// ---------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------

let seq = 0

function appt(over: Row = {}): Row {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    account_id: ACCOUNT,
    contact_id: CONTACT,
    staff_id: STAFF,
    service_id: SERVICE,
    patient_id: null,
    location_id: null,
    starts_at: '2026-11-06T15:00:00.000Z',
    ends_at: '2026-11-06T15:45:00.000Z',
    status: 'pending',
    notes: PRIVATE_NOTE,
    updated_at: '2026-11-05T12:00:00.000000+00:00',
    google_dirty: true,
    google_calendar_id: null,
    google_synced_at: null,
    google_sync_error: null,
    ...over,
  }
}

const baseIdOf = (row: Row) => eventIdForAppointment(row.id as string)

function world(
  opts: {
    clinic?: boolean
    connection?: Row | null
    appointments?: Row[]
    staffCalendar?: string | null
    ownerUserId?: string | null
    extra?: Record<string, Row[]>
  } = {},
): FakeDb {
  const tables: Record<string, Row[]> = {
    accounts: [
      {
        id: ACCOUNT,
        owner_user_id: opts.ownerUserId === undefined ? OWNER : opts.ownerUserId,
        modules: opts.clinic ? ['agenda', 'clinica'] : ['agenda'],
        vertical_key: 'agenda',
      },
    ],
    agenda_calendar_connections:
      opts.connection === null
        ? []
        : [
            {
              account_id: ACCOUNT,
              refresh_token_encrypted: 'cifrado-1',
              default_calendar_id: DEFAULT_CAL,
              status: 'active',
              last_error: null,
              last_sync_at: null,
              ...opts.connection,
            },
          ],
    booking_appointments: opts.appointments ?? [],
    booking_staff: [
      {
        id: STAFF,
        account_id: ACCOUNT,
        name: 'Dra. Paula',
        google_calendar_id: opts.staffCalendar ?? null,
      },
    ],
    booking_services: [{ id: SERVICE, account_id: ACCOUNT, name: 'Limpieza dental' }],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'María Gómez', phone: PHONE }],
    clinic_patients: [
      { id: PATIENT, account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Camila Rojas' },
    ],
    notifications: [],
  }
  for (const [name, rows] of Object.entries(opts.extra ?? {})) {
    tables[name] = [...(tables[name] ?? []), ...rows]
  }
  return makeFakeDb(tables)
}

const rowOf = (db: FakeDb, id: unknown): Row =>
  db._tables.booking_appointments.find((r) => r.id === id) as Row

const connectionOf = (db: FakeDb): Row => db._tables.agenda_calendar_connections[0]

// ---------------------------------------------------------------------------
// Google falso con estado
// ---------------------------------------------------------------------------

interface GCall {
  method: string
  url: string
  calendarId: string | null
  eventId: string | null
  body: Record<string, unknown> | null
}

type EventState = 'live' | 'cancelled' | 'dead'

function makeGoogle(opts: { dead?: string[]; live?: string[]; missingCalendars?: string[] } = {}) {
  const events = new Map<string, { state: EventState; body: Record<string, unknown> | null }>()
  const key = (cal: string, id: string) => `${cal}|${id}`
  for (const k of opts.dead ?? []) events.set(k, { state: 'dead', body: null })
  for (const k of opts.live ?? []) events.set(k, { state: 'live', body: null })

  const calls: GCall[] = []
  const tokenBodies: URLSearchParams[] = []
  let tokenResponse: () => Response = () =>
    Response.json({ access_token: 'acceso-1', expires_in: 3600, scope: '' })
  let intercept: ((call: GCall) => Response | undefined) | null = null

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenBodies.push(new URLSearchParams(String(init?.body ?? '')))
      return tokenResponse()
    }
    const m = /\/calendars\/([^/]+)\/events(?:\/([^/?]+))?/.exec(url)
    if (!m) throw new Error(`URL inesperada en la prueba: ${url}`)
    const calendarId = decodeURIComponent(m[1])
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const eventId = m[2] ? decodeURIComponent(m[2]) : ((body?.id as string | undefined) ?? null)
    const call: GCall = { method, url, calendarId, eventId, body }
    calls.push(call)

    const forced = intercept?.(call)
    if (forced) return forced
    if (opts.missingCalendars?.includes(calendarId)) {
      return Response.json({ error: { errors: [{ reason: 'notFound' }] } }, { status: 404 })
    }

    const k = key(calendarId, eventId ?? '')
    const entry = events.get(k)
    if (method === 'PUT') {
      if (!entry || entry.state === 'dead') {
        return Response.json({ error: { errors: [{ reason: 'notFound' }] } }, { status: 404 })
      }
      events.set(k, { state: body?.status === 'cancelled' ? 'cancelled' : 'live', body })
      return Response.json({ id: eventId })
    }
    if (method === 'POST') {
      if (entry) {
        return Response.json({ error: { errors: [{ reason: 'duplicate' }] } }, { status: 409 })
      }
      events.set(k, { state: body?.status === 'cancelled' ? 'cancelled' : 'live', body })
      return Response.json({ id: eventId })
    }
    if (method === 'DELETE') {
      if (entry && entry.state !== 'dead') {
        events.set(k, { state: 'dead', body: null })
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: entry ? 410 : 404 })
    }
    throw new Error(`Método inesperado en la prueba: ${method}`)
  })

  return {
    fetchImpl,
    calls,
    tokenBodies,
    events,
    key,
    /** Solo las llamadas a eventos (sin el token). */
    methods: () => calls.map((c) => c.method),
    setTokenResponse(fn: () => Response) {
      tokenResponse = fn
    },
    onEvent(fn: (call: GCall) => Response | undefined) {
      intercept = fn
    },
  }
}

type Google = ReturnType<typeof makeGoogle>

const run = (db: FakeDb, google: Google, accountId = ACCOUNT) =>
  syncAccountCalendar({
    db: asClient(db),
    accountId,
    now: NOW,
    fetchImpl: google.fetchImpl,
  })

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'cliente-1'
  process.env.GOOGLE_CLIENT_SECRET = 'secreto-1'
  admin.failCreate = false
  admin.client = null
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_SECRET
  consoleErrorSpy.mockRestore()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

describe('buildEventText', () => {
  const base = {
    status: 'pending',
    serviceName: 'Limpieza dental',
    personName: 'María Gómez',
    staffName: 'Dra. Paula',
    isClinic: false,
  }

  it('título "{atención} · {nombre}" y descripción con el profesional', () => {
    const out = buildEventText(base)
    expect(out.title).toBe('Limpieza dental · María Gómez')
    expect(out.description).toBe('Profesional: Dra. Paula\nCreada desde Shift')
  })

  it('completada lleva "✓ " y no vino lleva "No vino · "', () => {
    expect(buildEventText({ ...base, status: 'completed' }).title).toBe(
      '✓ Limpieza dental · María Gómez',
    )
    expect(buildEventText({ ...base, status: 'no_show' }).title).toBe(
      'No vino · Limpieza dental · María Gómez',
    )
  })

  it('sin profesional la descripción es solo "Creada desde Shift"', () => {
    expect(buildEventText({ ...base, staffName: null }).description).toBe('Creada desde Shift')
  })

  it('sin servicio o sin nombre usa textos neutros (paciente en clínica)', () => {
    expect(buildEventText({ ...base, serviceName: null, personName: null }).title).toBe(
      'Cita · Cliente',
    )
    expect(
      buildEventText({ ...base, serviceName: null, personName: null, isClinic: true }).title,
    ).toBe('Cita · Paciente')
  })

  it('un nombre que es un teléfono no sale: se usa el texto neutro', () => {
    expect(buildEventText({ ...base, personName: '+57 300 111 2233' }).title).toBe(
      'Limpieza dental · Cliente',
    )
    expect(buildEventText({ ...base, personName: '573001112233' }).title).toBe(
      'Limpieza dental · Cliente',
    )
  })

  it('un teléfono dentro del nombre se quita y el nombre se deja en una línea', () => {
    const out = buildEventText({ ...base, personName: 'Ana\n +57 300 111 2233  Pérez' })
    expect(out.title).toBe('Limpieza dental · Ana Pérez')
    expect(out.title).not.toContain('300')
  })
})

// ---------------------------------------------------------------------------
// Una cuenta
// ---------------------------------------------------------------------------

describe('syncAccountCalendar: cuentas sin trabajo', () => {
  it('sin conexión no hace nada: ni llamadas a Google ni cambios en las citas', async () => {
    const row = appt()
    const db = world({ connection: null, appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out.outcome).toBe('no_connection')
    expect(google.fetchImpl).not.toHaveBeenCalled()
    expect(rowOf(db, row.id).google_dirty).toBe(true)
  })

  it('una conexión revocada o con error no se intenta', async () => {
    for (const status of ['revoked', 'error']) {
      const db = world({ connection: { status }, appointments: [appt()] })
      const google = makeGoogle()
      const out = await run(db, google)
      expect(out.outcome).toBe('inactive')
      expect(google.fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('sin citas pendientes no pide ni el token', async () => {
    const db = world({ appointments: [appt({ google_dirty: false })] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out).toMatchObject({ outcome: 'ok', found: 0, synced: 0 })
    expect(google.fetchImpl).not.toHaveBeenCalled()
  })

  it('sin GOOGLE_CLIENT_ID/SECRET no llama a Google y deja las citas pendientes', async () => {
    delete process.env.GOOGLE_CLIENT_SECRET
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out.outcome).toBe('not_configured')
    expect(google.fetchImpl).not.toHaveBeenCalled()
    expect(rowOf(db, row.id).google_dirty).toBe(true)
  })

  it('si el token guardado no se puede descifrar, lo anota y no llama a Google', async () => {
    const row = appt()
    const db = world({ connection: { refresh_token_encrypted: 'roto' }, appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out.outcome).toBe('error')
    expect(google.fetchImpl).not.toHaveBeenCalled()
    expect(connectionOf(db).status).toBe('active')
    expect(String(connectionOf(db).last_error)).not.toBe('')
    expect(rowOf(db, row.id).google_dirty).toBe(true)
  })
})

describe('syncAccountCalendar: estados y textos', () => {
  it('pendiente: evento tentative en el calendario general y la cita queda limpia', async () => {
    const row = appt({ status: 'pending' })
    const db = world({ appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out).toMatchObject({ outcome: 'ok', found: 1, synced: 1, failed: 0, raced: 0 })
    // Descifra el token guardado y se lo da a Google.
    expect(google.tokenBodies).toHaveLength(1)
    expect(google.tokenBodies[0].get('refresh_token')).toBe('plano-cifrado-1')
    expect(google.tokenBodies[0].get('client_id')).toBe('cliente-1')

    // Cita nueva: el PUT da 404 y se crea con POST (mismo id y mismo cuerpo).
    expect(google.methods()).toEqual(['PUT', 'POST'])
    const call = google.calls[0]
    expect(call).toMatchObject({
      method: 'PUT',
      calendarId: DEFAULT_CAL,
      eventId: baseIdOf(row),
    })
    expect(call.body).toMatchObject({
      summary: 'Limpieza dental · María Gómez',
      description: 'Profesional: Dra. Paula\nCreada desde Shift',
      status: 'tentative',
      start: { dateTime: '2026-11-06T15:00:00.000Z', timeZone: 'America/Bogota' },
      end: { dateTime: '2026-11-06T15:45:00.000Z', timeZone: 'America/Bogota' },
    })

    const saved = rowOf(db, row.id)
    expect(saved.google_dirty).toBe(false)
    expect(saved.google_calendar_id).toBe(DEFAULT_CAL)
    expect(saved.google_synced_at).toBe(NOW.toISOString())
    expect(saved.google_sync_error).toBeNull()
    expect(connectionOf(db).last_sync_at).toBe(NOW.toISOString())
    expect(connectionOf(db).last_error).toBeNull()
  })

  it('confirmada: evento confirmed', async () => {
    const db = world({ appointments: [appt({ status: 'confirmed' })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].body?.status).toBe('confirmed')
  })

  it('completada: confirmed con "✓ " en el título', async () => {
    const db = world({ appointments: [appt({ status: 'completed' })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].body).toMatchObject({
      status: 'confirmed',
      summary: '✓ Limpieza dental · María Gómez',
    })
  })

  it('no vino: confirmed con "No vino · " en el título', async () => {
    const db = world({ appointments: [appt({ status: 'no_show' })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].body).toMatchObject({
      status: 'confirmed',
      summary: 'No vino · Limpieza dental · María Gómez',
    })
  })

  it('el evento no lleva teléfonos, notas ni otros datos del contacto', async () => {
    const db = world({ appointments: [appt()] })
    const google = makeGoogle()
    await run(db, google)
    const sent = JSON.stringify(google.calls[0].body)
    expect(sent).not.toContain(PHONE)
    expect(sent).not.toContain('3001112233')
    expect(sent).not.toContain('penicilina')
    expect(sent).not.toContain('3009998877')
  })

  it('clínica: el nombre es el del paciente', async () => {
    const db = world({ clinic: true, appointments: [appt({ patient_id: PATIENT })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].body?.summary).toBe('Limpieza dental · Camila Rojas')
  })

  it('clínica: una cita sin paciente usa el nombre del contacto', async () => {
    const db = world({ clinic: true, appointments: [appt({ patient_id: null })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].body?.summary).toBe('Limpieza dental · María Gómez')
  })

  it('otras cuentas: usa el contacto aunque la cita traiga un paciente', async () => {
    const db = world({ clinic: false, appointments: [appt({ patient_id: PATIENT })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].body?.summary).toBe('Limpieza dental · María Gómez')
  })

  it('cancelada que ya estaba en Google: PUT con status cancelled en su calendario, sin DELETE', async () => {
    const row = appt({ status: 'cancelled', google_calendar_id: DEFAULT_CAL })
    const db = world({ appointments: [row] })
    const key = `${DEFAULT_CAL}|${baseIdOf(row)}`
    const google = makeGoogle({ live: [key] })

    const out = await run(db, google)

    expect(out.synced).toBe(1)
    expect(google.methods()).toEqual(['PUT'])
    expect(google.calls[0].body?.status).toBe('cancelled')
    expect(google.events.get(key)?.state).toBe('cancelled')
    const saved = rowOf(db, row.id)
    expect(saved.google_dirty).toBe(false)
    expect(saved.google_calendar_id).toBe(DEFAULT_CAL)
  })

  it('cancelada que nunca llegó a Google: no llama a Google y queda limpia', async () => {
    const row = appt({ status: 'cancelled', google_calendar_id: null })
    const db = world({ appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out.synced).toBe(1)
    expect(google.calls).toHaveLength(0)
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('una cita cancelada que vuelve a estar activa restaura el mismo evento', async () => {
    const row = appt({ status: 'confirmed', google_calendar_id: DEFAULT_CAL })
    const db = world({ appointments: [row] })
    const key = `${DEFAULT_CAL}|${baseIdOf(row)}`
    const google = makeGoogle()
    google.events.set(key, { state: 'cancelled', body: null })

    await run(db, google)

    expect(google.methods()).toEqual(['PUT'])
    expect(google.events.get(key)?.state).toBe('live')
  })
})

describe('syncAccountCalendar: calendarios', () => {
  it('usa el calendario del profesional si lo tiene', async () => {
    const row = appt()
    const db = world({ staffCalendar: STAFF_CAL, appointments: [row] })
    const google = makeGoogle()

    await run(db, google)

    expect(google.calls[0].calendarId).toBe(STAFF_CAL)
    expect(rowOf(db, row.id).google_calendar_id).toBe(STAFF_CAL)
  })

  it('una cita sin profesional va al calendario general', async () => {
    const db = world({ staffCalendar: STAFF_CAL, appointments: [appt({ staff_id: null })] })
    const google = makeGoogle()
    await run(db, google)
    expect(google.calls[0].calendarId).toBe(DEFAULT_CAL)
    expect(google.calls[0].body?.description).toBe('Creada desde Shift')
  })

  it('si cambió el calendario de destino, escribe en el nuevo y borra del anterior', async () => {
    const row = appt({ google_calendar_id: OLD_CAL })
    const db = world({ staffCalendar: STAFF_CAL, appointments: [row] })
    const oldKey = `${OLD_CAL}|${baseIdOf(row)}`
    const google = makeGoogle({ live: [oldKey] })

    await run(db, google)

    // Primero escribe en el calendario nuevo y solo después borra del anterior.
    expect(google.calls.map((c) => [c.method, c.calendarId])).toEqual([
      ['PUT', STAFF_CAL],
      ['POST', STAFF_CAL],
      ['DELETE', OLD_CAL],
    ])
    expect(google.events.get(oldKey)?.state).toBe('dead')
    expect(rowOf(db, row.id).google_calendar_id).toBe(STAFF_CAL)
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('la copia vieja puede estar en un id con sufijo: prueba el id base y luego v1', async () => {
    const row = appt({ google_calendar_id: OLD_CAL })
    const db = world({ appointments: [row] })
    const base = baseIdOf(row)
    const google = makeGoogle({
      dead: [`${OLD_CAL}|${base}`],
      live: [`${OLD_CAL}|${base}v1`],
    })

    await run(db, google)

    const deletes = google.calls.filter((c) => c.method === 'DELETE')
    expect(deletes.map((c) => c.eventId)).toEqual([base, `${base}v1`])
    expect(google.events.get(`${OLD_CAL}|${base}v1`)?.state).toBe('dead')
  })

  it('si la copia vieja ya no existe, igual termina bien (no es error)', async () => {
    const row = appt({ google_calendar_id: OLD_CAL })
    const db = world({ appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 1, failed: 0 })
    expect(rowOf(db, row.id).google_calendar_id).toBe(DEFAULT_CAL)
  })

  it('si cambió el calendario y la cita se cancela, se cancela la copia donde está', async () => {
    const row = appt({ status: 'cancelled', google_calendar_id: OLD_CAL })
    const db = world({ staffCalendar: STAFF_CAL, appointments: [row] })
    const oldKey = `${OLD_CAL}|${baseIdOf(row)}`
    const google = makeGoogle({ live: [oldKey] })

    await run(db, google)

    expect(google.calls).toHaveLength(1)
    expect(google.calls[0]).toMatchObject({ method: 'PUT', calendarId: OLD_CAL })
    expect(google.events.get(oldKey)?.state).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// Qué citas se toman
// ---------------------------------------------------------------------------

describe('syncAccountCalendar: qué citas entran', () => {
  it('toma hasta 50 por corrida y deja el resto sucio para la siguiente', async () => {
    const rows = Array.from({ length: 53 }, (_, i) =>
      appt({ starts_at: new Date(NOW.getTime() + (i + 1) * 3600_000).toISOString(),
             ends_at: new Date(NOW.getTime() + (i + 1) * 3600_000 + 1800_000).toISOString() }),
    )
    const db = world({ appointments: rows })
    const google = makeGoogle()

    const first = await run(db, google)
    expect(first).toMatchObject({ found: 50, synced: 50 })
    expect(db._tables.booking_appointments.filter((r) => r.google_dirty === true)).toHaveLength(3)

    const second = await run(db, google)
    expect(second).toMatchObject({ found: 3, synced: 3 })
  })

  it('solo mira de hace 1 día a 180 días adelante, y solo las sucias de la cuenta', async () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
    const inside = appt({ starts_at: at(-DAY + 60_000), ends_at: at(-DAY + 3_660_000) })
    const edgeFuture = appt({ starts_at: at(179 * DAY), ends_at: at(179 * DAY + 1_800_000) })
    const tooOld = appt({ starts_at: at(-2 * DAY), ends_at: at(-2 * DAY + 1_800_000) })
    const tooFar = appt({ starts_at: at(181 * DAY), ends_at: at(181 * DAY + 1_800_000) })
    const clean = appt({ google_dirty: false })
    const foreign = appt({ account_id: OTHER_ACCOUNT })
    const db = world({ appointments: [inside, edgeFuture, tooOld, tooFar, clean, foreign] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out).toMatchObject({ found: 2, synced: 2 })
    expect(rowOf(db, tooOld.id).google_dirty).toBe(true)
    expect(rowOf(db, tooFar.id).google_dirty).toBe(true)
    expect(rowOf(db, foreign.id).google_dirty).toBe(true)
    expect(rowOf(db, clean.id).google_synced_at).toBeNull()
  })

  it('las que ya fallaron van después de las nuevas, para que no frenen la cola', async () => {
    const at = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString()
    const failing = appt({
      starts_at: at(1),
      ends_at: at(2),
      google_sync_error: 'Google respondió un error (HTTP 500)',
    })
    const rows = [
      failing,
      ...Array.from({ length: 50 }, (_, i) => appt({ starts_at: at(10 + i), ends_at: at(10.5 + i) })),
    ]
    const db = world({ appointments: rows })
    const google = makeGoogle()

    await run(db, google)

    expect(rowOf(db, failing.id).google_dirty).toBe(true)
    expect(db._tables.booking_appointments.filter((r) => r.google_dirty === false)).toHaveLength(50)
  })
})

// ---------------------------------------------------------------------------
// Carreras y errores
// ---------------------------------------------------------------------------

describe('syncAccountCalendar: carreras y errores por cita', () => {
  it('si la cita cambió mientras se sincronizaba (updated_at distinto), no se limpia', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()
    google.onEvent(() => {
      // Alguien la mueve justo mientras Google responde.
      rowOf(db, row.id).updated_at = '2026-11-05T14:59:59.000000+00:00'
      return undefined
    })

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 0, raced: 1, failed: 0 })
    const saved = rowOf(db, row.id)
    expect(saved.google_dirty).toBe(true)
    expect(saved.google_synced_at).toBeNull()
    // Se recuerda dónde quedó el evento, para poder cancelarlo después.
    expect(saved.google_calendar_id).toBe(DEFAULT_CAL)
  })

  it('tras una carrera, la siguiente corrida la sincroniza con lo nuevo', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()
    let first = true
    google.onEvent(() => {
      if (first) {
        first = false
        rowOf(db, row.id).updated_at = '2026-11-05T14:59:59.000000+00:00'
      }
      return undefined
    })

    await run(db, google)
    const out = await run(db, google)

    expect(out.synced).toBe(1)
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('un error en una cita se guarda en ella y sigue con la siguiente', async () => {
    const bad = appt({ starts_at: '2026-11-06T10:00:00.000Z', ends_at: '2026-11-06T10:30:00.000Z' })
    const good = appt({ starts_at: '2026-11-06T11:00:00.000Z', ends_at: '2026-11-06T11:30:00.000Z' })
    const db = world({ appointments: [bad, good] })
    const google = makeGoogle()
    google.onEvent((call) =>
      call.eventId === baseIdOf(bad)
        ? Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 })
        : undefined,
    )

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 1, failed: 1 })
    const badSaved = rowOf(db, bad.id)
    expect(badSaved.google_dirty).toBe(true)
    expect(badSaved.google_sync_error).toBe('Google respondió un error (HTTP 500, backendError)')
    expect(rowOf(db, good.id).google_dirty).toBe(false)
    // El último error de conexión queda visible para el panel.
    expect(connectionOf(db).last_error).toBe('Google respondió un error (HTTP 500, backendError)')
    expect(connectionOf(db).status).toBe('active')
  })

  it('el error guardado nunca lleva tokens, nombres ni teléfonos', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()
    google.onEvent(() => {
      throw new Error(`falló con acceso acceso-1 y ${PHONE} de María Gómez`)
    })

    await run(db, google)

    const text = JSON.stringify([rowOf(db, row.id), connectionOf(db)])
    expect(text).not.toContain('acceso-1')
    expect(text).not.toContain(PHONE)
    expect(text).not.toContain('María')
    expect(String(rowOf(db, row.id).google_sync_error).length).toBeLessThanOrEqual(300)
  })

  it('un error de red al pedir el token deja todo pendiente y la conexión activa', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()
    google.setTokenResponse(() => Response.json({}, { status: 503 }))

    const out = await run(db, google)

    expect(out.outcome).toBe('error')
    expect(connectionOf(db).status).toBe('active')
    expect(String(connectionOf(db).last_error)).not.toBe('')
    expect(rowOf(db, row.id).google_dirty).toBe(true)
    expect(google.calls).toHaveLength(0)
  })

  it('no inventa un evento si la base falla al leer las citas: lanza', async () => {
    const db = world({ appointments: [appt()] })
    db._failNext('select', 'booking_appointments', { message: 'se cayó' })
    await expect(run(db, makeGoogle())).rejects.toThrow('se cayó')
  })
})

describe('syncAccountCalendar: invalid_grant', () => {
  const revoked = () => Response.json({ error: 'invalid_grant' }, { status: 400 })

  it('marca la conexión como revocada, avisa al dueño una sola vez y deja las citas pendientes', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()
    google.setTokenResponse(revoked)

    const out = await run(db, google)

    expect(out.outcome).toBe('revoked')
    expect(connectionOf(db).status).toBe('revoked')
    expect(String(connectionOf(db).last_error)).not.toBe('')
    expect(google.calls).toHaveLength(0)
    expect(rowOf(db, row.id).google_dirty).toBe(true)

    const notes = db._tables.notifications
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: OWNER,
      conversation_id: null,
      contact_id: null,
    })
    expect(String(notes[0].title)).toContain('Google Calendar')

    // Se deja de intentar hasta reconectar: la segunda corrida no avisa otra vez.
    const again = await run(db, google)
    expect(again.outcome).toBe('inactive')
    expect(db._tables.notifications).toHaveLength(1)
    expect(google.tokenBodies).toHaveLength(1)
  })

  it('si la conexión ya no estaba activa (otra corrida la revocó), no repite el aviso', async () => {
    const db = world({ appointments: [appt()] })
    const google = makeGoogle()
    google.setTokenResponse(() => {
      // Otra corrida alcanzó a revocarla mientras esta esperaba a Google.
      connectionOf(db).status = 'revoked'
      return revoked()
    })

    await run(db, google)

    expect(db._tables.notifications).toHaveLength(0)
  })

  it('sin dueño en la cuenta revoca igual y no lanza', async () => {
    const db = world({ appointments: [appt()], ownerUserId: null })
    const google = makeGoogle()
    google.setTokenResponse(revoked)

    const out = await run(db, google)

    expect(out.outcome).toBe('revoked')
    expect(connectionOf(db).status).toBe('revoked')
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('si el aviso falla, la conexión queda revocada igual y no lanza', async () => {
    const db = world({ appointments: [appt()] })
    db._failNext('insert', 'notifications', { message: 'no se pudo insertar' })
    const google = makeGoogle()
    google.setTokenResponse(revoked)

    const out = await run(db, google)

    expect(out.outcome).toBe('revoked')
    expect(connectionOf(db).status).toBe('revoked')
    expect(db._tables.notifications).toHaveLength(0)
    expect(consoleErrorSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Ids de evento "quemados" (borrados en Google: PUT 404 y POST 409)
// ---------------------------------------------------------------------------

describe('syncAccountCalendar: ids de evento quemados', () => {
  it('si el id base está quemado, crea el evento con el sufijo v1', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const base = baseIdOf(row)
    const google = makeGoogle({ dead: [`${DEFAULT_CAL}|${base}`] })

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 1, failed: 0 })
    expect(google.calls.map((c) => `${c.method} ${c.eventId}`)).toEqual([
      `PUT ${base}`,
      `POST ${base}`,
      `PUT ${base}`,
      `PUT ${base}v1`,
      `POST ${base}v1`,
    ])
    expect(google.events.get(`${DEFAULT_CAL}|${base}v1`)?.state).toBe('live')
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('en las siguientes corridas prueba primero el base y luego los sufijos en orden', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const base = baseIdOf(row)
    const google = makeGoogle({
      dead: [`${DEFAULT_CAL}|${base}`, `${DEFAULT_CAL}|${base}v1`],
      live: [`${DEFAULT_CAL}|${base}v2`],
    })

    await run(db, google)

    const ids = google.calls.filter((c) => c.method === 'PUT').map((c) => c.eventId)
    expect(ids).toEqual([base, base, `${base}v1`, `${base}v1`, `${base}v2`])
    expect(google.calls.at(-1)).toMatchObject({ method: 'PUT', eventId: `${base}v2` })
    // El evento vivo se actualizó en su sitio: no se creó otro.
    expect(google.calls.filter((c) => c.method === 'POST' && c.eventId === `${base}v2`)).toHaveLength(0)
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('el sufijo sigue siendo un id válido de Google (base32hex: 0-9 y a-v)', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const base = baseIdOf(row)
    const google = makeGoogle({ dead: [`${DEFAULT_CAL}|${base}`] })

    await run(db, google)

    for (const c of google.calls) expect(c.eventId).toMatch(/^[0-9a-v]{5,1024}$/)
  })

  it('cancelar con el id base quemado cancela la copia viva con sufijo, sin crear ni borrar', async () => {
    const row = appt({ status: 'cancelled', google_calendar_id: DEFAULT_CAL })
    const db = world({ appointments: [row] })
    const base = baseIdOf(row)
    const google = makeGoogle({
      dead: [`${DEFAULT_CAL}|${base}`],
      live: [`${DEFAULT_CAL}|${base}v1`],
    })

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 1, failed: 0 })
    expect(google.calls.map((c) => `${c.method} ${c.eventId}`)).toEqual([
      `PUT ${base}`,
      `PUT ${base}v1`,
    ])
    expect(google.events.get(`${DEFAULT_CAL}|${base}v1`)?.state).toBe('cancelled')
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('cancelar algo que ya no existe en ningún id no es error: queda limpia y no crea nada', async () => {
    const row = appt({ status: 'cancelled', google_calendar_id: DEFAULT_CAL })
    const db = world({ appointments: [row] })
    const google = makeGoogle()

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 1, failed: 0 })
    expect(google.methods()).toEqual(['PUT', 'PUT', 'PUT', 'PUT'])
    expect(google.events.size).toBe(0)
    expect(rowOf(db, row.id).google_dirty).toBe(false)
  })

  it('si el id base y los tres sufijos están quemados, falla esa cita con un mensaje claro', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const base = baseIdOf(row)
    const google = makeGoogle({
      dead: ['', 'v1', 'v2', 'v3'].map((s) => `${DEFAULT_CAL}|${base}${s}`),
    })

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 0, failed: 1 })
    expect(rowOf(db, row.id).google_dirty).toBe(true)
    expect(String(rowOf(db, row.id).google_sync_error)).toContain('Google')
    // Cuatro ids x (PUT, POST, PUT): no sigue para siempre.
    expect(google.calls).toHaveLength(12)
  })

  it('un calendario que no existe falla rápido: la segunda cita no repite las llamadas', async () => {
    const a = appt({ starts_at: '2026-11-06T10:00:00.000Z', ends_at: '2026-11-06T10:30:00.000Z' })
    const b = appt({ starts_at: '2026-11-06T11:00:00.000Z', ends_at: '2026-11-06T11:30:00.000Z' })
    const db = world({ appointments: [a, b] })
    const google = makeGoogle({ missingCalendars: [DEFAULT_CAL] })

    const out = await run(db, google)

    expect(out).toMatchObject({ synced: 0, failed: 2 })
    const callsForA = google.calls.filter((c) => c.eventId?.startsWith(baseIdOf(a))).length
    expect(callsForA).toBe(8) // 4 ids x (PUT + POST)
    expect(google.calls.filter((c) => c.eventId?.startsWith(baseIdOf(b)))).toHaveLength(0)
    expect(rowOf(db, b.id).google_sync_error).toBe(rowOf(db, a.id).google_sync_error)
  })

  it('un error de otro tipo (por ejemplo 403) no prueba sufijos', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    const google = makeGoogle()
    google.onEvent(() =>
      Response.json({ error: { errors: [{ reason: 'forbidden' }] } }, { status: 403 }),
    )

    const out = await run(db, google)

    expect(out.failed).toBe(1)
    expect(google.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Todas las cuentas
// ---------------------------------------------------------------------------

describe('runCalendarSync', () => {
  function twoAccounts() {
    const first = appt()
    const second = appt({ account_id: OTHER_ACCOUNT })
    const db = world({
      appointments: [first, second],
      extra: {
        accounts: [
          { id: OTHER_ACCOUNT, owner_user_id: OWNER, modules: ['agenda'], vertical_key: 'agenda' },
        ],
        agenda_calendar_connections: [
          {
            account_id: OTHER_ACCOUNT,
            refresh_token_encrypted: 'cifrado-2',
            default_calendar_id: 'primary',
            status: 'active',
            last_error: null,
            last_sync_at: null,
          },
        ],
      },
    })
    return { db, first, second }
  }

  it('recorre solo las conexiones activas, una tras otra, y resume', async () => {
    const { db, first, second } = twoAccounts()
    // Una tercera conexión revocada no se toca.
    db._tables.accounts.push({ id: 'cccccccc-0000-4000-8000-000000000000', owner_user_id: OWNER, modules: ['agenda'] })
    db._tables.agenda_calendar_connections.push({
      account_id: 'cccccccc-0000-4000-8000-000000000000',
      refresh_token_encrypted: 'x',
      default_calendar_id: 'primary',
      status: 'revoked',
    })
    const google = makeGoogle()

    const out = await runCalendarSync({
      db: asClient(db),
      now: NOW,
      fetchImpl: google.fetchImpl,
    })

    expect(out).toMatchObject({ accounts: 2, synced: 2, failed: 0, errors: [] })
    expect(rowOf(db, first.id).google_dirty).toBe(false)
    expect(rowOf(db, second.id).google_dirty).toBe(false)
    expect(google.tokenBodies).toHaveLength(2)
  })

  it('si una cuenta lanza, las demás siguen y el error queda en el resumen', async () => {
    const { db, second } = twoAccounts()
    // La primera lectura de citas (cuenta 1111...) falla.
    db._failNext('select', 'booking_appointments', { message: 'se cayó' })
    const google = makeGoogle()

    const out = await runCalendarSync({
      db: asClient(db),
      now: NOW,
      fetchImpl: google.fetchImpl,
    })

    expect(out.accounts).toBe(2)
    expect(out.synced).toBe(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toContain(ACCOUNT)
    expect(out.errors[0]).toContain('se cayó')
    expect(out.errors[0]).not.toContain('María')
    expect(rowOf(db, second.id).google_dirty).toBe(false)
  })

  it('cuenta las conexiones revocadas en esta corrida y los fallos por cita', async () => {
    const { db } = twoAccounts()
    const google = makeGoogle()
    let n = 0
    google.setTokenResponse(() => {
      n += 1
      return n === 1
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'acceso-2', expires_in: 3600 })
    })

    const out = await runCalendarSync({
      db: asClient(db),
      now: NOW,
      fetchImpl: google.fetchImpl,
    })

    expect(out).toMatchObject({ accounts: 2, revoked: 1, synced: 1 })
  })

  it('sin GOOGLE_CLIENT_ID/SECRET lo dice una sola vez con el texto de CALENDAR_SYNC_TEXTS', async () => {
    delete process.env.GOOGLE_CLIENT_SECRET
    const { db, first, second } = twoAccounts()
    const google = makeGoogle()

    const out = await runCalendarSync({
      db: asClient(db),
      now: NOW,
      fetchImpl: google.fetchImpl,
    })

    expect(CALENDAR_SYNC_TEXTS.notConfigured).toContain('GOOGLE_CLIENT_ID')
    expect(CALENDAR_SYNC_TEXTS.notConfigured).toContain('GOOGLE_CLIENT_SECRET')
    expect(out.errors).toEqual([CALENDAR_SYNC_TEXTS.notConfigured])
    expect(out).toMatchObject({ accounts: 2, synced: 0, connectionErrors: 2 })
    expect(google.fetchImpl).not.toHaveBeenCalled()
    expect(rowOf(db, first.id).google_dirty).toBe(true)
    expect(rowOf(db, second.id).google_dirty).toBe(true)
  })

  it('si no se pueden leer las conexiones, lanza', async () => {
    const db = world()
    db._failNext('select', 'agenda_calendar_connections', { message: 'se cayó' })
    await expect(runCalendarSync({ db: asClient(db), now: NOW })).rejects.toThrow('se cayó')
  })

  it('sin conexiones activas no hace nada', async () => {
    const db = world({ connection: null, appointments: [appt()] })
    const out = await runCalendarSync({ db: asClient(db), now: NOW })
    expect(out).toMatchObject({ accounts: 0, synced: 0, failed: 0, errors: [] })
  })
})

// ---------------------------------------------------------------------------
// Empujón inmediato
// ---------------------------------------------------------------------------

describe('kickCalendarSyncNow', () => {
  it('sincroniza la cuenta con el cliente de servicio', async () => {
    const row = appt()
    const db = world({ appointments: [row] })
    admin.client = asClient(db)
    const google = makeGoogle()
    vi.stubGlobal('fetch', google.fetchImpl)

    await kickCalendarSyncNow(ACCOUNT)

    expect(rowOf(db, row.id).google_dirty).toBe(false)
    expect(google.methods()).toEqual(['PUT', 'POST'])
  })

  it('traga los errores y no lleva datos personales al log', async () => {
    const db = world({ appointments: [appt()] })
    db._failNext('select', 'booking_appointments', { message: 'se cayó' })
    admin.client = asClient(db)
    vi.stubGlobal('fetch', makeGoogle().fetchImpl)

    await expect(kickCalendarSyncNow(ACCOUNT)).resolves.toBeUndefined()

    expect(consoleErrorSpy).toHaveBeenCalled()
    const logged = consoleErrorSpy.mock.calls.flat().map(String).join(' ')
    expect(logged).not.toContain(PHONE)
    expect(logged).not.toContain('María')
  })

  it('no lanza si ni siquiera se puede crear el cliente de servicio', async () => {
    admin.failCreate = true
    await expect(kickCalendarSyncNow(ACCOUNT)).resolves.toBeUndefined()
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('una cuenta sin conexión no hace nada', async () => {
    const db = world({ connection: null, appointments: [appt()] })
    admin.client = asClient(db)
    const google = makeGoogle()
    vi.stubGlobal('fetch', google.fetchImpl)

    await kickCalendarSyncNow(ACCOUNT)

    expect(google.fetchImpl).not.toHaveBeenCalled()
  })
})
