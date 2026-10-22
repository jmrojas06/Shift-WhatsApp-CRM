import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'
import { DEFAULT_LABELS } from '@/verticals/agenda/labels'
import { DEFAULT_TOGGLES } from '@/verticals/agenda/toggles'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  type TestResponse,
} from '../_lib/route-testing'

// ============================================================
// PATCH /api/verticals/agenda/config — permisos, validación y
// escritura por partes contra el fake de PostgREST compartido.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import(
    '@/app/api/verticals/agenda/_lib/route-testing'
  )
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import(
    '@/app/api/verticals/agenda/_lib/route-testing'
  )
  return authMockModule(h.state)
})

import { PATCH } from './route'

function baseSeed(): Record<string, Row[]> {
  return {
    accounts: [
      {
        id: TEST_ACCOUNT,
        name: 'Barbería de prueba',
        default_currency: 'COP',
        owner_user_id: 'user-1',
      },
      {
        id: 'acc-2',
        name: 'Otra barbería',
        default_currency: 'EUR',
        owner_user_id: 'user-2',
      },
    ],
    booking_settings: [],
  }
}

function boot(seed?: Record<string, Row[]>) {
  const db = makeFakeDb(seed ?? baseSeed())
  h.state.db = db
  return db
}

beforeEach(() => {
  h.state.role = 'owner'
})

describe('PATCH /api/verticals/agenda/config', () => {
  it('guarda la dirección y devuelve los ajustes con defaults', async () => {
    const db = boot()

    const res = (await PATCH(
      jsonRequest({ address: 'Cra 7 # 45-12' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.settings).toEqual({
      address: 'Cra 7 # 45-12',
      reminders2hEnabled: false,
      botTexts: {},
      labels: DEFAULT_LABELS,
      toggles: DEFAULT_TOGGLES,
      presetKey: null,
    })
    expect(res.body.currency).toBeNull()
    expect(db._tables.booking_settings).toHaveLength(1)
  })

  it('activa la señal de 2 h y guarda textos sin pisar la dirección', async () => {
    const db = boot({
      ...baseSeed(),
      booking_settings: [
        {
          account_id: TEST_ACCOUNT,
          address: 'Calle 1 # 2-3',
          reminders_2h_enabled: false,
          bot_texts: {},
        },
      ],
    })

    const res = (await PATCH(
      jsonRequest({
        reminders_2h_enabled: true,
        bot_texts: { welcome: '¡Hola de Don Pedro! 💈' },
      }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.settings).toMatchObject({
      address: 'Calle 1 # 2-3',
      reminders2hEnabled: true,
      botTexts: { welcome: '¡Hola de Don Pedro! 💈' },
    })
    expect(db._tables.booking_settings).toHaveLength(1)
  })

  it('cambia la moneda de la cuenta y de nadie más', async () => {
    const db = boot()

    const res = (await PATCH(
      jsonRequest({ currency: 'usd' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.currency).toBe('USD')
    // Solo moneda: los ajustes del bot no se tocan ni se crean.
    expect(res.body.settings).toBeNull()
    expect(
      db._tables.accounts.find((a) => a.id === TEST_ACCOUNT)?.default_currency,
    ).toBe('USD')
    expect(
      db._tables.accounts.find((a) => a.id === 'acc-2')?.default_currency,
    ).toBe('EUR')
    expect(db._tables.booking_settings).toHaveLength(0)
  })

  it('400 con mensaje en es-CO para cada campo inválido', async () => {
    boot()
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'No hay cambios que guardar.'],
      [{ currency: 'US' }, 'La moneda debe ser un código ISO de 3 letras.'],
      [{ address: 42 }, 'La dirección debe ser texto.'],
      [{ reminders_2h_enabled: 'sí' }, 'La segunda señal debe ser sí o no.'],
    ]
    for (const [body, message] of cases) {
      const res = (await PATCH(jsonRequest(body))) as unknown as TestResponse
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(message)
    }
  })

  it('400 cuando un texto del bot no es texto', async () => {
    boot()
    const res = (await PATCH(
      jsonRequest({ bot_texts: { welcome: 42 } }),
    )) as unknown as TestResponse

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('debe ser texto')
  })

  it.each([[''], [null]])(
    'vaciar una palabra (%j) vuelve a su valor por defecto sin tocar las otras',
    async (empty) => {
      const db = boot({
        ...baseSeed(),
        booking_settings: [
          {
            account_id: TEST_ACCOUNT,
            labels: { profesional: 'doctor', cita: 'consulta' },
          },
        ],
      })

      const res = (await PATCH(
        jsonRequest({ labels: { profesional: empty } }),
      )) as unknown as TestResponse

      expect(res.status).toBe(200)
      expect(res.body.settings).toMatchObject({
        labels: { ...DEFAULT_LABELS, cita: 'consulta' },
      })
      expect(db._tables.booking_settings[0].labels).toEqual({ cita: 'consulta' })
    },
  )

  it('rechaza a agent y viewer con 403 sin escribir nada', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      const res = (await PATCH(
        jsonRequest({ address: 'X' }),
      )) as unknown as TestResponse
      expect(res.status).toBe(403)
    }
    expect(db._tables.booking_settings).toHaveLength(0)
  })

  it('el dueño apaga una pieza y la fila queda con esa columna en false', async () => {
    const db = boot()

    const res = (await PATCH(
      jsonRequest({ toggles: { choose_staff: false } }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.settings).toMatchObject({
      toggles: { ...DEFAULT_TOGGLES, chooseStaff: false },
    })
    expect(db._tables.booking_settings[0]).toMatchObject({
      account_id: TEST_ACCOUNT,
      choose_staff: false,
      show_price: true,
    })
  })

  it('un agent no puede cambiar piezas (403) y no se escribe nada', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = (await PATCH(
      jsonRequest({ toggles: { choose_staff: false } }),
    )) as unknown as TestResponse

    expect(res.status).toBe(403)
    expect(db._tables.booking_settings).toHaveLength(0)
  })

  it('400 para piezas que no son sí/no, palabras con marcas y tipos de negocio desconocidos', async () => {
    const db = boot()
    const bodies: Record<string, unknown>[] = [
      { toggles: { show_price: 'no' } },
      { labels: { cita: '*x*' } },
      { preset_key: 'tienda' },
    ]
    for (const body of bodies) {
      const res = (await PATCH(jsonRequest(body))) as unknown as TestResponse
      expect(res.status).toBe(400)
    }
    expect(db._tables.booking_settings).toHaveLength(0)
  })

  it('guarda palabras y tipo de negocio sin borrar dirección, textos ni piezas', async () => {
    const db = boot({
      ...baseSeed(),
      booking_settings: [
        {
          account_id: TEST_ACCOUNT,
          address: 'Calle 1 # 2-3',
          reminders_2h_enabled: false,
          bot_texts: { welcome: 'Hola' },
          choose_staff: false,
        },
      ],
    })

    const res = (await PATCH(
      jsonRequest({ labels: { profesional: 'doctor' }, preset_key: 'salud' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.settings).toMatchObject({
      address: 'Calle 1 # 2-3',
      botTexts: { welcome: 'Hola' },
      labels: { ...DEFAULT_LABELS, profesional: 'doctor' },
      toggles: { ...DEFAULT_TOGGLES, chooseStaff: false },
      presetKey: 'salud',
    })
    expect(db._tables.booking_settings).toHaveLength(1)
  })

  it('un cuerpo que no es JSON es 400, no 500', async () => {
    boot()
    const res = (await PATCH(brokenJsonRequest())) as unknown as TestResponse
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Los ajustes no son válidos.')
  })
})
