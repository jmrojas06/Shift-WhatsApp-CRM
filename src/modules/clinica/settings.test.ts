import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { ensureClinicSetup, loadClinicContext } from './settings'

const ACCOUNT = 'acc-1'

const SETTINGS_ROW = {
  account_id: ACCOUNT,
  consent_text: 'Autorizo',
  consent_version: 3,
  urgency_words: ['dolor'],
  urgency_alarm_text: 'Signos',
  urgency_service_id: 'svc-u',
  offer_days: 45,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('configuración de la clínica', () => {
  it('sin fila de configuración dice que falta, no que falló', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDb({ clinic_settings: [], clinic_locations: [] })

    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toEqual({ status: 'missing' })
    expect(spy).toHaveBeenCalled()
  })

  it('si la lectura falla devuelve error, que no es lo mismo que faltar', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDb({ clinic_settings: [SETTINGS_ROW], clinic_locations: [] })
    db._failNext('select', 'clinic_settings', { message: 'conexión caída' })

    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toEqual({ status: 'error' })
    expect(spy).toHaveBeenCalled()
  })

  it.each([
    ['sin texto de autorización', { consent_text: '   ' }],
    ['con el texto de autorización nulo', { consent_text: null }],
    ['sin signos de alarma', { urgency_alarm_text: '' }],
  ])('una fila %s es un error: no se puede pedir una autorización vacía', async (_name, patch) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDb({ clinic_settings: [{ ...SETTINGS_ROW, ...patch }], clinic_locations: [] })

    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toEqual({ status: 'error' })
  })

  it('lee la configuración y la primera sede activa de la cuenta', async () => {
    const db = makeFakeDb({
      clinic_settings: [SETTINGS_ROW],
      clinic_locations: [
        { id: 'otra', account_id: 'acc-2', name: 'Ajena', is_active: true },
        { id: 'inactiva', account_id: ACCOUNT, name: 'Vieja', is_active: false },
        { id: 'loc-1', account_id: ACCOUNT, name: 'Centro', address: 'Calle 1', is_active: true },
      ],
    })
    const result = await loadClinicContext(asClient(db), ACCOUNT)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.clinic).toMatchObject({
      consentText: 'Autorizo',
      consentVersion: 3,
      urgencyWords: ['dolor'],
      urgencyServiceId: 'svc-u',
      offerDays: 45,
      location: { id: 'loc-1', name: 'Centro', address: 'Calle 1' },
    })
  })

  it('sin sede activa sigue siendo válida: la autorización y las urgencias no dependen de ella', async () => {
    const db = makeFakeDb({ clinic_settings: [SETTINGS_ROW], clinic_locations: [] })

    const result = await loadClinicContext(asClient(db), ACCOUNT)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.clinic.location).toBeNull()
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
    expect(db._tables.clinic_locations[0].name).toBe('Principal')
  })

  it('si otro montaje creó la configuración justo antes, no falla ni la pisa', async () => {
    const db = makeFakeDb({
      clinic_settings: [{ ...SETTINGS_ROW, consent_text: 'Texto ajustado por Shift' }],
      clinic_locations: [{ id: 'loc-1', account_id: ACCOUNT, name: 'Centro', is_active: true }],
    })
    // El montaje lee ANTES de que la otra fila aparezca: la primera lectura no ve nada.
    let firstRead = true
    const racing = {
      ...db,
      from(table: string) {
        if (table === 'clinic_settings' && firstRead) {
          firstRead = false
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          }
        }
        return db.from(table)
      },
    }

    await expect(ensureClinicSetup(racing as unknown as SupabaseClient, ACCOUNT)).resolves.toBeUndefined()

    expect(db._tables.clinic_settings).toHaveLength(1)
    expect(db._tables.clinic_settings[0].consent_text).toBe('Texto ajustado por Shift')
  })
})
