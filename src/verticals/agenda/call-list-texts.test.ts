import { describe, expect, it } from 'vitest'

import {
  CALL_LIST_TEXTS as T,
  describeManualResult,
  describeRobotResult,
  formatAgo,
  formatPhoneDisplay,
  relativeDayLabel,
  telHref,
} from './call-list-texts'

const NOW = new Date('2026-11-05T15:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const HOUR = 3_600_000

describe('formatAgo', () => {
  it.each([
    [0, 'ahora mismo'],
    [30_000, 'ahora mismo'],
    [MIN, 'hace 1 min'],
    [59 * MIN, 'hace 59 min'],
    [HOUR, 'hace 1 h'],
    [5 * HOUR + 40 * MIN, 'hace 5 h'],
    [24 * HOUR, 'hace 1 día'],
    [3 * 24 * HOUR, 'hace 3 días'],
  ])('hace %i ms → %s', (ms, text) => {
    expect(formatAgo(ago(ms), NOW)).toBe(text)
  })

  it('una hora en el futuro (reloj distinto) dice "ahora mismo"', () => {
    expect(formatAgo(ago(-5 * MIN), NOW)).toBe('ahora mismo')
  })

  it('una fecha rota devuelve texto vacío', () => {
    expect(formatAgo('no es fecha', NOW)).toBe('')
  })
})

describe('relativeDayLabel', () => {
  // NOW = jueves 5 de noviembre de 2026, 10:00 en Bogotá.
  it.each([
    ['2026-11-05T15:00:00.000Z', 'Hoy'],
    ['2026-11-06T03:00:00.000Z', 'Hoy'], // 10 p. m. del jueves en Bogotá, ya viernes en UTC
    ['2026-11-06T15:00:00.000Z', 'Mañana'],
    ['2026-11-07T15:00:00.000Z', 'sáb 7 nov'],
  ])('%s → %s', (iso, label) => {
    expect(relativeDayLabel(new Date(iso), NOW)).toBe(label)
  })
})

describe('formatPhoneDisplay y telHref', () => {
  it('un celular de Colombia se agrupa en 3-3-4', () => {
    expect(formatPhoneDisplay('573001112233')).toBe('+57 300 111 2233')
    expect(formatPhoneDisplay('+573001112233')).toBe('+57 300 111 2233')
  })

  it('otro país queda con el + y los dígitos', () => {
    expect(formatPhoneDisplay('14155550123')).toBe('+14155550123')
  })

  it('tel: lleva el + y solo dígitos', () => {
    expect(telHref('573001112233')).toBe('tel:+573001112233')
    expect(telHref('+57 300 111 2233')).toBe('tel:+573001112233')
  })

  it('un número sin dígitos no tiene enlace', () => {
    expect(telHref('')).toBeNull()
    expect(telHref('abc')).toBeNull()
  })
})

describe('describeRobotResult', () => {
  const last = (outcome: string | null, status: string) => ({ outcome, status, at: ago(HOUR) }) as never

  it.each([
    [{ outcome: 'human', status: 'completed' }, T.result.human],
    [{ outcome: 'advisor_missed', status: 'completed' }, T.result.advisorMissed],
    [{ outcome: 'advisor_connected', status: 'completed' }, T.result.advisorConnected],
    [{ outcome: 'wrong_number', status: 'completed' }, T.result.wrongNumber],
    [{ outcome: 'no_response', status: 'no_answer' }, T.result.noAnswer],
    [{ outcome: 'no_response', status: 'busy' }, T.result.busy],
    [{ outcome: 'no_response', status: 'completed' }, T.result.noKey],
    [{ outcome: null, status: 'no_answer' }, T.result.noAnswer],
    [{ outcome: null, status: 'failed' }, T.result.failed],
    [{ outcome: null, status: 'calling' }, T.result.calling],
  ])('%j', ({ outcome, status }, text) => {
    expect(describeRobotResult(last(outcome, status))).toBe(text)
  })

  it('un fallo gana sobre el resultado guardado', () => {
    expect(describeRobotResult(last('no_response', 'failed'))).toBe(T.result.failed)
  })
})

describe('describeManualResult', () => {
  it.each([
    ['no_response', T.result.noAnswer],
    ['wrong_number', T.result.wrongNumber],
  ])('%s', (outcome, text) => {
    expect(describeManualResult({ outcome, status: 'completed', at: ago(HOUR) } as never)).toBe(text)
  })
})

describe('textos', () => {
  it('no usan rayas largas', () => {
    const all = JSON.stringify(T, (_key, value) => (typeof value === 'function' ? undefined : value))
    expect(all).not.toMatch(/[–—]/)
  })
})
