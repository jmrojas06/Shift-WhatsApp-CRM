import { describe, expect, it } from 'vitest'

import { sanitizeBotTexts } from '../bot-texts'
import { sanitizeLabels } from '../labels'
import { MAX_QUESTIONS, validateQuestionCreate } from '../questions'
import { AGENDA_PRESETS, getPreset, isPresetKey, PRESET_KEYS } from './index'

describe('puntos de partida', () => {
  it.each(PRESET_KEYS)('%s es válido de punta a punta', (key) => {
    const preset = AGENDA_PRESETS[key]
    expect(preset.key).toBe(key)
    expect(getPreset(key)).toBe(preset)
    expect(sanitizeLabels(preset.labels)).toEqual({ ok: true, value: preset.labels })
    expect(preset.questions.length).toBeLessThanOrEqual(MAX_QUESTIONS)
    for (const q of preset.questions) expect(validateQuestionCreate(q).ok).toBe(true)
    expect(preset.welcome.length).toBeLessThanOrEqual(320)
    expect(sanitizeBotTexts({ welcome: preset.welcome })).toEqual({
      ok: true,
      value: { welcome: preset.welcome },
    })
    expect(preset.aiPrompt.trim().length).toBeGreaterThan(0)
    for (const s of preset.seed.services) {
      expect(s.durationMinutes).toBeGreaterThan(0)
      expect(s.durationMinutes).toBeLessThanOrEqual(480)
      expect(s.price).toBeGreaterThanOrEqual(0)
    }
  })

  it.each(PRESET_KEYS)('%s lleva las etiquetas y el pipeline que usa el bot', (key) => {
    const { seed } = AGENDA_PRESETS[key]
    expect(seed.tags.map((t) => t.name)).toEqual(
      expect.arrayContaining(['cita-confirmada', 'cita-cancelada', 'quiere-humano']),
    )
    expect(seed.pipeline.name).toBe('Agenda')
    expect(seed.pipeline.stages.map((s) => s.name)).toContain('Cita agendada')
  })

  it.each(PRESET_KEYS)('%s trae el horario solo si trae equipo', (key) => {
    const { seed } = AGENDA_PRESETS[key]
    expect(seed.weeklySchedule.length > 0).toBe(seed.staff.length > 0)
    for (const h of seed.weeklySchedule) {
      expect(h.startTime < h.endTime).toBe(true)
      expect(h.startTime).toMatch(/^\d\d:\d\d:00$/)
    }
  })

  it('nombres de servicios y del equipo no se repiten dentro de un punto de partida', () => {
    for (const key of PRESET_KEYS) {
      const { seed } = AGENDA_PRESETS[key]
      const services = seed.services.map((s) => s.name.toLowerCase())
      expect(new Set(services).size).toBe(services.length)
    }
  })

  it('solo la barbería menciona al barbero o la barbería', () => {
    for (const key of PRESET_KEYS.filter((k) => k !== 'barberia')) {
      const p = AGENDA_PRESETS[key]
      const text = JSON.stringify([p.name, p.description, p.welcome, p.aiPrompt, p.seed, p.questions])
      expect(text.toLowerCase()).not.toMatch(/barber/)
    }
  })

  it('el taller no deja elegir técnico y pide la placa', () => {
    const taller = AGENDA_PRESETS.taller
    expect(taller.toggles.chooseStaff).toBe(false)
    expect(taller.questions).toEqual([
      { label: 'Placa del vehículo', kind: 'texto', required: true, options: [] },
    ])
  })

  it('clases dice sesión en vez de cita', () => {
    expect(AGENDA_PRESETS.clases.labels).toMatchObject({
      servicio: 'clase',
      servicios: 'clases',
      cita: 'sesión',
      citas: 'sesiones',
    })
  })

  it('en blanco no trae servicios, equipo, horario ni preguntas', () => {
    const { seed, questions } = AGENDA_PRESETS.blanco
    expect(seed.services).toEqual([])
    expect(seed.staff).toEqual([])
    expect(seed.weeklySchedule).toEqual([])
    expect(questions).toEqual([])
  })

  it('isPresetKey solo acepta las claves conocidas', () => {
    expect(isPresetKey('salud')).toBe(true)
    expect(isPresetKey('tienda')).toBe(false)
    expect(isPresetKey(undefined)).toBe(false)
    expect(isPresetKey('constructor')).toBe(false)
  })
})
