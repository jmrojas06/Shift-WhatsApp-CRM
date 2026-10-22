import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// ============================================================
// Contrato de RLS del vertical (migración 050, D2) + guard de
// accounts (D3), verificado sobre el TEXTO de las migraciones.
//
// No reemplaza a supabase/ci/verify-schema.sql (que corre contra un
// Postgres real en CI): aquí se "re-aplican" en orden todos los
// DROP POLICY / CREATE POLICY de supabase/migrations y se mira la
// política que QUEDA vigente. Así una migración futura que vuelva a
// bajar la configuración a 'agent' falla en `npm test`, sin base.
// ============================================================

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../supabase/migrations', import.meta.url),
)

interface Policy {
  table: string
  name: string
  cmd: string
  body: string
}

function effectivePolicies(): Map<string, Policy> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const policies = new Map<string, Policy>()
  const statement =
    /(DROP POLICY IF EXISTS\s+("?[\w ]+"?)\s+ON\s+(\w+)\s*;)|(CREATE POLICY\s+("?[\w ]+"?)\s+ON\s+(\w+)\s+FOR\s+(\w+)([\s\S]*?);)/gi
  for (const file of files) {
    // Fuera los comentarios de línea: llevan ';' y nombres de política.
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(
      /--[^\n]*/g,
      '',
    )
    for (const m of sql.matchAll(statement)) {
      if (m[1]) {
        policies.delete(`${m[3]}.${m[2]}`)
      } else {
        policies.set(`${m[6]}.${m[5]}`, {
          table: m[6],
          name: m[5],
          cmd: m[7].toUpperCase(),
          body: m[8],
        })
      }
    }
  }
  return policies
}

function policiesFor(table: string, cmd: string): Policy[] {
  return [...effectivePolicies().values()].filter(
    (p) => p.table === table && p.cmd === cmd,
  )
}

const CONFIG_TABLES = [
  'booking_services',
  'booking_staff',
  'booking_staff_services',
  'booking_working_hours',
  'booking_time_off',
  'booking_settings',
]

describe('RLS de configuración del vertical (050 / D2)', () => {
  for (const table of CONFIG_TABLES) {
    for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
      it(`${table} ${cmd}: solo owner/admin`, () => {
        const found = policiesFor(table, cmd)
        expect(found).toHaveLength(1)
        expect(found[0].body).toContain("'admin'")
        expect(found[0].body).not.toContain("'agent'")
      })
    }

    it(`${table} SELECT: cualquier miembro (viewer incluido)`, () => {
      const found = policiesFor(table, 'SELECT')
      expect(found).toHaveLength(1)
      expect(found[0].body).toMatch(/is_account_member\(account_id\)/)
    })
  }

  it('los agentes no pueden crear bloqueos (time off)', () => {
    const [insert] = policiesFor('booking_time_off', 'INSERT')
    expect(insert.body).toContain("'admin'")
  })

  for (const table of ['booking_appointments', 'booking_sessions']) {
    it(`${table}: la escritura sigue abierta a agent (operación)`, () => {
      for (const cmd of ['INSERT', 'UPDATE']) {
        const [policy] = policiesFor(table, cmd)
        expect(policy.body).toContain("'agent'")
      }
    })
  }

  it('las citas siguen sin política DELETE (se cancelan, no se borran)', () => {
    expect(policiesFor('booking_appointments', 'DELETE')).toHaveLength(0)
  })
})

describe('guard de columnas protegidas de accounts (050 / D3)', () => {
  const sql = readFileSync(
    join(MIGRATIONS_DIR, '050_barberia_config_rls_and_account_guards.sql'),
    'utf8',
  )

  it('el trigger BEFORE UPDATE existe sobre accounts', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER enforce_account_protected_columns\s+BEFORE UPDATE ON public\.accounts/,
    )
  })

  it('bloquea owner_user_id y vertical_key solo para el navegador', () => {
    expect(sql).toContain('NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id')
    expect(sql).toContain('NEW.vertical_key IS DISTINCT FROM OLD.vertical_key')
    expect(sql).toContain("current_user IN ('authenticated', 'anon')")
    expect(sql).toContain("ERRCODE = 'insufficient_privilege'")
  })

  it('no es destructiva: ni DROP TABLE/COLUMN ni DELETE/TRUNCATE', () => {
    const code = sql.replace(/--[^\n]*/g, '')
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/DROP\s+COLUMN/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(code).not.toMatch(/\bTRUNCATE\b/i)
  })

  it('transfer_account_ownership sigue siendo SECURITY DEFINER de postgres (puede mover el dueño)', () => {
    const rpc = readFileSync(
      join(MIGRATIONS_DIR, '018_account_member_rpcs.sql'),
      'utf8',
    )
    expect(rpc).toMatch(/SECURITY DEFINER/)
    expect(rpc).toContain(
      'ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres',
    )
  })
})

describe('preguntas extra del bot (051 / booking_questions)', () => {
  it('SELECT: cualquier miembro (viewer incluido)', () => {
    const found = policiesFor('booking_questions', 'SELECT')
    expect(found).toHaveLength(1)
    expect(found[0].body).toMatch(/is_account_member\(account_id\)/)
  })

  for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
    it(`${cmd}: solo owner/admin`, () => {
      const found = policiesFor('booking_questions', cmd)
      expect(found).toHaveLength(1)
      expect(found[0].body).toContain("'admin'")
      expect(found[0].body).not.toContain("'agent'")
    })
  }

  it('UPDATE: la política tiene WITH CHECK admin (no se puede mover la fila a otra cuenta)', () => {
    const [update] = policiesFor('booking_questions', 'UPDATE')
    expect(update.body).toMatch(
      /WITH CHECK\s*\(\s*is_account_member\(account_id,\s*'admin'\)\s*\)/,
    )
  })

  const code = readFileSync(
    join(MIGRATIONS_DIR, '051_agenda_armable.sql'),
    'utf8',
  ).replace(/--[^\r\n]*/g, '')

  it('la tabla tiene RLS activada', () => {
    expect(code).toMatch(
      /ALTER TABLE booking_questions ENABLE ROW LEVEL SECURITY/,
    )
  })

  it('no es destructiva: ni DROP TABLE/COLUMN ni DELETE/TRUNCATE', () => {
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/DROP\s+COLUMN/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(code).not.toMatch(/\bTRUNCATE\b/i)
  })

  const rewrite = /UPDATE\s+accounts\s+SET\s+vertical_key\s*=\s*'agenda'\s+WHERE\s+vertical_key\s*=\s*'barberia'/i
  const backfillInsert = /INSERT\s+INTO\s+booking_settings[^;]*?WHERE\s+vertical_key\s*=\s*'barberia'/i
  const backfillUpdate = /UPDATE\s+booking_settings[^;]*?a\.vertical_key\s*=\s*'barberia'/i

  it("reescribe la clave del vertical 'barberia' a 'agenda'", () => {
    expect(code).toMatch(rewrite)
  })

  it("el backfill filtra por 'barberia' y corre ANTES del rename (re-correr 051 no pisa cuentas 'agenda')", () => {
    const renameAt = code.search(rewrite)
    const insertAt = code.search(backfillInsert)
    const updateAt = code.search(backfillUpdate)
    expect(insertAt).toBeGreaterThanOrEqual(0)
    expect(updateAt).toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThanOrEqual(0)
    expect(insertAt).toBeLessThan(renameAt)
    expect(updateAt).toBeLessThan(renameAt)
  })
})
