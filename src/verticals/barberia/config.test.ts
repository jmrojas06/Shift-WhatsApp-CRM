import { describe, expect, it } from 'vitest'

import {
  ADDRESS_MAX,
  BIO_MAX,
  ConfigError,
  DURATION_MAX_MINUTES,
  MAX_WORK_BLOCKS,
  PRICE_MAX,
  SERVICE_NAME_MAX,
  TIME_OFF_MAX_DAYS,
  validateConfigPatch,
  validateOrder,
  validateServiceCreate,
  validateServiceUpdate,
  validateStaffCreate,
  validateStaffServices,
  validateStaffUpdate,
  validateTimeOffCreate,
  validateWorkingHours,
} from './config'

// ============================================================
// Validadores de configuración — puros. Cada caso comprueba el
// contrato del borde y que el mensaje es claro (es-CO) para la UI.
// ============================================================

const serviceBody = {
  name: 'Corte clásico',
  description: 'Máquina y tijera',
  duration_minutes: 30,
  price: 25000,
}

describe('validateServiceCreate', () => {
  it('acepta un servicio completo y recorta el nombre', () => {
    const result = validateServiceCreate({ ...serviceBody, name: '  Corte  ' })
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Corte',
        description: 'Máquina y tijera',
        durationMinutes: 30,
        price: 25000,
        isActive: true,
      },
    })
  })

  it('exige el nombre y su tope', () => {
    expect(validateServiceCreate({ ...serviceBody, name: '   ' })).toEqual({
      ok: false,
      message: 'El nombre del servicio es obligatorio.',
    })
    const long = validateServiceCreate({
      ...serviceBody,
      name: 'x'.repeat(SERVICE_NAME_MAX + 1),
    })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.message).toContain(String(SERVICE_NAME_MAX))
  })

  it('acepta descripción ausente, vacía o null como null', () => {
    for (const description of [undefined, '', '   ', null]) {
      const result = validateServiceCreate({ ...serviceBody, description })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.description).toBeNull()
    }
  })

  it('valida duración: entero dentro de rango', () => {
    for (const bad of [0, -5, DURATION_MAX_MINUTES + 1, 30.5, '30', null]) {
      const result = validateServiceCreate({ ...serviceBody, duration_minutes: bad })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('duración')
    }
    const ok = validateServiceCreate({ ...serviceBody, duration_minutes: 480 })
    expect(ok.ok).toBe(true)
  })

  it('valida precio: rango, finito y máximo 2 decimales', () => {
    for (const bad of [-1, PRICE_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY, 100.999, 'abc', null]) {
      const result = validateServiceCreate({ ...serviceBody, price: bad })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('precio')
    }
    const ok = validateServiceCreate({ ...serviceBody, price: 12000.5 })
    expect(ok.ok).toBe(true)
  })

  it('is_active es opcional pero debe ser booleano', () => {
    const ok = validateServiceCreate({ ...serviceBody, is_active: false })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.isActive).toBe(false)

    const bad = validateServiceCreate({ ...serviceBody, is_active: 'sí' })
    expect(bad.ok).toBe(false)
  })

  it('rechaza cuerpos que no son objeto', () => {
    for (const bad of [null, 'hola', 42, ['a']]) {
      expect(validateServiceCreate(bad).ok).toBe(false)
    }
  })
})

describe('validateServiceUpdate', () => {
  it('acepta cambios parciales y detecta que no haya ninguno', () => {
    const result = validateServiceUpdate({ price: 30000, is_active: false })
    expect(result).toEqual({ ok: true, value: { price: 30000, isActive: false } })

    const empty = validateServiceUpdate({})
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.message).toContain('No hay cambios')
  })

  it('description null limpia el campo', () => {
    const result = validateServiceUpdate({ description: null })
    expect(result).toEqual({ ok: true, value: { description: null } })
  })

  it('valida los campos presentes con las mismas reglas', () => {
    expect(validateServiceUpdate({ duration_minutes: 0 }).ok).toBe(false)
    expect(validateServiceUpdate({ name: '' }).ok).toBe(false)
  })
})

describe('validateStaffCreate / validateStaffUpdate', () => {
  it('crea con nombre obligatorio y bio opcional', () => {
    const result = validateStaffCreate({ name: '  Andrés  ' })
    expect(result).toEqual({ ok: true, value: { name: 'Andrés', bio: null } })

    const withBio = validateStaffCreate({ name: 'Andrés', bio: '  Fades  ' })
    expect(withBio).toEqual({
      ok: true,
      value: { name: 'Andrés', bio: 'Fades' },
    })
  })

  it('corta en los topes de nombre y bio', () => {
    expect(
      validateStaffCreate({ name: 'x'.repeat(81) }).ok,
    ).toBe(false)
    const longBio = validateStaffCreate({
      name: 'Andrés',
      bio: 'x'.repeat(BIO_MAX + 1),
    })
    expect(longBio.ok).toBe(false)
  })

  it('update parcial: is_active y bio', () => {
    expect(validateStaffUpdate({ is_active: true })).toEqual({
      ok: true,
      value: { isActive: true },
    })
    expect(validateStaffUpdate({}).ok).toBe(false)
    expect(validateStaffUpdate({ bio: 12 }).ok).toBe(false)
  })
})

describe('validateStaffServices', () => {
  it('acepta lista de ids única y recortada', () => {
    expect(
      validateStaffServices({ service_ids: [' a ', 'b'] }),
    ).toEqual({ ok: true, value: ['a', 'b'] })
  })

  it('rechaza repetidos, no-strings y cuerpos sin lista', () => {
    expect(validateStaffServices({ service_ids: ['a', 'a'] }).ok).toBe(false)
    expect(validateStaffServices({ service_ids: ['a', 2] }).ok).toBe(false)
    expect(validateStaffServices({}).ok).toBe(false)
    expect(validateStaffServices(null).ok).toBe(false)
  })
})

describe('validateWorkingHours', () => {
  it('normaliza horas y acepta turnos partidos (almuerzo)', () => {
    const result = validateWorkingHours([
      { weekday: 1, start_time: '9:00', end_time: '12:00' },
      { weekday: 1, start_time: '13:00', end_time: '18:00' },
    ])
    expect(result).toEqual({
      ok: true,
      value: [
        { weekday: 1, startTime: '09:00', endTime: '12:00' },
        { weekday: 1, startTime: '13:00', endTime: '18:00' },
      ],
    })
  })

  it('permite bloques que se tocan (fin = inicio del siguiente)', () => {
    const result = validateWorkingHours([
      { weekday: 2, start_time: '09:00', end_time: '12:00' },
      { weekday: 2, start_time: '12:00', end_time: '17:00' },
    ])
    expect(result.ok).toBe(true)
  })

  it('rechaza fin <= inicio nombrando el día', () => {
    const result = validateWorkingHours([
      { weekday: 3, start_time: '18:00', end_time: '09:00' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('miércoles')
      expect(result.message).toContain('mayor')
    }
  })

  it('rechaza traslapes dentro del mismo día', () => {
    const result = validateWorkingHours([
      { weekday: 1, start_time: '09:00', end_time: '13:00' },
      { weekday: 1, start_time: '12:00', end_time: '18:00' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('lunes')
  })

  it('el mismo rango en días distintos no es traslape', () => {
    const result = validateWorkingHours([
      { weekday: 1, start_time: '09:00', end_time: '13:00' },
      { weekday: 2, start_time: '09:00', end_time: '13:00' },
    ])
    expect(result.ok).toBe(true)
  })

  it('valida formato, días y tope de bloques', () => {
    expect(
      validateWorkingHours([{ weekday: 1, start_time: '25:00', end_time: '26:00' }]).ok,
    ).toBe(false)
    expect(validateWorkingHours([{ weekday: 7, start_time: '09:00' }]).ok).toBe(false)
    expect(
      validateWorkingHours(
        Array.from({ length: MAX_WORK_BLOCKS + 1 }, () => ({
          weekday: 1,
          start_time: '09:00',
          end_time: '10:00',
        })),
      ).ok,
    ).toBe(false)
    expect(validateWorkingHours('nope').ok).toBe(false)
  })

  it('lista vacía es válida (borrar el horario)', () => {
    expect(validateWorkingHours([])).toEqual({ ok: true, value: [] })
  })
})

describe('validateTimeOffCreate', () => {
  const base = {
    staff_id: 'st-1',
    starts_at: '2026-11-02T13:00:00.000Z',
    ends_at: '2026-11-04T22:00:00.000Z',
    reason: '  Vacaciones  ',
  }

  it('acepta un rango válido y recorta el motivo', () => {
    const result = validateTimeOffCreate(base)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.staffId).toBe('st-1')
      expect(result.value.reason).toBe('Vacaciones')
      expect(result.value.startsAtIso).toBe('2026-11-02T13:00:00.000Z')
    }
  })

  it('exige staff y fechas parseables con fin > inicio', () => {
    expect(validateTimeOffCreate({ ...base, staff_id: '' }).ok).toBe(false)
    expect(validateTimeOffCreate({ ...base, starts_at: 'ayer' }).ok).toBe(false)
    expect(
      validateTimeOffCreate({ ...base, ends_at: base.starts_at }).ok,
    ).toBe(false)
  })

  it('corta rangos mayores a 366 días y motivos largos', () => {
    const tooLong = {
      ...base,
      ends_at: new Date(
        Date.parse(base.starts_at) + (TIME_OFF_MAX_DAYS + 1) * 86_400_000,
      ).toISOString(),
    }
    expect(validateTimeOffCreate(tooLong).ok).toBe(false)

    expect(
      validateTimeOffCreate({ ...base, reason: 'x'.repeat(121) }).ok,
    ).toBe(false)
  })

  it('motivo vacío o null se guarda como null', () => {
    for (const reason of ['', null, undefined]) {
      const result = validateTimeOffCreate({ ...base, reason })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.reason).toBeNull()
    }
  })
})

describe('validateOrder', () => {
  it('acepta una permutación exacta', () => {
    expect(validateOrder({ ids: ['b', 'a', 'c'] }, ['a', 'b', 'c'])).toEqual({
      ok: true,
      value: ['b', 'a', 'c'],
    })
  })

  it('rechaza faltantes, sobrantes, repetidos y ajenos', () => {
    expect(validateOrder({ ids: ['a', 'b'] }, ['a', 'b', 'c']).ok).toBe(false)
    expect(validateOrder({ ids: ['a', 'b', 'c', 'd'] }, ['a', 'b', 'c']).ok).toBe(false)
    expect(validateOrder({ ids: ['a', 'a', 'c'] }, ['a', 'b', 'c']).ok).toBe(false)
    expect(validateOrder({ ids: ['a', 'b', 'z'] }, ['a', 'b', 'c']).ok).toBe(false)
    expect(validateOrder({ ids: 'abc' }, ['a', 'b', 'c']).ok).toBe(false)
  })
})

describe('validateConfigPatch', () => {
  it('acepta dirección, moneda, señal y textos', () => {
    const result = validateConfigPatch({
      address: '  Cra. 7 # 45-12  ',
      currency: 'cop',
      reminders_2h_enabled: true,
      bot_texts: { welcome: 'Hola 👋' },
    })
    expect(result).toEqual({
      ok: true,
      value: {
        address: 'Cra. 7 # 45-12',
        currency: 'COP',
        reminders2hEnabled: true,
        botTexts: { welcome: 'Hola 👋' },
      },
    })
  })

  it('dirección vacía o null limpia el campo', () => {
    for (const address of ['', null]) {
      const result = validateConfigPatch({ address })
      expect(result).toEqual({ ok: true, value: { address: null } })
    }
  })

  it('rechaza monedas que no son ISO de 3 letras y direcciones largas', () => {
    for (const bad of ['US', 'EURO', 'U$S', 42]) {
      expect(validateConfigPatch({ currency: bad }).ok).toBe(false)
    }
    expect(
      validateConfigPatch({ address: 'x'.repeat(ADDRESS_MAX + 1) }).ok,
    ).toBe(false)
  })

  it('valida la señal de 2 h como booleana', () => {
    expect(validateConfigPatch({ reminders_2h_enabled: 'sí' }).ok).toBe(false)
    expect(validateConfigPatch({ reminders_2h_enabled: false })).toEqual({
      ok: true,
      value: { reminders2hEnabled: false },
    })
  })

  it('propaga los errores de los textos del bot y exige algún cambio', () => {
    const bad = validateConfigPatch({ bot_texts: { welcome: 7 } })
    expect(bad.ok).toBe(false)
    expect(validateConfigPatch({}).ok).toBe(false)
    expect(validateConfigPatch(null).ok).toBe(false)
  })
})

describe('ConfigError', () => {
  it('lleva código y mensaje', () => {
    const err = new ConfigError('not_found', 'El servicio no existe.')
    expect(err.code).toBe('not_found')
    expect(err.message).toBe('El servicio no existe.')
    expect(err instanceof Error).toBe(true)
  })
})
