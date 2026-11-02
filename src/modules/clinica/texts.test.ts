import { describe, expect, it } from 'vitest'

import { containsUrgencyWord } from '@/verticals/agenda/agent/state'
import { DEFAULT_LABELS } from '@/verticals/agenda/labels'

import {
  buildClinicTexts,
  DEFAULT_CONSENT_TEXT,
  DEFAULT_URGENCY_ALARM_TEXT,
  DEFAULT_URGENCY_WORDS,
} from './texts'

const texts = buildClinicTexts(DEFAULT_LABELS)

describe('textos de la clínica', () => {
  it('quien no acepta no recibe una promesa falsa de que no se guardan sus datos', () => {
    expect(texts.consentDeclined).toBe(
      'Entendido. Una persona de la clínica te atiende por este chat. 🙌',
    )
    expect(texts.consentDeclined).not.toMatch(/guardaremos/i)
  })

  it('las notas internas empiezan por "Paciente:"', () => {
    expect(texts.consentDeclinedNote).toBe(
      'Paciente: no aceptó la autorización de datos (bot en pausa).',
    )
    expect(texts.urgencyNote).toBe('Paciente: reportó signos de alarma (bot en pausa).')
    expect(texts.urgencyOffHoursNote).toBe(
      'Paciente: urgencia sin cupo en la agenda de hoy (bot en pausa).',
    )
  })

  it('el texto de autorización por defecto no promete menos de lo que se hace', () => {
    expect(DEFAULT_CONSENT_TEXT).toContain(
      'No tienes la obligación de autorizarlos y te atendemos igual si no aceptas.',
    )
    expect(DEFAULT_CONSENT_TEXT).toContain(
      'Los usamos para atenderte: tus citas, tus recordatorios y el seguimiento después de cada visita.',
    )
    expect(DEFAULT_CONSENT_TEXT).not.toContain('No estás obligado')
    expect(DEFAULT_CONSENT_TEXT).not.toContain('solo para gestionar')
  })

  it('los textos por defecto caben en lo que admite la base (900) y WhatsApp (1024)', () => {
    expect([...DEFAULT_CONSENT_TEXT].length).toBeLessThanOrEqual(900)
    expect([...DEFAULT_URGENCY_ALARM_TEXT].length).toBeLessThanOrEqual(900)
  })

  it.each([
    ['cita', 'citas'],
    ['turno', 'turnos'],
    ['sesión', 'sesiones'],
  ])('no depende del género de la palabra del dueño (%s)', (cita, citas) => {
    const t = buildClinicTexts({ ...DEFAULT_LABELS, cita, citas })

    expect(t.noUpcoming).toBe(`Por ahora no hay ${citas} a tu nombre. ¿Quieres agendar?`)
    expect(t.patientMenuBody).toBe('¿Quién va a asistir?')
    expect(t.patientNamePrompt).toBe(
      'Escríbeme el nombre y los apellidos de quien va a asistir.',
    )
    expect(
      t.reminderBody({
        patient: 'Ana Pérez',
        business: 'Clínica Sonrisa',
        location: 'Centro',
        staff: 'Dra. Gómez',
        date: 'lunes 4',
        time: '3:00 p. m.',
      }),
    ).toBe(
      `¡Hola! 👋 Te recordamos que Ana Pérez tiene ${cita} en Clínica Sonrisa, sede Centro:\n\n👤 Dra. Gómez\n📅 lunes 4\n🕐 3:00 p. m.\n\n¿Nos confirmas?`,
    )
  })
})

describe('palabras de urgencia por defecto', () => {
  const words = DEFAULT_URGENCY_WORDS

  it('van en minúsculas y sin tildes, como se comparan', () => {
    for (const word of words) {
      expect(word).toBe(
        word
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase(),
      )
    }
  })

  it('no repite ninguna', () => {
    expect(new Set(words).size).toBe(words.length)
  })

  it('"dolores" no es una palabra de urgencia: es un nombre', () => {
    expect(words).not.toContain('dolores')
    expect(containsUrgencyWord('Dolores Pérez pide una cita', words)).toBe(false)
  })

  it.each([
    'me duelen las muelas',
    'me sangran las encías',
    'hay mucha sangre',
    'se me partió una muela',
    'se me quebró un diente',
    'se quebró la corona',
    'se me rompió el puente',
    'se rompió el diente',
    'tengo la cara inflamada',
    'tengo la encía inflamada',
    'el cachete está inflamado',
    'me cuesta respirar',
    'no puedo tragar',
    'tengo mucho dolor',
    'se me cayó una corona',
    'no paro de sangrar',
    'yo sangro mucho',
    'se me hinchó la cara',
    'se me inflamó la encía',
    'me fracturé un diente',
    'me falta el aire',
    'me fracturo un diente jugando',
    'me está doliendo muchísimo la muela',
    'me dolió toda la noche',
    'me golpeé la boca con la puerta',
    'tiene calentura desde ayer',
  ])('reconoce una urgencia: %s', (message) => {
    expect(containsUrgencyWord(message, words)).toBe(true)
  })

  it.each(['quiero agendar una limpieza', 'Soy Dolores Pérez', 'cuánto cuesta una consulta'])(
    'no confunde un mensaje normal: %s',
    (message) => {
      expect(containsUrgencyWord(message, words)).toBe(false)
    },
  )
})
