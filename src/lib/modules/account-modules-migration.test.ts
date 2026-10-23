import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// ============================================================
// Contrato de la migración 053 (módulos combinables), verificado sobre
// el TEXTO del SQL — mismo patrón que el test de RLS de la agenda: no
// reemplaza a supabase/ci/verify-schema.sql (Postgres real, en CI),
// pero hace que un cambio que rompa el contrato falle en `npm test`.
// ============================================================

const SUPABASE_DIR = fileURLToPath(new URL('../../../supabase', import.meta.url))

const raw = readFileSync(
  join(SUPABASE_DIR, 'migrations', '053_account_modules.sql'),
  'utf8',
)
/** Sin comentarios de línea (llevan ';' y nombres de objetos). */
const code = raw.replace(/--[^\r\n]*/g, '')

describe('053_account_modules.sql', () => {
  it('lleva lock_timeout al inicio', () => {
    expect(code.trimStart()).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i)
  })

  it("agrega accounts.modules text[] NOT NULL DEFAULT '{}' de forma idempotente", () => {
    expect(code).toMatch(
      /ALTER TABLE accounts ADD COLUMN IF NOT EXISTS modules text\[\] NOT NULL DEFAULT '\{\}'/,
    )
  })

  it('valida la forma de cada clave con un CHECK (misma forma que vertical_key)', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.valid_module_keys(keys text[])')
    expect(code).toContain("'^[a-z0-9_-]{1,40}$'")
    expect(code).toMatch(
      /DROP CONSTRAINT IF EXISTS accounts_modules_check;\s*ALTER TABLE accounts ADD CONSTRAINT accounts_modules_check CHECK \(public\.valid_module_keys\(modules\)\)/,
    )
  })

  it('la función rechaza elementos NULL y no depende del search_path', () => {
    const fn = code.match(
      /CREATE OR REPLACE FUNCTION public\.valid_module_keys[\s\S]*?\$\$;/,
    )?.[0]
    expect(fn).toBeDefined()
    expect(fn).toMatch(/bool_and\(k IS NOT NULL AND k ~ '\^\[a-z0-9_-\]\{1,40\}\$'\)/)
    expect(fn).toMatch(/SET search_path = pg_catalog/)
    expect(fn).toMatch(/IMMUTABLE/)
  })

  it('el backfill pasa agenda/barberia a modules sin duplicar al re-correr', () => {
    expect(code).toMatch(
      /UPDATE accounts SET modules = array_append\(modules, 'agenda'\)\s*WHERE vertical_key IN \('agenda', 'barberia'\) AND NOT \('agenda' = ANY\(modules\)\)/,
    )
  })

  it('amplía el trigger de 050: el navegador tampoco cambia modules', () => {
    expect(code).toContain(
      'CREATE OR REPLACE FUNCTION public.enforce_account_protected_columns()',
    )
    expect(code).toContain('NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id')
    expect(code).toContain('NEW.vertical_key IS DISTINCT FROM OLD.vertical_key')
    expect(code).toContain('NEW.modules IS DISTINCT FROM OLD.modules')
    expect(code).toContain("current_user IN ('authenticated', 'anon')")
    expect(code).toContain("ERRCODE = 'insufficient_privilege'")
    expect(code).toContain(
      'ALTER FUNCTION public.enforce_account_protected_columns() OWNER TO postgres',
    )
  })

  it('no recrea el trigger de 050: ya apunta a la función', () => {
    expect(code).not.toMatch(/CREATE TRIGGER enforce_account_protected_columns/i)
    expect(code.match(/CREATE TRIGGER/gi)).toHaveLength(1)
  })

  describe('sincronía vertical_key → modules', () => {
    const fn = code.match(
      /CREATE OR REPLACE FUNCTION public\.sync_account_modules_from_vertical\(\)[\s\S]*?\$\$;/,
    )?.[0]

    it('la función existe, es SECURITY INVOKER y fija su search_path', () => {
      expect(fn).toBeDefined()
      expect(fn).toMatch(/RETURNS TRIGGER/)
      expect(fn).toMatch(/SECURITY INVOKER/)
      expect(fn).not.toMatch(/SECURITY DEFINER/)
      expect(fn).toMatch(/SET search_path = pg_catalog, public/)
    })

    it('solo llena modules si está vacío y hay vertical_key (barberia → agenda)', () => {
      expect(fn).toMatch(/cardinality\(NEW\.modules\), 0\) = 0/)
      expect(fn).toMatch(/NEW\.vertical_key IS NOT NULL/)
      expect(fn).toMatch(/WHEN NEW\.vertical_key = 'barberia' THEN 'agenda'/)
      expect(fn).toMatch(/NEW\.modules := ARRAY\[/)
      // Una clave con forma inválida no rompe el INSERT: simplemente no se copia.
      expect(fn).toMatch(/public\.valid_module_keys\(ARRAY\[/)
    })

    it('se dispara BEFORE INSERT OR UPDATE OF vertical_key, modules, por fila', () => {
      expect(code).toMatch(
        /DROP TRIGGER IF EXISTS accounts_sync_modules ON public\.accounts;\s*CREATE TRIGGER accounts_sync_modules\s+BEFORE INSERT OR UPDATE OF vertical_key, modules ON public\.accounts\s+FOR EACH ROW EXECUTE FUNCTION public\.sync_account_modules_from_vertical\(\);/,
      )
    })

    it('corre ANTES del guardia de columnas protegidas (orden alfabético de triggers)', () => {
      // Si corriera después, un cliente que mande vertical_key sin cambiarlo
      // podría llenar modules sin que el guardia lo vea.
      expect('accounts_sync_modules' < 'enforce_account_protected_columns').toBe(true)
    })
  })

  it('es aditiva: ni DROP TABLE/COLUMN ni DELETE/TRUNCATE, un solo UPDATE', () => {
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/DROP\s+COLUMN/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(code).not.toMatch(/\bTRUNCATE\b/i)
    // Un solo UPDATE de datos (el backfill); el `UPDATE OF` del trigger no cuenta.
    expect(code.match(/^\s*UPDATE\s+accounts\b/gim)).toHaveLength(1)
  })

  it('no toca vertical_key (sigue vigente para el respaldo del código)', () => {
    expect(code).not.toMatch(/SET\s+vertical_key/i)
    expect(code).not.toMatch(/DROP\s+COLUMN\s+vertical_key/i)
  })
})

describe('verify-schema.sql (053)', () => {
  const sql = readFileSync(join(SUPABASE_DIR, 'ci', 'verify-schema.sql'), 'utf8')

  it('comprueba columna, restricción, función y trigger de 053', () => {
    expect(sql).toContain("column_name = 'modules'")
    expect(sql).toContain("conname = 'accounts_modules_check'")
    expect(sql).toContain("to_regprocedure('public.valid_module_keys(text[])')")
    expect(sql).toContain("pg_get_functiondef('public.enforce_account_protected_columns()'::regprocedure)")
    expect(sql).toContain("NOT LIKE '%NEW.modules IS DISTINCT FROM OLD.modules%'")
  })

  it('comprueba el trigger de sincronía vertical_key → modules y que corre antes del guardia', () => {
    expect(sql).toContain("to_regprocedure('public.sync_account_modules_from_vertical()')")
    expect(sql).toContain("tgname = 'accounts_sync_modules'")
    expect(sql).toContain("'accounts_sync_modules' >= 'enforce_account_protected_columns'")
    expect(sql).toContain('sync_account_modules_from_vertical is SECURITY DEFINER')
  })

  it('comprueba que valid_module_keys rechaza un elemento NULL', () => {
    expect(sql).toContain('public.valid_module_keys(ARRAY[NULL]::text[]) IS DISTINCT FROM false')
  })

  it('sigue siendo UN solo statement (un único bloque DO)', () => {
    const noComments = sql.replace(/--[^\r\n]*/g, '')
    expect(noComments.match(/\bDO\s+\$\$/g)).toHaveLength(1)
    expect(noComments.match(/\bEND\s*\$\$;/g)).toHaveLength(1)
  })
})
