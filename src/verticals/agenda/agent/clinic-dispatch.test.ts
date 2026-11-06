import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// El bot de la clínica detrás del despachador de verticales, de verdad.
//
// El despachador lee la sesión ANTES de llamar al bot, y si el bot no consume
// el mensaje y no avisa que soltó la sesión (`released`), reclama el mensaje
// por esa sesión vieja: nadie contesta. Estas pruebas pasan por
// `dispatchInboundToVertical`, no solo por el controlador, porque ahí es donde
// se pierde el mensaje.
// ============================================================

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  notifyAlert: vi.fn<(text: string) => Promise<void>>(async () => {}),
  sendText: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendButtons: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendList: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  loadAiConfig: vi.fn(),
}))

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => mocks.db }))
vi.mock('@/lib/ops/alert', () => ({ notifyAlert: mocks.notifyAlert }))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: mocks.sendText,
  engineSendInteractiveButtons: mocks.sendButtons,
  engineSendInteractiveList: mocks.sendList,
}))

import { dispatchInboundToVertical } from '@/lib/verticals/dispatch'

import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  OWNER,
  clinicDb,
  grantedConsent,
} from './testing/clinic-harness'
import type { FakeDb } from './testing/fake-db'

const NOW = new Date('2026-10-19T13:00:00.000Z')
const BUSY = '2099-01-01T00:00:00.000Z'

const MARKETING_SESSION = {
  id: 'ses-mkt',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: {
    step: 'marketing_consent',
    mode: 'book',
    options: [
      { id: 'act:mkt_yes', title: 'Sí, avísame' },
      { id: 'act:mkt_no', title: 'No, gracias' },
    ],
    fails: 0,
  },
}

const MENU_SESSION = {
  id: 'ses-menu',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: {
    step: 'clinic_menu',
    mode: 'book',
    options: [
      { id: 'act:book', title: 'Agendar cita' },
      { id: 'act:mine', title: 'Mis citas' },
      { id: 'act:faq', title: 'Precios y dudas' },
      { id: 'act:urgent', title: 'Tengo una urgencia' },
      { id: 'act:human', title: 'Hablar con una persona' },
    ],
    fails: 0,
  },
}

/** Una clínica de verdad para el despachador: con módulos, autorización y un mensaje entrante. */
function clinicWith(session: typeof MARKETING_SESSION, text: string): FakeDb {
  const db = clinicDb({
    accounts: [
      {
        id: ACCOUNT,
        default_currency: 'COP',
        owner_user_id: OWNER,
        modules: ['agenda', 'clinica'],
        vertical_key: 'odontologia',
      },
    ],
    clinic_consents: [grantedConsent()],
    booking_sessions: [{ ...session }],
    messages: [
      {
        id: 'msg-in',
        conversation_id: CONVERSATION,
        message_id: 'wamid-in',
        content_text: text,
        interactive_reply_id: null,
        reply_to_message_id: null,
      },
    ],
  })
  mocks.db = db
  return db
}

const dispatch = () =>
  dispatchInboundToVertical({
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    inboundMessageId: 'wamid-in',
  })

const sessionStatus = (db: FakeDb, id: string) =>
  db._tables.booking_sessions.find((s) => s.id === id)?.status

const nothingSent = () =>
  mocks.sendText.mock.calls.length + mocks.sendButtons.mock.calls.length + mocks.sendList.mock.calls.length === 0

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.loadAiConfig.mockResolvedValue({ autoReplyEnabled: true, autoReplyMaxPerConversation: 3 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('el mensaje de un paciente no se pierde por una sesión que el bot soltó', () => {
  describe('tras la pregunta de avisos de control', () => {
    it.each([
      '¿tienen parqueadero?',
      'gracias',
      'sí',
      'gracias, ¿dónde queda la clínica?',
    ])('%j llega a la IA: el despachador no lo da por consumido', async (text) => {
      const db = clinicWith(MARKETING_SESSION, text)

      const result = await dispatch()

      // La IA lo contesta: nadie lo reclamó, y la sesión de la pregunta ya se cerró.
      expect(result).toEqual({ consumed: false })
      expect(sessionStatus(db, 'ses-mkt')).toBe('completed')
      expect(nothingSent()).toBe(true)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('un "no" completo sí lo contesta el bot, y el despachador lo da por consumido', async () => {
      const db = clinicWith(MARKETING_SESSION, 'no gracias')

      const result = await dispatch()

      expect(result).toEqual({ consumed: true })
      expect(db._tables.clinic_consents.filter((c) => c.kind === 'mercadeo')).toMatchObject([
        { granted: false },
      ])
    })

    it('si la IA no va a contestar, la duda pasa a una persona y se consume', async () => {
      mocks.loadAiConfig.mockResolvedValue({ autoReplyEnabled: false, autoReplyMaxPerConversation: 3 })
      const db = clinicWith(MARKETING_SESSION, '¿tienen parqueadero?')

      const result = await dispatch()

      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    })
  })

  describe('tras esperar el candado', () => {
    it('con el menú abierto, dos dudas seguidas: la segunda tampoco se pierde', async () => {
      const db = clinicWith(MENU_SESSION as typeof MARKETING_SESSION, '¿tienen parqueadero?')
      // La primera duda sigue en proceso: tiene el candado.
      db._tables.conversations[0].bot_lock_until = BUSY

      const pending = dispatch()
      await vi.advanceTimersByTimeAsync(300)
      // La primera termina: pasó a la IA y cerró la sesión; suelta el candado.
      db._tables.booking_sessions[0].status = 'completed'
      db._tables.conversations[0].bot_lock_until = null
      await vi.advanceTimersByTimeAsync(300)

      // La segunda ya no ve sesión, pero el despachador la leyó antes: sin `released`
      // la reclamaría por la sesión vieja.
      expect(await pending).toEqual({ consumed: false })
      expect(nothingSent()).toBe(true)
    })

    it('si la sesión sigue abierta, el bot sigue siendo dueño del mensaje', async () => {
      const db = clinicWith(MENU_SESSION as typeof MARKETING_SESSION, 'Hola')
      db._tables.conversations[0].bot_lock_until = BUSY

      const pending = dispatch()
      await vi.advanceTimersByTimeAsync(300)
      db._tables.conversations[0].bot_lock_until = null
      await vi.advanceTimersByTimeAsync(300)

      expect(await pending).toEqual({ consumed: true })
      expect(sessionStatus(db, 'ses-menu')).toBe('active')
    })
  })
})
