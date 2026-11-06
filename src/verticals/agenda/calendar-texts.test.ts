import { describe, expect, it } from 'vitest'

import { DEFAULT_LABELS, type AgendaLabels } from './labels'
import { CALENDAR_TEXTS as T } from './calendar-texts'

const TURNOS: AgendaLabels = {
  ...DEFAULT_LABELS,
  cita: 'turno',
  citas: 'turnos',
}

describe('CALENDAR_TEXTS con las palabras de la cuenta', () => {
  it('"sin citas" usa el plural de la palabra del negocio', () => {
    expect(T.noAppointmentsDay(DEFAULT_LABELS)).toBe('Sin citas')
    expect(T.noAppointmentsDay(TURNOS)).toBe('Sin turnos')
    expect(T.emptyWeekDay(TURNOS)).toBe('Sin turnos este día')
  })

  it('el nombre de la cuadrícula usa el plural de la palabra del negocio', () => {
    expect(T.gridLabel(DEFAULT_LABELS)).toBe('Calendario de citas')
    expect(T.gridLabel(TURNOS)).toBe('Calendario de turnos')
  })

  it('el conteo usa singular y plural de la cuenta', () => {
    expect(T.countOf(1, TURNOS)).toBe('1 turno')
    expect(T.countOf(3, TURNOS)).toBe('3 turnos')
  })
})
