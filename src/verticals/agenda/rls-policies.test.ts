import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BARBERIA_PRESET } from './presets/barberia'

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

// Sintaxis de Postgres:
//   CREATE POLICY nombre ON [esquema.]tabla [AS PERMISSIVE|RESTRICTIVE]
//     [FOR ALL|SELECT|INSERT|UPDATE|DELETE] [TO roles] [USING (...)] [WITH CHECK (...)]
// Sin FOR la política vale para todos los comandos (ALL). Las de otros
// esquemas (storage.objects) no son de las tablas de la app: se ignoran.
const POLICY_STATEMENT =
  /(DROP POLICY(?:\s+IF EXISTS)?\s+("?[\w ]+"?)\s+ON\s+(?:(\w+)\.)?(\w+)\s*;)|(CREATE POLICY\s+("?[\w ]+"?)\s+ON\s+(?:(\w+)\.)?(\w+)(?:\s+AS\s+(?:PERMISSIVE|RESTRICTIVE))?(?:\s+FOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE))?([\s\S]*?);)/gi

// Re-aplica en orden los archivos SQL y devuelve las políticas que
// quedan vigentes (clave `tabla.nombre`).
function parsePolicies(sqlFiles: string[]): Map<string, Policy> {
  const policies = new Map<string, Policy>()
  for (const raw of sqlFiles) {
    // Fuera los comentarios de línea: llevan ';' y nombres de política.
    const sql = raw.replace(/--[^\n]*/g, '')
    for (const m of sql.matchAll(POLICY_STATEMENT)) {
      if (m[1]) {
        if (m[3] && m[3].toLowerCase() !== 'public') continue
        policies.delete(`${m[4]}.${m[2]}`)
      } else {
        if (m[7] && m[7].toLowerCase() !== 'public') continue
        policies.set(`${m[8]}.${m[6]}`, {
          table: m[8],
          name: m[6],
          cmd: (m[9] ?? 'ALL').toUpperCase(),
          body: m[10],
        })
      }
    }
  }
  return policies
}

function effectivePolicies(): Map<string, Policy> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  return parsePolicies(
    files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')),
  )
}

// Quita los comentarios de línea de un archivo SQL (CRLF o LF).
const stripComments = (sql: string): string => sql.replace(/--[^\r\n]*/g, '')

// Junta los espacios para comparar texto SQL sin depender del formato.
const squash = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()

// Las políticas permisivas se OR-ean en Postgres: una FOR ALL
// (cmd='ALL') que mencione 'agent' vuelve inútil a la política
// admin-only aunque aquella siga existiendo. Por eso acá se recolectan
// las 'ALL' junto a las del comando exacto (mismo criterio que
// supabase/ci/verify-schema.sql).
function policiesFor(table: string, cmd: string): Policy[] {
  return [...effectivePolicies().values()].filter(
    (p) => p.table === table && (p.cmd === cmd || p.cmd === 'ALL'),
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
        expect(found.length).toBeGreaterThan(0)
        for (const policy of found) {
          expect(policy.body).toContain("'admin'")
          expect(policy.body).not.toContain("'agent'")
        }
      })
    }

    it(`${table} SELECT: cualquier miembro (viewer incluido)`, () => {
      const found = policiesFor(table, 'SELECT')
      expect(
        found.some((p) => /is_account_member\(account_id\)/.test(p.body)),
      ).toBe(true)
    })
  }

  it('los agentes no pueden crear bloqueos (time off)', () => {
    const found = policiesFor('booking_time_off', 'INSERT')
    expect(found.length).toBeGreaterThan(0)
    for (const policy of found) expect(policy.body).not.toContain("'agent'")
  })

  for (const table of ['booking_appointments', 'booking_sessions']) {
    it(`${table}: la escritura sigue abierta a agent (operación)`, () => {
      for (const cmd of ['INSERT', 'UPDATE']) {
        const found = policiesFor(table, cmd)
        expect(found.length).toBeGreaterThan(0)
        expect(found.some((p) => p.body.includes("'agent'"))).toBe(true)
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

  it("051 (aditiva): el backfill filtra por 'barberia' (re-correrla no pisa cuentas 'agenda')", () => {
    expect(code).toMatch(backfillInsert)
    expect(code).toMatch(backfillUpdate)
  })

  it('051: el backfill conserva la bienvenida de barbería sin pisar una personalizada', () => {
    const update = code.match(backfillUpdate)?.[0] ?? ''
    expect(update).toMatch(/bot_texts\s*=\s*CASE/i)
    expect(update).toMatch(/WHEN\s+bs\.bot_texts\s*\?\s*'welcome'\s+THEN\s+bs\.bot_texts/i)
    expect(update).toContain(BARBERIA_PRESET.welcome)
    // Idempotente: solo toca filas que aún no tienen punto de partida.
    expect(code).toMatch(/AND\s+bs\.preset_key\s+IS\s+NULL/i)
  })

  it('051 (aditiva): no toca accounts (segura con el código viejo en producción)', () => {
    expect(code).not.toMatch(/UPDATE\s+accounts\b/i)
    expect(code).not.toMatch(/ALTER\s+TABLE\s+accounts\b/i)
    expect(code).not.toMatch(rewrite)
  })

  describe('052 (reescritura de la clave del vertical)', () => {
    const code052 = readFileSync(
      join(MIGRATIONS_DIR, '052_agenda_vertical_key.sql'),
      'utf8',
    ).replace(/--[^\r\n]*/g, '')

    it("reescribe 'barberia' a 'agenda'", () => {
      expect(code052).toMatch(rewrite)
    })

    it('es lo único que hace: un solo UPDATE, sin DDL ni borrados', () => {
      expect(code052.match(/\bUPDATE\b/gi)).toHaveLength(1)
      expect(code052).not.toMatch(/\b(CREATE|ALTER|DROP|DELETE|TRUNCATE|INSERT)\b/i)
    })

    it('lleva lock_timeout', () => {
      expect(code052).toMatch(/SET\s+LOCAL\s+lock_timeout/i)
    })
  })
})

describe('lector de políticas (parsePolicies)', () => {
  const only = (sql: string) => [...parsePolicies([sql]).values()]

  it('una política sin FOR cuenta como ALL', () => {
    const [p] = only("CREATE POLICY p ON t USING (is_account_member(account_id, 'agent'));")
    expect(p.cmd).toBe('ALL')
    expect(p.table).toBe('t')
  })

  it('acepta ON public.tabla', () => {
    const [p] = only('CREATE POLICY p ON public.t FOR SELECT USING (true);')
    expect(p).toMatchObject({ table: 't', cmd: 'SELECT' })
  })

  it('acepta AS PERMISSIVE / AS RESTRICTIVE antes de FOR (y también sin FOR)', () => {
    const found = only(`
      CREATE POLICY a ON t AS PERMISSIVE FOR INSERT WITH CHECK (true);
      CREATE POLICY b ON public.u AS RESTRICTIVE USING (true);
    `)
    expect(found.map((p) => [p.table, p.cmd])).toEqual([
      ['t', 'INSERT'],
      ['u', 'ALL'],
    ])
  })

  it('DROP POLICY (con o sin IF EXISTS, con public.) retira la política', () => {
    expect(
      only('CREATE POLICY p ON t FOR SELECT USING (true); DROP POLICY IF EXISTS p ON public.t;'),
    ).toHaveLength(0)
    expect(only('CREATE POLICY p ON t FOR SELECT USING (true); DROP POLICY p ON t;')).toHaveLength(0)
  })

  it('un CREATE posterior reemplaza al anterior con el mismo nombre', () => {
    const found = only(`
      CREATE POLICY p ON t FOR SELECT USING (true);
      DROP POLICY IF EXISTS p ON t;
      CREATE POLICY p ON t FOR SELECT USING (false);
    `)
    expect(found).toHaveLength(1)
    expect(found[0].body).toContain('false')
  })

  it('ignora las políticas de otros esquemas (storage.objects)', () => {
    expect(only('CREATE POLICY "Avatars" ON storage.objects FOR SELECT USING (true);')).toHaveLength(0)
  })

  it('ignora lo que está en comentarios', () => {
    expect(only('-- CREATE POLICY p ON t FOR SELECT USING (true);')).toHaveLength(0)
  })
})

describe('ninguna migración apaga ni esquiva la RLS', () => {
  const offendersFor = (pattern: RegExp): string[] =>
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => pattern.test(stripComments(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))))

  it('no hay DISABLE ROW LEVEL SECURITY en ningún archivo', () => {
    expect(offendersFor(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i)).toEqual([])
  })

  it('no hay ALTER POLICY (el lector de políticas no lo sigue: usar DROP + CREATE)', () => {
    expect(offendersFor(/\bALTER\s+POLICY\b/i)).toEqual([])
  })
})

describe('módulo clínica (055)', () => {
  const CLINIC_TABLES = ['clinic_settings', 'clinic_locations', 'clinic_patients', 'clinic_consents']

  const ADMIN = "is_account_member(account_id, 'admin')"
  const AGENT = "is_account_member(account_id, 'agent')"
  // El servicio de urgencias debe ser de la misma cuenta: la FK sola no lo comprueba.
  const SERVICE_SAME_ACCOUNT = `(
    urgency_service_id IS NULL
    OR EXISTS (
      SELECT 1 FROM booking_services s
      WHERE s.id = clinic_settings.urgency_service_id
        AND s.account_id = clinic_settings.account_id
    )
  )`
  // El contacto del paciente debe ser de la misma cuenta (patrón 054, orders.deal_id).
  const CONTACT_SAME_ACCOUNT = `EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = clinic_patients.contact_id
      AND c.account_id = clinic_patients.account_id
  )`

  // Una sola política por (tabla, comando) y con el cuerpo exacto: una
  // segunda permisiva, o una FOR ALL, abriría la tabla (se suman con OR).
  function expectOnly(table: string, cmd: string, body: string) {
    const found = policiesFor(table, cmd)
    expect(found, `${table} ${cmd}`).toHaveLength(1)
    expect(squash(found[0].body)).toBe(squash(body))
  }

  for (const table of CLINIC_TABLES) {
    it(`${table} SELECT: una sola política, abierta a cualquier miembro`, () => {
      expectOnly(table, 'SELECT', 'USING (is_account_member(account_id))')
    })
  }

  describe('configuración y sedes: solo owner/admin escribe', () => {
    for (const table of ['clinic_settings', 'clinic_locations']) {
      for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
        it(`${table} ${cmd}: solo owner/admin`, () => {
          const found = policiesFor(table, cmd)
          expect(found).toHaveLength(1)
          expect(found[0].body).toContain("'admin'")
          expect(found[0].body).not.toContain("'agent'")
        })
      }
    }

    it('clinic_locations: cuerpos exactos', () => {
      expectOnly('clinic_locations', 'INSERT', `WITH CHECK (${ADMIN})`)
      expectOnly('clinic_locations', 'UPDATE', `USING (${ADMIN}) WITH CHECK (${ADMIN})`)
      expectOnly('clinic_locations', 'DELETE', `USING (${ADMIN})`)
    })

    it('clinic_settings: cuerpos exactos, con servicio de urgencias de la misma cuenta', () => {
      expectOnly('clinic_settings', 'INSERT', `WITH CHECK (${ADMIN} AND ${SERVICE_SAME_ACCOUNT})`)
      expectOnly(
        'clinic_settings',
        'UPDATE',
        `USING (${ADMIN}) WITH CHECK (${ADMIN} AND ${SERVICE_SAME_ACCOUNT})`,
      )
      expectOnly('clinic_settings', 'DELETE', `USING (${ADMIN})`)
    })
  })

  describe('pacientes: agent escribe, nadie borra, el contacto es de la misma cuenta', () => {
    it('INSERT y UPDATE: cuerpos exactos, con el contacto de la misma cuenta', () => {
      expectOnly('clinic_patients', 'INSERT', `WITH CHECK (${AGENT} AND ${CONTACT_SAME_ACCOUNT})`)
      expectOnly(
        'clinic_patients',
        'UPDATE',
        `USING (${AGENT}) WITH CHECK (${AGENT} AND ${CONTACT_SAME_ACCOUNT})`,
      )
    })

    it('DELETE: sin política (un paciente con citas es un registro del negocio)', () => {
      expect(policiesFor('clinic_patients', 'DELETE')).toHaveLength(0)
    })
  })

  describe('WITH CHECK en los UPDATE (no se puede mover la fila a otra cuenta)', () => {
    for (const [table, role] of [
      ['clinic_settings', 'admin'],
      ['clinic_locations', 'admin'],
      ['clinic_patients', 'agent'],
    ] as const) {
      it(`${table} UPDATE`, () => {
        const [update] = policiesFor(table, 'UPDATE')
        expect(update.body).toMatch(
          new RegExp(`WITH CHECK\\s*\\(\\s*is_account_member\\(account_id,\\s*'${role}'\\)`),
        )
      })
    }
  })

  it('clinic_consents: desde el navegador solo se lee', () => {
    expect(policiesFor('clinic_consents', 'SELECT')).toHaveLength(1)
    for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(policiesFor('clinic_consents', cmd)).toHaveLength(0)
    }
  })

  const code = stripComments(readFileSync(join(MIGRATIONS_DIR, '055_clinica_base.sql'), 'utf8'))
  const flat = squash(code)

  // El cuerpo de un CREATE TABLE, con los espacios juntos.
  function tableBlock(name: string): string {
    const m = code.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\r?\\n\\);`),
    )
    expect(m, `CREATE TABLE ${name}`).not.toBeNull()
    return squash(m![1])
  }

  it('activa RLS en las cuatro tablas', () => {
    for (const table of CLINIC_TABLES) {
      expect(code).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
    }
  })

  it('no es destructiva y lleva lock_timeout', () => {
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/DROP\s+COLUMN/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    // REVOKE TRUNCATE es justo lo que queremos: se mira sin GRANT/REVOKE.
    expect(code.replace(/\b(?:GRANT|REVOKE)\b[^;]*;/gi, '')).not.toMatch(/\bTRUNCATE\b/i)
    expect(code).toMatch(/SET\s+LOCAL\s+lock_timeout/i)
  })

  describe('las autorizaciones sobreviven al contacto', () => {
    it('clinic_consents.contact_id es anulable y pasa a NULL al borrar el contacto', () => {
      const consents = tableBlock('clinic_consents')
      expect(consents).toMatch(/contact_id uuid REFERENCES contacts\(id\) ON DELETE SET NULL/)
      expect(consents).not.toMatch(/contact_id uuid NOT NULL/)
    })

    it('guarda quién autorizó (contact_ref) y qué texto aceptó (text_snapshot)', () => {
      const consents = tableBlock('clinic_consents')
      expect(consents).toContain(
        "contact_ref text NOT NULL CHECK (char_length(contact_ref) BETWEEN 1 AND 64 AND contact_ref ~ '\\S')",
      )
      expect(consents).toContain(
        "text_snapshot text NOT NULL CHECK (char_length(text_snapshot) BETWEEN 1 AND 1000 AND text_snapshot ~ '\\S')",
      )
    })

    it('clinic_patients.contact_id es NOT NULL y SIN cascada: un contacto con paciente no se borra', () => {
      const patients = tableBlock('clinic_patients')
      const column = patients.match(/\bcontact_id uuid [^,]*/)?.[0] ?? ''
      expect(column).toBe('contact_id uuid NOT NULL REFERENCES contacts(id)')
      expect(column).not.toMatch(/ON DELETE/i)
    })
  })

  describe('nada cruza cuentas', () => {
    it('pacientes y sedes llevan UNIQUE (account_id, id)', () => {
      expect(tableBlock('clinic_patients')).toContain('UNIQUE (account_id, id)')
      expect(tableBlock('clinic_locations')).toContain('UNIQUE (account_id, id)')
    })

    it('las columnas de la cita se agregan sin FK simple', () => {
      expect(flat).toMatch(/ALTER TABLE booking_appointments ADD COLUMN IF NOT EXISTS patient_id uuid, ADD COLUMN IF NOT EXISTS location_id uuid;/)
    })

    for (const [column, table, constraint] of [
      ['patient_id', 'clinic_patients', 'booking_appointments_patient_fk'],
      ['location_id', 'clinic_locations', 'booking_appointments_location_fk'],
    ] as const) {
      it(`${column}: FK compuesta (account_id, ${column}) y re-ejecutable`, () => {
        expect(flat).toContain(
          `ALTER TABLE booking_appointments DROP CONSTRAINT IF EXISTS ${constraint};`,
        )
        expect(flat).toContain(
          `ALTER TABLE booking_appointments ADD CONSTRAINT ${constraint} ` +
            `FOREIGN KEY (account_id, ${column}) REFERENCES ${table} (account_id, id) ` +
            `ON DELETE SET NULL (${column});`,
        )
      })
    }

    it('el encabezado avisa que pide Postgres 15 o más', () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, '055_clinica_base.sql'), 'utf8')
      const header = sql.slice(0, sql.indexOf('SET LOCAL lock_timeout'))
      expect(header).toMatch(/REQUIERE Postgres 15 o más/)
      expect(header).not.toMatch(/Postgres 1[0-4]\b/)
    })
  })

  describe('clinic_consents es solo para agregar de verdad', () => {
    it('trigger BEFORE UPDATE OR DELETE por fila, re-ejecutable', () => {
      expect(flat).toContain('DROP TRIGGER IF EXISTS clinic_consents_append_only ON clinic_consents;')
      expect(flat).toContain(
        'CREATE TRIGGER clinic_consents_append_only BEFORE UPDATE OR DELETE ON clinic_consents ' +
          'FOR EACH ROW EXECUTE FUNCTION clinic_consents_append_only();',
      )
    })

    it('a profundidad > 1 deja pasar DELETE, pero un UPDATE solo si pone contact_id en NULL y nada más', () => {
      const fn = flat.match(
        /CREATE OR REPLACE FUNCTION clinic_consents_append_only\(\) RETURNS trigger AS \$\$(.*?)\$\$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;/,
      )
      expect(fn, 'CREATE OR REPLACE FUNCTION clinic_consents_append_only').not.toBeNull()
      const body = fn![1]
      expect(body).toContain('pg_trigger_depth() > 1')
      expect(body).toContain("ERRCODE = 'insufficient_privilege'")
      // El rechazo va DESPUÉS de la salida de las FK: si no, la FK nunca pasaría.
      expect(body.indexOf('pg_trigger_depth()')).toBeLessThan(body.indexOf('RAISE EXCEPTION'))
      // Borrar la cuenta borra las filas (DELETE abierto); borrar el contacto
      // solo pone contact_id en NULL. Cualquier otro UPDATE anidado cae al RAISE.
      expect(body).toContain(
        "IF pg_trigger_depth() > 1 THEN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; " +
          "IF NEW.contact_id IS NULL AND to_jsonb(NEW) - 'contact_id' = to_jsonb(OLD) - 'contact_id' " +
          'THEN RETURN NEW; END IF; END IF;',
      )
      expect(body.match(/RETURN NEW/g)).toHaveLength(1)
      expect(body.match(/RETURN OLD/g)).toHaveLength(1)
    })

    it('la función se endurece como 047: dueña postgres, solo service_role ejecuta', () => {
      expect(flat).toContain('ALTER FUNCTION public.clinic_consents_append_only() OWNER TO postgres;')
      expect(flat).toContain(
        'REVOKE ALL ON FUNCTION public.clinic_consents_append_only() FROM PUBLIC, anon, authenticated;',
      )
      expect(flat).toContain(
        'GRANT EXECUTE ON FUNCTION public.clinic_consents_append_only() TO service_role;',
      )
    })

    it('TRUNCATE revocado a anon, authenticated y service_role', () => {
      expect(flat).toContain(
        'REVOKE TRUNCATE ON clinic_consents FROM anon, authenticated, service_role;',
      )
    })
  })

  describe('índices', () => {
    it.each([
      [
        'citas por paciente (parcial)',
        'CREATE INDEX IF NOT EXISTS idx_booking_appointments_patient ON booking_appointments (patient_id) WHERE patient_id IS NOT NULL;',
      ],
      [
        'citas por sede (parcial)',
        'CREATE INDEX IF NOT EXISTS idx_booking_appointments_location ON booking_appointments (location_id) WHERE location_id IS NOT NULL;',
      ],
      [
        'pacientes por contacto (la FK busca por contact_id)',
        'CREATE INDEX IF NOT EXISTS idx_clinic_patients_contact ON clinic_patients (contact_id);',
      ],
      [
        'autorizaciones por contacto (parcial: contact_id es anulable)',
        'CREATE INDEX IF NOT EXISTS idx_clinic_consents_contact ON clinic_consents (contact_id) WHERE contact_id IS NOT NULL;',
      ],
    ])('%s', (_name, ddl) => {
      expect(flat).toContain(ddl)
    })
  })

  describe('identificador externo y validaciones', () => {
    const PAIR = 'CHECK ((external_source IS NULL) = (external_id IS NULL))'

    it('fuente e id externos van juntos o ninguno, en pacientes y en sedes', () => {
      expect(tableBlock('clinic_patients')).toContain(PAIR)
      expect(tableBlock('clinic_locations')).toContain(PAIR)
      expect(tableBlock('clinic_locations')).toMatch(/\bexternal_source text\b/)
    })

    it('el id externo es único por cuenta y fuente, también en sedes', () => {
      expect(flat).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_patients_external ON clinic_patients (account_id, external_source, external_id) WHERE external_id IS NOT NULL;',
      )
      expect(flat).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_locations_external ON clinic_locations (account_id, external_source, external_id) WHERE external_id IS NOT NULL;',
      )
    })

    it('los nombres no pueden ser solo espacios', () => {
      expect(tableBlock('clinic_patients')).toContain("btrim(full_name) <> ''")
      expect(tableBlock('clinic_locations')).toContain("btrim(name) <> ''")
    })

    it('los textos de autorización no pueden estar en blanco (~ \'\\S\': btrim no quita saltos de línea)', () => {
      for (const [table, column, max] of [
        ['clinic_settings', 'consent_text', 900],
        ['clinic_settings', 'urgency_alarm_text', 900],
        ['clinic_consents', 'contact_ref', 64],
        ['clinic_consents', 'text_snapshot', 1000],
      ] as const) {
        expect(tableBlock(table)).toContain(
          `CHECK (char_length(${column}) BETWEEN 1 AND ${max} AND ${column} ~ '\\S')`,
        )
      }
    })

    it('latitud y longitud en rango', () => {
      const locations = tableBlock('clinic_locations')
      expect(locations).toContain('CHECK (latitude BETWEEN -90 AND 90)')
      expect(locations).toContain('CHECK (longitude BETWEEN -180 AND 180)')
    })
  })
})

describe('clínica, fases 2 y 3 (056)', () => {
  const FILE = '056_clinica_recepcion_seguimientos.sql'
  const NEW_TABLES = [
    'agenda_calendar_connections',
    'booking_call_settings',
    'booking_calls',
    'clinic_followups',
    'clinic_ratings',
    'clinic_day_closes',
  ]
  // Las que el navegador puede leer (la de Google no tiene ninguna política).
  const READABLE_TABLES = NEW_TABLES.filter((t) => t !== 'agenda_calendar_connections')

  const ADMIN = "is_account_member(account_id, 'admin')"
  const AGENT = "is_account_member(account_id, 'agent')"
  // Llamada a mano: solo manual y saliente, a nombre de quien la anota y con
  // un contacto de su misma cuenta (la FK sola no lo comprueba).
  const MANUAL_CALL = `(
    ${AGENT}
    AND channel = 'manual'
    AND direction = 'outbound'
    AND created_by = auth.uid()
    AND (
      contact_id IS NULL
      OR EXISTS (
        SELECT 1 FROM contacts c
        WHERE c.id = booking_calls.contact_id
          AND c.account_id = booking_calls.account_id
      )
    )
  )`

  // Una sola política por (tabla, comando) y con el cuerpo exacto: una
  // segunda permisiva, o una FOR ALL, abriría la tabla (se suman con OR).
  function expectOnly(table: string, cmd: string, body: string) {
    const found = policiesFor(table, cmd)
    expect(found, `${table} ${cmd}`).toHaveLength(1)
    expect(squash(found[0].body)).toBe(squash(body))
  }

  const raw = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8')
  const code = stripComments(raw)
  const flat = squash(code)

  // El cuerpo de un CREATE TABLE, con los espacios juntos.
  function tableBlock(name: string): string {
    const m = code.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\r?\\n\\);`),
    )
    expect(m, `CREATE TABLE ${name}`).not.toBeNull()
    return squash(m![1])
  }

  describe('RLS', () => {
    it('activa la RLS en las seis tablas nuevas', () => {
      for (const table of NEW_TABLES) {
        expect(code).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
      }
    })

    for (const table of READABLE_TABLES) {
      it(`${table} SELECT: una sola política, abierta a cualquier miembro`, () => {
        expectOnly(table, 'SELECT', 'USING (is_account_member(account_id))')
      })
    }

    it('agenda_calendar_connections: SIN ninguna política (el token solo lo lee el servidor)', () => {
      const found = [...effectivePolicies().values()].filter(
        (p) => p.table === 'agenda_calendar_connections',
      )
      expect(found).toEqual([])
    })

    it('agenda_calendar_connections: se revoca todo a anon y authenticated', () => {
      expect(flat).toContain(
        'REVOKE ALL ON agenda_calendar_connections FROM anon, authenticated;',
      )
      // Y nunca se le da nada de vuelta.
      expect(flat).not.toMatch(/GRANT [^;]* ON agenda_calendar_connections/i)
    })

    it('booking_call_settings: owner/admin escriben (cuerpos exactos), sin DELETE', () => {
      expectOnly('booking_call_settings', 'INSERT', `WITH CHECK (${ADMIN})`)
      expectOnly('booking_call_settings', 'UPDATE', `USING (${ADMIN}) WITH CHECK (${ADMIN})`)
      expect(policiesFor('booking_call_settings', 'DELETE')).toHaveLength(0)
      for (const cmd of ['INSERT', 'UPDATE']) {
        const [policy] = policiesFor('booking_call_settings', cmd)
        expect(policy.body).not.toContain("'agent'")
      }
    })

    it('booking_calls: el navegador solo inserta llamadas manuales y salientes, a su nombre', () => {
      expectOnly('booking_calls', 'INSERT', `WITH CHECK ${MANUAL_CALL}`)
    })

    it('booking_calls: sin UPDATE ni DELETE para el navegador', () => {
      expect(policiesFor('booking_calls', 'UPDATE')).toHaveLength(0)
      expect(policiesFor('booking_calls', 'DELETE')).toHaveLength(0)
    })

    for (const table of ['clinic_followups', 'clinic_ratings', 'clinic_day_closes']) {
      it(`${table}: desde el navegador solo se lee`, () => {
        for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
          expect(policiesFor(table, cmd), `${table} ${cmd}`).toHaveLength(0)
        }
      })
    }
  })

  describe('aditiva, no destructiva y re-ejecutable', () => {
    it('no borra nada: ni DROP TABLE/COLUMN ni DELETE/TRUNCATE y lleva lock_timeout', () => {
      expect(code).not.toMatch(/DROP\s+TABLE/i)
      expect(code).not.toMatch(/DROP\s+COLUMN/i)
      expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
      expect(code).not.toMatch(/\bTRUNCATE\b/i)
      expect(code).toMatch(/SET\s+LOCAL\s+lock_timeout/i)
    })

    it('no apaga ni esquiva la RLS de nada', () => {
      expect(code).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i)
      expect(code).not.toMatch(/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i)
    })

    it('el encabezado avisa: Postgres 15 o más y después de 055', () => {
      const header = raw.slice(0, raw.indexOf('SET LOCAL lock_timeout'))
      expect(header).toMatch(/REQUIERE Postgres 15 o más/)
      expect(header).not.toMatch(/Postgres 1[0-4]\b/)
      expect(header).toMatch(/DESPUÉS de 055/)
    })

    it('tablas, columnas e índices con IF NOT EXISTS', () => {
      expect(code).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/i)
      expect(code).not.toMatch(/CREATE (?:UNIQUE )?INDEX(?! IF NOT EXISTS)/i)
      expect(code).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/i)
    })

    it('cada ADD CONSTRAINT va precedido de su DROP CONSTRAINT IF EXISTS', () => {
      const names = [...flat.matchAll(/ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/g)].map((m) => ({
        table: m[1],
        name: m[2],
      }))
      expect(names.length).toBeGreaterThan(0)
      for (const { table, name } of names) {
        // La única excepción es el UNIQUE de las citas: de él cuelgan FK, así
        // que no se borra; se crea solo si falta.
        if (name === 'booking_appointments_account_id_id_key') continue
        expect(flat, name).toContain(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`)
      }
    })

    it('el UNIQUE (account_id, id) de las citas solo se crea si falta', () => {
      expect(flat).toContain(
        'CREATE UNIQUE INDEX IF NOT EXISTS booking_appointments_account_id_id_key ON booking_appointments (account_id, id);',
      )
      expect(flat).toContain(
        "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.booking_appointments'::regclass AND conname = 'booking_appointments_account_id_id_key') THEN " +
          'ALTER TABLE booking_appointments ADD CONSTRAINT booking_appointments_account_id_id_key ' +
          'UNIQUE USING INDEX booking_appointments_account_id_id_key; END IF;',
      )
    })

    it('cada CREATE POLICY y CREATE TRIGGER va precedido de su DROP IF EXISTS', () => {
      const policies = [...flat.matchAll(/CREATE POLICY (\w+) ON (\w+)/g)]
      expect(policies.length).toBeGreaterThan(0)
      for (const [, name, table] of policies) {
        expect(flat, name).toContain(`DROP POLICY IF EXISTS ${name} ON ${table};`)
      }
      const triggers = [...flat.matchAll(/CREATE TRIGGER (\w+)[^;]*? ON (\w+)/g)]
      expect(triggers.length).toBeGreaterThan(0)
      for (const [, name, table] of triggers) {
        expect(flat, name).toContain(`DROP TRIGGER IF EXISTS ${name} ON ${table};`)
      }
    })
  })

  describe('booking_appointments', () => {
    it('agrega la confirmación del paciente y las columnas de Google', () => {
      expect(flat).toContain(
        'ALTER TABLE booking_appointments ADD COLUMN IF NOT EXISTS attendance_confirmed_at timestamptz, ' +
          'ADD COLUMN IF NOT EXISTS google_calendar_id text, ' +
          'ADD COLUMN IF NOT EXISTS google_dirty boolean NOT NULL DEFAULT true, ' +
          'ADD COLUMN IF NOT EXISTS google_synced_at timestamptz, ' +
          'ADD COLUMN IF NOT EXISTS google_sync_error text;',
      )
    })

    it('google_sync_error de hasta 300 y google_calendar_id de hasta 300', () => {
      expect(flat).toContain(
        'CHECK (google_sync_error IS NULL OR char_length(google_sync_error) <= 300)',
      )
      expect(flat).toContain(
        'CHECK (google_calendar_id IS NULL OR char_length(google_calendar_id) <= 300)',
      )
    })

    it("created_via y booking_events.actor aceptan 'dashboard' (citas del panel)", () => {
      expect(flat).toContain(
        "ALTER TABLE booking_appointments ADD CONSTRAINT booking_appointments_created_via_check " +
          "CHECK (created_via IN ('bot', 'agent', 'api', 'dashboard'));",
      )
      expect(flat).toContain(
        "ALTER TABLE booking_events ADD CONSTRAINT booking_events_actor_check " +
          "CHECK (actor IN ('bot', 'agent', 'api', 'dashboard', 'system'));",
      )
    })

    it('índice parcial de lo pendiente de copiar a Google', () => {
      expect(flat).toContain(
        'CREATE INDEX IF NOT EXISTS idx_booking_appointments_google_dirty ON booking_appointments (account_id) WHERE google_dirty;',
      )
    })

    it('booking_staff.google_calendar_id (NULL = el calendario de la conexión)', () => {
      expect(flat).toContain(
        'ALTER TABLE booking_staff ADD COLUMN IF NOT EXISTS google_calendar_id text;',
      )
      expect(flat).toContain(
        'CHECK (google_calendar_id IS NULL OR char_length(google_calendar_id) <= 300)',
      )
    })
  })

  describe('trigger mark_booking_google_dirty', () => {
    const WATCHED = [
      'starts_at',
      'ends_at',
      'status',
      'staff_id',
      'service_id',
      'contact_id',
      'patient_id',
      'location_id',
      'notes',
    ]

    const fn = flat.match(
      /CREATE OR REPLACE FUNCTION mark_booking_google_dirty\(\) RETURNS trigger AS \$\$(.*?)\$\$ LANGUAGE plpgsql SET search_path = public;/,
    )

    it('la función existe, es plpgsql y fija el search_path', () => {
      expect(fn, 'CREATE OR REPLACE FUNCTION mark_booking_google_dirty').not.toBeNull()
    })

    it('mira exactamente las nueve columnas de la cita que Google muestra', () => {
      const body = fn![1]
      for (const column of WATCHED) {
        expect(body, column).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`)
      }
      // Ni una más: si mirara google_* la sincronización se dispararía a sí misma.
      const looked = [...body.matchAll(/OLD\.(\w+)/g)].map((m) => m[1]).sort()
      expect(looked).toEqual([...WATCHED].sort())
    })

    it('en INSERT y en cambio vigilado deja google_dirty en true; nunca lo apaga', () => {
      const body = fn![1]
      expect(body).toContain("TG_OP = 'INSERT'")
      expect(body.match(/NEW\.google_dirty := true;/g)).toHaveLength(2)
      expect(body).not.toMatch(/google_dirty := false/)
    })

    it('BEFORE INSERT OR UPDATE por fila, re-ejecutable', () => {
      expect(flat).toContain('DROP TRIGGER IF EXISTS mark_booking_google_dirty ON booking_appointments;')
      expect(flat).toContain(
        'CREATE TRIGGER mark_booking_google_dirty BEFORE INSERT OR UPDATE ON booking_appointments ' +
          'FOR EACH ROW EXECUTE FUNCTION mark_booking_google_dirty();',
      )
    })

    it('la función se endurece como 047/055: dueña postgres, solo service_role ejecuta', () => {
      expect(flat).toContain('ALTER FUNCTION public.mark_booking_google_dirty() OWNER TO postgres;')
      expect(flat).toContain(
        'REVOKE ALL ON FUNCTION public.mark_booking_google_dirty() FROM PUBLIC, anon, authenticated;',
      )
      expect(flat).toContain(
        'GRANT EXECUTE ON FUNCTION public.mark_booking_google_dirty() TO service_role;',
      )
    })
  })

  describe('updated_at de las citas (candado optimista del panel)', () => {
    const GOOGLE_COLUMNS = ['google_dirty', 'google_synced_at', 'google_calendar_id', 'google_sync_error']

    const fn = flat.match(
      /CREATE OR REPLACE FUNCTION booking_appointments_set_updated_at\(\) RETURNS trigger AS \$\$(.*?)\$\$ LANGUAGE plpgsql SET search_path = public;/,
    )

    it('la función existe, es plpgsql y fija el search_path', () => {
      expect(fn, 'CREATE OR REPLACE FUNCTION booking_appointments_set_updated_at').not.toBeNull()
    })

    it('reemplaza el set_updated_at de 047 solo en las citas, re-ejecutable', () => {
      expect(flat).toContain(
        'DROP TRIGGER IF EXISTS set_updated_at ON booking_appointments; ' +
          'CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_appointments ' +
          'FOR EACH ROW EXECUTE FUNCTION booking_appointments_set_updated_at();',
      )
      // Ninguna otra tabla recibe esta función.
      const users = [...flat.matchAll(/ON (\w+) FOR EACH ROW EXECUTE FUNCTION booking_appointments_set_updated_at/g)]
      expect(users.map((m) => m[1])).toEqual(['booking_appointments'])
    })

    it('no toca la función compartida update_updated_at_column() de las demás tablas', () => {
      expect(code).not.toMatch(
        /(?:CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP)\s+FUNCTION\s+(?:public\.)?update_updated_at_column/i,
      )
    })

    it('conserva updated_at si lo único que cambió son las cuatro columnas google_*', () => {
      const body = fn![1]
      for (const column of GOOGLE_COLUMNS) {
        expect(body, column).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`)
      }
      // Al menos una de las cuatro cambió Y todo lo demás quedó igual.
      expect(body).toContain('AND to_jsonb(NEW) - ignored = to_jsonb(OLD) - ignored')
      expect(body).toContain('NEW.updated_at := OLD.updated_at;')
      // En cualquier otro caso (incluido un UPDATE que no cambia nada) vale now(), como antes.
      expect(body).toContain('ELSE NEW.updated_at := now();')
    })

    it('lo que se ignora al comparar es updated_at y esas cuatro columnas, nada más', () => {
      const list = fn![1].match(/ignored constant text\[\] := ARRAY\[\s*((?:'\w+',?\s*)+)\]/)
      expect(list, 'ignored := ARRAY[...]').not.toBeNull()
      const names = [...list![1].matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()
      expect(names).toEqual(['updated_at', ...GOOGLE_COLUMNS].sort())
    })

    it('corre DESPUÉS de mark_booking_google_dirty (orden alfabético de los triggers)', () => {
      expect('mark_booking_google_dirty' < 'set_updated_at').toBe(true)
    })

    it('la función se endurece igual que mark_booking_google_dirty', () => {
      expect(flat).toContain('ALTER FUNCTION public.booking_appointments_set_updated_at() OWNER TO postgres;')
      expect(flat).toContain(
        'REVOKE ALL ON FUNCTION public.booking_appointments_set_updated_at() FROM PUBLIC, anon, authenticated;',
      )
      expect(flat).toContain(
        'GRANT EXECUTE ON FUNCTION public.booking_appointments_set_updated_at() TO service_role;',
      )
    })
  })

  describe('nada cruza cuentas', () => {
    it('llamadas y seguimientos se van con la cita (FK compuesta, CASCADE)', () => {
      expect(tableBlock('booking_calls')).toContain(
        'CONSTRAINT booking_calls_appointment_fk FOREIGN KEY (account_id, appointment_id) ' +
          'REFERENCES booking_appointments (account_id, id) ON DELETE CASCADE',
      )
      expect(tableBlock('clinic_followups')).toContain(
        'CONSTRAINT clinic_followups_appointment_fk FOREIGN KEY (account_id, appointment_id) ' +
          'REFERENCES booking_appointments (account_id, id) ON DELETE CASCADE',
      )
    })

    it('las calificaciones sobreviven: cita, sede y seguimiento pasan a NULL solo en su columna', () => {
      const ratings = tableBlock('clinic_ratings')
      expect(ratings).toContain(
        'CONSTRAINT clinic_ratings_appointment_fk FOREIGN KEY (account_id, appointment_id) ' +
          'REFERENCES booking_appointments (account_id, id) ON DELETE SET NULL (appointment_id)',
      )
      expect(ratings).toContain(
        'CONSTRAINT clinic_ratings_location_fk FOREIGN KEY (account_id, location_id) ' +
          'REFERENCES clinic_locations (account_id, id) ON DELETE SET NULL (location_id)',
      )
      expect(ratings).toContain(
        'CONSTRAINT clinic_ratings_followup_fk FOREIGN KEY (account_id, followup_id) ' +
          'REFERENCES clinic_followups (account_id, id) ON DELETE SET NULL (followup_id)',
      )
    })

    it('el seguimiento lleva UNIQUE (account_id, id): lo necesita la FK de las calificaciones', () => {
      expect(tableBlock('clinic_followups')).toContain('UNIQUE (account_id, id)')
    })

    it('el contacto se enlaza con SET NULL (se conserva el registro)', () => {
      for (const table of ['booking_calls', 'clinic_followups', 'clinic_ratings']) {
        expect(tableBlock(table), table).toContain('contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL')
      }
    })
  })

  describe('índices', () => {
    it.each([
      [
        'número entrante único (parcial)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_call_settings_inbound_number ON booking_call_settings (inbound_number) WHERE inbound_number IS NOT NULL;',
      ],
      [
        'llamadas por cuenta y fecha',
        'CREATE INDEX IF NOT EXISTS idx_booking_calls_account_created ON booking_calls (account_id, created_at);',
      ],
      [
        'llamadas por cita',
        'CREATE INDEX IF NOT EXISTS idx_booking_calls_appointment ON booking_calls (appointment_id);',
      ],
      [
        'llamadas por contacto (parcial: la FK es anulable)',
        'CREATE INDEX IF NOT EXISTS idx_booking_calls_contact ON booking_calls (contact_id) WHERE contact_id IS NOT NULL;',
      ],
      [
        'un intento del robot por cita (único parcial)',
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_calls_robot_attempt ON booking_calls (appointment_id, attempt) WHERE direction = 'outbound' AND channel = 'robot';",
      ],
      [
        'seguimientos pendientes por fecha (parcial)',
        "CREATE INDEX IF NOT EXISTS idx_clinic_followups_due ON clinic_followups (due_at) WHERE status = 'pending';",
      ],
      [
        'seguimientos por cuenta, estado y fecha',
        'CREATE INDEX IF NOT EXISTS idx_clinic_followups_account_status_due ON clinic_followups (account_id, status, due_at);',
      ],
      [
        'seguimientos por contacto (parcial)',
        'CREATE INDEX IF NOT EXISTS idx_clinic_followups_contact ON clinic_followups (contact_id) WHERE contact_id IS NOT NULL;',
      ],
      [
        'calificaciones por cuenta y fecha',
        'CREATE INDEX IF NOT EXISTS idx_clinic_ratings_account_created ON clinic_ratings (account_id, created_at);',
      ],
      [
        'calificaciones por contacto (parcial)',
        'CREATE INDEX IF NOT EXISTS idx_clinic_ratings_contact ON clinic_ratings (contact_id, created_at) WHERE contact_id IS NOT NULL;',
      ],
      [
        'calificaciones por cita (parcial)',
        'CREATE INDEX IF NOT EXISTS idx_clinic_ratings_appointment ON clinic_ratings (appointment_id) WHERE appointment_id IS NOT NULL;',
      ],
      [
        'calificaciones por sede (parcial)',
        'CREATE INDEX IF NOT EXISTS idx_clinic_ratings_location ON clinic_ratings (location_id) WHERE location_id IS NOT NULL;',
      ],
    ])('%s', (_name, ddl) => {
      expect(flat).toContain(ddl)
    })

    it('un seguimiento por (cita, tipo) y una calificación por seguimiento', () => {
      expect(tableBlock('clinic_followups')).toContain('UNIQUE (appointment_id, kind)')
      expect(tableBlock('clinic_ratings')).toContain(
        'CONSTRAINT clinic_ratings_followup_unique UNIQUE (followup_id)',
      )
    })

    it('clinic_day_closes: un aviso por cuenta y día (clave primaria)', () => {
      expect(tableBlock('clinic_day_closes')).toContain('PRIMARY KEY (account_id, date_key)')
    })
  })

  describe('valores y largos', () => {
    const E164 = String.raw`'^\+[1-9][0-9]{6,14}$'`

    it('conexión con Google: estados, proveedor y token acotados', () => {
      const t = tableBlock('agenda_calendar_connections')
      expect(t).toContain("provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google'))")
      expect(t).toContain("status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked'))")
      expect(t).toContain('refresh_token_encrypted text NOT NULL CHECK (char_length(refresh_token_encrypted) BETWEEN 1 AND 4000)')
      expect(t).toContain('last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300)')
      expect(t).toContain('account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE')
    })

    it('configuración de llamadas: apagada por defecto, E.164 y límites', () => {
      const t = tableBlock('booking_call_settings')
      expect(t).toContain('outbound_enabled boolean NOT NULL DEFAULT false')
      expect(t).toContain('inbound_enabled boolean NOT NULL DEFAULT false')
      expect(t).toContain(`inbound_number text CHECK (inbound_number IS NULL OR inbound_number ~ ${E164})`)
      expect(t).toContain(`caller_id text CHECK (caller_id IS NULL OR caller_id ~ ${E164})`)
      expect(t).toContain("advisor_phones text[] NOT NULL DEFAULT '{}'")
      expect(t).toContain('array_position(advisor_phones, NULL::text) IS NULL')
      expect(t).toContain('{0,2}')
      expect(t).toContain("jsonb_typeof(office_hours) = 'object'")
      expect(t).toContain('info_text text CHECK (info_text IS NULL OR char_length(info_text) <= 500)')
      expect(t).toContain('call_after_minutes integer NOT NULL DEFAULT 180')
      expect(t).toContain('min_lead_minutes integer NOT NULL DEFAULT 120')
      expect(t).toContain('max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3)')
      expect(t).toContain('retry_minutes integer NOT NULL DEFAULT 90')
      expect(t).toContain("window_start text NOT NULL DEFAULT '08:00'")
      expect(t).toContain("window_end text NOT NULL DEFAULT '19:00'")
      expect(t).toContain('call_saturday boolean NOT NULL DEFAULT true')
      expect(t).toContain('monthly_limit integer NOT NULL DEFAULT 300')
      expect(t).toContain('CHECK (window_end > window_start)')
    })

    it('llamadas: dirección, canal, estados y resultados de la lista del diseño', () => {
      const t = tableBlock('booking_calls')
      expect(t).toContain("direction text NOT NULL CHECK (direction IN ('outbound', 'inbound'))")
      expect(t).toContain("channel text NOT NULL CHECK (channel IN ('robot', 'manual'))")
      expect(t).toContain(
        "status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'calling', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled'))",
      )
      for (const outcome of [
        'confirmed',
        'cancelled',
        'human',
        'no_response',
        'wrong_number',
        'booking_link_sent',
        'advisor_connected',
        'advisor_missed',
        'out_of_hours',
        'info',
        'urgency',
      ]) {
        expect(t, outcome).toContain(`'${outcome}'`)
      }
      expect(t).toContain('attempt integer CHECK (attempt IS NULL OR attempt BETWEEN 1 AND 3)')
      expect(t).toContain('menu_path text CHECK (menu_path IS NULL OR char_length(menu_path) <= 60)')
      expect(t).toContain('digits text CHECK (digits IS NULL OR char_length(digits) <= 10)')
      expect(t).toContain('error text CHECK (error IS NULL OR char_length(error) <= 300)')
      expect(t).toContain('created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL')
    })

    it('seguimientos: tipos, estados, intentos de 0 a 5 y respuestas', () => {
      const t = tableBlock('clinic_followups')
      expect(t).toContain("kind text NOT NULL CHECK (kind IN ('cuidados', 'como_sigues', 'calificacion'))")
      expect(t).toContain(
        "status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed'))",
      )
      expect(t).toContain('attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)')
      expect(t).toContain('skip_reason text CHECK (skip_reason IS NULL OR char_length(skip_reason) <= 60)')
      expect(t).toContain("response text CHECK (response IS NULL OR response IN ('bien', 'molestias', 'ayuda'))")
    })

    it('calificaciones y cierres: valores y formato de la fecha', () => {
      expect(tableBlock('clinic_ratings')).toContain(
        "value text NOT NULL CHECK (value IN ('bien', 'regular', 'mal'))",
      )
      expect(tableBlock('clinic_day_closes')).toContain(
        String.raw`date_key text NOT NULL CHECK (date_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')`,
      )
    })
  })
})
