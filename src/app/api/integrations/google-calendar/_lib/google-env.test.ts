import { describe, expect, it } from 'vitest'

import {
  CALLBACK_PATH,
  RETURN_REASONS,
  newState,
  readGoogleEnv,
  returnUrl,
  statesMatch,
} from './google-env'

const FULL_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  NEXT_PUBLIC_SITE_URL: 'https://crm.example.com',
}

describe('readGoogleEnv', () => {
  it('arma la URL de retorno con la dirección de la app', () => {
    expect(readGoogleEnv(FULL_ENV)).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      appUrl: 'https://crm.example.com',
      redirectUri: `https://crm.example.com${CALLBACK_PATH}`,
    })
  })

  it('quita las barras finales y los espacios de la dirección', () => {
    const env = readGoogleEnv({ ...FULL_ENV, NEXT_PUBLIC_SITE_URL: '  https://crm.example.com//  ' })
    expect(env?.appUrl).toBe('https://crm.example.com')
    expect(env?.redirectUri).toBe(`https://crm.example.com${CALLBACK_PATH}`)
  })

  // NEXT_PUBLIC_SITE_URL es la variable que ya usa el resto de la app
  // (.env.local.example, compose, docs de despliegue); NEXT_PUBLIC_APP_URL es el respaldo.
  it('NEXT_PUBLIC_SITE_URL manda sobre NEXT_PUBLIC_APP_URL', () => {
    const env = readGoogleEnv({ ...FULL_ENV, NEXT_PUBLIC_APP_URL: 'https://otra.example.com' })
    expect(env?.appUrl).toBe('https://crm.example.com')
  })

  it.each([undefined, '', '   '])(
    'sin NEXT_PUBLIC_SITE_URL (%j) usa NEXT_PUBLIC_APP_URL',
    (site) => {
      const env = readGoogleEnv({
        ...FULL_ENV,
        NEXT_PUBLIC_SITE_URL: site,
        NEXT_PUBLIC_APP_URL: 'https://respaldo.example.com/',
      })
      expect(env?.appUrl).toBe('https://respaldo.example.com')
      expect(env?.redirectUri).toBe(`https://respaldo.example.com${CALLBACK_PATH}`)
    },
  )

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_SITE_URL'] as const)(
    'devuelve null si falta %s (y no hay NEXT_PUBLIC_APP_URL)',
    (name) => {
      expect(readGoogleEnv({ ...FULL_ENV, [name]: undefined })).toBeNull()
      expect(readGoogleEnv({ ...FULL_ENV, [name]: '   ' })).toBeNull()
    },
  )
})

describe('newState y statesMatch', () => {
  it('genera 32 bytes aleatorios en base64url y distintos cada vez', () => {
    const a = newState()
    const b = newState()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('acepta solo el mismo valor', () => {
    const state = newState()
    expect(statesMatch(state, state)).toBe(true)
    expect(statesMatch(state, newState())).toBe(false)
  })

  it('rechaza lo vacío, lo ausente y lo de otro largo', () => {
    const state = newState()
    expect(statesMatch(undefined, state)).toBe(false)
    expect(statesMatch(state, null)).toBe(false)
    expect(statesMatch('', '')).toBe(false)
    expect(statesMatch(state, state.slice(0, -1))).toBe(false)
    expect(statesMatch(state, `${state}x`)).toBe(false)
  })
})

describe('returnUrl', () => {
  it('vuelve a la configuración con el resultado', () => {
    expect(returnUrl('https://crm.example.com', 'ok')).toBe(
      'https://crm.example.com/agenda/configuracion?google=ok',
    )
  })

  it('el error lleva su motivo corto', () => {
    expect(returnUrl('https://crm.example.com', 'no_refresh_token')).toBe(
      'https://crm.example.com/agenda/configuracion?google=error&reason=no_refresh_token',
    )
  })

  it('todos los motivos son códigos cortos sin espacios', () => {
    for (const reason of RETURN_REASONS) expect(reason).toMatch(/^[a-z_]{1,20}$/)
  })
})
