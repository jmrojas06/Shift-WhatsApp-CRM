import { describe, expect, it } from 'vitest'

import {
  failureXml,
  inactiveXml,
  MAX_LOOPS,
  outboundFlow,
  replayXml,
  type OutboundFlowContext,
  type OutboundFlowInput,
} from './outbound-flow'
import * as scripts from './scripts'

// ============================================================
// Máquina de pasos de la llamada de confirmación (§6.2): estado (query) +
// tecla → TeXML + efecto. Pura: no toca red ni base.
// ============================================================

const VOICE = 'Polly.Mia-Neural'

const GREETING = {
  business: 'Clínica Sonrisa',
  patient: 'Ana Pérez',
  day: 'el martes 10 de noviembre',
  time: 'a las 3 y media de la tarde',
  staff: 'la doctora Rojas',
}

const URLS = {
  step: (step: string, loop: number, path: string) =>
    `https://crm.example.test/api/voice/telnyx/outbound?call=c1&step=${step}&loop=${loop}&path=${encodeURIComponent(path)}&t=tok`,
  dialResult: 'https://crm.example.test/api/voice/telnyx/dial-result?call=c1&t=tok',
}

const ADVISORS = { phones: ['+573001110000', '+573002220000'], callerId: '+576015550000' }

function context(overrides: Partial<OutboundFlowContext> = {}): OutboundFlowContext {
  return { voice: VOICE, greeting: GREETING, test: false, advisors: ADVISORS, urls: URLS, ...overrides }
}

function input(overrides: Partial<OutboundFlowInput> = {}): OutboundFlowInput {
  return { step: 'menu', loop: 1, digits: null, path: '', ...overrides }
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

describe('menú, primera vuelta', () => {
  it('saluda con el guion del diseño dentro de un Gather de una tecla', () => {
    const result = outboundFlow(input(), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)).toEqual([
      scripts.outboundMenu({
        business: GREETING.business,
        patient: GREETING.patient,
        day: GREETING.day,
        time: GREETING.time,
        staff: GREETING.staff,
      }),
    ])
    expect(result.xml).toMatch(/<Gather action="[^"]+" numDigits="1" timeout="\d+"><Say /)
    expect(result.xml).toContain(`voice="${VOICE}"`)
    // Telnyx no tiene `method` en Gather.
    expect(/<Gather[^>]*method=/.test(result.xml)).toBe(false)
  })

  it('el Gather vuelve al mismo paso con su vuelta y, sin tecla, redirige a la vuelta 2', () => {
    const { xml } = outboundFlow(input(), context())
    expect(gatherAction(xml)).toBe(URLS.step('menu', 1, ''))
    expect(redirectUrl(xml)).toBe(URLS.step('menu', 2, ''))
    // El Redirect va después del Gather: solo se ejecuta si no marcaron nada.
    expect(xml.indexOf('</Gather>')).toBeLessThan(xml.indexOf('<Redirect'))
  })

  it('escapa & y comillas del negocio y de las URL', () => {
    const { xml } = outboundFlow(
      input(),
      context({ greeting: { ...GREETING, business: 'Dental "Luz" & Cía', patient: null } }),
    )
    expect(xml).toContain('Dental &quot;Luz&quot; &amp; Cía')
    expect(xml).toContain('&amp;loop=1')
    expect(xml).not.toMatch(/&(?!amp;|quot;|apos;|lt;|gt;)/)
  })

  it('en la llamada de prueba abre diciendo que es una prueba', () => {
    const { xml } = outboundFlow(input(), context({ test: true }))
    expect(said(xml)[0]).toBe(scripts.testCallIntro())
    expect(said(xml)).toHaveLength(2)
    // La frase de prueba va antes del Gather, para que no se pueda cortar con una tecla.
    expect(xml.indexOf(scripts.testCallIntro())).toBeLessThan(xml.indexOf('<Gather'))
  })

  it('sin datos del saludo cae a la frase corta (nunca se cae la llamada)', () => {
    const { xml } = outboundFlow(input(), context({ greeting: null }))
    expect(said(xml)).toEqual([scripts.outboundReprompt()])
  })
})

describe('menú, sin respuesta', () => {
  it('la vuelta 2 repite el menú corto y redirige a la 3', () => {
    const result = outboundFlow(input({ loop: 2 }), context())
    expect(said(result.xml)).toEqual([scripts.outboundReprompt()])
    expect(gatherAction(result.xml)).toBe(URLS.step('menu', 2, ''))
    expect(redirectUrl(result.xml)).toBe(URLS.step('menu', 3, ''))
    expect(result.effect).toBeNull()
  })

  it('pasadas las dos vueltas dice que no hubo respuesta, cuelga y queda no_response', () => {
    const result = outboundFlow(input({ loop: MAX_LOOPS + 1 }), context())
    expect(said(result.xml)).toEqual([scripts.noResponse()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.xml).not.toContain('<Gather')
    expect(result.effect).toEqual({ type: 'no_response' })
  })
})

describe('menú, teclas', () => {
  it('1 confirma: efecto confirm, frase de confirmación y cuelga', () => {
    const result = outboundFlow(input({ digits: '1' }), context({ greeting: null }))
    expect(result.effect).toEqual({ type: 'confirm' })
    expect(said(result.xml)).toEqual([scripts.appointmentConfirmed()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.digits).toBe('1')
    expect(result.path).toBe('1')
  })

  it('2 pregunta si está seguro (doble confirmación) y todavía no cancela nada', () => {
    const result = outboundFlow(input({ digits: '2' }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)).toEqual([scripts.cancelConfirmAsk()])
    expect(gatherAction(result.xml)).toBe(URLS.step('cancel', 1, '2'))
    expect(redirectUrl(result.xml)).toBe(URLS.step('cancel', 2, '2'))
    expect(hangsUp(result.xml)).toBe(false)
    expect(result.path).toBe('2')
  })

  it('3 con asesores disponibles dice que lo comunica y marca a todos a la vez', () => {
    const result = outboundFlow(input({ digits: '3' }), context())
    expect(result.effect).toEqual({ type: 'dial' })
    expect(said(result.xml)).toEqual([scripts.advisorConnecting()])
    expect(result.xml).toContain('<Dial ')
    expect(result.xml).toContain('<Number>+573001110000</Number><Number>+573002220000</Number>')
    expect(result.xml).toContain('callerId="+576015550000"')
    expect(result.xml).toContain('timeout="25"')
    expect(result.xml).toContain('timeLimit="1800"')
    expect(result.xml).toContain('action="https://crm.example.test/api/voice/telnyx/dial-result?call=c1&amp;t=tok"')
    expect(result.path).toBe('3')
  })

  it('3 sin asesores disponibles deja el resultado human, avisa y cuelga', () => {
    const result = outboundFlow(input({ digits: '3' }), context({ advisors: null }))
    expect(result.effect).toEqual({ type: 'human' })
    expect(said(result.xml)).toEqual([scripts.humanFollowUp()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.xml).not.toContain('<Dial')
  })

  it('otra tecla dice "No entendí" y repite el menú corto en la vuelta siguiente', () => {
    const result = outboundFlow(input({ digits: '7' }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)).toEqual([scripts.notUnderstood(), scripts.outboundReprompt()])
    expect(gatherAction(result.xml)).toBe(URLS.step('menu', 2, ''))
    expect(redirectUrl(result.xml)).toBe(URLS.step('menu', 3, ''))
    // La tecla mala se guarda como último dígito pero no entra al camino.
    expect(result.digits).toBe('7')
    expect(result.path).toBe('')
  })

  it('una tecla mala en la última vuelta cuelga sin tocar la cita', () => {
    const result = outboundFlow(input({ loop: MAX_LOOPS, digits: '9' }), context())
    expect(said(result.xml)).toEqual([scripts.notUnderstood(), scripts.goodbye()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.effect).toEqual({ type: 'no_response' })
  })

  it('varias teclas juntas no valen como una (11 no es 1)', () => {
    const result = outboundFlow(input({ digits: '11' }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)[0]).toBe(scripts.notUnderstood())
  })

  it('una tecla vacía o con espacios es "sin tecla"', () => {
    expect(said(outboundFlow(input({ loop: 2, digits: '  ' }), context()).xml)).toEqual([scripts.outboundReprompt()])
  })

  it('guarda como mucho 10 caracteres de lo marcado', () => {
    const result = outboundFlow(input({ digits: '12345678901234' }), context())
    expect(result.digits).toBe('1234567890')
  })
})

describe('cancelar con doble confirmación', () => {
  const cancel = (overrides: Partial<OutboundFlowInput> = {}) =>
    input({ step: 'cancel', path: '2', ...overrides })

  it('1 (sí) cancela: efecto cancel, frase y cuelga', () => {
    const result = outboundFlow(cancel({ digits: '1' }), context())
    expect(result.effect).toEqual({ type: 'cancel' })
    expect(said(result.xml)).toEqual([scripts.appointmentCancelled()])
    expect(hangsUp(result.xml)).toBe(true)
    expect(result.path).toBe('2>1')
  })

  it('2 (no) vuelve al menú sin cancelar', () => {
    const result = outboundFlow(cancel({ digits: '2' }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)).toEqual([scripts.outboundReprompt()])
    expect(gatherAction(result.xml)).toBe(URLS.step('menu', 1, '2>2'))
    expect(redirectUrl(result.xml)).toBe(URLS.step('menu', 2, '2>2'))
    expect(hangsUp(result.xml)).toBe(false)
  })

  it('sin tecla repite la pregunta y, pasadas las vueltas, termina SIN cancelar', () => {
    const again = outboundFlow(cancel({ loop: 2 }), context())
    expect(said(again.xml)).toEqual([scripts.cancelConfirmAsk()])
    expect(gatherAction(again.xml)).toBe(URLS.step('cancel', 2, '2'))
    expect(redirectUrl(again.xml)).toBe(URLS.step('cancel', 3, '2'))
    expect(again.effect).toBeNull()

    const gaveUp = outboundFlow(cancel({ loop: MAX_LOOPS + 1 }), context())
    expect(gaveUp.effect).toEqual({ type: 'no_response' })
    expect(said(gaveUp.xml)).toEqual([scripts.noResponse()])
    expect(hangsUp(gaveUp.xml)).toBe(true)
  })

  it('una tecla mala vuelve a preguntar y, en la última vuelta, cuelga sin cancelar', () => {
    const retry = outboundFlow(cancel({ digits: '5' }), context())
    expect(said(retry.xml)).toEqual([scripts.notUnderstood(), scripts.cancelConfirmAsk()])
    expect(gatherAction(retry.xml)).toBe(URLS.step('cancel', 2, '2'))
    expect(retry.effect).toBeNull()

    const last = outboundFlow(cancel({ loop: MAX_LOOPS, digits: '5' }), context())
    expect(last.effect).toEqual({ type: 'no_response' })
    expect(hangsUp(last.xml)).toBe(true)
  })

  it('3 en la pregunta de cancelar no cuenta como "pasar con alguien": es una tecla mala', () => {
    const result = outboundFlow(cancel({ digits: '3' }), context())
    expect(result.effect).toBeNull()
    expect(said(result.xml)[0]).toBe(scripts.notUnderstood())
  })
})

describe('frases sueltas', () => {
  it('cita inactiva: lo dice y cuelga', () => {
    const xml = inactiveXml(VOICE)
    expect(said(xml)).toEqual([scripts.appointmentInactive()])
    expect(hangsUp(xml)).toBe(true)
  })

  it('falla interna: se disculpa con la frase de "alguien te contactará" y cuelga', () => {
    const xml = failureXml(VOICE)
    expect(said(xml)).toEqual([scripts.humanFollowUp()])
    expect(hangsUp(xml)).toBe(true)
  })

  it.each([
    ['confirmed', [scripts.appointmentConfirmed()]],
    ['cancelled', [scripts.appointmentCancelled()]],
    ['human', [scripts.humanFollowUp()]],
    ['no_response', [scripts.noResponse()]],
    ['advisor_missed', [scripts.advisorMissed()]],
    ['advisor_connected', []],
  ] as const)('repite la despedida de un resultado ya guardado (%s)', (outcome, phrases) => {
    const xml = replayXml(outcome, VOICE)
    expect(said(xml)).toEqual(phrases)
    expect(hangsUp(xml)).toBe(true)
  })

  it('todo documento es un Response de XML válido', () => {
    for (const xml of [
      outboundFlow(input(), context()).xml,
      outboundFlow(input({ digits: '3' }), context()).xml,
      inactiveXml(VOICE),
      replayXml('confirmed', VOICE),
    ]) {
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true)
      expect(xml.endsWith('</Response>')).toBe(true)
    }
  })
})
