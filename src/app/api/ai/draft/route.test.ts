import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  canUseAi: vi.fn(),
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  logAiUsage: vi.fn(),
  conversation: { data: null as unknown, error: null as unknown },
  admin: { name: 'service-role-client' },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/context', () => ({ buildConversationContext: mocks.buildConversationContext }))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: mocks.retrieveKnowledge }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }))
vi.mock('@/modules/clinica/ai-gate', () => ({ canUseAi: mocks.canUseAi }))

import { POST } from './route'

const scoped = {
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(mocks.conversation),
    }
    return chain
  },
}

function request(body: unknown) {
  return new Request('http://localhost/api/ai/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.conversation = { data: { id: 'conv-1', contact_id: 'ct-1' }, error: null }
  mocks.requireRole.mockResolvedValue({ supabase: scoped, accountId: 'acc-1', userId: 'user-1' })
  mocks.canUseAi.mockResolvedValue(true)
  mocks.loadAiConfig.mockResolvedValue({ provider: 'openai', model: 'm', systemPrompt: null })
  mocks.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hola' }])
  mocks.retrieveKnowledge.mockResolvedValue([])
  mocks.generateReply.mockResolvedValue({ text: 'Borrador', usage: {} })
})

describe('POST /api/ai/draft', () => {
  it('devuelve el borrador cuando la IA puede leer el chat', async () => {
    const response = await POST(request({ conversation_id: 'conv-1' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ draft: 'Borrador' })
    expect(mocks.canUseAi).toHaveBeenCalledWith(mocks.admin, {
      accountId: 'acc-1',
      contactId: 'ct-1',
    })
  })

  it('sin autorización responde 403 y no manda el chat a la IA', async () => {
    mocks.canUseAi.mockResolvedValue(false)
    const response = await POST(request({ conversation_id: 'conv-1' }))
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.code).toBe('consent_required')
    expect(body.error).toEqual(expect.any(String))
    expect(body.error.length).toBeGreaterThan(20)
    expect(mocks.buildConversationContext).not.toHaveBeenCalled()
    expect(mocks.retrieveKnowledge).not.toHaveBeenCalled()
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('con otra conversación que no es de la cuenta, sigue siendo 404 y no consulta nada', async () => {
    mocks.conversation = { data: null, error: null }
    const response = await POST(request({ conversation_id: 'conv-9' }))
    expect(response.status).toBe(404)
    expect(mocks.canUseAi).not.toHaveBeenCalled()
  })
})
