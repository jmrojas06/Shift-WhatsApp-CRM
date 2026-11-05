import { describe, expect, it } from 'vitest'

import type { AppointmentStatus } from './appointments'
import { buildColumns } from './calendar-columns'
import type { CalendarAppointment, CalendarData } from './calendar-data'

const bogota = (dateKey: string, time: string): Date => new Date(`${dateKey}T${time}:00-05:00`)

const TUE = '2026-11-10' // martes
const SUN = '2026-11-15'

const staffA = { id: 'sa', name: 'Dra. Ruiz', isActive: true }
const staffB = { id: 'sb', name: 'Dr. Mora', isActive: true }
const staffOld = { id: 'so', name: 'Dra. Vieja', isActive: false }

function appt(
  id: string,
  staffId: string | null,
  dateKey: string,
  from: string,
  to: string,
  status: AppointmentStatus = 'confirmed',
): CalendarAppointment {
  return {
    id,
    startsAt: bogota(dateKey, from),
    endsAt: bogota(dateKey, to),
    status,
    staffId,
    serviceId: 'sv',
    serviceName: 'Limpieza',
    contactId: 'c',
    contactName: 'Paciente',
    contactPhone: null,
    patientName: null,
    conversationId: null,
    patientConfirmed: false,
  }
}

const hours = (staffId: string, weekday: number, start = '08:00:00', end = '17:00:00') => ({
  staffId,
  weekday,
  startTime: start,
  endTime: end,
})

function data(partial: Partial<CalendarData>): CalendarData {
  return {
    services: [],
    staff: [staffA, staffB],
    staffServices: [],
    workBlocks: [hours('sa', 2), hours('sb', 2, '09:00:00', '13:00:00')],
    timeOff: [],
    appointments: [],
    ...partial,
  }
}

const base = { dateKey: TUE, staffFilter: null, showCancelled: false }

describe('buildColumns: vista de día', () => {
  it('una columna por profesional activo, con sus citas del día', () => {
    const result = buildColumns({
      ...base,
      view: 'day',
      data: data({
        appointments: [
          appt('1', 'sa', TUE, '09:00', '09:30'),
          appt('2', 'sb', TUE, '10:00', '10:30'),
          appt('3', 'sa', '2026-11-11', '09:00', '09:30'), // otro día
        ],
      }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns.map((c) => c.staffName)).toEqual(['Dra. Ruiz', 'Dr. Mora'])
    expect(result.columns[0].appointments.map((a) => a.id)).toEqual(['1'])
    expect(result.columns[1].appointments.map((a) => a.id)).toEqual(['2'])
  })

  it('el filtro deja solo a ese profesional', () => {
    const result = buildColumns({
      ...base,
      staffFilter: 'sb',
      view: 'day',
      data: data({ appointments: [appt('1', 'sa', TUE, '09:00', '09:30')] }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns.map((c) => c.staffId)).toEqual(['sb'])
    expect(result.columns[0].appointments).toEqual([])
  })

  it('un profesional inactivo solo aparece si tiene citas ese día', () => {
    const withAppt = buildColumns({
      ...base,
      view: 'day',
      data: data({ staff: [staffA, staffOld], appointments: [appt('1', 'so', TUE, '09:00', '09:30')] }),
      now: bogota(TUE, '08:00'),
    })
    expect(withAppt.columns.map((c) => c.staffId)).toEqual(['sa', 'so'])

    const without = buildColumns({
      ...base,
      view: 'day',
      data: data({ staff: [staffA, staffOld] }),
      now: bogota(TUE, '08:00'),
    })
    expect(without.columns.map((c) => c.staffId)).toEqual(['sa'])
  })

  it('las citas sin profesional van a una columna "Sin asignar" al final', () => {
    const result = buildColumns({
      ...base,
      view: 'day',
      data: data({ appointments: [appt('1', null, TUE, '09:00', '09:30')] }),
      now: bogota(TUE, '08:00'),
    })
    const last = result.columns[result.columns.length - 1]
    expect(last.staffId).toBeNull()
    expect(last.appointments.map((a) => a.id)).toEqual(['1'])
  })

  it('las canceladas se ocultan y se cuentan; con el interruptor se ven', () => {
    const appointments = [
      appt('1', 'sa', TUE, '09:00', '09:30'),
      appt('2', 'sa', TUE, '10:00', '10:30', 'cancelled'),
    ]
    const hidden = buildColumns({ ...base, view: 'day', data: data({ appointments }), now: bogota(TUE, '08:00') })
    expect(hidden.columns[0].appointments.map((a) => a.id)).toEqual(['1'])
    expect(hidden.hiddenCancelled).toBe(1)

    const shown = buildColumns({
      ...base,
      showCancelled: true,
      view: 'day',
      data: data({ appointments }),
      now: bogota(TUE, '08:00'),
    })
    expect(shown.columns[0].appointments.map((a) => a.id)).toEqual(['1', '2'])
    expect(shown.hiddenCancelled).toBe(0)
  })

  it('cada columna trae solo el horario de su profesional ese día de la semana', () => {
    const result = buildColumns({ ...base, view: 'day', data: data({}), now: bogota(TUE, '08:00') })
    expect(result.columns[0].workBlocks).toEqual([{ startTime: '08:00:00', endTime: '17:00:00' }])
    expect(result.columns[1].workBlocks).toEqual([{ startTime: '09:00:00', endTime: '13:00:00' }])
  })

  it('sin horarios configurados en toda la cuenta no se sombrea nada', () => {
    const result = buildColumns({ ...base, view: 'day', data: data({ workBlocks: [] }), now: bogota(TUE, '08:00') })
    expect(result.columns.every((c) => c.workBlocks === null)).toBe(true)
    expect(result.range).toEqual({ startHour: 6, endHour: 22 })
  })

  it('un profesional sin horario ese día queda sombreado por completo', () => {
    const result = buildColumns({
      ...base,
      dateKey: SUN,
      view: 'day',
      data: data({}),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns[0].workBlocks).toEqual([])
  })

  it('marca el día de hoy', () => {
    const today = buildColumns({ ...base, view: 'day', data: data({}), now: bogota(TUE, '08:00') })
    expect(today.columns.every((c) => c.isToday)).toBe(true)
    const other = buildColumns({ ...base, view: 'day', data: data({}), now: bogota('2026-11-11', '08:00') })
    expect(other.columns.every((c) => !c.isToday)).toBe(true)
  })

  it('los bloqueos de ese profesional que tocan el día', () => {
    const result = buildColumns({
      ...base,
      view: 'day',
      data: data({
        timeOff: [
          { id: 't1', staffId: 'sa', startsAt: bogota(TUE, '12:00'), endsAt: bogota(TUE, '13:00'), reason: 'Almuerzo' },
          { id: 't2', staffId: 'sb', startsAt: bogota(TUE, '12:00'), endsAt: bogota(TUE, '13:00'), reason: null },
          { id: 't3', staffId: 'sa', startsAt: bogota('2026-11-12', '12:00'), endsAt: bogota('2026-11-12', '13:00'), reason: null },
        ],
      }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns[0].timeOff.map((t) => t.id)).toEqual(['t1'])
    expect(result.columns[1].timeOff.map((t) => t.id)).toEqual(['t2'])
  })

  it('la franja visible se estira para una cita fuera del horario', () => {
    const result = buildColumns({
      ...base,
      view: 'day',
      data: data({ appointments: [appt('1', 'sa', TUE, '19:00', '19:30')] }),
      now: bogota(TUE, '08:00'),
    })
    // Horario 8 a 17 -> 7 a 18; la cita de las 7 p. m. la lleva hasta las 20.
    expect(result.range).toEqual({ startHour: 7, endHour: 20 })
  })
})

describe('buildColumns: vista de semana', () => {
  it('una columna por día, de lunes a sábado si el domingo está vacío', () => {
    const result = buildColumns({
      ...base,
      view: 'week',
      data: data({ appointments: [appt('1', 'sa', TUE, '09:00', '09:30')] }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns.map((c) => c.dateKey)).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
    ])
    expect(result.columns[1].appointments.map((a) => a.id)).toEqual(['1'])
  })

  it('incluye el domingo si hay citas ese día', () => {
    const result = buildColumns({
      ...base,
      view: 'week',
      data: data({ appointments: [appt('1', 'sa', SUN, '09:00', '09:30')] }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns).toHaveLength(7)
    expect(result.columns[6].dateKey).toBe(SUN)
  })

  it('incluye el domingo si alguien trabaja ese día', () => {
    const result = buildColumns({
      ...base,
      view: 'week',
      data: data({ workBlocks: [hours('sa', 0)] }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns).toHaveLength(7)
  })

  it('con "todos", el horario del día es la unión del equipo', () => {
    const result = buildColumns({ ...base, view: 'week', data: data({}), now: bogota(TUE, '08:00') })
    // El martes trabajan A (8 a 17) y B (9 a 13).
    const tuesday = result.columns[1]
    expect(tuesday.workBlocks).toHaveLength(2)
    // El lunes nadie trabaja: todo sombreado.
    expect(result.columns[0].workBlocks).toEqual([])
  })

  it('con un profesional elegido, sus citas, su horario y sus bloqueos', () => {
    const result = buildColumns({
      ...base,
      staffFilter: 'sb',
      view: 'week',
      data: data({
        appointments: [appt('1', 'sa', TUE, '09:00', '09:30'), appt('2', 'sb', TUE, '10:00', '10:30')],
        timeOff: [
          { id: 't', staffId: 'sb', startsAt: bogota(TUE, '12:00'), endsAt: bogota(TUE, '13:00'), reason: null },
        ],
      }),
      now: bogota(TUE, '08:00'),
    })
    const tuesday = result.columns[1]
    expect(tuesday.appointments.map((a) => a.id)).toEqual(['2'])
    expect(tuesday.workBlocks).toEqual([{ startTime: '09:00:00', endTime: '13:00:00' }])
    expect(tuesday.timeOff.map((t) => t.id)).toEqual(['t'])
  })

  it('con "todos" no se dibujan bloqueos sueltos', () => {
    const result = buildColumns({
      ...base,
      view: 'week',
      data: data({
        timeOff: [{ id: 't', staffId: 'sb', startsAt: bogota(TUE, '12:00'), endsAt: bogota(TUE, '13:00'), reason: null }],
      }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns.every((c) => c.timeOff.length === 0)).toBe(true)
  })

  it('las citas de cada día salen en orden de hora', () => {
    const result = buildColumns({
      ...base,
      view: 'week',
      data: data({
        appointments: [appt('late', 'sa', TUE, '15:00', '15:30'), appt('early', 'sb', TUE, '09:00', '09:30')],
      }),
      now: bogota(TUE, '08:00'),
    })
    expect(result.columns[1].appointments.map((a) => a.id)).toEqual(['early', 'late'])
  })
})
