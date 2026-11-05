import { describe, expect, it } from 'vitest'

import type { OfficeHours } from '@/lib/voice/hours'

import * as scripts from './scripts'
import {
  advisorConnecting,
  advisorMissed,
  appointmentCancelled,
  appointmentConfirmed,
  appointmentInactive,
  bookingLinkFailed,
  bookingLinkSent,
  cancelConfirmAsk,
  goodbye,
  humanFollowUp,
  inboundGreeting,
  inboundMenu,
  myAppointment,
  noAppointments,
  noResponse,
  notUnderstood,
  numberUnavailable,
  officeInfo,
  outboundMenu,
  outboundReprompt,
  outOfHours,
  speakable,
  spokenDay,
  spokenStaff,
  spokenWhen,
  testCallIntro,
  thanksGoodbye,
  urgencyAlarm,
  urgencyNoOne,
  urgencyOnCall,
} from './scripts'

const HOURS: OfficeHours = {
  '1': [['08:00', '18:00']],
  '2': [['08:00', '18:00']],
  '3': [['08:00', '18:00']],
  '4': [['08:00', '18:00']],
  '5': [['08:00', '18:00']],
  '6': [['08:00', '13:00']],
}

describe('spokenDay', () => {
  it('día de la semana, número y mes, sin año', () => {
    expect(spokenDay('2026-11-10')).toBe('el martes 10 de noviembre')
    expect(spokenDay('2027-03-28')).toBe('el domingo 28 de marzo')
  })

  it('el día 1 se dice "primero"', () => {
    expect(spokenDay('2026-11-01')).toBe('el domingo primero de noviembre')
    expect(spokenDay('2026-12-01')).toBe('el martes primero de diciembre')
  })

  it('con la fecha de hoy dice "hoy" y "mañana"', () => {
    expect(spokenDay('2026-11-10', '2026-11-10')).toBe('hoy')
    expect(spokenDay('2026-11-11', '2026-11-10')).toBe('mañana')
    expect(spokenDay('2026-11-12', '2026-11-10')).toBe('el jueves 12 de noviembre')
    expect(spokenDay('2027-01-01', '2026-12-31')).toBe('mañana')
  })
})

describe('spokenWhen', () => {
  it('usa la hora de Bogotá, no la de UTC', () => {
    // 20:30Z = 3:30 p. m. en Bogotá.
    expect(spokenWhen(new Date('2026-11-10T20:30:00Z'))).toEqual({
      day: 'el martes 10 de noviembre',
      time: 'a las 3 y media de la tarde',
    })
    // 02:00Z del miércoles = martes 9:00 p. m. en Bogotá.
    expect(spokenWhen(new Date('2026-11-11T02:00:00Z'))).toEqual({
      day: 'el martes 10 de noviembre',
      time: 'a las 9 de la noche',
    })
  })

  it('con "ahora" dice hoy y mañana según el día de Bogotá', () => {
    const now = new Date('2026-11-10T14:00:00Z')
    expect(spokenWhen(new Date('2026-11-10T20:30:00Z'), now).day).toBe('hoy')
    expect(spokenWhen(new Date('2026-11-11T14:00:00Z'), now)).toEqual({
      day: 'mañana',
      time: 'a las 9 de la mañana',
    })
  })

  it('la una de la tarde es "a la 1"', () => {
    expect(spokenWhen(new Date('2026-11-10T18:00:00Z')).time).toBe('a la 1 de la tarde')
  })
})

describe('speakable', () => {
  it('quita emoji, formato de WhatsApp y enlaces', () => {
    expect(speakable('😀 *Ojo*: _urgente_ ~ya~ `ahora` https://x.test/a?b=1 fin')).toBe('Ojo: urgente ya ahora fin')
  })

  it('une las líneas como frases y quita las viñetas', () => {
    expect(speakable('Fiebre alta\n• Hinchazón en la cara\n- Dificultad para tragar.\n\nSangrado que no para')).toBe(
      'Fiebre alta. Hinchazón en la cara. Dificultad para tragar. Sangrado que no para',
    )
  })

  it('lee "8 a. m." como "8 de la mañana" y no deja a. m. ni p. m.', () => {
    expect(speakable('Lunes a viernes 8 a.m. a 6 p. m. y sábados de 8:30 am a 1pm')).toBe(
      'Lunes a viernes 8 de la mañana a 6 de la tarde y sábados de 8 y media de la mañana a 1 de la tarde',
    )
    expect(speakable('12 m. y 12 p. m. y 12 a. m.')).toBe('12 del día y 12 del día y 12 de la noche')
  })

  it('expande abreviaturas de títulos y direcciones, y el #', () => {
    expect(speakable('Dr. Pérez y Dra. Gómez, Sra. Ruiz')).toBe('doctor Pérez y doctora Gómez, señora Ruiz')
    expect(speakable('Cra. 7 # 12-30, Av. Caracas')).toBe('carrera 7 número 12-30, avenida Caracas')
  })

  it('recorta sin cortar a media palabra', () => {
    const long = 'palabra '.repeat(200)
    const out = speakable(long, 50)
    expect(out.length).toBeLessThanOrEqual(50)
    expect(out.endsWith('palabra')).toBe(true)
  })

  it('texto vacío o solo símbolos → vacío', () => {
    expect(speakable('')).toBe('')
    expect(speakable('  🙂 \n ')).toBe('')
  })
})

describe('spokenStaff', () => {
  it('pone el artículo al título y deja el nombre limpio', () => {
    expect(spokenStaff('Dr. Juan Pérez')).toBe('el doctor Juan Pérez')
    expect(spokenStaff('Dra. Ana Gómez')).toBe('la doctora Ana Gómez')
    expect(spokenStaff('Laura 🦷')).toBe('Laura')
  })
})

describe('guion saliente', () => {
  const base = {
    business: 'Clínica Sonrisa',
    patient: 'Juan Pérez',
    day: 'el martes 10 de noviembre',
    time: 'a las 3 y media de la tarde',
    staff: 'Dra. Ana Gómez',
  }

  it('menú completo con paciente y profesional', () => {
    expect(outboundMenu(base)).toBe(
      'Hola, soy el asistente virtual de Clínica Sonrisa. ' +
        'Te llamamos para recordarte la cita de Juan Pérez para el martes 10 de noviembre a las 3 y media de la tarde, con la doctora Ana Gómez. ' +
        'Para confirmarla, marca 1. Para cancelarla, marca 2. Para hablar con alguien del equipo, marca 3.',
    )
  })

  it('sin paciente dice "tu cita" y sin profesional no lo menciona', () => {
    const text = outboundMenu({ ...base, patient: null, staff: null })
    expect(text).toContain('recordarte tu cita para el martes 10 de noviembre a las 3 y media de la tarde. Para confirmarla')
    expect(text).not.toContain(', con ')
  })

  it('el nombre del negocio con puntos al final no deja dos puntos seguidos', () => {
    expect(outboundMenu({ ...base, business: 'Clínica Sonrisa S.A.S.' })).not.toContain('..')
  })

  it('NUNCA nombra el procedimiento, aunque se lo cuelen al llamar', () => {
    const smuggled = { ...base, service: 'Blanqueamiento dental', serviceName: 'Blanqueamiento dental' }
    expect(outboundMenu(smuggled as typeof base)).not.toMatch(/blanqueamiento/i)
    // @ts-expect-error la función no recibe el servicio
    outboundMenu({ ...base, service: 'Blanqueamiento dental' })
  })

  it('el reintento corto y las respuestas', () => {
    expect(outboundReprompt()).toBe(
      'Para confirmar tu cita, marca 1. Para cancelarla, marca 2. Para hablar con alguien del equipo, marca 3.',
    )
    expect(appointmentConfirmed()).toBe('Listo, tu cita quedó confirmada. Te esperamos. Hasta luego.')
    expect(cancelConfirmAsk()).toBe('¿Seguro que quieres cancelarla? Marca 1 para sí o 2 para no.')
    expect(appointmentCancelled()).toBe('Tu cita quedó cancelada. Te escribimos por WhatsApp para agendar otra.')
    expect(humanFollowUp()).toBe('Listo, alguien del equipo te va a contactar pronto. Hasta luego.')
    expect(advisorConnecting()).toBe('Te comunico con un asesor.')
    expect(noResponse()).toBe('No recibimos respuesta. Hasta luego.')
    expect(notUnderstood()).toBe('No entendí.')
    expect(appointmentInactive()).toBe('Esta cita ya no está activa. Hasta luego.')
    expect(goodbye()).toBe('Hasta luego.')
    expect(testCallIntro()).toBe('Esta es una llamada de prueba. No se va a cambiar ninguna cita.')
  })
})

describe('guion entrante', () => {
  it('saludo y no disponible', () => {
    expect(inboundGreeting({ business: 'Clínica Sonrisa' })).toBe(
      'Hola, gracias por llamar a Clínica Sonrisa. Soy el asistente virtual.',
    )
    expect(numberUnavailable()).toBe('Este número no está disponible.')
    expect(thanksGoodbye()).toBe('Gracias por llamar. Hasta luego.')
  })

  it('el menú de una clínica empieza por la urgencia (9)', () => {
    expect(inboundMenu({ clinic: true })).toBe(
      'Si es una urgencia, marca 9. ' +
        'Para agendar una cita, marca 1. ' +
        'Para confirmar o cancelar una cita que ya tienes, marca 2. ' +
        'Para conocer el horario y la dirección, marca 3. ' +
        'Para hablar con un asesor, marca 0.',
    )
  })

  it('el menú de otro negocio no ofrece el 9', () => {
    const text = inboundMenu({ clinic: false })
    expect(text).not.toContain('urgencia')
    expect(text).not.toContain('marca 9')
    expect(text.startsWith('Para agendar una cita, marca 1.')).toBe(true)
  })

  it('urgencia: lee los signos y manda a urgencias', () => {
    expect(urgencyAlarm({ alarmText: 'Fiebre alta, hinchazón en la cara o sangrado que no para' })).toBe(
      'Fiebre alta, hinchazón en la cara o sangrado que no para. Si tienes alguno de estos signos, ve a urgencias ahora.',
    )
    // Un texto que ya termina en punto no duplica el punto.
    expect(urgencyAlarm({ alarmText: '🚨 *Fiebre alta.*' })).toBe(
      'Fiebre alta. Si tienes alguno de estos signos, ve a urgencias ahora.',
    )
    // Sin texto no queda una frase coja.
    expect(urgencyAlarm({ alarmText: '   ' })).toBe('Si tienes una urgencia, ve a urgencias ahora.')
    expect(urgencyOnCall()).toBe('Te comunico con el profesional de turno.')
    expect(urgencyNoOne()).toBe('Le avisamos al equipo y te escribirán a primera hora.')
  })

  it('agendar: enlace enviado o fallo', () => {
    expect(bookingLinkSent()).toBe('Te enviamos un WhatsApp a este número para que agendes en un minuto.')
    expect(bookingLinkFailed()).toBe('No pudimos enviarte el WhatsApp. Escríbenos por WhatsApp para agendar.')
  })

  it('mi cita: con y sin paciente, y cuando no hay citas', () => {
    expect(
      myAppointment({ patient: 'Juan Pérez', day: 'mañana', time: 'a las 9 de la mañana', staff: 'Dr. Luis Mora' }),
    ).toBe(
      'La próxima cita registrada con este número es la de Juan Pérez, para mañana a las 9 de la mañana, con el doctor Luis Mora. ' +
        'Para confirmarla, marca 1. Para cancelarla, marca 2. Para volver al menú, marca 0.',
    )
    expect(myAppointment({ patient: null, day: 'el martes 10 de noviembre', time: 'a la 1 de la tarde', staff: null })).toBe(
      'Tu próxima cita es para el martes 10 de noviembre a la 1 de la tarde. ' +
        'Para confirmarla, marca 1. Para cancelarla, marca 2. Para volver al menú, marca 0.',
    )
    expect(noAppointments()).toBe('No encontramos citas con este número. Para agendar, marca 1.')
  })

  it('horario y dirección: lee el texto del negocio y, si no hay, el horario', () => {
    expect(officeInfo({ infoText: 'Estamos en la Calle 10 # 5-20, Bogotá.', officeHours: HOURS })).toBe(
      'Estamos en la Calle 10 número 5-20, Bogotá.',
    )
    expect(officeInfo({ infoText: '', officeHours: HOURS })).toBe(
      'Atendemos de lunes a viernes de 8 de la mañana a 6 de la tarde y los sábados de 8 de la mañana a 1 de la tarde.',
    )
    expect(officeInfo({ infoText: null, officeHours: {} })).toBe(
      'Por ahora no tenemos el horario disponible por teléfono. Escríbenos por WhatsApp.',
    )
  })

  it('asesor: sin respuesta y fuera de horario', () => {
    expect(advisorMissed()).toBe(
      'En este momento no hay asesores disponibles. Le avisamos al equipo para que te llame.',
    )
    expect(outOfHours({ officeHours: HOURS })).toBe(
      'En este momento estamos fuera del horario de atención. ' +
        'Atendemos de lunes a viernes de 8 de la mañana a 6 de la tarde y los sábados de 8 de la mañana a 1 de la tarde. ' +
        'Si deseas hablar con un asesor, llama en ese horario y marca 0. Para agendar por WhatsApp, marca 1.',
    )
    expect(outOfHours({ officeHours: {} })).toBe(
      'En este momento no tenemos asesores disponibles. Para agendar por WhatsApp, marca 1.',
    )
  })
})

describe('todas las frases', () => {
  const sample = {
    business: 'Clínica Sonrisa',
    patient: 'Juan Pérez',
    day: 'el martes 10 de noviembre',
    time: 'a las 3 y media de la tarde',
    staff: 'Dra. Ana Gómez',
  }

  // Cada guion con datos de ejemplo: así se revisan todos con las mismas reglas.
  const phrases: Record<string, string> = {
    outboundMenu: scripts.outboundMenu(sample),
    outboundMenuSinDatos: scripts.outboundMenu({ ...sample, patient: null, staff: null }),
    outboundReprompt: scripts.outboundReprompt(),
    appointmentConfirmed: scripts.appointmentConfirmed(),
    cancelConfirmAsk: scripts.cancelConfirmAsk(),
    appointmentCancelled: scripts.appointmentCancelled(),
    humanFollowUp: scripts.humanFollowUp(),
    advisorConnecting: scripts.advisorConnecting(),
    noResponse: scripts.noResponse(),
    notUnderstood: scripts.notUnderstood(),
    appointmentInactive: scripts.appointmentInactive(),
    goodbye: scripts.goodbye(),
    thanksGoodbye: scripts.thanksGoodbye(),
    testCallIntro: scripts.testCallIntro(),
    numberUnavailable: scripts.numberUnavailable(),
    inboundGreeting: scripts.inboundGreeting({ business: sample.business }),
    inboundMenuClinic: scripts.inboundMenu({ clinic: true }),
    inboundMenu: scripts.inboundMenu({ clinic: false }),
    urgencyAlarm: scripts.urgencyAlarm({ alarmText: 'Fiebre alta' }),
    urgencyOnCall: scripts.urgencyOnCall(),
    urgencyNoOne: scripts.urgencyNoOne(),
    bookingLinkSent: scripts.bookingLinkSent(),
    bookingLinkFailed: scripts.bookingLinkFailed(),
    myAppointment: scripts.myAppointment(sample),
    noAppointments: scripts.noAppointments(),
    officeInfo: scripts.officeInfo({ infoText: null, officeHours: HOURS }),
    officeInfoTexto: scripts.officeInfo({ infoText: 'Atendemos de 8 a.m. a 6 p.m.', officeHours: HOURS }),
    advisorMissed: scripts.advisorMissed(),
    outOfHours: scripts.outOfHours({ officeHours: HOURS }),
  }

  it.each(Object.entries(phrases))('%s: texto limpio y natural', (_name, text) => {
    expect(text.length).toBeGreaterThan(0)
    expect(text).toBe(text.trim())
    // Nada que la voz lea mal.
    expect(text).not.toMatch(/\b[ap]\. ?m\./i)
    expect(text).not.toMatch(/\b(?:Dra?|Sra?|Av|Cra|Cll)\./)
    expect(text).not.toMatch(/[*_~`#]/)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(text).not.toContain('..')
    expect(text).not.toMatch(/\s{2,}/)
    expect(text).not.toMatch(/\s[.,;:?!](?!\w)/)
    // Termina como una frase.
    expect(text).toMatch(/[.?!]$/)
    // Tuteo y "marca", como se habla en Colombia (no "presione" ni "oprima").
    expect(text).not.toMatch(/\b(?:presione|presiona|oprima|oprime|pulse|pulsa|digite|usted|su cita)\b/i)
    // Nunca el procedimiento.
    expect(text).not.toMatch(/blanqueamiento|limpieza|endodoncia|ortodoncia|servicio/i)
  })

  it('cada opción de menú se pide con "marca N"', () => {
    for (const text of [phrases.outboundMenu, phrases.inboundMenuClinic, phrases.myAppointment]) {
      expect(text).toMatch(/marca \d/)
    }
  })

  it('las despedidas dicen "Hasta luego"', () => {
    for (const name of [
      'appointmentConfirmed',
      'humanFollowUp',
      'noResponse',
      'appointmentInactive',
      'goodbye',
      'thanksGoodbye',
    ]) {
      expect(phrases[name]).toMatch(/Hasta luego\.$/)
    }
  })
})
