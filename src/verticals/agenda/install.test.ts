import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { installAgendaTemplate } from './install'
import { AGENDA_PRESETS, type PresetKey } from './presets'
import { BARBERIA_PRESET } from './presets/barberia'

const AGENDA_SEED = BARBERIA_PRESET.seed

// ============================================================
// Installer contract tests.
//
// The installer talks to Supabase through a tiny chainable surface
// (select/insert/update/delete + eq + maybeSingle). The fake below
// implements exactly that surface over in-memory tables and applies
// `eq` filters the way PostgREST would — so a query that forgets
// `account_id` genuinely reads the wrong rows here, instead of the
// test merely asserting on call shapes.
// ============================================================

type Row = Record<string, unknown>

interface QueryApi {
  select(cols?: string, opts?: unknown): QueryApi
  insert(payload: unknown): QueryApi
  update(payload: unknown): QueryApi
  upsert(payload: unknown, opts?: { onConflict?: string }): QueryApi
  delete(): QueryApi
  eq(col: string, val: unknown): QueryApi
  order(col?: string): QueryApi
  maybeSingle(): Promise<{ data: Row | null; error: null }>
  then(
    resolve: (v: { data: Row[] | null; error: unknown }) => unknown,
  ): Promise<unknown>
}

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

interface FakeDb {
  from(table: string): QueryApi
  _tables: Record<string, Row[]>
  /** Hace fallar la PRÓXIMA operación `op` sobre `table` (devuelve un error de PostgREST). */
  _failNext(op: Op, table: string): void
  /** Corre antes de cada operación (simula una escritura concurrente de otra sesión). */
  _beforeOp: ((op: Op, table: string) => void) | null
}

function fakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }))
  }
  const ensure = (t: string): Row[] => (tables[t] ??= [])
  const failures: [Op, string][] = []

  const db: FakeDb = {
    _tables: tables,
    _beforeOp: null,
    _failNext(op, table) {
      failures.push([op, table])
    },
    from(table: string): QueryApi {
      const state: {
        op: Op
        payload?: unknown
        onConflict?: string
        filters: [string, unknown][]
      } = { op: 'select', filters: [] }

      const rows = (): Row[] =>
        ensure(table).filter((r) =>
          state.filters.every(([col, val]) => r[col] === val),
        )

      const api: QueryApi = {
        select: () => api,
        insert: (payload) => {
          state.op = 'insert'
          state.payload = payload
          return api
        },
        update: (payload) => {
          state.op = 'update'
          state.payload = payload
          return api
        },
        upsert: (payload, opts) => {
          state.op = 'upsert'
          state.payload = payload
          state.onConflict = opts?.onConflict
          return api
        },
        delete: () => {
          state.op = 'delete'
          return api
        },
        eq: (col, val) => {
          state.filters.push([col, val])
          return api
        },
        order: () => api,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve) => {
          db._beforeOp?.(state.op, table)
          const failAt = failures.findIndex(([op, t]) => op === state.op && t === table)
          if (failAt >= 0) {
            failures.splice(failAt, 1)
            return Promise.resolve({ data: null, error: { message: 'falló a propósito' } }).then(resolve)
          }
          let data: Row[] | null = null
          if (state.op === 'select') {
            data = rows()
          } else if (state.op === 'insert') {
            const list = Array.isArray(state.payload)
              ? (state.payload as Row[])
              : [state.payload as Row]
            ensure(table).push(...list.map((r) => ({ ...r })))
          } else if (state.op === 'update') {
            for (const r of rows()) Object.assign(r, state.payload)
          } else if (state.op === 'upsert') {
            // Como PostgREST: mezcla en la fila con la misma clave de conflicto o la crea.
            const key = state.onConflict ?? 'id'
            const incoming = state.payload as Row
            const existing = ensure(table).find((r) => r[key] === incoming[key])
            if (existing) Object.assign(existing, incoming)
            else ensure(table).push({ ...incoming })
          } else {
            for (const r of rows()) {
              const i = ensure(table).indexOf(r)
              if (i >= 0) ensure(table).splice(i, 1)
            }
          }
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return api
    },
  }
  return db
}

const ACCOUNT = 'acc-1'
const USER = 'user-1'

function asClient(db: FakeDb): SupabaseClient {
  return db as unknown as SupabaseClient
}

function install(db: FakeDb) {
  return installAgendaTemplate({
    db: asClient(db),
    accountId: ACCOUNT,
    userId: USER,
  })
}

describe('installAgendaTemplate', () => {
  it('instala la plantilla completa en una cuenta vacía', async () => {
    const db = fakeDb({
      // Cuenta que ya configuró su proveedor de IA pero sin prompt propio.
      ai_configs: [{ id: 'ai-1', account_id: ACCOUNT, system_prompt: null }],
    })

    const report = await install(db)

    expect(report.services).toEqual({ created: 3, skipped: 0 })
    expect(report.staff).toEqual({ created: 1, skipped: 0 })
    expect(report.staffServices).toEqual({ created: 3, skipped: 0 })
    expect(report.workingHours).toEqual({ created: 12, skipped: 0 })
    expect(report.tags).toEqual({ created: 6, skipped: 0 })
    expect(report.customFields).toEqual({ created: 2, skipped: 0 })
    expect(report.pipeline).toEqual({ created: true, stagesCreated: 5 })
    expect(report.quickReplies).toEqual({ created: 2, skipped: 0 })
    expect(report.knowledge).toEqual({ created: 5, skipped: 0 })
    expect(report.aiPrompt).toBe('written')
    expect(report.warnings).toEqual([])

    // Cada fila queda amarrada a la cuenta (y a quien instaló).
    const ownedTables = [
      'booking_services',
      'booking_staff',
      'booking_staff_services',
      'booking_working_hours',
      'tags',
      'custom_fields',
      'quick_replies',
      'ai_knowledge_documents',
      'ai_knowledge_chunks',
      'pipelines',
    ]
    for (const table of ownedTables) {
      const rows = db._tables[table]
      expect(rows, table).toBeDefined()
      expect(rows.length, table).toBeGreaterThan(0)
      expect(
        rows.every((r) => r.account_id === ACCOUNT),
        table,
      ).toBe(true)
    }

    // Etapas del pipeline: cuelgan del pipeline recién creado.
    const pipeline = db._tables.pipelines[0]
    const stages = db._tables.pipeline_stages
    expect(stages).toHaveLength(AGENDA_SEED.pipeline.stages.length)
    expect(stages.every((s) => s.pipeline_id === pipeline.id)).toBe(true)
    expect(stages.map((s) => s.name)).toEqual(
      AGENDA_SEED.pipeline.stages.map((s) => s.name),
    )

    // Filas con user_id (en estas tablas la columna es NOT NULL pre-017).
    expect(db._tables.tags.every((r) => r.user_id === USER)).toBe(true)
    expect(db._tables.custom_fields.every((r) => r.user_id === USER)).toBe(
      true,
    )
    expect(db._tables.pipelines.every((r) => r.user_id === USER)).toBe(true)
    expect(db._tables.quick_replies.every((r) => r.user_id === USER)).toBe(
      true,
    )

    // Los documentos de conocimiento quedan troceados (chunks) y sin
    // embeddings — la búsqueda léxica ya funciona; el embebido llega al
    // re-guardar el documento.
    expect(db._tables.ai_knowledge_chunks.length).toBeGreaterThanOrEqual(
      AGENDA_SEED.knowledgeDocs.length,
    )
    expect(
      db._tables.ai_knowledge_chunks.every((r) => r.embedding === null),
    ).toBe(true)
    const docIds = new Set(
      db._tables.ai_knowledge_documents.map((r) => r.id as string),
    )
    expect(
      db._tables.ai_knowledge_chunks.every((r) =>
        docIds.has(r.document_id as string),
      ),
    ).toBe(true)

    // El prompt del agente se escribió porque estaba vacío.
    expect(db._tables.ai_configs[0].system_prompt).toBe(BARBERIA_PRESET.aiPrompt)
  })

  it('es idempotente: reinstalar no duplica ni reescribe nada', async () => {
    const db = fakeDb({
      ai_configs: [{ id: 'ai-1', account_id: ACCOUNT, system_prompt: null }],
    })

    await install(db)
    const countsAfterFirst = Object.fromEntries(
      Object.entries(db._tables).map(([t, rows]) => [t, rows.length]),
    )

    const second = await install(db)

    expect(second.services).toEqual({ created: 0, skipped: 3 })
    expect(second.staff).toEqual({ created: 0, skipped: 1 })
    expect(second.staffServices).toEqual({ created: 0, skipped: 3 })
    expect(second.workingHours).toEqual({ created: 0, skipped: 12 })
    expect(second.tags).toEqual({ created: 0, skipped: 6 })
    expect(second.customFields).toEqual({ created: 0, skipped: 2 })
    expect(second.pipeline).toEqual({ created: false, stagesCreated: 0 })
    expect(second.quickReplies).toEqual({ created: 0, skipped: 2 })
    expect(second.knowledge).toEqual({ created: 0, skipped: 5 })
    expect(second.aiPrompt).toBe('already_set')
    expect(second.warnings.length).toBeGreaterThan(0)

    const countsAfterSecond = Object.fromEntries(
      Object.entries(db._tables).map(([t, rows]) => [t, rows.length]),
    )
    expect(countsAfterSecond).toEqual(countsAfterFirst)
  })

  it('nunca sobrescribe el prompt de IA existente', async () => {
    const db = fakeDb({
      ai_configs: [
        {
          id: 'ai-1',
          account_id: ACCOUNT,
          system_prompt: 'Prompt propio del dueño',
        },
      ],
    })

    const report = await install(db)

    expect(report.aiPrompt).toBe('already_set')
    expect(report.warnings.some((w) => w.includes('prompt'))).toBe(true)
    expect(db._tables.ai_configs[0].system_prompt).toBe(
      'Prompt propio del dueño',
    )
  })

  it('sin fila de ai_configs deja advertencia y no inventa una configuración', async () => {
    const db = fakeDb()

    const report = await install(db)

    expect(report.aiPrompt).toBe('no_config')
    expect(report.warnings.some((w) => w.includes('IA'))).toBe(true)
    expect(db._tables.ai_configs ?? []).toHaveLength(0)
  })

  it('respeta servicios y barberos que el dueño ya había creado', async () => {
    const db = fakeDb({
      booking_services: [
        {
          id: 'svc-propio',
          account_id: ACCOUNT,
          name: 'CORTE CLÁSICO', // misma cosa, otra capitalización
          description: 'Editado por el dueño',
        },
      ],
      booking_staff: [
        { id: 'staff-propio', account_id: ACCOUNT, name: 'andrés' },
      ],
    })

    const report = await install(db)

    expect(report.services).toEqual({ created: 2, skipped: 1 })
    expect(report.staff).toEqual({ created: 0, skipped: 1 })
    // La fila existente no se toca.
    const svc = db._tables.booking_services.find((r) => r.id === 'svc-propio')
    expect(svc?.description).toBe('Editado por el dueño')
    // La relación barbero-servicios usa el barbero existente.
    expect(db._tables.booking_staff_services).toHaveLength(3)
    expect(
      db._tables.booking_staff_services.every(
        (r) => r.staff_id === 'staff-propio',
      ),
    ).toBe(true)
  })

  it.each(['Agenda', '  barbería '])(
    'trata un pipeline existente llamado %j como el de la agenda',
    async (name) => {
      const db = fakeDb({
        pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, name }],
      })

      const report = await install(db)

      // Existía pero sin etapas (una instalación cortada): se siembran en ese pipeline.
      expect(report.pipeline).toEqual({ created: false, stagesCreated: 5 })
      expect(db._tables.pipelines).toHaveLength(1)
      expect(db._tables.pipeline_stages).toHaveLength(5)
      expect(db._tables.pipeline_stages.every((s) => s.pipeline_id === 'pipe-1')).toBe(true)
      expect(db._tables.pipeline_stages.map((s) => s.name)).toContain('Cita agendada')
    },
  )

  it('no toca las etapas de un pipeline que ya las tiene', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, name: 'Barbería' }],
      pipeline_stages: [{ id: 'st-1', pipeline_id: 'pipe-1', name: 'Mi etapa' }],
    })

    const report = await install(db)

    expect(report.pipeline).toEqual({ created: false, stagesCreated: 0 })
    expect(db._tables.pipeline_stages).toEqual([
      { id: 'st-1', pipeline_id: 'pipe-1', name: 'Mi etapa' },
    ])
  })

  it('no toca datos de otras cuentas', async () => {
    const db = fakeDb({
      booking_services: [
        { id: 'ajeno-svc', account_id: 'acc-2', name: 'Corte clásico' },
      ],
      tags: [{ id: 'ajeno-tag', account_id: 'acc-2', name: 'cita-pendiente' }],
      pipelines: [{ id: 'ajeno-pipe', account_id: 'acc-2', name: 'Barbería' }],
      accounts: [
        { id: ACCOUNT, default_currency: 'USD' },
        { id: 'acc-2', default_currency: 'USD' },
      ],
    })

    const report = await install(db)

    expect(report.services).toEqual({ created: 3, skipped: 0 })
    expect(report.tags).toEqual({ created: 6, skipped: 0 })
    expect(report.pipeline).toEqual({ created: true, stagesCreated: 5 })

    expect(db._tables.booking_services).toHaveLength(4) // 1 ajena + 3 nuevas
    expect(db._tables.tags).toHaveLength(7)
    expect(db._tables.pipelines).toHaveLength(2)
    expect(
      db._tables.pipelines.filter((r) => r.account_id === 'acc-2'),
    ).toHaveLength(1)
    // La regla de moneda también queda acotada a la cuenta que instala.
    const other = db._tables.accounts.find((r) => r.id === 'acc-2')
    expect(other?.default_currency).toBe('USD')
  })

  // ----------------------------------------------------------
  // Regla de moneda (Fase 1): una barbería colombiana cobra en COP,
  // y la cuenta nace en 'USD' (default de la migración 021). La
  // instalación ajusta la moneda SOLO mientras siga en ese default
  // intacto; una elección explícita del dueño nunca se pisa.
  // ----------------------------------------------------------
  it('fija COP cuando la cuenta sigue en la moneda por defecto', async () => {
    const db = fakeDb({
      accounts: [{ id: ACCOUNT, default_currency: 'USD' }],
    })

    const report = await install(db)

    expect(report.currency).toBe('set_cop')
    expect(db._tables.accounts[0].default_currency).toBe('COP')
  })

  it('la regla de moneda es idempotente: reinstalar ya no la toca', async () => {
    const db = fakeDb({
      accounts: [{ id: ACCOUNT, default_currency: 'USD' }],
    })

    await install(db)
    const second = await install(db)

    expect(second.currency).toBe('kept')
    expect(db._tables.accounts[0].default_currency).toBe('COP')
  })

  it('respeta la moneda que el dueño ya configuró explícitamente', async () => {
    const db = fakeDb({
      accounts: [{ id: ACCOUNT, default_currency: 'EUR' }],
    })

    const report = await install(db)

    expect(report.currency).toBe('kept')
    expect(db._tables.accounts[0].default_currency).toBe('EUR')
  })
})

// ------------------------------------------------------------
// Puntos de partida
// ------------------------------------------------------------
function installPreset(db: FakeDb, presetKey?: PresetKey) {
  return installAgendaTemplate({
    db: asClient(db),
    accountId: ACCOUNT,
    userId: USER,
    presetKey,
  })
}

const settingsOf = (db: FakeDb): Row => {
  const rows = (db._tables.booking_settings ?? []).filter((r) => r.account_id === ACCOUNT)
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('installAgendaTemplate con punto de partida', () => {
  it('salud instala sus servicios, palabras, punto de partida y su pregunta', async () => {
    const db = fakeDb()

    const report = await installPreset(db, 'salud')

    expect(report.presetKey).toBe('salud')
    expect(report.services).toEqual({ created: 3, skipped: 0 })
    expect(report.staff).toEqual({ created: 1, skipped: 0 })
    expect(report.workingHours).toEqual({ created: 10, skipped: 0 })
    expect(report.questions).toEqual({ created: 1, skipped: 0 })
    expect(db._tables.booking_services.map((r) => r.name)).toEqual([
      'Consulta general',
      'Control',
      'Procedimiento',
    ])
    expect(db._tables.booking_staff.map((r) => r.name)).toEqual(['Especialista 1'])
    // Nada de barbería: ni campos, ni respuestas rápidas, ni documentos.
    expect(db._tables.custom_fields ?? []).toHaveLength(0)
    expect(db._tables.quick_replies ?? []).toHaveLength(0)
    expect(db._tables.ai_knowledge_documents ?? []).toHaveLength(0)
    // Pero sí las etiquetas y el pipeline que usa el bot.
    expect(report.tags.created).toBe(6)
    expect(db._tables.pipelines.map((r) => r.name)).toEqual(['Agenda'])

    const settings = settingsOf(db)
    expect(settings.preset_key).toBe('salud')
    expect(settings.labels).toEqual(AGENDA_PRESETS.salud.labels)
    expect((settings.labels as { profesional: string }).profesional).toBe('especialista')
    expect(settings.choose_staff).toBe(true)
    expect((settings.bot_texts as { welcome: string }).welcome).toBe(AGENDA_PRESETS.salud.welcome)

    expect(db._tables.booking_questions).toEqual([
      expect.objectContaining({
        account_id: ACCOUNT,
        label: '¿Cuál es el motivo de la consulta?',
        kind: 'texto',
        required: false,
        options: [],
        position: 0,
        is_active: true,
      }),
    ])
  })

  it('sin presetKey usa el de la cuenta; sin ninguno, barbería', async () => {
    const withPreset = fakeDb({
      booking_settings: [{ account_id: ACCOUNT, preset_key: 'clases' }],
    })
    expect((await installPreset(withPreset)).presetKey).toBe('clases')
    expect(withPreset._tables.booking_services.map((r) => r.name)).toEqual([
      'Clase individual',
      'Clase de prueba',
    ])

    const invalid = fakeDb({
      booking_settings: [{ account_id: ACCOUNT, preset_key: 'tienda' }],
    })
    expect((await installPreset(invalid)).presetKey).toBe('barberia')

    const empty = fakeDb()
    expect((await installPreset(empty)).presetKey).toBe('barberia')
    expect(settingsOf(empty).preset_key).toBe('barberia')
    expect(settingsOf(empty).labels).toEqual(AGENDA_PRESETS.barberia.labels)
  })

  it('taller apaga elegir técnico y pide la placa como obligatoria', async () => {
    const db = fakeDb()

    await installPreset(db, 'taller')

    const settings = settingsOf(db)
    expect(settings.choose_staff).toBe(false)
    expect(settings.show_price).toBe(true)
    expect(db._tables.booking_questions).toEqual([
      expect.objectContaining({ label: 'Placa del vehículo', kind: 'texto', required: true }),
    ])
  })

  it('en blanco no instala servicios, equipo, horario ni preguntas, pero sí etiquetas y pipeline', async () => {
    const db = fakeDb()

    const report = await installPreset(db, 'blanco')

    expect(report.services).toEqual({ created: 0, skipped: 0 })
    expect(report.staff).toEqual({ created: 0, skipped: 0 })
    expect(report.staffServices).toEqual({ created: 0, skipped: 0 })
    expect(report.workingHours).toEqual({ created: 0, skipped: 0 })
    expect(report.questions).toEqual({ created: 0, skipped: 0 })
    expect(db._tables.booking_services ?? []).toHaveLength(0)
    expect(db._tables.booking_staff ?? []).toHaveLength(0)
    expect(db._tables.booking_working_hours ?? []).toHaveLength(0)
    expect(db._tables.booking_questions ?? []).toHaveLength(0)
    expect(report.tags.created).toBe(6)
    expect(report.pipeline).toEqual({ created: true, stagesCreated: 5 })
    expect(settingsOf(db).preset_key).toBe('blanco')
  })

  it('reinstalar con otro punto de partida agrega lo que falta sin borrar ni duplicar', async () => {
    const db = fakeDb()
    await installPreset(db, 'barberia')
    const before = {
      services: db._tables.booking_services.map((r) => r.id),
      staff: db._tables.booking_staff.map((r) => r.id),
      tags: db._tables.tags.length,
      pipelines: db._tables.pipelines.length,
    }

    const report = await installPreset(db, 'salud')

    // Los de barbería siguen; se suman los de salud.
    expect(report.services).toEqual({ created: 3, skipped: 0 })
    expect(db._tables.booking_services).toHaveLength(6)
    for (const id of before.services) {
      expect(db._tables.booking_services.some((r) => r.id === id)).toBe(true)
    }
    expect(db._tables.booking_staff.map((r) => r.id)).toEqual(
      expect.arrayContaining(before.staff),
    )
    expect(db._tables.booking_staff).toHaveLength(2)
    // Etiquetas y pipeline no se duplican.
    expect(report.tags).toEqual({ created: 0, skipped: 6 })
    expect(db._tables.tags).toHaveLength(before.tags)
    expect(report.pipeline).toEqual({ created: false, stagesCreated: 0 })
    expect(db._tables.pipelines).toHaveLength(before.pipelines)
    // Palabras y punto de partida pasan al nuevo.
    expect(settingsOf(db).preset_key).toBe('salud')
    expect(settingsOf(db).labels).toEqual(AGENDA_PRESETS.salud.labels)
  })

  it('no duplica las preguntas al reinstalar; otro punto de partida suma solo las que faltan', async () => {
    const db = fakeDb()
    await installPreset(db, 'taller')
    expect(db._tables.booking_questions).toHaveLength(1)

    const same = await installPreset(db, 'taller')
    expect(same.questions).toEqual({ created: 0, skipped: 1 })
    expect(db._tables.booking_questions).toHaveLength(1)

    const other = await installPreset(db, 'salud')
    expect(other.questions).toEqual({ created: 1, skipped: 0 })
    expect(db._tables.booking_questions.map((q) => [q.label, q.position])).toEqual([
      ['Placa del vehículo', 0],
      ['¿Cuál es el motivo de la consulta?', 1],
    ])

    // Volver a salud ya no agrega nada, ni vuelve a taller.
    await installPreset(db, 'salud')
    await installPreset(db, 'taller')
    expect(db._tables.booking_questions).toHaveLength(2)
  })

  it('una pregunta con la misma etiqueta no se repite, aunque esté desactivada o cambie la mayúscula', async () => {
    const db = fakeDb({
      booking_questions: [
        {
          id: 'q-vieja',
          account_id: ACCOUNT,
          label: '¿CUÁL ES EL MOTIVO DE LA CONSULTA?',
          is_active: false,
          position: 4,
        },
        // De otra cuenta: no cuenta.
        { id: 'q-ajena', account_id: 'acc-2', label: 'Ajena', is_active: true, position: 0 },
      ],
    })

    const report = await installPreset(db, 'salud')

    expect(report.questions).toEqual({ created: 0, skipped: 1 })
    expect(db._tables.booking_questions).toHaveLength(2)
  })

  it('agrega la pregunta del punto de partida después de las que ya tiene la cuenta', async () => {
    const db = fakeDb({
      booking_questions: [
        { id: 'q-1', account_id: ACCOUNT, label: 'Propia', is_active: true, position: 0 },
      ],
    })

    const report = await installPreset(db, 'taller')

    expect(report.questions).toEqual({ created: 1, skipped: 0 })
    expect(db._tables.booking_questions.map((q) => [q.label, q.position])).toEqual([
      ['Propia', 0],
      ['Placa del vehículo', 1],
    ])
  })

  it('no pasa del tope de preguntas activas', async () => {
    const db = fakeDb({
      booking_questions: Array.from({ length: 5 }, (_, i) => ({
        id: `q-${i}`,
        account_id: ACCOUNT,
        label: `Propia ${i}`,
        is_active: true,
        position: i,
      })),
    })

    const report = await installPreset(db, 'taller')

    expect(report.questions).toEqual({ created: 0, skipped: 1 })
    expect(db._tables.booking_questions).toHaveLength(5)
  })

  it('reaplicar el mismo punto de partida no revive lo que el dueño renombró o quitó', async () => {
    const db = fakeDb()
    await installPreset(db, 'salud')
    const hoursBefore = db._tables.booking_working_hours.length
    const pairsBefore = db._tables.booking_staff_services.length

    // El dueño renombra a la especialista y un servicio, y borra la pregunta.
    db._tables.booking_staff[0].name = 'Dra. Pérez'
    db._tables.booking_services.find((r) => r.name === 'Control')!.name = 'Control mensual'
    db._tables.booking_questions.length = 0

    const report = await installPreset(db, 'salud')

    expect(report.services).toEqual({ created: 0, skipped: 3 })
    expect(report.staff).toEqual({ created: 0, skipped: 1 })
    expect(report.staffServices).toEqual({ created: 0, skipped: 3 })
    expect(report.workingHours).toEqual({ created: 0, skipped: 10 })
    expect(report.questions).toEqual({ created: 0, skipped: 1 })
    expect(db._tables.booking_staff.map((r) => r.name)).toEqual(['Dra. Pérez'])
    expect(db._tables.booking_services.map((r) => r.name).sort()).toEqual([
      'Consulta general',
      'Control mensual',
      'Procedimiento',
    ])
    expect(db._tables.booking_working_hours).toHaveLength(hoursBefore)
    expect(db._tables.booking_staff_services).toHaveLength(pairsBefore)
    expect(db._tables.booking_questions).toHaveLength(0)
  })

  it('una cuenta con el punto de partida marcado pero vacía (barbería migrada) sí se siembra', async () => {
    const db = fakeDb({
      booking_settings: [{ account_id: ACCOUNT, preset_key: 'barberia' }],
    })

    const report = await installPreset(db)

    expect(report.services).toEqual({ created: 3, skipped: 0 })
    expect(report.staff).toEqual({ created: 1, skipped: 0 })
    expect(report.workingHours).toEqual({ created: 12, skipped: 0 })
  })

  it('al cambiar de punto de partida solo escribe las piezas de presentación', async () => {
    const db = fakeDb({
      booking_settings: [
        {
          account_id: ACCOUNT,
          preset_key: 'salud',
          reminders_enabled: false,
          allow_reschedule: false,
          show_price: true,
          show_duration: true,
        },
      ],
    })

    await installPreset(db, 'taller')

    const settings = settingsOf(db)
    expect(settings.preset_key).toBe('taller')
    expect(settings.choose_staff).toBe(false)
    expect(settings.show_price).toBe(true)
    expect(settings.show_duration).toBe(true)
    // Decisiones del dueño: nunca se tocan.
    expect(settings.reminders_enabled).toBe(false)
    expect(settings.allow_reschedule).toBe(false)
  })

  it('en blanco no guarda una bienvenida propia (usa la de siempre)', async () => {
    const db = fakeDb()
    await installPreset(db, 'blanco')
    expect(settingsOf(db).bot_texts).toEqual({})

    // Venir de otro punto de partida quita la bienvenida que ese dejó, no la del dueño.
    const db2 = fakeDb()
    await installPreset(db2, 'salud')
    await installPreset(db2, 'blanco')
    expect(settingsOf(db2).bot_texts).toEqual({})

    const db3 = fakeDb({
      booking_settings: [{ account_id: ACCOUNT, bot_texts: { welcome: 'Mi bienvenida' } }],
    })
    await installPreset(db3, 'blanco')
    expect(settingsOf(db3).bot_texts).toEqual({ welcome: 'Mi bienvenida' })
  })

  it('no pierde una bienvenida que el dueño guardó mientras corría la instalación', async () => {
    const db = fakeDb({
      booking_settings: [{ account_id: ACCOUNT, preset_key: null, bot_texts: {} }],
    })
    let wrote = false
    db._beforeOp = (op, table) => {
      // A mitad de la instalación otra sesión guarda su bienvenida.
      if (op === 'insert' && table === 'tags' && !wrote) {
        wrote = true
        settingsOf(db).bot_texts = { welcome: 'Escrita durante la instalación' }
      }
    }

    await installPreset(db, 'salud')

    expect(wrote).toBe(true)
    expect((settingsOf(db).bot_texts as { welcome: string }).welcome).toBe(
      'Escrita durante la instalación',
    )
  })

  it('si falla el guardado de ajustes, volver a correrla aplica las palabras sin duplicar nada', async () => {
    const db = fakeDb()
    db._failNext('upsert', 'booking_settings')

    await expect(installPreset(db, 'salud')).rejects.toMatchObject({ message: 'falló a propósito' })
    // El catálogo quedó sembrado, pero las palabras y el punto de partida no.
    expect(db._tables.booking_services).toHaveLength(3)
    expect(db._tables.booking_settings ?? []).toHaveLength(0)

    const report = await installPreset(db, 'salud')

    expect(report.services).toEqual({ created: 0, skipped: 3 })
    expect(report.staff).toEqual({ created: 0, skipped: 1 })
    expect(db._tables.booking_services).toHaveLength(3)
    expect(db._tables.booking_staff).toHaveLength(1)
    expect(db._tables.booking_questions).toHaveLength(1)
    expect(settingsOf(db).preset_key).toBe('salud')
    expect(settingsOf(db).labels).toEqual(AGENDA_PRESETS.salud.labels)
  })

  it('no pisa una bienvenida que el dueño ya escribió', async () => {
    const db = fakeDb({
      booking_settings: [
        {
          account_id: ACCOUNT,
          preset_key: null,
          bot_texts: { welcome: 'Hola, bienvenido a mi negocio', reminder: 'Te esperamos' },
        },
      ],
    })

    await installPreset(db, 'salud')

    expect(settingsOf(db).bot_texts).toEqual({
      welcome: 'Hola, bienvenido a mi negocio',
      reminder: 'Te esperamos',
    })
    // Lo demás del punto de partida sí se aplica.
    expect(settingsOf(db).preset_key).toBe('salud')
  })

  it('cambia la bienvenida que dejó otro punto de partida, no la del dueño', async () => {
    const db = fakeDb()
    await installPreset(db, 'barberia')
    expect((settingsOf(db).bot_texts as { welcome: string }).welcome).toBe(
      AGENDA_PRESETS.barberia.welcome,
    )

    await installPreset(db, 'salud')

    expect((settingsOf(db).bot_texts as { welcome: string }).welcome).toBe(
      AGENDA_PRESETS.salud.welcome,
    )
  })

  it('reinstalar el mismo punto de partida no pisa las palabras ni las piezas que editó el dueño', async () => {
    const db = fakeDb()
    await installPreset(db, 'salud')
    Object.assign(settingsOf(db), {
      labels: { ...AGENDA_PRESETS.salud.labels, profesional: 'doctora' },
      show_price: false,
      bot_texts: { welcome: 'Mi bienvenida' },
    })

    const report = await installPreset(db, 'salud')

    expect(report.services).toEqual({ created: 0, skipped: 3 })
    expect((settingsOf(db).labels as { profesional: string }).profesional).toBe('doctora')
    expect(settingsOf(db).show_price).toBe(false)
    expect(settingsOf(db).bot_texts).toEqual({ welcome: 'Mi bienvenida' })
  })

  it('escribe el prompt del punto de partida sin nombrar la barbería en los demás', async () => {
    const db = fakeDb({
      ai_configs: [{ id: 'ai-1', account_id: ACCOUNT, system_prompt: '' }],
    })

    await installPreset(db, 'taller')

    const prompt = String(db._tables.ai_configs[0].system_prompt)
    expect(prompt).toBe(AGENDA_PRESETS.taller.aiPrompt)
    expect(prompt.toLowerCase()).not.toContain('barber')
    expect(prompt.toLowerCase()).not.toContain('colombia')
  })

  it('no toca los ajustes de otras cuentas', async () => {
    const db = fakeDb({
      booking_settings: [
        { account_id: 'acc-2', preset_key: 'clases', labels: { profesional: 'profe' } },
      ],
    })

    await installPreset(db, 'salud')

    const other = db._tables.booking_settings.find((r) => r.account_id === 'acc-2')
    expect(other).toEqual({
      account_id: 'acc-2',
      preset_key: 'clases',
      labels: { profesional: 'profe' },
    })
  })

  it.each(Object.keys(AGENDA_PRESETS) as PresetKey[])(
    '%s se puede instalar dos veces sin duplicar nada',
    async (key) => {
      const db = fakeDb()
      await installPreset(db, key)
      const first = Object.fromEntries(
        Object.entries(db._tables).map(([t, rows]) => [t, rows.length]),
      )

      await installPreset(db, key)

      const second = Object.fromEntries(
        Object.entries(db._tables).map(([t, rows]) => [t, rows.length]),
      )
      expect(second).toEqual(first)
    },
  )
})
