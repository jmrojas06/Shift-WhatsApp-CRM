import { describe, expect, it } from 'vitest'

import {
  buildCallList,
  CALL_LIST_HORIZON_HOURS,
  type BuildCallListArgs,
  type CallListAppointment,
  type CallListCall,
} from './call-list'

// Jueves 5 de noviembre de 2026, 10:00 en Bogotá.
const NOW = new Date('2026-11-05T15:00:00.000Z')
const HOUR = 3_600_000
const MINUTE = 60_000

const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString()

/** Una cita que SÍ entra: activa, dentro de 24 h, recordatorio de hace 5 h, sin confirmar. */
function appt(overrides: Partial<CallListAppointment> = {}): CallListAppointment {
  return {
    id: 'a1',
    startsAt: iso(24 * HOUR),
    status: 'confirmed',
    contactId: 'c1',
    staffId: 's1',
    patientId: null,
    reminderSentAt: iso(-5 * HOUR),
    attendanceConfirmedAt: null,
    ...overrides,
  }
}

function call(overrides: Partial<CallListCall> = {}): CallListCall {
  return {
    appointmentId: 'a1',
    direction: 'outbound',
    channel: 'robot',
    attempt: 1,
    status: 'completed',
    outcome: null,
    createdAt: iso(-2 * HOUR),
    ...overrides,
  }
}

function build(overrides: Partial<BuildCallListArgs> = {}) {
  return buildCallList({
    now: NOW,
    callAfterMinutes: 180,
    appointments: [appt()],
    calls: [],
    contacts: [{ id: 'c1', name: 'Ana Pérez', phone: '573001112233' }],
    staff: [{ id: 's1', name: 'Dra. Rojas' }],
    patients: [],
    noCallContactIds: new Set<string>(),
    ...overrides,
  })
}

describe('quién entra a la lista', () => {
  it('una cita activa, sin confirmar y con el recordatorio de hace más de call_after_minutes', () => {
    const [row, ...rest] = build()
    expect(rest).toHaveLength(0)
    expect(row).toMatchObject({
      appointmentId: 'a1',
      contactId: 'c1',
      contactName: 'Ana Pérez',
      phone: '573001112233',
      staffName: 'Dra. Rojas',
      reason: 'reminder_unanswered',
      robotAttempts: 0,
      manualAttempts: 0,
      lastRobot: null,
      lastManual: null,
      robotInProgress: false,
      canRobotCall: true,
    })
  })

  it('una cita pendiente también entra', () => {
    expect(build({ appointments: [appt({ status: 'pending' })] })).toHaveLength(1)
  })

  it('el recordatorio justo en el límite de call_after_minutes entra (igual que el runner)', () => {
    const exact = appt({ reminderSentAt: iso(-180 * MINUTE) })
    expect(build({ appointments: [exact] })).toHaveLength(1)
  })

  it('con el recordatorio de hace menos de call_after_minutes todavía no', () => {
    const recent = appt({ reminderSentAt: iso(-179 * MINUTE) })
    expect(build({ appointments: [recent] })).toHaveLength(0)
  })

  it('sin recordatorio enviado no entra (no se le ha avisado nada)', () => {
    expect(build({ appointments: [appt({ reminderSentAt: null })] })).toHaveLength(0)
  })

  it('cambiar call_after_minutes cambia quién entra', () => {
    const a = appt({ reminderSentAt: iso(-60 * MINUTE) })
    expect(build({ appointments: [a], callAfterMinutes: 180 })).toHaveLength(0)
    expect(build({ appointments: [a], callAfterMinutes: 30 })).toHaveLength(1)
  })

  it.each(['completed', 'no_show', 'cancelled'])('una cita %s no entra', (status) => {
    expect(build({ appointments: [appt({ status })] })).toHaveLength(0)
  })

  it('una cita que ya empezó no entra (eso es de "Sin marcar")', () => {
    expect(build({ appointments: [appt({ startsAt: iso(-1 * MINUTE) })] })).toHaveLength(0)
    expect(build({ appointments: [appt({ startsAt: iso(0) })] })).toHaveLength(0)
  })

  it('solo las próximas 48 horas', () => {
    expect(CALL_LIST_HORIZON_HOURS).toBe(48)
    expect(build({ appointments: [appt({ startsAt: iso(48 * HOUR) })] })).toHaveLength(1)
    expect(build({ appointments: [appt({ startsAt: iso(48 * HOUR + MINUTE) })] })).toHaveLength(0)
  })

  it('una cita que el paciente ya confirmó no entra, ni siquiera si el robot la dejó con alguien', () => {
    const confirmed = appt({ attendanceConfirmedAt: iso(-HOUR) })
    expect(build({ appointments: [confirmed] })).toHaveLength(0)
    expect(build({ appointments: [confirmed], calls: [call({ outcome: 'human' })] })).toHaveLength(0)
  })

  it('un contacto con la etiqueta no-llamar no entra', () => {
    expect(build({ noCallContactIds: new Set(['c1']) })).toHaveLength(0)
    // Otro contacto con la etiqueta no afecta a este.
    expect(build({ noCallContactIds: new Set(['c9']) })).toHaveLength(1)
  })

  it('si el contacto no se pudo leer, la cita igual aparece (sin nombre ni teléfono)', () => {
    const [row] = build({ contacts: [] })
    expect(row).toMatchObject({ contactName: null, phone: null })
  })
})

describe('lo que el robot dejó para una persona', () => {
  // Estas citas NO cumplen la regla del recordatorio (nunca salió o es muy reciente).
  const noReminder = appt({ reminderSentAt: null })

  it.each([
    ['human', 'completed', 'robot_human'],
    ['advisor_missed', 'completed', 'robot_advisor_missed'],
    ['no_response', 'no_answer', 'robot_no_response'],
    ['no_response', 'completed', 'robot_no_response'],
  ] as const)('el último resultado del robot %s (%s) entra como %s', (outcome, status, reason) => {
    const [row] = build({ appointments: [noReminder], calls: [call({ outcome, status })] })
    expect(row.reason).toBe(reason)
    expect(row.lastRobot).toMatchObject({ outcome, status })
  })

  it('una llamada que Telnyx rechazó (failed) deja la cita en la lista', () => {
    const [row] = build({
      appointments: [noReminder],
      calls: [call({ status: 'failed', outcome: null })],
    })
    expect(row.reason).toBe('robot_failed')
  })

  it('terminó sin resultado (no contestó, ocupado) cuenta como no_response', () => {
    for (const status of ['no_answer', 'busy', 'canceled', 'completed'] as const) {
      const [row] = build({ appointments: [noReminder], calls: [call({ status, outcome: null })] })
      expect(row.reason).toBe('robot_no_response')
    }
  })

  it('advisor_connected, wrong_number y confirmed del robot no entran por sí solos', () => {
    for (const outcome of ['advisor_connected', 'wrong_number', 'confirmed', 'cancelled'] as const) {
      expect(build({ appointments: [noReminder], calls: [call({ outcome })] })).toHaveLength(0)
    }
  })

  it('una llamada en curso no es un resultado: sin recordatorio no entra', () => {
    for (const status of ['queued', 'calling', 'in_progress'] as const) {
      expect(build({ appointments: [noReminder], calls: [call({ status, createdAt: iso(-MINUTE) })] })).toHaveLength(0)
    }
  })

  it('una llamada "en curso" de hace más de 15 minutos se da por perdida: no_response', () => {
    const [row] = build({
      appointments: [noReminder],
      calls: [call({ status: 'calling', outcome: null, createdAt: iso(-20 * MINUTE) })],
    })
    expect(row.reason).toBe('robot_no_response')
    expect(row.robotInProgress).toBe(false)
  })

  it('manda el último intento del robot, no el primero', () => {
    const calls = [
      call({ attempt: 1, outcome: 'human', createdAt: iso(-6 * HOUR) }),
      call({ attempt: 2, status: 'no_answer', outcome: 'no_response', createdAt: iso(-3 * HOUR) }),
    ]
    const [row] = build({ appointments: [noReminder], calls })
    expect(row.reason).toBe('robot_no_response')
    expect(row.lastRobot).toMatchObject({ outcome: 'no_response' })
  })

  it('el resultado del robot gana sobre el recordatorio como motivo', () => {
    const [row] = build({ calls: [call({ outcome: 'human' })] })
    expect(row.reason).toBe('robot_human')
  })

  it('si el último intento del robot no deja nada para la persona, vuelve el motivo del recordatorio', () => {
    const calls = [
      call({ attempt: 1, outcome: 'human', createdAt: iso(-6 * HOUR) }),
      call({ attempt: 2, outcome: 'advisor_connected', createdAt: iso(-3 * HOUR) }),
    ]
    const [row] = build({ calls })
    expect(row.reason).toBe('reminder_unanswered')
  })

  it('las llamadas de otra cita no cuentan', () => {
    const calls = [call({ appointmentId: 'otra', outcome: 'human' })]
    expect(build({ appointments: [noReminder], calls })).toHaveLength(0)
  })

  it('las llamadas entrantes no cuentan', () => {
    const calls = [call({ direction: 'inbound', outcome: 'human' })]
    expect(build({ appointments: [noReminder], calls })).toHaveLength(0)
  })
})

describe('intentos y último resultado', () => {
  it('cuenta los intentos del robot (también el que Telnyx rechazó) y los manuales por separado', () => {
    const calls = [
      call({ attempt: 1, outcome: 'no_response', status: 'no_answer', createdAt: iso(-8 * HOUR) }),
      call({ attempt: 2, status: 'failed', createdAt: iso(-6 * HOUR) }),
      call({ channel: 'manual', attempt: 1, outcome: 'no_response', status: 'no_answer', createdAt: iso(-4 * HOUR) }),
      call({ channel: 'manual', attempt: 2, outcome: 'wrong_number', status: 'completed', createdAt: iso(-HOUR) }),
    ]
    const [row] = build({ calls })
    expect(row.robotAttempts).toBe(2)
    expect(row.manualAttempts).toBe(2)
    expect(row.lastManual).toMatchObject({ outcome: 'wrong_number' })
    expect(row.lastManual?.at).toBe(iso(-HOUR))
  })

  it('una llamada manual no cambia el motivo ni el último del robot', () => {
    const calls = [call({ channel: 'manual', outcome: 'no_response', status: 'no_answer' })]
    const [row] = build({ calls })
    expect(row.reason).toBe('reminder_unanswered')
    expect(row.lastRobot).toBeNull()
  })

  it('se puede pedir otra llamada al robot mientras queden intentos (tope 3 de la base)', () => {
    const two = [call({ attempt: 1 }), call({ attempt: 2, createdAt: iso(-HOUR) })]
    expect(build({ calls: two })[0].canRobotCall).toBe(true)
    const three = [...two, call({ attempt: 3, createdAt: iso(-MINUTE * 30) })]
    expect(build({ calls: three })[0].canRobotCall).toBe(false)
  })

  it('un intento rechazado también gasta el número de intento', () => {
    const calls = [call({ attempt: 3, status: 'failed' })]
    expect(build({ calls })[0].canRobotCall).toBe(false)
  })

  it('con una llamada del robot sonando ahora: en curso y no se pide otra', () => {
    const calls = [call({ status: 'calling', outcome: null, createdAt: iso(-2 * MINUTE) })]
    const [row] = build({ calls })
    expect(row.robotInProgress).toBe(true)
    expect(row.canRobotCall).toBe(false)
    // Y sigue en la lista por el recordatorio.
    expect(row.reason).toBe('reminder_unanswered')
  })
})

describe('nombres', () => {
  it('en una clínica trae el paciente y el contacto por separado', () => {
    const [row] = build({
      appointments: [appt({ patientId: 'p1' })],
      patients: [{ id: 'p1', fullName: 'Julián Pardo' }],
      contacts: [{ id: 'c1', name: 'Natalia Pardo', phone: '573104448899' }],
    })
    expect(row).toMatchObject({ patientName: 'Julián Pardo', contactName: 'Natalia Pardo' })
  })

  it('sin paciente (otros negocios) el nombre del paciente es null', () => {
    expect(build()[0].patientName).toBeNull()
  })

  it('un paciente que ya no existe no rompe nada', () => {
    const [row] = build({ appointments: [appt({ patientId: 'borrado' })] })
    expect(row.patientName).toBeNull()
  })

  it('el profesional que ya no existe queda null', () => {
    expect(build({ staff: [] })[0].staffName).toBeNull()
    expect(build({ appointments: [appt({ staffId: null })] })[0].staffName).toBeNull()
  })

  it('los espacios sobrantes de los nombres se limpian y un nombre vacío es null', () => {
    const [row] = build({ contacts: [{ id: 'c1', name: '   ', phone: ' 573001112233 ' }] })
    expect(row.contactName).toBeNull()
    expect(row.phone).toBe('573001112233')
  })
})

describe('orden', () => {
  it('por hora de la cita, la más cercana primero', () => {
    const rows = build({
      appointments: [
        appt({ id: 'tarde', startsAt: iso(30 * HOUR) }),
        appt({ id: 'temprano', startsAt: iso(5 * HOUR) }),
        appt({ id: 'medio', startsAt: iso(20 * HOUR) }),
      ],
    })
    expect(rows.map((r) => r.appointmentId)).toEqual(['temprano', 'medio', 'tarde'])
  })

  it('a la misma hora, un orden estable por id', () => {
    const rows = build({
      appointments: [appt({ id: 'b' }), appt({ id: 'a' })],
    })
    expect(rows.map((r) => r.appointmentId)).toEqual(['a', 'b'])
  })

  it('no cambia la lista de entrada', () => {
    const appointments = [appt({ id: 'z', startsAt: iso(30 * HOUR) }), appt({ id: 'y', startsAt: iso(5 * HOUR) })]
    const copy = structuredClone(appointments)
    build({ appointments })
    expect(appointments).toEqual(copy)
  })
})
