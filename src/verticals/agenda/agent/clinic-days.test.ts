import { describe, expect, it } from 'vitest'

import { patId, svcId } from './state'
import {
  ACCOUNT,
  CONTACT,
  SERVICE_LIMPIEZA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import type { FakeDb } from './testing/fake-db'

async function openDayMenu() {
  const db = clinicDb({
    clinic_consents: [grantedConsent()],
    clinic_patients: [{ id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' }],
  })
  const rec = makeRecorder()
  await send(db, rec, { text: 'Hola' })
  await send(db, rec, { replyId: 'act:book' })
  await send(db, rec, { replyId: patId('pat-1') })
  await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
  return { db, rec }
}

/** Estado guardado de la sesión abierta (lo que se escribió en la base, no lo que hay en memoria). */
const savedState = (db: FakeDb) =>
  db._tables.booking_sessions.find((s) => s.status === 'active')?.state as
    | Record<string, unknown>
    | undefined

const dayIds = (ids: string[]) => ids.filter((id) => id.startsWith('day:'))

describe('citas lejanas', () => {
  it('muestra 9 días y "Ver más días" cuando hay más', async () => {
    const { rec } = await openDayMenu()
    expect(last(rec).ids).toHaveLength(10)
    expect(last(rec).ids.at(-1)).toBe('act:more_days')
    expect(last(rec).titles.at(-1)).toBe('Ver más días')
  })

  it('"Ver más días" pasa a la siguiente página', async () => {
    const { db, rec } = await openDayMenu()
    const first = last(rec).ids
    await send(db, rec, { replyId: 'act:more_days' })
    expect(last(rec).ids[0]).not.toBe(first[0])
    expect(last(rec).ids.filter((id) => first.includes(id) && id.startsWith('day:'))).toEqual([])
  })

  it('llega hasta offer_days y se detiene', async () => {
    const { db, rec } = await openDayMenu()
    db._tables.clinic_settings[0].offer_days = 10
    await send(db, rec, { replyId: 'act:more_days' })
    expect(last(rec).ids).not.toContain('act:more_days')
  })

  it('recorre todas las páginas sin repetir ni saltarse días, y la última no ofrece más', async () => {
    const { db, rec } = await openDayMenu()
    const seen = dayIds(last(rec).ids)
    let pages = 1
    while (last(rec).ids.includes('act:more_days') && pages < 10) {
      await send(db, rec, { replyId: 'act:more_days' })
      pages += 1
      seen.push(...dayIds(last(rec).ids))
    }
    expect(pages).toBe(3)
    expect(last(rec).ids).not.toContain('act:more_days')
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort()).toEqual(seen)
    // Lunes a viernes entre el 19 de octubre y el 17 de noviembre: 22 días con hora.
    expect(seen).toHaveLength(22)
  })

  it('si la agenda se acorta y la página queda vacía, vuelve a la primera', async () => {
    const { db, rec } = await openDayMenu()
    await send(db, rec, { replyId: 'act:more_days' })
    await send(db, rec, { replyId: 'act:more_days' })
    expect(savedState(db)).toMatchObject({ step: 'pick_day', dayPage: 2 })
    db._tables.clinic_settings[0].offer_days = 10
    // Con 10 días solo caben 8 con hora: la página 3 no existe.
    await send(db, rec, { replyId: 'act:more_days' })
    expect(dayIds(last(rec).ids)).toHaveLength(8)
    expect(last(rec).ids).not.toContain('act:more_days')
    expect(savedState(db)).not.toHaveProperty('dayPage')
  })

  it('la primera página no guarda dayPage en la sesión', async () => {
    const { db } = await openDayMenu()
    expect(savedState(db)).toMatchObject({ step: 'pick_day' })
    expect(savedState(db)).not.toHaveProperty('dayPage')
  })

  it('elegir un día de la segunda página sigue el flujo normal', async () => {
    const { db, rec } = await openDayMenu()
    await send(db, rec, { replyId: 'act:more_days' })
    const chosen = dayIds(last(rec).ids)[0]
    await send(db, rec, { replyId: chosen })
    expect(savedState(db)).toMatchObject({ step: 'pick_slot', dateKey: chosen.slice('day:'.length) })
    expect(last(rec).ids.every((id) => id.startsWith('slot:'))).toBe(true)
  })

  it('"Reprogramar" desde el resumen vuelve a la primera página de días', async () => {
    const { db, rec } = await openDayMenu()
    const first = last(rec).ids
    await send(db, rec, { replyId: 'act:more_days' })
    await send(db, rec, { replyId: dayIds(last(rec).ids)[0] }) // día de la página 2
    await send(db, rec, { replyId: last(rec).ids[0] }) // hora
    expect(last(rec).ids).toContain('act:reschedule')
    await send(db, rec, { replyId: 'act:reschedule' })
    expect(last(rec).ids).toEqual(first)
    expect(savedState(db)).toMatchObject({ step: 'pick_day' })
    expect(savedState(db)).not.toHaveProperty('dayPage')
  })

  it('una cuenta sin clínica ve el mismo menú de 7 días y no guarda dayPage', async () => {
    const db = clinicDb()
    db._tables.booking_sessions.push({
      id: 'ses-1',
      account_id: ACCOUNT,
      contact_id: CONTACT,
      status: 'active',
      expires_at: '2026-10-19T13:10:00.000Z',
      state: { step: 'pick_service', mode: 'book', options: [{ id: svcId(SERVICE_LIMPIEZA), title: 'Limpieza' }], fails: 0 },
    })
    const rec = makeRecorder()
    await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) }, { modules: ['agenda'] })
    // 7 días desde hoy (19 al 25 de octubre): de lunes a viernes hay hora, 5 días.
    expect(dayIds(last(rec).ids)).toHaveLength(5)
    expect(last(rec).ids).not.toContain('act:more_days')
    expect(last(rec).ids.every((id) => id.startsWith('day:'))).toBe(true)
    expect(savedState(db)).toMatchObject({ step: 'pick_day' })
    expect(savedState(db)).not.toHaveProperty('dayPage')
  })
})
