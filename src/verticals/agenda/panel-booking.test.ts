import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { computeDaySlots } from './agent/availability'
import { DEFAULT_LABELS } from './labels'
import {
  canMove,
  PANEL_BOOKING_MESSAGES,
  panelBookingMessage,
  validatePanelBooking,
  type PanelBookingRejection,
} from './panel-booking'

// Bogotá es UTC-5 fijo. 2026-11-09 es lunes; el 10 es martes.
const NOW = new Date('2026-11-05T15:00:00.000Z')
/** Lunes 9 de noviembre, 10:00 hora de Bogotá. */
const MON_10 = new Date('2026-11-09T15:00:00.000Z')
/** Instante UTC de una hora local de Bogotá del lunes 9 de noviembre. */
const monLocal = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00.000-05:00`)

const WORK_DAY = [{ weekday: 1, startTime: '09:00:00', endTime: '18:00:00' }]

type Args = Parameters<typeof validatePanelBooking>[0]

function base(overrides: Partial<Args> = {}): Args {
  return {
    startsAt: MON_10,
    durationMinutes: 30,
    now: NOW,
    staffServesService: true,
    workBlocks: WORK_DAY,
    timeOff: [],
    outsideHoursOk: false,
    chairs: null,
    ...overrides,
  }
}

const rejected = (overrides: Partial<Args>): PanelBookingRejection | 'ok' => {
  const res = validatePanelBooking(base(overrides))
  return res.ok ? 'ok' : res.code
}

describe('validatePanelBooking', () => {
  it('acepta una cita dentro del horario y calcula cuándo termina', () => {
    const res = validatePanelBooking(base({ durationMinutes: 45 }))
    expect(res).toEqual({ ok: true, endsAt: new Date('2026-11-09T15:45:00.000Z') })
  })

  it('acepta horas del bloque con o sin segundos', () => {
    const blocks = [{ weekday: 1, startTime: '09:00', endTime: '18:00' }]
    expect(rejected({ workBlocks: blocks })).toBe('ok')
  })

  describe('invalid_input', () => {
    it('rechaza una fecha de inicio inválida', () => {
      expect(rejected({ startsAt: new Date('no es fecha') })).toBe('invalid_input')
    })

    it('rechaza un "ahora" inválido', () => {
      expect(rejected({ now: new Date(NaN) })).toBe('invalid_input')
    })

    it.each([0, -30, 12.5, Number.NaN, Number.POSITIVE_INFINITY, 481])(
      'rechaza la duración %s',
      (durationMinutes) => {
        expect(rejected({ durationMinutes })).toBe('invalid_input')
      },
    )

    it('acepta el tope de 480 minutos que pone la base', () => {
      const blocks = [{ weekday: 1, startTime: '08:00', endTime: '20:00' }]
      expect(rejected({ durationMinutes: 480, workBlocks: blocks })).toBe('ok')
    })
  })

  describe('past', () => {
    it('rechaza una hora que ya pasó', () => {
      expect(rejected({ startsAt: new Date('2026-11-05T14:59:00.000Z') })).toBe('past')
    })

    it('una cita que empieza exactamente ahora aún no es pasada', () => {
      const now = monLocal('10:00')
      expect(rejected({ startsAt: now, now })).toBe('ok')
    })

    it('una hora pasada se rechaza aunque se acepte salir del horario', () => {
      expect(
        rejected({
          startsAt: new Date('2026-11-02T15:00:00.000Z'),
          outsideHoursOk: true,
        }),
      ).toBe('past')
    })
  })

  describe('staff_not_for_service', () => {
    it('rechaza cuando el profesional no atiende el servicio', () => {
      expect(rejected({ staffServesService: false })).toBe('staff_not_for_service')
    })

    it('salir del horario aceptado no salva a quien no atiende el servicio', () => {
      expect(rejected({ staffServesService: false, outsideHoursOk: true })).toBe(
        'staff_not_for_service',
      )
    })
  })

  describe('outside_hours', () => {
    it('empezar justo cuando abre el bloque es válido', () => {
      expect(rejected({ startsAt: monLocal('09:00') })).toBe('ok')
    })

    it('terminar justo cuando cierra el bloque es válido', () => {
      expect(rejected({ startsAt: monLocal('17:30') })).toBe('ok')
    })

    it('empezar antes de que abra el bloque es fuera de horario', () => {
      expect(rejected({ startsAt: monLocal('08:30') })).toBe('outside_hours')
    })

    it('empezar dentro pero terminar después del cierre es fuera de horario', () => {
      expect(rejected({ startsAt: monLocal('17:45') })).toBe('outside_hours')
    })

    it('un día sin bloques es fuera de horario', () => {
      expect(rejected({ workBlocks: [{ weekday: 2, startTime: '09:00', endTime: '18:00' }] })).toBe(
        'outside_hours',
      )
    })

    it('sin ningún bloque es fuera de horario', () => {
      expect(rejected({ workBlocks: [] })).toBe('outside_hours')
    })

    it('la cita debe caber entera en UN bloque (igual que el bot)', () => {
      const split = [
        { weekday: 1, startTime: '09:00', endTime: '12:00' },
        { weekday: 1, startTime: '12:00', endTime: '18:00' },
      ]
      expect(rejected({ startsAt: monLocal('11:45'), workBlocks: split })).toBe('outside_hours')
      expect(rejected({ startsAt: monLocal('12:00'), workBlocks: split })).toBe('ok')
      expect(rejected({ startsAt: monLocal('11:30'), workBlocks: split })).toBe('ok')
    })

    it('usa el día de la semana local, no el UTC', () => {
      // Lunes 22:00 en Bogotá es martes 03:00 UTC.
      const monNight = new Date('2026-11-10T03:00:00.000Z')
      const mondayBlock = [{ weekday: 1, startTime: '20:00', endTime: '23:00' }]
      const tuesdayBlock = [{ weekday: 2, startTime: '20:00', endTime: '23:00' }]
      expect(rejected({ startsAt: monNight, workBlocks: mondayBlock })).toBe('ok')
      expect(rejected({ startsAt: monNight, workBlocks: tuesdayBlock })).toBe('outside_hours')
    })

    it('una cita que cruza la medianoche no cabe en un bloque del día', () => {
      const late = [{ weekday: 1, startTime: '20:00', endTime: '23:59' }]
      expect(rejected({ startsAt: monLocal('23:30'), durationMinutes: 60, workBlocks: late })).toBe(
        'outside_hours',
      )
    })

    it('un bloqueo (time off) que se cruza con la cita la saca del horario', () => {
      const timeOff = [{ startsAt: monLocal('10:15'), endsAt: monLocal('11:00') }]
      expect(rejected({ timeOff })).toBe('outside_hours')
    })

    it('un bloqueo que cubre toda la cita la saca del horario', () => {
      const timeOff = [{ startsAt: monLocal('08:00'), endsAt: monLocal('20:00') }]
      expect(rejected({ timeOff })).toBe('outside_hours')
    })

    it('un bloqueo que empieza justo al terminar la cita no la toca', () => {
      const timeOff = [{ startsAt: monLocal('10:30'), endsAt: monLocal('12:00') }]
      expect(rejected({ timeOff })).toBe('ok')
    })

    it('un bloqueo que termina justo al empezar la cita no la toca', () => {
      const timeOff = [{ startsAt: monLocal('09:00'), endsAt: monLocal('10:00') }]
      expect(rejected({ timeOff })).toBe('ok')
    })

    it('con outsideHoursOk se salta tanto el horario como los bloqueos', () => {
      const timeOff = [{ startsAt: monLocal('09:00'), endsAt: monLocal('12:00') }]
      expect(rejected({ startsAt: monLocal('06:00'), outsideHoursOk: true })).toBe('ok')
      expect(rejected({ timeOff, outsideHoursOk: true })).toBe('ok')
      expect(rejected({ workBlocks: [], outsideHoursOk: true })).toBe('ok')
    })
  })

  describe('chairs_full', () => {
    const slot = (from: string, to: string) => ({ startsAt: monLocal(from), endsAt: monLocal(to) })

    it('sin información de sillones (no es clínica) no limita', () => {
      expect(rejected({ chairs: null })).toBe('ok')
    })

    it('sillones sin cupo puesto no limitan', () => {
      const active = [slot('10:00', '10:30'), slot('10:00', '10:30')]
      expect(rejected({ chairs: { chairCount: null, active } })).toBe('ok')
    })

    it('con una silla libre todavía cabe', () => {
      const chairs = { chairCount: 2, active: [slot('10:00', '10:30')] }
      expect(rejected({ chairs })).toBe('ok')
    })

    it('con tantas citas cruzadas como sillas no cabe', () => {
      const chairs = { chairCount: 2, active: [slot('09:30', '10:15'), slot('10:20', '11:00')] }
      expect(rejected({ chairs })).toBe('chairs_full')
    })

    it('las citas que solo tocan los bordes no ocupan silla', () => {
      const chairs = { chairCount: 1, active: [slot('09:30', '10:00'), slot('10:30', '11:00')] }
      expect(rejected({ chairs })).toBe('ok')
    })

    it('fuera de horario se avisa antes que los sillones', () => {
      const chairs = { chairCount: 1, active: [slot('08:00', '08:45')] }
      expect(rejected({ startsAt: monLocal('08:15'), chairs })).toBe('outside_hours')
    })

    it('aceptar salir del horario no salta el cupo de sillones', () => {
      const chairs = { chairCount: 1, active: [slot('08:00', '08:45')] }
      expect(
        rejected({ startsAt: monLocal('08:15'), chairs, outsideHoursOk: true }),
      ).toBe('chairs_full')
    })
  })

  it('coincide con la rejilla del bot: lo que el bot ofrece, el panel lo acepta', () => {
    const slots = computeDaySlots({
      dateKey: '2026-11-09',
      durationMinutes: 60,
      workBlocks: WORK_DAY,
      busy: [],
      now: NOW,
    })
    expect(slots.length).toBeGreaterThan(0)
    for (const s of slots) {
      const res = validatePanelBooking(base({ startsAt: s.startsAt, durationMinutes: 60 }))
      expect(res).toEqual({ ok: true, endsAt: s.endsAt })
    }
    // Y la primera hora que el bot NO ofrece por quedarse corta de bloque, el panel la rechaza.
    const last = slots[slots.length - 1].startsAt
    const tooLate = new Date(last.getTime() + 30 * 60_000)
    expect(rejected({ startsAt: tooLate, durationMinutes: 60 })).toBe('outside_hours')
  })
})

describe('canMove', () => {
  const future = new Date('2026-11-09T15:00:00.000Z')
  const past = new Date('2026-11-01T15:00:00.000Z')

  it('se puede mover una cita pendiente o confirmada futura', () => {
    expect(canMove('pending', future, NOW)).toBe(true)
    expect(canMove('confirmed', future, NOW)).toBe(true)
  })

  it('una cita que empieza exactamente ahora aún se puede mover', () => {
    expect(canMove('confirmed', NOW, NOW)).toBe(true)
  })

  it('no se puede mover una cita ya pasada', () => {
    expect(canMove('pending', past, NOW)).toBe(false)
    expect(canMove('confirmed', past, NOW)).toBe(false)
  })

  it.each(['cancelled', 'completed', 'no_show'] as const)(
    'no se puede mover una cita en estado %s, aunque sea futura',
    (status) => {
      expect(canMove(status, future, NOW)).toBe(false)
    },
  )

  it('una fecha inválida no se puede mover', () => {
    expect(canMove('pending', new Date(NaN), NOW)).toBe(false)
  })
})

describe('mensajes', () => {
  const CODES = [
    'invalid_input',
    'past',
    'staff_not_for_service',
    'outside_hours',
    'not_editable',
    'chairs_full',
    'slot_taken',
    'stale',
  ] as const

  it('hay un mensaje en español para cada código', () => {
    expect(Object.keys(PANEL_BOOKING_MESSAGES).sort()).toEqual([...CODES].sort())
    for (const code of CODES) {
      expect(PANEL_BOOKING_MESSAGES[code].length).toBeGreaterThan(10)
    }
  })

  it('PANEL_BOOKING_MESSAGES es lo mismo que panelBookingMessage con las palabras por defecto', () => {
    for (const code of CODES) {
      expect(PANEL_BOOKING_MESSAGES[code]).toBe(panelBookingMessage(code, DEFAULT_LABELS))
    }
  })

  it('los mensajes que nombran a quien atiende usan las palabras de la cuenta', () => {
    const labels = { ...DEFAULT_LABELS, profesional: 'doctora', servicio: 'consulta' }
    expect(panelBookingMessage('slot_taken', labels)).toContain('doctora')
    expect(panelBookingMessage('staff_not_for_service', labels)).toContain('doctora')
    expect(panelBookingMessage('staff_not_for_service', labels)).toContain('consulta')
    expect(panelBookingMessage('slot_taken', DEFAULT_LABELS)).toContain('profesional')
  })

  it('no ponen artículo delante de la palabra de la cuenta (el género cambia de un negocio a otro)', () => {
    const labels = { ...DEFAULT_LABELS, profesional: 'XPROF', servicio: 'XSERV', cita: 'XCITA' }
    for (const code of CODES) {
      const text = panelBookingMessage(code, labels)
      expect(text).not.toMatch(/\b(el|la|los|las|un|una|este|esta|ese|esa|otro|otra) (XPROF|XSERV|XCITA)/i)
    }
  })

  it('no nombran a la barbería ni a ningún paciente', () => {
    const source = readFileSync(fileURLToPath(new URL('./panel-booking.ts', import.meta.url)), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/barber/i)
  })
})
