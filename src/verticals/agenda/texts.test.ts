import { describe, expect, it } from 'vitest'

import { resolveLabels } from './labels'
import { AGENDA_AGENT_TEXTS, buildAgentTexts } from './texts'

const summary = {
  service: 'Limpieza dental',
  staff: 'Dra. Ruiz',
  date: 'martes 20 de octubre de 2026',
  time: '3:00 p. m.',
  price: '$80.000',
  answers: [{ label: 'Motivo', value: 'Control' }],
}

describe('buildAgentTexts', () => {
  it('usa las palabras del negocio', () => {
    const t = buildAgentTexts(
      resolveLabels({ profesional: 'doctor', profesionales: 'doctores', cita: 'consulta' }),
    )
    expect(t.staffMenuBody).toBe('¿Con qué doctor quieres tu consulta?')
    expect(t.staffMenuButton).toBe('Ver doctores')
    expect(t.summaryBody(summary)).toContain('Así queda tu consulta')
  })

  it('el resumen muestra precio y respuestas; sin precio no hay línea de precio', () => {
    const t = buildAgentTexts(resolveLabels(null))
    expect(t.summaryBody(summary)).toContain('💵 $80.000')
    expect(t.summaryBody(summary)).toContain('📝 Motivo: Control')
    expect(t.summaryBody({ ...summary, price: null })).not.toContain('💵')
  })

  it('sin profesional asignado no hay línea de 👤', () => {
    const t = buildAgentTexts(resolveLabels(null))
    expect(t.summaryBody({ ...summary, staff: '' })).not.toContain('👤')
    expect(t.confirmed({ ...summary, staff: '' })).not.toContain('👤')
    expect(t.rescheduleDone({ ...summary, staff: '' })).not.toContain('👤')
  })

  it('la confirmación nunca muestra el precio', () => {
    const t = buildAgentTexts(resolveLabels(null))
    expect(t.confirmed(summary)).not.toContain('💵')
    expect(t.confirmed(summary)).toContain('👤 Dra. Ruiz')
  })

  it('los botones nunca pasan de 20 caracteres', () => {
    const t = buildAgentTexts(resolveLabels({ profesionales: 'especialistas en estética' }))
    expect(t.staffMenuButton.length).toBeLessThanOrEqual(20)
    const long = buildAgentTexts(
      resolveLabels({ cita: 'sesión de acompañamiento' }),
    )
    expect(long.manageNew.length).toBeLessThanOrEqual(20)
    expect(long.manageCancel.length).toBeLessThanOrEqual(20)
  })

  it('AGENDA_AGENT_TEXTS es el copy con palabras por defecto', () => {
    expect(AGENDA_AGENT_TEXTS.staffMenuBody).toBe('¿Con qué profesional quieres tu cita?')
  })
})
