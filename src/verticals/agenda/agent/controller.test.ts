import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { VerticalSession } from '@/lib/verticals/types'

import { handleAgendaInbound, type AgendaSender } from './controller'
import { dayId, slotId, staffId, svcId } from './state'
import { AGENDA_AGENT_TEXTS } from '../texts'

// ============================================================
// Controlador de reservas — contrato completo del diálogo.
//
// La base de datos es un fake chainable (select/insert/update/
// upsert + eq/in/lt/lte/gt/gte + order/limit + maybeSingle/single)
// que aplica los filtros como PostgREST: una consulta que olvide
// `account_id` lee filas de más y el test lo nota. El envío de
// WhatsApp es un grabador: los tests inspeccionan el último menú
// ofrecido y responden como lo haría un cliente (tap o texto).
// ============================================================

type Row = Record<string, unknown>

// ------------------------------------------------------------
// Fake de Supabase
// ------------------------------------------------------------

interface FakeDb {
  _tables: Record<string, Row[]>
  _failNext(
    op: 'select' | 'insert' | 'update' | 'upsert' | 'delete',
    table: string,
    error: { code?: string; message?: string },
  ): void
  from(table: string): unknown
}

type FilterKind = 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte'

function makeFakeDb(seed: Record<string, Row[]>): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }
  const failures: {
    op: string
    table: string
    error: { code?: string; message?: string }
  }[] = []

  const ensure = (name: string): Row[] => (tables[name] ??= [])

  function from(table: string) {
    const filters: { col: string; kind: FilterKind; value: unknown }[] = []
    const orders: { col: string; ascending: boolean }[] = []
    type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'
    let op: Op = 'select'
    let payload: Row | Row[] | null = null
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null =
      null
    let limitN: number | null = null
    let inserted: Row[] = []

    const matches = (row: Row): boolean =>
      filters.every(({ col, kind, value }) => {
        const v = row[col]
        switch (kind) {
          case 'eq':
            return v === value
          case 'in':
            return (value as unknown[]).includes(v)
          case 'lt':
            return String(v) < String(value)
          case 'lte':
            return String(v) <= String(value)
          case 'gt':
            return String(v) > String(value)
          case 'gte':
            return String(v) >= String(value)
        }
      })

    const candidateRows = (): Row[] => {
      const out = ensure(table).filter(matches)
      if (orders.length) {
        // Como PostgREST: el primer `.order()` manda y los siguientes desempatan.
        out.sort((a, b) => {
          for (const { col, ascending } of orders) {
            const av = a[col] as never
            const bv = b[col] as never
            if (av === bv) continue
            return (av < bv ? -1 : 1) * (ascending ? 1 : -1)
          }
          return 0
        })
      }
      return limitN === null ? out : out.slice(0, limitN)
    }

    const takeFailure = (opName: Op): { code?: string; message?: string } | null => {
      const idx = failures.findIndex((f) => f.op === opName && f.table === table)
      if (idx === -1) return null
      return failures.splice(idx, 1)[0].error
    }

    // Índice único parcial de 047 (idx_booking_sessions_one_active):
    // una sola sesión 'active' por (account_id, contact_id).
    const violatesOneActiveSession = (row: Row, self?: Row): boolean =>
      table === 'booking_sessions' &&
      row.status === 'active' &&
      ensure(table).some(
        (r) =>
          r !== self &&
          r.status === 'active' &&
          r.account_id === row.account_id &&
          r.contact_id === row.contact_id,
      )
    const UNIQUE_VIOLATION = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "idx_booking_sessions_one_active"',
    }

    const run = (): { data: unknown; error: unknown } => {
      if (op === 'select') {
        const fail = takeFailure('select')
        if (fail) return { data: null, error: fail }
        return { data: candidateRows().map((r) => ({ ...r })), error: null }
      }
      if (op === 'insert') {
        const fail = takeFailure('insert')
        if (fail) return { data: null, error: fail }
        const rows = Array.isArray(payload) ? payload : [payload as Row]
        if (rows.some((r) => violatesOneActiveSession(r))) {
          return { data: null, error: UNIQUE_VIOLATION }
        }
        inserted = rows.map((r) => ({ ...r }))
        ensure(table).push(...inserted)
        return { data: null, error: null }
      }
      if (op === 'upsert') {
        const fail = takeFailure('upsert')
        if (fail) return { data: null, error: fail }
        const rows = Array.isArray(payload) ? payload : [payload as Row]
        const conflictCols = (upsertOpts?.onConflict ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
        for (const row of rows) {
          const existing = conflictCols.length
            ? ensure(table).find((r) =>
                conflictCols.every((c) => r[c] === row[c]),
              )
            : undefined
          if (existing) {
            if (!upsertOpts?.ignoreDuplicates) Object.assign(existing, row)
          } else {
            ensure(table).push({ ...row })
          }
        }
        return { data: null, error: null }
      }
      if (op === 'update') {
        const fail = takeFailure('update')
        if (fail) return { data: null, error: fail }
        const targets = candidateRows()
        if (
          targets.some((row) =>
            violatesOneActiveSession({ ...row, ...(payload as Row) }, row),
          )
        ) {
          return { data: null, error: UNIQUE_VIOLATION }
        }
        for (const row of targets) Object.assign(row, payload as Row)
        // Con `.select()` PostgREST devuelve las filas afectadas.
        return { data: targets.map((r) => ({ ...r })), error: null }
      }
      const fail = takeFailure('delete')
      if (fail) return { data: null, error: fail }
      const doomed = new Set(candidateRows())
      tables[table] = ensure(table).filter((r) => !doomed.has(r))
      return { data: null, error: null }
    }

    const api = {
      select: () => api,
      insert: (p: Row | Row[]) => {
        op = 'insert'
        payload = p
        return api
      },
      upsert: (p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        op = 'upsert'
        payload = p
        upsertOpts = o ?? null
        return api
      },
      update: (p: Row) => {
        op = 'update'
        payload = p
        return api
      },
      delete: () => {
        op = 'delete'
        return api
      },
      eq: (col: string, value: unknown) => {
        filters.push({ col, kind: 'eq', value })
        return api
      },
      in: (col: string, value: unknown[]) => {
        filters.push({ col, kind: 'in', value })
        return api
      },
      lt: (col: string, value: unknown) => {
        filters.push({ col, kind: 'lt', value })
        return api
      },
      lte: (col: string, value: unknown) => {
        filters.push({ col, kind: 'lte', value })
        return api
      },
      gt: (col: string, value: unknown) => {
        filters.push({ col, kind: 'gt', value })
        return api
      },
      gte: (col: string, value: unknown) => {
        filters.push({ col, kind: 'gte', value })
        return api
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        orders.push({ col, ascending: o?.ascending ?? true })
        return api
      },
      limit: (n: number) => {
        limitN = n
        return api
      },
      maybeSingle: async () => {
        const result = run()
        if (result.error) return { data: null, error: result.error }
        if (op === 'insert') {
          return { data: inserted[0] ? { id: inserted[0].id } : null, error: null }
        }
        const rows = result.data as Row[]
        return { data: rows[0] ?? null, error: null }
      },
      single: async () => {
        const result = run()
        if (result.error) return { data: null, error: result.error }
        if (op === 'insert') return { data: inserted[0] ?? null, error: null }
        const rows = result.data as Row[]
        if (!rows.length) return { data: null, error: { message: 'no rows' } }
        return { data: rows[0], error: null }
      },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(resolve(run())),
    }
    return api
  }

  return {
    _tables: tables,
    _failNext(op, table, error) {
      failures.push({ op, table, error })
    },
    from,
  }
}

// ------------------------------------------------------------
// Fixture
// ------------------------------------------------------------

const ACCOUNT = 'acc-1'
const CONTACT = 'ct-1'
const CONVERSATION = 'cv-1'
const OWNER = 'user-owner'
const HANDOFF_AGENT = 'user-agent'
const PIPELINE = 'pipe-1'
const STAGE = 'stage-cita'
const TAG_CONFIRMADA = 'tag-confirmada'
const TAG_CANCELADA = 'tag-cancelada'
const TAG_REPROGRAMADA = 'tag-reprogramada'
const TAG_HUMANO = 'tag-humano'
const SERVICE_CORTE = 'svc-corte'
const SERVICE_BARBA = 'svc-barba'
const STAFF_ANDRES = 'st-andres'
const STAFF_BETO = 'st-beto'

/** Lunes 19 de octubre de 2026, 08:00 en Bogotá (13:00Z). */
const NOW = new Date('2026-10-19T13:00:00Z')
const MONDAY = '2026-10-19'

function baseSeed(): Record<string, Row[]> {
  return {
    accounts: [
      { id: ACCOUNT, default_currency: 'COP', owner_user_id: OWNER },
    ],
    ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: HANDOFF_AGENT }],
    contacts: [
      {
        id: CONTACT,
        account_id: ACCOUNT,
        name: 'Carlos Pérez',
        phone: '573001112233',
      },
    ],
    conversations: [
      {
        id: CONVERSATION,
        account_id: ACCOUNT,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
        assigned_agent_id: null,
      },
    ],
    booking_services: [
      {
        id: SERVICE_CORTE,
        account_id: ACCOUNT,
        name: 'Corte clásico',
        description: 'Corte a tijera',
        duration_minutes: 30,
        price: 25000,
        is_active: true,
        position: 0,
      },
      {
        id: SERVICE_BARBA,
        account_id: ACCOUNT,
        name: 'Perfilado de barba',
        description: null,
        duration_minutes: 20,
        price: 15000,
        is_active: true,
        position: 1,
      },
    ],
    booking_staff: [
      {
        id: STAFF_ANDRES,
        account_id: ACCOUNT,
        name: 'Andrés',
        bio: null,
        is_active: true,
        position: 0,
      },
      {
        id: STAFF_BETO,
        account_id: ACCOUNT,
        name: 'Beto',
        bio: null,
        is_active: true,
        position: 1,
      },
    ],
    booking_staff_services: [
      { account_id: ACCOUNT, staff_id: STAFF_ANDRES, service_id: SERVICE_CORTE },
      { account_id: ACCOUNT, staff_id: STAFF_ANDRES, service_id: SERVICE_BARBA },
      { account_id: ACCOUNT, staff_id: STAFF_BETO, service_id: SERVICE_CORTE },
    ],
    booking_working_hours: [
      {
        account_id: ACCOUNT,
        staff_id: STAFF_ANDRES,
        weekday: 1,
        start_time: '09:00:00',
        end_time: '13:00:00',
      },
      {
        account_id: ACCOUNT,
        staff_id: STAFF_ANDRES,
        weekday: 1,
        start_time: '14:00:00',
        end_time: '19:00:00',
      },
      {
        account_id: ACCOUNT,
        staff_id: STAFF_BETO,
        weekday: 1,
        start_time: '10:00:00',
        end_time: '13:00:00',
      },
    ],
    booking_time_off: [],
    booking_appointments: [],
    booking_sessions: [],
    // Vocabulario y piezas del punto de partida Barbería: así los tests
    // existentes siguen esperando "barbero" aunque el default sea "profesional".
    booking_settings: [
      {
        account_id: ACCOUNT,
        bot_texts: {},
        labels: { profesional: 'barbero', profesionales: 'barberos' },
        choose_staff: true,
        show_price: true,
        show_duration: true,
        reminders_enabled: true,
        allow_reschedule: true,
      },
    ],
    tags: [
      { id: TAG_CONFIRMADA, account_id: ACCOUNT, name: 'cita-confirmada' },
      { id: TAG_CANCELADA, account_id: ACCOUNT, name: 'cita-cancelada' },
      { id: TAG_REPROGRAMADA, account_id: ACCOUNT, name: 'cita-reprogramada' },
      { id: TAG_HUMANO, account_id: ACCOUNT, name: 'quiere-humano' },
    ],
    pipelines: [{ id: PIPELINE, account_id: ACCOUNT, name: 'Barbería' }],
    pipeline_stages: [{ id: STAGE, pipeline_id: PIPELINE, name: 'Cita agendada' }],
    deals: [],
    notifications: [],
    booking_events: [],
    messages: [],
  }
}

function appointmentRow(overrides: Row = {}): Row {
  return {
    id: 'appt-old',
    account_id: ACCOUNT,
    contact_id: CONTACT,
    conversation_id: CONVERSATION,
    service_id: SERVICE_CORTE,
    staff_id: STAFF_ANDRES,
    starts_at: '2026-10-21T20:00:00.000Z', // miércoles 15:00 local
    ends_at: '2026-10-21T20:30:00.000Z',
    status: 'confirmed',
    cancel_reason: null,
    rescheduled_from: null,
    created_via: 'agent',
    confirmed_at: '2026-10-18T12:00:00.000Z',
    cancelled_at: null,
    ...overrides,
  }
}

let msgCounter = 0

function seedInbound(
  db: FakeDb,
  input: { text?: string; replyId?: string | null },
): string {
  msgCounter += 1
  const messageId = `wamid-${msgCounter}`
  db._tables.messages.push({
    id: `msg-${msgCounter}`,
    account_id: ACCOUNT,
    conversation_id: CONVERSATION,
    message_id: messageId,
    content_text: input.text ?? '',
    content_type: input.replyId ? 'interactive' : 'text',
    interactive_reply_id: input.replyId ?? null,
  })
  return messageId
}

/** Lo que el dispatcher pasaría: solo la sesión activa y vigente. */
function currentSession(db: FakeDb, now: Date): VerticalSession | null {
  const row = db._tables.booking_sessions.find(
    (r) =>
      r.account_id === ACCOUNT &&
      r.contact_id === CONTACT &&
      r.status === 'active' &&
      String(r.expires_at) > now.toISOString(),
  )
  return row
    ? {
        id: row.id as string,
        state: (row.state ?? {}) as Record<string, unknown>,
        expiresAt: row.expires_at as string,
      }
    : null
}

interface SenderCall {
  kind: 'text' | 'buttons' | 'list'
  bodyText: string
  buttons?: { id: string; title: string }[]
  buttonLabel?: string
  sections?: { rows: { id: string; title: string; description?: string }[] }[]
  footerText?: string
}

function makeRecorder() {
  const calls: SenderCall[] = []
  const sender: AgendaSender = {
    sendText: async ({ text }) => {
      calls.push({ kind: 'text', bodyText: text })
    },
    sendButtons: async ({ bodyText, buttons, footerText }) => {
      calls.push({ kind: 'buttons', bodyText, buttons, footerText })
    },
    sendList: async ({ bodyText, buttonLabel, sections, footerText }) => {
      calls.push({
        kind: 'list',
        bodyText,
        buttonLabel,
        sections: sections.map((s) => ({ rows: s.rows })),
        footerText,
      })
    },
  }
  return { calls, sender }
}

type Recorder = ReturnType<typeof makeRecorder>

async function send(
  db: FakeDb,
  rec: Recorder,
  input: { text?: string; replyId?: string | null },
  now: Date = NOW,
  opts: { humanOwned?: boolean } = {},
) {
  const inboundMessageId = seedInbound(db, input)
  return handleAgendaInbound({
    db: db as unknown as SupabaseClient,
    sender: rec.sender,
    now,
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    inboundMessageId,
    session: currentSession(db, now),
    humanOwned: opts.humanOwned,
  })
}

/** Como lo llama el dispatcher cuando un humano es dueño del hilo (D1). */
const sendHuman = (
  db: FakeDb,
  rec: Recorder,
  input: { text?: string; replyId?: string | null },
) => send(db, rec, input, NOW, { humanOwned: true })

function last(rec: Recorder): SenderCall {
  const call = rec.calls.at(-1)
  if (!call) throw new Error('el bot no envió nada')
  return call
}

function optionTitles(call: SenderCall): string[] {
  if (call.kind === 'buttons') return (call.buttons ?? []).map((b) => b.title)
  return (call.sections ?? []).flatMap((s) => s.rows.map((r) => r.title))
}

function optionIds(call: SenderCall): string[] {
  if (call.kind === 'buttons') return (call.buttons ?? []).map((b) => b.id)
  return (call.sections ?? []).flatMap((s) => s.rows.map((r) => r.id))
}

function sessionRow(db: FakeDb): Row | undefined {
  return db._tables.booking_sessions.find((r) => r.status === 'active')
}

function messagesWith(rec: Recorder, needle: string): SenderCall[] {
  return rec.calls.filter((c) => c.bodyText.includes(needle))
}

/** Cambia la configuración del negocio (booking_settings) dentro de un test. */
function setSettings(db: FakeDb, patch: Row) {
  Object.assign(db._tables.booking_settings[0], patch)
}

/** Camino feliz hasta el menú de días (corte clásico con Andrés). */
async function walkToDay(db: FakeDb, rec: Recorder) {
  await send(db, rec, { text: 'hola' })
  await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
  await send(db, rec, { replyId: staffId(STAFF_ANDRES) })
}

// ------------------------------------------------------------
// Tests
// ------------------------------------------------------------

describe('mensajes ajenos al flujo', () => {
  it('un mensaje que no es de citas no se consume ni abre sesión', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { text: '¿tienen parqueadero?' })

    expect(res.consumed).toBe(false)
    expect(db._tables.booking_sessions).toHaveLength(0)
    expect(rec.calls).toHaveLength(0)
  })
})

describe('arranque del flujo', () => {
  it('un saludo abre sesión y muestra el menú de servicios', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { text: '¡Hola!' })

    expect(res.consumed).toBe(true)
    const session = sessionRow(db)
    expect(session?.status).toBe('active')
    expect((session?.state as Record<string, unknown>).step).toBe('pick_service')
    expect(session?.expires_at).toBe('2026-10-19T13:15:00.000Z')

    const call = last(rec)
    expect(call.bodyText).toContain('servicio')
    expect(optionTitles(call)).toEqual(['Corte clásico', 'Perfilado de barba'])
  })

  it('un número elige el servicio del último menú', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { text: '2' })

    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.serviceId).toBe(SERVICE_BARBA)
    // Solo Andrés hace barba: se salta el menú de barberos.
    expect(state.step).toBe('pick_day')
    expect(state.staffId).toBe(STAFF_ANDRES)
    expect(last(rec).bodyText).toContain('día')
  })
})

describe('selección de barbero', () => {
  it('con varios barberos elegibles ofrece Cualquiera', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    const call = last(rec)
    expect(call.bodyText).toContain('barbero')
    expect(optionTitles(call)).toEqual(['Andrés', 'Beto', 'Cualquiera'])

    await send(db, rec, { replyId: staffId('any') })
    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.staffId).toBe('any')
    expect(state.step).toBe('pick_day')
  })

  it('un solo barbero elegible se selecciona sin preguntar', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_BARBA) })

    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.staffId).toBe(STAFF_ANDRES)
    expect(last(rec).bodyText).not.toContain('barbero')
    expect(last(rec).bodyText).toContain('día')
  })
})

describe('disponibilidad', () => {
  it('solo ofrece días con cupo (el fixture solo trabaja los lunes)', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)

    // La rejilla de días de 7 día de la semana, solo el lunes tiene bloques.
    const dayMenu = rec.calls.find((c) => optionIds(c).some((id) => id.startsWith('day:')))
    expect(dayMenu).toBeDefined()
    expect(optionTitles(dayMenu!)).toEqual(['Hoy'])
  })

  it('excluye horas ocupadas por citas existentes', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [
      appointmentRow({
        id: 'appt-busy',
        contact_id: 'ct-otro-cliente',
        starts_at: '2026-10-19T14:00:00.000Z', // 9:00 local
        ends_at: '2026-10-19T14:30:00.000Z',
        status: 'confirmed',
      }),
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })

    const call = last(rec)
    const titles = optionTitles(call)
    expect(titles).not.toContain('9:00 a. m.')
    expect(titles).toContain('9:30 a. m.')
    expect(optionIds(call)).not.toContain(
      slotId('2026-10-19T14:00:00.000Z'),
    )
    expect(optionIds(call)).toContain(slotId('2026-10-19T14:30:00.000Z'))
  })

  it('recorta la lista de horas a 10 con un aviso al pie', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })

    const call = last(rec)
    expect(call.kind).toBe('list')
    expect(optionIds(call)).toHaveLength(10)
    expect(call.footerText).toContain('primeras')
  })
})

describe('resumen y confirmación', () => {
  it('el resumen muestra servicio, barbero, fecha, hora y precio', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T14:00:00.000Z') })

    const call = last(rec)
    expect(call.kind).toBe('buttons')
    expect(optionTitles(call)).toEqual(['Confirmar ✅', 'Reprogramar', 'Cancelar'])
    expect(call.bodyText).toContain('Corte clásico')
    expect(call.bodyText).toContain('Andrés')
    expect(call.bodyText).toContain('lunes 19 de octubre de 2026')
    expect(call.bodyText).toContain('9:00 a. m.')
    expect(call.bodyText).toContain('$25.000')
  })

  it('confirmar deja rastro completo: cita, etiqueta, negocio y evento', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T14:00:00.000Z') })
    const res = await send(db, rec, { replyId: 'act:confirm' })

    expect(res.consumed).toBe(true)

    // Cita confirmada.
    const appointments = db._tables.booking_appointments
    expect(appointments).toHaveLength(1)
    const appt = appointments[0]
    expect(appt).toMatchObject({
      account_id: ACCOUNT,
      contact_id: CONTACT,
      conversation_id: CONVERSATION,
      service_id: SERVICE_CORTE,
      staff_id: STAFF_ANDRES,
      starts_at: '2026-10-19T14:00:00.000Z',
      ends_at: '2026-10-19T14:30:00.000Z',
      status: 'confirmed',
      created_via: 'bot',
    })
    expect(appt.confirmed_at).toBe('2026-10-19T13:00:00.000Z')

    // Etiqueta de contacto.
    const tag = db._tables.tags.find((t) => t.id === TAG_CONFIRMADA)
    expect(
      db._tables.contact_tags.some(
        (ct) => ct.contact_id === CONTACT && ct.tag_id === tag?.id,
      ),
    ).toBe(true)

    // Negocio en el pipeline de barbería.
    const deal = db._tables.deals[0]
    expect(deal).toMatchObject({
      account_id: ACCOUNT,
      pipeline_id: PIPELINE,
      stage_id: STAGE,
      contact_id: CONTACT,
      value: 25000,
      currency: 'COP',
      status: 'open',
    })
    expect(String(deal.title)).toContain('Corte clásico')

    // Evento del bot.
    const event = db._tables.booking_events[0]
    expect(event).toMatchObject({
      account_id: ACCOUNT,
      appointment_id: appt.id,
      event: 'confirmed',
      actor: 'bot',
    })

    // Sesión cerrada.
    const session = sessionRow(db)
    expect(session).toBeUndefined()
    expect(
      db._tables.booking_sessions.every((s) => s.status === 'completed'),
    ).toBe(true)

    // Mensaje final.
    expect(last(rec).bodyText).toContain('Quedó agendado')
    expect(last(rec).bodyText).toContain('9:00 a. m.')
  })
})

describe('carreras por la misma hora', () => {
  it('si la hora se ocupa antes del resumen, avisa y vuelve al menú de horas', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })

    // Alguien más agenda justo antes de que el cliente toque su hora.
    db._tables.booking_appointments.push(
      appointmentRow({
        id: 'appt-race',
        staff_id: STAFF_ANDRES,
        starts_at: '2026-10-19T14:00:00.000Z',
        ends_at: '2026-10-19T14:30:00.000Z',
        status: 'confirmed',
      }),
    )
    await send(db, rec, { replyId: slotId('2026-10-19T14:00:00.000Z') })

    expect(messagesWith(rec, 'ocupó')).toHaveLength(1)
    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.step).toBe('pick_slot')
    expect(db._tables.booking_appointments).toHaveLength(1)
    // Las alternativas nuevas ya no incluyen la hora tomada.
    expect(optionIds(last(rec))).not.toContain(
      slotId('2026-10-19T14:00:00.000Z'),
    )
  })

  it('si la hora se ocupa al confirmar, no agenda y ofrece alternativas', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T14:00:00.000Z') })

    db._tables.booking_appointments.push(
      appointmentRow({
        id: 'appt-race',
        staff_id: STAFF_ANDRES,
        starts_at: '2026-10-19T14:00:00.000Z',
        ends_at: '2026-10-19T14:30:00.000Z',
        status: 'confirmed',
      }),
    )
    const res = await send(db, rec, { replyId: 'act:confirm' })

    expect(res.consumed).toBe(true)
    expect(messagesWith(rec, 'ocupó')).toHaveLength(1)
    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.step).toBe('pick_slot')
    // Solo queda la cita del intruso: la nuestra no se creó.
    expect(db._tables.booking_appointments).toHaveLength(1)
    expect(db._tables.booking_appointments[0].id).toBe('appt-race')
  })

  it('dos "Confirmar" a la vez (doble tap con Cualquiera) dejan UNA sola cita', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    await send(db, rec, { replyId: staffId('any') })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:30:00.000Z') }) // ambos libres
    const before = rec.calls.length

    // Los dos webhooks leen la misma sesión antes de que cualquiera escriba.
    const [a, b] = await Promise.all([
      send(db, rec, { replyId: 'act:confirm' }),
      send(db, rec, { replyId: 'act:confirm' }),
    ])

    expect(a.consumed).toBe(true)
    expect(b.consumed).toBe(true)
    expect(db._tables.booking_appointments).toHaveLength(1)
    const sent = rec.calls.slice(before)
    // Una confirmación y nada que la contradiga.
    expect(sent).toHaveLength(1)
    expect(sent[0].bodyText).toContain('Quedó agendado')
    expect(messagesWith(rec, 'ocupó')).toHaveLength(0)
    expect(sessionRow(db)).toBeUndefined()
  })

  it('si la cita no se crea, la sesión reclamada vuelve a quedar activa', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T14:00:00.000Z') })

    db._failNext('insert', 'booking_appointments', { message: 'timeout' })
    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.booking_appointments).toHaveLength(0)
    expect(last(rec).kind).toBe('buttons') // re-ofrece el resumen
    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe(
      'summary',
    )

    // El reintento funciona sobre la misma sesión.
    await send(db, rec, { replyId: 'act:confirm' })
    expect(db._tables.booking_appointments).toHaveLength(1)
  })

  it('un choque a nivel de base de datos (EXCLUDE) se trata como hora ocupada', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T14:00:00.000Z') })

    db._failNext('insert', 'booking_appointments', {
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint',
    })
    await send(db, rec, { replyId: 'act:confirm' })

    expect(messagesWith(rec, 'ocupó')).toHaveLength(1)
    expect(db._tables.booking_appointments).toHaveLength(0)
    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe(
      'pick_slot',
    )
  })
})

describe('expiración de la sesión', () => {
  it('una sesión vencida se marca expirada y no se consume el mensaje', async () => {
    const seed = baseSeed()
    seed.booking_sessions = [
      {
        id: 'sess-old',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        state: { step: 'pick_service', mode: 'book', options: [], fails: 0 },
        status: 'active',
        expires_at: '2026-10-19T12:59:00.000Z',
        updated_at: '2026-10-19T12:44:00.000Z',
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { text: '2' })

    expect(res.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_sessions[0].status).toBe('expired')
  })

  it('tras expirar, una intención abre una sesión nueva', async () => {
    const seed = baseSeed()
    seed.booking_sessions = [
      {
        id: 'sess-old',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        state: { step: 'pick_service', mode: 'book', options: [], fails: 0 },
        status: 'active',
        expires_at: '2026-10-19T12:59:00.000Z',
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'hola' })

    expect(res.consumed).toBe(true)
    expect(db._tables.booking_sessions).toHaveLength(2)
    const old = db._tables.booking_sessions.find((s) => s.id === 'sess-old')
    expect(old?.status).toBe('expired')
    const fresh = sessionRow(db)
    expect(fresh?.id).not.toBe('sess-old')
    expect(fresh?.expires_at).toBe('2026-10-19T13:15:00.000Z')
  })

  it('cada mensaje de la sesión refresca la expiración (15 min)', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    expect(sessionRow(db)?.expires_at).toBe('2026-10-19T13:15:00.000Z')

    // 10 minutos después: la sesión sigue vigente y se extiende.
    const later = new Date('2026-10-19T13:10:00Z')
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) }, later)

    expect(sessionRow(db)?.expires_at).toBe('2026-10-19T13:25:00.000Z')
  })
})

describe('gestión de una cita existente', () => {
  it('saludar teniendo cita próxima abre el menú de gestión', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'cita' })

    expect(res.consumed).toBe(true)
    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.step).toBe('manage_menu')
    expect(state.appointmentId).toBe('appt-old')

    const call = last(rec)
    expect(call.bodyText).toContain('Corte clásico')
    expect(optionTitles(call)).toEqual([
      'Agendar otra vez',
      'Reprogramar',
      'Cancelar cita',
    ])
  })

  it('cancelar pide confirmación y deja rastro completo', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'cita' })
    await send(db, rec, { replyId: 'act:cancel' })

    expect(last(rec).bodyText).toContain('¿Seguro')
    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe(
      'manage_cancel_confirm',
    )

    await send(db, rec, { replyId: 'act:cancel_yes' })

    const appt = db._tables.booking_appointments[0]
    expect(appt.status).toBe('cancelled')
    expect(appt.cancel_reason).toBe('cliente')
    expect(appt.cancelled_at).toBe('2026-10-19T13:00:00.000Z')

    const tag = db._tables.tags.find((t) => t.id === TAG_CANCELADA)
    expect(
      db._tables.contact_tags.some(
        (ct) => ct.contact_id === CONTACT && ct.tag_id === tag?.id,
      ),
    ).toBe(true)

    const event = db._tables.booking_events.find(
      (e) => e.event === 'cancelled',
    )
    expect(event).toMatchObject({
      appointment_id: 'appt-old',
      actor: 'bot',
    })

    expect(last(rec).bodyText).toContain('quedó cancelado')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('arrepentirse de cancelar deja la cita intacta', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'cita' })
    await send(db, rec, { replyId: 'act:cancel' })
    await send(db, rec, { replyId: 'act:back' })

    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(db._tables.booking_events).toHaveLength(0)
    expect(last(rec).bodyText).toContain('como está')
  })

  it('reprogramar conserva la trazabilidad con rescheduled_from', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'cita' })
    await send(db, rec, { replyId: 'act:reschedule' })
    expect(last(rec).bodyText).toContain('nuevo día')

    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:00:00.000Z') }) // 11:00 local
    await send(db, rec, { replyId: 'act:confirm' })

    const appointments = db._tables.booking_appointments
    expect(appointments).toHaveLength(2)

    const fresh = appointments.find((a) => a.id !== 'appt-old')
    expect(fresh).toMatchObject({
      contact_id: CONTACT,
      service_id: SERVICE_CORTE,
      staff_id: STAFF_ANDRES,
      starts_at: '2026-10-19T16:00:00.000Z',
      status: 'confirmed',
      created_via: 'bot',
      rescheduled_from: 'appt-old',
    })

    const old = appointments.find((a) => a.id === 'appt-old')
    expect(old?.status).toBe('cancelled')
    expect(old?.cancel_reason).toBe('reprogramada')

    const tag = db._tables.tags.find((t) => t.id === TAG_REPROGRAMADA)
    expect(
      db._tables.contact_tags.some(
        (ct) => ct.contact_id === CONTACT && ct.tag_id === tag?.id,
      ),
    ).toBe(true)

    const event = db._tables.booking_events.find(
      (e) => e.event === 'rescheduled',
    )
    expect(event).toMatchObject({ appointment_id: fresh?.id, actor: 'bot' })
    expect((event?.payload as Record<string, unknown>).from_appointment_id).toBe(
      'appt-old',
    )

    expect(last(rec).bodyText).toContain('Quedó reprogramado')
  })
})

describe('escrituras críticas que fallan', () => {
  const silence = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('si cancelar falla, responde confirmError (no "cancelada") y re-ofrece la confirmación', async () => {
    silence()
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'cita' })
    await send(db, rec, { replyId: 'act:cancel' })
    db._failNext('update', 'booking_appointments', { message: 'timeout' })
    const res = await send(db, rec, { replyId: 'act:cancel_yes' })

    expect(res.consumed).toBe(true)
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.confirmError)).toHaveLength(1)
    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.cancelDone)).toHaveLength(0)
    expect(db._tables.booking_events).toHaveLength(0)
    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe(
      'manage_cancel_confirm',
    )
  })

  it('si confirmar desde el recordatorio falla, responde confirmError (no "confirmada")', async () => {
    silence()
    const seed = baseSeed()
    seed.booking_appointments = [
      appointmentRow({ status: 'pending', confirmed_at: null }),
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    db._failNext('update', 'booking_appointments', { message: 'timeout' })
    const res = await send(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    expect(db._tables.booking_appointments[0].status).toBe('pending')
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.confirmError)
    expect(messagesWith(rec, 'Queda confirmado')).toHaveLength(0)
    expect(db._tables.booking_events).toHaveLength(0)
  })

  it('si al reprogramar no se puede cancelar la cita anterior, deshace la nueva', async () => {
    silence()
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'cita' })
    await send(db, rec, { replyId: 'act:reschedule' })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:00:00.000Z') })
    db._failNext('update', 'booking_appointments', { message: 'timeout' })
    await send(db, rec, { replyId: 'act:confirm' })

    const active = db._tables.booking_appointments.filter(
      (a) => a.status === 'confirmed' || a.status === 'pending',
    )
    // El cliente conserva SOLO su cita original.
    expect(active.map((a) => a.id)).toEqual(['appt-old'])
    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.confirmError)).toHaveLength(1)
    expect(messagesWith(rec, 'Quedó reprogramado')).toHaveLength(0)
    expect(sessionRow(db)).toBeDefined()
  })

  it('si pausar el bot falla en el handoff, el error sube y no se promete un humano', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    db._failNext('update', 'conversations', { message: 'timeout' })

    await expect(send(db, rec, { text: 'necesito un asesor' })).rejects.toThrow()
    expect(messagesWith(rec, 'asesor humano')).toHaveLength(0)
  })
})

describe('Cualquiera asigna al barbero disponible', () => {
  it('confirma con el primer candidato libre', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    await send(db, rec, { replyId: staffId('any') })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:30:00.000Z') }) // 11:30, ambos libres

    expect(last(rec).bodyText).toContain('Cualquiera')

    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.booking_appointments[0].staff_id).toBe(STAFF_ANDRES)
    expect(last(rec).bodyText).toContain('Andrés')
  })

  it('si el primero se ocupó, cae al siguiente candidato', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    await send(db, rec, { replyId: staffId('any') })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:30:00.000Z') })

    // Andrés se ocupa entre el resumen y la confirmación.
    db._tables.booking_appointments.push(
      appointmentRow({
        id: 'appt-race',
        staff_id: STAFF_ANDRES,
        starts_at: '2026-10-19T16:30:00.000Z',
        ends_at: '2026-10-19T17:00:00.000Z',
        status: 'confirmed',
      }),
    )

    await send(db, rec, { replyId: 'act:confirm' })

    const ours = db._tables.booking_appointments.find(
      (a) => a.id !== 'appt-race',
    )
    expect(ours?.staff_id).toBe(STAFF_BETO)
    expect(last(rec).bodyText).toContain('Beto')
  })
})

describe('handoff a un humano', () => {
  it('pide asesor: IA en pausa, etiqueta, asignación, aviso y mensaje', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'quiero hablar con una persona' })

    expect(res.consumed).toBe(true)

    const conv = db._tables.conversations[0]
    expect(conv.ai_autoreply_disabled).toBe(true)
    expect(String(conv.ai_handoff_summary)).toContain('persona')
    expect(conv.assigned_agent_id).toBe(HANDOFF_AGENT)

    const tag = db._tables.tags.find((t) => t.id === TAG_HUMANO)
    expect(
      db._tables.contact_tags.some(
        (ct) => ct.contact_id === CONTACT && ct.tag_id === tag?.id,
      ),
    ).toBe(true)

    const notification = db._tables.notifications[0]
    expect(notification).toMatchObject({
      account_id: ACCOUNT,
      user_id: OWNER,
      type: 'conversation_assigned',
      conversation_id: CONVERSATION,
      contact_id: CONTACT,
    })
    expect(String(notification.title)).toContain('Agenda')
    expect(String(notification.body)).toContain('Carlos')

    expect(last(rec).bodyText).toContain('asesor humano')
    // Un pedido de humano no abre flujo de citas.
    expect(db._tables.booking_sessions).toHaveLength(0)
  })

  it('sin agente de handoff configurado igual avisa al dueño', async () => {
    const seed = baseSeed()
    seed.ai_configs = [{ account_id: ACCOUNT, handoff_agent_id: null }]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'necesito un asesor' })

    const conv = db._tables.conversations[0]
    expect(conv.ai_autoreply_disabled).toBe(true)
    expect(conv.assigned_agent_id).toBeNull()
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0].user_id).toBe(OWNER)
  })

  it('dos respuestas inválidas seguidas escalan a un humano', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    await send(db, rec, { text: 'no sé qué poner' })
    expect(messagesWith(rec, 'No entendí')).toHaveLength(1)
    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.fails).toBe(1)
    expect(state.step).toBe('pick_service')

    await send(db, rec, { text: 'zzz' })
    expect(last(rec).bodyText).toContain('asesor humano')
    expect(
      db._tables.contact_tags.some((ct) => ct.tag_id === TAG_HUMANO),
    ).toBe(true)
    expect(sessionRow(db)).toBeUndefined()
    expect(
      db._tables.booking_sessions.every((s) => s.status === 'cancelled'),
    ).toBe(true)
  })

  it('pedir humano en medio del flujo también escala y cierra la sesión', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    const res = await send(db, rec, { text: 'mejor quiero un humano' })

    expect(res.consumed).toBe(true)
    expect(last(rec).bodyText).toContain('asesor humano')
    expect(sessionRow(db)).toBeUndefined()
    expect(db._tables.booking_appointments).toHaveLength(0)
  })
})

describe('botones del recordatorio (rem:*)', () => {
  it('confirmar actualiza la cita y registra el evento, sin abrir sesión', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [
      appointmentRow({ status: 'pending', confirmed_at: null }),
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    const appt = db._tables.booking_appointments[0]
    expect(appt.status).toBe('confirmed')
    expect(appt.confirmed_at).toBe('2026-10-19T13:00:00.000Z')

    const event = db._tables.booking_events.find(
      (e) => e.event === 'confirmed',
    )
    expect(event).toMatchObject({ appointment_id: 'appt-old', actor: 'bot' })
    expect(db._tables.contact_tags ?? []).toHaveLength(0)

    expect(last(rec).bodyText).toContain('Queda confirmado')
    expect(last(rec).bodyText).toContain('Corte clásico')
    expect(last(rec).bodyText).toContain('Andrés')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('confirmar una cita ya confirmada es idempotente y también responde', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow({ status: 'confirmed' })]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    const appt = db._tables.booking_appointments[0]
    expect(appt.status).toBe('confirmed')
    expect(appt.confirmed_at).toBe('2026-10-19T13:00:00.000Z')
    expect(last(rec).bodyText).toContain('Queda confirmado')
  })

  it('sin cita próxima activa avisa que ya no está en vez de inventar', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow({ status: 'cancelled' })]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    expect(last(rec).bodyText).toContain('ya no está activo')
    expect(sessionRow(db)).toBeUndefined()
    expect(db._tables.booking_events).toHaveLength(0)
  })

  it('reprogramar abre el flujo existente con la cita del recordatorio', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:reschedule' })

    expect(res.consumed).toBe(true)
    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.step).toBe('pick_day')
    expect(state.mode).toBe('reschedule')
    expect(state.appointmentId).toBe('appt-old')
    expect(state.serviceId).toBe(SERVICE_CORTE)
    expect(state.staffId).toBe(STAFF_ANDRES)
    expect(last(rec).bodyText).toContain('nuevo día')
  })

  it('cancelar entra al flujo existente y el "Sí, cancelar" cancela de verdad', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:cancel' })

    expect(res.consumed).toBe(true)
    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe(
      'manage_cancel_confirm',
    )
    expect(last(rec).bodyText).toContain('¿Seguro')
    expect(optionTitles(last(rec))).toContain('Sí, cancelar')

    await send(db, rec, { replyId: 'act:cancel_yes' })

    const appt = db._tables.booking_appointments[0]
    expect(appt.status).toBe('cancelled')
    expect(appt.cancel_reason).toBe('cliente')
    expect(last(rec).bodyText).toContain('quedó cancelado')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('con una sesión a medias reutiliza la fila en vez de duplicarla', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    const sessionId = sessionRow(db)?.id

    await send(db, rec, { replyId: 'rem:reschedule' })

    const active = db._tables.booking_sessions.filter(
      (r) => r.status === 'active',
    )
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe(sessionId)
    const state = active[0].state as Record<string, unknown>
    expect(state.step).toBe('pick_day')
    expect(state.mode).toBe('reschedule')
  })

  it('reprogramar con una sesión vencida que sigue "active" la expira y el flujo avanza', async () => {
    // Reserva abandonada de ayer: quedó 'active' con expires_at vencido.
    // El dispatcher no la entrega (está vencida), pero el índice único
    // de sesión activa sigue contándola.
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    seed.booking_sessions = [
      {
        id: 'sess-abandonada',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        state: { step: 'pick_service', mode: 'book', options: [], fails: 0 },
        status: 'active',
        expires_at: '2026-10-18T20:00:00.000Z',
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:reschedule' })

    expect(res.consumed).toBe(true)
    const old = db._tables.booking_sessions.find(
      (s) => s.id === 'sess-abandonada',
    )
    expect(old?.status).toBe('expired')
    const fresh = sessionRow(db)
    expect(fresh?.id).not.toBe('sess-abandonada')
    expect((fresh?.state as Record<string, unknown>).step).toBe('pick_day')

    // El siguiente tap (un día) encuentra la sesión y avanza.
    const next = await send(db, rec, { replyId: dayId(MONDAY) })
    expect(next.consumed).toBe(true)
    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe(
      'pick_slot',
    )
  })

  it('si crear la sesión falla, el error sube (no se manda un menú huérfano)', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    db._failNext('insert', 'booking_sessions', { message: 'boom' })

    await expect(
      send(db, rec, { replyId: 'rem:reschedule' }),
    ).rejects.toThrow()
    expect(rec.calls).toHaveLength(0)
  })

  it('un rem:* desconocido no se consume ni arranca nada', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:tomar' })

    expect(res.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
    expect(sessionRow(db)).toBeUndefined()
  })
})

describe('recordatorio con un humano a cargo del chat (D1)', () => {
  function humanSeed(assignedAgentId: string | null = HANDOFF_AGENT) {
    const seed = baseSeed()
    seed.booking_appointments = [
      appointmentRow({ status: 'pending', confirmed_at: null }),
    ]
    seed.conversations[0].assigned_agent_id = assignedAgentId
    seed.conversations[0].ai_autoreply_disabled = assignedAgentId === null
    return seed
  }

  it('Confirmar funciona aunque haya agente asignado', async () => {
    const db = makeFakeDb(humanSeed())
    const rec = makeRecorder()

    const res = await sendHuman(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(last(rec).bodyText).toContain('Queda confirmado')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('Cancelar funciona aunque la IA esté en pausa: pide confirmación y cancela', async () => {
    const db = makeFakeDb(humanSeed(null))
    const rec = makeRecorder()

    const first = await sendHuman(db, rec, { replyId: 'rem:cancel' })
    expect(first.consumed).toBe(true)
    expect(optionTitles(last(rec))).toContain('Sí, cancelar')

    const second = await sendHuman(db, rec, { replyId: 'act:cancel_yes' })
    expect(second.consumed).toBe(true)
    expect(db._tables.booking_appointments[0].status).toBe('cancelled')
    expect(last(rec).bodyText).toContain('quedó cancelado')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('Reprogramar con agente asignado NO abre el flujo: avisa al agente, registra y responde', async () => {
    const db = makeFakeDb(humanSeed())
    const rec = makeRecorder()

    const res = await sendHuman(db, rec, { replyId: 'rem:reschedule' })

    expect(res.consumed).toBe(true)
    // Sin flujo del bot y la cita intacta.
    expect(db._tables.booking_sessions).toHaveLength(0)
    expect(db._tables.booking_appointments[0].status).toBe('pending')
    // Aviso al agente asignado.
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: HANDOFF_AGENT,
      type: 'conversation_assigned',
      conversation_id: CONVERSATION,
      contact_id: CONTACT,
    })
    expect(String(db._tables.notifications[0].body)).toContain('Carlos')
    // Intento registrado.
    const event = db._tables.booking_events.find(
      (e) => e.event === 'reschedule_requested',
    )
    expect(event).toMatchObject({ appointment_id: 'appt-old', actor: 'bot' })
    // El cliente sabe que sigue un humano.
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.rescheduleHandedToHuman)
    expect(rec.calls).toHaveLength(1)
  })

  it('Reprogramar con la IA en pausa y sin agente avisa al dueño', async () => {
    const db = makeFakeDb(humanSeed(null))
    const rec = makeRecorder()

    await sendHuman(db, rec, { replyId: 'rem:reschedule' })

    expect(db._tables.notifications[0].user_id).toBe(OWNER)
    expect(db._tables.booking_sessions).toHaveLength(0)
  })

  it('cualquier otro mensaje en el hilo del humano no se consume ni responde', async () => {
    const db = makeFakeDb(humanSeed())
    const rec = makeRecorder()

    const greeting = await sendHuman(db, rec, { text: 'hola, quiero una cita' })
    const handoffWord = await sendHuman(db, rec, { text: 'asesor' })
    const staleTap = await sendHuman(db, rec, { replyId: dayId(MONDAY) })

    expect(greeting.consumed).toBe(false)
    expect(handoffWord.consumed).toBe(false)
    expect(staleTap.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
  })

  it('sin humano a cargo, Reprogramar sigue abriendo el flujo normal', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:reschedule' })

    expect((sessionRow(db)?.state as Record<string, unknown>).step).toBe('pick_day')
    expect(db._tables.notifications).toHaveLength(0)
  })
})

describe('textos del bot personalizados (Fase 4)', () => {
  it('usa la bienvenida configurada en booking_settings.bot_texts', async () => {
    const seed = baseSeed()
    seed.booking_settings = [
      {
        account_id: ACCOUNT,
        bot_texts: { welcome: '¡Hola de Don Pedro! 💈 ¿Qué te agendo?' },
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(last(rec).bodyText).toBe(
      '¡Hola de Don Pedro! 💈 ¿Qué te agendo?',
    )
    // El menú (botones) y el resto del flujo no cambian.
    expect(optionTitles(last(rec))).toEqual([
      'Corte clásico',
      'Perfilado de barba',
    ])
  })

  it('sin overrides usa el copy por defecto', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.serviceMenuBody)
  })

  it('un override con basura (tipo equivocado) no rompe: cae al default', async () => {
    const seed = baseSeed()
    seed.booking_settings = [
      { account_id: ACCOUNT, bot_texts: { welcome: 42 } },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'hola' })

    expect(res.consumed).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.serviceMenuBody)
  })

  it('el reintento también es editable', async () => {
    const seed = baseSeed()
    seed.booking_settings = [
      {
        account_id: ACCOUNT,
        bot_texts: { retry: 'Mmm, no te entendí. Toca una opción 🙂' },
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { text: 'quiero un tinte verde' })

    // El retry va y después el menú se re-ofrece (re-pregunta).
    expect(messagesWith(rec, 'Mmm, no te entendí')).toHaveLength(1)
    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.retry)).toHaveLength(0)
    expect(last(rec).kind).toBe('buttons')
  })

  it('los overrides de otra cuenta no se filtran', async () => {
    const seed = baseSeed()
    seed.booking_settings = [
      {
        account_id: 'acc-otra',
        bot_texts: { welcome: 'Texto de otra barbería' },
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.serviceMenuBody)
  })
})

// ------------------------------------------------------------
// Palabras y piezas del negocio (051)
// ------------------------------------------------------------

/** Cuatro servicios: el menú sale como lista y muestra descripción por fila. */
function withFourServices(db: FakeDb) {
  for (const n of [1, 2]) {
    db._tables.booking_services.push({
      id: `svc-extra-${n}`,
      account_id: ACCOUNT,
      name: `Extra ${n}`,
      description: null,
      duration_minutes: 45,
      price: 40000,
      is_active: true,
      position: 1 + n,
    })
  }
}

function listDescriptions(call: SenderCall): (string | undefined)[] {
  expect(call.kind).toBe('list')
  return (call.sections ?? []).flatMap((s) => s.rows.map((r) => r.description))
}

describe('palabras y piezas del negocio', () => {
  it('usa las palabras configuradas en el menú de profesionales', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { profesional: 'estilista', profesionales: 'estilistas' } })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    expect(last(rec).bodyText).toBe('¿Con qué estilista quieres tu cita?')
  })

  it('sin fila de configuración usa las palabras y piezas por defecto', async () => {
    const seed = baseSeed()
    seed.booking_settings = []
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    expect(last(rec).bodyText).toBe('¿Con qué profesional quieres tu cita?')
  })

  it('palabras corruptas en la base no rompen: caen al valor por defecto', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { profesional: 42, profesionales: '*mal*', cita: '  ' } })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    expect(last(rec).bodyText).toBe('¿Con qué profesional quieres tu cita?')
  })

  it('choose_staff apagado: no pregunta con quién y asigna a cualquiera', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { choose_staff: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.staffId).toBe('any')
    expect(state.step).toBe('pick_day')
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.dayMenuBody)
  })

  it('choose_staff apagado: el resumen no tiene línea de profesional y la confirmación muestra el asignado', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { choose_staff: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:30:00.000Z') }) // ambos libres

    expect(last(rec).bodyText).toContain('Corte clásico')
    expect(last(rec).bodyText).not.toContain('👤')
    expect(last(rec).bodyText).not.toContain('Cualquiera')

    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.booking_appointments[0].staff_id).toBe(STAFF_ANDRES)
    expect(last(rec).bodyText).toContain('👤 Andrés')
  })

  it('show_price y show_duration prendidos: la fila del menú muestra duración y precio', async () => {
    const db = makeFakeDb(baseSeed())
    withFourServices(db)
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    const descriptions = listDescriptions(last(rec))
    expect(descriptions).toHaveLength(4)
    expect(descriptions[0]).toContain('30 min')
    expect(descriptions[0]).toContain('25.000')
  })

  it('show_price y show_duration apagados: la fila del menú no tiene descripción', async () => {
    const db = makeFakeDb(baseSeed())
    withFourServices(db)
    setSettings(db, { show_price: false, show_duration: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(listDescriptions(last(rec))).toEqual([undefined, undefined, undefined, undefined])
  })

  it('solo show_price apagado: la fila muestra solo la duración', async () => {
    const db = makeFakeDb(baseSeed())
    withFourServices(db)
    setSettings(db, { show_price: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(listDescriptions(last(rec))[0]).toBe('30 min')
  })

  it('show_price apagado: el resumen no muestra precio', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { show_price: false })
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: optionIds(last(rec))[0] })
    await send(db, rec, { replyId: optionIds(last(rec))[0] })

    expect(last(rec).bodyText).toContain('Así queda tu cita')
    expect(last(rec).bodyText).not.toContain('💵')
  })

  it('una palabra propia ("sesión") abre el flujo', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { cita: 'sesión', citas: 'sesiones' } })
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'quiero una sesión' })

    expect(res.consumed).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.serviceMenuBody)
  })

  it('una palabra propia con signos de regex no tumba el flujo', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { cita: 'consulta (vip', citas: 'consultas [x' } })
    const rec = makeRecorder()

    await expect(send(db, rec, { text: 'buenas tardes' })).resolves.toEqual({ consumed: false })
  })

  it('sin la palabra propia, un mensaje ajeno no abre el flujo', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'quiero una sesión' })

    expect(res.consumed).toBe(false)
  })
})

// ------------------------------------------------------------
// Revisión: piezas, límites de Meta y títulos
// ------------------------------------------------------------

/** Mitad de un par sustituto sin su compañera. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Andrés ocupado a las 10:00 locales (15:00Z) con la cita de otro cliente. */
function blockAndresAtTen(db: FakeDb) {
  db._tables.booking_appointments.push(
    appointmentRow({
      id: 'appt-block',
      contact_id: 'ct-otro',
      staff_id: STAFF_ANDRES,
      starts_at: '2026-10-19T15:00:00.000Z',
      ends_at: '2026-10-19T15:30:00.000Z',
    }),
  )
}

const TEN_O_CLOCK = slotId('2026-10-19T15:00:00.000Z')

describe('reprogramar con "elegir profesional" apagado', () => {
  async function rescheduleSlots(chooseStaff: boolean, via: 'menu' | 'recordatorio') {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow()] // cita de Andrés, el miércoles
    const db = makeFakeDb(seed)
    blockAndresAtTen(db)
    setSettings(db, { choose_staff: chooseStaff })
    const rec = makeRecorder()

    if (via === 'menu') {
      await send(db, rec, { text: 'cita' })
      await send(db, rec, { replyId: 'act:reschedule' })
    } else {
      await send(db, rec, { replyId: 'rem:reschedule' })
    }
    await send(db, rec, { replyId: dayId(MONDAY) })
    return optionIds(last(rec))
  }

  it('desde el menú de la cita: ofrece también las horas de los demás', async () => {
    expect(await rescheduleSlots(false, 'menu')).toContain(TEN_O_CLOCK)
  })

  it('desde el recordatorio: ofrece también las horas de los demás', async () => {
    expect(await rescheduleSlots(false, 'recordatorio')).toContain(TEN_O_CLOCK)
  })

  it('con la pieza prendida se queda con el profesional de la cita', async () => {
    expect(await rescheduleSlots(true, 'menu')).not.toContain(TEN_O_CLOCK)
    expect(await rescheduleSlots(true, 'recordatorio')).not.toContain(TEN_O_CLOCK)
  })
})

describe('"elegir profesional" apagado: resumen y asignación', () => {
  it('con un solo profesional elegible el resumen tampoco muestra 👤; la confirmación sí', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { choose_staff: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_BARBA) }) // solo Andrés la hace
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: optionIds(last(rec))[0] })

    expect(last(rec).bodyText).toContain('Perfilado de barba')
    expect(last(rec).bodyText).not.toContain('👤')
    expect(last(rec).bodyText).not.toContain('Andrés')

    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.booking_appointments[0].staff_id).toBe(STAFF_ANDRES)
    expect(last(rec).bodyText).toContain('👤 Andrés')
  })

  it('con la pieza prendida y un solo elegible, el resumen sí muestra al profesional', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_BARBA) })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: optionIds(last(rec))[0] })

    expect(last(rec).bodyText).toContain('👤 Andrés')
  })

  it('si Andrés está ocupado a esa hora y Beto libre, asigna a Beto y lo muestra al confirmar', async () => {
    const db = makeFakeDb(baseSeed())
    blockAndresAtTen(db)
    setSettings(db, { choose_staff: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: TEN_O_CLOCK })
    expect(last(rec).bodyText).not.toContain('👤')

    await send(db, rec, { replyId: 'act:confirm' })

    const ours = db._tables.booking_appointments.find((a) => a.id !== 'appt-block')
    expect(ours?.staff_id).toBe(STAFF_BETO)
    expect(last(rec).bodyText).toContain('👤 Beto')
  })
})

describe('título del negocio en el pipeline', () => {
  it('usa la palabra de la cita del negocio, con mayúscula inicial', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { choose_staff: false, labels: { cita: 'turno', citas: 'turnos' } })
    const rec = makeRecorder()

    await send(db, rec, { text: 'turno' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: optionIds(last(rec))[0] })
    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.deals).toHaveLength(1)
    expect(db._tables.deals[0].title).toBe('Turno: Corte clásico')
  })
})

describe('límites de Meta en UTF-16', () => {
  function addServices(db: FakeDb, names: string[]) {
    names.forEach((name, i) => {
      db._tables.booking_services.push({
        id: `svc-long-${i}`,
        account_id: ACCOUNT,
        name,
        description: null,
        duration_minutes: 30,
        price: 10000,
        is_active: true,
        position: 5 + i,
      })
    })
  }

  it('el botón de la lista y los títulos de fila no pasan el límite ni parten un emoji', async () => {
    const db = makeFakeDb(baseSeed())
    addServices(db, ['\u{1F485}'.repeat(20), 'Masaje \u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}\u{1F486}'])
    setSettings(db, { labels: { servicios: 'especialistas \u{1F485}\u{1F485}' } })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    const call = last(rec)
    expect(call.kind).toBe('list')
    expect(call.buttonLabel?.length).toBeLessThanOrEqual(20)
    expect(call.buttonLabel).not.toMatch(LONE_SURROGATE)
    for (const row of call.sections?.flatMap((s) => s.rows) ?? []) {
      expect(row.title.length).toBeLessThanOrEqual(24)
      expect(row.title).not.toMatch(LONE_SURROGATE)
    }
  })

  it('los botones de respuesta no pasan 20 unidades aunque el nombre lleve emoji', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { cita: 'cita \u{1F485}\u{1F485}\u{1F485}\u{1F485}\u{1F485}\u{1F485}' } })
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    const call = last(rec)
    expect(call.kind).toBe('buttons')
    for (const button of call.buttons ?? []) {
      expect(button.title.length).toBeLessThanOrEqual(20)
      expect(button.title).not.toMatch(LONE_SURROGATE)
    }
  })
})

describe('pieza reprogramar/cancelar apagada', () => {
  const HUMAN = 'user-human'

  function offDb() {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { allow_reschedule: false })
    db._tables.booking_appointments.push(appointmentRow())
    return db
  }

  const changeEvents = (db: FakeDb) =>
    db._tables.booking_events.filter(
      (e) => e.event === 'reschedule_requested' || e.event === 'cancel_requested',
    )

  const notifiedUsers = (db: FakeDb) => db._tables.notifications.map((n) => n.user_id)

  it('el menú de gestión solo ofrece agendar otra vez y explica cómo cambiar', async () => {
    const db = offDb()
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(optionIds(last(rec))).toEqual(['act:new'])
    expect(last(rec).bodyText).toContain('asesor')
    expect(last(rec).bodyText).toContain('cita')
  })

  it('con la pieza prendida el menú sigue ofreciendo las tres opciones', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(optionIds(last(rec))).toEqual(['act:new', 'act:reschedule', 'act:cancel'])
    expect(last(rec).bodyText).not.toContain('asesor')
  })

  it('el menú sin cambios usa las palabras del negocio', async () => {
    const db = offDb()
    setSettings(db, { labels: { cita: 'turno', citas: 'turnos' } })
    const rec = makeRecorder()

    await send(db, rec, { text: 'turno' })

    expect(last(rec).bodyText).toContain('tu turno')
    expect(last(rec).bodyText).not.toContain('cita')
  })

  it.each([
    ['rem:reschedule', 'reschedule_requested'],
    ['rem:cancel', 'cancel_requested'],
  ])(
    'el tap %s pasa a un humano: un solo mensaje, bot en pausa, aviso al dueño y cita intacta',
    async (replyId, event) => {
      const db = offDb()
      const rec = makeRecorder()

      const res = await send(db, rec, { replyId })

      expect(res.consumed).toBe(true)
      expect(rec.calls).toHaveLength(1)
      expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
      expect(db._tables.booking_appointments[0].status).toBe('confirmed')
      expect(db._tables.booking_sessions).toHaveLength(0)
      const conv = db._tables.conversations[0]
      expect(conv.ai_autoreply_disabled).toBe(true)
      expect(conv.assigned_agent_id).toBe(HANDOFF_AGENT)
      expect(String(conv.ai_handoff_summary)).toContain(
        replyId === 'rem:cancel' ? 'cancelar' : 'reprogramar',
      )
      expect(changeEvents(db).map((e) => e.event)).toEqual([event])
      // Al agente asignado lo avisa el trigger 027; al dueño, el bot.
      expect(notifiedUsers(db)).toEqual([OWNER])
      expect(
        db._tables.contact_tags.some(
          (ct) => ct.contact_id === CONTACT && ct.tag_id === TAG_HUMANO,
        ),
      ).toBe(true)
    },
  )

  it('con un humano a cargo no le quita el hilo: responde una vez y avisa a asignado y dueño', async () => {
    const db = offDb()
    db._tables.conversations[0].assigned_agent_id = HUMAN
    const rec = makeRecorder()

    await sendHuman(db, rec, { replyId: 'rem:reschedule' })

    const conv = db._tables.conversations[0]
    expect(conv.assigned_agent_id).toBe(HUMAN)
    expect(conv.ai_handoff_summary ?? null).toBeNull()
    expect(conv.ai_autoreply_disabled).toBe(false)
    expect(rec.calls).toHaveLength(1)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
    expect([...notifiedUsers(db)].sort()).toEqual([HUMAN, OWNER].sort())
    expect(db._tables.contact_tags ?? []).toHaveLength(0)
  })

  it('si el asignado es el dueño, se le avisa una sola vez', async () => {
    const db = offDb()
    db._tables.conversations[0].assigned_agent_id = OWNER
    const rec = makeRecorder()

    await sendHuman(db, rec, { replyId: 'rem:reschedule' })

    expect(notifiedUsers(db)).toEqual([OWNER])
    expect(rec.calls).toHaveLength(1)
  })

  it('un humano a cargo no pierde el hilo ni desde un menú viejo', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { text: 'hola' })
    setSettings(db, { allow_reschedule: false })
    db._tables.conversations[0].assigned_agent_id = HUMAN
    rec.calls.length = 0

    await send(db, rec, { replyId: 'act:cancel' })

    const conv = db._tables.conversations[0]
    expect(conv.assigned_agent_id).toBe(HUMAN)
    expect(conv.ai_handoff_summary ?? null).toBeNull()
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
    expect(rec.calls).toHaveLength(1)
  })

  it('dos taps seguidos: un solo mensaje, un solo evento, un solo aviso', async () => {
    const db = offDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:reschedule' })
    await send(db, rec, { replyId: 'rem:reschedule' })

    expect(rec.calls).toHaveLength(1)
    expect(changeEvents(db)).toHaveLength(1)
    expect(db._tables.notifications).toHaveLength(1)
  })

  it('pasados 2 minutos un nuevo tap vuelve a avisar', async () => {
    const db = offDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:reschedule' })
    await send(db, rec, { replyId: 'rem:reschedule' }, new Date(NOW.getTime() + 3 * 60_000))

    expect(rec.calls).toHaveLength(2)
    expect(changeEvents(db)).toHaveLength(2)
  })

  it('"Reprogramar" y luego "Cancelar" seguidos son pedidos distintos: dos eventos, dos mensajes', async () => {
    const db = offDb()
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:reschedule' })
    const notificationsAfterFirst = db._tables.notifications.length
    await send(db, rec, { replyId: 'rem:cancel' })

    expect(changeEvents(db).map((e) => e.event)).toEqual(['reschedule_requested', 'cancel_requested'])
    expect(rec.calls).toHaveLength(2)
    expect(db._tables.notifications.length).toBeGreaterThan(notificationsAfterFirst)

    // Repetir el mismo tipo sigue deduplicado.
    await send(db, rec, { replyId: 'rem:cancel' })
    expect(changeEvents(db)).toHaveLength(2)
    expect(rec.calls).toHaveLength(2)
  })

  it('"Confirmar" del recordatorio sigue funcionando', async () => {
    const db = offDb()
    db._tables.booking_appointments[0].status = 'pending'
    db._tables.booking_appointments[0].confirmed_at = null
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:confirm' })

    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(last(rec).bodyText).toContain('Queda confirmado')
  })

  it.each([
    ['act:reschedule', 'reschedule_requested'],
    ['act:cancel', 'cancel_requested'],
  ])('un menú viejo con %s no sirve de atajo: pasa a un humano', async (replyId, event) => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { text: 'hola' }) // menú con las tres opciones
    setSettings(db, { allow_reschedule: false })
    rec.calls.length = 0

    await send(db, rec, { replyId })

    expect(rec.calls).toHaveLength(1)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(sessionRow(db)).toBeUndefined()
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(changeEvents(db).map((e) => e.event)).toEqual([event])
  })

  it('una confirmación de cancelación abierta antes de apagar la pieza no cancela y pasa a un humano', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'rem:cancel' }) // pide "Sí, cancelar"
    setSettings(db, { allow_reschedule: false })
    rec.calls.length = 0

    await send(db, rec, { replyId: 'act:cancel_yes' })

    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
    expect(rec.calls).toHaveLength(1)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(notifiedUsers(db)).toEqual([OWNER])
    expect(changeEvents(db).map((e) => e.event)).toEqual(['cancel_requested'])
  })

  it('si la cita ya no está activa responde que ya no está activo, sin pasar a un humano', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { text: 'hola' })
    setSettings(db, { allow_reschedule: false })
    db._tables.booking_appointments[0].status = 'cancelled'
    rec.calls.length = 0

    await send(db, rec, { replyId: 'act:cancel' })

    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.managedAppointmentGone)
    expect(rec.calls).toHaveLength(1)
    expect(sessionRow(db)).toBeUndefined()
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(changeEvents(db)).toHaveLength(0)
  })

  it('una sesión de reprogramación abierta cuando se apaga la pieza pasa a un humano', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'rem:reschedule' }) // pick_day en modo reschedule
    setSettings(db, { allow_reschedule: false })
    rec.calls.length = 0

    await send(db, rec, { replyId: dayId(MONDAY) })

    expect(rec.calls).toHaveLength(1)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
    expect(changeEvents(db).map((e) => e.event)).toEqual(['reschedule_requested'])
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('en el resumen de una reprogramación, "Cancelar" solo descarta el cambio (no es una cancelación)', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'rem:reschedule' })
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId('2026-10-19T16:30:00.000Z') })
    setSettings(db, { allow_reschedule: false })
    rec.calls.length = 0

    await send(db, rec, { replyId: 'act:cancel' })

    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.cancelDeclined)
    expect(rec.calls).toHaveLength(1)
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(changeEvents(db)).toHaveLength(0)
    expect(sessionRow(db)).toBeUndefined()
  })

  describe('una cita nueva con la pieza apagada', () => {
    async function toSummary() {
      const db = makeFakeDb(baseSeed())
      setSettings(db, { allow_reschedule: false, choose_staff: false })
      const rec = makeRecorder()
      await send(db, rec, { text: 'hola' })
      await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
      await send(db, rec, { replyId: dayId(MONDAY) })
      await send(db, rec, { replyId: slotId('2026-10-19T16:30:00.000Z') })
      return { db, rec }
    }

    it('"Cambiar hora" del resumen vuelve a elegir día', async () => {
      const { db, rec } = await toSummary()

      await send(db, rec, { replyId: 'act:reschedule' })

      expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.dayMenuBody)
      expect(changeEvents(db)).toHaveLength(0)
    })

    it('"Cancelar" del resumen descarta el borrador', async () => {
      const { db, rec } = await toSummary()

      await send(db, rec, { replyId: 'act:cancel' })

      expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.draftCancelled)
      expect(changeEvents(db)).toHaveLength(0)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })
  })

  it('si pausar el bot falla, el cliente no recibe nada y la sesión queda abierta', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()
    await send(db, rec, { text: 'hola' })
    setSettings(db, { allow_reschedule: false })
    rec.calls.length = 0
    db._failNext('update', 'conversations', { message: 'timeout' })

    await expect(send(db, rec, { replyId: 'act:cancel' })).rejects.toThrow()

    expect(rec.calls).toHaveLength(0)
    expect(sessionRow(db)).toBeDefined()
    expect(changeEvents(db)).toHaveLength(0)
  })
})

// ------------------------------------------------------------
// Preguntas extra (Fase 1, Task 10)
// ------------------------------------------------------------

describe('preguntas extra', () => {
  const SLOT = '2026-10-19T14:00:00.000Z'
  const SLOT_2 = '2026-10-19T14:30:00.000Z'
  const MOTIVO = '¿Motivo de la visita?'
  const SEDE = '¿En qué sede?'

  function question(overrides: Row): Row {
    return {
      account_id: ACCOUNT,
      required: true,
      options: [],
      position: 0,
      is_active: true,
      kind: 'texto',
      ...overrides,
    }
  }

  const qMotivo = (o: Row = {}) =>
    question({ id: 'q-motivo', label: MOTIVO, kind: 'texto', position: 0, ...o })
  const qSede = (o: Row = {}) =>
    question({
      id: 'q-sede',
      label: SEDE,
      kind: 'opcion',
      options: ['Norte', 'Sur'],
      position: 1,
      ...o,
    })

  function withQuestions(db: FakeDb, ...rows: Row[]) {
    db._tables.booking_questions = rows.length ? rows : [qMotivo(), qSede()]
  }

  const questionRow = (db: FakeDb, id: string): Row => {
    const row = db._tables.booking_questions.find((r) => r.id === id)
    if (!row) throw new Error(`no hay pregunta ${id}`)
    return row
  }

  /** Servicio, barbero, día y hora: el siguiente mensaje del bot es la primera pregunta. */
  async function walkToSlot(db: FakeDb, rec: Recorder, slot: string = SLOT) {
    await walkToDay(db, rec)
    await send(db, rec, { replyId: dayId(MONDAY) })
    await send(db, rec, { replyId: slotId(slot) })
  }

  const state = (db: FakeDb) => sessionRow(db)?.state as Record<string, unknown>
  const silence = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  const SUMMARY_BUTTONS = ['Confirmar ✅', 'Reprogramar', 'Cancelar']

  it('después de la hora pregunta en orden y luego muestra el resumen con las respuestas', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToSlot(db, rec)
    expect(last(rec).kind).toBe('text')
    expect(last(rec).bodyText).toBe(MOTIVO)
    expect(state(db).step).toBe('ask_question')
    expect(state(db).questionId).toBe('q-motivo')

    await send(db, rec, { text: 'Control' })
    expect(last(rec).kind).toBe('buttons')
    expect(last(rec).bodyText).toBe(SEDE)
    expect(optionTitles(last(rec))).toEqual(['Norte', 'Sur'])
    expect(optionIds(last(rec))).toEqual(['ans:0', 'ans:1'])

    await send(db, rec, { replyId: 'ans:1' })
    expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
    expect(last(rec).bodyText).toContain('📝 ¿Motivo de la visita?: Control')
    expect(last(rec).bodyText).toContain('📝 ¿En qué sede?: Sur')
    expect(state(db).step).toBe('summary')
    expect(state(db).answers).toEqual({ 'q-motivo': 'Control', 'q-sede': 'Sur' })
  })

  it('al confirmar, la cita guarda las respuestas por id de pregunta (el mensaje final no las repite)', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToSlot(db, rec)
    await send(db, rec, { text: 'Control' })
    await send(db, rec, { replyId: 'ans:0' })
    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.booking_appointments.at(-1)?.answers).toEqual({
      'q-motivo': 'Control',
      'q-sede': 'Norte',
    })
    expect(last(rec).bodyText).toContain('Quedó agendado')
    expect(last(rec).bodyText).not.toContain('📝')
  })

  it('una cuenta sin preguntas va directo al resumen y la cita no lleva answers', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()

    await walkToSlot(db, rec)
    expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
    expect(last(rec).bodyText).not.toContain('📝')
    await send(db, rec, { replyId: 'act:confirm' })
    expect('answers' in db._tables.booking_appointments[0]).toBe(false)
  })

  it('una respuesta obligatoria vacía repite la pregunta con aviso', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToSlot(db, rec)
    await send(db, rec, { text: '   ' })

    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.answerRequired)).toHaveLength(1)
    expect(last(rec).bodyText).toBe(MOTIVO)
    expect(state(db).step).toBe('ask_question')
    expect(state(db).answers ?? {}).toEqual({})
  })

  it('una respuesta demasiado larga avisa y repite la pregunta', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToSlot(db, rec)
    await send(db, rec, { text: 'x'.repeat(201) })

    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.answerTooLong)).toHaveLength(1)
    expect(last(rec).bodyText).toBe(MOTIVO)
  })

  it('el texto de la respuesta se limpia (espacios y caracteres invisibles)', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db, qMotivo())
    const rec = makeRecorder()

    await walkToSlot(db, rec)
    await send(db, rec, { text: '  Con\ntrol​  ' })

    expect(last(rec).bodyText).toContain('📝 ¿Motivo de la visita?: Con trol')
  })

  describe('pregunta de número', () => {
    const qNum = () => question({ id: 'q-num', label: '¿Cuántas personas?', kind: 'numero' })

    it('con letras avisa y repite; con dígitos la guarda', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qNum())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'cuatro' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.answerInvalidNumber)).toHaveLength(1)
      expect(last(rec).bodyText).toBe('¿Cuántas personas?')
      expect(state(db).step).toBe('ask_question')

      await send(db, rec, { text: '4' })
      expect(last(rec).bodyText).toContain('📝 ¿Cuántas personas?: 4')
    })
  })

  describe('pregunta de opción: cómo responde el cliente', () => {
    async function atSede(options: string[] = ['Norte', 'Sur']) {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qSede({ options, position: 0 }))
      const rec = makeRecorder()
      await walkToSlot(db, rec)
      return { db, rec }
    }

    it('un tap guarda el título ofrecido', async () => {
      const { db, rec } = await atSede()
      await send(db, rec, { replyId: 'ans:1' })
      expect(state(db).answers).toEqual({ 'q-sede': 'Sur' })
    })

    it('escribir el título entero (sin importar mayúsculas ni tildes) lo elige', async () => {
      const options = ['Norte', 'Sur', 'Sede Cañas', 'Médico']
      const first = await atSede(options)
      await send(first.db, first.rec, { text: 'SUR' })
      expect(state(first.db).answers).toEqual({ 'q-sede': 'Sur' })

      const second = await atSede(options)
      await send(second.db, second.rec, { text: 'medico' })
      expect(state(second.db).answers).toEqual({ 'q-sede': 'Médico' })

      const third = await atSede(options)
      await send(third.db, third.rec, { text: 'sede canas' })
      expect(state(third.db).answers).toEqual({ 'q-sede': 'Sede Cañas' })
    })

    it('escribir un número elige por posición cuando ningún título es ese número', async () => {
      const options = ['2 horas', 'Un día']
      const first = await atSede(options)
      await send(first.db, first.rec, { text: '2' })
      expect(state(first.db).answers).toEqual({ 'q-sede': 'Un día' })

      const second = await atSede(options)
      await send(second.db, second.rec, { text: '1.' })
      expect(state(second.db).answers).toEqual({ 'q-sede': '2 horas' })

      const third = await atSede(options)
      await send(third.db, third.rec, { text: '2 horas' })
      expect(state(third.db).answers).toEqual({ 'q-sede': '2 horas' })
    })

    it('una respuesta que no empareja cuenta como fallo y a la segunda pasa a un humano', async () => {
      const { db, rec } = await atSede()
      await send(db, rec, { text: 'ni idea' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.retry)).toHaveLength(1)
      expect(last(rec).bodyText).toBe(SEDE)
      expect(state(db).step).toBe('ask_question')

      await send(db, rec, { text: 'tampoco' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(1)
      expect(sessionRow(db)).toBeUndefined()
    })

    it('un tap de un menú viejo no se acepta', async () => {
      const { db, rec } = await atSede()
      await send(db, rec, { replyId: 'ans:7' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.retry)).toHaveLength(1)
      expect(state(db).answers ?? {}).toEqual({})
    })

    it('tocar un botón viejo cuando se pregunta por texto no responde nada', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qMotivo())
      const rec = makeRecorder()
      await walkToSlot(db, rec)

      await send(db, rec, { replyId: 'act:confirm' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.retry)).toHaveLength(1)
      expect(last(rec).bodyText).toBe(MOTIVO)
      expect(state(db).answers ?? {}).toEqual({})
    })
  })

  describe('pregunta opcional', () => {
    const qNota = () =>
      question({ id: 'q-nota', label: '¿Alguna nota?', kind: 'texto', required: false, position: 0 })

    it('sin texto se salta: no se guarda ni se muestra, y sigue la próxima', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qNota(), qSede({ position: 1 }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).bodyText).toBe(`¿Alguna nota?\n${AGENDA_AGENT_TEXTS.answerOptionalHint}`)
      await send(db, rec, { text: '   ' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.answerRequired)).toHaveLength(0)
      expect(last(rec).bodyText).toBe(SEDE)

      await send(db, rec, { replyId: 'ans:0' })
      expect(last(rec).bodyText).toContain('📝 ¿En qué sede?: Norte')
      expect(last(rec).bodyText).not.toContain('¿Alguna nota?')

      await send(db, rec, { replyId: 'act:confirm' })
      expect(db._tables.booking_appointments[0].answers).toEqual({ 'q-sede': 'Norte' })
    })

    it('si solo hay una opcional y se salta, la cita no lleva answers', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qNota())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: '' })
      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      await send(db, rec, { replyId: 'act:confirm' })
      expect('answers' in db._tables.booking_appointments[0]).toBe(false)
    })

    it('con texto se guarda', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qNota())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Llego 5 minutos tarde' })
      await send(db, rec, { replyId: 'act:confirm' })
      expect(db._tables.booking_appointments[0].answers).toEqual({ 'q-nota': 'Llego 5 minutos tarde' })
    })
  })

  describe('la configuración cambia mientras el cliente responde', () => {
    it('una pregunta desactivada se salta (sin consumir el mensaje) y sigue la próxima', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).bodyText).toBe(MOTIVO)
      questionRow(db, 'q-motivo').is_active = false

      await send(db, rec, { text: 'Control' })
      expect(last(rec).bodyText).toBe(SEDE)
      expect(state(db).questionId).toBe('q-sede')
      expect(state(db).answers ?? {}).toEqual({})

      await send(db, rec, { replyId: 'ans:0' })
      await send(db, rec, { replyId: 'act:confirm' })
      expect(db._tables.booking_appointments[0].answers).toEqual({ 'q-sede': 'Norte' })
    })

    it('si era la última pregunta, pasa al resumen con lo que ya respondió', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Control' })
      questionRow(db, 'q-sede').is_active = false

      await send(db, rec, { replyId: 'ans:0' })
      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      expect(last(rec).bodyText).toContain('📝 ¿Motivo de la visita?: Control')
      expect(last(rec).bodyText).not.toContain('sede')
    })

    it('si desactivan todas, el cliente llega al resumen sin respuestas', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      questionRow(db, 'q-motivo').is_active = false
      questionRow(db, 'q-sede').is_active = false

      await send(db, rec, { text: 'Control' })
      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      await send(db, rec, { replyId: 'act:confirm' })
      expect('answers' in db._tables.booking_appointments[0]).toBe(false)
    })

    it('si cambian las opciones y la elegida ya no existe, se repite la pregunta sin guardar', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qSede({ position: 0 }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(optionTitles(last(rec))).toEqual(['Norte', 'Sur'])
      questionRow(db, 'q-sede').options = ['Norte', 'Centro']

      await send(db, rec, { replyId: 'ans:1' }) // "Sur" ya no existe
      expect(optionTitles(last(rec))).toEqual(['Norte', 'Centro'])
      expect(last(rec).bodyText).toBe(SEDE)
      expect(state(db).step).toBe('ask_question')
      expect(state(db).answers ?? {}).toEqual({})
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.retry)).toHaveLength(0)

      await send(db, rec, { replyId: 'ans:1' })
      expect(state(db).answers).toEqual({ 'q-sede': 'Centro' })
    })

    it('si cambian las opciones pero la elegida sigue, se acepta', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qSede({ position: 0 }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      questionRow(db, 'q-sede').options = ['Norte', 'Sur', 'Centro']

      await send(db, rec, { replyId: 'ans:1' })
      expect(state(db).answers).toEqual({ 'q-sede': 'Sur' })
    })

    it('si una pregunta de opción pasa a texto, se repite como texto', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qSede({ position: 0 }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      Object.assign(questionRow(db, 'q-sede'), { kind: 'texto', options: [] })

      await send(db, rec, { replyId: 'ans:0' })
      expect(last(rec).kind).toBe('text')
      expect(last(rec).bodyText).toBe(SEDE)
      expect(state(db).answers ?? {}).toEqual({})

      await send(db, rec, { text: 'La del centro' })
      expect(state(db).answers).toEqual({ 'q-sede': 'La del centro' })
    })

    it('si una pregunta de texto pasa a opción, se repite con sus opciones', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qMotivo())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      Object.assign(questionRow(db, 'q-motivo'), { kind: 'opcion', options: ['Control', 'Primera vez'] })

      await send(db, rec, { text: 'Control' })
      expect(last(rec).kind).toBe('buttons')
      expect(optionTitles(last(rec))).toEqual(['Control', 'Primera vez'])
      expect(state(db).answers ?? {}).toEqual({})
    })

    it('si reordenan, pregunta la primera sin responder en el orden nuevo y el resumen sigue ese orden', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      questionRow(db, 'q-sede').position = 0
      questionRow(db, 'q-motivo').position = 1

      await send(db, rec, { text: 'Control' })
      expect(last(rec).bodyText).toBe(SEDE)

      await send(db, rec, { replyId: 'ans:1' })
      const body = last(rec).bodyText
      expect(body.indexOf('¿En qué sede?: Sur')).toBeGreaterThan(-1)
      expect(body.indexOf('¿En qué sede?: Sur')).toBeLessThan(body.indexOf('¿Motivo de la visita?: Control'))
    })

    it('si agregan una pregunta mientras responde, también se la hace', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      db._tables.booking_questions.push(
        question({ id: 'q-extra', label: '¿Algo más?', kind: 'texto', position: 2 }),
      )
      await send(db, rec, { text: 'Control' })
      await send(db, rec, { replyId: 'ans:0' })
      expect(last(rec).bodyText).toBe('¿Algo más?')
    })
  })

  describe('si no se pueden leer las preguntas', () => {
    it('al entrar sigue al resumen y la cita se crea igual', async () => {
      const spy = silence()
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToDay(db, rec)
      await send(db, rec, { replyId: dayId(MONDAY) })
      db._failNext('select', 'booking_questions', { message: 'boom' })
      await send(db, rec, { replyId: slotId(SLOT) })

      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      expect(spy).toHaveBeenCalled()

      await send(db, rec, { replyId: 'act:confirm' })
      expect(db._tables.booking_appointments).toHaveLength(1)
      expect(db._tables.booking_appointments[0].status).toBe('confirmed')
      expect('answers' in db._tables.booking_appointments[0]).toBe(false)
      expect(last(rec).bodyText).toContain('Quedó agendado')
    })

    it('a mitad de las preguntas sigue al resumen sin perder la reserva', async () => {
      const spy = silence()
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Control' })
      db._failNext('select', 'booking_questions', { message: 'boom' })
      await send(db, rec, { replyId: 'ans:0' })

      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      expect(spy).toHaveBeenCalled()
      await send(db, rec, { replyId: 'act:confirm' })
      expect(db._tables.booking_appointments).toHaveLength(1)
      expect(last(rec).bodyText).toContain('Quedó agendado')
    })

    it('si falla al confirmar, guarda las respuestas que ya tenía', async () => {
      silence()
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Control' })
      await send(db, rec, { replyId: 'ans:0' })
      db._failNext('select', 'booking_questions', { message: 'boom' })
      await send(db, rec, { replyId: 'act:confirm' })

      expect(db._tables.booking_appointments).toHaveLength(1)
      expect(db._tables.booking_appointments[0].answers).toEqual({
        'q-motivo': 'Control',
        'q-sede': 'Norte',
      })
    })
  })

  describe('desde el resumen', () => {
    it('"Reprogramar" borra las respuestas y vuelve a preguntar después de elegir otra hora', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Control' })
      await send(db, rec, { replyId: 'ans:0' })
      expect(state(db).answers).toEqual({ 'q-motivo': 'Control', 'q-sede': 'Norte' })

      await send(db, rec, { replyId: 'act:reschedule' })
      expect(state(db).step).toBe('pick_day')
      expect(state(db).answers).toBeUndefined()
      expect(state(db).questionId).toBeUndefined()
      expect(state(db).slotStartsAt).toBeUndefined()

      await send(db, rec, { replyId: dayId(MONDAY) })
      await send(db, rec, { replyId: slotId(SLOT_2) })
      expect(last(rec).bodyText).toBe(MOTIVO)
      await send(db, rec, { text: 'Otra cosa' })
      await send(db, rec, { replyId: 'ans:1' })
      await send(db, rec, { replyId: 'act:confirm' })

      expect(db._tables.booking_appointments[0].answers).toEqual({
        'q-motivo': 'Otra cosa',
        'q-sede': 'Sur',
      })
    })

    it('si la hora se ocupa al confirmar, conserva las respuestas y no las vuelve a preguntar', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db)
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Control' })
      await send(db, rec, { replyId: 'ans:0' })

      db._tables.booking_appointments.push(
        appointmentRow({
          id: 'appt-race',
          staff_id: STAFF_ANDRES,
          starts_at: SLOT,
          ends_at: SLOT_2,
        }),
      )
      await send(db, rec, { replyId: 'act:confirm' })
      expect(messagesWith(rec, 'ocupó')).toHaveLength(1)
      expect(state(db).step).toBe('pick_slot')

      await send(db, rec, { replyId: slotId(SLOT_2) })
      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      expect(last(rec).bodyText).toContain('📝 ¿Motivo de la visita?: Control')

      await send(db, rec, { replyId: 'act:confirm' })
      const fresh = db._tables.booking_appointments.find((a) => a.id !== 'appt-race')
      expect(fresh?.answers).toEqual({ 'q-motivo': 'Control', 'q-sede': 'Norte' })
    })
  })

  describe('reprogramar una cita que ya existe', () => {
    it('no vuelve a preguntar y la cita nueva copia las respuestas de la anterior', async () => {
      const seed = baseSeed()
      seed.booking_appointments = [
        appointmentRow({ answers: { 'q-motivo': 'Control', 'q-sede': 'Sur' } }),
      ]
      const db = makeFakeDb(seed)
      withQuestions(db)
      const rec = makeRecorder()

      await send(db, rec, { text: 'cita' })
      await send(db, rec, { replyId: 'act:reschedule' })
      await send(db, rec, { replyId: dayId(MONDAY) })
      await send(db, rec, { replyId: slotId('2026-10-19T16:00:00.000Z') })

      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      expect(messagesWith(rec, MOTIVO)).toHaveLength(0)
      expect(messagesWith(rec, SEDE)).toHaveLength(0)
      expect(state(db).step).toBe('summary')

      await send(db, rec, { replyId: 'act:confirm' })
      const fresh = db._tables.booking_appointments.find((a) => a.id !== 'appt-old')
      expect(fresh?.answers).toEqual({ 'q-motivo': 'Control', 'q-sede': 'Sur' })
      expect(fresh?.rescheduled_from).toBe('appt-old')
      expect(last(rec).bodyText).toContain('Quedó reprogramado')
    })

    it('si la cita anterior no tenía respuestas, la nueva tampoco', async () => {
      const seed = baseSeed()
      seed.booking_appointments = [appointmentRow()]
      const db = makeFakeDb(seed)
      withQuestions(db)
      const rec = makeRecorder()

      await send(db, rec, { text: 'cita' })
      await send(db, rec, { replyId: 'act:reschedule' })
      await send(db, rec, { replyId: dayId(MONDAY) })
      await send(db, rec, { replyId: slotId('2026-10-19T16:00:00.000Z') })
      await send(db, rec, { replyId: 'act:confirm' })

      const fresh = db._tables.booking_appointments.find((a) => a.id !== 'appt-old')
      expect('answers' in (fresh ?? {})).toBe(false)
    })

    it('"Agendar otra vez" desde la gestión sí hace las preguntas', async () => {
      const seed = baseSeed()
      seed.booking_appointments = [appointmentRow()]
      const db = makeFakeDb(seed)
      withQuestions(db)
      const rec = makeRecorder()

      await send(db, rec, { text: 'cita' })
      await send(db, rec, { replyId: 'act:new' })
      await send(db, rec, { replyId: svcId(SERVICE_CORTE) })
      await send(db, rec, { replyId: staffId(STAFF_ANDRES) })
      await send(db, rec, { replyId: dayId(MONDAY) })
      await send(db, rec, { replyId: slotId(SLOT) })
      expect(last(rec).bodyText).toBe(MOTIVO)
    })
  })

  describe('saltar una pregunta opcional', () => {
    const HINT = AGENDA_AGENT_TEXTS.answerOptionalHint
    const qNota = (o: Row = {}) =>
      question({ id: 'q-nota', label: '¿Alguna nota?', kind: 'texto', required: false, position: 0, ...o })
    const qOpt = (options: string[], o: Row = {}) =>
      question({ id: 'q-op', label: '¿Qué prefieres?', kind: 'opcion', required: false, options, position: 0, ...o })

    it('la pregunta opcional lleva el aviso; la obligatoria no', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qNota(), qMotivo({ position: 1 }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).bodyText).toBe(`¿Alguna nota?\n${HINT}`)
      expect(HINT).toContain('omitir')
      await send(db, rec, { text: 'Nada especial' })
      expect(last(rec).bodyText).toBe(MOTIVO)
    })

    it.each(['omitir', 'Omitir.', 'no', 'NO', 'ninguno', 'Ninguna', 'no aplica', 'N/A', 'n.a.'])(
      '"%s" salta la pregunta opcional de texto',
      async (word) => {
        const db = makeFakeDb(baseSeed())
        withQuestions(db, qNota())
        const rec = makeRecorder()

        await walkToSlot(db, rec)
        await send(db, rec, { text: word })
        expect(state(db).answers).toEqual({ 'q-nota': '' })
        expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
        expect(last(rec).bodyText).not.toContain('¿Alguna nota?')
        await send(db, rec, { replyId: 'act:confirm' })
        expect('answers' in db._tables.booking_appointments[0]).toBe(false)
      },
    )

    it('una frase que solo contiene la palabra es una respuesta, no un salto', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qNota())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'no tengo ninguna' })
      expect(state(db).answers).toEqual({ 'q-nota': 'no tengo ninguna' })
    })

    it('en una pregunta obligatoria "no" y "omitir" son respuestas normales', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qMotivo())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).bodyText).toBe(MOTIVO)
      await send(db, rec, { text: 'no' })
      expect(state(db).answers).toEqual({ 'q-motivo': 'no' })
    })

    it('opción opcional con pocas opciones suma el botón "Omitir" y el aviso', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qOpt(['Norte', 'Sur']))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).kind).toBe('buttons')
      expect(last(rec).bodyText).toBe(`¿Qué prefieres?\n${HINT}`)
      expect(optionTitles(last(rec))).toEqual(['Norte', 'Sur', 'Omitir'])
      expect(optionIds(last(rec))).toEqual(['ans:0', 'ans:1', 'ans:skip'])

      await send(db, rec, { replyId: 'ans:skip' })
      expect(state(db).answers).toEqual({ 'q-op': '' })
      expect(optionTitles(last(rec))).toEqual(SUMMARY_BUTTONS)
      expect(last(rec).bodyText).not.toContain('¿Qué prefieres?')
    })

    it('con 4 a 9 opciones el "Omitir" va como fila de la lista', async () => {
      const db = makeFakeDb(baseSeed())
      const options = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9']
      withQuestions(db, qOpt(options))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).kind).toBe('list')
      expect(optionIds(last(rec))).toHaveLength(10)
      expect(optionTitles(last(rec)).at(-1)).toBe('Omitir')
      await send(db, rec, { replyId: 'ans:skip' })
      expect(state(db).answers).toEqual({ 'q-op': '' })
    })

    it('con 10 opciones no hay fila "Omitir", pero se puede escribir', async () => {
      const db = makeFakeDb(baseSeed())
      const options = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9', 'J10']
      withQuestions(db, qOpt(options))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(optionIds(last(rec))).toHaveLength(10)
      expect(optionIds(last(rec))).not.toContain('ans:skip')
      await send(db, rec, { text: 'ninguno' })
      expect(state(db).answers).toEqual({ 'q-op': '' })
    })

    it.each(['omitir', 'no aplica', 'N/A'])('escribir "%s" también salta una opción opcional', async (word) => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qOpt(['Norte', 'Sur']))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: word })
      expect(state(db).answers).toEqual({ 'q-op': '' })
    })

    it('si una opción se llama "No", escribir "no" elige esa opción y no salta', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qOpt(['Sí', 'No']))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'no' })
      expect(state(db).answers).toEqual({ 'q-op': 'No' })
    })

    it('una opción obligatoria no ofrece "Omitir" ni lo acepta', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qOpt(['Norte', 'Sur'], { required: true }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      expect(last(rec).bodyText).toBe('¿Qué prefieres?')
      expect(optionTitles(last(rec))).toEqual(['Norte', 'Sur'])

      await send(db, rec, { text: 'omitir' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.retry)).toHaveLength(1)
      expect(state(db).answers ?? {}).toEqual({})
    })

    it('si la pregunta pasa a obligatoria mientras tanto, un "Omitir" viejo se repite', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qOpt(['Norte', 'Sur']))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      questionRow(db, 'q-op').required = true
      await send(db, rec, { replyId: 'ans:skip' })
      expect(state(db).answers ?? {}).toEqual({})
      expect(optionTitles(last(rec))).toEqual(['Norte', 'Sur'])
    })
  })

  describe('pedir un humano mientras se responde', () => {
    it('en una pregunta escrita, una frase que contiene "persona" es la respuesta', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qMotivo())
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'Es para una persona mayor' })

      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(0)
      expect(state(db).answers).toEqual({ 'q-motivo': 'Es para una persona mayor' })
    })

    it.each(['asesor', 'Humano', 'persona.', 'humana'])(
      'pero el mensaje que es solo "%s" sí pasa a un humano',
      async (word) => {
        const db = makeFakeDb(baseSeed())
        withQuestions(db, qMotivo())
        const rec = makeRecorder()

        await walkToSlot(db, rec)
        await send(db, rec, { text: word })

        expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(1)
        expect(sessionRow(db)).toBeUndefined()
      },
    )

    it('lo mismo en preguntas de número y de dirección', async () => {
      for (const kind of ['numero', 'direccion']) {
        const db = makeFakeDb(baseSeed())
        withQuestions(db, question({ id: 'q-x', label: '¿Dato?', kind }))
        const rec = makeRecorder()

        await walkToSlot(db, rec)
        await send(db, rec, { text: 'quiero hablar con un asesor' })
        expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(0)
        await send(db, rec, { text: 'asesor' })
        expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(1)
      }
    })

    it('en una pregunta de opciones sigue la regla de siempre: la palabra en cualquier parte', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qSede({ position: 0 }))
      const rec = makeRecorder()

      await walkToSlot(db, rec)
      await send(db, rec, { text: 'quiero hablar con un asesor' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(1)
    })

    it('fuera de las preguntas escritas, la palabra en cualquier parte sigue pasando a un humano', async () => {
      const db = makeFakeDb(baseSeed())
      withQuestions(db, qMotivo())
      const rec = makeRecorder()

      await send(db, rec, { text: 'hola' })
      await send(db, rec, { text: 'mejor una persona' })
      expect(messagesWith(rec, AGENDA_AGENT_TEXTS.handoff)).toHaveLength(1)
    })
  })
})
