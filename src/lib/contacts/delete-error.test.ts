import { describe, expect, it } from 'vitest'

import { contactDeleteToastKey } from './delete-error'

const PATIENT_MESSAGE =
  'update or delete on table "contacts" violates foreign key constraint "clinic_patients_contact_id_fkey" on table "clinic_patients"'

describe('contactDeleteToastKey', () => {
  it('23503 por clinic_patients (contacto con paciente): mensaje propio, individual y masivo', () => {
    const error = { code: '23503', message: PATIENT_MESSAGE }
    expect(contactDeleteToastKey(error, false)).toBe('toastPatientContact')
    expect(contactDeleteToastKey(error, true)).toBe('toastBulkPatientContact')
  })

  it.each([
    // Borrar un contacto borra su conversación en cascada, y deals.conversation_id
    // no tiene ON DELETE: es un 23503 que nada tiene que ver con la clínica.
    'update or delete on table "conversations" violates foreign key constraint "deals_conversation_id_fkey" on table "deals"',
    'insert or update on table "deals" violates foreign key constraint "deals_conversation_id_fkey" on table "deals"',
  ])('23503 por otra tabla (%#): el mensaje genérico, no el de paciente', (message) => {
    const error = { code: '23503', message }
    expect(contactDeleteToastKey(error, false)).toBe('toastFailedDelete')
    expect(contactDeleteToastKey(error, true)).toBe('toastBulkFailedDelete')
  })

  it('23503 sin mensaje: el genérico', () => {
    for (const message of [undefined, null, '']) {
      expect(contactDeleteToastKey({ code: '23503', message }, false)).toBe('toastFailedDelete')
      expect(contactDeleteToastKey({ code: '23503', message }, true)).toBe('toastBulkFailedDelete')
    }
  })

  it('cualquier otro código: el genérico, aunque el mensaje nombre a clinic_patients', () => {
    for (const code of ['42501', '23505', 'PGRST301', undefined, null]) {
      expect(contactDeleteToastKey({ code, message: PATIENT_MESSAGE }, false)).toBe(
        'toastFailedDelete',
      )
      expect(contactDeleteToastKey({ code, message: PATIENT_MESSAGE }, true)).toBe(
        'toastBulkFailedDelete',
      )
    }
  })
})
