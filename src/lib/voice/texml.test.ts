import { describe, expect, it } from 'vitest'

import {
  dial,
  escapeXml,
  gather,
  hangup,
  pause,
  redirect,
  response,
  say,
} from './texml'

/**
 * Revisión mínima de "bien formado" (no hay parser XML en el repo):
 * etiquetas balanceadas, atributos entre comillas dobles y ningún `&`
 * o `<` suelto dentro de texto o valores.
 */
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>/, '')
  const stack: string[] = []
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? []
  for (const token of tokens) {
    if (token.startsWith('<')) {
      const closing = /^<\/([A-Za-z]+)>$/.exec(token)
      const selfClosing = /^<([A-Za-z]+)((?:\s+[A-Za-z]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)\s*\/>$/.exec(token)
      const opening = /^<([A-Za-z]+)((?:\s+[A-Za-z]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)>$/.exec(token)
      if (closing) {
        expect(stack.pop()).toBe(closing[1])
      } else if (selfClosing) {
        // nada que apilar
      } else if (opening) {
        stack.push(opening[1])
      } else {
        throw new Error(`Etiqueta mal formada: ${token}`)
      }
    } else {
      // Texto: todo `&` debe ser una de las cinco entidades.
      expect(token.replace(/&(?:amp|lt|gt|quot|apos);/g, '')).not.toMatch(/[&<>]/)
    }
  }
  expect(stack).toEqual([])
}

describe('escapeXml', () => {
  it('escapa & < > " y \'', () => {
    expect(escapeXml(`Tom & Jerry <b> "x" 'y'`)).toBe(
      'Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;',
    )
  })

  it('no escapa dos veces lo que ya escapó', () => {
    expect(escapeXml(escapeXml('a&b'))).toBe('a&amp;amp;b')
  })

  it('quita los caracteres de control que XML 1.0 no admite', () => {
    expect(escapeXml('a\u0000b\u0008c\u000Bd\u001Fe\uFFFEf')).toBe('abcdef')
  })

  it('conserva tab, salto de línea y letras con tilde', () => {
    expect(escapeXml('a\tb\nñ á')).toBe('a\tb\nñ á')
  })

  it('quita sustitutos sueltos y deja los pares completos', () => {
    expect(escapeXml('a\uD800b')).toBe('ab')
    expect(escapeXml('x😀y')).toBe('x😀y')
  })
})

describe('say', () => {
  it('lleva voz e idioma, y escapa el texto', () => {
    expect(say('Hola & adiós', 'Polly.Mia-Neural')).toEqual({
      kind: 'say',
      xml: '<Say voice="Polly.Mia-Neural" language="es-MX">Hola &amp; adiós</Say>',
    })
  })

  it('toma el idioma de una voz de Azure', () => {
    expect(say('Hola', 'Azure.es-CO-SalomeNeural').xml).toContain('language="es-CO"')
  })

  it('escapa también la voz', () => {
    expect(say('Hola', 'a"b').xml).toContain('voice="a&quot;b"')
  })
})

describe('gather', () => {
  it('no lleva method y deja los hijos dentro', () => {
    const node = gather(
      { action: 'https://x.test/a?t=1&step=menu', numDigits: 1, timeout: 6 },
      [say('Marca 1', 'Polly.Mia-Neural'), pause(1)],
    )
    expect(node.xml).toBe(
      '<Gather action="https://x.test/a?t=1&amp;step=menu" numDigits="1" timeout="6">' +
        '<Say voice="Polly.Mia-Neural" language="es-MX">Marca 1</Say><Pause length="1"/>' +
        '</Gather>',
    )
    expect(node.xml).not.toContain('method')
  })
})

describe('dial', () => {
  it('lleva method POST, tiempos, callerId y un Number por teléfono', () => {
    const node = dial(
      {
        action: 'https://x.test/dial?t=1&call=2',
        timeout: 25,
        timeLimit: 1800,
        callerId: '+576015550000',
      },
      ['+573001112233', '+573004445566'],
    )
    expect(node.xml).toBe(
      '<Dial action="https://x.test/dial?t=1&amp;call=2" method="POST" timeout="25" timeLimit="1800" callerId="+576015550000">' +
        '<Number>+573001112233</Number><Number>+573004445566</Number></Dial>',
    )
  })

  it('escapa los números', () => {
    expect(dial({ action: 'u', timeout: 1, timeLimit: 2, callerId: 'c' }, ['<1>']).xml).toContain(
      '<Number>&lt;1&gt;</Number>',
    )
  })
})

describe('redirect, pause y hangup', () => {
  it('redirect lleva method POST y escapa la URL', () => {
    expect(redirect('https://x.test/a?b=1&c=2').xml).toBe(
      '<Redirect method="POST">https://x.test/a?b=1&amp;c=2</Redirect>',
    )
  })

  it('pause redondea y no baja de 1 segundo', () => {
    expect(pause(2).xml).toBe('<Pause length="2"/>')
    expect(pause(0).xml).toBe('<Pause length="1"/>')
    expect(pause(1.6).xml).toBe('<Pause length="2"/>')
  })

  it('hangup', () => {
    expect(hangup().xml).toBe('<Hangup/>')
  })
})

describe('response', () => {
  it('envuelve todo en Response con la declaración XML', () => {
    const xml = response([say('Hola', 'Polly.Mia-Neural'), hangup()])
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Say voice="Polly.Mia-Neural" language="es-MX">Hola</Say><Hangup/></Response>',
    )
  })

  it('un menú completo queda bien formado aunque el texto traiga símbolos', () => {
    const xml = response([
      gather({ action: 'https://x.test/a?t=1&step=2', numDigits: 1, timeout: 6 }, [
        say(`Clínica "Sonrisa" & <Cía> 'Ñandú'`, 'Polly.Mia-Neural'),
      ]),
      redirect('https://x.test/b?x=1&y=2'),
      dial({ action: 'https://x.test/c?x=1&y=2', timeout: 25, timeLimit: 1800, callerId: '+57601' }, [
        '+573001112233',
      ]),
      hangup(),
    ])
    assertWellFormed(xml)
  })
})
