import { describe, expect, it } from 'vitest'

import { asClient, makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { ensureClinicSetup, loadClinicContext } from './settings'

const ACCOUNT = 'acc-1'

describe('configuración de la clínica', () => {
  it('sin fila de configuración devuelve null', async () => {
    const db = makeFakeDb({ clinic_settings: [], clinic_locations: [] })
    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toBeNull()
  })

  it('lee la configuración y la primera sede activa de la cuenta', async () => {
    const db = makeFakeDb({
      clinic_settings: [
        {
          account_id: ACCOUNT,
          consent_text: 'Autorizo',
          consent_version: 3,
          urgency_words: ['dolor'],
          urgency_alarm_text: 'Signos',
          urgency_service_id: 'svc-u',
          offer_days: 45,
        },
      ],
      clinic_locations: [
        { id: 'otra', account_id: 'acc-2', name: 'Ajena', is_active: true },
        { id: 'inactiva', account_id: ACCOUNT, name: 'Vieja', is_active: false },
        { id: 'loc-1', account_id: ACCOUNT, name: 'Centro', address: 'Calle 1', is_active: true },
      ],
    })
    const clinic = await loadClinicContext(asClient(db), ACCOUNT)
    expect(clinic).toMatchObject({
      consentText: 'Autorizo',
      consentVersion: 3,
      urgencyWords: ['dolor'],
      urgencyServiceId: 'svc-u',
      offerDays: 45,
      location: { id: 'loc-1', name: 'Centro', address: 'Calle 1' },
    })
  })

  it('el montaje crea lo que falta una sola vez y enlaza la atención de urgencia', async () => {
    const db = makeFakeDb({
      clinic_settings: [],
      clinic_locations: [],
      booking_services: [
        { id: 'svc-u', account_id: ACCOUNT, name: 'Urgencia' },
        { id: 'svc-x', account_id: 'acc-2', name: 'Urgencia' },
      ],
    })
    await ensureClinicSetup(asClient(db), ACCOUNT)
    await ensureClinicSetup(asClient(db), ACCOUNT)

    expect(db._tables.clinic_settings).toHaveLength(1)
    expect(db._tables.clinic_settings[0].urgency_service_id).toBe('svc-u')
    expect(db._tables.clinic_settings[0].consent_version).toBe(1)
    expect(db._tables.clinic_locations).toHaveLength(1)
    expect(db._tables.clinic_locations[0].name).toBe('Sede principal')
  })
})
