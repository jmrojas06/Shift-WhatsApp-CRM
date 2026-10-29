import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Combobox, type ComboboxProps } from './combobox'

// ============================================================
// Combobox: input con lista filtrable. Los textos llegan por props
// (el componente no trae ninguno fijo) y el input queda con los
// atributos ARIA de un combobox. El filtrado y el teclado los pone
// Base UI; aquí se fija lo que es nuestro: el contrato de props y
// el marcado inicial.
// ============================================================

interface Person {
  id: string
  name: string
  phone: string
}

const people: Person[] = [
  { id: 'a', name: 'Ana Gómez', phone: '+57 300 111 2222' },
  { id: 'b', name: 'Luis Pérez', phone: '+57 300 333 4444' },
]

function render(overrides: Partial<ComboboxProps<Person>> = {}) {
  return renderToStaticMarkup(
    React.createElement(Combobox<Person>, {
      items: people,
      value: null,
      onValueChange: () => {},
      getItemKey: (p) => p.id,
      getItemLabel: (p) => p.name,
      getItemDescription: (p) => p.phone,
      emptyText: 'Sin resultados',
      triggerLabel: 'Mostrar opciones',
      clearLabel: 'Quitar selección',
      placeholder: 'Buscar por nombre',
      id: 'person',
      ...overrides,
    }),
  )
}

describe('<Combobox />', () => {
  it('el input es un combobox con su id, placeholder y autocompletado apagado', () => {
    const html = render()
    expect(html).toContain('role="combobox"')
    expect(html).toContain('id="person"')
    expect(html).toContain('placeholder="Buscar por nombre"')
    expect(html).toContain('autoComplete="off"')
    // Cerrado: la lista y sus opciones no están en el DOM.
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('Ana Gómez')
  })

  it('el botón de abrir lleva el nombre accesible recibido por props', () => {
    const html = render({ triggerLabel: 'Mostrar contactos' })
    expect(html).toContain('aria-label="Mostrar contactos"')
  })

  it('muestra la etiqueta de la opción elegida en el input', () => {
    const html = render({ value: people[0] })
    expect(html).toContain('value="Ana Gómez"')
  })

  it('marca el campo inválido y lo enlaza con su mensaje', () => {
    const html = render({ invalid: true, 'aria-describedby': 'person-error' })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="person-error"')
  })

  it('sin invalid no pone aria-invalid', () => {
    expect(render()).not.toContain('aria-invalid="')
  })

  it('usa aria-label cuando no hay una etiqueta visible', () => {
    const html = render({ id: undefined, 'aria-label': 'Contacto' })
    expect(html).toContain('aria-label="Contacto"')
  })

  it('deshabilitado: el input queda deshabilitado', () => {
    expect(render({ disabled: true })).toMatch(/<input[^>]*\sdisabled=""/)
  })

  it('no trae textos fijos: sin props de texto no aparece ninguno', () => {
    const html = render({
      placeholder: undefined,
      emptyText: '',
      triggerLabel: 'x',
      clearLabel: undefined,
    })
    expect(html).not.toContain('Sin resultados')
    expect(html).not.toContain('Quitar selección')
  })
})
