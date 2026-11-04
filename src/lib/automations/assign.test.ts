import { describe, expect, it } from 'vitest'

import { assignableMemberIds, pickLeastLoadedAgent } from './assign'

describe('assignableMemberIds', () => {
  const members = [
    { user_id: 'dueno', email: 'dueno@inmobiliaria.co' },
    { user_id: 'shift', email: 'Equipo@Shift.co' },
    { user_id: 'asesora', email: 'asesora@inmobiliaria.co' },
  ]

  it('deja por fuera al equipo de Shift, que entra a cada cuenta como admin', () => {
    expect(assignableMemberIds(members, 'equipo@shift.co, otro@shift.co')).toEqual([
      'dueno',
      'asesora',
    ])
  })

  it('sin lista de Shift reparte entre todos', () => {
    expect(assignableMemberIds(members, undefined)).toEqual(['dueno', 'shift', 'asesora'])
  })

  it('si solo queda Shift, no hay a quién asignar', () => {
    expect(assignableMemberIds([members[1]], 'equipo@shift.co')).toEqual([])
  })
})

describe('pickLeastLoadedAgent', () => {
  it('sin miembros no asigna a nadie', () => {
    expect(pickLeastLoadedAgent([], [])).toBeNull()
  })

  it('le da el chat al que tiene menos conversaciones abiertas', () => {
    expect(pickLeastLoadedAgent(['a', 'b', 'c'], ['a', 'a', 'b', 'c', 'c'])).toBe('b')
  })

  it('reparte uno por uno cuando van empatados', () => {
    const members = ['b', 'a', 'c']
    const open: string[] = []
    const order: string[] = []
    for (let i = 0; i < 6; i++) {
      const next = pickLeastLoadedAgent(members, open)!
      order.push(next)
      open.push(next)
    }
    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })

  it('ignora chats sin asignar o de alguien que ya no está en el equipo', () => {
    expect(pickLeastLoadedAgent(['a', 'b'], [null, 'ex', 'ex', 'b'])).toBe('a')
  })
})
