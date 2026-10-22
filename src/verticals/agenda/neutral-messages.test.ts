import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// ============================================================
// Los mensajes que el servidor devuelve a la pantalla (validación y
// errores de la configuración) no pueden nombrar a la barbería a mano:
// la agenda sirve a cualquier negocio (salón, consultorio, taller…).
// Se revisa el código sin comentarios, solo los textos.
// ============================================================

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SOURCES = [
  'src/verticals/agenda/config.ts',
  'src/verticals/agenda/config-repo.ts',
  'src/app/api/verticals/agenda/reminders/run/route.ts',
  'src/app/api/verticals/agenda/_lib/http.ts',
]

describe('mensajes del servidor de la agenda', () => {
  for (const file of SOURCES) {
    it(`${file} no nombra al barbero ni a la barbería`, () => {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'))
      expect(code).not.toMatch(/barber/i)
    })
  }
})
