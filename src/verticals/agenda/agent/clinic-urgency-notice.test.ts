import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notifyAlert } from '@/lib/ops/alert'
import { buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import {
  ACCOUNT,
  CONVERSATION,
  OWNER,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import type { FakeDb } from './testing/fake-db'

// ============================================================
// El aviso prioritario sale desde el PRIMER mensaje de una urgencia, sin esperar
// a que la persona conteste los signos de alarma.
// ============================================================

vi.mock('@/lib/ops/alert', () => ({ notifyAlert: vi.fn(async () => {}) }))

beforeEach(() => {
  vi.mocked(notifyAlert).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const texts = buildClinicTexts(DEFAULT_LABELS)
const AGENT = 'user-agent'
const NOW = new Date('2026-10-19T13:00:00Z')

const opened = (db: FakeDb) =>
  db._tables.notifications.filter((n) => n.title === texts.urgencyOpenedNotificationTitle)
const confirmed = (db: FakeDb) =>
  db._tables.notifications.filter((n) => n.title === texts.urgencyNotificationTitle)

describe('el aviso al abrir los signos de alarma', () => {
  it('por texto: sale ya, antes de que conteste', async () => {
    const db = clinicDb()
    const rec = makeRecorder()

    await send(db, rec, { text: 'me duele una muela' })

    expect(last(rec).ids).toEqual(['act:alarm_yes', 'act:alarm_no'])
    expect(opened(db)).toMatchObject([
      {
        user_id: OWNER,
        conversation_id: CONVERSATION,
        title: texts.urgencyOpenedNotificationTitle,
        body: texts.urgencyOpenedNotificationBody('Marta Ruiz'),
      },
    ])
    // Todavía no confirmó nada: el aviso de confirmación no existe.
    expect(confirmed(db)).toHaveLength(0)
  })

  it('por toque ("Tengo una urgencia"): también', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'act:urgent' })

    expect(opened(db)).toHaveLength(1)
  })

  it('desde el menú principal: también', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(opened(db)).toHaveLength(0)

    await send(db, rec, { replyId: 'act:urgent' })

    expect(opened(db)).toHaveLength(1)
    expect(last(rec).ids).toEqual(['act:alarm_yes', 'act:alarm_no'])
  })

  it('con un agente asignado, le llega a él', async () => {
    const db = clinicDb()
    db._tables.conversations[0].assigned_agent_id = AGENT

    await send(db, makeRecorder(), { text: 'tengo mucho dolor' })

    expect(opened(db)).toMatchObject([{ user_id: AGENT }])
  })

  it('el mensaje de signos de alarma sale igual', async () => {
    const rec = makeRecorder()
    await send(clinicDb(), rec, { text: 'me duele una muela' })
    expect(last(rec).bodyText).toBe(texts.urgencyBody('Signos de alarma'))
  })

  describe('uno por conversación cada 10 minutos', () => {
    it('quien escribe "me duele" varias veces no llena la bandeja', async () => {
      const db = clinicDb()
      const rec = makeRecorder()

      await send(db, rec, { text: 'me duele una muela' })
      await send(db, rec, { text: 'me duele mucho' })
      await send(db, rec, { replyId: 'act:urgent' })

      expect(opened(db)).toHaveLength(1)
    })

    it('pasados 10 minutos vuelve a avisar', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'me duele una muela' }, { now: NOW })

      await send(db, rec, { replyId: 'act:urgent' }, { now: new Date(NOW.getTime() + 11 * 60_000) })

      expect(opened(db)).toHaveLength(2)
    })

    it('otra conversación no comparte el límite', async () => {
      const db = clinicDb()
      db._tables.notifications.push({
        id: 'n-otra',
        account_id: ACCOUNT,
        user_id: OWNER,
        conversation_id: 'cv-otra',
        title: texts.urgencyOpenedNotificationTitle,
        created_at: NOW.toISOString(),
      })

      await send(db, makeRecorder(), { text: 'me duele una muela' }, { now: NOW })

      expect(opened(db)).toHaveLength(2)
    })

    it('el aviso de confirmación no se pierde por ese límite: dice algo más grave', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'me duele una muela' })
      expect(opened(db)).toHaveLength(1)

      // Confirma que tiene signos de alarma, dentro de los 10 minutos.
      await send(db, rec, { replyId: 'act:alarm_yes' })

      expect(opened(db)).toHaveLength(1)
      expect(confirmed(db)).toMatchObject([
        { user_id: OWNER, body: texts.urgencyNotificationBody('Marta Ruiz') },
      ])
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    })

    it('tampoco el de quien no confirma ("no, solo me duele")', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'me duele una muela' })

      await send(db, rec, { text: 'no, solo me duele' })

      expect(opened(db)).toHaveLength(1)
      expect(confirmed(db)).toHaveLength(1)
    })
  })

  describe('si el aviso falla', () => {
    it('avisa al equipo técnico sin el texto del paciente, y los signos de alarma salen igual', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      db._failNext('insert', 'notifications', { message: 'timeout' })

      await send(db, rec, { text: 'me duele una muela de Marta' })

      expect(last(rec).bodyText).toBe(texts.urgencyBody('Signos de alarma'))
      expect(notifyAlert).toHaveBeenCalledTimes(1)
      const alert = vi.mocked(notifyAlert).mock.calls[0][0]
      expect(alert).toContain(ACCOUNT)
      expect(alert).toContain(CONVERSATION)
      expect(alert).not.toContain('muela')
    })

    it('sin a quién avisar (ni agente ni dueño) también lo dice', async () => {
      const db = clinicDb({ accounts: [{ id: ACCOUNT, default_currency: 'COP', owner_user_id: null }] })

      await send(db, makeRecorder(), { text: 'me duele una muela' })

      expect(db._tables.notifications).toHaveLength(0)
      expect(notifyAlert).toHaveBeenCalledTimes(1)
    })

    it('si ya había un aviso reciente no es un fallo: alguien ya sabe', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'me duele una muela' })

      await send(db, rec, { replyId: 'act:urgent' })

      expect(notifyAlert).not.toHaveBeenCalled()
    })
  })

  it('un mensaje que no es una urgencia no avisa de nada', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    await send(db, makeRecorder(), { text: 'Hola' })
    await send(db, makeRecorder(), { text: 'quiero agendar una limpieza' })
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('una cuenta sin clínica no cambia: no abre los signos ni avisa', async () => {
    const db = clinicDb()
    await send(db, makeRecorder(), { text: 'me duele una muela' }, { modules: ['agenda'] })
    expect(db._tables.notifications).toHaveLength(0)
  })
})
