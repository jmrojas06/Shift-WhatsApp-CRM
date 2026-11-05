import { describe, expect, it, vi } from 'vitest'

import { ACCOUNT, CONTACT, SERVICE_LIMPIEZA, STAFF_ANA } from './testing/clinic-harness'
import {
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
  type Recorder,
} from './testing/clinic-harness'
import { BOOK_AGAIN_ID } from './state'

// ============================================================
// "Agendar otra" (aviso de cancelación) y "Agendar" (enlace tras una
// llamada): el toque `book:again` abre el flujo de reservas igual que el
// botón "Agendar" del menú de la clínica. Sin clínica también funciona, y
// con una persona a cargo del hilo se suelta como cualquier mensaje.
// ============================================================

// El bot de la clínica lee la configuración de la IA; aquí no importa.
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: vi.fn() }))

const authorized = () => clinicDb({ clinic_consents: [grantedConsent()] })

const activeSessions = (db: ReturnType<typeof clinicDb>) =>
  db._tables.booking_sessions.filter((s) => s.status === 'active')

const activeSteps = (db: ReturnType<typeof clinicDb>) =>
  activeSessions(db).map((s) => (s.state as { step: string }).step)

/** Lo que el paciente ve después del toque, para compararlo con otro toque. */
function outcome(db: ReturnType<typeof clinicDb>, rec: Recorder) {
  const call = last(rec)
  return {
    kind: call.kind,
    ids: call.ids,
    titles: call.titles,
    steps: activeSteps(db),
    // Un toque que el bot no entiende cuenta un fallo; este no debe contar ninguno.
    fails: activeSessions(db).map((s) => (s.state as { fails: number }).fails),
  }
}

describe('book:again en una clínica', () => {
  it('abre la reserva igual que el botón "Agendar" del menú', async () => {
    const viaMenu = authorized()
    const recMenu = makeRecorder()
    await send(viaMenu, recMenu, { replyId: 'act:book' })

    const viaAgain = authorized()
    const recAgain = makeRecorder()
    const result = await send(viaAgain, recAgain, { replyId: BOOK_AGAIN_ID })

    expect(result).toEqual({ consumed: true })
    expect(outcome(viaAgain, recAgain)).toEqual(outcome(viaMenu, recMenu))
    // Siguió la reserva: ni "No entendí" ni el menú otra vez.
    expect(activeSteps(viaAgain)).toHaveLength(1)
    expect(activeSteps(viaAgain)).not.toContain('clinic_menu')
    expect(last(recAgain).ids).not.toContain('act:book')
  })

  it('sin autorización, pide la autorización primero (como el menú)', async () => {
    const db = clinicDb()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: BOOK_AGAIN_ID })

    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
  })

  it('a media reserva la reinicia, como el botón del menú', async () => {
    const viaMenu = authorized()
    const recMenu = makeRecorder()
    await send(viaMenu, recMenu, { text: 'Hola' })
    await send(viaMenu, recMenu, { replyId: 'act:book' })
    await send(viaMenu, recMenu, { replyId: 'act:book' })

    const viaAgain = authorized()
    const recAgain = makeRecorder()
    await send(viaAgain, recAgain, { text: 'Hola' })
    await send(viaAgain, recAgain, { replyId: 'act:book' })
    await send(viaAgain, recAgain, { replyId: BOOK_AGAIN_ID })

    expect(outcome(viaAgain, recAgain)).toEqual(outcome(viaMenu, recMenu))
    expect(activeSteps(viaAgain)).toHaveLength(1)
  })

  it('con una persona a cargo del hilo se suelta: no responde ni abre sesión', async () => {
    const db = authorized()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: BOOK_AGAIN_ID }, { humanOwned: true })

    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
  })
})

describe('book:again sin el módulo clínica', () => {
  const plain = (extra: Parameters<typeof clinicDb>[0] = {}) => clinicDb(extra)
  const noClinic = { modules: ['agenda' as const] }

  it('sin sesión abre el menú de servicios', async () => {
    const db = plain()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: BOOK_AGAIN_ID }, noClinic)

    expect(result).toEqual({ consumed: true })
    expect(activeSteps(db)).toEqual(['pick_service'])
    expect(last(rec).titles).toEqual(['Limpieza', 'Urgencia'])
  })

  it('aunque tenga otra cita próxima, abre una reserva nueva (no el menú de gestión)', async () => {
    const db = plain({
      booking_appointments: [
        {
          id: 'ap-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          service_id: SERVICE_LIMPIEZA,
          staff_id: STAFF_ANA,
          starts_at: '2026-10-21T14:00:00.000Z',
          ends_at: '2026-10-21T14:30:00.000Z',
          status: 'confirmed',
          answers: {},
        },
      ],
    })
    const rec = makeRecorder()

    await send(db, rec, { replyId: BOOK_AGAIN_ID }, noClinic)

    expect(activeSteps(db)).toEqual(['pick_service'])
  })

  it('a media reserva reinicia en el menú de servicios, en la misma sesión', async () => {
    const db = plain()
    const rec = makeRecorder()
    await send(db, rec, { text: 'hola' }, noClinic)
    await send(db, rec, { replyId: `svc:${SERVICE_LIMPIEZA}` }, noClinic)
    expect(activeSteps(db)).not.toEqual(['pick_service'])
    const sessionId = activeSessions(db)[0].id

    await send(db, rec, { replyId: BOOK_AGAIN_ID }, noClinic)

    expect(activeSteps(db)).toEqual(['pick_service'])
    expect(activeSessions(db)[0].id).toBe(sessionId)
    expect(last(rec).titles).toEqual(['Limpieza', 'Urgencia'])
  })

  it('con una persona a cargo del hilo se suelta', async () => {
    const db = plain()
    const rec = makeRecorder()

    const result = await send(db, rec, { replyId: BOOK_AGAIN_ID }, { ...noClinic, humanOwned: true })

    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
  })
})
