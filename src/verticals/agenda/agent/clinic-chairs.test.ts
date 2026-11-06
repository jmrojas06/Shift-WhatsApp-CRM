import { describe, expect, it } from 'vitest'

import { dayId, patId, slotId, svcId } from './state'
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

/** Martes 20 de octubre, 9:00 en Bogotá. */
const NINE = '2026-10-20T14:00:00.000Z'
const TEN = '2026-10-20T15:00:00.000Z'

/** Cita de otro profesional a las 9:00: ocupa una silla aunque la doctora Ana esté libre. */
const otherDentistAtNine = {
  id: 'ap-otro',
  account_id: ACCOUNT,
  contact_id: 'ct-otro',
  service_id: SERVICE_LIMPIEZA,
  staff_id: 'st-bruno',
  status: 'confirmed',
  starts_at: NINE,
  ends_at: '2026-10-20T14:30:00.000Z',
}

async function openSlotMenu(chairCount: number | null) {
  const db = clinicDb({
    clinic_consents: [grantedConsent()],
    clinic_patients: [{ id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' }],
    booking_appointments: [otherDentistAtNine],
  })
  db._tables.clinic_locations[0].chair_count = chairCount
  const rec = makeRecorder()
  await send(db, rec, { text: 'Hola' })
  await send(db, rec, { replyId: 'act:book' })
  await send(db, rec, { replyId: patId('pat-1') })
  await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
  await send(db, rec, { replyId: dayId('2026-10-20') })
  return { db, rec }
}

describe('cupo de sillones en el bot de la clínica', () => {
  it('con el cupo lleno a esa hora, el bot no la ofrece aunque la doctora esté libre', async () => {
    const { rec } = await openSlotMenu(1)
    expect(last(rec).ids).not.toContain(slotId(NINE))
    expect(last(rec).ids).toContain(slotId(TEN))
  })

  it('con una silla de sobra, la hora se ofrece', async () => {
    const { rec } = await openSlotMenu(2)
    expect(last(rec).ids).toContain(slotId(NINE))
  })

  it('sin cupo puesto en la sede, no se limita', async () => {
    const { rec } = await openSlotMenu(null)
    expect(last(rec).ids).toContain(slotId(NINE))
  })
})
