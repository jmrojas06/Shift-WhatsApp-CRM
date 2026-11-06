import { beforeEach, describe, expect, it, vi } from 'vitest'

// El envío real (mensaje libre o plantilla) se prueba en notify-patient.test.ts.
const notifyPatient = vi.hoisted(() => vi.fn())
vi.mock('./notify-patient', () => ({ notifyPatient }))

import { notifyFromPanel, notifyIfRequested, type PanelNotifyArgs } from './panel-notify'

const args = (): PanelNotifyArgs => ({
  db: {} as PanelNotifyArgs['db'],
  accountId: 'acc-1',
  appointmentId: 'ap-1',
  kind: 'booked',
  now: new Date('2026-11-05T15:00:00.000Z'),
})

beforeEach(() => {
  notifyPatient.mockReset()
})

describe('notifyFromPanel', () => {
  it('delega en notifyPatient con los mismos argumentos y devuelve su resultado', async () => {
    notifyPatient.mockResolvedValue({ sent: true, channel: 'template' })
    const input = args()

    expect(await notifyFromPanel(input)).toEqual({ sent: true, channel: 'template' })
    expect(notifyPatient).toHaveBeenCalledWith(input)
  })
})

describe('notifyIfRequested', () => {
  it('sin aviso pedido no arma los argumentos (ni el cliente de service role)', async () => {
    const makeArgs = vi.fn(args)
    expect(await notifyIfRequested(false, makeArgs)).toEqual({ notified: false })
    expect(makeArgs).not.toHaveBeenCalled()
    expect(notifyPatient).not.toHaveBeenCalled()
  })

  it('un aviso enviado se reporta como notificado', async () => {
    notifyPatient.mockResolvedValue({ sent: true, channel: 'text' })

    expect(await notifyIfRequested(true, args)).toEqual({ notified: true })
  })

  it('un aviso que no salió devuelve el motivo para que el panel lo muestre', async () => {
    notifyPatient.mockResolvedValue({ sent: false, error: 'La plantilla "cita_agendada" no existe.' })

    expect(await notifyIfRequested(true, args)).toEqual({
      notified: false,
      notify_error: 'La plantilla "cita_agendada" no existe.',
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

  it('si notifyPatient lanzara (no debería), tampoco se escapa', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    notifyPatient.mockRejectedValue(new Error('boom Ana Pérez'))

    const outcome = await notifyIfRequested(true, args)

    expect(outcome).toEqual({ notified: false, notify_error: 'No se pudo enviar el aviso por WhatsApp.' })
    spy.mockRestore()
  })
})
