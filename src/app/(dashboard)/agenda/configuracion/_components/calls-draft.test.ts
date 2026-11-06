import { describe, expect, it } from 'vitest'

import type { CallSettingsPayload } from '@/verticals/agenda/voice/call-settings-payload'

import {
  addHoursBlock,
  buildPatch,
  checkPatch,
  copyDayToWeekdays,
  draftFromSettings,
  findPatchProblem,
  previewOfficeHours,
  removeHoursBlock,
  setDayOpen,
  updateHoursBlock,
  type CallsDraft,
} from './calls-draft'

// ============================================================
// Borrador de la tarjeta "Llamadas": del servidor al formulario y de vuelta
// al parche con SOLO lo que cambió (el servidor rechaza los campos de Shift).
// ============================================================

const SETTINGS: CallSettingsPayload = {
  outbound_enabled: false,
  inbound_enabled: false,
  inbound_number: '+576015550100',
  caller_id: null,
  advisor_phones: ['+573001234567'],
  office_hours: { '1': [['08:00', '18:00']], '2': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
  info_text: 'Calle 10 # 5-20',
  call_after_minutes: 180,
  min_lead_minutes: 120,
  max_attempts: 2,
  retry_minutes: 90,
  window_start: '08:00',
  window_end: '19:00',
  call_saturday: true,
  monthly_limit: 300,
}

function draft(patch: Partial<CallsDraft> = {}): CallsDraft {
  return { ...draftFromSettings(SETTINGS), ...patch }
}

describe('draftFromSettings', () => {
  it('pasa lo del servidor al formulario, con los números como texto', () => {
    const result = draftFromSettings(SETTINGS)

    expect(result).toMatchObject({
      outboundEnabled: false,
      advisorPhones: ['+573001234567'],
      infoText: 'Calle 10 # 5-20',
      windowStart: '08:00',
      windowEnd: '19:00',
      callSaturday: true,
      maxAttempts: '2',
      retryMinutes: '90',
      callAfterMinutes: '180',
      minLeadMinutes: '120',
    })
    expect(result.hours[1]).toEqual([{ start: '08:00', end: '18:00' }])
    expect(result.hours[6]).toEqual([{ start: '08:00', end: '13:00' }])
    // Los días sin horario existen y están cerrados.
    expect(result.hours[0]).toEqual([])
    expect(result.hours[3]).toEqual([])
  })
})

describe('buildPatch', () => {
  it('sin cambios no manda nada', () => {
    expect(buildPatch(SETTINGS, draft())).toEqual({})
  })

  it('manda solo lo que cambió y nunca los campos de Shift', () => {
    const patch = buildPatch(SETTINGS, draft({ callSaturday: false, maxAttempts: '3' }))

    expect(patch).toEqual({ call_saturday: false, max_attempts: 3 })
    for (const key of ['provider', 'monthly_limit', 'inbound_number', 'caller_id']) {
      expect(patch).not.toHaveProperty(key)
    }
  })

  it('con una hora de la ventana cambiada manda las dos', () => {
    expect(buildPatch(SETTINGS, draft({ windowStart: '09:00' }))).toEqual({
      window_start: '09:00',
      window_end: '19:00',
    })
    expect(buildPatch(SETTINGS, draft({ windowEnd: '18:00' }))).toEqual({
      window_start: '08:00',
      window_end: '18:00',
    })
  })

  it('un teléfono escrito con espacios que es el mismo guardado no cuenta como cambio', () => {
    expect(buildPatch(SETTINGS, draft({ advisorPhones: ['+57 300 123 4567'] }))).toEqual({})
  })

  it('ignora las filas de teléfono vacías y manda los demás', () => {
    const patch = buildPatch(
      SETTINGS,
      draft({ advisorPhones: ['+573001234567', '  ', '+573009876543'] }),
    )

    expect(patch).toEqual({ advisor_phones: ['+573001234567', '+573009876543'] })
  })

  it('quitar todos los teléfonos manda una lista vacía', () => {
    expect(buildPatch(SETTINGS, draft({ advisorPhones: [''] }))).toEqual({ advisor_phones: [] })
  })

  it('un teléfono mal escrito viaja tal cual para que el validador lo explique', () => {
    const patch = buildPatch(SETTINGS, draft({ advisorPhones: ['3001234567'] }))

    expect(patch).toEqual({ advisor_phones: ['3001234567'] })
    expect(checkPatch(patch)).toContain('+')
  })

  it('el texto de horario se compara sin espacios sobrantes', () => {
    expect(buildPatch(SETTINGS, draft({ infoText: '  Calle 10 # 5-20  ' }))).toEqual({})
    expect(buildPatch(SETTINGS, draft({ infoText: 'Otra' }))).toEqual({ info_text: 'Otra' })
    expect(buildPatch(SETTINGS, draft({ infoText: '' }))).toEqual({ info_text: '' })
  })

  it('el horario cambia solo si cambia un tramo, sin importar el orden de escritura', () => {
    const same = draft()
    expect(buildPatch(SETTINGS, same)).toEqual({})

    const patch = buildPatch(SETTINGS, { ...same, hours: setDayOpen(same.hours, 3, true) })
    expect(patch.office_hours).toEqual({
      '1': [['08:00', '18:00']],
      '2': [['08:00', '18:00']],
      '3': [['08:00', '18:00']],
      '6': [['08:00', '13:00']],
    })
  })

  it('cerrar todos los días manda un horario vacío', () => {
    let hours = draftFromSettings(SETTINGS).hours
    for (const day of [1, 2, 6]) hours = setDayOpen(hours, day, false)

    expect(buildPatch(SETTINGS, draft({ hours }))).toEqual({ office_hours: {} })
  })

  it('un número vacío o con letras viaja como NaN y el validador lo rechaza', () => {
    for (const bad of ['', 'abc', '2.5', '-1']) {
      const patch = buildPatch(SETTINGS, draft({ retryMinutes: bad }))
      expect(Number.isNaN(patch.retry_minutes)).toBe(true)
      expect(checkPatch(patch)).toContain('número entero')
    }
  })

  it('prender un interruptor cambia solo ese campo', () => {
    expect(buildPatch(SETTINGS, draft({ outboundEnabled: true }))).toEqual({ outbound_enabled: true })
  })
})

describe('findPatchProblem', () => {
  it('un parche válido no tiene problema', () => {
    expect(findPatchProblem({ call_saturday: false })).toBeNull()
  })

  it.each([
    ['retry_minutes', Number.NaN, 'calls-retry'],
    ['retry_minutes', 0, 'calls-retry'], // los minutos entre intentos empiezan en 1
    ['call_after_minutes', Number.NaN, 'calls-after'],
    ['min_lead_minutes', 99999, 'calls-lead'],
  ])('%s = %s señala el campo %s', (key, value, fieldId) => {
    const problem = findPatchProblem({ [key]: value })

    expect(problem?.fieldIds).toEqual([fieldId])
    expect(problem?.message).toContain('número entero')
  })

  it('señala el campo que falla aunque el parche lleve otros válidos', () => {
    const problem = findPatchProblem({ call_saturday: false, call_after_minutes: 60, retry_minutes: 0 })

    expect(problem?.fieldIds).toEqual(['calls-retry'])
  })

  it('una ventana al revés señala las dos horas', () => {
    const problem = findPatchProblem({ window_start: '20:00', window_end: '08:00' })

    expect(problem?.message).toContain('antes que la de fin')
    expect(problem?.fieldIds).toEqual(['calls-window-start', 'calls-window-end'])
  })

  it('un texto de horario demasiado largo señala su campo', () => {
    expect(findPatchProblem({ info_text: 'x'.repeat(5000) })?.fieldIds).toEqual(['calls-info'])
  })

  it('un campo sin casilla propia (el horario) trae el mensaje y ningún campo', () => {
    const problem = findPatchProblem({ office_hours: { '1': [['18:00', '08:00']] } })

    expect(problem?.message).toContain('lunes')
    expect(problem?.fieldIds).toEqual([])
  })

  it('el mensaje es el mismo de checkPatch', () => {
    const patch = { retry_minutes: 0 }

    expect(findPatchProblem(patch)?.message).toBe(checkPatch(patch))
  })
})

describe('checkPatch', () => {
  it('un parche válido no tiene mensaje', () => {
    expect(checkPatch({ call_saturday: false })).toBeNull()
  })

  it('usa los mismos mensajes del servidor', () => {
    expect(checkPatch({ window_start: '20:00', window_end: '08:00' })).toContain('antes que la de fin')
    expect(checkPatch({ office_hours: { '1': [['18:00', '08:00']] } })).toContain('lunes')
  })

  it('un tramo con la hora vacía se explica', () => {
    const hours = updateHoursBlock(draftFromSettings(SETTINGS).hours, 1, 0, { start: '' })
    const patch = buildPatch(SETTINGS, draft({ hours }))

    expect(checkPatch(patch)).toContain('HH:MM')
  })
})

describe('edición del horario', () => {
  it('abrir un día le pone un tramo de oficina y cerrarlo lo vacía', () => {
    const hours = draftFromSettings(SETTINGS).hours

    const open = setDayOpen(hours, 4, true)
    expect(open[4]).toEqual([{ start: '08:00', end: '18:00' }])
    expect(hours[4]).toEqual([]) // no muta el original

    expect(setDayOpen(open, 4, false)[4]).toEqual([])
  })

  it('abrir un día ya abierto no pisa sus tramos', () => {
    const hours = draftFromSettings(SETTINGS).hours

    expect(setDayOpen(hours, 1, true)[1]).toEqual([{ start: '08:00', end: '18:00' }])
  })

  it('agrega tramos hasta 4 por día y los quita', () => {
    let hours = draftFromSettings(SETTINGS).hours
    for (let i = 0; i < 6; i++) hours = addHoursBlock(hours, 1)

    expect(hours[1]).toHaveLength(4)

    const fewer = removeHoursBlock(hours, 1, 0)
    expect(fewer[1]).toHaveLength(3)
  })

  it('quitar el último tramo cierra el día', () => {
    const hours = removeHoursBlock(draftFromSettings(SETTINGS).hours, 6, 0)

    expect(hours[6]).toEqual([])
  })

  it('no agrega un tramo a un día cerrado', () => {
    const hours = draftFromSettings(SETTINGS).hours

    expect(addHoursBlock(hours, 0)[0]).toEqual([])
  })

  it('copia el lunes a martes-viernes y deja sábado y domingo como estaban', () => {
    const hours = draftFromSettings(SETTINGS).hours
    const withSplit = addHoursBlock(updateHoursBlock(hours, 1, 0, { end: '12:00' }), 1)

    const copied = copyDayToWeekdays(withSplit, 1)

    for (const day of [2, 3, 4, 5]) expect(copied[day]).toEqual(withSplit[1])
    expect(copied[6]).toEqual(hours[6])
    expect(copied[0]).toEqual([])
    // Copias independientes: editar un día no cambia otro.
    expect(copied[2]).not.toBe(copied[3])
  })

  it('copiar un lunes cerrado cierra martes a viernes', () => {
    const hours = setDayOpen(draftFromSettings(SETTINGS).hours, 1, false)

    const copied = copyDayToWeekdays(hours, 1)

    for (const day of [2, 3, 4, 5]) expect(copied[day]).toEqual([])
  })
})

describe('previewOfficeHours', () => {
  it('lee el horario como lo diría el asistente, agrupando días iguales', () => {
    const text = previewOfficeHours(draftFromSettings(SETTINGS).hours)

    expect(text).toBe('los lunes y martes de 8 a. m. a 6 p. m. y los sábados de 8 a. m. a 1 p. m.')
  })

  it('sin horario devuelve vacío', () => {
    let hours = draftFromSettings(SETTINGS).hours
    for (const day of [1, 2, 6]) hours = setDayOpen(hours, day, false)

    expect(previewOfficeHours(hours)).toBe('')
  })

  it('ignora los tramos a medio escribir en vez de romper', () => {
    const hours = updateHoursBlock(draftFromSettings(SETTINGS).hours, 1, 0, { start: '' })

    expect(previewOfficeHours(hours)).toBe('los martes de 8 a. m. a 6 p. m. y los sábados de 8 a. m. a 1 p. m.')
  })
})
