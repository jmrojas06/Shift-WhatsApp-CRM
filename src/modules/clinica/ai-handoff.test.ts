import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildClinicTexts, DEFAULT_URGENCY_ALARM_TEXT } from './texts'

const mocks = vi.hoisted(() => ({
  engineSendText: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  notifyAlert: vi.fn<(text: string) => Promise<void>>(async () => {}),
}))

vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: mocks.engineSendText }))
vi.mock('@/lib/ops/alert', () => ({ notifyAlert: mocks.notifyAlert }))

import { DEFAULT_LABELS } from '@/verticals/agenda/labels'
import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  OWNER,
  clinicDb,
} from '@/verticals/agenda/agent/testing/clinic-harness'
import { asClient } from '@/verticals/agenda/agent/testing/fake-db'

import { announceAiHandoff } from './ai-handoff'

const texts = buildClinicTexts(DEFAULT_LABELS)
const AGENT = 'user-agent'

const args = (over: Partial<Parameters<typeof announceAiHandoff>[1]> = {}) => ({
  accountId: ACCOUNT,
  conversationId: CONVERSATION,
  contactId: CONTACT,
  configOwnerUserId: OWNER,
  handoffAgentId: null,
  ...over,
})

const sentText = () => mocks.engineSendText.mock.calls[0]?.[0] as Record<string, unknown> | undefined

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('el pase de la IA en una clínica', () => {
  it('le dice al paciente que una persona lo revisa, con los signos de alarma de la clínica', async () => {
    const db = clinicDb()

    await announceAiHandoff(asClient(db), args())

    expect(mocks.engineSendText).toHaveBeenCalledTimes(1)
    expect(sentText()).toMatchObject({
      accountId: ACCOUNT,
      userId: OWNER,
      conversationId: CONVERSATION,
      contactId: CONTACT,
      text: texts.aiHandoffNotice('Signos de alarma'),
    })
    // El texto es el de siempre: la persona lo revisa, ya se le avisó, y los signos de alarma.
    expect(sentText()?.text).toContain('Esto lo debe revisar una persona de la clínica')
    expect(sentText()?.text).toContain('te escribe por este chat')
    expect(sentText()?.text).toContain('ve a urgencias sin esperar respuesta')
    expect(sentText()?.text).toContain('Signos de alarma')
  })

  it('crea un aviso en la app para el agente de pase', async () => {
    const db = clinicDb()

    await announceAiHandoff(asClient(db), args({ handoffAgentId: AGENT }))

    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: AGENT,
      conversation_id: CONVERSATION,
      contact_id: CONTACT,
      title: texts.aiHandoffNotificationTitle,
      body: texts.aiHandoffNotificationBody('Marta Ruiz'),
    })
  })

  it('sin agente de pase, el aviso es para el dueño', async () => {
    const db = clinicDb()

    await announceAiHandoff(asClient(db), args())

    expect(db._tables.notifications).toMatchObject([{ user_id: OWNER }])
  })

  it('el aviso se crea antes de decirle al paciente que ya se avisó', async () => {
    const db = clinicDb()
    const order: string[] = []
    mocks.engineSendText.mockImplementationOnce(async () => {
      order.push(`texto con ${db._tables.notifications.length} aviso(s)`)
    })

    await announceAiHandoff(asClient(db), args())

    expect(order).toEqual(['texto con 1 aviso(s)'])
  })

  it('sin la configuración de la clínica usa los signos de alarma de siempre', async () => {
    const db = clinicDb({ clinic_settings: [] })

    await announceAiHandoff(asClient(db), args())

    expect(sentText()?.text).toBe(texts.aiHandoffNotice(DEFAULT_URGENCY_ALARM_TEXT))
  })

  it('si no puede enviarle el texto, avisa al equipo técnico sin el texto del paciente, y el aviso en la app sale igual', async () => {
    const db = clinicDb()
    mocks.engineSendText.mockRejectedValueOnce(new Error('Meta rechazó el envío'))

    await announceAiHandoff(asClient(db), args())

    expect(db._tables.notifications).toHaveLength(1)
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    const alert = mocks.notifyAlert.mock.calls[0][0]
    expect(alert).toContain(ACCOUNT)
    expect(alert).toContain(CONVERSATION)
    expect(alert).not.toContain('Marta')
  })

  it('si no puede crear el aviso en la app, igual le escribe al paciente y avisa al equipo técnico', async () => {
    const db = clinicDb()
    db._failNext('insert', 'notifications', { message: 'timeout' })

    await announceAiHandoff(asClient(db), args())

    expect(mocks.engineSendText).toHaveBeenCalledTimes(1)
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    expect(mocks.notifyAlert.mock.calls[0][0]).toContain(CONVERSATION)
  })

  it('sin a quién avisar (ni agente ni dueño) lo dice al equipo técnico', async () => {
    const db = clinicDb({ accounts: [{ id: ACCOUNT, default_currency: 'COP', owner_user_id: null }] })

    await announceAiHandoff(asClient(db), args())

    expect(db._tables.notifications).toHaveLength(0)
    expect(mocks.engineSendText).toHaveBeenCalledTimes(1)
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
  })

  it('nunca lanza, ni con la base caída', async () => {
    const broken = {
      from() {
        throw new Error('base caída')
      },
    }

    await expect(
      announceAiHandoff(broken as unknown as Parameters<typeof announceAiHandoff>[0], args()),
    ).resolves.toBeUndefined()
    expect(mocks.notifyAlert).toHaveBeenCalled()
  })
})
