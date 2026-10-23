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

  it('orders: estados y moneda con CHECK', () => {
    expect(code).toContain("CHECK (payment_status IN ('pending','paid'))")
    expect(code).toContain("CHECK (status IN ('new','shipped','delivered','cancelled'))")
    expect(code).toContain("CHECK (currency ~ '^[A-Z]{3}$')")
  })

  it('orders: el contacto se puede borrar (SET NULL) y el pedido guarda nombre y teléfono', () => {
    expect(code).toContain('contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL')
    expect(code).not.toContain('contact_id uuid NOT NULL')
    expect(code).not.toContain('ON DELETE RESTRICT')
    expect(code).toMatch(/customer_name text NOT NULL CHECK \(char_length\(customer_name\) BETWEEN 1 AND 120\)/)
    expect(code).toMatch(/customer_phone text NOT NULL CHECK \(char_length\(customer_phone\) BETWEEN 1 AND 30\)/)
  })

  it("importes y precios rechazan NaN (NaN >= 0 es verdadero en Postgres)", () => {
    for (const col of ['subtotal', 'shipping', 'total', 'unit_price']) {
      expect(code).toMatch(new RegExp(`${col} <> 'NaN'`))
    }
  })

  it('order_items: nombre 1–120 y no vacío, cantidad 1–9999, precio >= 0', () => {
    expect(code).toContain("CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> '')")
    expect(code).toContain('CHECK (quantity BETWEEN 1 AND 9999)')
    expect(code).toMatch(/unit_price numeric\(12,2\) NOT NULL CHECK \(unit_price >= 0 AND unit_price <> 'NaN'\)/)
  })

  it('crea los índices previstos', () => {
    expect(code).toContain('idx_orders_account_created ON orders (account_id, created_at DESC)')
    expect(code).toContain('idx_orders_contact_created ON orders (contact_id, created_at DESC)')
    expect(code).not.toContain('idx_orders_account_contact')
    expect(code).toMatch(/idx_orders_conversation ON orders \(conversation_id\)\s+WHERE conversation_id IS NOT NULL/)
    expect(code).toMatch(/idx_orders_deal ON orders \(deal_id\)\s+WHERE deal_id IS NOT NULL/)
    expect(code).toMatch(/idx_orders_account_paid_at ON orders \(account_id, paid_at\)\s+WHERE payment_status = 'paid'/)
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
    it(`${table}: sin política INSERT (los pedidos nuevos solo nacen en create_order)`, () => {
      expect(policiesFor(table, 'INSERT')).toHaveLength(0)
      expect(code).not.toMatch(new RegExp(`ON ${table}\\s+FOR INSERT`, 'i'))
    })

    it(`${table}: sin política DELETE (se cancela, no se borra)`, () => {
      expect(policiesFor(table, 'DELETE')).toHaveLength(0)
      expect(code).not.toMatch(new RegExp(`ON ${table}\\s+FOR DELETE`, 'i'))
      expect(code).not.toMatch(new RegExp(`ON ${table}\\s+FOR ALL`, 'i'))
    })
  }

  it('order_items: sin política UPDATE (las líneas son el comprobante)', () => {
    expect(policiesFor('order_items', 'UPDATE')).toHaveLength(0)
  })

  it('orders UPDATE: agent o más, con WITH CHECK agent', () => {
    const found = policiesFor('orders', 'UPDATE')
    expect(found).toHaveLength(1)
    expect(found[0].body).toMatch(/USING\s*\(\s*is_account_member\(account_id,\s*'agent'\)\s*\)/)
    expect(found[0].body).toMatch(/WITH CHECK\s*\(\s*is_account_member\(account_id,\s*'agent'\)/)
    expect(found[0].body).not.toContain("'admin'")
  })

  it('orders UPDATE: el negocio enlazado debe ser de la misma cuenta', () => {
    const [update] = policiesFor('orders', 'UPDATE')
    expect(update.body).toMatch(
      /deal_id IS NULL\s+OR EXISTS \(\s*SELECT 1 FROM deals d\s+WHERE d\.id = orders\.deal_id AND d\.account_id = orders\.account_id/,
    )
  })

  it('las políticas retiradas se borran por si una versión anterior ya se aplicó', () => {
    for (const [name, table] of [
      ['orders_insert', 'orders'],
      ['order_items_insert', 'order_items'],
      ['order_items_update', 'order_items'],
    ]) {
      expect(code).toContain(`DROP POLICY IF EXISTS ${name} ON ${table};`)
    }
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
    expect(creates.length).toBeGreaterThanOrEqual(7)
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
    for (const col of [
      'account_id', 'number', 'contact_id', 'conversation_id', 'customer_name', 'customer_phone',
      'subtotal', 'shipping', 'total', 'currency', 'created_by',
    ]) {
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

describe('054_ventas.sql — libro de pedidos (orders_ledger_guard)', () => {
  const fn = code.match(/FUNCTION public\.orders_ledger_guard\(\)[\s\S]*?\$\$;/)?.[0] ?? ''

  it('es un trigger BEFORE UPDATE solo para el navegador', () => {
    expect(fn).not.toBe('')
    expect(fn).toContain("current_user IN ('authenticated', 'anon')")
    expect(fn).toContain("ERRCODE = 'insufficient_privilege'")
    expect(code).toMatch(/CREATE TRIGGER orders_ledger_guard\s+BEFORE UPDATE ON orders/)
    expect(code).toContain('ALTER FUNCTION public.orders_ledger_guard() OWNER TO postgres')
  })

  it('el estado solo avanza: new→shipped|delivered|cancelled y shipped→delivered|cancelled', () => {
    // new→delivered: retiro en tienda / entrega local sin guía.
    expect(fn).toContain("OLD.status = 'new' AND NEW.status IN ('shipped', 'delivered', 'cancelled')")
    expect(fn).toContain("OLD.status = 'shipped' AND NEW.status IN ('delivered', 'cancelled')")
    expect(fn).toMatch(/NEW\.status IS DISTINCT FROM OLD\.status/)
  })

  it('delivered y cancelled son finales: no hay transición que salga de ellos', () => {
    expect(fn).not.toMatch(/OLD\.status = 'delivered' AND NEW\.status/)
    expect(fn).not.toMatch(/OLD\.status = 'cancelled' AND NEW\.status/)
  })

  it('un pedido cancelado no cambia su estado de pago (42501)', () => {
    const block = fn.match(
      /IF OLD\.status = 'cancelled' AND NEW\.payment_status IS DISTINCT FROM OLD\.payment_status THEN[\s\S]*?END IF;/,
    )?.[0]
    expect(block).toBeDefined()
    expect(block).toContain("ERRCODE = 'insufficient_privilege'")
  })

  it('documenta que last_notice, last_notice_error e id_number quedan editables (solo los CHECK)', () => {
    expect(raw).toMatch(/last_notice`?,[\s-]*`?last_notice_error`? e `?id_number`?[\s\S]{0,400}aceptado por diseño/)
  })

  it('al fijar una marca de tiempo desde el navegador se fuerza now() (sin fechas atrasadas)', () => {
    for (const col of ['paid_at', 'shipped_at', 'delivered_at', 'cancelled_at']) {
      expect(fn).toContain(`OLD.${col} IS NULL AND NEW.${col} IS NOT NULL`)
      expect(fn).toContain(`NEW.${col} := now();`)
    }
  })

  it('el pago nunca vuelve de paid a pending, y paid exige paid_at', () => {
    expect(fn).toContain("OLD.payment_status = 'paid' AND NEW.payment_status <> 'paid'")
    expect(fn).toContain("NEW.payment_status = 'paid' AND NEW.paid_at IS NULL")
  })

  it('las marcas de tiempo se fijan una sola vez', () => {
    for (const col of ['paid_at', 'shipped_at', 'delivered_at', 'cancelled_at']) {
      expect(fn).toContain(`OLD.${col} IS NOT NULL AND NEW.${col} IS DISTINCT FROM OLD.${col}`)
    }
  })

  it('deja editables los datos operativos (avisos, negocio, envío)', () => {
    for (const col of ['last_notice', 'last_notice_error', 'deal_id', 'carrier', 'tracking_number', 'city', 'address']) {
      expect(fn).not.toContain(`NEW.${col}`)
    }
  })
})

describe('054_ventas.sql — create_order()', () => {
  const fn =
    code.match(/CREATE OR REPLACE FUNCTION public\.create_order\([\s\S]*?\n\$\$;/)?.[0] ?? ''
  const signature = 'public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)'

  it('existe, es SECURITY DEFINER de postgres y fija el search_path', () => {
    expect(fn).not.toBe('')
    expect(fn).toMatch(/SECURITY DEFINER/)
    expect(fn).not.toMatch(/SECURITY INVOKER/)
    expect(fn).toContain('SET search_path = public, pg_temp')
    expect(fn).toMatch(/RETURNS orders/)
    expect(code).toContain(`ALTER FUNCTION ${signature} OWNER TO postgres;`)
  })

  it('borra la firma anterior (con p_currency) antes de crear la nueva', () => {
    const drop = code.indexOf(
      'DROP FUNCTION IF EXISTS public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb);',
    )
    const create = code.indexOf('CREATE OR REPLACE FUNCTION public.create_order(')
    expect(drop).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(drop)
  })

  it('documenta que las llamadas sin JWT (SQL Editor, pg_cron) se rechazan a propósito', () => {
    expect(raw).toMatch(/sin JWT[\s\S]*SQL Editor[\s\S]*pg_cron[\s\S]*A PROPÓSITO/)
  })

  it('no recibe la moneda: la lee de la cuenta', () => {
    expect(fn).not.toContain('p_currency')
    expect(fn).toMatch(/SELECT default_currency, modules\s+INTO v_currency, v_modules\s+FROM accounts WHERE id = p_account_id/)
  })

  it('guarda de acceso: service_role o agente de la cuenta (42501), antes de tocar datos', () => {
    expect(fn).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'\s+AND NOT is_account_member\(p_account_id, 'agent'\)/)
    expect(fn).toContain("ERRCODE = 'insufficient_privilege'")
    const guard = fn.indexOf("is_account_member(p_account_id, 'agent')")
    const firstRead = fn.indexOf('FROM accounts')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstRead)
  })

  it('exige que el módulo Ventas esté activo en la cuenta', () => {
    expect(fn).toMatch(/NOT \('ventas' = ANY\(v_modules\)\)/)
    expect(fn).toContain('El módulo Ventas no está activo')
    expect(fn).toContain("ERRCODE = 'P0001'")
  })

  it('no confía en el llamador: contacto y conversación deben ser de la cuenta', () => {
    expect(fn).toMatch(/FROM contacts\s+WHERE id = p_contact_id AND account_id = p_account_id/)
    expect(fn).toMatch(/FROM conversations\s+WHERE id = p_conversation_id AND account_id = p_account_id AND contact_id = p_contact_id/)
    expect(fn).toContain("ERRCODE = '23503'")
  })

  it('guarda nombre y teléfono del contacto en el pedido', () => {
    expect(fn).toMatch(/SELECT name, phone\s+INTO v_contact_name, v_contact_phone\s+FROM contacts/)
    expect(fn).toContain("nullif(btrim(v_contact_name), '')")
    expect(fn).toMatch(/customer_name, customer_phone/)
  })

  it('rechaza NaN en el envío y en los precios, y nombres que son solo espacios', () => {
    expect(fn).toContain("v_shipping = 'NaN'::numeric")
    expect(fn).toMatch(/\(v_item->>'unit_price'\)::numeric = 'NaN'::numeric/)
    expect(fn).toMatch(/btrim\(v_item->>'name'\) = ''/)
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
    expect(sql).toContain("to_regprocedure('public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)')")
    expect(sql).toContain("has_function_privilege('anon'")
    expect(sql).toContain("has_function_privilege('authenticated'")
    expect(sql).toContain("has_function_privilege('service_role'")
    expect(sql).toContain("cmd IN ('DELETE', 'ALL')")
  })

  it('comprueba que create_order es DEFINER de postgres con su guarda', () => {
    expect(sql).toContain("'search_path=public, pg_temp' = ANY(proconfig)")
    expect(sql).toMatch(/NOT prosecdef/)
    expect(sql).toContain("pg_get_userbyid(proowner) <> 'postgres'")
    expect(sql).toContain("NOT LIKE '%is_account_member%'")
    expect(sql).toContain("NOT LIKE '%service_role%'")
    expect(sql).toContain("NOT LIKE '%''ventas''%'")
  })

  it('comprueba que la firma vieja de create_order (con p_currency) ya no existe', () => {
    expect(sql).toContain(
      "to_regprocedure('public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb)') IS NOT NULL",
    )
  })

  it('comprueba que no hay política INSERT en orders ni order_items', () => {
    expect(sql).toMatch(/tablename IN \('orders', 'order_items'\)\s+AND cmd = 'INSERT'/)
  })

  it('comprueba la FK de contacto (SET NULL), las columnas de cliente y los triggers', () => {
    expect(sql).toContain("confdeltype = 'n'")
    expect(sql).toContain("column_name IN ('customer_name', 'customer_phone')")
    expect(sql).toContain("'orders_ledger_guard'")
    expect(sql).toContain("tgname = 'order_items_freeze'")
  })

  it('ya no recorre políticas INSERT/UPDATE de order_items', () => {
    expect(sql).not.toMatch(/ARRAY\['orders', 'order_items'\] LOOP\s+FOR v_cmd IN SELECT unnest\(ARRAY\['INSERT', 'UPDATE'\]\)/)
  })

  it('sigue siendo UN solo statement (un único bloque DO)', () => {
    const noComments = sql.replace(/--[^\r\n]*/g, '')
    expect(noComments.match(/\bDO\s+\$\$/g)).toHaveLength(1)
    expect(noComments.match(/\bEND\s*\$\$;/g)).toHaveLength(1)
  })
})

describe('054_ventas.sql — activación', () => {
  it('apunta a la sentencia única de docs/ventas.md («Activar»), sin repetir una que pueda quitar la agenda', () => {
    expect(raw).toContain('docs/ventas.md')
    expect(raw).toContain('«Activar»')
    expect(raw).not.toContain("array_append(modules, 'ventas')")
  })
})

describe('verify-schema.sql (054): cancelado sin cambios de pago', () => {
  const verify = readFileSync(join(SUPABASE_DIR, 'ci', 'verify-schema.sql'), 'utf8')

  it('comprueba la guarda en el cuerpo de orders_ledger_guard', () => {
    expect(verify).toContain("pg_get_functiondef('public.orders_ledger_guard()'::regprocedure)")
    expect(verify).toContain(
      "NOT LIKE '%OLD.status = ''cancelled'' AND NEW.payment_status IS DISTINCT FROM OLD.payment_status%'",
    )
  })
})
