import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  type TestResponse,
} from '../_lib/route-testing'

// ============================================================
// GET / PATCH /api/verticals/agenda/call-settings: permisos, validación,
// campos de Shift, uso del mes y variables de Telnyx, contra el fake de
// PostgREST compartido (con un `count` agregado para la consulta del uso).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

import { GET, PATCH } from './route'

type QueryResult = { data: unknown; error: unknown; count?: number }

interface QueryBuilder {
  select: (...args: unknown[]) => unknown
  then: (resolve: (value: QueryResult) => unknown) => unknown
}

/** Como PostgREST con `{ count: 'exact', head: true }`: devuelve `count` y no filas. */
function withExactCount(db: FakeDb): FakeDb {
  return {
    ...db,
    from(table: string) {
      const builder = db.from(table) as QueryBuilder
      let head = false
      const select = builder.select
      const then = builder.then
      builder.select = (...args: unknown[]) => {
        const options = args[1] as { head?: boolean } | undefined
        if (options?.head) head = true
        return select.call(builder)
      }
      builder.then = (resolve) =>
        then.call(builder, (result: QueryResult) =>
          resolve(
            head
              ? {
                  data: null,
                  error: result.error,
                  count: Array.isArray(result.data) ? result.data.length : 0,
                }
              : result,
          ),
        )
      return builder
    },
  }
}

const TELNYX_ENV = {
  TELNYX_API_KEY: 'KEY-super-secreta-123',
  TELNYX_ACCOUNT_SID: 'SID-secreto-456',
  TELNYX_TEXML_APP_ID: 'APP-secreto-789',
  TELNYX_PUBLIC_KEY: 'PUB-secreto-000',
  VOICE_WEBHOOK_SECRET: 'WEBHOOK-secreto-111',
  NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
}

function setTelnyx(on: boolean) {
  for (const [name, value] of Object.entries(TELNYX_ENV)) vi.stubEnv(name, on ? value : '')
}

function call(overrides: Row = {}): Row {
  return {
    account_id: TEST_ACCOUNT,
    direction: 'outbound',
    channel: 'robot',
    created_at: '2026-11-04T15:00:00.000Z',
    ...overrides,
  }
}

function settingsRow(overrides: Row = {}): Row {
  return {
    account_id: TEST_ACCOUNT,
    provider: 'telnyx',
    outbound_enabled: false,
    inbound_enabled: false,
    inbound_number: null,
    caller_id: null,
    advisor_phones: [],
    office_hours: {},
    info_text: null,
    call_after_minutes: 180,
    min_lead_minutes: 120,
    max_attempts: 2,
    retry_minutes: 90,
    window_start: '08:00',
    window_end: '19:00',
    call_saturday: true,
    monthly_limit: 300,
    voice: null,
    ...overrides,
  }
}

function boot(seed: Record<string, Row[]> = {}) {
  const db = makeFakeDb({ booking_call_settings: [], booking_calls: [], ...seed })
  h.state.db = withExactCount(db)
  return db
}

const body = async (res: Promise<unknown>) => (await res) as unknown as TestResponse

beforeEach(() => {
  h.state.role = 'owner'
  setTelnyx(false)
  // El uso del mes se cuenta con la hora actual: noviembre de 2026.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T15:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('GET /api/verticals/agenda/call-settings', () => {
  it('cualquier miembro puede leer, también quien solo mira', async () => {
    h.state.role = 'viewer'
    boot()

    const res = await body(GET())

    expect(res.status).toBe(200)
  })

  it('sin fila devuelve los valores por defecto, todo apagado', async () => {
    boot()

    const res = await body(GET())

    expect(res.status).toBe(200)
    expect(res.body.settings).toEqual({
      outbound_enabled: false,
      inbound_enabled: false,
      inbound_number: null,
      caller_id: null,
      advisor_phones: [],
      office_hours: {},
      info_text: '',
      call_after_minutes: 180,
      min_lead_minutes: 120,
      max_attempts: 2,
      retry_minutes: 90,
      window_start: '08:00',
      window_end: '19:00',
      call_saturday: true,
      monthly_limit: 300,
    })
    expect(res.body.usage).toEqual({ month: '2026-11', used: 0 })
  })

  it('devuelve lo guardado, incluidos los campos que fija Shift', async () => {
    boot({
      booking_call_settings: [
        settingsRow({
          outbound_enabled: true,
          inbound_number: '+576015550100',
          caller_id: '+576015550101',
          advisor_phones: ['+573001234567'],
          office_hours: { '1': [['08:00', '18:00']] },
          info_text: 'Calle 10 # 5-20',
          monthly_limit: 900,
        }),
      ],
    })

    const res = await body(GET())

    expect(res.body.settings).toMatchObject({
      outbound_enabled: true,
      inbound_number: '+576015550100',
      caller_id: '+576015550101',
      advisor_phones: ['+573001234567'],
      office_hours: { '1': [['08:00', '18:00']] },
      info_text: 'Calle 10 # 5-20',
      monthly_limit: 900,
    })
  })

  it('cuenta solo las salientes del robot de esta cuenta en el mes de Bogotá', async () => {
    boot({
      booking_calls: [
        call(),
        call({ created_at: '2026-11-01T05:00:00.000Z' }), // primer instante del mes
        call({ created_at: '2026-11-05T14:59:00.000Z', status: 'failed' }), // cualquier estado cuenta
        call({ created_at: '2026-11-01T04:59:59.000Z' }), // 31 oct 23:59 en Bogotá
        call({ created_at: '2026-12-01T05:00:00.000Z' }), // ya es diciembre
        call({ direction: 'inbound', channel: 'robot' }),
        call({ channel: 'manual' }),
        call({ account_id: 'acc-2' }),
      ],
    })

    const res = await body(GET())

    expect(res.body.usage).toEqual({ month: '2026-11', used: 3 })
  })

  it('dice si Telnyx está configurado, sin exponer ningún valor', async () => {
    boot()
    expect((await body(GET())).body.telnyx).toEqual({ configured: false })

    setTelnyx(true)
    const res = await body(GET())

    expect(res.body.telnyx).toEqual({ configured: true })
    const text = JSON.stringify(res.body)
    for (const value of Object.values(TELNYX_ENV)) expect(text).not.toContain(value)
  })

  it('con una sola variable de Telnyx faltante sigue sin estar configurado', async () => {
    boot()
    setTelnyx(true)
    vi.stubEnv('TELNYX_PUBLIC_KEY', '')

    const res = await body(GET())

    expect(res.body.telnyx).toEqual({ configured: false })
  })

  it('si la base falla responde 500 genérico, no "sin configurar"', async () => {
    const db = boot()
    db._failNext('select', 'booking_call_settings', { message: 'boom' })

    const res = await body(GET())

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Error interno.' })
  })
})

describe('PATCH /api/verticals/agenda/call-settings: permisos y cuerpo', () => {
  it.each(['viewer', 'agent'] as const)('%s no puede guardar (403) y no se escribe nada', async (role) => {
    h.state.role = role
    const db = boot()

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.status).toBe(403)
    expect(db._tables.booking_call_settings).toHaveLength(0)
  })

  it.each(['admin', 'owner'] as const)('%s puede guardar', async (role) => {
    h.state.role = role
    boot()

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.status).toBe(200)
  })

  it('un cuerpo que no es JSON responde 400', async () => {
    boot()

    const res = await body(PATCH(brokenJsonRequest()))

    expect(res.status).toBe(400)
  })

  it('un cuerpo vacío responde 400 (no hay cambios)', async () => {
    boot()

    const res = await body(PATCH(jsonRequest({})))

    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('No hay cambios')
  })

  it('una clave desconocida responde 400', async () => {
    boot()

    const res = await body(PATCH(jsonRequest({ outbound_enable: true })))

    expect(res.status).toBe(400)
  })

  it.each([
    [{ max_attempts: 9 }],
    [{ advisor_phones: ['3001234567'] }],
    [{ advisor_phones: ['+573001234567', '+573001234568', '+573001234569', '+573001234560'] }],
    [{ info_text: 'x'.repeat(501) }],
    [{ window_start: '25:00' }],
    [{ window_start: '20:00', window_end: '08:00' }],
    [{ office_hours: { '1': [['18:00', '08:00']] } }],
    [{ call_saturday: 'si' }],
  ])('rechaza valores inválidos (%j) con 400 y sin escribir', async (patch) => {
    const db = boot()

    const res = await body(PATCH(jsonRequest(patch)))

    expect(res.status).toBe(400)
    expect(typeof res.body.error).toBe('string')
    expect(db._tables.booking_call_settings).toHaveLength(0)
  })
})

describe('PATCH: lo que controla Shift no se cambia desde el panel', () => {
  it.each([
    ['provider', 'telnyx'],
    ['monthly_limit', 5000],
    ['inbound_number', '+576015550100'],
    ['caller_id', '+576015550101'],
  ])('%s se rechaza con 400 aunque el resto sea válido', async (key, value) => {
    const db = boot({ booking_call_settings: [settingsRow({ monthly_limit: 300 })] })

    const res = await body(PATCH(jsonRequest({ call_saturday: false, [key]: value })))

    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('Shift')
    // Ni siquiera lo válido se guardó: el parche entero se rechaza.
    expect(db._tables.booking_call_settings[0].call_saturday).toBe(true)
  })

  it('mandar el mismo valor guardado también se rechaza', async () => {
    boot({ booking_call_settings: [settingsRow({ monthly_limit: 300 })] })

    const res = await body(PATCH(jsonRequest({ monthly_limit: 300 })))

    expect(res.status).toBe(400)
  })

  it('al guardar, las columnas de Shift de la fila quedan intactas', async () => {
    const db = boot({
      booking_call_settings: [
        settingsRow({ monthly_limit: 900, inbound_number: '+576015550100', caller_id: '+576015550101' }),
      ],
    })

    const res = await body(PATCH(jsonRequest({ info_text: 'Abrimos de lunes a sábado' })))

    expect(res.status).toBe(200)
    expect(db._tables.booking_call_settings[0]).toMatchObject({
      monthly_limit: 900,
      inbound_number: '+576015550100',
      caller_id: '+576015550101',
      info_text: 'Abrimos de lunes a sábado',
    })
    expect(res.body.settings).toMatchObject({ monthly_limit: 900, inbound_number: '+576015550100' })
  })
})

describe('PATCH: guardar', () => {
  it('crea la fila de la cuenta si no existe, solo con lo que se mandó', async () => {
    const db = boot()

    const res = await body(
      PATCH(
        jsonRequest({
          advisor_phones: ['+57 300 123 4567'],
          office_hours: { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
          info_text: '  Calle 10 # 5-20  ',
          max_attempts: 3,
          retry_minutes: 60,
          call_saturday: false,
        }),
      ),
    )

    expect(res.status).toBe(200)
    expect(db._tables.booking_call_settings).toHaveLength(1)
    expect(db._tables.booking_call_settings[0]).toEqual({
      account_id: TEST_ACCOUNT,
      advisor_phones: ['+573001234567'],
      office_hours: { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
      info_text: 'Calle 10 # 5-20',
      max_attempts: 3,
      retry_minutes: 60,
      call_saturday: false,
    })
    expect(res.body.settings).toMatchObject({
      advisor_phones: ['+573001234567'],
      info_text: 'Calle 10 # 5-20',
      max_attempts: 3,
      call_saturday: false,
    })
  })

  it('un guardado parcial no toca el resto de la fila', async () => {
    const db = boot({
      booking_call_settings: [settingsRow({ advisor_phones: ['+573001234567'], max_attempts: 3 })],
    })

    await body(PATCH(jsonRequest({ retry_minutes: 45 })))

    expect(db._tables.booking_call_settings).toHaveLength(1)
    expect(db._tables.booking_call_settings[0]).toMatchObject({
      advisor_phones: ['+573001234567'],
      max_attempts: 3,
      retry_minutes: 45,
    })
  })

  it('un texto de horario vacío se guarda como nulo y vuelve vacío', async () => {
    const db = boot({ booking_call_settings: [settingsRow({ info_text: 'Antes' })] })

    const res = await body(PATCH(jsonRequest({ info_text: '   ' })))

    expect(db._tables.booking_call_settings[0].info_text).toBeNull()
    expect((res.body.settings as { info_text: string }).info_text).toBe('')
  })

  it('no toca las filas de otras cuentas', async () => {
    const db = boot({
      booking_call_settings: [settingsRow({ account_id: 'acc-2', max_attempts: 1 })],
    })

    await body(PATCH(jsonRequest({ max_attempts: 3 })))

    expect(db._tables.booking_call_settings).toHaveLength(2)
    expect(db._tables.booking_call_settings.find((r) => r.account_id === 'acc-2')?.max_attempts).toBe(1)
  })

  it('responde con el uso del mes y el estado de Telnyx, igual que el GET', async () => {
    boot({ booking_calls: [call(), call()] })
    setTelnyx(true)

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.body.usage).toEqual({ month: '2026-11', used: 2 })
    expect(res.body.telnyx).toEqual({ configured: true })
  })

  it('si ya se guardó y falla leer el uso del mes, responde que se guardó, con el uso nulo', async () => {
    const db = boot({ booking_call_settings: [settingsRow()] })
    db._failNext('select', 'booking_calls', { message: 'canceling statement due to statement timeout' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    setTelnyx(true)

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.status).toBe(200)
    expect(res.body.usage).toBeNull()
    expect((res.body.settings as Row).call_saturday).toBe(false)
    expect(res.body.telnyx).toEqual({ configured: true })
    expect(db._tables.booking_call_settings[0].call_saturday).toBe(false)
    // Queda el rastro del fallo, sin datos de nadie.
    expect(consoleError).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('si falla guardar sigue siendo un error (el cambio no se guardó)', async () => {
    const db = boot({ booking_call_settings: [settingsRow()] })
    db._failNext('upsert', 'booking_call_settings', { code: 'XX000', message: 'boom' })

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.status).toBe(500)
    expect(db._tables.booking_call_settings[0].call_saturday).toBe(true)
  })

  it('si la base rechaza por permisos (42501) lo explica sin un 500', async () => {
    const db = boot()
    db._failNext('upsert', 'booking_call_settings', {
      code: '42501',
      message: 'booking_call_settings.provider, monthly_limit … are set by Shift',
    })

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.status).toBe(403)
    expect(String(res.body.error)).toContain('Shift')
  })

  it('cualquier otro fallo de la base es un 500 genérico', async () => {
    const db = boot()
    db._failNext('upsert', 'booking_call_settings', { code: 'XX000', message: 'boom' })

    const res = await body(PATCH(jsonRequest({ call_saturday: false })))

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Error interno.' })
  })
})

describe('PATCH: la ventana de llamadas se revisa contra lo guardado', () => {
  it('solo la hora de inicio, posterior al fin guardado, responde 400', async () => {
    const db = boot({ booking_call_settings: [settingsRow({ window_end: '19:00' })] })

    const res = await body(PATCH(jsonRequest({ window_start: '20:00' })))

    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('19:00')
    expect(db._tables.booking_call_settings[0].window_start).toBe('08:00')
  })

  it('solo la hora de fin, anterior al inicio guardado, responde 400', async () => {
    boot({ booking_call_settings: [settingsRow({ window_start: '08:00' })] })

    const res = await body(PATCH(jsonRequest({ window_end: '07:00' })))

    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('08:00')
  })

  it('un cambio de un solo lado válido guarda las dos horas juntas', async () => {
    const db = boot({
      booking_call_settings: [settingsRow({ window_start: '08:00', window_end: '19:00' })],
    })

    const res = await body(PATCH(jsonRequest({ window_start: '09:30' })))

    expect(res.status).toBe(200)
    // Se escriben las dos para que la fila propuesta del upsert cumpla el CHECK de la base.
    expect(db._tables.booking_call_settings[0]).toMatchObject({
      window_start: '09:30',
      window_end: '19:00',
    })
  })

  it('sin fila guardada, usa la ventana por defecto como base', async () => {
    boot()

    const res = await body(PATCH(jsonRequest({ window_end: '07:00' })))

    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('08:00')
  })
})

describe('PATCH: prender las llamadas', () => {
  it('sin las variables de Telnyx deja guardar el resto pero no prender las salientes', async () => {
    const db = boot({ booking_call_settings: [settingsRow({ caller_id: '+576015550101' })] })

    const blocked = await body(PATCH(jsonRequest({ outbound_enabled: true, call_saturday: false })))
    expect(blocked.status).toBe(409)
    expect(String(blocked.body.error)).toContain('Shift')
    expect(db._tables.booking_call_settings[0]).toMatchObject({
      outbound_enabled: false,
      call_saturday: true,
    })

    const saved = await body(PATCH(jsonRequest({ call_saturday: false })))
    expect(saved.status).toBe(200)
  })

  it('sin Telnyx tampoco deja prender las entrantes', async () => {
    boot({ booking_call_settings: [settingsRow({ inbound_number: '+576015550100' })] })

    const res = await body(PATCH(jsonRequest({ inbound_enabled: true })))

    expect(res.status).toBe(409)
  })

  it('apagar siempre se puede, aunque falte Telnyx', async () => {
    const db = boot({
      booking_call_settings: [settingsRow({ outbound_enabled: true, inbound_enabled: true })],
    })

    const res = await body(PATCH(jsonRequest({ outbound_enabled: false, inbound_enabled: false })))

    expect(res.status).toBe(200)
    expect(db._tables.booking_call_settings[0]).toMatchObject({
      outbound_enabled: false,
      inbound_enabled: false,
    })
  })

  it('mandar "prendido" cuando ya estaba prendido no es prender', async () => {
    boot({
      booking_call_settings: [settingsRow({ outbound_enabled: true, caller_id: '+576015550101' })],
    })

    const res = await body(PATCH(jsonRequest({ outbound_enabled: true, call_saturday: false })))

    expect(res.status).toBe(200)
  })

  it('con Telnyx pero sin número que marque, no deja prender las salientes', async () => {
    setTelnyx(true)
    boot({ booking_call_settings: [settingsRow()] })

    const res = await body(PATCH(jsonRequest({ outbound_enabled: true })))

    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('número')
  })

  it('con Telnyx pero sin número de entrada, no deja prender las entrantes', async () => {
    setTelnyx(true)
    boot({ booking_call_settings: [settingsRow({ caller_id: '+576015550101' })] })

    const res = await body(PATCH(jsonRequest({ inbound_enabled: true })))

    expect(res.status).toBe(409)
  })

  it('las salientes salen con el número de entrada si no hay otro que marque', async () => {
    setTelnyx(true)
    const db = boot({ booking_call_settings: [settingsRow({ inbound_number: '+576015550100' })] })

    const res = await body(PATCH(jsonRequest({ outbound_enabled: true })))

    expect(res.status).toBe(200)
    expect(db._tables.booking_call_settings[0].outbound_enabled).toBe(true)
  })

  it('con Telnyx y número, prende las dos', async () => {
    setTelnyx(true)
    const db = boot({ booking_call_settings: [settingsRow({ inbound_number: '+576015550100' })] })

    const res = await body(PATCH(jsonRequest({ outbound_enabled: true, inbound_enabled: true })))

    expect(res.status).toBe(200)
    expect(db._tables.booking_call_settings[0]).toMatchObject({
      outbound_enabled: true,
      inbound_enabled: true,
    })
  })

  it('sin fila guardada no hay número: no deja prender', async () => {
    setTelnyx(true)
    const db = boot()

    const res = await body(PATCH(jsonRequest({ outbound_enabled: true })))

    expect(res.status).toBe(409)
    expect(db._tables.booking_call_settings).toHaveLength(0)
  })
})
