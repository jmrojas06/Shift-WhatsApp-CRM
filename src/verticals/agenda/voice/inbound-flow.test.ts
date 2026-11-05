import { describe, expect, it } from 'vitest'

import type { OfficeHours } from '@/lib/voice/hours'

import {
  inboundFlow,
  inboundReplayXml,
  MAX_LOOPS,
  unavailableXml,
  type InboundFlowContext,
  type InboundFlowInput,
} from './inbound-flow'
import * as scripts from './scripts'

// ============================================================
// Máquina de pasos de la llamada entrante (§6.3): estado (query) + tecla →
// TeXML + efecto. Pura: no toca red ni base.
// ============================================================

const VOICE = 'Polly.Mia-Neural'
const APPT = '77777777-7777-4777-8777-777777777777'

const HOURS: OfficeHours = { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] }

const URLS = {
  step: (step: string, loop: number, path: string, appointmentId: string | null) =>
    `https://crm.example.test/api/voice/telnyx/inbound?call=c1&step=${step}&loop=${loop}&path=${encodeURIComponent(path)}${
      appointmentId ? `&appt=${appointmentId}` : ''
    }&t=tok`,
  dialResult: 'https://crm.example.test/api/voice/telnyx/dial-result?call=c1&t=tok',
}

const ADVISORS = { phones: ['+573001110000', '+573002220000'], callerId: '+576015550000' }
const ON_CALL = { phone: '+573009998877', callerId: '+576015550000' }

const NEXT_APPOINTMENT = {
  id: APPT,
  speech: { patient: 'Ana Pérez', day: 'el martes 10 de noviembre', time: 'a las 3 y media de la tarde', staff: 'la doctora Rojas' },
}

function context(overrides: Partial<InboundFlowContext> = {}): InboundFlowContext {
  return {
    voice: VOICE,
    business: 'Clínica Sonrisa',
    clinic: true,
    officeOpen: true,
    advisors: ADVISORS,
    officeHours: HOURS,
    infoText: 'Estamos en la Calle 10 número 5-20.',
    urgency: { alarmText: 'Fiebre alta o sangrado que no para', onCall: ON_CALL },
    nextAppointment: undefined,
    urls: URLS,
    ...overrides,
  }
}

function input(overrides: Partial<InboundFlowInput> = {}): InboundFlowInput {
  return { step: 'menu', loop: 1, digits: null, path: '', first: false, appointmentId: null, expired: false, ...overrides }
}

/** Lo que dice cada `<Say>`, sin escapes. */
function said(xml: string): string[] {
  return [...xml.matchAll(/<Say [^>]*>([^<]*)<\/Say>/g)].map((m) =>
    m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  )
}

const gatherAction = (xml: string) => /<Gather action="([^"]*)"/.exec(xml)?.[1]?.replace(/&amp;/g, '&')
const redirectUrl = (xml: string) => /<Redirect[^>]*>([^<]*)<\/Redirect>/.exec(xml)?.[1]?.replace(/&amp;/g, '&')
const hangsUp = (xml: string) => xml.includes('<Hangup/>')
const dialOf = (xml: string) => /<Dial [^>]*>.*<\/Dial>/.exec(xml)?.[0]
/** Lo que se dice dentro del Gather. */
const gathered = (xml: string) => said(/<Gather[^>]*>(.*?)<\/Gather>/.exec(xml)?.[1] ?? '')

describe('primer pedido: saludo y menú', () => {
  it('saluda con el nombre del negocio y dice el menú dentro de un Gather de una tecla', () => {
    const result = inboundFlow(input({ first: true }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)).toEqual([
      scripts.inboundGreeting({ business: 'Clínica Sonrisa' }),
      scripts.inboundMenu({ clinic: true }),
    ])
    // El saludo va antes del Gather: una tecla no lo corta.
    expect(result.xml.indexOf('Soy el asistente virtual')).toBeLessThan(result.xml.indexOf('<Gather'))
    expect(result.xml).toMatch(/<Gather action="[^"]+" numDigits="1" timeout="\d+">/)
    expect(/<Gather[^>]*method=/.test(result.xml)).toBe(false)
    expect(result.xml).toContain(`voice="${VOICE}"`)
  })

  it('el Gather vuelve al menú en la vuelta 1 y, sin tecla, el Redirect sigue en la 2', () => {
    const { xml } = inboundFlow(input({ first: true }), context())
    expect(gatherAction(xml)).toBe(URLS.step('menu', 1, '', null))
    expect(redirectUrl(xml)).toBe(URLS.step('menu', 2, '', null))
    expect(xml.indexOf('</Gather>')).toBeLessThan(xml.indexOf('<Redirect'))
  })

  it('una clínica ofrece el 9 primero; otro negocio no', () => {
    expect(gathered(inboundFlow(input({ first: true }), context({ clinic: true })).xml)[0]).toMatch(/^Si es una urgencia, marca 9\./)
    const other = gathered(inboundFlow(input({ first: true }), context({ clinic: false })).xml)[0]
    expect(other).not.toContain('marca 9')
  })

  it('el primer pedido ignora la tecla (aún no hay menú que la reciba)', () => {
    const result = inboundFlow(input({ first: true, digits: '1' }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)[0]).toBe(scripts.inboundGreeting({ business: 'Clínica Sonrisa' }))
  })

  it('escapa & y comillas del negocio y de las URL', () => {
    const { xml } = inboundFlow(input({ first: true }), context({ business: 'Dental "Luz" & Cía' }))
    expect(xml).toContain('Dental &quot;Luz&quot; &amp; Cía')
    expect(xml).toContain('&amp;loop=1')
    expect(xml).not.toMatch(/&(?!amp;|quot;|apos;|lt;|gt;)/)
  })
})

describe('sin respuesta y teclas inválidas: hasta dos repeticiones', () => {
  it('se repite el menú (sin saludo) en la vuelta 2 y la 3, y a la 4 se despide', () => {
    expect(MAX_LOOPS).toBe(3)
    for (const loop of [2, 3]) {
      const result = inboundFlow(input({ loop }), context())
      expect(said(result.xml)).toEqual([scripts.inboundMenu({ clinic: true })])
      expect(result.effect).toBeNull()
      expect(gatherAction(result.xml)).toBe(URLS.step('menu', loop, '', null))
      expect(redirectUrl(result.xml)).toBe(URLS.step('menu', loop + 1, '', null))
    }
    const last = inboundFlow(input({ loop: 4 }), context())
    expect(said(last.xml)).toEqual([scripts.thanksGoodbye()])
    expect(hangsUp(last.xml)).toBe(true)
    expect(last.xml).not.toContain('<Gather')
    expect(last.effect).toEqual({ type: 'no_response' })
  })

  it('una tecla inválida dice "No entendí" y repite; en la última vuelta se despide', () => {
    const first = inboundFlow(input({ loop: 1, digits: '7' }), context())
    expect(said(first.xml)).toEqual([scripts.notUnderstood(), scripts.inboundMenu({ clinic: true })])
    expect(gatherAction(first.xml)).toBe(URLS.step('menu', 2, '', null))
    expect(first.effect).toBeNull()
    expect(first.digits).toBe('7')

    const end = inboundFlow(input({ loop: MAX_LOOPS, digits: '7' }), context())
    expect(said(end.xml)).toEqual([scripts.notUnderstood(), scripts.thanksGoodbye()])
    expect(hangsUp(end.xml)).toBe(true)
    expect(end.effect).toEqual({ type: 'no_response' })
  })

  it('el 9 no existe fuera de una clínica: es una tecla inválida', () => {
    const result = inboundFlow(input({ digits: '9' }), context({ clinic: false }))
    expect(said(result.xml)[0]).toBe(scripts.notUnderstood())
    expect(result.effect).toBeNull()
    expect(dialOf(result.xml)).toBeUndefined()
  })

  it('guarda como mucho 10 caracteres de lo marcado', () => {
    expect(inboundFlow(input({ digits: '12345678901234' }), context()).digits).toBe('1234567890')
  })
})

describe('9: urgencia (solo clínicas)', () => {
  it('en horario pasa a los asesores, después de leer los signos de alarma', () => {
    const result = inboundFlow(input({ digits: '9' }), context())
    expect(said(result.xml)).toEqual([
      scripts.urgencyAlarm({ alarmText: 'Fiebre alta o sangrado que no para' }),
      scripts.advisorConnecting(),
    ])
    const dial = dialOf(result.xml)!
    expect(dial).toContain('callerId="+576015550000"')
    expect(dial).toContain('<Number>+573001110000</Number><Number>+573002220000</Number>')
    expect(dial).toContain('timeout="25"')
    expect(dial).toContain('timeLimit="1800"')
    expect(dial).toContain(`action="${URLS.dialResult.replace(/&/g, '&amp;')}"`)
    expect(result.effect).toEqual({ type: 'dial' })
    expect(result.path).toBe('9')
  })

  it('fuera de horario pasa al teléfono de turno de la sede', () => {
    const result = inboundFlow(input({ digits: '9' }), context({ advisors: null }))
    expect(said(result.xml)).toEqual([
      scripts.urgencyAlarm({ alarmText: 'Fiebre alta o sangrado que no para' }),
      scripts.urgencyOnCall(),
    ])
    expect(dialOf(result.xml)).toContain('<Number>+573009998877</Number>')
    expect(dialOf(result.xml)).not.toContain('+573001110000')
    expect(dialOf(result.xml)).toContain('callerId="+576015550000"')
    expect(result.effect).toEqual({ type: 'dial' })
  })

  it('sin asesores ni teléfono de turno avisa al equipo y cuelga', () => {
    const result = inboundFlow(input({ digits: '9' }), context({ advisors: null, urgency: { alarmText: 'Fiebre alta', onCall: null } }))
    expect(said(result.xml)).toEqual([scripts.urgencyAlarm({ alarmText: 'Fiebre alta' }), scripts.urgencyNoOne()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(dialOf(result.xml)).toBeUndefined()
    expect(result.effect).toEqual({ type: 'urgency_unattended' })
    expect(result.path).toBe('9')
  })

  it('sin texto de signos de alarma igual manda a urgencias', () => {
    const result = inboundFlow(input({ digits: '9' }), context({ urgency: { alarmText: null, onCall: ON_CALL } }))
    expect(said(result.xml)[0]).toBe('Si tienes una urgencia, ve a urgencias ahora.')
  })
})

describe('1: agendar por WhatsApp', () => {
  it('dice que se envió el WhatsApp, se despide y pide el envío', () => {
    const result = inboundFlow(input({ digits: '1' }), context())
    expect(said(result.xml)).toEqual([scripts.bookingLinkSent(), scripts.goodbye()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.effect).toEqual({ type: 'send_link' })
    expect(result.path).toBe('1')
  })

  it('trae la respuesta para cuando el envío falla', () => {
    const result = inboundFlow(input({ digits: '1' }), context())
    expect(result.failureXml).toBeDefined()
    expect(said(result.failureXml!)).toEqual([scripts.bookingLinkFailed(), scripts.goodbye()])
    expect(hangsUp(result.failureXml!)).toBe(true)
  })
})

describe('2: mi cita', () => {
  it('lee la próxima cita y ofrece confirmar, cancelar o volver; lleva la cita en la URL', () => {
    const result = inboundFlow(input({ digits: '2' }), context({ nextAppointment: NEXT_APPOINTMENT }))
    expect(said(result.xml)).toEqual([scripts.myAppointment(NEXT_APPOINTMENT.speech)])
    expect(gatherAction(result.xml)).toBe(URLS.step('appt', 1, '2', APPT))
    expect(redirectUrl(result.xml)).toBe(URLS.step('appt', 2, '2', APPT))
    expect(result.effect).toBeNull()
    expect(result.path).toBe('2')
  })

  it('sin citas lo dice y vuelve al menú', () => {
    const result = inboundFlow(input({ digits: '2' }), context({ nextAppointment: null }))
    expect(said(result.xml)).toEqual([scripts.noAppointments()])
    expect(gatherAction(result.xml)).toBe(URLS.step('menu', 1, '2', null))
    expect(result.effect).toBeNull()
    expect(hangsUp(result.xml)).toBe(false)
  })

  it('si no se pudo leer la cita no inventa nada: cae a "sin citas"', () => {
    const result = inboundFlow(input({ digits: '2' }), context({ nextAppointment: undefined }))
    expect(said(result.xml)).toEqual([scripts.noAppointments()])
  })

  describe('submenú de la cita', () => {
    const step = (digits: string | null, overrides: Partial<InboundFlowInput> = {}) =>
      inboundFlow(input({ step: 'appt', path: '2', appointmentId: APPT, digits, ...overrides }), context())

    it('1 confirma', () => {
      const result = step('1')
      expect(said(result.xml)).toEqual([scripts.appointmentConfirmed()])
      expect(hangsUp(result.xml)).toBe(true)
      expect(result.effect).toEqual({ type: 'confirm', appointmentId: APPT })
      expect(result.path).toBe('2>1')
    })

    it('2 pide la doble confirmación antes de cancelar', () => {
      const result = step('2')
      expect(said(result.xml)).toEqual([scripts.cancelConfirmAsk()])
      expect(gatherAction(result.xml)).toBe(URLS.step('cancel', 1, '2>2', APPT))
      expect(result.effect).toBeNull()
    })

    it('0 vuelve al menú principal', () => {
      const result = step('0')
      expect(said(result.xml)).toEqual([scripts.inboundMenu({ clinic: true })])
      expect(gatherAction(result.xml)).toBe(URLS.step('menu', 1, '2>0', null))
      expect(result.effect).toBeNull()
    })

    it('sin tecla repite solo las teclas (sin releer la cita) y luego se despide', () => {
      const repeat = step(null, { loop: 2 })
      expect(said(repeat.xml)).toEqual([scripts.inboundApptReprompt()])
      expect(gatherAction(repeat.xml)).toBe(URLS.step('appt', 2, '2', APPT))
      const end = step(null, { loop: MAX_LOOPS + 1 })
      expect(said(end.xml)).toEqual([scripts.thanksGoodbye()])
      expect(end.effect).toEqual({ type: 'no_response' })
    })

    it('una tecla inválida no toca la cita', () => {
      const result = step('5')
      expect(said(result.xml)[0]).toBe(scripts.notUnderstood())
      expect(result.effect).toBeNull()
    })
  })

  describe('doble confirmación de cancelar', () => {
    const step = (digits: string | null, overrides: Partial<InboundFlowInput> = {}) =>
      inboundFlow(input({ step: 'cancel', path: '2>2', appointmentId: APPT, digits, ...overrides }), context())

    it('1 cancela', () => {
      const result = step('1')
      expect(said(result.xml)).toEqual([scripts.appointmentCancelled()])
      expect(hangsUp(result.xml)).toBe(true)
      expect(result.effect).toEqual({ type: 'cancel', appointmentId: APPT })
      expect(result.path).toBe('2>2>1')
    })

    it('2 no cancela: vuelve al menú', () => {
      const result = step('2')
      expect(result.effect).toBeNull()
      expect(said(result.xml)).toEqual([scripts.inboundMenu({ clinic: true })])
      expect(gatherAction(result.xml)).toBe(URLS.step('menu', 1, '2>2>2', null))
    })

    it('sin tecla repite la pregunta y, pasadas las vueltas, no cancela', () => {
      expect(said(step(null, { loop: 2 }).xml)).toEqual([scripts.cancelConfirmAsk()])
      const end = step(null, { loop: MAX_LOOPS + 1 })
      expect(end.effect).toEqual({ type: 'no_response' })
      expect(said(end.xml)).toEqual([scripts.thanksGoodbye()])
    })

    it('un paso sin cita en la URL nunca confirma ni cancela', () => {
      const missing = inboundFlow(input({ step: 'cancel', path: '2>2', appointmentId: null, digits: '1' }), context())
      expect(missing.effect).toBeNull()
      const confirm = inboundFlow(input({ step: 'appt', path: '2', appointmentId: null, digits: '1' }), context())
      expect(confirm.effect).toBeNull()
    })
  })
})

describe('3: horario y dirección', () => {
  it('lee el texto del negocio y vuelve al menú', () => {
    const result = inboundFlow(input({ digits: '3' }), context())
    expect(said(result.xml)).toEqual([
      scripts.officeInfo({ infoText: 'Estamos en la Calle 10 número 5-20.', officeHours: HOURS }),
      scripts.inboundMenu({ clinic: true }),
    ])
    // Lo leído va antes del Gather; el menú, dentro.
    expect(gathered(result.xml)).toEqual([scripts.inboundMenu({ clinic: true })])
    expect(gatherAction(result.xml)).toBe(URLS.step('menu', 1, '3', null))
    expect(result.effect).toEqual({ type: 'info' })
  })

  it('sin texto lee el horario de atención generado', () => {
    const result = inboundFlow(input({ digits: '3' }), context({ infoText: '' }))
    expect(said(result.xml)[0]).toBe(scripts.officeInfo({ infoText: '', officeHours: HOURS }))
    expect(said(result.xml)[0]).toContain('Atendemos los lunes')
  })
})

describe('0: asesor', () => {
  it('en horario y con asesores dice "Te comunico" y marca a todos a la vez', () => {
    const result = inboundFlow(input({ digits: '0' }), context())
    expect(said(result.xml)).toEqual([scripts.advisorConnecting()])
    const dial = dialOf(result.xml)!
    expect(dial).toContain('<Number>+573001110000</Number><Number>+573002220000</Number>')
    expect(dial).toContain('callerId="+576015550000"')
    expect(dial).toContain('timeout="25"')
    expect(dial).toContain('timeLimit="1800"')
    expect(dial).toContain('method="POST"')
    expect(dial).toContain(`action="${URLS.dialResult.replace(/&/g, '&amp;')}"`)
    expect(result.effect).toEqual({ type: 'dial' })
    expect(result.path).toBe('0')
  })

  it('fuera de horario dice el horario y vuelve al menú', () => {
    const result = inboundFlow(input({ digits: '0' }), context({ advisors: null, officeOpen: false }))
    expect(said(result.xml)).toEqual([scripts.outOfHours({ officeHours: HOURS }), scripts.inboundMenu({ clinic: true })])
    expect(dialOf(result.xml)).toBeUndefined()
    expect(gatherAction(result.xml)).toBe(URLS.step('menu', 1, '0', null))
    expect(result.effect).toEqual({ type: 'out_of_hours' })
    expect(hangsUp(result.xml)).toBe(false)
  })

  it('fuera de horario sin horario configurado igual lo dice con la frase corta', () => {
    const result = inboundFlow(input({ digits: '0' }), context({ advisors: null, officeOpen: false, officeHours: {} }))
    expect(said(result.xml)[0]).toBe(scripts.outOfHours({ officeHours: {} }))
  })

  it('en horario pero sin asesores avisa al equipo y cuelga', () => {
    const result = inboundFlow(input({ digits: '0' }), context({ advisors: null, officeOpen: true }))
    expect(said(result.xml)).toEqual([scripts.advisorMissed()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(dialOf(result.xml)).toBeUndefined()
    expect(result.effect).toEqual({ type: 'advisor_unavailable' })
  })
})

describe('límite de 10 minutos', () => {
  it('pasado el límite, con asesores, pasa la llamada', () => {
    const result = inboundFlow(input({ expired: true, digits: '3' }), context())
    expect(said(result.xml)).toEqual([scripts.advisorConnecting()])
    expect(dialOf(result.xml)).toContain('<Number>+573001110000</Number>')
    expect(result.effect).toEqual({ type: 'dial' })
  })

  it('pasado el límite, sin asesores, se despide y cuelga', () => {
    const result = inboundFlow(input({ expired: true }), context({ advisors: null, officeOpen: false }))
    expect(said(result.xml)).toEqual([scripts.thanksGoodbye()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.effect).toEqual({ type: 'no_response' })
  })
})

describe('el camino del menú (menu_path)', () => {
  it('acumula las teclas y nunca pasa de 60 caracteres', () => {
    const long = Array.from({ length: 30 }, () => '3').join('>') // 59 caracteres
    expect(long.length).toBe(59)
    const result = inboundFlow(input({ digits: '3', path: long }), context())
    expect(result.path.length).toBeLessThanOrEqual(60)
    expect(result.path).toBe(long)
  })
})

describe('respuestas fijas', () => {
  it('número no disponible: lo dice y cuelga', () => {
    const xml = unavailableXml(VOICE)
    expect(said(xml)).toEqual([scripts.numberUnavailable()])
    expect(hangsUp(xml)).toBe(true)
  })

  it('un reintento de una llamada con resultado final recibe la misma despedida', () => {
    expect(said(inboundReplayXml('confirmed', VOICE))).toEqual([scripts.appointmentConfirmed()])
    expect(said(inboundReplayXml('cancelled', VOICE))).toEqual([scripts.appointmentCancelled()])
    expect(said(inboundReplayXml('booking_link_sent', VOICE))).toEqual([scripts.bookingLinkSent(), scripts.goodbye()])
    expect(said(inboundReplayXml('urgency', VOICE))).toEqual([scripts.urgencyNoOne()])
    expect(said(inboundReplayXml('advisor_missed', VOICE))).toEqual([scripts.advisorMissed()])
    expect(said(inboundReplayXml('human', VOICE))).toEqual([scripts.humanFollowUp()])
    for (const outcome of ['confirmed', 'booking_link_sent', 'advisor_connected', 'advisor_missed'] as const) {
      expect(hangsUp(inboundReplayXml(outcome, VOICE))).toBe(true)
    }
    // Conectado con un asesor: solo se cuelga.
    expect(said(inboundReplayXml('advisor_connected', VOICE))).toEqual([])
  })
})
