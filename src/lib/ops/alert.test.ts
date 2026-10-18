import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyAlert } from './alert'

// ============================================================
// Tests de notifyAlert (Fase 5).
//
// Contrato: no-op sin ALERT_WEBHOOK_URL, POST `{ text }` con él,
// timeout duro y NUNCA lanzar — ni en rechazo de red ni en no-2xx.
// La URL del webhook es un secreto: no debe quedar en los logs.
// ============================================================

const URL_WEBHOOK = 'https://hooks.example.test/services/T000/B000/secreto'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('ALERT_WEBHOOK_URL', URL_WEBHOOK)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('notifyAlert', () => {
  it('es un no-op sin ALERT_WEBHOOK_URL', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', '')

    await notifyAlert('hola')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('hace POST del texto como JSON', async () => {
    await notifyAlert('runner caído')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(URL_WEBHOOK)
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ text: 'runner caído' }))
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
  })

  it('nunca lanza si el webhook rechaza; solo loguea el mensaje', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(notifyAlert('x')).resolves.toBeUndefined()

    expect(spy).toHaveBeenCalledWith(
      '[ops alert] no se pudo entregar la alerta:',
      'fetch failed',
    )
    // La URL del webhook no debe quedar en los logs.
    expect(JSON.stringify(spy.mock.calls)).not.toContain(URL_WEBHOOK)
  })

  it('loguea (sin URL) si el webhook responde no-2xx y no lanza', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ ok: false, status: 500 })

    await expect(notifyAlert('x')).resolves.toBeUndefined()

    expect(spy).toHaveBeenCalledWith('[ops alert] webhook respondió 500')
    expect(JSON.stringify(spy.mock.calls)).not.toContain(URL_WEBHOOK)
  })

  it('aborta con timeout y se traga el abort', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            ),
          )
        }),
    )

    const pending = notifyAlert('x')
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(pending).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith(
      '[ops alert] no se pudo entregar la alerta:',
      'The operation was aborted.',
    )
  })
})
