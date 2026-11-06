// ============================================================
// Cableado real de la llamada entrante: lo que la ruta le pasa a
// `inbound-webhook.ts`. Las pruebas del webhook usan dobles; este archivo junta
// los ayudantes de siempre del CRM (contactos, conversación, WhatsApp, Google).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts'
import { findExistingContact } from '@/lib/contacts/dedupe'

import { kickCalendarSync } from '../calendar-kick'
import { notifyPatient, sendBookingLink } from '../notify-patient'
import { ensureConversation } from '../panel-booking-repo'
import type { InboundDeps } from './inbound-effects'

/**
 * El contacto del número que llamó (se crea si no existe, con el número como
 * nombre, igual que un contacto nuevo del CRM) y su conversación de WhatsApp
 * (vacía si aún no tiene: no se envía nada). Lanza si no se puede.
 */
async function ensureCaller(
  db: SupabaseClient,
  args: { accountId: string; phone: string },
): Promise<{ contactId: string; conversationId: string }> {
  const auditUserId = await resolveAuditUserId(db, args.accountId)
  const { id } = await findOrCreateContact(db, args.accountId, auditUserId, { phone: args.phone })
  const conversationId = await ensureConversation(db, {
    accountId: args.accountId,
    contactId: id,
    userId: auditUserId,
  })
  return { contactId: id, conversationId }
}

async function findContact(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<{ id: string } | null> {
  const found = await findExistingContact(db, accountId, phone)
  return found ? { id: found.id } : null
}

export const inboundDeps: InboundDeps = {
  notifyPatient,
  kickCalendar: kickCalendarSync,
  sendBookingLink,
  ensureCaller,
  findContact,
}
