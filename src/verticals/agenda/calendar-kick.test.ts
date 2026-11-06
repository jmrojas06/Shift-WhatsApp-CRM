import { beforeEach, describe, expect, it, vi } from 'vitest'

const kickNow = vi.fn<(accountId: string) => Promise<void>>()

vi.mock('./calendar-sync', () => ({
  kickCalendarSyncNow: (accountId: string) => kickNow(accountId),
}))

import { kickCalendarSync } from './calendar-kick'

describe('kickCalendarSync', () => {
  beforeEach(() => {
    kickNow.mockReset()
  })

  it('copia en el momento las citas de esa cuenta', async () => {
    kickNow.mockResolvedValue(undefined)
    await kickCalendarSync('acc-1')
    expect(kickNow).toHaveBeenCalledWith('acc-1')
  })

  it('nunca lanza, aunque la copia falle', async () => {
    kickNow.mockRejectedValue(new Error('google caído'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(kickCalendarSync('acc-1')).resolves.toBeUndefined()
  })
})
