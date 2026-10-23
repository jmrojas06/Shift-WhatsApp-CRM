import { describe, expect, it } from 'vitest'

import { groupActivity } from './group-activity'
import type { ActivityItem } from './types'

const msg = (id: string, text: string, href = '/inbox?c=1'): ActivityItem => ({
  id,
  kind: 'message',
  text,
  at: '2026-10-22T10:00:00Z',
  href,
})

describe('groupActivity', () => {
  it('merges consecutive identical events and keeps the newest', () => {
    const groups = groupActivity([
      msg('a', 'Nuevo mensaje de Laura M.'),
      msg('b', 'Nuevo mensaje de Laura M.'),
      msg('c', 'Nuevo mensaje de Laura M.'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ count: 3, item: { id: 'a' } })
  })

  it('does not merge across a different event or conversation', () => {
    const groups = groupActivity([
      msg('a', 'Nuevo mensaje de Laura M.'),
      { ...msg('b', 'Nuevo contacto: Laura M.'), kind: 'contact', href: undefined },
      msg('c', 'Nuevo mensaje de Laura M.'),
      msg('d', 'Nuevo mensaje de Laura M.', '/inbox?c=2'),
    ])
    expect(groups.map((g) => g.count)).toEqual([1, 1, 1, 1])
  })
})
