import { describe, expect, it } from 'vitest'

import { CLINIC_HUMAN_WORDS, buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { AGENDA_AGENT_TEXTS } from '../texts'
import {
  ACCOUNT,
  CONTACT,
  clinicDb,
  grantedConsent,
  makeRecorder,
  send,
  last,
} from './testing/clinic-harness'

const texts = buildClinicTexts(DEFAULT_LABELS)

const session = (state: Record<string, unknown>) => ({
  id: 'ses-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: { mode: 'book', options: [], fails: 0, ...state },
})

describe('quejas, pagos y documentos van a una persona', () => {
  it('la lista tiene lo que pide la spec, sin tildes', () => {
    expect([...CLINIC_HUMAN_WORDS]).toEqual([
      'queja',
      'reclamo',
      'pqr',
      'pqrs',
      'factura',
      'pago',
      'pagar',
      'abono',
      'saldo',
      'certificado',
      'incapacidad',
      'historia clinica',
      'radiografia',
      'receta',
      'documento',
      'documentos',
    ])
  })

  it.each([
    'Tengo una queja del servicio',
    'Quiero poner un reclamo',
    'Necesito radicar una PQR',
    'Una pqrs por favor',
    'Necesito mi factura',
    'Quiero hacer el pago',
    'Voy a pagar hoy',
    'Hice un abono ayer',
    'Quiero saber mi saldo',
    'Necesito un certificado',
    'Necesito la incapacidad',
    'Mi historia clínica, por favor',
    'Necesito la radiografía de mi hijo',
    'Necesito una receta',
    'Envíenme el documento',
    'Documentos para el seguro',
    'Hola, quiero pagar mi factura',
  ])('un mensaje que no es una duda pasa a una persona: %j', async (text) => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.humanTopicNote)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('no necesita autorización: nadie con una queja se queda atascado en un aviso legal', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Tengo una queja de mi última cita' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
    expect(rec.calls.every((c) => !c.ids.includes('act:consent_yes'))).toBe(true)
  })

  it('con una sesión abierta también pasa a una persona y la cierra', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session({ step: 'clinic_menu' })],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Necesito mi factura' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it.each([
    '¿Cuánto cuesta el certificado?',
    '¿Puedo pagar con tarjeta?',
    'cómo pago',
    'qué documentos piden para el primer día',
    'dónde recojo mi factura',
  ])('una duda va a la IA: %j', async (text) => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text })
    expect(result).toEqual({ consumed: false })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(rec.calls).toHaveLength(0)
  })

  it('un verbo de pedir gana sobre la forma de pregunta', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Me das el certificado?' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('no se aplica mientras escribe el nombre de quien va a asistir', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session({ step: 'new_patient_name' })],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Camila Pago Receta' })
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.humanTopicNote)
  })

  it('no se aplica mientras escribe la respuesta a una pregunta de la clínica', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session({ step: 'ask_question', questionId: 'q-1' })],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Voy a pagar con tarjeta' })
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.humanTopicNote)
  })

  it('no confunde una palabra más larga: "pagos" y "pagado" no son "pago"', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'ya está pagado, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('un toque de un botón no es texto y no dispara nada', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:book' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('en una cuenta sin clínica no cambia nada', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Necesito mi factura' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: false })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('un hilo que ya es de una persona no se toca', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Necesito mi factura' }, { humanOwned: true })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })
})
