import { describe, expect, it } from 'vitest'

import {
  computeDaySlots,
  mergeSlotsByStart,
  type WorkBlock,
} from './availability'

// ============================================================
// Cálculo de disponibilidad — puro: recibe bloques de horario,
// ocupaciones y `now`; devuelve slots. Sin base de datos.
//
// Referencias de tiempo (America/Bogota = UTC-5):
//   2026-10-19 (lunes): 09:00-13:00 y 14:00-19:00 locales
//   09:00 local = 14:00Z · 19:00 local = 00:00Z del día siguiente
// ============================================================

const MONDAY = '2026-10-19'
const JORNADA: WorkBlock[] = [
  { weekday: 1, startTime: '09:00:00', endTime: '13:00:00' },
  { weekday: 1, startTime: '14:00:00', endTime: '19:00:00' },
]

// 08:00 de la mañana local del lunes.
const NOW = new Date('2026-10-19T13:00:00Z')

describe('computeDaySlots', () => {
  it('genera la rejilla de 30 minutos dentro de los bloques del día', () => {
    const slots = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 30,
      workBlocks: JORNADA,
      busy: [],
      now: NOW,
    })

    // Mañana: 09:00→12:30 (8). Tarde: 14:00→18:30 (10).
    expect(slots).toHaveLength(18)
    expect(slots[0]).toMatchObject({
      startsAt: new Date('2026-10-19T14:00:00Z'),
      label: '9:00 a. m.',
    })
    expect(slots[7].label).toBe('12:30 p. m.')
    expect(slots[8].label).toBe('2:00 p. m.')
    expect(slots[17]).toMatchObject({
      startsAt: new Date('2026-10-19T23:30:00Z'),
      label: '6:30 p. m.',
    })
    expect(slots.every((s) => s.dateKey === MONDAY)).toBe(true)
  })

  it('respeta la pausa del mediodía (jornada partida)', () => {
    const slots = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 30,
      workBlocks: JORNADA,
      busy: [],
      now: NOW,
    })
    expect(slots.map((s) => s.label)).not.toContain('1:00 p. m.')
    expect(slots.map((s) => s.label)).not.toContain('1:30 p. m.')
  })

  it('un servicio de 45 minutos solo entra si cabe completo en el bloque', () => {
    const slots = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 45,
      workBlocks: [JORNADA[0]],
      busy: [],
      now: NOW,
    })
    // 09:00→12:00 arrancan; 12:30 ya no cabe (12:30+45 > 13:00).
    expect(slots).toHaveLength(7)
    expect(slots.at(-1)?.label).toBe('12:00 p. m.')
    expect(slots.at(-1)?.endsAt.toISOString()).toBe(
      '2026-10-19T17:45:00.000Z',
    )
  })

  it('excluye horas ocupadas por citas y bloqueos de time off', () => {
    const slots = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 30,
      workBlocks: [JORNADA[0]],
      busy: [
        // Una cita a las 9:00 y un bloqueo a las 11:00 (ambos locales).
        { startsAt: new Date('2026-10-19T14:00:00Z'), endsAt: new Date('2026-10-19T14:30:00Z') },
        { startsAt: new Date('2026-10-19T16:00:00Z'), endsAt: new Date('2026-10-19T17:00:00Z') },
      ],
      now: NOW,
    })
    const labels = slots.map((s) => s.label)
    expect(labels).not.toContain('9:00 a. m.')
    expect(labels).not.toContain('11:00 a. m.')
    expect(labels).not.toContain('11:30 a. m.')
    expect(labels).toContain('10:30 a. m.')
    expect(labels).toContain('12:00 p. m.')
  })

  it('no ofrece horarios dentro del margen de anticipación', () => {
    const slots = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 30,
      workBlocks: JORNADA,
      busy: [],
      // 14:10 local: con 30 min de margen, lo más pronto es 14:40.
      now: new Date('2026-10-19T19:10:00Z'),
    })
    expect(slots[0].label).toBe('3:00 p. m.')
    expect(slots.map((s) => s.label)).not.toContain('2:30 p. m.')
  })

  it('un día sin bloques para ese weekday no produce slots', () => {
    const slots = computeDaySlots({
      dateKey: '2026-10-18', // domingo
      durationMinutes: 30,
      workBlocks: JORNADA,
      busy: [],
      now: NOW,
    })
    expect(slots).toEqual([])
  })
})

describe('mergeSlotsByStart', () => {
  it('fusiona horarios de varios barberos por hora de inicio', () => {
    const a = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 30,
      workBlocks: [JORNADA[0]],
      busy: [],
      now: NOW,
    })
    // Beto empieza más tarde: 10:00-12:00 local (15:00Z-17:00Z).
    const betoBlocks: WorkBlock[] = [
      { weekday: 1, startTime: '10:00:00', endTime: '12:00:00' },
    ]
    const b = computeDaySlots({
      dateKey: MONDAY,
      durationMinutes: 30,
      workBlocks: betoBlocks,
      busy: [],
      now: NOW,
    })

    const merged = mergeSlotsByStart([
      { staffId: 'andres', slots: a },
      { staffId: 'beto', slots: b },
    ])

    expect(merged[0]).toMatchObject({
      startsAt: new Date('2026-10-19T14:00:00Z'),
      staffIds: ['andres'],
    })
    const at10 = merged.find((m) => m.label === '10:00 a. m.')
    expect(at10?.staffIds).toEqual(['andres', 'beto'])
    const at11 = merged.find((m) => m.label === '11:00 a. m.')
    expect(at11?.staffIds).toEqual(['andres', 'beto'])
    // 12:00 solo lo tiene Andrés.
    const at12 = merged.find((m) => m.label === '12:00 p. m.')
    expect(at12?.staffIds).toEqual(['andres'])
    // Orden ascendente por hora.
    const times = merged.map((m) => m.startsAt.getTime())
    expect(times).toEqual([...times].sort((x, y) => x - y))
  })
})
