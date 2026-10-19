import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { VerticalSession } from '@/lib/verticals/types'

import { handleBarberiaInbound, type BarberiaSender } from './controller'
import { dayId, slotId, staffId, svcId } from './state'
import { BARBERIA_AGENT_TEXTS } from '../texts'

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
    op: 'insert' | 'update' | 'upsert' | 'delete',
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
      for (const { col, ascending } of orders) {
        out.sort((a, b) => {
          const av = a[col] as never
          const bv = b[col] as never
          if (av === bv) return 0
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1)
        })
      }
      return limitN === null ? out : out.slice(0, limitN)
    }

    const takeFailure = (opName: Op): { code?: string } | null => {
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
  sections?: { rows: { id: string; title: string; description?: string }[] }[]
  footerText?: string
}

function makeRecorder() {
  const calls: SenderCall[] = []
  const sender: BarberiaSender = {
    sendText: async ({ text }) => {
      calls.push({ kind: 'text', bodyText: text })
    },
    sendButtons: async ({ bodyText, buttons, footerText }) => {
      calls.push({ kind: 'buttons', bodyText, buttons, footerText })
    },
    sendList: async ({ bodyText, sections, footerText }) => {
      calls.push({
        kind: 'list',
        bodyText,
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
) {
  const inboundMessageId = seedInbound(db, input)
  return handleBarberiaInbound({
    db: db as unknown as SupabaseClient,
    sender: rec.sender,
    now,
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    inboundMessageId,
    session: currentSession(db, now),
  })
}

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
    expect(last(rec).bodyText).toContain('quedó agendada')
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
      'Nueva cita',
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

    expect(last(rec).bodyText).toContain('cancelada')
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

    expect(last(rec).bodyText).toContain('reprogramada')
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
    expect(String(notification.title)).toContain('Barbería')
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

    expect(last(rec).bodyText).toContain('queda confirmada')
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
    expect(last(rec).bodyText).toContain('queda confirmada')
  })

  it('sin cita próxima activa avisa que ya no está en vez de inventar', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow({ status: 'cancelled' })]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    expect(last(rec).bodyText).toContain('ya no está activa')
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
    expect(last(rec).bodyText).toContain('cancelada')
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

    expect(last(rec).bodyText).toBe(BARBERIA_AGENT_TEXTS.serviceMenuBody)
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
    expect(last(rec).bodyText).toBe(BARBERIA_AGENT_TEXTS.serviceMenuBody)
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
    expect(messagesWith(rec, BARBERIA_AGENT_TEXTS.retry)).toHaveLength(0)
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

    expect(last(rec).bodyText).toBe(BARBERIA_AGENT_TEXTS.serviceMenuBody)
  })
})
