import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { CallSettingsResponse } from '@/verticals/agenda/voice/call-settings-payload'

// ============================================================
// Tarjeta "Llamadas": lo que se ve en cada estado.
// Render estático (como google-calendar-section.test.tsx): los efectos no
// corren, así que no se llama a ninguna ruta ni a Telnyx.
// ============================================================

import { CallsForm, CallsSection, UsageMeter, type CallsFormProps } from './calls-section'
import { draftFromSettings } from './calls-draft'
import { CALLS_TEXTS as C } from './calls-texts'

const DATA: CallSettingsResponse = {
  settings: {
    outbound_enabled: false,
    inbound_enabled: false,
    inbound_number: '+576015550100',
    caller_id: null,
    advisor_phones: ['+573001234567'],
    office_hours: { '1': [['08:00', '18:00']], '6': [['08:00', '13:00']] },
    info_text: '',
    call_after_minutes: 180,
    min_lead_minutes: 120,
    max_attempts: 2,
    retry_minutes: 90,
    window_start: '08:00',
    window_end: '19:00',
    call_saturday: true,
    monthly_limit: 300,
  },
  usage: { month: '2026-11', used: 12 },
  telnyx: { configured: true },
}

function formProps(patch: Partial<CallsFormProps> = {}): CallsFormProps {
  const data = patch.data ?? DATA
  return {
    data,
    draft: draftFromSettings(data.settings),
    onDraftChange: vi.fn(),
    dirty: false,
    saving: false,
    saved: false,
    formError: null,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    testPhone: '',
    onTestPhoneChange: vi.fn(),
    test: { kind: 'idle' },
    onTest: vi.fn(),
    ...patch,
  }
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node)

/** El tag completo de un elemento por su texto de ayuda (aria-label, id…). */
function tagWith(html: string, fragment: string): string {
  const at = html.indexOf(fragment)
  if (at < 0) return ''
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1)
}

/** ¿Lleva el atributo aria-invalid? Ignora las clases `aria-invalid:` de Tailwind. */
const hasInvalidAttr = (html: string): boolean => /\saria-invalid="/.test(html.replace(/class="[^"]*"/g, ''))

/** ¿La etiqueta está desactivada? Ignora las clases `disabled:` de Tailwind. */
function isDisabled(tag: string): boolean {
  expect(tag).not.toBe('')
  return /\s(disabled|data-disabled|aria-disabled)(=|\s|>|\/)/.test(tag.replace(/class="[^"]*"/, ''))
}

describe('CallsSection (primer render)', () => {
  it('mientras carga muestra un esqueleto y ningún formulario', () => {
    const html = render(<CallsSection />)

    expect(html).toContain(C.title)
    expect(html).toContain(C.loading)
    expect(html).not.toContain(C.costNotice)
    expect(html).not.toContain(C.save)
  })
})

describe('CallsForm', () => {
  it('siempre muestra el aviso de costo', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(html).toContain(
      'Las llamadas tienen costo por minuto. Las salientes solo salen de lunes a sábado en tu ventana y nunca en festivos.',
    )
  })

  it('con Telnyx listo no avisa que falta y deja prender los interruptores', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(html).not.toContain(C.telnyxMissing)
    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-outbound-title"'))).toBe(false)
    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-inbound-title"'))).toBe(false)
  })

  it('sin Telnyx lo dice y no deja prender, pero el resto sigue editable', () => {
    const html = render(
      <CallsForm {...formProps({ data: { ...DATA, telnyx: { configured: false } } })} />,
    )

    expect(html).toContain(C.telnyxMissing)
    expect(html).toContain(C.notReadyTelnyx)
    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-outbound-title"'))).toBe(true)
    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-inbound-title"'))).toBe(true)
    // El horario de atención sigue editable.
    expect(isDisabled(tagWith(html, 'aria-label="Lunes, tramo 1: hora de apertura"'))).toBe(false)
  })

  it('ya prendido, se puede apagar aunque falte Telnyx', () => {
    const data: CallSettingsResponse = {
      ...DATA,
      settings: { ...DATA.settings, outbound_enabled: true },
      telnyx: { configured: false },
    }

    const html = render(<CallsForm {...formProps({ data })} />)

    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-outbound-title"'))).toBe(false)
    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-inbound-title"'))).toBe(true)
  })

  it('sin número asignado por Shift explica por qué no se puede prender', () => {
    const data: CallSettingsResponse = {
      ...DATA,
      settings: { ...DATA.settings, inbound_number: null, caller_id: null },
    }

    const html = render(<CallsForm {...formProps({ data })} />)

    expect(html).toContain(C.notReadyOutboundNumber)
    expect(html).toContain(C.notReadyInboundNumber)
    expect(html).toContain(C.numberPending)
    expect(isDisabled(tagWith(html, 'aria-labelledby="calls-outbound-title"'))).toBe(true)
  })

  it('los números de Shift salen en solo lectura, sin campo para escribirlos', () => {
    const data: CallSettingsResponse = {
      ...DATA,
      settings: { ...DATA.settings, caller_id: '+576015550101' },
    }

    const html = render(<CallsForm {...formProps({ data })} />)

    expect(html).toContain('+576015550100')
    expect(html).toContain('+576015550101')
    expect(html).not.toMatch(/<input[^>]*value="\+57601555010[01]"/)
  })

  it('muestra los asesores, el horario con su vista previa y la ventana de llamadas', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(html).toMatch(/<input[^>]*value="\+573001234567"/)
    expect(html).toContain('Atendemos los lunes de 8 a. m. a 6 p. m. y los sábados de 8 a. m. a 1 p. m.')
    expect(html).toContain(C.hoursCopy)
    expect(html).toContain(C.windowStart)
    expect(html).toContain(C.saturday)
    expect(html).toContain(C.attemptsOption(2))
  })

  it('la vista previa no termina con dos puntos seguidos', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(html).toContain('a 1 p. m.')
    expect(html).not.toContain('p. m..')
  })

  it('el domingo (sin tramos) sale cerrado', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(html).toContain(C.hoursClosed)
  })

  it('sin horario guardado la vista previa avisa qué pasa', () => {
    const data: CallSettingsResponse = { ...DATA, settings: { ...DATA.settings, office_hours: {} } }

    expect(render(<CallsForm {...formProps({ data })} />)).toContain(C.hoursPreviewEmpty)
  })

  it('muestra lo usado del mes y el tope', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(html).toContain(C.usageValue(12, 300))
    expect(html).toContain('aria-valuenow="12"')
    expect(html).toContain('aria-valuemax="300"')
  })

  it('la prueba de llamada se activa con Telnyx y avisa el resultado', () => {
    const idle = render(<CallsForm {...formProps()} />)
    expect(isDisabled(tagWith(idle, 'id="calls-test-phone"'))).toBe(false)
    expect(idle).toContain(C.testButton)

    const ok = render(<CallsForm {...formProps({ test: { kind: 'ok' }, testPhone: '+573001234567' })} />)
    expect(ok).toContain(C.testSuccess)

    const failed = render(
      <CallsForm {...formProps({ test: { kind: 'error', message: 'Telnyx rechazó la llamada' } })} />,
    )
    expect(failed).toContain('Telnyx rechazó la llamada')
  })

  it('sin Telnyx la prueba queda desactivada con su explicación', () => {
    const html = render(
      <CallsForm {...formProps({ data: { ...DATA, telnyx: { configured: false } } })} />,
    )

    expect(isDisabled(tagWith(html, 'id="calls-test-phone"'))).toBe(true)
    expect(html).toContain(C.testNeedsTelnyx)
  })

  it('sin cambios, Guardar está desactivado; con cambios se activa y avisa', () => {
    const clean = render(<CallsForm {...formProps()} />)
    expect(clean).not.toContain(C.discard)
    expect(clean).not.toContain(C.unsaved)
    const saveAt = clean.lastIndexOf('<button', clean.indexOf(C.save))
    expect(isDisabled(clean.slice(saveAt, clean.indexOf('>', saveAt) + 1))).toBe(true)

    const dirty = render(<CallsForm {...formProps({ dirty: true })} />)
    expect(dirty).toContain(C.discard)
    expect(dirty).toContain(C.unsaved)
    const dirtySaveAt = dirty.lastIndexOf('<button', dirty.indexOf(C.save))
    expect(isDisabled(dirty.slice(dirtySaveAt, dirty.indexOf('>', dirtySaveAt) + 1))).toBe(false)
  })

  it('muestra el error de guardado y la confirmación', () => {
    expect(render(<CallsForm {...formProps({ formError: 'Los intentos por cita no son válidos.' })} />)).toContain(
      'Los intentos por cita no son válidos.',
    )
    expect(render(<CallsForm {...formProps({ saved: true })} />)).toContain(C.saved)
  })

  describe('accesibilidad de los errores de validación', () => {
    const MESSAGE = 'Los minutos entre intentos debe ser un número entero entre 1 y 2880.'

    it('el campo con error se marca aria-invalid y apunta al mensaje (además de su ayuda)', () => {
      const html = render(
        <CallsForm {...formProps({ formError: MESSAGE, errorFields: ['calls-retry'] })} />,
      )

      const retry = tagWith(html, 'id="calls-retry"')
      expect(retry).toContain(' aria-invalid="true"')
      expect(retry).toContain('aria-describedby="calls-retry-hint calls-form-error"')
      // El mensaje existe con ese id, así que el aria-describedby no queda colgando.
      expect(html).toMatch(/id="calls-form-error"[^>]*>[^<]*Los minutos entre intentos/)
    })

    it('solo se marca el campo que falló: los demás quedan como estaban', () => {
      const html = render(
        <CallsForm {...formProps({ formError: MESSAGE, errorFields: ['calls-retry'] })} />,
      )

      for (const id of ['calls-after', 'calls-lead', 'calls-window-start', 'calls-info']) {
        expect(hasInvalidAttr(tagWith(html, `id="${id}"`))).toBe(false)
        expect(tagWith(html, `id="${id}"`)).not.toContain('calls-form-error')
      }
      expect(tagWith(html, 'id="calls-after"')).toContain('aria-describedby="calls-after-hint"')
    })

    it('las horas de la ventana y el texto de horario también se pueden marcar', () => {
      const html = render(
        <CallsForm
          {...formProps({
            formError: 'La hora de inicio debe ser antes que la de fin.',
            errorFields: ['calls-window-start', 'calls-window-end', 'calls-info'],
          })}
        />,
      )

      for (const id of ['calls-window-start', 'calls-window-end']) {
        expect(tagWith(html, `id="${id}"`)).toContain(' aria-invalid="true"')
        expect(tagWith(html, `id="${id}"`)).toContain('aria-describedby="calls-form-error"')
      }
      expect(tagWith(html, 'id="calls-info"')).toContain('aria-describedby="calls-info-hint calls-form-error"')
    })

    it('sin error, ningún campo se marca ni apunta al mensaje', () => {
      const html = render(<CallsForm {...formProps()} />)

      expect(hasInvalidAttr(html)).toBe(false)
      expect(html).not.toContain('calls-form-error')
    })

    it('un error sin campo propio (el horario) muestra el mensaje y no marca ninguno', () => {
      const html = render(<CallsForm {...formProps({ formError: MESSAGE, errorFields: [] })} />)

      expect(html).toContain('id="calls-form-error"')
      expect(hasInvalidAttr(html)).toBe(false)
    })
  })

  it('cada campo de minutos tiene su propio mínimo: entre intentos desde 1, los demás desde 0', () => {
    const html = render(<CallsForm {...formProps()} />)

    expect(tagWith(html, 'id="calls-retry"')).toContain(' min="1"')
    expect(tagWith(html, 'id="calls-after"')).toContain(' min="0"')
    expect(tagWith(html, 'id="calls-lead"')).toContain(' min="0"')
  })

  it('sin el uso del mes (después de guardar) no pinta el medidor y lo explica', () => {
    const html = render(<CallsForm {...formProps({ data: { ...DATA, usage: null } })} />)

    expect(html).not.toContain('aria-valuenow')
    expect(html).toContain(C.usageUnavailable)
  })

  it('al guardar muestra el estado y bloquea los campos', () => {
    const html = render(<CallsForm {...formProps({ dirty: true, saving: true })} />)

    expect(html).toContain(C.saving)
    expect(isDisabled(tagWith(html, 'id="calls-info"'))).toBe(true)
  })

  it('no lleva guiones largos en ningún texto visible', () => {
    const html = render(<CallsForm {...formProps({ dirty: true })} />)

    expect(html).not.toContain('—')
    expect(html).not.toContain('–')
  })
})

describe('UsageMeter', () => {
  it('lejos del tope usa el texto normal', () => {
    expect(render(<UsageMeter used={12} limit={300} />)).toContain(C.usageHint)
  })

  it('cerca del tope avisa cuántas quedan', () => {
    expect(render(<UsageMeter used={280} limit={300} />)).toContain(C.usageLow(20))
    expect(render(<UsageMeter used={299} limit={300} />)).toContain(C.usageLow(1))
  })

  it('en el tope dice que no saldrán más llamadas', () => {
    const html = render(<UsageMeter used={300} limit={300} />)

    expect(html).toContain(C.usageFull)
    expect(html).toContain('width:100%')
  })

  it('con tope 0 no divide entre cero', () => {
    const html = render(<UsageMeter used={0} limit={0} />)

    expect(html).toContain(C.usageFull)
  })
})
