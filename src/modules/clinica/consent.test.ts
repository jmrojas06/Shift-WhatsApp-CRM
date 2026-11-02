import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb, type FakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { latestConsent, recordConsent } from './consent'

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const CONTACT = 'ct-1'

function consentRow(overrides: Record<string, unknown>) {
  return {
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
  }
}

const recordArgs = {
  accountId: ACCOUNT,
  contactId: CONTACT,
  kind: 'datos_sensibles' as const,
  granted: true,
  textVersion: 3,
  textSnapshot: 'Texto que vio',
  source: 'whatsapp' as const,
  createdAtIso: '2026-10-19T13:00:00.000Z',
}

describe('latestConsent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('sin registros, no hay decisión', async () => {
    const db = makeFakeDb({ clinic_consents: [] })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toBeNull()
  })

  it('vale la más reciente, no la primera', async () => {
    const db = makeFakeDb({
      clinic_consents: [
        consentRow({ granted: true, created_at: '2026-10-01T00:00:00.000Z' }),
        consentRow({ granted: false, created_at: '2026-10-10T00:00:00.000Z' }),
      ],
    })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toEqual({ granted: false })
  })

  it('no mezcla tipos, contactos ni cuentas', async () => {
    const db = makeFakeDb({
      clinic_consents: [
        consentRow({ kind: 'mercadeo' }),
        consentRow({ contact_id: 'ct-2' }),
        consentRow({ account_id: OTHER_ACCOUNT }),
      ],
    })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toBeNull()
  })

  it('si no se pudo leer, no hay decisión (nunca "autorizó")', async () => {
    const db = makeFakeDb({ clinic_consents: [consentRow({ granted: true })] })
    db._failNext('select', 'clinic_consents', { message: 'timeout' })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toBeNull()
  })
})

describe('recordConsent', () => {
  let db: FakeDb

  beforeEach(() => {
    db = makeFakeDb({
      contacts: [
        { id: CONTACT, account_id: ACCOUNT, name: 'Marta', phone: ' 573001112233 ', wa_user_id: null },
        { id: 'ct-user', account_id: ACCOUNT, name: 'Luis', phone: '', wa_user_id: 'US.123' },
        { id: 'ct-none', account_id: ACCOUNT, name: 'Sin datos', phone: '', wa_user_id: null },
        { id: 'ct-other', account_id: OTHER_ACCOUNT, name: 'Ajena', phone: '573009998877' },
      ],
      clinic_consents: [],
    })
  })

  it('guarda quién autorizó, qué texto vio y desde dónde', async () => {
    await recordConsent(asClient(db), { ...recordArgs, messageId: 'wamid-9' })
    expect(db._tables.clinic_consents).toMatchObject([
      {
        account_id: ACCOUNT,
        contact_id: CONTACT,
        contact_ref: '573001112233',
        kind: 'datos_sensibles',
        granted: true,
        text_version: 3,
        text_snapshot: 'Texto que vio',
        source: 'whatsapp',
        message_id: 'wamid-9',
        created_at: '2026-10-19T13:00:00.000Z',
      },
    ])
  })

  it('sin mensaje de origen, guarda null', async () => {
    await recordConsent(asClient(db), recordArgs)
    expect(db._tables.clinic_consents[0].message_id).toBeNull()
  })

  it('sin teléfono, quién autorizó es su identificador de WhatsApp', async () => {
    await recordConsent(asClient(db), { ...recordArgs, contactId: 'ct-user' })
    expect(db._tables.clinic_consents[0].contact_ref).toBe('US.123')
  })

  it('sin teléfono ni identificador, lanza y no guarda nada', async () => {
    await expect(recordConsent(asClient(db), { ...recordArgs, contactId: 'ct-none' })).rejects.toThrow(
      'teléfono ni identificador',
    )
    expect(db._tables.clinic_consents).toHaveLength(0)
  })

  it('un contacto de otra cuenta no sirve de referencia', async () => {
    await expect(recordConsent(asClient(db), { ...recordArgs, contactId: 'ct-other' })).rejects.toThrow()
    expect(db._tables.clinic_consents).toHaveLength(0)
  })

  it('si no se pudo leer el contacto, lanza y no guarda nada', async () => {
    db._failNext('select', 'contacts', { message: 'timeout' })
    await expect(recordConsent(asClient(db), recordArgs)).rejects.toThrow('No se pudo leer el contacto')
    expect(db._tables.clinic_consents).toHaveLength(0)
  })

  it('si la base rechaza el registro, lanza', async () => {
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await expect(recordConsent(asClient(db), recordArgs)).rejects.toThrow(
      'No se pudo guardar la autorización: boom',
    )
    expect(db._tables.clinic_consents).toHaveLength(0)
  })
})
