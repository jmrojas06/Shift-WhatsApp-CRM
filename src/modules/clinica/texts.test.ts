import { describe, expect, it } from 'vitest'

import { containsUrgencyWord } from '@/verticals/agenda/agent/state'
import { DEFAULT_LABELS } from '@/verticals/agenda/labels'

import {
  buildClinicTexts,
  DEFAULT_CONSENT_TEXT,
  DEFAULT_LOCATION_NAME,
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

describe('pase de la IA a una persona', () => {
  it('el texto al paciente es fijo: lo revisa una persona, ya se avisó, y los signos de alarma', () => {
    expect(texts.aiHandoffNotice('Ve a urgencias si sangra.')).toBe(
      'Esto lo debe revisar una persona de la clínica. Ya le avisé y te escribe por este chat. Si aparece uno de estos signos, ve a urgencias sin esperar respuesta:\n\nVe a urgencias si sangra.',
    )
  })

  it('no diagnostica ni recomienda nada', () => {
    const notice = texts.aiHandoffNotice(DEFAULT_URGENCY_ALARM_TEXT)
    expect(notice).not.toMatch(/medicamento|tratamiento|diagn[oó]stic|normal/i)
  })

  it('el aviso en la app nombra a la persona y manda a responderle', () => {
    expect(texts.aiHandoffNotificationTitle).toBe('Un paciente necesita a una persona')
    expect(texts.aiHandoffNotificationBody('Marta Ruiz')).toBe(
      'Marta Ruiz escribió algo sobre su salud que el asistente no contesta. Respóndele por este chat.',
    )
  })
})

describe('instrucciones previas', () => {
  it('instrucciones o dirección con solo espacios no mandan un mensaje vacío', () => {
    expect(texts.prepInfo({ prep: '   ', address: '\n ', mapUrl: ' ' })).toBeNull()
    expect(texts.prepInfo({ prep: '', address: '', mapUrl: null })).toBeNull()
  })

  it('recorta los espacios de lo que sí dice', () => {
    expect(texts.prepInfo({ prep: '  Cepíllate antes.  ', address: ' Calle 1 ', mapUrl: null })).toBe(
      'Para tu cita:\nCepíllate antes.\n\n📍 Calle 1',
    )
    // Una de las dos vacía: solo sale la otra.
    expect(texts.prepInfo({ prep: '  ', address: 'Calle 1', mapUrl: null })).toBe('📍 Calle 1')
  })
})

describe('respuesta a tocar Confirmar', () => {
  const when = { staff: 'Dra. Ana', date: 'martes 20 de octubre de 2026', time: '9:00 a. m.' }

  it('nombra al paciente, al profesional, la fecha y la hora', () => {
    expect(texts.reminderConfirmed({ patient: 'Tomás Gil', ...when })).toBe(
      '¡Listo! Queda confirmado:\n\n🙋 Paciente: Tomás Gil\n👤 Dra. Ana\n📅 martes 20 de octubre de 2026\n🕐 9:00 a. m.\n\n¡Te esperamos! 🙌',
    )
  })

  it('sin el nombre del paciente omite esa línea', () => {
    const body = texts.reminderConfirmed({ patient: null, ...when })
    expect(body).not.toContain('Paciente')
    expect(body).toBe(
      '¡Listo! Queda confirmado:\n\n👤 Dra. Ana\n📅 martes 20 de octubre de 2026\n🕐 9:00 a. m.\n\n¡Te esperamos! 🙌',
    )
  })

  it('no tiene dónde poner el procedimiento', () => {
    expect(texts.reminderConfirmed({ patient: 'Tomás Gil', ...when })).not.toContain('📌')
  })
})

describe('sede por defecto', () => {
  it('no repite la palabra "sede" en el recordatorio', () => {
    expect(DEFAULT_LOCATION_NAME).toBe('Principal')
    const body = texts.reminderBody({
      patient: 'Ana Pérez',
      business: 'Clínica Sonrisa',
      location: DEFAULT_LOCATION_NAME,
      staff: 'Dra. Gómez',
      date: 'lunes 4',
      time: '3:00 p. m.',
    })
    expect(body).toContain('sede Principal:')
    expect(body).not.toMatch(/sede sede/i)
  })
})

describe('respuestas a los botones de los seguimientos', () => {
  it('los textos del diseño (§7.4)', () => {
    expect(texts.followupWellReply).toBe('¡Qué bueno! Cualquier cosa, escríbenos por aquí.')
    expect(texts.followupTroubleReply('Signos de alarma')).toBe(
      'Le avisamos al equipo para que te contacten pronto.\n\nSignos de alarma',
    )
    expect(texts.followupRatingThanks(null)).toBe('¡Gracias por contarnos!')
    expect(texts.followupRatingThanks('https://g.page/r/abc')).toBe(
      '¡Gracias por contarnos! Si quieres, déjanos tu opinión en Google: https://g.page/r/abc',
    )
  })

  it('los cuidados salen sin espacios de más y con la palabra del negocio', () => {
    expect(texts.followupCareReply('  No comas por 2 horas.\n')).toBe(
      'Estas son las recomendaciones de cuidado después de tu cita:\n\nNo comas por 2 horas.',
    )
    const turno = buildClinicTexts({ ...DEFAULT_LABELS, cita: 'turno', citas: 'turnos' })
    expect(turno.followupCareReply('Reposo.')).toContain('después de tu turno:')
  })

  it('el aviso de una calificación baja dice cuál fue', () => {
    expect(texts.followupLowRatingNotificationTitle('mal')).toBe('Calificación Mal: llama al paciente')
    expect(texts.followupLowRatingNotificationTitle('regular')).toBe(
      'Calificación Regular: llama al paciente',
    )
    expect(texts.followupLowRatingNotificationBody('Marta Ruiz', 'regular')).toContain(
      'Marta Ruiz calificó su visita como Regular.',
    )
  })
})
