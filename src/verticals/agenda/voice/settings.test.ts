import { afterEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import {
  DEFAULT_CALL_SETTINGS,
  DEFAULT_VOICE,
  callSettingsFromRow,
  callSettingsToRow,
  isValidCallWindow,
  loadCallSettings,
  resolveVoice,
  validateCallSettingsPatch,
  type CallSettingsPatch,
} from './settings'

const ACCOUNT = 'acc-1'

const ROW = {
  account_id: ACCOUNT,
  provider: 'telnyx',
  outbound_enabled: true,
  inbound_enabled: true,
  inbound_number: '+576015550000',
  caller_id: '+576015550001',
  advisor_phones: ['+573001112233', '+573004445566'],
  office_hours: { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
  info_text: 'Calle 1 # 2-3',
  call_after_minutes: 240,
  min_lead_minutes: 90,
  max_attempts: 3,
  retry_minutes: 60,
  window_start: '09:00',
  window_end: '18:00',
  call_saturday: false,
  monthly_limit: 150,
  voice: 'Azure.es-CO-SalomeNeural',
  updated_at: '2026-11-05T15:00:00Z',
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('DEFAULT_CALL_SETTINGS', () => {
  it('todo apagado y con los valores del diseño', () => {
    expect(DEFAULT_CALL_SETTINGS).toEqual({
      provider: 'telnyx',
      outboundEnabled: false,
      inboundEnabled: false,
      inboundNumber: null,
      callerId: null,
      advisorPhones: [],
      officeHours: {},
      infoText: '',
      callAfterMinutes: 180,
      minLeadMinutes: 120,
      maxAttempts: 2,
      retryMinutes: 90,
      windowStart: '08:00',
      windowEnd: '19:00',
      callSaturday: true,
      monthlyLimit: 300,
      voice: null,
      updatedAt: null,
    })
  })
})

describe('callSettingsFromRow', () => {
  it('sin fila usa los valores por defecto (copia nueva)', () => {
    const settings = callSettingsFromRow(null)
    expect(settings).toEqual(DEFAULT_CALL_SETTINGS)
    settings.advisorPhones.push('+573000000000')
    expect(DEFAULT_CALL_SETTINGS.advisorPhones).toEqual([])
  })

  it('lee una fila completa', () => {
    expect(callSettingsFromRow(ROW)).toEqual({
      provider: 'telnyx',
      outboundEnabled: true,
      inboundEnabled: true,
      inboundNumber: '+576015550000',
      callerId: '+576015550001',
      advisorPhones: ['+573001112233', '+573004445566'],
      officeHours: { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
      infoText: 'Calle 1 # 2-3',
      callAfterMinutes: 240,
      minLeadMinutes: 90,
      maxAttempts: 3,
      retryMinutes: 60,
      windowStart: '09:00',
      windowEnd: '18:00',
      callSaturday: false,
      monthlyLimit: 150,
      voice: 'Azure.es-CO-SalomeNeural',
      updatedAt: '2026-11-05T15:00:00Z',
    })
  })

  it('una fila dañada nunca prende nada ni lanza', () => {
    const settings = callSettingsFromRow({
      outbound_enabled: 'true',
      inbound_enabled: 1,
      inbound_number: '3001234567',
      caller_id: 42,
      advisor_phones: 'no-es-lista',
      office_hours: 'texto',
      info_text: null,
      call_after_minutes: 'mucho',
      max_attempts: 99,
      window_start: 'x',
      window_end: null,
      call_saturday: 'sí',
      monthly_limit: -5,
      voice: '   ',
    })
    expect(settings.outboundEnabled).toBe(false)
    expect(settings.inboundEnabled).toBe(false)
    expect(settings.inboundNumber).toBeNull()
    expect(settings.callerId).toBeNull()
    expect(settings.advisorPhones).toEqual([])
    expect(settings.officeHours).toEqual({})
    expect(settings.infoText).toBe('')
    expect(settings.callAfterMinutes).toBe(180)
    expect(settings.maxAttempts).toBe(2)
    expect(settings.windowStart).toBe('08:00')
    expect(settings.windowEnd).toBe('19:00')
    expect(settings.callSaturday).toBe(true)
    expect(settings.monthlyLimit).toBe(300)
    expect(settings.voice).toBeNull()
  })

  it('descarta teléfonos de asesor inválidos o repetidos y se queda con tres', () => {
    expect(
      callSettingsFromRow({
        advisor_phones: ['+573001112233', 'malo', '+573001112233', '+573004445566', '+573007778899', '+573009990000'],
      }).advisorPhones,
    ).toEqual(['+573001112233', '+573004445566', '+573007778899'])
  })

  it('acepta horas con segundos (columna time) y las normaliza', () => {
    const settings = callSettingsFromRow({ window_start: '08:30:00', window_end: '19:00:00' })
    expect([settings.windowStart, settings.windowEnd]).toEqual(['08:30', '19:00'])
  })

  it('una ventana al revés vuelve a la de por defecto', () => {
    const settings = callSettingsFromRow({ window_start: '19:00', window_end: '08:00' })
    expect([settings.windowStart, settings.windowEnd]).toEqual(['08:00', '19:00'])
  })
})

describe('loadCallSettings', () => {
  it('sin fila devuelve los valores por defecto', async () => {
    const db = makeFakeDb({ booking_call_settings: [] })
    await expect(loadCallSettings(asClient(db), ACCOUNT)).resolves.toEqual(DEFAULT_CALL_SETTINGS)
  })

  it('lee la fila de la cuenta y no la de otra', async () => {
    const db = makeFakeDb({
      booking_call_settings: [{ ...ROW, account_id: 'acc-2', inbound_number: '+576019999999' }, ROW],
    })
    const settings = await loadCallSettings(asClient(db), ACCOUNT)
    expect(settings.inboundNumber).toBe('+576015550000')
    expect(settings.outboundEnabled).toBe(true)
  })

  it('si la lectura falla, lanza (no se confunde con "sin configurar")', async () => {
    const db = makeFakeDb({ booking_call_settings: [ROW] })
    db._failNext('select', 'booking_call_settings', { message: 'conexión caída' })
    await expect(loadCallSettings(asClient(db), ACCOUNT)).rejects.toThrow(/conexión caída/)
  })
})

describe('resolveVoice', () => {
  it('la de la cuenta, si no la de la plataforma, si no Polly Mia', () => {
    expect(resolveVoice({ voice: 'Azure.es-CO-SalomeNeural' }, { VOICE_DEFAULT_VOICE: 'Polly.Lupe-Neural' })).toBe(
      'Azure.es-CO-SalomeNeural',
    )
    expect(resolveVoice({ voice: null }, { VOICE_DEFAULT_VOICE: 'Polly.Lupe-Neural' })).toBe('Polly.Lupe-Neural')
    expect(resolveVoice({ voice: null }, { VOICE_DEFAULT_VOICE: '  ' })).toBe(DEFAULT_VOICE)
    expect(resolveVoice({ voice: null }, {})).toBe('Polly.Mia-Neural')
  })

  it('por defecto lee process.env', () => {
    vi.stubEnv('VOICE_DEFAULT_VOICE', 'Polly.Pedro-Neural')
    expect(resolveVoice({ voice: null })).toBe('Polly.Pedro-Neural')
  })
})

describe('isValidCallWindow', () => {
  it('el inicio debe ser antes que el fin', () => {
    expect(isValidCallWindow('08:00', '19:00')).toBe(true)
    expect(isValidCallWindow('19:00', '08:00')).toBe(false)
    expect(isValidCallWindow('08:00', '08:00')).toBe(false)
    expect(isValidCallWindow('x', '08:00')).toBe(false)
  })
})

function ok(body: unknown): CallSettingsPatch {
  const result = validateCallSettingsPatch(body)
  if (!result.ok) throw new Error(`Se esperaba válido: ${result.message}`)
  return result.value
}

function bad(body: unknown): string {
  const result = validateCallSettingsPatch(body)
  if (result.ok) throw new Error('Se esperaba un error')
  return result.message
}

describe('validateCallSettingsPatch', () => {
  it('acepta un parche válido y lo devuelve en camelCase', () => {
    expect(
      ok({
        outbound_enabled: true,
        inbound_enabled: false,
        inbound_number: '+57 601 555 0000',
        caller_id: null,
        advisor_phones: ['+57 300 111 2233', '+573004445566'],
        office_hours: { '1': [['8:00', '18:00']], '6': [['08:00', '13:00']] },
        info_text: '  Calle 1 # 2-3  ',
        call_after_minutes: 120,
        min_lead_minutes: 60,
        max_attempts: 3,
        retry_minutes: 45,
        window_start: '8:30',
        window_end: '18:30',
        call_saturday: false,
        monthly_limit: 500,
        voice: 'Polly.Mia-Neural',
      }),
    ).toEqual({
      outboundEnabled: true,
      inboundEnabled: false,
      inboundNumber: '+576015550000',
      callerId: null,
      advisorPhones: ['+573001112233', '+573004445566'],
      officeHours: { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
      infoText: 'Calle 1 # 2-3',
      callAfterMinutes: 120,
      minLeadMinutes: 60,
      maxAttempts: 3,
      retryMinutes: 45,
      windowStart: '08:30',
      windowEnd: '18:30',
      callSaturday: false,
      monthlyLimit: 500,
      voice: 'Polly.Mia-Neural',
    })
  })

  it('un parche parcial solo trae lo que se mandó', () => {
    expect(ok({ call_saturday: false })).toEqual({ callSaturday: false })
  })

  it('ignora provider y updated_at (solo lectura) pero no deja pasar claves desconocidas', () => {
    expect(ok({ provider: 'telnyx', updated_at: 'x', call_saturday: true })).toEqual({ callSaturday: true })
    expect(bad({ outbond_enabled: true })).toMatch(/outbond_enabled/)
  })

  it('un cuerpo vacío o que no es un objeto no es un cambio', () => {
    expect(bad({})).toMatch(/cambios/i)
    expect(bad({ provider: 'telnyx' })).toMatch(/cambios/i)
    for (const body of [null, 'x', 7, [1], undefined]) expect(bad(body)).toMatch(/no son válidos/i)
  })

  it('los interruptores son sí o no, sin coerción', () => {
    for (const key of ['outbound_enabled', 'inbound_enabled', 'call_saturday']) {
      expect(bad({ [key]: 'true' })).toMatch(/sí o no/i)
      expect(bad({ [key]: 1 })).toMatch(/sí o no/i)
      expect(bad({ [key]: null })).toMatch(/sí o no/i)
    }
  })

  describe('teléfonos', () => {
    it('E.164 con el + obligatorio; tolera espacios, guiones y paréntesis', () => {
      expect(ok({ inbound_number: '+57 (601) 555-0000' }).inboundNumber).toBe('+576015550000')
      expect(bad({ inbound_number: '6015550000' })).toMatch(/\+57/)
      expect(bad({ inbound_number: '+0123456789' })).toMatch(/indicativo/i)
      expect(bad({ inbound_number: '+57abc' })).toMatch(/indicativo/i)
      expect(bad({ caller_id: '123' })).toMatch(/indicativo/i)
      expect(bad({ inbound_number: 573001234567 })).toMatch(/indicativo/i)
    })

    it('null o texto en blanco borran el número', () => {
      expect(ok({ inbound_number: null }).inboundNumber).toBeNull()
      expect(ok({ inbound_number: '   ' }).inboundNumber).toBeNull()
      expect(ok({ caller_id: '' }).callerId).toBeNull()
    })

    it('de 0 a 3 asesores, sin repetidos', () => {
      expect(ok({ advisor_phones: [] }).advisorPhones).toEqual([])
      expect(ok({ advisor_phones: ['+573001112233', '+57 300 111 2233'] }).advisorPhones).toEqual(['+573001112233'])
      expect(
        bad({ advisor_phones: ['+573001112233', '+573004445566', '+573007778899', '+573009990000'] }),
      ).toMatch(/hasta 3/i)
      expect(bad({ advisor_phones: ['+573001112233', 'malo'] })).toMatch(/indicativo/i)
      expect(bad({ advisor_phones: '+573001112233' })).toMatch(/lista/i)
      expect(bad({ advisor_phones: null })).toMatch(/lista/i)
    })
  })

  describe('horario de atención', () => {
    it('normaliza, ordena y descarta los días sin tramos', () => {
      expect(
        ok({
          office_hours: {
            '1': [
              ['14:00', '18:00'],
              ['8:00', '12:00'],
            ],
            '2': [],
          },
        }).officeHours,
      ).toEqual({
        '1': [
          ['08:00', '12:00'],
          ['14:00', '18:00'],
        ],
      })
      expect(ok({ office_hours: {} }).officeHours).toEqual({})
    })

    it.each([
      ['no es un objeto', 'lunes a viernes'],
      ['es una lista', [['08:00', '18:00']]],
      ['trae un día que no existe', { '7': [['08:00', '18:00']] }],
      ['trae el día con nombre', { lunes: [['08:00', '18:00']] }],
      ['un día no es lista', { '1': 'todo el día' }],
      ['un tramo no tiene dos horas', { '1': [['08:00']] }],
      ['una hora no es HH:MM', { '1': [['8am', '18:00']] }],
      ['la hora no existe', { '1': [['08:00', '25:00']] }],
      ['abre después de cerrar', { '1': [['18:00', '08:00']] }],
      ['abre y cierra a la vez', { '1': [['08:00', '08:00']] }],
      ['los tramos se cruzan', { '1': [['08:00', '12:00'], ['11:00', '14:00']] }],
      ['tiene demasiados tramos', { '1': [['01:00', '02:00'], ['03:00', '04:00'], ['05:00', '06:00'], ['07:00', '08:00'], ['09:00', '10:00']] }],
    ])('rechaza el horario si %s', (_name, hours) => {
      expect(bad({ office_hours: hours })).toMatch(/horario|tramo|día|hora/i)
    })

    it('el mensaje de un tramo cruzado dice qué día', () => {
      expect(bad({ office_hours: { '3': [['08:00', '12:00'], ['11:00', '14:00']] } })).toMatch(/miércoles/)
    })
  })

  describe('texto de horario y dirección', () => {
    it('hasta 500 caracteres, contando emoji como uno', () => {
      expect(ok({ info_text: 'a'.repeat(500) }).infoText).toHaveLength(500)
      expect(bad({ info_text: 'a'.repeat(501) })).toMatch(/500/)
      expect(ok({ info_text: '😀'.repeat(500) }).infoText).toBe('😀'.repeat(500))
      expect(bad({ info_text: '😀'.repeat(501) })).toMatch(/500/)
    })

    it('null o en blanco queda vacío, y se quitan los caracteres que la base no admite', () => {
      expect(ok({ info_text: null }).infoText).toBe('')
      expect(ok({ info_text: '   ' }).infoText).toBe('')
      expect(ok({ info_text: 'a\u0000b\nc' }).infoText).toBe('ab\nc')
      expect(bad({ info_text: 5 })).toMatch(/texto/i)
    })
  })

  describe('números enteros', () => {
    it.each([
      ['call_after_minutes', 0, 2880],
      ['min_lead_minutes', 0, 4320],
      ['max_attempts', 1, 3],
      ['retry_minutes', 1, 2880],
      ['monthly_limit', 0, 100000],
    ])('%s va de %i a %i', (key, min, max) => {
      expect(Object.values(ok({ [key]: min }))[0]).toBe(min)
      expect(Object.values(ok({ [key]: max }))[0]).toBe(max)
      expect(bad({ [key]: min - 1 })).toMatch(new RegExp(`${min}.*${max}|entre ${min}`))
      expect(bad({ [key]: max + 1 })).toMatch(new RegExp(`${max}`))
    })

    it('solo enteros: nada de decimales, textos, NaN ni nulos', () => {
      for (const value of [1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, null, true]) {
        expect(bad({ max_attempts: value })).toMatch(/número entero/i)
      }
    })
  })

  describe('ventana de llamadas', () => {
    it('horas HH:MM, normalizadas', () => {
      expect(ok({ window_start: '7:05' }).windowStart).toBe('07:05')
      expect(bad({ window_start: '25:00' })).toMatch(/HH:MM/)
      expect(bad({ window_end: '7pm' })).toMatch(/HH:MM/)
      expect(bad({ window_end: null })).toMatch(/HH:MM/)
    })

    it('si vienen las dos, el inicio va antes que el fin', () => {
      expect(ok({ window_start: '08:00', window_end: '19:00' })).toEqual({ windowStart: '08:00', windowEnd: '19:00' })
      expect(bad({ window_start: '19:00', window_end: '08:00' })).toMatch(/antes/i)
      expect(bad({ window_start: '10:00', window_end: '10:00' })).toMatch(/antes/i)
    })
  })

  describe('voz', () => {
    it('un nombre de voz razonable o null (la de la plataforma)', () => {
      expect(ok({ voice: 'Azure.es-CO-SalomeNeural' }).voice).toBe('Azure.es-CO-SalomeNeural')
      expect(ok({ voice: null }).voice).toBeNull()
      expect(ok({ voice: '  ' }).voice).toBeNull()
      expect(bad({ voice: 'voz con espacios y "comillas"' })).toMatch(/voz/i)
      expect(bad({ voice: 'x'.repeat(81) })).toMatch(/voz/i)
      expect(bad({ voice: 7 })).toMatch(/voz/i)
    })
  })
})

describe('callSettingsToRow', () => {
  it('pasa a nombres de columna y deja el texto vacío como null', () => {
    expect(
      callSettingsToRow({
        outboundEnabled: true,
        inboundNumber: '+576015550000',
        advisorPhones: ['+573001112233'],
        officeHours: { '1': [['08:00', '18:00']] },
        infoText: '',
        callAfterMinutes: 120,
        windowStart: '08:30',
        callSaturday: false,
        voice: null,
      }),
    ).toEqual({
      outbound_enabled: true,
      inbound_number: '+576015550000',
      advisor_phones: ['+573001112233'],
      office_hours: { '1': [['08:00', '18:00']] },
      info_text: null,
      call_after_minutes: 120,
      window_start: '08:30',
      call_saturday: false,
      voice: null,
    })
  })

  it('un parche vacío da una fila vacía', () => {
    expect(callSettingsToRow({})).toEqual({})
  })

  it('ida y vuelta: lo que valida el parche se puede leer como fila', () => {
    const patch = ok({ advisor_phones: ['+573001112233'], max_attempts: 3, voice: 'Polly.Mia-Neural' })
    const row = callSettingsToRow(patch)
    const settings = callSettingsFromRow({ ...ROW, ...row })
    expect(settings.advisorPhones).toEqual(['+573001112233'])
    expect(settings.maxAttempts).toBe(3)
    expect(settings.voice).toBe('Polly.Mia-Neural')
  })
})
