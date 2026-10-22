import { describe, expect, it } from 'vitest'

import { resolveLabels } from './labels'
import { AGENDA_AGENT_TEXTS, buildAgentTexts } from './texts'

/** Mitad de un par sustituto sin su compañera. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

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
    // Si la pregunta ya termina en "?", no lleva dos puntos.
    const withQuestion = { ...summary, answers: [{ label: '¿Motivo?', value: 'Control' }] }
    expect(t.summaryBody(withQuestion)).toContain('📝 ¿Motivo? Control')
    expect(t.summaryBody(withQuestion)).not.toContain('¿Motivo?: ')
    expect(t.summaryBody({ ...summary, price: null })).not.toContain('💵')
  })

  it('el resumen avisa cuántas respuestas no caben', () => {
    const t = buildAgentTexts(resolveLabels(null))
    expect(t.summaryBody({ ...summary, moreAnswers: 3 })).toContain('📝 +3 respuestas más')
    expect(t.summaryBody({ ...summary, moreAnswers: 1 })).toContain('📝 +1 respuesta más')
    expect(t.summaryBody(summary)).not.toContain('respuestas más')
  })

  it('las preguntas opcionales traen sus avisos', () => {
    expect(AGENDA_AGENT_TEXTS.answerOptionalHint).toContain('omitir')
    expect(AGENDA_AGENT_TEXTS.answerOptionalHintOptions).toContain('Omitir')
    expect(AGENDA_AGENT_TEXTS.answerSkip.length).toBeLessThanOrEqual(20)
    expect(AGENDA_AGENT_TEXTS.answerRetryText).not.toContain('opciones')
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

  it('los botones miden unidades UTF-16 (emoji = 2) y nunca parten un par sustituto', () => {
    const t = buildAgentTexts(
      resolveLabels({ profesionales: 'especialistas \u{1F485}\u{1F485}', cita: 'cita \u{1F485}\u{1F485}\u{1F485}\u{1F485}' }),
    )
    const buttons = [t.staffMenuButton, t.serviceMenuButton, t.manageNew, t.manageCancel]
    for (const label of buttons) {
      expect(label.length).toBeLessThanOrEqual(20)
      expect(label).not.toMatch(LONE_SURROGATE)
    }
    expect(t.staffMenuButton).toBe('Ver especialistas…')
  })

  it('el botón de "otra cita" es neutro en género: no usa la palabra del negocio', () => {
    for (const cita of ['turno', 'sesión', 'consulta', 'reserva']) {
      const t = buildAgentTexts(resolveLabels({ cita, citas: `${cita}s` }))
      expect(t.manageNew).toBe('Agendar otra vez')
      expect(t.manageNew).not.toMatch(/nuev[oa]/i)
    }
  })

  it('AGENDA_AGENT_TEXTS es el copy con palabras por defecto', () => {
    expect(AGENDA_AGENT_TEXTS.staffMenuBody).toBe('¿Con qué profesional quieres tu cita?')
  })
})
