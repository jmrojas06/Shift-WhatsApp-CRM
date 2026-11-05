import { describe, expect, it } from 'vitest'

import { kickCalendarSync } from './calendar-kick'

describe('kickCalendarSync', () => {
  it('por ahora no hace nada y nunca lanza (T10 lo llena)', async () => {
    await expect(kickCalendarSync('acc-1')).resolves.toBeUndefined()
  })
})
