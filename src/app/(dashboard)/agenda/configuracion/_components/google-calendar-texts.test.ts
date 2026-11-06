import { describe, expect, it } from 'vitest'

import { RETURN_REASONS } from '@/app/api/integrations/google-calendar/_lib/google-env'

import {
  GENERAL_CALENDAR_VALUE,
  GOOGLE_TEXTS,
  calendarSelectValue,
  calendarValueToSave,
  formatLastSync,
  readReturnFeedback,
} from './google-calendar-texts'

describe('readReturnFeedback', () => {
  it('?google=ok es un aviso de éxito', () => {
    const feedback = readReturnFeedback('?google=ok')
    expect(feedback).toEqual({ kind: 'success', message: GOOGLE_TEXTS.returnOk, reason: null })
  })

  it('cada motivo que manda el servidor tiene un mensaje propio', () => {
    for (const reason of RETURN_REASONS) {
      const feedback = readReturnFeedback(`?google=error&reason=${reason}`)
      expect(feedback?.kind).toBe('error')
      expect(feedback?.reason).toBe(reason)
      expect(feedback?.message).toBe(GOOGLE_TEXTS.returnReasons[reason])
      expect(feedback?.message).not.toBe(GOOGLE_TEXTS.returnGeneric)
    }
  })

  it('sin permiso permanente explica cómo quitar el acceso de Shift y volver a conectar', () => {
    const feedback = readReturnFeedback('?google=error&reason=no_refresh_token')
    expect(feedback?.message).toContain('Quita el acceso de Shift en tu cuenta de Google')
    expect(feedback?.message).toContain('vuelve a conectar')
  })

  it('un motivo desconocido usa el mensaje general (no se pinta texto de la URL)', () => {
    const feedback = readReturnFeedback('?google=error&reason=<script>alert(1)</script>')
    expect(feedback).toEqual({
      kind: 'error',
      message: GOOGLE_TEXTS.returnGeneric,
      reason: null,
    })
  })

  it('un error sin motivo usa el mensaje general', () => {
    expect(readReturnFeedback('?google=error')?.message).toBe(GOOGLE_TEXTS.returnGeneric)
  })

  it('sin el parámetro, o con otro valor, no hay aviso', () => {
    expect(readReturnFeedback('')).toBeNull()
    expect(readReturnFeedback('?tab=staff')).toBeNull()
    expect(readReturnFeedback('?google=maybe')).toBeNull()
  })
})

describe('formatLastSync', () => {
  const now = new Date('2026-11-05T15:00:00.000Z')

  it('sin fecha dice que aún no se copió nada', () => {
    expect(formatLastSync(null, now)).toBe(GOOGLE_TEXTS.neverSynced)
  })

  it('hace menos de un minuto', () => {
    expect(formatLastSync('2026-11-05T14:59:40.000Z', now)).toBe('Hace un momento')
  })

  it('hace minutos', () => {
    expect(formatLastSync('2026-11-05T14:55:00.000Z', now)).toBe('Hace 5 min')
  })

  it('hace horas', () => {
    expect(formatLastSync('2026-11-05T12:00:00.000Z', now)).toBe('Hace 3 h')
  })

  it('hace más de un día muestra la fecha en hora de Bogotá', () => {
    // 2026-11-02 18:30 UTC = 13:30 en Bogotá (UTC-5).
    const text = formatLastSync('2026-11-02T18:30:00.000Z', now)
    expect(text).toContain('2')
    expect(text).toMatch(/13:30|1:30/)
  })

  it('una fecha rota se trata como sin copiar', () => {
    expect(formatLastSync('no-es-una-fecha', now)).toBe(GOOGLE_TEXTS.neverSynced)
  })
})

describe('selector de calendario', () => {
  const calendars = [
    { id: 'clinica@example.com', name: 'clinica@example.com', primary: true },
    { id: 'sala-1@group.calendar.google.com', name: 'Sala 1', primary: false },
  ]

  it('"primary" se muestra como el calendario principal de la lista', () => {
    expect(calendarSelectValue('primary', calendars)).toBe('clinica@example.com')
  })

  it('un calendario elegido se muestra tal cual', () => {
    expect(calendarSelectValue('sala-1@group.calendar.google.com', calendars)).toBe(
      'sala-1@group.calendar.google.com',
    )
  })

  it('al elegir el principal se guarda "primary"', () => {
    expect(calendarValueToSave('clinica@example.com', calendars)).toBe('primary')
    expect(calendarValueToSave('sala-1@group.calendar.google.com', calendars)).toBe(
      'sala-1@group.calendar.google.com',
    )
  })

  it('sin lista, "primary" queda como "primary"', () => {
    expect(calendarSelectValue('primary', [])).toBe('primary')
    expect(calendarValueToSave('primary', [])).toBe('primary')
  })

  it('el valor del "calendario general" no se confunde con ningún id', () => {
    expect(GENERAL_CALENDAR_VALUE).toMatch(/^__/)
  })
})
