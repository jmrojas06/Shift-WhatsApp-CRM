import { describe, expect, it } from 'vitest'

import { OPT_OUT_TAG } from '@/lib/contacts/opt-out'
import {
  asClient,
  makeFakeDb,
  type FakeDb,
  type Row,
} from '@/verticals/agenda/agent/testing/fake-db'
import { DEFAULT_LABELS } from '@/verticals/agenda/labels'

import {
  FOLLOWUP_MAX_ATTEMPTS,
  OPEN_COMPLAINT_TAG,
  buildFollowupBody,
  buildFollowupTemplateParams,
  commonSkipReason,
  followupButtons,
  followupPayload,
  followupQuickReplyPayloads,
  followupSchedule,
  ratingPayload,
  ratingSkipReason,
  runClinicFollowups,
  type FollowupDelivery,
  type FollowupKind,
} from './followups'

// ============================================================
// Seguimientos después de la cita (Fase 3, §7): reglas puras, builders y
// runner con el fake de Supabase del vertical.
//
// El fake no tiene `.or(...)` (el runner lo usa para traer las cuentas con
// clínica): aquí se agrega como un no-op que registra la expresión, y el
// runner vuelve a filtrar con `hasModule`, igual que en producción.
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const OWNER = 'u-owner'
const CONTACT = 'ct-1'
const CONV = 'cv-1'
const SERVICE = 'svc-1'
const APPT = 'ap-1'
const PATIENT = 'pt-1'
const LOCATION = 'loc-1'
const FOLLOWUP = 'fu-1'

/** Lunes 19 de octubre de 2026, 09:00 a 09:30 en Bogotá. */
const STARTS_AT = '2026-10-19T14:00:00.000Z'
const ENDS_AT = '2026-10-19T14:30:00.000Z'

/** Lunes 10:00 en Bogotá: ya pasó el fin de la cita (los cuidados vencen). */
const NOW_DAY0 = new Date('2026-10-19T15:00:00.000Z')
/** Martes 10:30 en Bogotá: vence el "¿Cómo sigues?" (10:00). */
const NOW_DAY1 = new Date('2026-10-20T15:30:00.000Z')
/** Miércoles 10:30 en Bogotá: vence la calificación. */
const NOW_DAY2 = new Date('2026-10-21T15:30:00.000Z')

const iso = (value: string) => new Date(value).toISOString()

function withOr(db: FakeDb, ors: string[]): FakeDb {
  return {
    ...db,
    from(table: string) {
      const query = db.from(table) as Record<string, unknown>
      query.or = (expression: string) => {
        ors.push(expression)
        return query
      }
      return query
    },
  }
}

function baseSeed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    accounts: [
      {
        id: ACCOUNT,
        name: 'Clínica Sonrisa',
        owner_user_id: OWNER,
        modules: ['agenda', 'clinica'],
        vertical_key: 'agenda',
      },
      {
        id: OTHER_ACCOUNT,
        name: 'Barbería El Parche',
        owner_user_id: 'u-2',
        modules: ['agenda'],
        vertical_key: 'agenda',
      },
    ],
    booking_settings: [{ account_id: ACCOUNT, labels: {} }],
    // El interruptor de los seguimientos: prendido en la cuenta de las pruebas.
    clinic_settings: [{ account_id: ACCOUNT, followups_enabled: true }],
    contacts: [
      { id: CONTACT, account_id: ACCOUNT, name: 'Marta Ruiz', phone: '573001112233', wa_user_id: null },
    ],
    conversations: [
      { id: CONV, account_id: ACCOUNT, contact_id: CONTACT, created_at: '2026-10-01T00:00:00.000Z' },
    ],
    // El paciente escribió hace 1 hora (respecto de NOW_DAY0): ventana abierta.
    messages: [
      {
        id: 'm-1',
        conversation_id: CONV,
        sender_type: 'customer',
        created_at: '2026-10-19T14:00:00.000Z',
      },
    ],
    booking_services: [
      {
        id: SERVICE,
        account_id: ACCOUNT,
        name: 'Endodoncia',
        aftercare_instructions: 'No comas por 2 horas.',
      },
    ],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        conversation_id: CONV,
        service_id: SERVICE,
        patient_id: PATIENT,
        location_id: LOCATION,
        starts_at: STARTS_AT,
        ends_at: ENDS_AT,
        status: 'completed',
      },
    ],
    clinic_patients: [{ id: PATIENT, account_id: ACCOUNT, full_name: 'Tomás Gil' }],
    clinic_locations: [{ id: LOCATION, account_id: ACCOUNT, name: 'Centro' }],
    clinic_followups: [],
    clinic_ratings: [],
    clinic_day_closes: [],
    clinic_consents: [],
    tags: [],
    contact_tags: [],
    notifications: [],
    ...extra,
  }
}

function followupRow(over: Row = {}): Row {
  return {
    id: FOLLOWUP,
    account_id: ACCOUNT,
    appointment_id: APPT,
    contact_id: CONTACT,
    kind: 'como_sigues',
    due_at: iso('2026-10-20T15:00:00.000Z'),
    status: 'pending',
    attempts: 0,
    skip_reason: null,
    response: null,
    sent_at: null,
    ...over,
  }
}

function rows(db: FakeDb, table: string): Row[] {
  return db._tables[table] ?? []
}

function row(db: FakeDb, table: string, id: string): Row {
  const found = rows(db, table).find((r) => r.id === id)
  if (!found) throw new Error(`${table} ${id} no existe en el fake`)
  return found
}

function makeRecorder() {
  const deliveries: FollowupDelivery[] = []
  return {
    deliveries,
    send: async (delivery: FollowupDelivery) => {
      deliveries.push(delivery)
    },
  }
}

async function run(
  db: FakeDb,
  over: { now?: Date; limit?: number; send?: (d: FollowupDelivery) => Promise<void> } = {},
) {
  const recorder = makeRecorder()
  const ors: string[] = []
  const summary = await runClinicFollowups({
    db: asClient(withOr(db, ors)),
    send: over.send ?? recorder.send,
    now: over.now ?? NOW_DAY1,
    ...(over.limit ? { limit: over.limit } : {}),
  })
  return { summary, deliveries: recorder.deliveries, ors }
}

// ------------------------------------------------------------
// Reglas puras
// ------------------------------------------------------------

describe('followupSchedule', () => {
  it('cuidados al terminar la cita, "¿cómo sigues?" a las 10:00 del día +1 y la calificación del día +2', () => {
    expect(followupSchedule({ startsAt: STARTS_AT, endsAt: ENDS_AT }, true)).toEqual([
      { kind: 'cuidados', dueAt: ENDS_AT },
      { kind: 'como_sigues', dueAt: '2026-10-20T15:00:00.000Z' },
      { kind: 'calificacion', dueAt: '2026-10-21T15:00:00.000Z' },
    ])
  })

  it('sin cuidados en el servicio no hay seguimiento de cuidados', () => {
    expect(followupSchedule({ startsAt: STARTS_AT, endsAt: ENDS_AT }, false).map((i) => i.kind)).toEqual([
      'como_sigues',
      'calificacion',
    ])
  })

  it('el día es el de Bogotá, no el de UTC: una cita a las 23:30 locales cuenta como ese día', () => {
    // 23:30 del 18 de octubre en Bogotá = 04:30Z del 19.
    const schedule = followupSchedule(
      { startsAt: '2026-10-19T04:30:00.000Z', endsAt: '2026-10-19T05:00:00.000Z' },
      false,
    )

    expect(schedule).toEqual([
      { kind: 'como_sigues', dueAt: '2026-10-19T15:00:00.000Z' },
      { kind: 'calificacion', dueAt: '2026-10-20T15:00:00.000Z' },
    ])
  })

  it('cruza el fin de mes', () => {
    const schedule = followupSchedule(
      { startsAt: '2026-10-31T14:00:00.000Z', endsAt: '2026-10-31T14:30:00.000Z' },
      false,
    )

    expect(schedule.map((i) => i.dueAt)).toEqual(['2026-11-01T15:00:00.000Z', '2026-11-02T15:00:00.000Z'])
  })

  it('sin hora de fin, los cuidados vencen al inicio de la cita', () => {
    expect(followupSchedule({ startsAt: STARTS_AT }, true)[0]).toEqual({
      kind: 'cuidados',
      dueAt: STARTS_AT,
    })
  })
})

describe('commonSkipReason', () => {
  const ok = { appointmentStatus: 'completed', hasContact: true, hasPhone: true, block: null }

  it('sin nada que lo impida no se omite', () => {
    expect(commonSkipReason(ok)).toBeNull()
  })

  it.each([
    [{ appointmentStatus: 'no_show' }, 'appointment_not_completed'],
    [{ appointmentStatus: 'cancelled' }, 'appointment_not_completed'],
    [{ appointmentStatus: null }, 'appointment_not_completed'],
    [{ hasContact: false }, 'no_contact'],
    [{ hasPhone: false }, 'no_phone'],
    [{ block: 'opt_out' as const }, 'opt_out'],
    [{ block: 'consent_revoked' as const }, 'consent_revoked'],
  ])('%j se omite como %s', (over, reason) => {
    expect(commonSkipReason({ ...ok, ...over })).toBe(reason)
  })
})

describe('ratingSkipReason', () => {
  const ok = {
    hasFutureAppointment: false,
    ratedRecently: false,
    openComplaint: false,
    howAreYouResponse: null,
  }

  it('sin nada que lo impida se pide la calificación', () => {
    expect(ratingSkipReason(ok)).toBeNull()
    expect(ratingSkipReason({ ...ok, howAreYouResponse: 'bien' })).toBeNull()
  })

  it.each([
    [{ hasFutureAppointment: true }, 'future_appointment'],
    [{ ratedRecently: true }, 'recent_rating'],
    [{ openComplaint: true }, 'open_complaint'],
    [{ howAreYouResponse: 'molestias' as const }, 'trouble_reported'],
    [{ howAreYouResponse: 'ayuda' as const }, 'trouble_reported'],
  ])('%j se omite como %s', (over, reason) => {
    expect(ratingSkipReason({ ...ok, ...over })).toBe(reason)
  })
})

// ------------------------------------------------------------
// Ids de los botones y textos
// ------------------------------------------------------------

describe('ids de los botones', () => {
  it('los builders arman el formato que lee el bot (fu:<acción>:<id> y rt:<valor>:<id>)', () => {
    expect(followupPayload('cuidados', FOLLOWUP)).toBe('fu:cuidados:fu-1')
    expect(followupPayload('molestias', FOLLOWUP)).toBe('fu:molestias:fu-1')
    expect(ratingPayload('regular', FOLLOWUP)).toBe('rt:regular:fu-1')
  })

  it.each<[FollowupKind, string[]]>([
    ['cuidados', ['fu:cuidados:fu-1']],
    ['como_sigues', ['fu:bien:fu-1', 'fu:molestias:fu-1', 'fu:ayuda:fu-1']],
    ['calificacion', ['rt:bien:fu-1', 'rt:regular:fu-1', 'rt:mal:fu-1']],
  ])('%s: los payloads de la plantilla siguen el orden de sus botones', (kind, payloads) => {
    expect(followupQuickReplyPayloads(kind, FOLLOWUP)).toEqual(payloads)
    expect(followupButtons(kind, FOLLOWUP).map((b) => b.id)).toEqual(payloads)
  })

  it('los títulos caben en un botón de WhatsApp (20 caracteres)', () => {
    for (const kind of ['cuidados', 'como_sigues', 'calificacion'] as const) {
      for (const button of followupButtons(kind, FOLLOWUP)) {
        expect([...button.title].length).toBeLessThanOrEqual(20)
        expect(button.title).not.toBe('')
      }
    }
  })
})

function delivery(over: Partial<FollowupDelivery> = {}): FollowupDelivery {
  return {
    followupId: FOLLOWUP,
    appointmentId: APPT,
    kind: 'cuidados',
    accountId: ACCOUNT,
    contactId: CONTACT,
    conversationId: CONV,
    ownerUserId: OWNER,
    channel: 'text',
    businessName: 'Clínica Sonrisa',
    patientName: 'Tomás Gil',
    aftercare: 'No comas por 2 horas.',
    labels: DEFAULT_LABELS,
    ...over,
  }
}

describe('textos del seguimiento', () => {
  it('cuidados con la ventana abierta llevan las instrucciones del servicio', () => {
    const body = buildFollowupBody(delivery())

    expect(body).toContain('Tomás Gil')
    expect(body).toContain('Clínica Sonrisa')
    expect(body).toContain('No comas por 2 horas.')
  })

  it('la plantilla de cuidados nunca lleva las instrucciones ni el procedimiento', () => {
    const body = buildFollowupBody(delivery({ channel: 'template', aftercare: null }))

    expect(body).toContain('Tomás Gil')
    expect(body).not.toContain('No comas')
    expect(body).not.toMatch(/endodoncia/i)
  })

  it('las plantillas llevan dos variables: paciente y negocio', () => {
    expect(buildFollowupTemplateParams(delivery({ channel: 'template' }))).toEqual([
      'Tomás Gil',
      'Clínica Sonrisa',
    ])
  })

  it.each(['como_sigues', 'calificacion'] as const)('%s nombra al paciente y al negocio', (kind) => {
    const body = buildFollowupBody(delivery({ kind, aftercare: null }))

    expect(body).toContain('Tomás Gil')
    expect(body).toContain('Clínica Sonrisa')
  })

  it('una variable de la plantilla va en una sola línea', () => {
    expect(
      buildFollowupTemplateParams(delivery({ channel: 'template', patientName: 'Tomás\nGil' })),
    ).toEqual(['Tomás Gil', 'Clínica Sonrisa'])
  })
})

// ------------------------------------------------------------
// Runner: cuentas
// ------------------------------------------------------------

describe('runClinicFollowups — cuentas', () => {
  it('pide las cuentas con el módulo clínica y atiende solo esas', async () => {
    const db = makeFakeDb(
      baseSeed({
        booking_appointments: [
          ...baseSeed().booking_appointments,
          {
            id: 'ap-otra',
            account_id: OTHER_ACCOUNT,
            contact_id: 'ct-otra',
            service_id: 'svc-otra',
            starts_at: STARTS_AT,
            ends_at: ENDS_AT,
            status: 'completed',
          },
        ],
      }),
    )

    const { summary, ors } = await run(db)

    expect(ors.join(' ')).toContain('modules.cs.{clinica}')
    expect(summary.accounts).toBe(1)
    expect(rows(db, 'clinic_followups').every((f) => f.account_id === ACCOUNT)).toBe(true)
  })

  it('una cuenta sin el módulo clínica no siembra, no envía y no avisa', async () => {
    const db = makeFakeDb(
      baseSeed({
        accounts: [
          { id: ACCOUNT, name: 'Barbería', owner_user_id: OWNER, modules: ['agenda'], vertical_key: 'agenda' },
        ],
      }),
    )

    const { summary, deliveries } = await run(db, { now: new Date('2026-10-20T01:30:00.000Z') })

    expect(summary).toMatchObject({ accounts: 0, seeded: 0, sent: 0, dayCloses: 0 })
    expect(rows(db, 'clinic_followups')).toHaveLength(0)
    expect(deliveries).toHaveLength(0)
    expect(rows(db, 'notifications')).toHaveLength(0)
  })

  it('una cuenta con `modules` vacío y vertical_key clinica cuenta como clínica', async () => {
    const db = makeFakeDb(
      baseSeed({
        accounts: [{ id: ACCOUNT, name: 'Clínica', owner_user_id: OWNER, modules: [], vertical_key: 'clinica' }],
      }),
    )

    const { summary } = await run(db, { now: NOW_DAY0 })

    expect(summary.accounts).toBe(1)
  })

  it('sin la columna `modules` (053 sin aplicar) repite la lectura con vertical_key', async () => {
    const db = makeFakeDb(
      baseSeed({
        accounts: [{ id: ACCOUNT, name: 'Clínica', owner_user_id: OWNER, vertical_key: 'clinica' }],
      }),
    )
    db._failNext('select', 'accounts', { code: '42703', message: 'column accounts.modules does not exist' })

    const { summary } = await run(db, { now: NOW_DAY0 })

    expect(summary.accounts).toBe(1)
  })

  it('un fallo al leer las cuentas lanza (la ruta responde 500 y avisa)', async () => {
    const db = makeFakeDb(baseSeed())
    db._failNext('select', 'accounts', { message: 'connection reset' })

    await expect(run(db)).rejects.toThrow('no se pudieron leer las cuentas: connection reset')
  })
})

// ------------------------------------------------------------
// Runner: interruptor por cuenta (clinic_settings.followups_enabled)
//
// Los seguimientos le escriben a pacientes con plantillas que Meta debe
// aprobar. Sin el interruptor, desplegar el código los activaría en todas las
// clínicas. Apagado (o sin fila de configuración) no se siembra ni se envía;
// el cierre del día sigue, porque solo avisa al dueño dentro de la app.
// ------------------------------------------------------------

describe('runClinicFollowups — interruptor por cuenta', () => {
  /** 20:00 en Bogotá del lunes 19 de octubre, con una cita de hoy sin marcar. */
  const EIGHT_PM = new Date('2026-10-20T01:00:00.000Z')

  const withSwitch = (settings: Row[], extra: Record<string, Row[]> = {}) =>
    makeFakeDb(baseSeed({ clinic_settings: settings, ...extra }))

  it('con el interruptor apagado no siembra, no envía y no toca lo pendiente', async () => {
    const db = withSwitch([{ account_id: ACCOUNT, followups_enabled: false }], {
      clinic_followups: [followupRow()],
    })

    const { summary, deliveries } = await run(db, { now: NOW_DAY1 })

    expect(summary).toMatchObject({
      accounts: 1,
      followupAccounts: 0,
      seeded: 0,
      due: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    })
    expect(deliveries).toHaveLength(0)
    // Ni siquiera sembró la cita atendida del seed: solo queda la fila pendiente de antes.
    expect(rows(db, 'clinic_followups')).toHaveLength(1)
    expect(row(db, 'clinic_followups', FOLLOWUP)).toMatchObject({ status: 'pending', sent_at: null })
  })

  it('sin fila en clinic_settings cuenta como apagado', async () => {
    const db = withSwitch([])

    const { summary, deliveries } = await run(db, { now: NOW_DAY1 })

    expect(summary).toMatchObject({ accounts: 1, followupAccounts: 0, seeded: 0, sent: 0 })
    expect(deliveries).toHaveLength(0)
    expect(rows(db, 'clinic_followups')).toHaveLength(0)
  })

  it('un valor que no es true (null) cuenta como apagado', async () => {
    const db = withSwitch([{ account_id: ACCOUNT, followups_enabled: null }])

    const { summary } = await run(db, { now: NOW_DAY1 })

    expect(summary).toMatchObject({ followupAccounts: 0, seeded: 0, sent: 0 })
  })

  it('con el interruptor prendido siembra y envía', async () => {
    const db = withSwitch([{ account_id: ACCOUNT, followups_enabled: true }])

    const { summary, deliveries } = await run(db, { now: NOW_DAY1 })

    expect(summary).toMatchObject({ accounts: 1, followupAccounts: 1 })
    expect(summary.seeded).toBeGreaterThan(0)
    expect(deliveries.length).toBeGreaterThan(0)
  })

  it('cada cuenta decide por sí misma: la apagada no recibe nada aunque otra clínica sí', async () => {
    const SECOND = 'acc-3'
    const db = withSwitch(
      [
        { account_id: ACCOUNT, followups_enabled: false },
        { account_id: SECOND, followups_enabled: true },
      ],
      {
        accounts: [
          ...(baseSeed().accounts as Row[]),
          { id: SECOND, name: 'Clínica Dos', owner_user_id: 'u-3', modules: ['clinica'], vertical_key: 'agenda' },
        ],
        booking_appointments: [
          ...(baseSeed().booking_appointments as Row[]),
          {
            id: 'ap-3',
            account_id: SECOND,
            contact_id: 'ct-3',
            conversation_id: 'cv-3',
            service_id: null,
            starts_at: STARTS_AT,
            ends_at: ENDS_AT,
            status: 'completed',
          },
        ],
        contacts: [
          ...(baseSeed().contacts as Row[]),
          { id: 'ct-3', account_id: SECOND, name: 'Luis Paz', phone: '573009998877', wa_user_id: null },
        ],
        conversations: [
          ...(baseSeed().conversations as Row[]),
          { id: 'cv-3', account_id: SECOND, contact_id: 'ct-3', created_at: '2026-10-01T00:00:00.000Z' },
        ],
      },
    )

    const { summary, deliveries } = await run(db, { now: NOW_DAY1 })

    expect(summary).toMatchObject({ accounts: 2, followupAccounts: 1 })
    expect(deliveries.length).toBeGreaterThan(0)
    expect(deliveries.every((d) => d.accountId === SECOND)).toBe(true)
    expect(rows(db, 'clinic_followups').every((f) => f.account_id === SECOND)).toBe(true)
  })

  it('el cierre del día sigue funcionando con el interruptor apagado (no escribe a pacientes)', async () => {
    const db = withSwitch([{ account_id: ACCOUNT, followups_enabled: false }], {
      booking_appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          starts_at: '2026-10-19T14:00:00.000Z',
          ends_at: '2026-10-19T14:30:00.000Z',
          status: 'pending',
        },
      ],
    })

    const { summary, deliveries } = await run(db, { now: EIGHT_PM })

    expect(summary).toMatchObject({ followupAccounts: 0, sent: 0, dayCloses: 1 })
    expect(deliveries).toHaveLength(0)
    expect(rows(db, 'notifications')).toHaveLength(1)
    expect(rows(db, 'messages')).toHaveLength(1) // solo el mensaje del paciente del seed
  })

  it('un fallo al leer el interruptor lanza (la ruta responde 500 y avisa), no asume prendido', async () => {
    const db = withSwitch([{ account_id: ACCOUNT, followups_enabled: true }])
    db._failNext('select', 'clinic_settings', { message: 'connection reset' })

    await expect(run(db)).rejects.toThrow(
      'no se pudo leer el interruptor de los seguimientos: connection reset',
    )
    expect(rows(db, 'clinic_followups')).toHaveLength(0)
  })
})

// ------------------------------------------------------------
// Runner: siembra
// ------------------------------------------------------------

describe('runClinicFollowups — siembra', () => {
  it('crea los tres seguimientos de una cita atendida cuyo servicio tiene cuidados', async () => {
    const db = makeFakeDb(baseSeed())

    const { summary } = await run(db, { now: new Date('2026-10-19T14:15:00.000Z') })

    expect(summary.seeded).toBe(3)
    expect(
      rows(db, 'clinic_followups')
        .map((f) => ({
          kind: f.kind,
          due: f.due_at,
          account: f.account_id,
          appointment: f.appointment_id,
          contact: f.contact_id,
          status: f.status,
          attempts: f.attempts ?? 0,
        }))
        .sort((a, b) => String(a.due).localeCompare(String(b.due))),
    ).toEqual([
      { kind: 'cuidados', due: ENDS_AT, account: ACCOUNT, appointment: APPT, contact: CONTACT, status: 'pending', attempts: 0 },
      { kind: 'como_sigues', due: '2026-10-20T15:00:00.000Z', account: ACCOUNT, appointment: APPT, contact: CONTACT, status: 'pending', attempts: 0 },
      { kind: 'calificacion', due: '2026-10-21T15:00:00.000Z', account: ACCOUNT, appointment: APPT, contact: CONTACT, status: 'pending', attempts: 0 },
    ])
  })

  it('sin instrucciones de cuidado en el servicio no crea el de cuidados', async () => {
    const db = makeFakeDb(
      baseSeed({
        booking_services: [{ id: SERVICE, account_id: ACCOUNT, name: 'Valoración', aftercare_instructions: '  ' }],
      }),
    )

    await run(db, { now: NOW_DAY0 })

    expect(rows(db, 'clinic_followups').map((f) => f.kind).sort()).toEqual(['calificacion', 'como_sigues'])
  })

  it('una cita sin servicio solo tiene "¿cómo sigues?" y calificación', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [{ ...seed.booking_appointments[0], service_id: null }]
    const db = makeFakeDb(seed)

    await run(db, { now: NOW_DAY0 })

    expect(rows(db, 'clinic_followups').map((f) => f.kind).sort()).toEqual(['calificacion', 'como_sigues'])
  })

  it('correr dos veces no duplica (upsert con ignoreDuplicates)', async () => {
    const db = makeFakeDb(baseSeed())

    const first = await run(db, { now: NOW_DAY0 })
    const second = await run(db, { now: NOW_DAY0 })

    expect(first.summary.seeded).toBe(3)
    expect(second.summary.seeded).toBe(0)
    expect(rows(db, 'clinic_followups')).toHaveLength(3)
  })

  it('dos corridas a la vez siembran una sola vez (la segunda choca y no pisa nada)', async () => {
    const db = makeFakeDb(baseSeed())

    const [first, second] = await Promise.all([run(db, { now: NOW_DAY0 }), run(db, { now: NOW_DAY0 })])

    expect(first.summary.seeded + second.summary.seeded).toBe(3)
    expect(rows(db, 'clinic_followups')).toHaveLength(3)
  })

  it('una cita que ya tiene seguimientos no se vuelve a tocar', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [followupRow({ id: 'fu-existente', kind: 'como_sigues', status: 'sent' })],
      }),
    )

    const { summary } = await run(db, { now: NOW_DAY0 })

    expect(summary.seeded).toBe(0)
    expect(rows(db, 'clinic_followups')).toHaveLength(1)
    expect(row(db, 'clinic_followups', 'fu-existente').status).toBe('sent')
  })

  it('solo siembra citas atendidas con inicio en los últimos 3 días', async () => {
    const seed = baseSeed()
    const base = seed.booking_appointments[0]
    seed.booking_appointments = [
      { ...base, id: 'ap-no-vino', status: 'no_show' },
      { ...base, id: 'ap-pendiente', status: 'pending' },
      { ...base, id: 'ap-cancelada', status: 'cancelled' },
      // Hace casi 4 días.
      { ...base, id: 'ap-vieja', starts_at: '2026-10-15T14:00:00.000Z', ends_at: '2026-10-15T14:30:00.000Z' },
      // Todavía no empieza.
      { ...base, id: 'ap-futura', starts_at: '2026-10-20T20:00:00.000Z', ends_at: '2026-10-20T20:30:00.000Z' },
      // Hace 2 días y 21 horas: entra.
      { ...base, id: 'ap-reciente', starts_at: '2026-10-16T18:00:00.000Z', ends_at: '2026-10-16T18:30:00.000Z' },
    ]
    const db = makeFakeDb(seed)

    await run(db, { now: NOW_DAY0 })

    expect([...new Set(rows(db, 'clinic_followups').map((f) => f.appointment_id))]).toEqual(['ap-reciente'])
  })

  it('un fallo al sembrar una cuenta se anota y no frena el envío', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ kind: 'cuidados', due_at: ENDS_AT })] }))
    db._failNext('select', 'booking_appointments', { message: 'timeout' })

    const { summary } = await run(db, { now: NOW_DAY0 })

    expect(summary.failed).toBeGreaterThan(0)
    expect(summary.errors.join(' ')).toContain('timeout')
  })
})

// ------------------------------------------------------------
// Runner: envío
// ------------------------------------------------------------

describe('runClinicFollowups — envío', () => {
  it('con la ventana abierta manda el texto y reclama el seguimiento', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ kind: 'cuidados', due_at: ENDS_AT })] }))

    const { summary, deliveries } = await run(db, { now: NOW_DAY0 })

    expect(summary).toMatchObject({ due: 1, sent: 1, failed: 0, skipped: 0 })
    expect(summary.byChannel).toEqual({ text: 1, template: 0 })
    expect(summary.byKind).toMatchObject({ cuidados: 1 })
    expect(deliveries).toEqual([
      {
        followupId: FOLLOWUP,
        appointmentId: APPT,
        kind: 'cuidados',
        accountId: ACCOUNT,
        contactId: CONTACT,
        conversationId: CONV,
        ownerUserId: OWNER,
        channel: 'text',
        businessName: 'Clínica Sonrisa',
        patientName: 'Tomás Gil',
        aftercare: 'No comas por 2 horas.',
        labels: DEFAULT_LABELS,
      },
    ])
    expect(row(db, 'clinic_followups', FOLLOWUP)).toMatchObject({
      status: 'sent',
      sent_at: NOW_DAY0.toISOString(),
    })
  })

  it('con la ventana cerrada manda la plantilla y los cuidados no viajan', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [followupRow({ kind: 'cuidados', due_at: ENDS_AT })],
        messages: [
          {
            id: 'm-viejo',
            conversation_id: CONV,
            sender_type: 'customer',
            created_at: '2026-10-10T14:00:00.000Z',
          },
        ],
      }),
    )

    const { summary, deliveries } = await run(db, { now: NOW_DAY0 })

    expect(summary.byChannel).toEqual({ text: 0, template: 1 })
    expect(deliveries[0]).toMatchObject({ channel: 'template', kind: 'cuidados', aftercare: null })
  })

  it.each(['como_sigues', 'calificacion'] as const)('%s no lleva instrucciones en ningún canal', async (kind) => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ kind, due_at: iso('2026-10-20T15:00:00.000Z') })] }))

    const { deliveries } = await run(db, { now: NOW_DAY2 })

    expect(deliveries[0]).toMatchObject({ kind, aftercare: null })
  })

  it('no envía lo que todavía no vence', async () => {
    const db = makeFakeDb(
      baseSeed({ clinic_followups: [followupRow({ kind: 'como_sigues', due_at: iso('2026-10-20T15:00:00.000Z') })] }),
    )

    const { summary, deliveries } = await run(db, { now: NOW_DAY0 })

    expect(summary.due).toBe(0)
    expect(deliveries).toHaveLength(0)
    expect(row(db, 'clinic_followups', FOLLOWUP).status).toBe('pending')
  })

  it('no vuelve a enviar lo que ya salió, se omitió o falló', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [
          followupRow({ id: 'fu-a', status: 'sent' }),
          followupRow({ id: 'fu-b', kind: 'cuidados', status: 'skipped' }),
          followupRow({ id: 'fu-c', kind: 'calificacion', status: 'failed' }),
        ],
      }),
    )

    const { deliveries } = await run(db, { now: NOW_DAY2 })

    expect(deliveries).toHaveLength(0)
  })

  it('el cupo de la corrida (limit) corta, y se atiende primero lo más viejo', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [
          followupRow({ id: 'fu-3', kind: 'calificacion', due_at: iso('2026-10-20T16:00:00.000Z') }),
          followupRow({ id: 'fu-1', kind: 'cuidados', due_at: iso('2026-10-19T14:30:00.000Z') }),
          followupRow({ id: 'fu-2', kind: 'como_sigues', due_at: iso('2026-10-20T15:00:00.000Z') }),
        ],
      }),
    )

    const { summary, deliveries } = await run(db, { now: NOW_DAY2, limit: 2 })

    expect(summary.due).toBe(2)
    expect(deliveries.map((d) => d.followupId)).toEqual(['fu-1', 'fu-2'])
    expect(row(db, 'clinic_followups', 'fu-3').status).toBe('pending')
  })

  it('dos corridas a la vez no mandan el mismo seguimiento dos veces', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ kind: 'cuidados', due_at: ENDS_AT })] }))
    const recorder = makeRecorder()

    await Promise.all([run(db, { now: NOW_DAY0, send: recorder.send }), run(db, { now: NOW_DAY0, send: recorder.send })])

    expect(recorder.deliveries).toHaveLength(1)
  })

  it('usa la conversación más reciente del contacto si la cita no tiene una', async () => {
    const seed = baseSeed({ clinic_followups: [followupRow({ kind: 'como_sigues' })] })
    seed.booking_appointments = [{ ...seed.booking_appointments[0], conversation_id: null }]
    const db = makeFakeDb(seed)

    const { deliveries } = await run(db, { now: NOW_DAY1 })

    expect(deliveries[0].conversationId).toBe(CONV)
  })

  it('lleva las palabras del negocio (cita, turno…) al mensaje', async () => {
    const db = makeFakeDb(
      baseSeed({
        booking_settings: [{ account_id: ACCOUNT, labels: { cita: 'turno', citas: 'turnos' } }],
        clinic_followups: [followupRow({ kind: 'cuidados', due_at: ENDS_AT })],
      }),
    )

    const { deliveries } = await run(db, { now: NOW_DAY0 })

    expect(deliveries[0].labels).toMatchObject({ cita: 'turno', citas: 'turnos' })
  })
})

// ------------------------------------------------------------
// Runner: omisiones
// ------------------------------------------------------------

describe('runClinicFollowups — omisiones', () => {
  async function skipped(db: FakeDb, now = NOW_DAY2) {
    const result = await run(db, { now })
    return { ...result, followup: row(db, 'clinic_followups', FOLLOWUP) }
  }

  it('una cita que ya no está atendida se omite', async () => {
    const seed = baseSeed({ clinic_followups: [followupRow()] })
    seed.booking_appointments = [{ ...seed.booking_appointments[0], status: 'no_show' }]
    const db = makeFakeDb(seed)

    const { summary, deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(summary.skipped).toBe(1)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'appointment_not_completed' })
  })

  it('un contacto con la etiqueta de baja se omite', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [followupRow()],
        tags: [{ id: 'tag-baja', account_id: ACCOUNT, name: OPT_OUT_TAG }],
        contact_tags: [{ contact_id: CONTACT, tag_id: 'tag-baja' }],
      }),
    )

    const { deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'opt_out' })
  })

  it('quien revocó la autorización de datos se omite', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [followupRow()],
        clinic_consents: [
          { account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: true, created_at: '2026-10-01T00:00:00.000Z' },
          { account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: false, created_at: '2026-10-15T00:00:00.000Z' },
        ],
      }),
    )

    const { deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'consent_revoked' })
  })

  it('quien nunca respondió la autorización sí recibe el seguimiento', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow()] }))

    const { deliveries } = await skipped(db)

    expect(deliveries).toHaveLength(1)
  })

  it('un contacto sin número de WhatsApp se omite', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [followupRow()],
        contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Marta Ruiz', phone: '', wa_user_id: null }],
      }),
    )

    const { deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'no_phone' })
  })

  it('un contacto borrado (contact_id nulo) se omite', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ contact_id: null })] }))

    const { deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'no_contact' })
  })

  it('sin ninguna conversación del contacto se omite para siempre (no se queda en la cola)', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow()], conversations: [] }))
    const seed = db._tables.booking_appointments[0]
    seed.conversation_id = null

    const { deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'no_conversation' })
  })

  it('unos cuidados cuyo servicio ya no tiene instrucciones se omiten, con cualquier canal', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [followupRow({ kind: 'cuidados', due_at: ENDS_AT })],
        booking_services: [{ id: SERVICE, account_id: ACCOUNT, name: 'Endodoncia', aftercare_instructions: null }],
      }),
    )

    const { deliveries, followup } = await skipped(db, NOW_DAY0)

    expect(deliveries).toHaveLength(0)
    expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'no_aftercare' })
  })

  describe('calificación', () => {
    const rating = (extra: Record<string, Row[]> = {}) =>
      makeFakeDb(
        baseSeed({
          clinic_followups: [followupRow({ kind: 'calificacion', due_at: iso('2026-10-21T15:00:00.000Z') })],
          ...extra,
        }),
      )

    it('sin nada que lo impida se envía', async () => {
      const { deliveries } = await skipped(rating())

      expect(deliveries).toHaveLength(1)
      expect(deliveries[0].kind).toBe('calificacion')
    })

    it('con una cita futura activa se omite (también confirmada)', async () => {
      for (const status of ['pending', 'confirmed']) {
        const db = rating({
          booking_appointments: [
            ...baseSeed().booking_appointments,
            {
              id: 'ap-futura',
              account_id: ACCOUNT,
              contact_id: CONTACT,
              starts_at: '2026-10-30T15:00:00.000Z',
              ends_at: '2026-10-30T15:30:00.000Z',
              status,
            },
          ],
        })

        const { deliveries, followup } = await skipped(db)

        expect(deliveries).toHaveLength(0)
        expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'future_appointment' })
      }
    })

    it('una cita futura cancelada, o una pasada, no la impide', async () => {
      const db = rating({
        booking_appointments: [
          ...baseSeed().booking_appointments,
          { id: 'ap-cancelada', account_id: ACCOUNT, contact_id: CONTACT, starts_at: '2026-10-30T15:00:00.000Z', status: 'cancelled' },
          { id: 'ap-pasada', account_id: ACCOUNT, contact_id: CONTACT, starts_at: '2026-10-01T15:00:00.000Z', status: 'pending' },
        ],
      })

      const { deliveries } = await skipped(db)

      expect(deliveries).toHaveLength(1)
    })

    it('con una calificación en los últimos 90 días se omite', async () => {
      const db = rating({
        clinic_ratings: [{ id: 'r-1', account_id: ACCOUNT, contact_id: CONTACT, value: 'bien', created_at: '2026-08-01T00:00:00.000Z' }],
      })

      const { deliveries, followup } = await skipped(db)

      expect(deliveries).toHaveLength(0)
      expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'recent_rating' })
    })

    it('una calificación de hace más de 90 días no la impide', async () => {
      const db = rating({
        clinic_ratings: [{ id: 'r-1', account_id: ACCOUNT, contact_id: CONTACT, value: 'bien', created_at: '2026-07-01T00:00:00.000Z' }],
      })

      const { deliveries } = await skipped(db)

      expect(deliveries).toHaveLength(1)
    })

    it('la calificación de otro contacto no la impide', async () => {
      const db = rating({
        clinic_ratings: [{ id: 'r-1', account_id: ACCOUNT, contact_id: 'ct-otro', value: 'mal', created_at: '2026-10-01T00:00:00.000Z' }],
      })

      const { deliveries } = await skipped(db)

      expect(deliveries).toHaveLength(1)
    })

    it('con la etiqueta queja-abierta se omite', async () => {
      const db = rating({
        tags: [{ id: 'tag-queja', account_id: ACCOUNT, name: OPEN_COMPLAINT_TAG }],
        contact_tags: [{ contact_id: CONTACT, tag_id: 'tag-queja' }],
      })

      const { deliveries, followup } = await skipped(db)

      expect(deliveries).toHaveLength(0)
      expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'open_complaint' })
    })

    it.each(['molestias', 'ayuda'])('si en "¿cómo sigues?" respondió %s se omite', async (response) => {
      const db = rating({
        clinic_followups: [
          followupRow({ kind: 'calificacion', due_at: iso('2026-10-21T15:00:00.000Z') }),
          followupRow({ id: 'fu-como', kind: 'como_sigues', status: 'sent', response }),
        ],
      })

      const { deliveries, followup } = await skipped(db)

      expect(deliveries).toHaveLength(0)
      expect(followup).toMatchObject({ status: 'skipped', skip_reason: 'trouble_reported' })
    })

    it('si respondió que está bien, la calificación sale', async () => {
      const db = rating({
        clinic_followups: [
          followupRow({ kind: 'calificacion', due_at: iso('2026-10-21T15:00:00.000Z') }),
          followupRow({ id: 'fu-como', kind: 'como_sigues', status: 'sent', response: 'bien' }),
        ],
      })

      const { deliveries } = await skipped(db)

      expect(deliveries).toHaveLength(1)
    })

    it('las reglas de la calificación no aplican a los otros seguimientos', async () => {
      const db = makeFakeDb(
        baseSeed({
          clinic_followups: [followupRow({ kind: 'como_sigues' })],
          tags: [{ id: 'tag-queja', account_id: ACCOUNT, name: OPEN_COMPLAINT_TAG }],
          contact_tags: [{ contact_id: CONTACT, tag_id: 'tag-queja' }],
          clinic_ratings: [{ id: 'r-1', account_id: ACCOUNT, contact_id: CONTACT, value: 'bien', created_at: '2026-10-01T00:00:00.000Z' }],
        }),
      )

      const { deliveries } = await skipped(db)

      expect(deliveries).toHaveLength(1)
    })
  })

  it('un fallo al leer lo necesario no omite ni reclama: se reintenta en la próxima corrida', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow()] }))
    db._failNext('select', 'tags', { message: 'connection reset' })

    const { summary, deliveries, followup } = await skipped(db)

    expect(deliveries).toHaveLength(0)
    expect(summary.failed).toBe(1)
    expect(summary.errors.join(' ')).toContain('connection reset')
    expect(followup).toMatchObject({ status: 'pending', attempts: 0 })
  })
})

// ------------------------------------------------------------
// Runner: revertir y fallar
// ------------------------------------------------------------

describe('runClinicFollowups — fallos de envío', () => {
  const failing = async () => {
    throw new Error('(#131047) Re-engagement message')
  }

  it('si el envío falla, vuelve a pendiente con un intento más', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow()] }))

    const { summary } = await run(db, { now: NOW_DAY1, send: failing })

    expect(summary).toMatchObject({ sent: 0, failed: 1 })
    expect(summary.errors).toEqual([`seguimiento ${FOLLOWUP}: (#131047) Re-engagement message`])
    expect(row(db, 'clinic_followups', FOLLOWUP)).toMatchObject({
      status: 'pending',
      attempts: 1,
      sent_at: null,
    })
  })

  it('el error no lleva el nombre del paciente ni su número', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow()] }))

    const { summary } = await run(db, { now: NOW_DAY1, send: failing })

    const text = summary.errors.join(' ')
    expect(text).not.toContain('Tomás')
    expect(text).not.toContain('573001112233')
  })

  it('al llegar al tercer intento queda fallido y ya no se reintenta', async () => {
    expect(FOLLOWUP_MAX_ATTEMPTS).toBe(3)
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ attempts: 2 })] }))

    await run(db, { now: NOW_DAY1, send: failing })
    expect(row(db, 'clinic_followups', FOLLOWUP)).toMatchObject({ status: 'failed', attempts: 3, sent_at: null })

    const recorder = makeRecorder()
    await run(db, { now: NOW_DAY1, send: recorder.send })
    expect(recorder.deliveries).toHaveLength(0)
  })

  it('tres corridas fallidas seguidas lo dejan fallido', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow()] }))

    for (let i = 0; i < 3; i++) await run(db, { now: NOW_DAY1, send: failing })

    expect(row(db, 'clinic_followups', FOLLOWUP)).toMatchObject({ status: 'failed', attempts: 3 })
  })

  it('un fallo no frena los demás seguimientos de la corrida', async () => {
    const db = makeFakeDb(
      baseSeed({
        clinic_followups: [
          followupRow({ id: 'fu-1', kind: 'cuidados', due_at: ENDS_AT }),
          followupRow({ id: 'fu-2', kind: 'como_sigues' }),
        ],
      }),
    )
    const sent: string[] = []

    const { summary } = await run(db, {
      now: NOW_DAY1,
      send: async (d) => {
        if (d.followupId === 'fu-1') throw new Error('meta 500')
        sent.push(d.followupId)
      },
    })

    expect(sent).toEqual(['fu-2'])
    expect(summary).toMatchObject({ sent: 1, failed: 1 })
  })

  it('si no se puede escribir la omisión, queda pendiente y se anota', async () => {
    const db = makeFakeDb(baseSeed({ clinic_followups: [followupRow({ contact_id: null })] }))
    db._failNext('update', 'clinic_followups', { message: 'read-only' })

    const { summary } = await run(db, { now: NOW_DAY1 })

    expect(summary.failed).toBe(1)
    expect(row(db, 'clinic_followups', FOLLOWUP).status).toBe('pending')
  })
})

// ------------------------------------------------------------
// Runner: cierre del día
// ------------------------------------------------------------

describe('runClinicFollowups — cierre del día', () => {
  /** 20:00 en Bogotá del lunes 19 de octubre. */
  const EIGHT_PM = new Date('2026-10-20T01:00:00.000Z')

  const apptRow = (id: string, startsAt: string, status: string, account = ACCOUNT): Row => ({
    id,
    account_id: account,
    contact_id: CONTACT,
    starts_at: startsAt,
    ends_at: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
    status,
  })

  function closeDb(appointments: Row[], extra: Record<string, Row[]> = {}) {
    return makeFakeDb(baseSeed({ booking_appointments: appointments, ...extra }))
  }

  const noticeRows = (db: FakeDb) => rows(db, 'notifications')

  it('desde las 20:00 avisa una vez al dueño cuántas citas de hoy quedaron sin marcar', async () => {
    const db = closeDb([
      apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending'),
      apptRow('a-2', '2026-10-19T18:00:00.000Z', 'confirmed'),
    ])

    const { summary } = await run(db, { now: EIGHT_PM })

    expect(summary.dayCloses).toBe(1)
    expect(noticeRows(db)).toHaveLength(1)
    expect(noticeRows(db)[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: OWNER,
      conversation_id: null,
      contact_id: null,
      title: 'Cierre del día pendiente',
    })
    expect(String(noticeRows(db)[0].body)).toContain('Tienes 2 citas de hoy sin marcar')
    expect(rows(db, 'clinic_day_closes')).toEqual([
      expect.objectContaining({ account_id: ACCOUNT, date_key: '2026-10-19' }),
    ])
  })

  it('con una sola cita lo dice en singular', async () => {
    const db = closeDb([apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending')])

    await run(db, { now: EIGHT_PM })

    expect(String(noticeRows(db)[0].body)).toContain('Tienes 1 cita de hoy sin marcar')
  })

  it('correr el cron de nuevo el mismo día no repite el aviso', async () => {
    const db = closeDb([apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending')])

    await run(db, { now: EIGHT_PM })
    const again = await run(db, { now: new Date('2026-10-20T02:30:00.000Z') })

    expect(again.summary.dayCloses).toBe(0)
    expect(noticeRows(db)).toHaveLength(1)
  })

  it('dos corridas a la vez avisan una sola vez', async () => {
    const db = closeDb([apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending')])

    await Promise.all([run(db, { now: EIGHT_PM }), run(db, { now: EIGHT_PM })])

    expect(noticeRows(db)).toHaveLength(1)
  })

  it('al día siguiente vuelve a avisar', async () => {
    const db = closeDb([
      apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending'),
      apptRow('a-2', '2026-10-20T14:00:00.000Z', 'pending'),
    ])

    await run(db, { now: EIGHT_PM })
    await run(db, { now: new Date('2026-10-21T01:00:00.000Z') })

    expect(rows(db, 'clinic_day_closes').map((c) => c.date_key)).toEqual(['2026-10-19', '2026-10-20'])
    expect(noticeRows(db)).toHaveLength(2)
  })

  it('antes de las 20:00 no avisa', async () => {
    const db = closeDb([apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending')])

    // 19:50 en Bogotá.
    const { summary } = await run(db, { now: new Date('2026-10-20T00:50:00.000Z') })

    expect(summary.dayCloses).toBe(0)
    expect(noticeRows(db)).toHaveLength(0)
  })

  it('no cuenta lo ya marcado, lo cancelado, lo que no ha empezado ni lo de otros días', async () => {
    const db = closeDb([
      apptRow('a-atendida', '2026-10-19T14:00:00.000Z', 'completed'),
      apptRow('a-no-vino', '2026-10-19T15:00:00.000Z', 'no_show'),
      apptRow('a-cancelada', '2026-10-19T16:00:00.000Z', 'cancelled'),
      // 21:00 en Bogotá: todavía no empieza a las 20:00.
      apptRow('a-futura', '2026-10-20T02:00:00.000Z', 'pending'),
      // Ayer.
      apptRow('a-ayer', '2026-10-18T14:00:00.000Z', 'pending'),
      // 22:00 de ayer en Bogotá: es el día 19 en UTC, pero no es "hoy".
      apptRow('a-anoche', '2026-10-19T03:00:00.000Z', 'pending'),
      // Otra cuenta (sin clínica).
      apptRow('a-otra', '2026-10-19T14:00:00.000Z', 'pending', OTHER_ACCOUNT),
    ])

    const { summary } = await run(db, { now: EIGHT_PM })

    expect(summary.dayCloses).toBe(0)
    expect(noticeRows(db)).toHaveLength(0)
    expect(rows(db, 'clinic_day_closes')).toHaveLength(0)
  })

  it('una cita de las 7:00 a. m. de hoy cuenta aunque UTC ya sea otro día', async () => {
    // 20:00 de Bogotá es 01:00Z del día siguiente: "hoy" se mide en hora local.
    const db = closeDb([apptRow('a-1', '2026-10-19T12:00:00.000Z', 'pending')])

    const { summary } = await run(db, { now: EIGHT_PM })

    expect(summary.dayCloses).toBe(1)
  })

  it('si el aviso no se pudo crear, suelta el cierre para reintentar en la próxima corrida', async () => {
    const db = closeDb([apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending')])
    db._failNext('insert', 'notifications', { message: 'boom' })

    const first = await run(db, { now: EIGHT_PM })

    expect(first.summary.dayCloses).toBe(0)
    expect(first.summary.failed).toBe(1)
    expect(first.summary.errors.join(' ')).toContain('boom')
    expect(rows(db, 'clinic_day_closes')).toHaveLength(0)

    const second = await run(db, { now: new Date('2026-10-20T01:10:00.000Z') })

    expect(second.summary.dayCloses).toBe(1)
    expect(noticeRows(db)).toHaveLength(1)
  })

  it('usa las palabras del negocio', async () => {
    const db = closeDb([apptRow('a-1', '2026-10-19T14:00:00.000Z', 'pending'), apptRow('a-2', '2026-10-19T15:00:00.000Z', 'pending')], {
      booking_settings: [{ account_id: ACCOUNT, labels: { cita: 'turno', citas: 'turnos' } }],
    })

    await run(db, { now: EIGHT_PM })

    expect(String(noticeRows(db)[0].body)).toContain('Tienes 2 turnos de hoy sin marcar')
  })
})
