import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { canUseAi } from './ai-gate'

const ACCOUNT = 'acc-1'
const CONTACT = 'ct-1'

const consent = (overrides: Row = {}): Row => ({
  id: crypto.randomUUID(),
  account_id: ACCOUNT,
  contact_id: CONTACT,
  contact_ref: '573001112233',
  kind: 'datos_sensibles',
  granted: true,
  text_version: 1,
  text_snapshot: 'Texto',
  source: 'whatsapp',
  created_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

function dbWith(account: Row | null, consents: Row[] = []): FakeDb {
  return makeFakeDb({
    accounts: account ? [{ id: ACCOUNT, ...account }] : [],
    clinic_consents: consents,
  })
}

const can = (db: FakeDb) => canUseAi(asClient(db), { accountId: ACCOUNT, contactId: CONTACT })

describe('canUseAi', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('una cuenta sin el módulo clínica usa la IA sin más', async () => {
    expect(await can(dbWith({ modules: ['agenda'], vertical_key: 'agenda' }))).toBe(true)
    expect(await can(dbWith({ modules: [], vertical_key: 'barberia' }))).toBe(true)
    expect(await can(dbWith({ modules: ['agenda', 'ventas'], vertical_key: 'agenda' }))).toBe(true)
  })

  it('una cuenta sin el módulo no mira las autorizaciones', async () => {
    const db = dbWith({ modules: ['agenda'] })
    db._failNext('select', 'clinic_consents', { message: 'no debería leerse' })
    expect(await can(db)).toBe(true)
  })

  it('con el módulo, sin autorización, no', async () => {
    expect(await can(dbWith({ modules: ['agenda', 'clinica'] }))).toBe(false)
  })

  it('con el módulo y la autorización dada, sí', async () => {
    expect(await can(dbWith({ modules: ['agenda', 'clinica'] }, [consent()]))).toBe(true)
  })

  it('con el módulo y la autorización rechazada, no', async () => {
    expect(await can(dbWith({ modules: ['agenda', 'clinica'] }, [consent({ granted: false })]))).toBe(false)
  })

  it('vale la decisión más reciente', async () => {
    const accepted = consent({ granted: true, created_at: '2026-10-01T00:00:00.000Z' })
    const refused = consent({ granted: false, created_at: '2026-10-10T00:00:00.000Z' })
    expect(await can(dbWith({ modules: ['clinica'] }, [accepted, refused]))).toBe(false)
    expect(await can(dbWith({ modules: ['clinica'] }, [refused, { ...accepted, created_at: '2026-10-20T00:00:00.000Z' }]))).toBe(true)
  })

  it('la autorización de otro contacto o de otro tipo no cuenta', async () => {
    const others = [
      consent({ contact_id: 'ct-2' }),
      consent({ kind: 'mercadeo' }),
      consent({ account_id: 'acc-2' }),
    ]
    expect(await can(dbWith({ modules: ['clinica'] }, others))).toBe(false)
  })

  it('una cuenta con clínica y sin agenda tampoco la usa sin autorización', async () => {
    expect(await can(dbWith({ modules: ['clinica'], vertical_key: null }))).toBe(false)
    expect(await can(dbWith({ modules: [], vertical_key: 'clinica' }))).toBe(false)
  })

  it('si no se pudo leer la cuenta, no (aunque no sea clínica)', async () => {
    const db = dbWith({ modules: ['agenda'] })
    db._failNext('select', 'accounts', { message: 'connection reset' })
    expect(await can(db)).toBe(false)
  })

  it('si no hay fila de la cuenta, no', async () => {
    expect(await can(dbWith(null))).toBe(false)
  })

  it('si no se pudo leer la autorización, no', async () => {
    const db = dbWith({ modules: ['clinica'] }, [consent()])
    db._failNext('select', 'clinic_consents', { message: 'timeout' })
    expect(await can(db)).toBe(false)
  })
})
