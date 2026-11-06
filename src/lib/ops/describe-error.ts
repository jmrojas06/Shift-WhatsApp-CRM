// ============================================================
// Un error, en una línea corta y sin datos, para los logs.
//
// Un error de la base (PostgREST) o de una librería puede traer la fila que no
// pudo guardar (`details`, `hint`) o repetir un valor en el mensaje; volcar el
// objeto entero al log deja nombres y teléfonos de pacientes en los registros.
// Aquí solo sale lo que sirve para ubicar el fallo:
//   - un `Error`: su nombre y su mensaje;
//   - un error de PostgREST (objeto con `code` y `message`): el código y el mensaje.
// Se quitan los números largos y se corta el largo.
// ============================================================

/** Cuánto del mensaje cabe en el log: sirve para ubicarlo, no para volcar datos. */
const MAX_LENGTH = 200

/** Quita teléfonos e identificadores (números largos, con o sin separadores). */
function scrubDigits(text: string): string {
  return text.replace(/\+?\d(?:[\s().-]?\d){5,}/g, '#').replace(/\d{4,}/g, '#')
}

const clean = (text: string): string => scrubDigits(text).slice(0, MAX_LENGTH)

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return clean(`${error.name}: ${error.message}`)
  }
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    // El código (p. ej. 23505) es un dato fijo de la base: no se le quitan los números.
    const parts = [
      typeof code === 'string' && code !== '' ? code.slice(0, 20) : null,
      typeof message === 'string' && message !== '' ? clean(message) : null,
    ].filter((part): part is string => part !== null)
    if (parts.length > 0) return parts.join(': ')
  }
  return 'error desconocido'
}
