import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ContactError, findOrCreateContact } from '@/lib/api/v1/contacts'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { loadClinicContext } from '@/modules/clinica/settings'
import { insertAppointment } from '@/verticals/agenda/agent/db'
import { parseCreateBody } from '@/verticals/agenda/panel-booking-input'
import {
  accountHasClinic,
  ensureConversation,
  loadBookableService,
  loadBookableStaff,
  loadPanelContact,
  loadPanelLabels,
  loadSlotContext,
  PATIENT_MESSAGES,
  recordReceptionConsent,
  resolvePatient,
  staffServesService,
  type PanelContact,
} from '@/verticals/agenda/panel-booking-repo'
import { validatePanelBooking } from '@/verticals/agenda/panel-booking'
import { notifyIfRequested } from '@/verticals/agenda/panel-notify'

import { panelError, panelRejection, scheduleCalendarKick } from '../_lib/panel-http'
import { readJsonBody } from '../_lib/http'

// ============================================================
// POST /api/verticals/agenda/appointments
//
// La recepción crea una cita desde el panel. Las mismas reglas que el
// bot (el profesional atiende el servicio, no hay choque, en una
// clínica queda un sillón libre), pero más flexible: puede agendar
// fuera de horario si lo confirma (`outside_hours_ok`).
//
// Orden: sesión (agent o más) → forma del cuerpo → servicio y
// profesional de la cuenta → reglas (nada se escribe si fallan) →
// contacto, conversación y paciente → la cita → autorización de
// recepción (clínica) → aviso a Google y al paciente.
//
// El aviso al paciente nunca deshace la cita: si falla, la respuesta
// trae `notify_error` y la pantalla lo dice. Lo mismo la autorización
// de recepción: si no se pudo guardar, el bot la pedirá en su primer
// mensaje.
//
// Respuesta 201: `{ id, notified, notify_error? }`.
// Errores: `{ error, code }` (ver _lib/panel-http.ts).
// ============================================================

const NOT_FOUND_MESSAGE =
  'Esa opción ya no existe o está desactivada. Recarga la página e intenta de nuevo.'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const { accountId, userId } = ctx
    const db = ctx.supabase

    const parsed = parseCreateBody(await readJsonBody(request))
    if (!parsed.ok) return panelError(400, 'invalid_body', parsed.message)
    const input = parsed.value

    const now = new Date()
    const labels = await loadPanelLabels(db, accountId)
    const clinicActive = await accountHasClinic(db, accountId)

    const service = await loadBookableService(db, accountId, input.serviceId)
    if (!service) return panelError(404, 'service_not_found', NOT_FOUND_MESSAGE)
    const staff = await loadBookableStaff(db, accountId, input.staffId)
    if (!staff) return panelError(404, 'staff_not_found', NOT_FOUND_MESSAGE)

    let existingContact: PanelContact | null = null
    if ('id' in input.contact) {
      existingContact = await loadPanelContact(db, accountId, input.contact.id)
      if (!existingContact) return panelError(404, 'contact_not_found', NOT_FOUND_MESSAGE)
    }

    // En una clínica se lee la configuración ANTES de escribir nada: sin ella
    // no hay sede ni texto de autorización, y no se agenda a ciegas.
    let clinic: { locationId: string | null; consentText: string; consentVersion: number } | null =
      null
    if (clinicActive) {
      const result = await loadClinicContext(db, accountId)
      if (result.status !== 'ok') {
        return panelError(
          500,
          'clinic_unavailable',
          'No se pudo leer la configuración de la clínica. Intenta de nuevo.',
        )
      }
      clinic = {
        locationId: result.clinic.location?.id ?? null,
        consentText: result.clinic.consentText,
        consentVersion: result.clinic.consentVersion,
      }
    }

    // ---- reglas de agenda: si fallan, no se escribe nada -------------------
    const endsAtForReads = new Date(input.startsAt.getTime() + service.durationMinutes * 60_000)
    const slot = await loadSlotContext(db, {
      accountId,
      staffId: staff.id,
      startsAt: input.startsAt,
      endsAt: endsAtForReads,
      clinic: clinicActive,
    })
    const check = validatePanelBooking({
      startsAt: input.startsAt,
      durationMinutes: service.durationMinutes,
      now,
      staffServesService: await staffServesService(db, accountId, staff.id, service.id),
      workBlocks: slot.workBlocks,
      timeOff: slot.timeOff,
      outsideHoursOk: input.outsideHoursOk,
      chairs: slot.chairs,
    })
    if (!check.ok) return panelRejection(check.code, labels)

    // ---- contacto, conversación y paciente ---------------------------------
    let contact = existingContact
    if (!contact) {
      if ('id' in input.contact) throw new Error('contacto sin resolver')
      try {
        const created = await findOrCreateContact(db, accountId, userId, input.contact)
        contact = await loadPanelContact(db, accountId, created.id)
      } catch (err) {
        if (!(err instanceof ContactError)) throw err
        if (err.status === 400) {
          return panelError(
            400,
            'invalid_body',
            'El teléfono debe llevar el indicativo del país con +, por ejemplo +573001234567.',
          )
        }
        console.error('[agenda panel] no se pudo crear el contacto')
        return panelError(500, 'contact_failed', 'No se pudo crear el contacto. Intenta de nuevo.')
      }
      if (!contact) throw new Error('El contacto recién creado no se pudo leer')
    }

    const conversationId = await ensureConversation(db, {
      accountId,
      contactId: contact.id,
      userId,
    })

    let patientId: string | null = null
    if (clinic) {
      const patient = await resolvePatient(db, {
        accountId,
        contact,
        patientId: input.patientId,
        newPatientName: input.newPatientName,
      })
      if (!patient.ok) {
        return panelError(
          patient.code === 'patient_not_found' ? 404 : 400,
          patient.code,
          PATIENT_MESSAGES[patient.code],
        )
      }
      patientId = patient.patientId
    }

    // ---- la cita ----------------------------------------------------------
    const appointmentId = crypto.randomUUID()
    const { error } = await insertAppointment(db, {
      id: appointmentId,
      accountId,
      contactId: contact.id,
      conversationId,
      serviceId: service.id,
      staffId: staff.id,
      startsAtIso: input.startsAt.toISOString(),
      endsAtIso: check.endsAt.toISOString(),
      status: 'confirmed',
      createdVia: 'dashboard',
      createdBy: userId,
      confirmedAtIso: now.toISOString(),
      patientId,
      locationId: clinic?.locationId ?? null,
    })
    // El EXCLUDE anti-doble-reserva de 047: el profesional ya tiene otra cita.
    if (error?.code === '23P01') return panelRejection('slot_taken', labels)
    if (error) throw new Error(`No se pudo guardar la cita: ${error.message ?? 'error'}`)

    scheduleCalendarKick(accountId)

    // La cita ya está guardada: lo que sigue no la puede deshacer.
    if (clinic) {
      try {
        await recordReceptionConsent(db, supabaseAdmin(), {
          accountId,
          contactId: contact.id,
          consentText: clinic.consentText,
          consentVersion: clinic.consentVersion,
          nowIso: now.toISOString(),
        })
      } catch (err) {
        console.error(
          '[agenda panel] no se pudo guardar la autorización de recepción:',
          err instanceof Error ? err.message : 'error',
        )
      }
    }

    const outcome = await notifyIfRequested(input.notify, () => ({
      db: supabaseAdmin(),
      accountId,
      appointmentId,
      kind: 'booked',
      now,
    }))

    return NextResponse.json({ id: appointmentId, ...outcome }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
