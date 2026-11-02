import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { aiWillAnswer, hasActiveAutoResponder, replyCapReached } from './eligibility'

const loadAiConfig = vi.hoisted(() => vi.fn())
vi.mock('./config', () => ({ loadAiConfig }))

const ACCOUNT = 'acc-1'
const CONVERSATION = 'cv-1'

const config = (overrides = {}) => ({
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  ...overrides,
})

function db(extra: Record<string, Row[]> = {}) {
  return makeFakeDb({
    automations: [],
    conversations: [{ id: CONVERSATION, account_id: ACCOUNT, ai_reply_count: 0 }],
    ...extra,
  })
}

const ask = (fake: ReturnType<typeof db>) =>
  aiWillAnswer(asClient(fake), { accountId: ACCOUNT, conversationId: CONVERSATION })

beforeEach(() => {
  loadAiConfig.mockReset()
  loadAiConfig.mockResolvedValue(config())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('hasActiveAutoResponder', () => {
  const auto = (overrides: Row) => ({
    id: 'a-1',
    account_id: ACCOUNT,
    is_active: true,
    trigger_type: 'keyword_match',
    ...overrides,
  })

  it('ve una automatización activa de mensaje o de palabra clave', async () => {
    for (const trigger_type of ['new_message_received', 'keyword_match']) {
      const fake = db({ automations: [auto({ trigger_type })] })
      expect(await hasActiveAutoResponder(asClient(fake), ACCOUNT)).toBe(true)
    }
  })

  it('no ve una apagada, de otro tipo ni de otra cuenta', async () => {
    const fake = db({
      automations: [
        auto({ is_active: false }),
        auto({ trigger_type: 'first_inbound_message' }),
        auto({ account_id: 'acc-2' }),
      ],
    })
    expect(await hasActiveAutoResponder(asClient(fake), ACCOUNT)).toBe(false)
  })
})

describe('replyCapReached', () => {
  it('llega al tope cuando ya se contestó el máximo', () => {
    expect(replyCapReached({ ai_reply_count: 3 }, { autoReplyMaxPerConversation: 3 })).toBe(true)
    expect(replyCapReached({ ai_reply_count: 2 }, { autoReplyMaxPerConversation: 3 })).toBe(false)
    expect(replyCapReached({ ai_reply_count: null }, { autoReplyMaxPerConversation: 3 })).toBe(false)
  })
})

describe('aiWillAnswer', () => {
  it('sí, si la respuesta automática está prendida y nada la frena', async () => {
    expect(await ask(db())).toBe(true)
  })

  it('no, si la IA no está configurada o la respuesta automática está apagada', async () => {
    loadAiConfig.mockResolvedValue(null)
    expect(await ask(db())).toBe(false)
    loadAiConfig.mockResolvedValue(config({ autoReplyEnabled: false }))
    expect(await ask(db())).toBe(false)
  })

  it('no, si la configuración no se puede leer', async () => {
    loadAiConfig.mockRejectedValue(new Error('llave'))
    expect(await ask(db())).toBe(false)
  })

  it('no, si hay una automatización que contesta: la IA se aparta', async () => {
    const fake = db({
      automations: [{ id: 'a', account_id: ACCOUNT, is_active: true, trigger_type: 'new_message_received' }],
    })
    expect(await ask(fake)).toBe(false)
  })

  it('no, si la conversación ya llegó al tope de respuestas', async () => {
    const fake = db({ conversations: [{ id: CONVERSATION, account_id: ACCOUNT, ai_reply_count: 3 }] })
    expect(await ask(fake)).toBe(false)
  })

  it('no, si no se encuentra la conversación', async () => {
    expect(await ask(db({ conversations: [] }))).toBe(false)
  })
})
