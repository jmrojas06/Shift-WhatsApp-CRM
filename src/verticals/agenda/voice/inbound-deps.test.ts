import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// El cableado real de la llamada entrante: contacto + conversación de quien
// llama, con los mismos ayudantes que usa el resto del CRM. Los módulos de
// contactos se reemplazan por dobles; aquí solo se prueba cómo se juntan.
// ============================================================

const h = vi.hoisted(() => ({
  resolveAuditUserId: vi.fn(),
  findOrCreateContact: vi.fn(),
  findExistingContact: vi.fn(),
  ensureConversation: vi.fn(),
}))

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: (...args: unknown[]) => h.resolveAuditUserId(...args),
  findOrCreateContact: (...args: unknown[]) => h.findOrCreateContact(...args),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: (...args: unknown[]) => h.findExistingContact(...args),
}))
vi.mock('../panel-booking-repo', () => ({
  ensureConversation: (...args: unknown[]) => h.ensureConversation(...args),
}))
vi.mock('../calendar-kick', () => ({ kickCalendarSync: vi.fn() }))
vi.mock('../notify-patient', () => ({ notifyPatient: vi.fn(), sendBookingLink: vi.fn() }))

import { inboundDeps } from './inbound-deps'

const DB = { fake: 'db' } as never

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset()
  h.resolveAuditUserId.mockResolvedValue('audit-user')
  h.findOrCreateContact.mockResolvedValue({ id: 'contact-1', created: true })
  h.ensureConversation.mockResolvedValue('conv-1')
})

describe('ensureCaller', () => {
  it('busca o crea el contacto con el número que llamó y asegura su conversación', async () => {
    const result = await inboundDeps.ensureCaller(DB, { accountId: 'acc-1', phone: '+573001112233' })

    expect(result).toEqual({ contactId: 'contact-1', conversationId: 'conv-1' })
    expect(h.resolveAuditUserId).toHaveBeenCalledWith(DB, 'acc-1')
    // Sin nombre: el contacto nuevo queda con el número como nombre.
    expect(h.findOrCreateContact).toHaveBeenCalledWith(DB, 'acc-1', 'audit-user', { phone: '+573001112233' })
    expect(h.ensureConversation).toHaveBeenCalledWith(DB, {
      accountId: 'acc-1',
      contactId: 'contact-1',
      userId: 'audit-user',
    })
  })

  it('si el contacto ya existía, lo reutiliza', async () => {
    h.findOrCreateContact.mockResolvedValue({ id: 'contact-9', created: false })
    const result = await inboundDeps.ensureCaller(DB, { accountId: 'acc-1', phone: '+573001112233' })
    expect(result.contactId).toBe('contact-9')
    expect(h.ensureConversation).toHaveBeenCalledWith(DB, expect.objectContaining({ contactId: 'contact-9' }))
  })

  it('un fallo al crear el contacto sube (no se manda nada a ciegas)', async () => {
    h.findOrCreateContact.mockRejectedValue(new Error('Failed to create contact'))
    await expect(inboundDeps.ensureCaller(DB, { accountId: 'acc-1', phone: '+573001112233' })).rejects.toThrow()
    expect(h.ensureConversation).not.toHaveBeenCalled()
  })
})

describe('findContact', () => {
  it('devuelve el contacto que ya existe, sin crear nada', async () => {
    h.findExistingContact.mockResolvedValue({ id: 'contact-1', phone: '573001112233', name: 'Ana' })
    expect(await inboundDeps.findContact(DB, 'acc-1', '+573001112233')).toEqual({ id: 'contact-1' })
    expect(h.findExistingContact).toHaveBeenCalledWith(DB, 'acc-1', '+573001112233')
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('si no existe devuelve null', async () => {
    h.findExistingContact.mockResolvedValue(null)
    expect(await inboundDeps.findContact(DB, 'acc-1', '+573001112233')).toBeNull()
  })
})
