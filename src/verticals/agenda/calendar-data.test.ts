import { describe, expect, it } from 'vitest'

import { appointmentTitle, parseContactQuery } from './calendar-data'

describe('parseContactQuery', () => {
  it('pide al menos 2 letras para buscar por nombre', () => {
    expect(parseContactQuery('')).toBeNull()
    expect(parseContactQuery(' a ')).toBeNull()
    expect(parseContactQuery('Lu')).toEqual({ kind: 'name', text: 'Lu' })
  })

  it('pide al menos 3 números para buscar por celular', () => {
    expect(parseContactQuery('30')).toBeNull()
    expect(parseContactQuery('300')).toEqual({ kind: 'phone', text: '300' })
  })

  it('un celular con indicativo, espacios y guiones se busca solo con los números', () => {
    expect(parseContactQuery('+57 300-123 45')).toEqual({ kind: 'phone', text: '5730012345' })
  })

  it('quita los signos que rompen el filtro de la base', () => {
    expect(parseContactQuery('Ana,(Pérez)%_*')).toEqual({ kind: 'name', text: 'AnaPérez' })
    expect(parseContactQuery('  María   José  ')).toEqual({ kind: 'name', text: 'María José' })
  })

  it('si después de limpiar no queda nada útil, no busca', () => {
    expect(parseContactQuery('%%%')).toBeNull()
    expect(parseContactQuery(',,,')).toBeNull()
  })

  it('corta lo demasiado largo', () => {
    const q = parseContactQuery('x'.repeat(200))
    expect(q?.text.length).toBe(60)
  })
})

describe('appointmentTitle', () => {
  const base = { patientName: null, contactName: null, contactPhone: null }

  it('en clínica manda el paciente', () => {
    expect(appointmentTitle({ ...base, patientName: 'Lucía Pérez', contactName: 'Mamá de Lucía' }, 'Sin nombre')).toBe(
      'Lucía Pérez',
    )
  })

  it('sin paciente usa el contacto y, si falta, el celular', () => {
    expect(appointmentTitle({ ...base, contactName: 'Mateo Rojas', contactPhone: '+57300' }, 'Sin nombre')).toBe(
      'Mateo Rojas',
    )
    expect(appointmentTitle({ ...base, contactName: '  ', contactPhone: '+573001112233' }, 'Sin nombre')).toBe(
      '+573001112233',
    )
  })

  it('sin nada usa el texto de respaldo', () => {
    expect(appointmentTitle(base, 'Sin nombre')).toBe('Sin nombre')
  })
})
