import { describe, expect, it } from 'vitest'

import { DEFAULT_LABELS } from './labels'
import {
  NOTIFY_TEMPLATES,
  renderMovedText,
  renderNotifyTemplate,
  type NotifyTemplateName,
} from './notify-texts'

// ============================================================
// Las plantillas de los avisos: lo que se aprueba en WhatsApp Manager
// (docs/clinica-montaje.md) sale de aquí, así que se fija su forma.
// ============================================================

const NAMES = Object.keys(NOTIFY_TEMPLATES) as NotifyTemplateName[]

/** El cuerpo como se aprueba en Meta: {{1}}, {{2}}… en el orden de las variables. */
const approvedBody = (name: NotifyTemplateName) =>
  renderNotifyTemplate(
    name,
    NOTIFY_TEMPLATES[name].variables.map((_, index) => `{{${index + 1}}}`),
    DEFAULT_LABELS,
  )

describe('plantillas de aviso', () => {
  it('son las cinco del diseño, con sus variables en orden', () => {
    expect(NAMES).toEqual([
      'cita_agendada',
      'cita_cancelada',
      'cita_agendada_clinica',
      'cita_cancelada_clinica',
      'agendar_por_llamada',
    ])
    expect(NOTIFY_TEMPLATES.cita_agendada.variables).toEqual(['business', 'service', 'staff', 'date', 'time'])
    expect(NOTIFY_TEMPLATES.cita_cancelada.variables).toEqual(['business', 'date', 'time'])
    expect(NOTIFY_TEMPLATES.cita_agendada_clinica.variables).toEqual([
      'patient',
      'business',
      'location',
      'doctor',
      'date',
      'time',
    ])
    expect(NOTIFY_TEMPLATES.cita_cancelada_clinica.variables).toEqual(['patient', 'business', 'date', 'time'])
    expect(NOTIFY_TEMPLATES.agendar_por_llamada.variables).toEqual(['business'])
  })

  it.each(NAMES)('%s: cada variable aparece una vez y el cuerpo no empieza ni termina en una', (name) => {
    const body = approvedBody(name)
    NOTIFY_TEMPLATES[name].variables.forEach((_, index) => {
      expect(body.split(`{{${index + 1}}}`)).toHaveLength(2)
    })
    expect(body.startsWith('{{')).toBe(false)
    expect(body.endsWith('}}')).toBe(false)
  })

  it('las de clínica nunca tienen una variable para el procedimiento', () => {
    for (const name of ['cita_agendada_clinica', 'cita_cancelada_clinica'] as const) {
      expect(NOTIFY_TEMPLATES[name].variables).not.toContain('service')
    }
  })

  it('el botón: Agendar otra en las cancelaciones, Agendar en el enlace, ninguno en agendada', () => {
    expect(NOTIFY_TEMPLATES.cita_cancelada.button).toEqual({ id: 'book:again', title: 'Agendar otra' })
    expect(NOTIFY_TEMPLATES.cita_cancelada_clinica.button).toEqual({ id: 'book:again', title: 'Agendar otra' })
    expect(NOTIFY_TEMPLATES.agendar_por_llamada.button).toEqual({ id: 'book:again', title: 'Agendar' })
    expect(NOTIFY_TEMPLATES.cita_agendada.button).toBeUndefined()
    expect(NOTIFY_TEMPLATES.cita_agendada_clinica.button).toBeUndefined()
  })

  it('las palabras del negocio entran en el texto', () => {
    const labels = { ...DEFAULT_LABELS, cita: 'turno' }
    expect(renderNotifyTemplate('cita_agendada', ['A', 'B', 'C', 'D', 'E'], labels)).toContain('tu turno')
    expect(renderMovedText(false, ['A', 'B', 'C', 'D', 'E'], labels)).toContain('tu turno')
  })

  it('mover usa los mismos valores que agendar pero avisa del cambio', () => {
    const plain = renderMovedText(false, ['Negocio', 'Corte', 'Andrés', 'lunes 9', '10:00'], DEFAULT_LABELS)
    expect(plain).toMatch(/cambiamos la hora/i)
    for (const part of ['Negocio', 'Corte', 'Andrés', 'lunes 9', '10:00']) expect(plain).toContain(part)

    const clinic = renderMovedText(true, ['Marta', 'Clínica', 'Centro', 'Dra. Ana', 'lunes 9', '10:00'], DEFAULT_LABELS)
    expect(clinic).toMatch(/cambiamos la hora/i)
    for (const part of ['Marta', 'Clínica', 'Centro', 'Dra. Ana', 'lunes 9', '10:00']) expect(clinic).toContain(part)
  })
})
