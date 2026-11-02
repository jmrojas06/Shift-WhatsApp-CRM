import { describe, expect, it } from 'vitest'

import { contactDeleteToastKey } from './delete-error'

describe('contactDeleteToastKey', () => {
  it('23503 (contacto con paciente): mensaje propio, individual y masivo', () => {
    expect(contactDeleteToastKey({ code: '23503' }, false)).toBe('toastPatientContact')
    expect(contactDeleteToastKey({ code: '23503' }, true)).toBe('toastBulkPatientContact')
  })

  it('cualquier otro error: el mensaje genérico de siempre', () => {
    for (const code of ['42501', '23505', 'PGRST301', undefined, null]) {
      expect(contactDeleteToastKey({ code }, false)).toBe('toastFailedDelete')
      expect(contactDeleteToastKey({ code }, true)).toBe('toastBulkFailedDelete')
    }
  })
})
