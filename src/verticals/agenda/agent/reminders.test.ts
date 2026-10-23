import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { DEFAULT_LABELS } from '../labels'
import {
  AGENDA_REMINDER_TEMPLATE,
  H24_MS,
  buildReminderBody,
  buildReminderTemplateParams,
  claimReminder,
  pickDueReminder,
  reminderButtons,
  runAgendaReminders,
  type ReminderDelivery,
} from './reminders'

// ============================================================
// Recordatorios — decisión pura (ventanas 24 h / 2 h), builders y
// runner con fake chainable.
//
// El fake aplica filtros como PostgREST y soporta lo que el runner
// necesita de verdad: `.is(col, null)` para el claim y
// `update(...).select('id')` devolviendo las filas afectadas (así
// se prueba que dos corridas no mandan dos veces el recordatorio).
// ============================================================

type Row = Record<string, unknown>

interface FakeDb {
  _tables: Record<string, Row[]>
  /** Pedidos `.or(...)` recibidos, tal cual. */
  _ors: string[]
  from(table: string): unknown
}

type FilterKind = 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'is' | 'or'

/**
 * `.or('vertical_key.in.(a,b),modules.cs.{a}')` como PostgREST: una fila
 * pasa si cumple alguna condición. Solo soporta `in` y `cs` (array contiene).
 */
function matchesOr(row: Row, expr: string): boolean {
  const conditions: boolean[] = []
  for (const m of expr.matchAll(/(\w+)\.in\.\(([^)]*)\)/g)) {
    conditions.push(m[2].split(',').includes(String(row[m[1]])))
  }
  for (const m of expr.matchAll(/(\w+)\.cs\.\{([^}]*)\}/g)) {
    const have = Array.isArray(row[m[1]]) ? (row[m[1]] as string[]) : []
    conditions.push(m[2].split(',').every((k) => have.includes(k)))
  }
  return conditions.some(Boolean)
}

interface FakeDbOptions {
  /** Simula una base sin la migración 053: filtrar por `modules` falla. */
  modulesColumnMissing?: boolean
}

function makeFakeDb(
  seed: Record<string, Row[]>,
  options: FakeDbOptions = {},
): FakeDb {
  const ors: string[] = []
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }
  const ensure = (name: string): Row[] => (tables[name] ??= [])

  function from(table: string) {
    const filters: { col: string; kind: FilterKind; value: unknown }[] = []
    const orders: { col: string; ascending: boolean }[] = []
    type Op = 'select' | 'insert' | 'update'
    let op: Op = 'select'
    let payload: Row | null = null
    let limitN: number | null = null
    let wantRows = false

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
          case 'is':
            return v === value
          case 'or':
            return matchesOr(row, value as string)
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

    const run = (): { data: unknown; error: unknown } => {
      if (
        options.modulesColumnMissing &&
        filters.some((f) => f.kind === 'or' && String(f.value).includes('modules'))
      ) {
        return {
          data: null,
          error: { code: '42703', message: 'column accounts.modules does not exist' },
        }
      }
      if (op === 'select') {
        return { data: candidateRows().map((r) => ({ ...r })), error: null }
      }
      if (op === 'insert') {
        const row = { ...(payload as Row) }
        ensure(table).push(row)
        return { data: wantRows ? [{ ...row }] : null, error: null }
      }
      const updated = candidateRows()
      for (const row of updated) Object.assign(row, payload as Row)
      return {
        data: wantRows ? updated.map((r) => ({ ...r })) : null,
        error: null,
      }
    }

    const api = {
      select: () => {
        wantRows = true
        return api
      },
      insert: (p: Row) => {
        op = 'insert'
        payload = p
        return api
      },
      update: (p: Row) => {
        op = 'update'
        payload = p
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
      or: (expr: string) => {
        ors.push(expr)
        filters.push({ col: '', kind: 'or', value: expr })
        return api
      },
      gt: (col: string, value: unknown) => {
        filters.push({ col, kind: 'gt', value })
        return api
      },
      lte: (col: string, value: unknown) => {
        filters.push({ col, kind: 'lte', value })
        return api
      },
      is: (col: string, value: unknown) => {
        filters.push({ col, kind: 'is', value })
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
        const rows = (result.data ?? []) as Row[]
        return { data: rows[0] ?? null, error: null }
      },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(resolve(run())),
    }
    return api
  }

  return { _tables: tables, _ors: ors, from }
}

// ------------------------------------------------------------
// Fixture
// ------------------------------------------------------------

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const CONTACT = 'ct-1'
const CONTACT_2 = 'ct-2'
const CONV = 'cv-1'
const SERVICE = 'svc-1'
const STAFF = 'st-1'
const APPT = 'ap-1'

/** Lunes 19 de octubre de 2026, 08:00 en Bogotá (13:00Z). */
const NOW = new Date('2026-10-19T13:00:00.000Z')
/** Martes 20 de octubre, 23 h después de NOW (7:00 a. m. en Bogotá). */
const STARTS_IN_23H = '2026-10-20T12:00:00.000Z'

function baseSeed(): Record<string, Row[]> {
  return {
    accounts: [
      {
        id: ACCOUNT,
        name: 'Barbería El Parche',
        owner_user_id: 'u-owner',
        vertical_key: 'agenda',
      },
      {
        id: OTHER_ACCOUNT,
        name: 'Otro negocio',
        owner_user_id: 'u-2',
        vertical_key: 'otro',
      },
    ],
    booking_settings: [],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        conversation_id: CONV,
        service_id: SERVICE,
        staff_id: STAFF,
        starts_at: STARTS_IN_23H,
        status: 'confirmed',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      },
    ],
    conversations: [
      {
        id: CONV,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        created_at: '2026-10-18T00:00:00.000Z',
      },
    ],
    // Mensaje del cliente de hace 1 h → dentro de la ventana de 24 h.
    messages: [
      {
        id: 'm-1',
        conversation_id: CONV,
        sender_type: 'customer',
        created_at: '2026-10-19T12:00:00.000Z',
      },
    ],
    booking_services: [{ id: SERVICE, account_id: ACCOUNT, name: 'Corte clásico' }],
    booking_staff: [{ id: STAFF, account_id: ACCOUNT, name: 'Andrés' }],
  }
}

function asClient(db: FakeDb): SupabaseClient {
  return db as unknown as SupabaseClient
}

function appointmentRow(db: FakeDb, id = APPT): Row {
  const row = (db._tables.booking_appointments ?? []).find((r) => r.id === id)
  if (!row) throw new Error(`cita ${id} no existe en el fake`)
  return row
}

function makeRecorder() {
  const deliveries: ReminderDelivery[] = []
  return {
    deliveries,
    send: async (d: ReminderDelivery) => {
      deliveries.push(d)
    },
  }
}

// ------------------------------------------------------------
// Decisión pura
// ------------------------------------------------------------

describe('pickDueReminder', () => {
  const base = {
    startsAtMs: NOW.getTime() + H24_MS,
    nowMs: NOW.getTime(),
    reminderSentAtMs: null as number | null,
    reminder2hSentAtMs: null as number | null,
    twoHourEnabled: false,
  }

  it('a 25 h todavía no hay nada que enviar; a 23 h vence el de 24 h', () => {
    expect(
      pickDueReminder({ ...base, startsAtMs: NOW.getTime() + H24_MS + 60_000 }),
    ).toBeNull()
    expect(
      pickDueReminder({ ...base, startsAtMs: NOW.getTime() + 23 * 60 * 60_000 }),
    ).toBe('h24')
  })

  it('no repite el de 24 h ni dispara el de 2 h si está desactivado', () => {
    expect(
      pickDueReminder({
        ...base,
        reminderSentAtMs: NOW.getTime() - 1000,
        twoHourEnabled: false,
      }),
    ).toBeNull()
  })

  it('con la cita a 1.5 h y el de 24 h ya enviado, dispara el de 2 h', () => {
    const startsAtMs = NOW.getTime() + 90 * 60_000
    expect(
      pickDueReminder({
        ...base,
        startsAtMs,
        nowMs: startsAtMs - 90 * 60_000,
        reminderSentAtMs: startsAtMs - H24_MS,
        twoHourEnabled: true,
      }),
    ).toBe('h2')
  })

  it('cita creada a menos de 2 h: UNA sola señal (la de 2 h)', () => {
    const startsAtMs = NOW.getTime() + 90 * 60_000
    expect(
      pickDueReminder({
        ...base,
        startsAtMs,
        nowMs: startsAtMs - 90 * 60_000,
        reminderSentAtMs: null,
        twoHourEnabled: true,
      }),
    ).toBe('h2')
  })

  it('si un recordatorio salió dentro de la ventana de 2 h, no se repite', () => {
    const startsAtMs = NOW.getTime() + 90 * 60_000
    expect(
      pickDueReminder({
        ...base,
        startsAtMs,
        nowMs: startsAtMs - 60 * 60_000,
        reminderSentAtMs: startsAtMs - 90 * 60_000,
        twoHourEnabled: true,
      }),
    ).toBeNull()
  })

  it('sin el de 2 h pero con la ventana abierta, envía el de 24 h tarde', () => {
    const startsAtMs = NOW.getTime() + 90 * 60_000
    expect(
      pickDueReminder({
        ...base,
        startsAtMs,
        nowMs: startsAtMs - 90 * 60_000,
        twoHourEnabled: false,
      }),
    ).toBe('h24')
  })

  it('no manda dos veces el de 2 h y no recuerda citas ya iniciadas', () => {
    const startsAtMs = NOW.getTime() + 30 * 60_000
    expect(
      pickDueReminder({
        ...base,
        startsAtMs,
        nowMs: startsAtMs - 30 * 60_000,
        reminderSentAtMs: startsAtMs - H24_MS,
        reminder2hSentAtMs: startsAtMs - 40 * 60_000,
        twoHourEnabled: true,
      }),
    ).toBeNull()
    expect(
      pickDueReminder({
        ...base,
        startsAtMs: NOW.getTime() - 60_000,
        reminderSentAtMs: null,
      }),
    ).toBeNull()
  })
})

// ------------------------------------------------------------
// Builders
// ------------------------------------------------------------

function delivery(over: Partial<ReminderDelivery> = {}): ReminderDelivery {
  return {
    appointmentId: APPT,
    accountId: ACCOUNT,
    contactId: CONTACT,
    conversationId: CONV,
    ownerUserId: 'u-owner',
    kind: 'h24',
    channel: 'text',
    businessName: 'Barbería El Parche',
    serviceName: 'Corte clásico',
    staffName: 'Andrés',
    startsAtIso: STARTS_IN_23H,
    dateLabel: 'martes 20 de octubre de 2026',
    timeLabel: '7:00 a. m.',
    labels: DEFAULT_LABELS,
    allowReschedule: true,
    ...over,
  }
}

describe('builders del recordatorio', () => {
  it('el cuerpo incluye negocio, servicio, barbero, fecha y hora', () => {
    const text = buildReminderBody(delivery())
    expect(text).toContain('Barbería El Parche')
    expect(text).toContain('Corte clásico')
    expect(text).toContain('Andrés')
    expect(text).toContain('martes 20 de octubre de 2026')
    expect(text).toContain('7:00 a. m.')
  })

  it('el cuerpo usa las palabras del negocio', () => {
    const text = buildReminderBody(
      delivery({ labels: { ...DEFAULT_LABELS, cita: 'turno', servicio: 'tratamiento' }, serviceName: null }),
    )
    expect(text).toContain('tu turno')
    expect(text).not.toContain('tu cita')
    expect(text).toContain('tu tratamiento')
  })

  it('usa las variables de la plantilla en orden negocio→hora', () => {
    expect(buildReminderTemplateParams(delivery())).toEqual([
      'Barbería El Parche',
      'Corte clásico',
      'Andrés',
      'martes 20 de octubre de 2026',
      '7:00 a. m.',
    ])
    // Catálogo cambiado: servicio/barbero desaparecidos → textos de reemplazo.
    expect(
      buildReminderTemplateParams(delivery({ serviceName: null, staffName: null })),
    ).toEqual([
      'Barbería El Parche',
      'tu servicio',
      'Cualquiera',
      'martes 20 de octubre de 2026',
      '7:00 a. m.',
    ])
  })

  it('los tres botones llevan ids estáticos y títulos que caben en Meta', () => {
    const buttons = reminderButtons()
    expect(buttons.map((b) => b.id)).toEqual([
      'rem:confirm',
      'rem:reschedule',
      'rem:cancel',
    ])
    expect(buttons.map((b) => b.title)).toEqual([
      'Confirmar',
      'Reprogramar',
      'Cancelar',
    ])
    for (const b of buttons) expect(b.title.length).toBeLessThanOrEqual(20)
  })

  it('con reprogramar/cancelar apagado el mensaje libre solo lleva Confirmar', () => {
    expect(reminderButtons(false).map((b) => b.id)).toEqual(['rem:confirm'])
    expect(reminderButtons(true)).toHaveLength(3)
  })

  it('los reemplazos de la plantilla usan las palabras del negocio', () => {
    const params = buildReminderTemplateParams(
      delivery({
        serviceName: null,
        labels: { ...DEFAULT_LABELS, servicio: 'tratamiento' },
      }),
    )
    expect(params[1]).toBe('tu tratamiento')
  })

  it('la plantilla documentada usa el idioma es', () => {
    expect(AGENDA_REMINDER_TEMPLATE).toEqual({
      name: 'recordatorio_cita',
      language: 'es',
    })
  })
})

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

describe('runAgendaReminders', () => {
  it('también atiende cuentas con la clave anterior barberia', async () => {
    const seed = baseSeed()
    seed.accounts[0].vertical_key = 'barberia'
    const db = makeFakeDb(seed)
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })

    expect(summary.sent).toBe(1)
    expect(rec.deliveries).toHaveLength(1)
  })

  it('envía el de 24 h por mensaje libre (ventana abierta) y marca la cita', async () => {
    const db = makeFakeDb(baseSeed())
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })

    expect(summary.sent).toBe(1)
    expect(summary.byChannel).toEqual({ text: 1, template: 0 })
    expect(summary.byKind).toEqual({ h24: 1, h2: 0 })

    expect(rec.deliveries).toHaveLength(1)
    const d = rec.deliveries[0]
    expect(d.appointmentId).toBe(APPT)
    expect(d.kind).toBe('h24')
    expect(d.channel).toBe('text')
    expect(d.businessName).toBe('Barbería El Parche')
    expect(d.serviceName).toBe('Corte clásico')
    expect(d.staffName).toBe('Andrés')
    expect(d.dateLabel).toBe('martes 20 de octubre de 2026')
    expect(d.timeLabel).toBe('7:00 a. m.')
    expect(d.ownerUserId).toBe('u-owner')

    const row = appointmentRow(db)
    expect(row.reminder_sent_at).toBe(NOW.toISOString())
    expect(row.reminder_2h_sent_at).toBeNull()

    // Doble envío: la segunda corrida no manda nada (idempotencia).
    const second = makeRecorder()
    const summary2 = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: second.send,
    })
    expect(summary2.sent).toBe(0)
    expect(second.deliveries).toHaveLength(0)
    // Ya recordada: ni siquiera vuelve a entrar en la consulta.
    expect(summary2.due).toBe(0)
  })

  it('fuera de la ventana de 24 h usa plantilla; los mensajes del bot no cuentan', async () => {
    const db = makeFakeDb(baseSeed())
    db._tables.messages = [
      // Cliente por última vez hace 30 h.
      {
        id: 'm-old',
        conversation_id: CONV,
        sender_type: 'customer',
        created_at: '2026-10-18T07:00:00.000Z',
      },
      // Un saliente reciente no abre la ventana.
      {
        id: 'm-bot',
        conversation_id: CONV,
        sender_type: 'bot',
        created_at: '2026-10-19T12:55:00.000Z',
      },
    ]
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(summary.sent).toBe(1)
    expect(summary.byChannel).toEqual({ text: 0, template: 1 })
    expect(rec.deliveries[0].channel).toBe('template')
    expect(buildReminderTemplateParams(rec.deliveries[0])).toHaveLength(5)
  })

  it('no recuerda citas canceladas, completadas, no_show ni las de +25 h', async () => {
    const seed = baseSeed()
    seed.booking_appointments.push(
      {
        id: 'ap-cancelled',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        conversation_id: CONV,
        service_id: SERVICE,
        staff_id: STAFF,
        starts_at: STARTS_IN_23H,
        status: 'cancelled',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      },
      {
        id: 'ap-completed',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        conversation_id: CONV,
        service_id: SERVICE,
        staff_id: STAFF,
        starts_at: STARTS_IN_23H,
        status: 'completed',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      },
      {
        id: 'ap-noshow',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        conversation_id: CONV,
        service_id: SERVICE,
        staff_id: STAFF,
        starts_at: STARTS_IN_23H,
        status: 'no_show',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      },
      {
        id: 'ap-later',
        account_id: ACCOUNT,
        contact_id: CONTACT,
        conversation_id: CONV,
        service_id: SERVICE,
        staff_id: STAFF,
        starts_at: '2026-10-20T14:00:00.000Z', // +25 h
        status: 'confirmed',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      },
    )
    const db = makeFakeDb(seed)
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(summary.sent).toBe(1)
    expect(summary.due).toBe(1)
    expect(rec.deliveries.map((d) => d.appointmentId)).toEqual([APPT])
    for (const id of ['ap-cancelled', 'ap-completed', 'ap-noshow', 'ap-later']) {
      expect(appointmentRow(db, id).reminder_sent_at).toBeNull()
    }
  })

  describe('cuentas por módulos (053)', () => {
    async function run(seed: Record<string, Row[]>, options?: FakeDbOptions) {
      const db = makeFakeDb(seed, options)
      const rec = makeRecorder()
      const summary = await runAgendaReminders({
        db: asClient(db),
        now: NOW,
        send: rec.send,
      })
      return { db, rec, summary }
    }

    it('atiende una cuenta con modules [agenda] aunque vertical_key sea null', async () => {
      const seed = baseSeed()
      seed.accounts[0].vertical_key = null
      seed.accounts[0].modules = ['agenda']
      const { rec, summary } = await run(seed)
      expect(summary.accounts).toBe(1)
      expect(summary.sent).toBe(1)
      expect(rec.deliveries.map((d) => d.appointmentId)).toEqual([APPT])
    })

    it('atiende una cuenta con agenda y ventas a la vez', async () => {
      const seed = baseSeed()
      seed.accounts[0].modules = ['agenda', 'ventas']
      const { summary } = await run(seed)
      expect(summary.sent).toBe(1)
    })

    it('sigue atendiendo cuentas con solo vertical_key (modules vacío o ausente)', async () => {
      const seed = baseSeed()
      seed.accounts[0].modules = []
      const { summary } = await run(seed)
      expect(summary.sent).toBe(1)
    })

    it('no toca una cuenta que solo tiene ventas', async () => {
      const seed = baseSeed()
      seed.accounts[0].vertical_key = null
      seed.accounts[0].modules = ['ventas']
      const { summary } = await run(seed)
      expect(summary.accounts).toBe(0)
      expect(summary.sent).toBe(0)
    })

    it('antes de 053 (sin columna modules) cae a vertical_key y sigue recordando', async () => {
      const { db, summary } = await run(baseSeed(), { modulesColumnMissing: true })
      expect(summary.accounts).toBe(1)
      expect(summary.sent).toBe(1)
      expect(db._ors).toHaveLength(1)
    })
  })

  it('solo toca cuentas con vertical_key barbería', async () => {
    const seed = baseSeed()
    seed.booking_appointments.push({
      id: 'ap-other',
      account_id: OTHER_ACCOUNT,
      contact_id: 'ct-9',
      conversation_id: 'cv-9',
      service_id: null,
      staff_id: null,
      starts_at: STARTS_IN_23H,
      status: 'confirmed',
      reminder_sent_at: null,
      reminder_2h_sent_at: null,
    })
    const db = makeFakeDb(seed)
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(summary.due).toBe(1)
    expect(rec.deliveries.map((d) => d.appointmentId)).toEqual([APPT])
    expect(appointmentRow(db, 'ap-other').reminder_sent_at).toBeNull()
  })

  describe('pieza de recordatorios y palabras del negocio', () => {
    /** Segunda cuenta de agenda con su propia cita a 23 h. */
    function twoAccountSeed(): Record<string, Row[]> {
      const seed = baseSeed()
      seed.accounts[1] = {
        id: OTHER_ACCOUNT,
        name: 'Otro negocio',
        owner_user_id: 'u-2',
        vertical_key: 'agenda',
      }
      seed.booking_appointments.push({
        id: 'ap-2',
        account_id: OTHER_ACCOUNT,
        contact_id: CONTACT_2,
        conversation_id: 'cv-2',
        service_id: null,
        staff_id: null,
        starts_at: STARTS_IN_23H,
        status: 'confirmed',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      })
      seed.conversations.push({
        id: 'cv-2',
        account_id: OTHER_ACCOUNT,
        contact_id: CONTACT_2,
        created_at: '2026-10-18T00:00:00.000Z',
      })
      return seed
    }

    it('una cuenta con reminders_enabled apagado no recibe nada y otra sí', async () => {
      const seed = twoAccountSeed()
      seed.booking_settings.push({ account_id: ACCOUNT, reminders_enabled: false })
      const db = makeFakeDb(seed)
      const rec = makeRecorder()

      const summary = await runAgendaReminders({ db: asClient(db), now: NOW, send: rec.send })

      expect(rec.deliveries.map((d) => d.accountId)).toEqual([OTHER_ACCOUNT])
      expect(summary.sent).toBe(1)
      expect(appointmentRow(db, APPT).reminder_sent_at).toBeNull()
    })

    it('si todas las cuentas están apagadas no envía nada (ni lee citas)', async () => {
      const seed = baseSeed()
      seed.booking_settings.push({ account_id: ACCOUNT, reminders_enabled: false, reminders_2h_enabled: true })
      const db = makeFakeDb(seed)
      const rec = makeRecorder()

      const summary = await runAgendaReminders({ db: asClient(db), now: NOW, send: rec.send })

      expect(summary.due).toBe(0)
      expect(summary.sent).toBe(0)
      expect(rec.deliveries).toHaveLength(0)
    })

    it('apagado también corta la señal de 2 h', async () => {
      const seed = baseSeed()
      seed.booking_settings.push({ account_id: ACCOUNT, reminders_enabled: false, reminders_2h_enabled: true })
      const db = makeFakeDb(seed)
      const rec = makeRecorder()

      const summary = await runAgendaReminders({
        db: asClient(db),
        now: new Date('2026-10-20T10:30:00.000Z'),
        send: rec.send,
      })

      expect(summary.sent).toBe(0)
    })

    it('una cuenta sin fila de configuración sigue recibiendo recordatorios', async () => {
      const db = makeFakeDb(baseSeed())
      const rec = makeRecorder()

      const summary = await runAgendaReminders({ db: asClient(db), now: NOW, send: rec.send })

      expect(summary.sent).toBe(1)
      expect(rec.deliveries[0].labels).toEqual(DEFAULT_LABELS)
    })

    it('cada entrega lleva si la cuenta permite reprogramar (por defecto sí)', async () => {
      const seed = twoAccountSeed()
      seed.booking_settings.push({ account_id: ACCOUNT, allow_reschedule: false })
      const db = makeFakeDb(seed)
      const rec = makeRecorder()

      await runAgendaReminders({ db: asClient(db), now: NOW, send: rec.send })

      expect(rec.deliveries.find((d) => d.accountId === ACCOUNT)?.allowReschedule).toBe(false)
      expect(rec.deliveries.find((d) => d.accountId === OTHER_ACCOUNT)?.allowReschedule).toBe(true)
    })

    it('cada entrega lleva las palabras de su cuenta', async () => {
      const seed = twoAccountSeed()
      seed.booking_settings.push({
        account_id: ACCOUNT,
        reminders_enabled: true,
        labels: { cita: 'turno', citas: 'turnos', profesional: '*mal*' },
      })
      const db = makeFakeDb(seed)
      const rec = makeRecorder()

      await runAgendaReminders({ db: asClient(db), now: NOW, send: rec.send })

      const mine = rec.deliveries.find((d) => d.accountId === ACCOUNT)
      const other = rec.deliveries.find((d) => d.accountId === OTHER_ACCOUNT)
      expect(mine?.labels.cita).toBe('turno')
      expect(mine?.labels.profesional).toBe(DEFAULT_LABELS.profesional)
      expect(buildReminderBody(mine!)).toContain('tu turno')
      expect(other?.labels).toEqual(DEFAULT_LABELS)
    })
  })

  it('con la 2.ª señal activada envía 2 h antes sin repetir el de 24 h', async () => {
    const seed = baseSeed()
    seed.booking_settings.push({
      account_id: ACCOUNT,
      reminders_2h_enabled: true,
    })
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const first = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(first.sent).toBe(1)
    expect(rec.deliveries[0].kind).toBe('h24')

    // 1.5 h antes de la cita → vence la segunda señal.
    const beforeStart = new Date('2026-10-20T10:30:00.000Z')
    const second = await runAgendaReminders({
      db: asClient(db),
      now: beforeStart,
      send: rec.send,
    })
    expect(second.sent).toBe(1)
    expect(second.byKind).toEqual({ h24: 0, h2: 1 })
    expect(rec.deliveries[1].kind).toBe('h2')

    const row = appointmentRow(db)
    expect(row.reminder_sent_at).toBe(NOW.toISOString())
    expect(row.reminder_2h_sent_at).toBe(beforeStart.toISOString())

    const third = await runAgendaReminders({
      db: asClient(db),
      now: beforeStart,
      send: rec.send,
    })
    expect(third.sent).toBe(0)
    expect(rec.deliveries).toHaveLength(2)
  })

  it('cita con 2.ª señal activada creada a <2 h recibe UNA sola señal', async () => {
    const seed = baseSeed()
    seed.booking_settings.push({
      account_id: ACCOUNT,
      reminders_2h_enabled: true,
    })
    const db = makeFakeDb(seed)
    db._tables.booking_appointments[0].starts_at = '2026-10-19T14:30:00.000Z' // +1.5 h
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(summary.sent).toBe(1)
    expect(rec.deliveries).toHaveLength(1)
    expect(rec.deliveries[0].kind).toBe('h2')
    // La primera señal queda marcada como cumplida por la de 2 h.
    const row = appointmentRow(db)
    expect(row.reminder_sent_at).toBe(NOW.toISOString())
    expect(row.reminder_2h_sent_at).toBe(NOW.toISOString())
  })

  it('con 60 citas en 24 h y 50 ya recordadas, las 10 pendientes salen en la misma corrida', async () => {
    const seed = baseSeed()
    const at = (minutesFromNow: number) =>
      new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString()
    const row = (id: string, startsAt: string, sentAt: string | null): Row => ({
      id,
      account_id: ACCOUNT,
      contact_id: CONTACT,
      conversation_id: CONV,
      service_id: SERVICE,
      staff_id: STAFF,
      starts_at: startsAt,
      status: 'confirmed',
      reminder_sent_at: sentAt,
      reminder_2h_sent_at: null,
    })
    // 50 citas tempranas (1 h a ~11 h) ya recordadas ayer…
    const reminded = Array.from({ length: 50 }, (_, i) =>
      row(`ap-sent-${i}`, at(60 + i * 12), '2026-10-18T13:00:00.000Z'),
    )
    // …y 10 más tarde (20 h a ~22 h) todavía sin recordatorio.
    const pending = Array.from({ length: 10 }, (_, i) =>
      row(`ap-pending-${i}`, at(20 * 60 + i * 12), null),
    )
    seed.booking_appointments = [...reminded, ...pending]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()

    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })

    expect(summary.due).toBe(10)
    expect(summary.sent).toBe(10)
    expect(rec.deliveries.map((d) => d.appointmentId).sort()).toEqual(
      pending.map((p) => p.id as string).sort(),
    )
    for (const p of pending) {
      expect(appointmentRow(db, p.id as string).reminder_sent_at).toBe(
        NOW.toISOString(),
      )
    }
  })

  it('la 2.ª señal solo consulta cuentas que la tienen activa', async () => {
    const seed = baseSeed()
    // Ya recordada a 24 h; empieza en 1 h → solo podría tocarle la de 2 h.
    seed.booking_appointments[0].starts_at = '2026-10-19T14:00:00.000Z'
    seed.booking_appointments[0].reminder_sent_at = '2026-10-18T14:00:00.000Z'

    const off = makeFakeDb(seed)
    const offSummary = await runAgendaReminders({
      db: asClient(off),
      now: NOW,
      send: makeRecorder().send,
    })
    expect(offSummary.due).toBe(0)

    seed.booking_settings.push({ account_id: ACCOUNT, reminders_2h_enabled: true })
    const on = makeFakeDb(seed)
    const rec = makeRecorder()
    const onSummary = await runAgendaReminders({
      db: asClient(on),
      now: NOW,
      send: rec.send,
    })
    expect(onSummary.due).toBe(1)
    expect(rec.deliveries[0].kind).toBe('h2')
  })

  it('si el envío falla, revierte la marca y reintenta en la próxima corrida', async () => {
    const db = makeFakeDb(baseSeed())
    const failing = async () => {
      throw new Error('Meta caído')
    }
    const first = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: failing,
    })
    expect(first.sent).toBe(0)
    expect(first.failed).toBe(1)
    expect(first.errors[0]).toContain('Meta caído')
    expect(appointmentRow(db).reminder_sent_at).toBeNull()

    const rec = makeRecorder()
    const second = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(second.sent).toBe(1)
    expect(appointmentRow(db).reminder_sent_at).toBe(NOW.toISOString())
  })

  it.each(['accounts', 'booking_settings', 'booking_appointments'])(
    'si leer %s falla, el runner lanza (la ruta alerta y responde 500)',
    async (brokenTable) => {
      const db = makeFakeDb(baseSeed())
      const failing = {
        from(table: string) {
          if (table !== brokenTable) return db.from(table)
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'or', 'is', 'gt', 'lte', 'order', 'limit']) {
            chain[m] = () => chain
          }
          chain.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve(
              resolve({ data: null, error: { message: 'connection reset' } }),
            )
          return chain
        },
      }
      const rec = makeRecorder()

      await expect(
        runAgendaReminders({
          db: failing as unknown as SupabaseClient,
          now: NOW,
          send: rec.send,
        }),
      ).rejects.toThrow('connection reset')
      expect(rec.deliveries).toHaveLength(0)
    },
  )

  it('sin conversación no adivina: salta la cita con error acotado', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [
      {
        id: 'ap-noconv',
        account_id: ACCOUNT,
        contact_id: CONTACT_2,
        conversation_id: null,
        service_id: null,
        staff_id: null,
        starts_at: STARTS_IN_23H,
        status: 'confirmed',
        reminder_sent_at: null,
        reminder_2h_sent_at: null,
      },
    ]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()
    const summary = await runAgendaReminders({
      db: asClient(db),
      now: NOW,
      send: rec.send,
    })
    expect(summary.sent).toBe(0)
    expect(summary.skipped).toBe(1)
    expect(summary.errors[0]).toContain('ap-noconv')
    expect(rec.deliveries).toHaveLength(0)
  })
})

describe('claimReminder', () => {
  it('gana solo la primera corrida: el UPDATE condicional decide', async () => {
    const db = makeFakeDb(baseSeed())
    const first = await claimReminder(asClient(db), {
      id: APPT,
      accountId: ACCOUNT,
      kind: 'h24',
      claimedAtIso: NOW.toISOString(),
      previousReminderSentAt: null,
    })
    expect(first).toBe(true)
    expect(appointmentRow(db).reminder_sent_at).toBe(NOW.toISOString())

    const second = await claimReminder(asClient(db), {
      id: APPT,
      accountId: ACCOUNT,
      kind: 'h24',
      claimedAtIso: NOW.toISOString(),
      previousReminderSentAt: null,
    })
    expect(second).toBe(false)

    const second2h = await claimReminder(asClient(db), {
      id: APPT,
      accountId: ACCOUNT,
      kind: 'h2',
      claimedAtIso: NOW.toISOString(),
      previousReminderSentAt: NOW.toISOString(),
    })
    expect(second2h).toBe(true)
    expect(appointmentRow(db).reminder_2h_sent_at).toBe(NOW.toISOString())
    // La marca de la primera señal no se pisa cuando ya existía.
    expect(appointmentRow(db).reminder_sent_at).toBe(NOW.toISOString())
  })

  it('no reclama citas canceladas ni ya iniciadas', async () => {
    const seed = baseSeed()
    seed.booking_appointments.push({
      id: 'ap-cancelled',
      account_id: ACCOUNT,
      contact_id: CONTACT,
      conversation_id: CONV,
      service_id: SERVICE,
      staff_id: STAFF,
      starts_at: STARTS_IN_23H,
      status: 'cancelled',
      reminder_sent_at: null,
      reminder_2h_sent_at: null,
    })
    const db = makeFakeDb(seed)
    expect(
      await claimReminder(asClient(db), {
        id: 'ap-cancelled',
        accountId: ACCOUNT,
        kind: 'h24',
        claimedAtIso: NOW.toISOString(),
        previousReminderSentAt: null,
      }),
    ).toBe(false)

    // Cita ya iniciada (starts_at < claimedAtIso).
    db._tables.booking_appointments[0].starts_at = '2026-10-19T12:00:00.000Z'
    expect(
      await claimReminder(asClient(db), {
        id: APPT,
        accountId: ACCOUNT,
        kind: 'h24',
        claimedAtIso: NOW.toISOString(),
        previousReminderSentAt: null,
      }),
    ).toBe(false)
  })
})
