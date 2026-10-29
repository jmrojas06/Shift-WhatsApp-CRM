import { describe, expect, it } from 'vitest'

import { pickLeastLoadedAgent } from './assign'

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
