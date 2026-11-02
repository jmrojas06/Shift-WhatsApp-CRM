import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModuleKey, VerticalInboundContext } from '@/lib/verticals/types'

import { ACCOUNT, CONTACT, CONVERSATION, OWNER, clinicDb } from './testing/clinic-harness'
import { asClient } from './testing/fake-db'

const mocks = vi.hoisted(() => ({
  notifyAlert: vi.fn<(text: string) => Promise<void>>(async () => {}),
  sendText: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendButtons: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendList: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
}))

vi.mock('@/lib/ops/alert', () => ({ notifyAlert: mocks.notifyAlert }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: mocks.sendText,
  engineSendInteractiveButtons: mocks.sendButtons,
  engineSendInteractiveList: mocks.sendList,
}))

import { agendaInboundHandler } from './index'

/** Una base que se cae en cuanto el bot la toca. */
const brokenDb = {
  from() {
    throw new Error('base caída')
  },
} as unknown as SupabaseClient

function context(
  db: SupabaseClient,
  modules: readonly ModuleKey[] | undefined,
): VerticalInboundContext {
  return {
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    db,
    session: null,
    modules,
  }
}

describe('agendaInboundHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('en una cuenta con clínica, un error inesperado consume el mensaje y avisa', async () => {
    const result = await agendaInboundHandler(context(brokenDb, ['agenda', 'clinica']))

    // Consumido: la IA no ve el chat de un paciente cuando el bot falló.
    expect(result).toEqual({ consumed: true })
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    const text = mocks.notifyAlert.mock.calls[0][0]
    expect(text).toContain(ACCOUNT)
    expect(text).toContain(CONVERSATION)
    expect(text).toContain('base caída')
    expect(console.error).toHaveBeenCalled()
  })

  it('en una cuenta sin clínica, el error sigue subiendo como antes', async () => {
    await expect(agendaInboundHandler(context(brokenDb, ['agenda']))).rejects.toThrow('base caída')
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })

  it('si el contexto no trae módulos, tampoco se traga el error', async () => {
    await expect(agendaInboundHandler(context(brokenDb, undefined))).rejects.toThrow('base caída')
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })

  it('el aviso no lleva el teléfono ni el identificador de WhatsApp que traiga el error', async () => {
    // Un error de la base puede repetir la fila que no pudo guardar.
    const leaky = {
      from() {
        throw new Error(
          'duplicate key (573001112233) for +57 300 111 2233, user US.13491208655302741918, wa 3001112233',
        )
      },
    } as unknown as SupabaseClient
    await agendaInboundHandler(context(leaky, ['clinica']))
    const text = mocks.notifyAlert.mock.calls[0][0]
    expect(text).not.toMatch(/\d{4,}/)
    expect(text).not.toContain('300 111')
    expect(text).toContain('duplicate key')
    expect(text).toContain('#')
  })

  it('el aviso corta un error larguísimo', async () => {
    const long = {
      from() {
        throw new Error(`falló ${'x'.repeat(2000)}`)
      },
    } as unknown as SupabaseClient
    await agendaInboundHandler(context(long, ['clinica']))
    expect(mocks.notifyAlert.mock.calls[0][0].length).toBeLessThan(700)
  })

  it('sin fallos, devuelve lo que decide el bot y no avisa nada', async () => {
    // Una cuenta con clínica que aún no autorizó: el bot pide la autorización
    // por el envío real (aquí, el simulado del motor de flujos).
    const result = await agendaInboundHandler(
      context(asClient(clinicDb()), ['agenda', 'clinica']),
    )
    expect(result).toEqual({ consumed: true })
    expect(mocks.sendButtons).toHaveBeenCalledTimes(1)
    expect(mocks.sendButtons.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      bodyText: 'Texto de autorización',
    })
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------
// Candado por conversación (solo cuentas con clínica).
// ------------------------------------------------------------

describe('agendaInboundHandler — candado por conversación', () => {
  const BUSY = '2099-01-01T00:00:00.000Z'
  const NOW = new Date('2026-10-19T13:00:00.000Z')

  type Db = ReturnType<typeof clinicDb>

  const lockOf = (db: Db) => db._tables.conversations[0].bot_lock_until

  /** El mensaje que el webhook ya guardó; el bot lo lee por su id. */
  function withInbound(db: Db, text: string, replyId: string | null = null): Db {
    db._tables.messages.push({
      id: 'msg-in',
      conversation_id: CONVERSATION,
      message_id: 'wamid-in',
      content_text: text,
      interactive_reply_id: replyId,
      reply_to_message_id: null,
    })
    return db
  }

  const ctx = (db: Db, over: Partial<VerticalInboundContext> = {}): VerticalInboundContext => ({
    ...context(asClient(db), ['agenda', 'clinica']),
    inboundMessageId: 'wamid-in',
    ...over,
  })

  /** Corre el bot dejando pasar la espera del candado (5 s) sin esperar de verdad. */
  async function runWaiting(input: VerticalInboundContext) {
    const pending = agendaInboundHandler(input)
    await vi.advanceTimersByTimeAsync(6_000)
    return pending
  }

  const sentBodies = () =>
    mocks.sendButtons.mock.calls.map((call) => (call[0] as { bodyText: string }).bodyText)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('toma el candado mientras responde y lo suelta al terminar', async () => {
    const db = withInbound(clinicDb(), 'Hola')
    let heldWhileSending: unknown = null
    mocks.sendButtons.mockImplementationOnce(async () => {
      heldWhileSending = lockOf(db)
    })

    const result = await agendaInboundHandler(ctx(db))

    expect(result).toEqual({ consumed: true })
    expect(heldWhileSending).not.toBeNull()
    expect(lockOf(db)).toBeNull()
  })

  it('lo suelta aunque el bot falle, y el mensaje no llega a la IA', async () => {
    const db = withInbound(clinicDb(), 'Hola')
    mocks.sendButtons.mockRejectedValueOnce(new Error('Meta rechazó el envío'))

    const result = await agendaInboundHandler(ctx(db))

    expect(result).toEqual({ consumed: true })
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    expect(lockOf(db)).toBeNull()
  })

  it('un error al tomar el candado cae en el mismo cierre: consume y avisa', async () => {
    const db = withInbound(clinicDb(), 'Hola')
    db._failNext('update', 'conversations', { message: 'la base se cayó' })

    const result = await agendaInboundHandler(ctx(db))

    expect(result).toEqual({ consumed: true })
    expect(mocks.notifyAlert.mock.calls[0][0]).toContain('la base se cayó')
    expect(mocks.sendButtons).not.toHaveBeenCalled()
  })

  describe('después de tomar el candado se lee de nuevo lo que pudo cambiar', () => {
    it('la sesión: la que trajo el dispatcher pudo quedar vieja', async () => {
      // El dispatcher la vio abierta en el menú; mientras esperaba, la cerró otro mensaje.
      const stale = {
        id: 'se-vieja',
        state: { step: 'clinic_menu', mode: 'book', options: [], fails: 0 },
        expiresAt: '2026-10-19T13:30:00.000Z',
      }
      const db = withInbound(clinicDb(), 'Hola')

      await agendaInboundHandler(ctx(db, { session: stale }))

      // Sin sesión y sin autorización, lo que corresponde es pedir la autorización. Con
      // la sesión vieja habría vuelto a mostrar el menú.
      expect(sentBodies()).toEqual(['Texto de autorización'])
    })

    it('la sesión abierta mientras tanto: la del dispatcher era null', async () => {
      const db = withInbound(
        clinicDb({
          booking_sessions: [
            {
              id: 'se-nueva',
              account_id: ACCOUNT,
              contact_id: CONTACT,
              status: 'active',
              expires_at: '2026-10-19T13:30:00.000Z',
              state: {
                step: 'consent',
                mode: 'book',
                options: [
                  { id: 'act:consent_yes', title: 'Sí, acepto' },
                  { id: 'act:consent_no', title: 'No acepto' },
                ],
                fails: 0,
              },
            },
          ],
        }),
        'Hola',
      )

      await agendaInboundHandler(ctx(db, { session: null }))

      // Con la sesión de la base, "Hola" no responde a la autorización: se vuelve a
      // preguntar en ella, sin abrir otra sesión.
      expect(db._tables.booking_sessions).toHaveLength(1)
      expect(db._tables.booking_sessions[0]).toMatchObject({ id: 'se-nueva', status: 'active' })
      expect(db._tables.booking_sessions[0].state).toMatchObject({ step: 'consent', fails: 1 })
    })

    it('si una persona tomó el hilo mientras esperaba, el bot no contesta', async () => {
      const db = withInbound(clinicDb(), 'Hola')
      db._tables.conversations[0].ai_autoreply_disabled = true

      const result = await agendaInboundHandler(ctx(db, { humanOwned: false }))

      expect(result).toEqual({ consumed: false })
      expect(mocks.sendButtons).not.toHaveBeenCalled()
      expect(mocks.sendText).not.toHaveBeenCalled()
    })
  })

  describe('si el candado sigue ocupado', () => {
    it('un mensaje normal se consume sin responder y el candado sigue siendo del otro', async () => {
      const db = withInbound(clinicDb(), 'quiero una cita')
      db._tables.conversations[0].bot_lock_until = BUSY

      const result = await runWaiting(ctx(db))

      expect(result).toEqual({ consumed: true })
      expect(mocks.sendButtons).not.toHaveBeenCalled()
      expect(mocks.sendText).not.toHaveBeenCalled()
      expect(lockOf(db)).toBe(BUSY)
    })

    it.each([
      ['una palabra de la clínica', 'tengo mucho dolor'],
      ['una palabra del piso fijo', 'no puedo respirar bien'],
    ])('%s se procesa igual, sin soltar el candado de otro', async (_label, text) => {
      const db = withInbound(clinicDb(), text)
      db._tables.conversations[0].bot_lock_until = BUSY

      const result = await runWaiting(ctx(db))

      expect(result).toEqual({ consumed: true })
      // Los signos de alarma salen aunque el candado sea de otro.
      expect(sentBodies().some((body) => body.includes('Signos de alarma'))).toBe(true)
      expect(lockOf(db)).toBe(BUSY)
    })

    it('el toque de "Tengo una urgencia" también', async () => {
      const db = withInbound(clinicDb(), '', 'act:urgent')
      db._tables.conversations[0].bot_lock_until = BUSY

      await runWaiting(ctx(db))

      expect(sentBodies().some((body) => body.includes('Signos de alarma'))).toBe(true)
      expect(lockOf(db)).toBe(BUSY)
    })

    it('si la configuración de la clínica no se puede leer, valen las palabras de siempre', async () => {
      const db = withInbound(clinicDb({ clinic_settings: [] }), 'me duele mucho una muela')
      db._tables.conversations[0].bot_lock_until = BUSY

      const result = await runWaiting(ctx(db))

      // Sin configuración el bot no atiende, pero el aviso prioritario al equipo sale.
      expect(result).toEqual({ consumed: true })
      expect(db._tables.notifications.length).toBeGreaterThan(0)
      expect(lockOf(db)).toBe(BUSY)
    })

    it('un mensaje que no se encuentra no se da por urgente', async () => {
      const db = clinicDb() // sin el mensaje guardado
      db._tables.conversations[0].bot_lock_until = BUSY

      const result = await runWaiting(ctx(db))

      expect(result).toEqual({ consumed: true })
      expect(mocks.sendButtons).not.toHaveBeenCalled()
    })

    it('si el mensaje no se puede leer por un error, falla cerrado y avisa', async () => {
      const db = withInbound(clinicDb(), 'tengo mucho dolor')
      db._tables.conversations[0].bot_lock_until = BUSY
      db._failNext('select', 'messages', { message: 'la base se cayó' })

      const result = await runWaiting(ctx(db))

      expect(result).toEqual({ consumed: true })
      expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    })
  })

  describe('una cuenta sin clínica', () => {
    it('no toma ni espera el candado: sigue igual que siempre', async () => {
      const db = withInbound(clinicDb(), 'Hola')
      db._tables.conversations[0].bot_lock_until = BUSY

      // Sin temporizadores que avanzar: si esperara el candado, esto no terminaría.
      const result = await agendaInboundHandler(ctx(db, { modules: ['agenda'] }))

      expect(result).toEqual({ consumed: true })
      expect(mocks.sendList.mock.calls.length + mocks.sendButtons.mock.calls.length).toBeGreaterThan(0)
      expect(lockOf(db)).toBe(BUSY)
    })

    it('tampoco lo toma si no trae módulos', async () => {
      const db = withInbound(clinicDb(), 'Hola')

      await agendaInboundHandler(ctx(db, { modules: undefined }))

      expect(lockOf(db)).toBeNull()
    })

    it('no vuelve a leer la sesión: usa la que trajo el dispatcher', async () => {
      const db = withInbound(clinicDb(), 'Hola')
      const stale = {
        id: 'se-vieja',
        state: { step: 'pick_service', mode: 'book', options: [], fails: 0 },
        expiresAt: '2026-10-19T13:30:00.000Z',
      }

      await agendaInboundHandler(ctx(db, { modules: ['agenda'], session: stale }))

      // La sesión del dispatcher se atendió tal cual (aunque ya no exista en la base).
      expect(db._tables.booking_sessions).toHaveLength(0)
      expect(mocks.sendText.mock.calls.length + mocks.sendList.mock.calls.length + mocks.sendButtons.mock.calls.length).toBeGreaterThan(0)
    })
  })
})
