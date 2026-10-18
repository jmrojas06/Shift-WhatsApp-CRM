// ============================================================
// Utilidades HTTP de las rutas de configuración del vertical.
//
// Viven aquí (carpeta privada `_lib`) para que las nueve rutas
// compartan el mismo contrato de errores sin duplicar el mapeo:
//   - badRequest: 400 con mensaje en es-CO de los validadores.
//   - configErrorResponse: ConfigError → 404/409 con `code`.
//   - readJsonBody: cuerpo JSON o null (llamadas rotas).
// ============================================================

import { NextResponse } from 'next/server'

import { CONFIG_ERROR_STATUS, ConfigError } from '@/verticals/barberia/config'

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 })
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

/**
 * Convierte un error de dominio de la configuración en respuesta.
 * Devuelve null si el error no es de configuración: la ruta continúa
 * con `toErrorResponse` (auth → 401/403, resto → 500 genérico).
 */
export function configErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ConfigError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: CONFIG_ERROR_STATUS[err.code] },
    )
  }
  return null
}
