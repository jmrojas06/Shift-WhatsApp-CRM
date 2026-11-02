import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { acquireBotLock, withBotLock } from './bot-lock'
import { asClient, makeFakeDb } from './testing/fake-db'

const ACCOUNT = 'acc-1'
const CONVERSATION = 'cv-1'
const NOW = new Date('2026-10-19T13:00:00.000Z')
/** Un candado que nadie suelta mientras dura la prueba. */
const FAR_FUTURE = '2099-01-01T00:00:00.000Z'

const seed = (lockedUntil: string | null = null) =>
  makeFakeDb({
    conversations: [
      { id: CONVERSATION, account_id: ACCOUNT, bot_lock_until: lockedUntil },
      { id: 'cv-2', account_id: ACCOUNT, bot_lock_until: null },
      // Misma conversación en OTRA cuenta: el candado se acota por cuenta.
      { id: CONVERSATION, account_id: 'acc-2', bot_lock_until: null },
    ],
  })

const args = { accountId: ACCOUNT, conversationId: CONVERSATION }
const lockOf = (fake: ReturnType<typeof seed>, index = 0) => fake._tables.conversations[index].bot_lock_until

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('acquireBotLock', () => {
  it('solo gana uno', async () => {
    const db = asClient(seed())
    expect(await acquireBotLock(db, { ...args, now: NOW })).toBeTruthy()
    expect(await acquireBotLock(db, { ...args, now: NOW })).toBeNull()
  })

  it('un candado vencido se puede tomar', async () => {
    const db = asClient(seed('2026-10-19T12:59:00.000Z'))
    expect(await acquireBotLock(db, { ...args, now: NOW })).toBeTruthy()
  })

  it('dura 30 segundos', async () => {
    const fake = seed()
    await acquireBotLock(asClient(fake), { ...args, now: NOW })
    expect(lockOf(fake)).toBe('2026-10-19T13:00:30.000Z')
  })

  it('es de esa conversación y de esa cuenta', async () => {
    const fake = seed()
    await acquireBotLock(asClient(fake), { ...args, now: NOW })
    expect(lockOf(fake, 1)).toBeNull()
    expect(lockOf(fake, 2)).toBeNull()
  })

  it('un error de la base lanza: no se confunde con un candado ocupado', async () => {
    const fake = seed()
    fake._failNext('update', 'conversations', { message: 'la base se cayó' })
    await expect(acquireBotLock(asClient(fake), { ...args, now: NOW })).rejects.toThrow(
      'la base se cayó',
    )
  })
})

describe('withBotLock', () => {
  it('corre el trabajo con el candado puesto y lo suelta al terminar', async () => {
    const fake = seed()
    let heldDuringWork: unknown = null
    const result = await withBotLock(asClient(fake), args, async () => {
      heldDuringWork = lockOf(fake)
      return { consumed: false }
    })
    expect(result).toEqual({ consumed: false })
    expect(heldDuringWork).not.toBeNull()
    expect(lockOf(fake)).toBeNull()
  })

  it('suelta el candado aunque el trabajo falle', async () => {
    const fake = seed()
    await expect(
      withBotLock(asClient(fake), args, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(lockOf(fake)).toBeNull()
  })

  it('si no consigue el candado no ejecuta el trabajo y consume el mensaje', async () => {
    const fake = seed(FAR_FUTURE)
    const work = vi.fn(async () => ({ consumed: false }))
    const result = await withBotLock(asClient(fake), args, work, { waitMs: 0 })
    expect(result).toEqual({ consumed: true })
    expect(work).not.toHaveBeenCalled()
    // El candado es de otro: ni se toca ni se suelta.
    expect(lockOf(fake)).toBe(FAR_FUTURE)
  })

  it('espera a que se libere', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // Vence 2 s después: dentro de los 5 s de espera.
    const fake = seed('2026-10-19T13:00:02.000Z')
    const work = vi.fn(async () => ({ consumed: false }))

    const pending = withBotLock(asClient(fake), args, work)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(await pending).toEqual({ consumed: false })
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('no espera para siempre', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const fake = seed(FAR_FUTURE)
    const work = vi.fn(async () => ({ consumed: false }))

    const pending = withBotLock(asClient(fake), args, work)
    await vi.advanceTimersByTimeAsync(6_000)

    expect(await pending).toEqual({ consumed: true })
    expect(work).not.toHaveBeenCalled()
  })

  it('si el trabajo tardó más que el candado, no suelta el de quien lo tomó después', async () => {
    const fake = seed()
    await withBotLock(asClient(fake), args, async () => {
      // El candado venció y otro mensaje lo tomó mientras este trabajo seguía.
      fake._tables.conversations[0].bot_lock_until = FAR_FUTURE
      return { consumed: true }
    })
    expect(lockOf(fake)).toBe(FAR_FUTURE)
  })

  it('un error de la base al tomarlo lanza, sin ejecutar el trabajo', async () => {
    const fake = seed()
    fake._failNext('update', 'conversations', { message: 'la base se cayó' })
    const work = vi.fn(async () => ({ consumed: false }))
    await expect(withBotLock(asClient(fake), args, work)).rejects.toThrow('la base se cayó')
    expect(work).not.toHaveBeenCalled()
  })

  describe('sin el candado, un mensaje urgente no se pierde', () => {
    it('lo procesa igual, y el candado sigue siendo del otro', async () => {
      const fake = seed(FAR_FUTURE)
      const work = vi.fn(async () => ({ consumed: true }))
      const result = await withBotLock(asClient(fake), args, work, {
        waitMs: 0,
        runWithoutLockWhen: async () => true,
      })
      expect(result).toEqual({ consumed: true })
      expect(work).toHaveBeenCalledTimes(1)
      expect(lockOf(fake)).toBe(FAR_FUTURE)
    })

    it('si no es urgente, se consume sin responder como siempre', async () => {
      const fake = seed(FAR_FUTURE)
      const work = vi.fn(async () => ({ consumed: false }))
      const result = await withBotLock(asClient(fake), args, work, {
        waitMs: 0,
        runWithoutLockWhen: async () => false,
      })
      expect(result).toEqual({ consumed: true })
      expect(work).not.toHaveBeenCalled()
    })

    it('solo pregunta si es urgente cuando no consiguió el candado', async () => {
      const urgent = vi.fn(async () => true)
      await withBotLock(asClient(seed()), args, async () => ({ consumed: false }), {
        runWithoutLockWhen: urgent,
      })
      expect(urgent).not.toHaveBeenCalled()
    })

    it('si no se puede saber, lanza (y quien llama no pasa el mensaje a la IA)', async () => {
      const fake = seed(FAR_FUTURE)
      await expect(
        withBotLock(asClient(fake), args, async () => ({ consumed: false }), {
          waitMs: 0,
          runWithoutLockWhen: async () => {
            throw new Error('no se pudo leer')
          },
        }),
      ).rejects.toThrow('no se pudo leer')
    })
  })
})
