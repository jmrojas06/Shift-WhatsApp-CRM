import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// ============================================================
// Contrato de la migración 054 (Ventas A), verificado sobre el TEXTO
// del SQL — mismo patrón que el test de 053 y el de RLS de la agenda:
// no reemplaza a supabase/ci/verify-schema.sql (Postgres real, en CI),
// pero hace que un cambio que rompa el contrato falle en `npm test`.
// ============================================================

const SUPABASE_DIR = fileURLToPath(new URL('../../../supabase', import.meta.url))
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations')

const raw = readFileSync(join(MIGRATIONS_DIR, '054_ventas.sql'), 'utf8')
/** Sin comentarios de línea (llevan ';' y nombres de objetos). */
const code = raw.replace(/--[^\r\n]*/g, '')

interface Policy {
  table: string
  name: string
  cmd: string
  body: string
}

/** Re-aplica en orden todos los DROP/CREATE POLICY y deja las vigentes. */
function effectivePolicies(): Policy[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const policies = new Map<string, Policy>()
  const statement =
    /(DROP POLICY IF EXISTS\s+("?[\w ]+"?)\s+ON\s+(\w+)\s*;)|(CREATE POLICY\s+("?[\w ]+"?)\s+ON\s+(\w+)\s+FOR\s+(\w+)([\s\S]*?);)/gi
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '')
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
  return [...policies.values()]
}

const policiesFor = (table: string, cmd: string) =>
  effectivePolicies().filter((p) => p.table === table && p.cmd === cmd)

describe('054_ventas.sql — estructura', () => {
  it('lleva lock_timeout al inicio', () => {
    expect(code.trimStart()).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i)
  })

  it('crea las tres tablas de forma idempotente', () => {
    for (const t of ['orders', 'order_items', 'sales_settings']) {
      expect(code).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`)
    }
  })

  it('orders: consecutivo único por cuenta desde 1001 y total = subtotal + envío', () => {
    expect(code).toContain('number integer NOT NULL CHECK (number >= 1001)')
    expect(code).toContain('UNIQUE (account_id, number)')
    expect(code).toContain('CHECK (total = subtotal + shipping)')
  })

  it('orders: estados y moneda con CHECK; el contacto no se borra con pedidos', () => {
    expect(code).toContain("CHECK (payment_status IN ('pending','paid'))")
    expect(code).toContain("CHECK (status IN ('new','shipped','delivered','cancelled'))")
    expect(code).toContain("CHECK (currency ~ '^[A-Z]{3}$')")
    expect(code).toContain('contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT')
  })

  it('order_items: nombre 1–120, cantidad 1–9999, precio >= 0', () => {
    expect(code).toContain('CHECK (char_length(name) BETWEEN 1 AND 120)')
    expect(code).toContain('CHECK (quantity BETWEEN 1 AND 9999)')
    expect(code).toContain('unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0)')
  })

  it('crea los índices previstos', () => {
    expect(code).toContain('idx_orders_account_created ON orders (account_id, created_at DESC)')
    expect(code).toContain('idx_orders_account_contact ON orders (account_id, contact_id)')
    expect(code).toContain('idx_order_items_order ON order_items (order_id, position)')
  })

  it('updated_at lo mantiene el trigger común en orders y sales_settings', () => {
    for (const t of ['orders', 'sales_settings']) {
      expect(code).toContain(`DROP TRIGGER IF EXISTS set_updated_at ON ${t};`)
      expect(code).toMatch(
        new RegExp(
          `CREATE TRIGGER set_updated_at BEFORE UPDATE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION update_updated_at_column\\(\\)`,
        ),
      )
    }
  })

  it('es aditiva: ni DROP TABLE/COLUMN ni DELETE/TRUNCATE', () => {
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/DROP\s+COLUMN/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(code).not.toMatch(/\bTRUNCATE\b/i)
  })
})

describe('054_ventas.sql — RLS', () => {
  for (const table of ['orders', 'order_items', 'sales_settings']) {
    it(`${table}: RLS activada`, () => {
      expect(code).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    })

    it(`${table} SELECT: cualquier miembro (viewer incluido)`, () => {
      const found = policiesFor(table, 'SELECT')
      expect(found).toHaveLength(1)
      expect(found[0].body).toMatch(/is_account_member\(account_id\)/)
    })
  }

  for (const table of ['orders', 'order_items']) {
    for (const cmd of ['INSERT', 'UPDATE']) {
      it(`${table} ${cmd}: agent o más`, () => {
        const found = policiesFor(table, cmd)
        expect(found).toHaveLength(1)
        expect(found[0].body).toMatch(/is_account_member\(account_id,\s*'agent'\)/)
        expect(found[0].body).not.toContain("'admin'")
      })
    }

    it(`${table} UPDATE: WITH CHECK agent (no se mueve la fila a otra cuenta)`, () => {
      const [update] = policiesFor(table, 'UPDATE')
      expect(update.body).toMatch(/WITH CHECK\s*\(\s*is_account_member\(account_id,\s*'agent'\)\s*\)/)
    })

    it(`${table}: sin política DELETE (se cancela, no se borra)`, () => {
      expect(policiesFor(table, 'DELETE')).toHaveLength(0)
      expect(code).not.toMatch(new RegExp(`ON ${table}\\s+FOR DELETE`, 'i'))
      expect(code).not.toMatch(new RegExp(`ON ${table}\\s+FOR ALL`, 'i'))
    })
  }

  it('orders INSERT: contacto y conversación deben ser de la misma cuenta', () => {
    const [insert] = policiesFor('orders', 'INSERT')
    expect(insert.body).toMatch(/FROM contacts c\s+WHERE c\.id = orders\.contact_id AND c\.account_id = orders\.account_id/)
    expect(insert.body).toMatch(/FROM conversations v\s+WHERE v\.id = orders\.conversation_id/)
  })

  for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
    it(`sales_settings ${cmd}: solo owner/admin`, () => {
      const found = policiesFor('sales_settings', cmd)
      expect(found).toHaveLength(1)
      expect(found[0].body).toContain("'admin'")
      expect(found[0].body).not.toContain("'agent'")
    })
  }

  it('sales_settings UPDATE: WITH CHECK admin', () => {
    const [update] = policiesFor('sales_settings', 'UPDATE')
    expect(update.body).toMatch(/WITH CHECK\s*\(\s*is_account_member\(account_id,\s*'admin'\)\s*\)/)
  })

  it('las políticas se crean con DROP IF EXISTS antes (idempotente)', () => {
    const creates = code.match(/CREATE POLICY\s+(\w+)\s+ON\s+(\w+)/g) ?? []
    expect(creates.length).toBeGreaterThanOrEqual(10)
    for (const c of creates) {
      const [, name, table] = c.match(/CREATE POLICY\s+(\w+)\s+ON\s+(\w+)/)!
      expect(code).toContain(`DROP POLICY IF EXISTS ${name} ON ${table};`)
    }
  })
})

describe('054_ventas.sql — columnas congeladas para el navegador', () => {
  it('orders: el cliente solo cambia estado, no importes ni dueño', () => {
    expect(code).toContain('CREATE OR REPLACE FUNCTION public.orders_freeze_columns()')
    const fn = code.match(/FUNCTION public\.orders_freeze_columns\(\)[\s\S]*?\$\$;/)?.[0] ?? ''
    for (const col of ['account_id', 'number', 'contact_id', 'conversation_id', 'subtotal', 'shipping', 'total', 'currency', 'created_by']) {
      expect(fn).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`)
    }
    expect(fn).toContain("current_user IN ('authenticated', 'anon')")
    expect(fn).toContain("ERRCODE = 'insufficient_privilege'")
    expect(code).toMatch(/CREATE TRIGGER orders_freeze_columns\s+BEFORE UPDATE ON orders/)
  })

  it('order_items: inmutables para el navegador', () => {
    const fn = code.match(/FUNCTION public\.order_items_freeze\(\)[\s\S]*?\$\$;/)?.[0] ?? ''
    expect(fn).toContain("current_user IN ('authenticated', 'anon')")
    expect(fn).toContain("ERRCODE = 'insufficient_privilege'")
    expect(code).toMatch(/CREATE TRIGGER order_items_freeze\s+BEFORE UPDATE ON order_items/)
  })
})

describe('054_ventas.sql — create_order()', () => {
  const fn =
    code.match(/CREATE OR REPLACE FUNCTION public\.create_order\([\s\S]*?\n\$\$;/)?.[0] ?? ''
  const signature = 'public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb)'

  it('existe, es SECURITY INVOKER y fija el search_path', () => {
    expect(fn).not.toBe('')
    expect(fn).toMatch(/SECURITY INVOKER/)
    expect(fn).not.toMatch(/SECURITY DEFINER/)
    expect(fn).toMatch(/SET search_path = public/)
    expect(fn).toMatch(/RETURNS orders/)
  })

  it('no confía en el llamador: contacto y conversación deben ser de la cuenta', () => {
    expect(fn).toMatch(/FROM contacts\s+WHERE id = p_contact_id AND account_id = p_account_id/)
    expect(fn).toMatch(/FROM conversations\s+WHERE id = p_conversation_id AND account_id = p_account_id AND contact_id = p_contact_id/)
    expect(fn).toContain("ERRCODE = '23503'")
  })

  it('valida las líneas: arreglo de 1 a 50 con name/quantity/unit_price', () => {
    expect(fn).toContain("jsonb_typeof(p_items) IS DISTINCT FROM 'array'")
    expect(fn).toMatch(/v_count < 1 OR v_count > 50/)
    expect(fn).toContain("jsonb_typeof(v_item->'name') IS DISTINCT FROM 'string'")
    expect(fn).toContain("jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number'")
    expect(fn).toContain("jsonb_typeof(v_item->'unit_price') IS DISTINCT FROM 'number'")
    expect(fn).toContain("ERRCODE = '22023'")
  })

  it('exige cantidad entera y precios con máximo 2 decimales (subtotal = suma de líneas)', () => {
    expect(fn).toMatch(/trunc\(\(v_item->>'quantity'\)::numeric\)/)
    expect(fn).toMatch(/round\(\(v_item->>'unit_price'\)::numeric, 2\)/)
    expect(fn).toMatch(/round\(v_shipping, 2\)/)
  })

  it("convierte la cantidad vía numeric (un 2.0 de JSON no rompe el ::int)", () => {
    expect(fn).not.toMatch(/\(i->>'quantity'\)::int/)
    expect(fn).toContain("((i->>'quantity')::numeric)::int")
  })

  it('numera dentro de un lock por cuenta en la misma transacción', () => {
    const lock = fn.indexOf('pg_advisory_xact_lock(hashtextextended(')
    const max = fn.indexOf('max(number)')
    expect(lock).toBeGreaterThan(-1)
    expect(max).toBeGreaterThan(lock)
    expect(fn).toContain("'orders:' || p_account_id::text")
  })

  it('solo anon/público pierden el permiso; authenticated y service_role lo tienen', () => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon;`)
    expect(code).toContain(
      `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated, service_role;`,
    )
  })
})

describe('verify-schema.sql (054)', () => {
  const sql = readFileSync(join(SUPABASE_DIR, 'ci', 'verify-schema.sql'), 'utf8')

  it('comprueba tablas, RLS, sin DELETE, UNIQUE, total y función con grants', () => {
    expect(sql).toContain("to_regclass('public.orders')")
    expect(sql).toContain("to_regclass('public.order_items')")
    expect(sql).toContain("to_regclass('public.sales_settings')")
    expect(sql).toContain("pg_get_constraintdef(oid) = 'UNIQUE (account_id, number)'")
    expect(sql).toContain('subtotal + shipping')
    expect(sql).toContain("to_regprocedure('public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb)')")
    expect(sql).toContain("has_function_privilege('anon'")
    expect(sql).toContain("has_function_privilege('authenticated'")
    expect(sql).toContain("has_function_privilege('service_role'")
    expect(sql).toContain("cmd IN ('DELETE', 'ALL')")
  })

  it('sigue siendo UN solo statement (un único bloque DO)', () => {
    const noComments = sql.replace(/--[^\r\n]*/g, '')
    expect(noComments.match(/\bDO\s+\$\$/g)).toHaveLength(1)
    expect(noComments.match(/\bEND\s*\$\$;/g)).toHaveLength(1)
  })
})
