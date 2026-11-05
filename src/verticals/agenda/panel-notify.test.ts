import { describe, expect, it, vi } from 'vitest'

import { NOTIFY_UNAVAILABLE, notifyIfRequested, type PanelNotifyArgs } from './panel-notify'

const args = (): PanelNotifyArgs => ({
  db: {} as PanelNotifyArgs['db'],
  accountId: 'acc-1',
  appointmentId: 'ap-1',
  kind: 'booked',
  now: new Date('2026-11-05T15:00:00.000Z'),
})

describe('notifyIfRequested', () => {
  it('sin aviso pedido no arma los argumentos (ni el cliente de service role)', async () => {
    const makeArgs = vi.fn(args)
    expect(await notifyIfRequested(false, makeArgs)).toEqual({ notified: false })
    expect(makeArgs).not.toHaveBeenCalled()
  })

  it('mientras el aviso (T5) no esté conectado, devuelve "no se envió" con el motivo', async () => {
    expect(await notifyIfRequested(true, args)).toEqual({
      notified: false,
      notify_error: NOTIFY_UNAVAILABLE,
    })
  })

  it('una excepción no se escapa ni filtra su mensaje', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await notifyIfRequested(true, () => {
      throw new Error('no se pudo leer a Ana Pérez 573001112233')
    })
    expect(outcome.notified).toBe(false)
    expect(outcome.notify_error).toMatch(/no se pudo enviar/i)
    expect(JSON.stringify(outcome)).not.toContain('Ana')
    expect(JSON.stringify(spy.mock.calls)).not.toContain('573001112233')
    spy.mockRestore()
  })
})
