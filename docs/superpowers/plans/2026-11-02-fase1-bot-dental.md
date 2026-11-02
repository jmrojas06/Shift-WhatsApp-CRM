# Fase 1 del módulo clínica: bot dental. Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una clínica con la Agenda de Shift atienda por WhatsApp del primer mensaje a la cita y sus recordatorios: autorización de datos, varios pacientes por número, urgencias, citas lejanas y recordatorios sin procedimiento.

**Architecture:** El bot sigue siendo el de la Agenda, con un solo controlador. Las escrituras y la disponibilidad pasan a una interfaz `ClinicBackend` (hoy solo `InternalBackend`, que envuelve lo que ya existe). Los pasos nuevos viven en `agent/steps/clinic-steps.ts` y se prenden con el módulo `clinica` de la cuenta: sin ese módulo, el bot se comporta igual que hoy.

**Tech Stack:** Next.js 16, TypeScript, Supabase (Postgres + RLS), WhatsApp Cloud API, Vitest.

**Diseño:** `docs/superpowers/specs/2026-11-02-odontologia-design.md`.

---

## Antes de empezar

- Trabaja en la rama `feat/clinica-odontologia`, en `.claude/worktrees/clinica-odontologia`. Parte de `main` (ac93c35) y ya tiene `node_modules`.
- Línea base en `main`: `npx vitest run` da **2.859 pruebas pasando**. Si no da eso antes de tocar nada, detente.
- `.env.local` de la carpeta principal apunta a **producción**. Ninguna prueba de este plan necesita base real. No corras `npm run dev`, ni `supabase db push`.
- Las migraciones se aplican a mano en el SQL Editor, y **solo con OK explícito del usuario**. La tarea 1 solo crea el archivo.
- **Commits:** cada mensaje termina con la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Los ejemplos la omiten por brevedad.
- `npx vitest run <ruta>` corre un archivo. `npx tsc --noEmit` revisa tipos.

## Cambios frente al diseño

El diseño se ajusta en tres puntos, ya corregidos en la spec:

1. **Candado:** va en `conversations.bot_lock_until`, no en `booking_sessions`. La fila de la conversación siempre existe, y así el candado cubre el primer mensaje, cuando aún no hay sesión.
2. **`move` y `unknown`:** entran en la Fase 4, con el conector. Aquí reprogramar sigue siendo crear + cancelar con su deshacer, que ya está probado.
3. **Texto libre y audio con IA:** van en un plan aparte, después de esta fase.

## Hallazgo que afecta a producción

`sendReminderTemplate` llama a `sendTemplateMessage` solo con `params`, sin payload en los botones. Meta devuelve entonces la etiqueta en `button.payload` (`"Confirmar"`), y `parseReminderId('Confirmar')` da `null`. Por lectura de código, **los toques en un recordatorio enviado como plantilla no hacen nada**. La tarea 6 lo corrige leyendo también las etiquetas, pero conviene arreglarlo antes en su propio PR, porque afecta a los clientes actuales.

## Mapa de archivos

**Crear**

| Archivo | Responsabilidad |
| --- | --- |
| `supabase/migrations/055_clinica_base.sql` | Tablas y columnas de la fase |
| `src/modules/clinica/manifest.ts` | Identidad del módulo, sin menú propio |
| `src/modules/clinica/texts.ts` | Copy del bot clínico y textos por defecto |
| `src/modules/clinica/settings.ts` | Leer la configuración e instalarla |
| `src/modules/clinica/consent.ts` | Leer y registrar autorizaciones |
| `src/modules/clinica/patients.ts` | Pacientes de un contacto y validación del nombre |
| `src/modules/clinica/reminder-info.ts` | Paciente y sede de un recordatorio |
| `src/verticals/agenda/presets/odontologia.ts` | Punto de partida |
| `src/verticals/agenda/agent/backend.ts` | Interfaz `ClinicBackend` |
| `src/verticals/agenda/agent/internal-backend.ts` | Implementación sobre `booking_*` |
| `src/verticals/agenda/agent/steps/clinic-steps.ts` | Pasos del bot clínico |
| `src/verticals/agenda/agent/bot-lock.ts` | Candado por conversación |
| `src/verticals/agenda/agent/testing/clinic-harness.ts` | Utilidades de prueba del flujo |
| `docs/clinica-montaje.md` | Guía de montaje |

**Modificar:** `src/lib/verticals/{types,registry,dispatch}.ts`, `src/lib/whatsapp/meta-api.ts`, `src/verticals/agenda/agent/{controller,db,index,reminders,reminders-send,state}.ts`, `src/verticals/agenda/install.ts`, `src/verticals/agenda/presets/{index,salud}.ts`, `src/verticals/agenda/rls-policies.test.ts`, `supabase/ci/verify-schema.sql`, `docs/agenda-recordatorios.md`.

---

### Task 1: Migración 055

**Files:**
- Create: `supabase/migrations/055_clinica_base.sql`
- Modify: `src/verticals/agenda/rls-policies.test.ts` (al final del archivo)
- Modify: `supabase/ci/verify-schema.sql` (antes de `RAISE NOTICE 'schema verification passed';`)

- [ ] **Step 1: Escribe la prueba que falla**

Agrega al final de `src/verticals/agenda/rls-policies.test.ts`:

```ts
describe('módulo clínica (055)', () => {
  for (const table of ['clinic_settings', 'clinic_locations']) {
    for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
      it(`${table} ${cmd}: solo owner/admin`, () => {
        const found = policiesFor(table, cmd)
        expect(found).toHaveLength(1)
        expect(found[0].body).toContain("'admin'")
        expect(found[0].body).not.toContain("'agent'")
      })
    }

    it(`${table} SELECT: cualquier miembro`, () => {
      const found = policiesFor(table, 'SELECT')
      expect(found.some((p) => /is_account_member\(account_id\)/.test(p.body))).toBe(true)
    })
  }

  it('clinic_patients: agent escribe y nadie borra', () => {
    for (const cmd of ['INSERT', 'UPDATE']) {
      expect(policiesFor('clinic_patients', cmd).some((p) => p.body.includes("'agent'"))).toBe(true)
    }
    expect(policiesFor('clinic_patients', 'DELETE')).toHaveLength(0)
  })

  it('clinic_consents: desde el navegador solo se lee', () => {
    expect(policiesFor('clinic_consents', 'SELECT')).toHaveLength(1)
    for (const cmd of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(policiesFor('clinic_consents', cmd)).toHaveLength(0)
    }
  })

  const code = readFileSync(join(MIGRATIONS_DIR, '055_clinica_base.sql'), 'utf8').replace(
    /--[^\r\n]*/g,
    '',
  )

  it('activa RLS en las cuatro tablas', () => {
    for (const table of ['clinic_settings', 'clinic_locations', 'clinic_patients', 'clinic_consents']) {
      expect(code).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
    }
  })

  it('no es destructiva y lleva lock_timeout', () => {
    expect(code).not.toMatch(/DROP\s+TABLE/i)
    expect(code).not.toMatch(/DROP\s+COLUMN/i)
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(code).not.toMatch(/\bTRUNCATE\b/i)
    expect(code).toMatch(/SET\s+LOCAL\s+lock_timeout/i)
  })
})
```

- [ ] **Step 2: Córrela y verifica que falla**

Run: `npx vitest run src/verticals/agenda/rls-policies.test.ts`
Expected: FAIL con `ENOENT` sobre `055_clinica_base.sql`.

- [ ] **Step 3: Crea la migración**

Crea `supabase/migrations/055_clinica_base.sql`:

```sql
-- ============================================================
-- 055_clinica_base.sql — módulo clínica: pacientes y autorizaciones
-- ============================================================
--
-- Diseño: docs/superpowers/specs/2026-11-02-odontologia-design.md
--
--   1. clinic_settings: autorización, urgencias y días que ofrece el bot.
--   2. clinic_locations: sedes. Con la Agenda de Shift hay una sola fila.
--   3. clinic_patients: un contacto (número) tiene uno o varios pacientes.
--   4. clinic_consents: registro de autorizaciones, solo para agregar.
--   5. booking_appointments: paciente y sede de la cita.
--   6. booking_services: instrucciones previas y cuidados.
--   7. conversations.bot_lock_until: candado por conversación.
--
-- RLS (patrón 017/050): los miembros leen, owner/admin escriben la
-- configuración, un agent o más escribe pacientes y nadie escribe
-- autorizaciones desde el navegador (las escribe el bot con service role).
--
-- Reglas de datos:
--   - Nada cruza cuentas: pacientes y sedes llevan UNIQUE (account_id, id)
--     y las citas las enlazan con FK compuestas. Las demás referencias
--     entre cuentas (contacto del paciente, servicio de urgencias) las
--     cierra la política de escritura, como 054 con orders.deal_id.
--   - Un contacto con paciente NO se puede borrar (clinic_patients.contact_id
--     no tiene cascada: error 23503). Borrar una cuenta sí funciona: sus
--     contactos y sus pacientes se borran en la misma sentencia, y la
--     comprobación NO ACTION corre al final, cuando ya no queda ninguno.
--   - Las autorizaciones sobreviven al contacto: contact_id pasa a NULL y
--     la fila conserva contact_ref (quién autorizó) y text_snapshot (qué
--     texto aceptó). contacts.phone es NOT NULL pero vale '' si el contacto
--     solo tiene identificador de WhatsApp (040): contact_ref guarda el
--     teléfono, o wa_user_id si no hay teléfono.
--   - clinic_consents es de solo agregar: un trigger rechaza UPDATE y
--     DELETE directos (las acciones de FK pasan) y se revoca TRUNCATE.
--
-- REQUIERE Postgres 15 o más: las FK compuestas usan
-- ON DELETE SET NULL (columna). Con una versión menor, ese ALTER falla y,
-- como el script corre en una sola transacción, no queda nada a medias.
--
-- Aplicar ANTES de desplegar el código. Es ADITIVA y NO destructiva: solo
-- crea tablas, columnas, restricciones y políticas. Idempotente: se puede
-- correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de una tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1) clinic_settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- El cuerpo de un mensaje interactivo admite 1024 unidades UTF-16.
  consent_text text NOT NULL CHECK (char_length(consent_text) BETWEEN 1 AND 900 AND consent_text ~ '\S'),
  consent_version integer NOT NULL DEFAULT 1 CHECK (consent_version >= 1),
  -- La clínica declara que obtiene el permiso en recepción (ver spec §6.6).
  reception_consent_declared_at timestamptz,
  urgency_words text[] NOT NULL DEFAULT '{}',
  urgency_alarm_text text NOT NULL CHECK (char_length(urgency_alarm_text) BETWEEN 1 AND 900 AND urgency_alarm_text ~ '\S'),
  -- La política de escritura exige además que sea de la misma cuenta.
  urgency_service_id uuid REFERENCES booking_services(id) ON DELETE SET NULL,
  offer_days integer NOT NULL DEFAULT 30 CHECK (offer_days BETWEEN 1 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2) clinic_locations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_source text,
  external_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND btrim(name) <> ''),
  address text CHECK (address IS NULL OR char_length(address) <= 200),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  notice_phone text CHECK (notice_phone IS NULL OR char_length(notice_phone) <= 30),
  on_call_phone text CHECK (on_call_phone IS NULL OR char_length(on_call_phone) <= 30),
  google_review_url text CHECK (google_review_url IS NULL OR char_length(google_review_url) <= 500),
  chair_count integer CHECK (chair_count IS NULL OR chair_count > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- La fuente y el id externos van juntos o ninguno.
  CHECK ((external_source IS NULL) = (external_id IS NULL)),
  -- Lo necesita la FK compuesta de booking_appointments.
  UNIQUE (account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_locations_account
  ON clinic_locations (account_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_locations_external
  ON clinic_locations (account_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3) clinic_patients
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Sin ON DELETE a propósito (NO ACTION, el valor por defecto): un contacto
  -- con paciente no se borra (error 23503).
  contact_id uuid NOT NULL REFERENCES contacts(id),
  external_source text,
  external_id text,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120 AND btrim(full_name) <> ''),
  intake_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- La fuente y el id externos van juntos o ninguno.
  CHECK ((external_source IS NULL) = (external_id IS NULL)),
  -- Lo necesita la FK compuesta de booking_appointments.
  UNIQUE (account_id, id)
);

-- La FK busca por contact_id al borrar un contacto (no por account_id).
CREATE INDEX IF NOT EXISTS idx_clinic_patients_contact
  ON clinic_patients (contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_patients_external
  ON clinic_patients (account_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4) clinic_consents — solo para agregar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- La autorización sobrevive al contacto: al borrarlo queda en NULL y
  -- contact_ref sigue diciendo quién autorizó.
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Teléfono (o wa_user_id si no hay teléfono) del titular al autorizar.
  contact_ref text NOT NULL CHECK (char_length(contact_ref) BETWEEN 1 AND 64 AND contact_ref ~ '\S'),
  kind text NOT NULL CHECK (kind IN ('datos_sensibles', 'mercadeo')),
  granted boolean NOT NULL,
  text_version integer NOT NULL CHECK (text_version >= 1),
  -- El texto exacto que vio la persona: cambiar clinic_settings.consent_text
  -- no puede borrar qué aceptó cada una.
  text_snapshot text NOT NULL CHECK (char_length(text_snapshot) BETWEEN 1 AND 1000 AND text_snapshot ~ '\S'),
  source text NOT NULL CHECK (source IN ('whatsapp', 'recepcion')),
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_consents_lookup
  ON clinic_consents (account_id, contact_id, kind, created_at DESC);

-- La FK busca por contact_id al borrar un contacto. Parcial: contact_id es
-- anulable y las filas huérfanas no se buscan por contacto.
CREATE INDEX IF NOT EXISTS idx_clinic_consents_contact
  ON clinic_consents (contact_id)
  WHERE contact_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5) y 6) Columnas de citas y servicios
-- ------------------------------------------------------------
-- Sin FK simple: la FK compuesta de abajo obliga a que el paciente y la
-- sede sean de la misma cuenta que la cita.
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS patient_id uuid,
  ADD COLUMN IF NOT EXISTS location_id uuid;

-- MATCH SIMPLE (por defecto): con patient_id NULL no se comprueba nada.
-- ON DELETE SET NULL (columna) solo pone en NULL esa columna y deja intacto
-- account_id, que es NOT NULL. Pide Postgres 15 o más.
ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_patient_fk;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_patient_fk
  FOREIGN KEY (account_id, patient_id)
  REFERENCES clinic_patients (account_id, id)
  ON DELETE SET NULL (patient_id);

ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_location_fk;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_location_fk
  FOREIGN KEY (account_id, location_id)
  REFERENCES clinic_locations (account_id, id)
  ON DELETE SET NULL (location_id);

CREATE INDEX IF NOT EXISTS idx_booking_appointments_patient
  ON booking_appointments (patient_id)
  WHERE patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booking_appointments_location
  ON booking_appointments (location_id)
  WHERE location_id IS NOT NULL;

ALTER TABLE booking_services
  ADD COLUMN IF NOT EXISTS prep_instructions text,
  ADD COLUMN IF NOT EXISTS aftercare_instructions text;

ALTER TABLE booking_services
  DROP CONSTRAINT IF EXISTS booking_services_prep_length_check;
ALTER TABLE booking_services
  ADD CONSTRAINT booking_services_prep_length_check
  CHECK (prep_instructions IS NULL OR char_length(prep_instructions) <= 900);

ALTER TABLE booking_services
  DROP CONSTRAINT IF EXISTS booking_services_aftercare_length_check;
ALTER TABLE booking_services
  ADD CONSTRAINT booking_services_aftercare_length_check
  CHECK (aftercare_instructions IS NULL OR char_length(aftercare_instructions) <= 900);

-- ------------------------------------------------------------
-- 7) Candado por conversación
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_lock_until timestamptz;

-- ------------------------------------------------------------
-- updated_at (helper de 001)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON clinic_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinic_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON clinic_locations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinic_locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON clinic_patients;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinic_patients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- clinic_consents: solo para agregar de verdad
-- ------------------------------------------------------------
-- Sin política UPDATE/DELETE el navegador ya no puede tocarla, pero el
-- bot (service role, que se salta la RLS) sí podría. Este trigger rechaza
-- cualquier UPDATE o DELETE directo, venga de quien venga.
--
-- Las acciones de FK pasan: borrar una cuenta borra sus filas y borrar un
-- contacto pone contact_id en NULL. Postgres las ejecuta dentro de un
-- trigger propio, así que aquí corren a profundidad 2 o más; una edición
-- directa corre a profundidad 1. A profundidad 2 o más el DELETE queda
-- abierto (lo necesita borrar la cuenta), pero un UPDATE solo pasa si
-- únicamente pone contact_id en NULL: no cambia nada más de la fila.
--
-- SECURITY DEFINER + EXECUTE solo para service_role: mismo endurecimiento
-- que log_booking_appointment_event (047, patrón de 044). Al disparar el
-- trigger, Postgres no mira el permiso EXECUTE de quien escribe.
CREATE OR REPLACE FUNCTION clinic_consents_append_only()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW.contact_id IS NULL
       AND to_jsonb(NEW) - 'contact_id' = to_jsonb(OLD) - 'contact_id' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'clinic_consents es de solo agregar: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER FUNCTION public.clinic_consents_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clinic_consents_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clinic_consents_append_only() TO service_role;

DROP TRIGGER IF EXISTS clinic_consents_append_only ON clinic_consents;
CREATE TRIGGER clinic_consents_append_only
  BEFORE UPDATE OR DELETE ON clinic_consents
  FOR EACH ROW EXECUTE FUNCTION clinic_consents_append_only();

-- TRUNCATE no dispara triggers de fila: se le quita a los roles de la API.
REVOKE TRUNCATE ON clinic_consents FROM anon, authenticated, service_role;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_consents ENABLE ROW LEVEL SECURITY;

-- El servicio de urgencias debe ser de la misma cuenta: la FK sola no lo
-- comprueba (mismo criterio que 054 con orders.deal_id).
DROP POLICY IF EXISTS clinic_settings_select ON clinic_settings;
CREATE POLICY clinic_settings_select ON clinic_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_settings_insert ON clinic_settings;
CREATE POLICY clinic_settings_insert ON clinic_settings
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'admin')
    AND (
      urgency_service_id IS NULL
      OR EXISTS (
        SELECT 1 FROM booking_services s
        WHERE s.id = clinic_settings.urgency_service_id
          AND s.account_id = clinic_settings.account_id
      )
    )
  );
DROP POLICY IF EXISTS clinic_settings_update ON clinic_settings;
CREATE POLICY clinic_settings_update ON clinic_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND (
      urgency_service_id IS NULL
      OR EXISTS (
        SELECT 1 FROM booking_services s
        WHERE s.id = clinic_settings.urgency_service_id
          AND s.account_id = clinic_settings.account_id
      )
    )
  );
DROP POLICY IF EXISTS clinic_settings_delete ON clinic_settings;
CREATE POLICY clinic_settings_delete ON clinic_settings
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS clinic_locations_select ON clinic_locations;
CREATE POLICY clinic_locations_select ON clinic_locations
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_locations_insert ON clinic_locations;
CREATE POLICY clinic_locations_insert ON clinic_locations
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_locations_update ON clinic_locations;
CREATE POLICY clinic_locations_update ON clinic_locations
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_locations_delete ON clinic_locations;
CREATE POLICY clinic_locations_delete ON clinic_locations
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- El contacto del paciente debe ser de la misma cuenta: la FK sola no lo
-- comprueba.
DROP POLICY IF EXISTS clinic_patients_select ON clinic_patients;
CREATE POLICY clinic_patients_select ON clinic_patients
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_patients_insert ON clinic_patients;
CREATE POLICY clinic_patients_insert ON clinic_patients
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = clinic_patients.contact_id
        AND c.account_id = clinic_patients.account_id
    )
  );
DROP POLICY IF EXISTS clinic_patients_update ON clinic_patients;
CREATE POLICY clinic_patients_update ON clinic_patients
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = clinic_patients.contact_id
        AND c.account_id = clinic_patients.account_id
    )
  );
-- Sin política DELETE: un paciente con citas es un registro del negocio.

DROP POLICY IF EXISTS clinic_consents_select ON clinic_consents;
CREATE POLICY clinic_consents_select ON clinic_consents
  FOR SELECT USING (is_account_member(account_id));
-- Sin INSERT/UPDATE/DELETE: el registro solo lo escribe el bot (service
-- role) y nadie lo edita desde el navegador.
```

- [ ] **Step 4: Agrega las verificaciones de esquema**

En `supabase/ci/verify-schema.sql`, dentro del bloque `DO`, justo antes de `RAISE NOTICE 'schema verification passed';`:

```sql
  -- 055 instala el módulo clínica.
  IF to_regclass('public.clinic_settings') IS NULL
     OR to_regclass('public.clinic_locations') IS NULL
     OR to_regclass('public.clinic_patients') IS NULL
     OR to_regclass('public.clinic_consents') IS NULL THEN
    RAISE EXCEPTION 'clinic_* tables are missing — migration 055 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'conversations'
      AND column_name = 'bot_lock_until'
  ) THEN
    RAISE EXCEPTION 'conversations.bot_lock_until is missing — migration 055 did not apply';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'booking_appointments'
      AND column_name = 'patient_id'
  ) THEN
    RAISE EXCEPTION 'booking_appointments.patient_id is missing — migration 055 did not apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'clinic_consents'
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'clinic_consents must be read-only for clients — migration 055 did not apply';
  END IF;
```

- [ ] **Step 5: Corre la prueba**

Run: `npx vitest run src/verticals/agenda/rls-policies.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/055_clinica_base.sql supabase/ci/verify-schema.sql src/verticals/agenda/rls-policies.test.ts
git commit -m "feat(clinica): add the base schema for clinics"
```

**Ajustes de la revisión de calidad (antes de aplicar la 055).** El SQL de arriba ya es el definitivo. Frente al primer borrador:

- Las autorizaciones sobreviven al contacto: `clinic_consents.contact_id` es anulable (`ON DELETE SET NULL`) y la fila guarda `contact_ref` (teléfono del titular, o `wa_user_id` si el contacto no tiene teléfono) y `text_snapshot` (el texto que aceptó). Las tareas 7 y 14 escriben ambos campos.
- Un contacto con paciente no se puede borrar: `clinic_patients.contact_id` no tiene cascada (`NO ACTION`, error `23503`). La pantalla de Contactos lo avisa.
- Nada cruza cuentas: `UNIQUE (account_id, id)` en pacientes y sedes, FK compuestas en las citas (piden **Postgres 15 o más**) y políticas de escritura que comprueban el contacto del paciente y el servicio de urgencias.
- `clinic_consents` es de solo agregar de verdad: trigger `BEFORE UPDATE OR DELETE` (deja pasar las acciones de FK: el DELETE de la cascada de la cuenta y el UPDATE que solo pone `contact_id` en NULL) y `TRUNCATE` revocado.
- `consent_text`, `urgency_alarm_text`, `contact_ref` y `text_snapshot` no admiten textos en blanco (`~ '\S'`).
- La prueba de políticas y `verify-schema.sql` quedaron más estrictos que los pasos 1 y 4: los archivos del repositorio son la versión vigente.

---

### Task 2: Módulo `clinica`

**Files:**
- Create: `src/modules/clinica/manifest.ts`, `src/modules/clinica/manifest.test.ts`
- Modify: `src/lib/verticals/types.ts`, `src/lib/verticals/registry.ts`, `src/lib/verticals/dispatch.ts`, `src/lib/verticals/dispatch.test.ts`, `src/verticals/agenda/agent/index.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/modules/clinica/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { getAccountModules, getModulesNav, hasModule } from '@/lib/verticals/registry'

describe('módulo clínica', () => {
  it('convive con la agenda, en orden estable', () => {
    expect(getAccountModules({ modules: ['clinica', 'agenda'] })).toEqual(['agenda', 'clinica'])
    expect(hasModule({ modules: ['agenda', 'clinica'] }, 'clinica')).toBe(true)
  })

  it('no agrega una entrada al menú', () => {
    expect(getModulesNav({ modules: ['clinica'] })).toEqual([])
  })
})
```

Agrega en `src/lib/verticals/dispatch.test.ts`, dentro de `describe('dispatchInboundToVertical', ...)`:

```ts
  it('le pasa al handler los módulos de la cuenta', async () => {
    dbState.responses = {
      accounts: { data: { modules: ['agenda', 'clinica'] }, error: null },
      conversations: openConversation,
    }
    await dispatchInboundToVertical(baseArgs)
    expect(dbState.handlerCalls[0].modules).toEqual(['agenda', 'clinica'])
  })
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/modules/clinica/manifest.test.ts src/lib/verticals/dispatch.test.ts`
Expected: FAIL. `getAccountModules` descarta `clinica`, y `modules` llega `undefined` al handler.

- [ ] **Step 3: Implementa**

Crea `src/modules/clinica/manifest.ts`:

```ts
import type { VerticalManifest } from '@/lib/verticals/types'

/**
 * Clínica — capa sobre la Agenda para clínicas odontológicas: pacientes,
 * autorización de datos, urgencias y recordatorios sin procedimiento.
 *
 * Sin bot propio ni menú: el bot sigue siendo el de la Agenda y este
 * módulo prende sus pasos clínicos.
 */
export const clinicaManifest: VerticalManifest = {
  key: 'clinica',
  name: 'Clínica',
  description: 'Pacientes, autorización de datos y urgencias sobre la agenda.',
}
```

En `src/lib/verticals/types.ts`:

```ts
export type ModuleKey = 'agenda' | 'ventas' | 'clinica'
```

Y en `VerticalInboundContext`, después de `humanOwned?: boolean`:

```ts
  /** Módulos activos de la cuenta (`getAccountModules`). */
  modules?: readonly ModuleKey[]
```

En `src/lib/verticals/registry.ts`:

```ts
import { clinicaManifest } from '@/modules/clinica/manifest'
```

```ts
const MANIFESTS: Readonly<Record<ModuleKey, VerticalManifest>> = {
  agenda: agendaManifest,
  ventas: ventasManifest,
  clinica: clinicaManifest,
}

/** Orden estable de los módulos (menú y listados). */
const MODULE_ORDER: readonly ModuleKey[] = ['agenda', 'ventas', 'clinica']
```

En `src/lib/verticals/dispatch.ts`, reemplaza:

```ts
    const botModules = getAccountModules(account).filter(
      (key) => VERTICAL_HANDLERS[key],
    )
```

por:

```ts
    const modules = getAccountModules(account)
    const botModules = modules.filter((key) => VERTICAL_HANDLERS[key])
```

Y en la llamada al handler, después de `humanOwned,`:

```ts
        modules,
```

En `src/verticals/agenda/agent/index.ts`, dentro de `handleAgendaInbound({...})`, después de `humanOwned: ctx.humanOwned ?? false,`:

```ts
    modules: ctx.modules,
```

En `src/verticals/agenda/agent/controller.ts`, en `HandleAgendaInboundArgs`:

```ts
  /** Módulos de la cuenta. Con 'clinica' se prenden los pasos clínicos. */
  modules?: readonly ModuleKey[]
```

Y cambia el import de tipos:

```ts
import type { ModuleKey, VerticalDispatchResult, VerticalSession } from '@/lib/verticals/types'
```

- [ ] **Step 4: Corre las pruebas y los tipos**

Run: `npx vitest run src/modules src/lib/verticals && npx tsc --noEmit`
Expected: PASS, sin errores de tipos.

- [ ] **Step 5: Commit**

```bash
git add src/modules/clinica src/lib/verticals src/verticals/agenda/agent/index.ts src/verticals/agenda/agent/controller.ts
git commit -m "feat(clinica): register the clinic module"
```

---

### Task 3: Punto de partida `odontologia`

**Files:**
- Create: `src/verticals/agenda/presets/odontologia.ts`
- Modify: `src/verticals/agenda/presets/index.ts`, `src/verticals/agenda/presets/salud.ts`, `src/verticals/agenda/presets/presets.test.ts`

- [ ] **Step 1: Escribe la prueba que falla**

Agrega en `src/verticals/agenda/presets/presets.test.ts`, dentro de `describe('puntos de partida', ...)`:

```ts
  it('odontología esconde precios y trae una atención de urgencia sin preguntas extra', () => {
    const preset = AGENDA_PRESETS.odontologia
    expect(preset.toggles.showPrice).toBe(false)
    expect(preset.toggles.showDuration).toBe(false)
    expect(preset.questions).toEqual([])
    expect(preset.seed.services.map((s) => s.name)).toContain('Urgencia')
    expect(preset.seed.services.every((s) => s.price === 0)).toBe(true)
    expect(preset.aiPrompt).toContain('Nunca des diagnósticos')
  })
```

- [ ] **Step 2: Córrela y verifica que falla**

Run: `npx vitest run src/verticals/agenda/presets/presets.test.ts`
Expected: FAIL, `preset` indefinido.

- [ ] **Step 3: Implementa**

Crea `src/verticals/agenda/presets/odontologia.ts`:

```ts
// ============================================================
// Punto de partida: Clínica odontológica. Duraciones y horario de
// ejemplo: Shift los ajusta con la clínica en el montaje. Sin precios:
// el valor de un tratamiento depende de la valoración.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'doctor(a)',
  profesionales: 'doctores',
  servicio: 'atención',
  servicios: 'atenciones',
  cita: 'cita',
  citas: 'citas',
}

export const ODONTOLOGIA_PRESET: AgendaPreset = {
  key: 'odontologia',
  name: 'Clínica odontológica',
  description: 'Consultorios y clínicas dentales.',
  labels,
  toggles: { ...DEFAULT_TOGGLES, showPrice: false, showDuration: false },
  welcome: '¡Hola! 👋 Soy el asistente de la clínica. ¿Qué atención necesitas?',
  aiPrompt: [
    genericAiPrompt(labels),
    '',
    'Reglas de salud (no se pueden romper):',
    '- Nunca des diagnósticos ni digas qué tratamiento necesita alguien.',
    '- Nunca recomiendes medicamentos ni dosis.',
    '- Si alguien describe dolor fuerte, sangrado, hinchazón o un golpe, dile que escriba "urgencia".',
    '- Para agendar, dile que escriba "cita".',
  ].join('\n'),
  seed: {
    services: [
      { name: 'Valoración', description: 'Primera revisión.', durationMinutes: 30, price: 0, position: 0 },
      { name: 'Limpieza', description: 'Profilaxis.', durationMinutes: 45, price: 0, position: 1 },
      { name: 'Control', description: 'Seguimiento de tratamiento.', durationMinutes: 20, price: 0, position: 2 },
      { name: 'Control de ortodoncia', description: 'Control mensual.', durationMinutes: 20, price: 0, position: 3 },
      { name: 'Urgencia', description: 'Atención prioritaria.', durationMinutes: 30, price: 0, position: 4 },
    ],
    staff: [{ name: 'Doctor(a) 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5], [['08:00', '12:00'], ['14:00', '18:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [],
}
```

En `src/verticals/agenda/presets/index.ts`:

```ts
import { ODONTOLOGIA_PRESET } from './odontologia'
```

```ts
export const PRESET_KEYS = ['barberia', 'salon', 'salud', 'odontologia', 'taller', 'clases', 'blanco'] as const
```

Y agrega a `AGENDA_PRESETS`, después de `salud: SALUD_PRESET,`:

```ts
  odontologia: ODONTOLOGIA_PRESET,
```

En `src/verticals/agenda/presets/salud.ts`:

```ts
  description: 'Fisioterapia, psicología, estética, medicina general.',
```

- [ ] **Step 4: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS. Si alguna prueba de `install.test.ts` o del panel cuenta los puntos de partida, ajústala de 6 a 7.

- [ ] **Step 5: Commit**

```bash
git add src/verticals/agenda/presets
git commit -m "feat(agenda): add the dental clinic starting point"
```

---

### Task 4: Extraer `ClinicBackend` sin cambiar conducta

Esta tarea es un refactor. **Ninguna prueba existente de `src/verticals/agenda` se modifica.** Si alguna falla, el refactor está mal.

**Files:**
- Create: `src/verticals/agenda/agent/backend.ts`, `src/verticals/agenda/agent/internal-backend.ts`, `src/verticals/agenda/agent/internal-backend.test.ts`
- Modify: `src/verticals/agenda/agent/controller.ts`, `src/verticals/agenda/agent/db.ts`

- [ ] **Step 1: Escribe la prueba que falla**

Crea `src/verticals/agenda/agent/internal-backend.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { ServiceInfo } from './db'
import { createInternalBackend } from './internal-backend'
import { asClient, makeFakeDb } from './testing/fake-db'

const ACCOUNT = 'acc-1'
const STAFF = 'st-1'
/** Lunes 19 de octubre de 2026, 08:00 en Bogotá. */
const NOW = new Date('2026-10-19T13:00:00Z')
const service: ServiceInfo = {
  id: 'svc-1',
  name: 'Limpieza',
  description: null,
  durationMinutes: 30,
  price: 0,
}

const seed = () =>
  makeFakeDb({
    booking_working_hours: [
      { account_id: ACCOUNT, staff_id: STAFF, weekday: 1, start_time: '09:00:00', end_time: '10:00:00' },
    ],
    booking_appointments: [],
    booking_time_off: [],
  })

const bookArgs = {
  id: 'ap-1',
  contactId: 'ct-1',
  conversationId: 'cv-1',
  serviceId: 'svc-1',
  staffId: STAFF,
  startsAtIso: '2026-10-19T14:00:00.000Z',
  endsAtIso: '2026-10-19T14:30:00.000Z',
  confirmedAtIso: NOW.toISOString(),
}

describe('InternalBackend', () => {
  it('devuelve las horas del día y descuenta las ocupadas', async () => {
    const db = seed()
    db._tables.booking_appointments.push({
      account_id: ACCOUNT,
      staff_id: STAFF,
      status: 'confirmed',
      starts_at: '2026-10-19T14:00:00.000Z',
      ends_at: '2026-10-19T14:30:00.000Z',
    })
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })
    const slots = await backend.getDaySlots({
      service,
      staffIds: [STAFF],
      dateKey: '2026-10-19',
      now: NOW,
    })
    expect(slots.map((s) => s.label)).toEqual(['9:30 a. m.'])
  })

  it('getDaysWithSlots solo trae días con cupo', async () => {
    const backend = createInternalBackend({ db: asClient(seed()), accountId: ACCOUNT })
    const keys = await backend.getDaysWithSlots({
      service,
      staffIds: [STAFF],
      fromKey: '2026-10-19',
      days: 8,
      now: NOW,
    })
    expect(keys).toEqual(['2026-10-19', '2026-10-26'])
  })

  it('book distingue un choque de otro error', async () => {
    const db = seed()
    const backend = createInternalBackend({ db: asClient(db), accountId: ACCOUNT })

    db._failNext('insert', 'booking_appointments', { code: '23P01', message: 'overlap' })
    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'slot_taken' })

    db._failNext('insert', 'booking_appointments', { code: 'XX000', message: 'caída' })
    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'failed', message: 'caída' })

    await expect(backend.book(bookArgs)).resolves.toEqual({ kind: 'ok' })
    expect(db._tables.booking_appointments).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Córrela y verifica que falla**

Run: `npx vitest run src/verticals/agenda/agent/internal-backend.test.ts`
Expected: FAIL, no existe `./internal-backend`.

- [ ] **Step 3: Crea la interfaz**

Crea `src/verticals/agenda/agent/backend.ts`:

```ts
// ============================================================
// Interfaz entre el bot y la agenda de la clínica.
//
// El bot no sabe dónde viven las citas: la Agenda de Shift es una
// implementación (internal-backend.ts) y el software de la clínica será
// otra (Fase 4). El catálogo que ve el paciente sigue siendo local en
// ambos casos, así que aquí solo está lo que cambia según quién manda.
// ============================================================

import type { AnswerMap } from '../questions'
import type { MergedSlot } from './availability'
import type { ServiceInfo } from './db'

export interface SlotQuery {
  service: ServiceInfo
  /** Candidatos ya resueltos: el elegido o todos los que atienden el servicio. */
  staffIds: string[]
  /** Día local 'YYYY-MM-DD'. */
  dateKey: string
  now: Date
}

export interface DayRangeQuery {
  service: ServiceInfo
  staffIds: string[]
  fromKey: string
  days: number
  now: Date
}

export interface BookArgs {
  id: string
  contactId: string
  conversationId: string
  serviceId: string
  staffId: string
  startsAtIso: string
  endsAtIso: string
  confirmedAtIso: string
  rescheduledFrom?: string | null
  answers?: AnswerMap
}

export type BookResult =
  | { kind: 'ok' }
  /** Alguien ganó la hora: se ofrecen otras. */
  | { kind: 'slot_taken' }
  /** La cita NO quedó creada. */
  | { kind: 'failed'; message: string }

export interface ClinicBackend {
  getDaySlots(query: SlotQuery): Promise<MergedSlot[]>
  /** Días del rango con al menos una hora ofrecible, en orden. */
  getDaysWithSlots(query: DayRangeQuery): Promise<string[]>
  isStaffFree(args: { staffId: string; startIso: string; endIso: string }): Promise<boolean>
  book(args: BookArgs): Promise<BookResult>
  /** Lanza si no se pudo: el bot no puede decir "cancelada" si sigue viva. */
  cancel(args: { id: string; reason: string; cancelledAtIso: string }): Promise<void>
  /** Lanza si no se pudo. */
  confirm(args: { id: string; confirmedAtIso: string }): Promise<void>
}
```

- [ ] **Step 4: Crea `InternalBackend`**

Crea `src/verticals/agenda/agent/internal-backend.ts`:

```ts
// ============================================================
// ClinicBackend sobre las tablas booking_*: la Agenda de Shift.
//
// Es el camino de todo negocio con agenda propia, barberías incluidas.
// Solo mueve aquí lo que antes vivía en el controlador, sin cambiar
// conducta: controller.test.ts es la garantía.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { computeDaySlots, mergeSlotsByStart, type MergedSlot } from './availability'
import type { ClinicBackend, DayRangeQuery, SlotQuery } from './backend'
import {
  cancelAppointment,
  insertAppointment,
  isStaffFree,
  listBusy,
  listWorkBlocks,
  markAppointmentConfirmed,
  type BusyRow,
  type WorkBlockRow,
} from './db'
import { addDaysToKey, startOfZonedDay } from './time'

interface DayData {
  blocks: WorkBlockRow[]
  busy: BusyRow[]
}

export function createInternalBackend(args: {
  db: SupabaseClient
  accountId: string
}): ClinicBackend {
  const { db, accountId } = args

  async function loadRange(staffIds: string[], fromKey: string, days: number): Promise<DayData> {
    const fromIso = startOfZonedDay(fromKey).toISOString()
    const toIso = startOfZonedDay(addDaysToKey(fromKey, days)).toISOString()
    const [blocks, busy] = await Promise.all([
      listWorkBlocks(db, accountId, staffIds),
      listBusy(db, accountId, staffIds, fromIso, toIso),
    ])
    return { blocks, busy }
  }

  function slotsForDay(
    query: Pick<SlotQuery, 'service' | 'staffIds' | 'now'>,
    data: DayData,
    dateKey: string,
  ): MergedSlot[] {
    const sets = query.staffIds.map((staffId) => ({
      staffId,
      slots: computeDaySlots({
        dateKey,
        durationMinutes: query.service.durationMinutes,
        workBlocks: data.blocks.filter((b) => b.staffId === staffId),
        busy: data.busy.filter((b) => b.staffId === staffId),
        now: query.now,
      }),
    }))
    return mergeSlotsByStart(sets)
  }

  return {
    async getDaySlots(query: SlotQuery) {
      const data = await loadRange(query.staffIds, query.dateKey, 1)
      return slotsForDay(query, data, query.dateKey)
    },

    async getDaysWithSlots(query: DayRangeQuery) {
      const data = await loadRange(query.staffIds, query.fromKey, query.days)
      const keys: string[] = []
      for (let i = 0; i < query.days; i += 1) {
        const key = addDaysToKey(query.fromKey, i)
        if (slotsForDay(query, data, key).length) keys.push(key)
      }
      return keys
    },

    isStaffFree: ({ staffId, startIso, endIso }) =>
      isStaffFree(db, accountId, staffId, startIso, endIso),

    async book(book) {
      const { error } = await insertAppointment(db, {
        ...book,
        accountId,
        status: 'confirmed',
        createdVia: 'bot',
      })
      if (!error) return { kind: 'ok' }
      if (error.code === '23P01') return { kind: 'slot_taken' }
      return { kind: 'failed', message: error.message ?? 'error desconocido' }
    },

    cancel: (cancel) => cancelAppointment(db, { accountId, ...cancel }),

    confirm: (confirm) => markAppointmentConfirmed(db, { accountId, ...confirm }),
  }
}
```

- [ ] **Step 5: Pasa el controlador a la interfaz**

En `src/verticals/agenda/agent/controller.ts`:

1. Reemplaza los imports de disponibilidad por:

```ts
import type { MergedSlot } from './availability'
import type { ClinicBackend } from './backend'
import { createInternalBackend } from './internal-backend'
```

2. Del import de `./db` quita `cancelAppointment`, `insertAppointment`, `isStaffFree`, `listBusy`, `listWorkBlocks`, `markAppointmentConfirmed`, `type BusyRow` y `type WorkBlockRow`. Del import de `./time` quita `startOfZonedDay`.

3. En `HandleAgendaInboundArgs` agrega:

```ts
  /** Dónde viven las citas. Por defecto, la Agenda de Shift. */
  backend?: ClinicBackend
```

4. En `Dialog` agrega `backend: ClinicBackend`, y en el objeto `dialog` de `handleAgendaInbound`:

```ts
    backend: args.backend ?? createInternalBackend({ db: args.db, accountId: args.accountId }),
```

5. Reemplaza toda la sección `// Disponibilidad`, desde `interface AvailabilityCtx` hasta el final de `dayOptions`, por:

```ts
/** Servicio y candidatos de la sesión; null si ya no hay a quién ofrecer. */
async function slotScope(
  dialog: Dialog,
  state: BookingState,
): Promise<{ service: ServiceInfo; staffIds: string[] } | null> {
  const service = await findService(dialog, state.serviceId)
  if (!service) return null
  const staff: Pick<StaffInfo, 'id'>[] =
    state.staffId && state.staffId !== 'any'
      ? [{ id: state.staffId }]
      : await listEligibleStaff(dialog.db, dialog.accountId, service.id)
  return staff.length ? { service, staffIds: staff.map((s) => s.id) } : null
}

async function mergedSlotsForDay(
  dialog: Dialog,
  state: BookingState,
  dateKey: string,
): Promise<MergedSlot[]> {
  const scope = await slotScope(dialog, state)
  if (!scope) return []
  return dialog.backend.getDaySlots({ ...scope, dateKey, now: dialog.now })
}

/** Próximos días (hasta 7) que tienen al menos una hora ofrecible. */
async function dayOptions(
  dialog: Dialog,
  state: BookingState,
): Promise<{ key: string; label: string }[]> {
  const scope = await slotScope(dialog, state)
  if (!scope) return []
  const todayKey = zonedDateKey(dialog.now)
  const tomorrowKey = addDaysToKey(todayKey, 1)
  const keys = await dialog.backend.getDaysWithSlots({
    ...scope,
    fromKey: todayKey,
    days: OFFER_DAYS,
    now: dialog.now,
  })
  return keys.map((key) => ({
    key,
    label:
      key === todayKey
        ? dialog.texts.dayToday
        : key === tomorrowKey
          ? dialog.texts.dayTomorrow
          : formatDayLabel(key),
  }))
}
```

6. En `handleReminderTap`, reemplaza `await markAppointmentConfirmed(dialog.db, {...})` por:

```ts
      await dialog.backend.confirm({ id: appt.id, confirmedAtIso: dialog.nowIso })
```

7. En el caso `manage_cancel_confirm` de `handleChoice`, reemplaza `await cancelAppointment(dialog.db, {...})` por:

```ts
          await dialog.backend.cancel({
            id: appt.id,
            reason: 'cliente',
            cancelledAtIso: dialog.nowIso,
          })
```

8. En `confirmAppointment`, reemplaza la comprobación del candidato:

```ts
    const free = await dialog.backend.isStaffFree({
      staffId: candidate,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    })
```

9. En `confirmAppointment`, reemplaza desde `const { error } = await insertAppointment(...)` hasta el cierre del `if (error)` por:

```ts
  const booked = await dialog.backend.book({
    id: appointmentId,
    contactId: dialog.contactId,
    conversationId: dialog.conversationId,
    serviceId: service.id,
    staffId: assigned,
    startsAtIso: start.toISOString(),
    endsAtIso: end.toISOString(),
    confirmedAtIso: dialog.nowIso,
    rescheduledFrom: oldAppt?.id ?? null,
    answers,
  })

  if (booked.kind !== 'ok') {
    // La cita no existe: la sesión vuelve a estar activa para que el
    // cliente pueda elegir otra hora o reintentar.
    await releaseSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      updatedAtIso: dialog.nowIso,
    })
    if (booked.kind === 'slot_taken') {
      // Choque con el EXCLUDE anti-doble-reserva: alguien ganó la carrera.
      await offerAlternatives(dialog, sessionId, state)
      return
    }
    await dialog.sender.sendText({
      text: dialog.texts.confirmError,
    })
    await conclude(dialog, sessionId, state)
    return
  }
```

10. En el bloque de reprogramación de `confirmAppointment`, reemplaza las dos llamadas a `cancelAppointment(dialog.db, {...})`:

```ts
      await dialog.backend.cancel({
        id: oldAppt.id,
        reason: 'reprogramada',
        cancelledAtIso: dialog.nowIso,
      })
```

```ts
        await dialog.backend.cancel({
          id: appointmentId,
          reason: 'error_reprogramacion',
          cancelledAtIso: dialog.nowIso,
        })
```

- [ ] **Step 6: Corre todo**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS, con todas las pruebas del controlador y de recordatorios sin modificar.

- [ ] **Step 7: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "refactor(agenda): route availability and bookings through ClinicBackend"
```

---

### Task 5: Textos y configuración de la clínica

**Files:**
- Create: `src/modules/clinica/texts.ts`, `src/modules/clinica/texts.test.ts`, `src/modules/clinica/settings.ts`, `src/modules/clinica/settings.test.ts`
- Modify: `src/verticals/agenda/install.ts`, `src/verticals/agenda/install.test.ts`, `src/verticals/agenda/agent/testing/fake-db.ts`
- Create: `src/verticals/agenda/agent/testing/fake-db.test.ts`

Dos reglas de esta tarea, ya corregidas tras la revisión:

- **Fallar cerrado.** `loadClinicContext` devuelve `{ status: 'ok' | 'missing' | 'error' }` y no un `null`. Si solo devolviera `null`, una lectura caída se confundiría con "esta cuenta no tiene configuración" y el bot seguiría como una agenda normal: no pediría la autorización de datos y la IA vería el chat de un paciente. Quien la llame (Task 7) decide qué hace en cada caso, y ante `error` no puede tratar la conversación como una agenda normal.
- **Sin carreras.** La fila de `clinic_settings` se crea con `upsert` + `ignoreDuplicates` (`ON CONFLICT DO NOTHING`): si otro montaje la creó justo antes, esa gana y no se pisa.

- [ ] **Step 1: Enseña `ignoreDuplicates` y el `onConflict` compuesto al fake**

En `src/verticals/agenda/agent/testing/fake-db.ts`, la prueba de la carrera necesita `ignoreDuplicates`, y un `onConflict: 'a,b'` debe comparar cada columna (comparar `r['a,b']` daba `undefined === undefined` y cualquier fila contaba como conflicto). Declara la bandera junto a `conflictKey`:

```ts
    let conflictKey: string | null = null
    let ignoreDuplicates = false
    let limitN: number | null = null
```

Reemplaza el bloque `if (op === 'upsert')` por:

```ts
      if (op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload ?? {}]
        const out = rows.flatMap((row) => {
          const incoming = row as Row
          // `onConflict` puede ser una lista ("account_id,kind"): choca la fila
          // que coincide en TODAS las columnas.
          const keys = conflictKey ? conflictKey.split(',').map((c) => c.trim()) : null
          const existing = keys
            ? ensure(table).find((r) => keys.every((c) => r[c] === incoming[c]))
            : undefined
          if (existing) {
            // ON CONFLICT DO NOTHING: la fila que ya estaba no se toca ni se devuelve.
            if (ignoreDuplicates) return []
            Object.assign(existing, incoming)
            return [{ ...existing }]
          }
          return [insertRow(incoming)]
        })
        return { data: wantRows ? out : null, error: null }
      }
```

Y el método `upsert` del objeto `api` por:

```ts
      upsert: (p: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        op = 'upsert'
        payload = p
        conflictKey = options?.onConflict ?? null
        ignoreDuplicates = options?.ignoreDuplicates === true
        return api
      },
```

Y crea `src/verticals/agenda/agent/testing/fake-db.test.ts`, que fija ese comportamiento del fake:

```ts
import { describe, expect, it } from 'vitest'

import { asClient, makeFakeDb } from './fake-db'

describe('fake-db: upsert con onConflict', () => {
  it('una columna: choca con la fila que tiene el mismo valor', async () => {
    const db = makeFakeDb({ t: [{ id: 'a', v: 'viejo' }] })

    await asClient(db).from('t').upsert({ id: 'a', v: 'nuevo' }, { onConflict: 'id' })
    await asClient(db).from('t').upsert({ id: 'b', v: 'otra' }, { onConflict: 'id' })

    expect(db._tables.t).toEqual([
      { id: 'a', v: 'nuevo' },
      { id: 'b', v: 'otra' },
    ])
  })

  it('varias columnas ("a,b"): solo choca cuando coinciden TODAS', async () => {
    const db = makeFakeDb({
      t: [
        { a: 1, b: 'x', v: 'primera' },
        { a: 2, b: 'y', v: 'segunda' },
      ],
    })

    // Misma "a", distinta "b": no es un conflicto, es una fila nueva.
    await asClient(db).from('t').upsert({ a: 1, b: 'y', v: 'nueva' }, { onConflict: 'a,b' })
    expect(db._tables.t).toHaveLength(3)

    // Mismas dos columnas: ahora sí pisa la fila que ya estaba.
    await asClient(db).from('t').upsert({ a: 2, b: 'y', v: 'pisada' }, { onConflict: 'a,b' })
    expect(db._tables.t).toHaveLength(3)
    expect(db._tables.t.find((r) => r.a === 2 && r.b === 'y')?.v).toBe('pisada')
    expect(db._tables.t.find((r) => r.a === 1 && r.b === 'x')?.v).toBe('primera')
  })

  it('varias columnas con ignoreDuplicates: la fila que choca no se toca', async () => {
    const db = makeFakeDb({ t: [{ a: 1, b: 'x', v: 'primera' }] })

    await asClient(db).from('t').upsert({ a: 1, b: 'x', v: 'nueva' }, { onConflict: 'a,b', ignoreDuplicates: true })
    await asClient(db).from('t').upsert({ a: 1, b: 'z', v: 'otra' }, { onConflict: 'a,b', ignoreDuplicates: true })

    expect(db._tables.t).toEqual([
      { a: 1, b: 'x', v: 'primera' },
      { a: 1, b: 'z', v: 'otra' },
    ])
  })

  it('tolera espacios alrededor de las columnas ("a, b")', async () => {
    const db = makeFakeDb({ t: [{ a: 1, b: 'x', v: 'primera' }] })

    await asClient(db).from('t').upsert({ a: 1, b: 'x', v: 'pisada' }, { onConflict: 'a, b' })

    expect(db._tables.t).toEqual([{ a: 1, b: 'x', v: 'pisada' }])
  })
})
```

- [ ] **Step 2: Escribe las pruebas que fallan**

Crea `src/modules/clinica/settings.test.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { ensureClinicSetup, loadClinicContext } from './settings'

const ACCOUNT = 'acc-1'

const SETTINGS_ROW = {
  account_id: ACCOUNT,
  consent_text: 'Autorizo',
  consent_version: 3,
  urgency_words: ['dolor'],
  urgency_alarm_text: 'Signos',
  urgency_service_id: 'svc-u',
  offer_days: 45,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('configuración de la clínica', () => {
  it('sin fila de configuración dice que falta, no que falló', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDb({ clinic_settings: [], clinic_locations: [] })

    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toEqual({ status: 'missing' })
    expect(spy).toHaveBeenCalled()
  })

  it('si la lectura falla devuelve error, que no es lo mismo que faltar', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDb({ clinic_settings: [SETTINGS_ROW], clinic_locations: [] })
    db._failNext('select', 'clinic_settings', { message: 'conexión caída' })

    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toEqual({ status: 'error' })
    expect(spy).toHaveBeenCalled()
  })

  it.each([
    ['sin texto de autorización', { consent_text: '   ' }],
    ['con el texto de autorización nulo', { consent_text: null }],
    ['sin signos de alarma', { urgency_alarm_text: '' }],
  ])('una fila %s es un error: no se puede pedir una autorización vacía', async (_name, patch) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = makeFakeDb({ clinic_settings: [{ ...SETTINGS_ROW, ...patch }], clinic_locations: [] })

    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toEqual({ status: 'error' })
  })

  it('lee la configuración y la primera sede activa de la cuenta', async () => {
    const db = makeFakeDb({
      clinic_settings: [SETTINGS_ROW],
      clinic_locations: [
        { id: 'otra', account_id: 'acc-2', name: 'Ajena', is_active: true },
        { id: 'inactiva', account_id: ACCOUNT, name: 'Vieja', is_active: false },
        { id: 'loc-1', account_id: ACCOUNT, name: 'Centro', address: 'Calle 1', is_active: true },
      ],
    })
    const result = await loadClinicContext(asClient(db), ACCOUNT)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.clinic).toMatchObject({
      consentText: 'Autorizo',
      consentVersion: 3,
      urgencyWords: ['dolor'],
      urgencyServiceId: 'svc-u',
      offerDays: 45,
      location: { id: 'loc-1', name: 'Centro', address: 'Calle 1' },
    })
  })

  it('sin sede activa sigue siendo válida: la autorización y las urgencias no dependen de ella', async () => {
    const db = makeFakeDb({ clinic_settings: [SETTINGS_ROW], clinic_locations: [] })

    const result = await loadClinicContext(asClient(db), ACCOUNT)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.clinic.location).toBeNull()
  })

  it('el montaje crea lo que falta una sola vez y enlaza la atención de urgencia', async () => {
    const db = makeFakeDb({
      clinic_settings: [],
      clinic_locations: [],
      booking_services: [
        { id: 'svc-u', account_id: ACCOUNT, name: 'Urgencia' },
        { id: 'svc-x', account_id: 'acc-2', name: 'Urgencia' },
      ],
    })
    await ensureClinicSetup(asClient(db), ACCOUNT)
    await ensureClinicSetup(asClient(db), ACCOUNT)

    expect(db._tables.clinic_settings).toHaveLength(1)
    expect(db._tables.clinic_settings[0].urgency_service_id).toBe('svc-u')
    expect(db._tables.clinic_settings[0].consent_version).toBe(1)
    expect(db._tables.clinic_locations).toHaveLength(1)
    expect(db._tables.clinic_locations[0].name).toBe('Sede principal')
  })

  it('si otro montaje creó la configuración justo antes, no falla ni la pisa', async () => {
    const db = makeFakeDb({
      clinic_settings: [{ ...SETTINGS_ROW, consent_text: 'Texto ajustado por Shift' }],
      clinic_locations: [{ id: 'loc-1', account_id: ACCOUNT, name: 'Centro', is_active: true }],
    })
    // El montaje lee ANTES de que la otra fila aparezca: la primera lectura no ve nada.
    let firstRead = true
    const racing = {
      ...db,
      from(table: string) {
        if (table === 'clinic_settings' && firstRead) {
          firstRead = false
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          }
        }
        return db.from(table)
      },
    }

    await expect(ensureClinicSetup(racing as unknown as SupabaseClient, ACCOUNT)).resolves.toBeUndefined()

    expect(db._tables.clinic_settings).toHaveLength(1)
    expect(db._tables.clinic_settings[0].consent_text).toBe('Texto ajustado por Shift')
  })
})
```

Crea `src/modules/clinica/texts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { containsUrgencyWord } from '@/verticals/agenda/agent/state'
import { DEFAULT_LABELS } from '@/verticals/agenda/labels'

import {
  buildClinicTexts,
  DEFAULT_CONSENT_TEXT,
  DEFAULT_URGENCY_ALARM_TEXT,
  DEFAULT_URGENCY_WORDS,
} from './texts'

const texts = buildClinicTexts(DEFAULT_LABELS)

describe('textos de la clínica', () => {
  it('quien no acepta no recibe una promesa falsa de que no se guardan sus datos', () => {
    expect(texts.consentDeclined).toBe(
      'Entendido. Una persona de la clínica te atiende por este chat. 🙌',
    )
    expect(texts.consentDeclined).not.toMatch(/guardaremos/i)
  })

  it('las notas internas empiezan por "Paciente:"', () => {
    expect(texts.consentDeclinedNote).toBe(
      'Paciente: no aceptó la autorización de datos (bot en pausa).',
    )
    expect(texts.urgencyNote).toBe('Paciente: reportó signos de alarma (bot en pausa).')
    expect(texts.urgencyOffHoursNote).toBe(
      'Paciente: urgencia sin cupo en la agenda de hoy (bot en pausa).',
    )
  })

  it('el texto de autorización por defecto no promete menos de lo que se hace', () => {
    expect(DEFAULT_CONSENT_TEXT).toContain(
      'No tienes la obligación de autorizarlos y te atendemos igual si no aceptas.',
    )
    expect(DEFAULT_CONSENT_TEXT).toContain(
      'Los usamos para atenderte: tus citas, tus recordatorios y el seguimiento después de cada visita.',
    )
    expect(DEFAULT_CONSENT_TEXT).not.toContain('No estás obligado')
    expect(DEFAULT_CONSENT_TEXT).not.toContain('solo para gestionar')
  })

  it('los textos por defecto caben en lo que admite la base (900) y WhatsApp (1024)', () => {
    expect([...DEFAULT_CONSENT_TEXT].length).toBeLessThanOrEqual(900)
    expect([...DEFAULT_URGENCY_ALARM_TEXT].length).toBeLessThanOrEqual(900)
  })

  it.each([
    ['cita', 'citas'],
    ['turno', 'turnos'],
    ['sesión', 'sesiones'],
  ])('no depende del género de la palabra del dueño (%s)', (cita, citas) => {
    const t = buildClinicTexts({ ...DEFAULT_LABELS, cita, citas })

    expect(t.noUpcoming).toBe(`Por ahora no hay ${citas} a tu nombre. ¿Quieres agendar?`)
    expect(t.patientMenuBody).toBe('¿Quién va a asistir?')
    expect(t.patientNamePrompt).toBe(
      'Escríbeme el nombre y los apellidos de quien va a asistir.',
    )
    expect(
      t.reminderBody({
        patient: 'Ana Pérez',
        business: 'Clínica Sonrisa',
        location: 'Centro',
        staff: 'Dra. Gómez',
        date: 'lunes 4',
        time: '3:00 p. m.',
      }),
    ).toBe(
      `¡Hola! 👋 Te recordamos que Ana Pérez tiene ${cita} en Clínica Sonrisa, sede Centro:\n\n👤 Dra. Gómez\n📅 lunes 4\n🕐 3:00 p. m.\n\n¿Nos confirmas?`,
    )
  })
})

describe('palabras de urgencia por defecto', () => {
  const words = DEFAULT_URGENCY_WORDS

  it('van en minúsculas y sin tildes, como se comparan', () => {
    for (const word of words) {
      expect(word).toBe(
        word
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase(),
      )
    }
  })

  it('no repite ninguna', () => {
    expect(new Set(words).size).toBe(words.length)
  })

  it('"dolores" no es una palabra de urgencia: es un nombre', () => {
    expect(words).not.toContain('dolores')
    expect(containsUrgencyWord('Dolores Pérez pide una cita', words)).toBe(false)
  })

  it.each([
    'me duelen las muelas',
    'me sangran las encías',
    'hay mucha sangre',
    'se me partió una muela',
    'se me quebró un diente',
    'se quebró la corona',
    'se me rompió el puente',
    'se rompió el diente',
    'tengo la cara inflamada',
    'tengo la encía inflamada',
    'el cachete está inflamado',
    'me cuesta respirar',
    'no puedo tragar',
    'tengo mucho dolor',
    'se me cayó una corona',
    'no paro de sangrar',
    'yo sangro mucho',
    'se me hinchó la cara',
    'se me inflamó la encía',
    'me fracturé un diente',
    'me falta el aire',
  ])('reconoce una urgencia: %s', (message) => {
    expect(containsUrgencyWord(message, words)).toBe(true)
  })

  it.each(['quiero agendar una limpieza', 'Soy Dolores Pérez', 'cuánto cuesta una consulta'])(
    'no confunde un mensaje normal: %s',
    (message) => {
      expect(containsUrgencyWord(message, words)).toBe(false)
    },
  )
})
```

Agrega en `src/verticals/agenda/install.test.ts`, al final del archivo (`fakeDb` e `installPreset` ya existen ahí):

```ts
describe('configuración de la clínica', () => {
  it('odontología la deja lista; los demás negocios no la tocan', async () => {
    const dental = fakeDb()
    await installPreset(dental, 'odontologia')
    expect(dental._tables.clinic_settings).toHaveLength(1)
    expect(dental._tables.clinic_locations).toHaveLength(1)

    const barberia = fakeDb()
    await installPreset(barberia, 'barberia')
    expect(barberia._tables.clinic_settings).toBeUndefined()
  })
})
```

- [ ] **Step 3: Córrelas y verifica que fallan**

Run: `npx vitest run src/modules/clinica src/verticals/agenda/install.test.ts`
Expected: FAIL, no existen `./settings` ni `./texts`.

- [ ] **Step 4: Crea los textos**

El texto de autorización dice para qué se usan los datos (citas, recordatorios y seguimiento tras cada visita), y el rechazo no promete borrar nada: el mensaje del paciente ya quedó guardado. Los textos que mencionan la cita no dependen del género de la palabra del dueño ("cita", "turno", "sesión").

Crea `src/modules/clinica/texts.ts`:

```ts
// ============================================================
// Copy del bot clínico — español colombiano.
//
// Como el resto del vertical, vive en código y no en messages/*.json.
// El texto de autorización y los signos de alarma son valores por
// defecto: el abogado y el director de la clínica los revisan antes de
// ir a producción, y cada cuenta guarda los suyos en clinic_settings.
// ============================================================

import type { AgendaLabels } from '@/verticals/agenda/labels'

export const DEFAULT_CONSENT_TEXT = [
  'Antes de seguir: para atenderte guardamos tu nombre, tu número y los datos de tus citas.',
  'Algunos pueden ser datos de salud, que son sensibles. No tienes la obligación de autorizarlos y te atendemos igual si no aceptas.',
  'Los usamos para atenderte: tus citas, tus recordatorios y el seguimiento después de cada visita.',
  '¿Autorizas el tratamiento de tus datos?',
].join('\n\n')

export const DEFAULT_URGENCY_ALARM_TEXT =
  'Ve a urgencias ahora si tienes dificultad para respirar o tragar, hinchazón que crece en la cara o el cuello, sangrado que no para, fiebre alta o un golpe fuerte en la cara.'

/** Sin tildes: se comparan contra el texto normalizado. */
export const DEFAULT_URGENCY_WORDS: readonly string[] = [
  'urgencia',
  'urgente',
  'emergencia',
  'dolor',
  'duele',
  'duelen',
  'sangrado',
  'sangra',
  'sangran',
  'sangrando',
  'sangrar',
  'sangro',
  'sangre',
  'hinchazon',
  'hinchado',
  'hinchada',
  'hincho',
  'inflamado',
  'inflamada',
  'inflamo',
  'absceso',
  'pus',
  'fiebre',
  'golpe',
  'fractura',
  'fracture',
  'se partio',
  'se me partio',
  'se quebro',
  'se me quebro',
  'se rompio',
  'se me rompio',
  'se me cayo',
  'respirar',
  'tragar',
  'me falta el aire',
]

/** Nota: una lista admite títulos de hasta 24 caracteres y un botón, 20. */
export function buildClinicTexts(l: AgendaLabels) {
  return {
    consentAccept: 'Sí, acepto',
    consentDecline: 'No acepto',
    consentDeclined: 'Entendido. Una persona de la clínica te atiende por este chat. 🙌',
    consentDeclinedNote: 'Paciente: no aceptó la autorización de datos (bot en pausa).',
    consentError: 'No pude guardar tu respuesta en este momento 😅. Intenta de nuevo, por favor.',

    menuBody: '¡Hola! 👋 Soy el asistente de la clínica. ¿En qué te ayudo?',
    menuButton: 'Ver opciones',
    menuBook: `Agendar ${l.cita}`,
    menuMine: `Mis ${l.citas}`,
    menuFaq: 'Precios y dudas',
    menuUrgent: 'Tengo una urgencia',
    menuHuman: 'Hablar con una persona',
    faqPrompt: 'Cuéntame tu duda y te respondo. 🙌',

    noUpcoming: `Por ahora no hay ${l.citas} a tu nombre. ¿Quieres agendar?`,
    pickAppointmentBody: `¿Sobre cuál ${l.cita}?`,
    pickAppointmentButton: `Ver ${l.citas}`,

    patientMenuBody: '¿Quién va a asistir?',
    patientMenuButton: 'Ver personas',
    patientOther: 'Otra persona',
    patientNamePrompt: 'Escríbeme el nombre y los apellidos de quien va a asistir.',
    patientNameRetry: 'Necesito nombre y apellidos, sin números. Escríbelos de nuevo, por favor.',
    patientSaveError: `No pude registrar a esa persona en este momento 😅. Intenta de nuevo o escríbeme "asesor".`,

    urgencyBody: (alarmText: string) => `${alarmText}\n\n¿Tienes alguno de estos signos?`,
    urgencyYes: 'Sí, tengo alguno',
    urgencyNo: 'No, ninguno',
    urgencyGoEr: 'Por favor ve a urgencias ahora. Ya avisé a la clínica para que se comuniquen contigo.',
    urgencyOffHours: (onCallPhone: string | null) =>
      onCallPhone
        ? `Hoy no tengo cupo en la agenda. Llama al ${onCallPhone}, que es el teléfono de turno. Si aparece alguno de los signos de alarma, ve a urgencias.`
        : 'Hoy no tengo cupo en la agenda. Ya avisé a la clínica para que te escriban a primera hora. Si aparece alguno de los signos de alarma, ve a urgencias.',
    urgencyNote: 'Paciente: reportó signos de alarma (bot en pausa).',
    urgencyOffHoursNote: 'Paciente: urgencia sin cupo en la agenda de hoy (bot en pausa).',
    urgencyNotificationTitle: '🚨 Posible urgencia',
    urgencyNotificationBody: (who: string) =>
      `${who} reportó una posible urgencia por WhatsApp. Comunícate con esa persona ya.`,

    moreDays: 'Ver más días',

    marketingBody: '¿Quieres que te avisemos cuando te toque tu próximo control o limpieza?',
    marketingYes: 'Sí, avísame',
    marketingNo: 'No, gracias',
    marketingThanksYes: 'Listo, te avisaremos. 🙌',
    marketingThanksNo: 'Perfecto, no te escribiremos por eso. 🙌',

    reminderBody: (a: {
      patient: string
      business: string
      location: string
      staff: string
      date: string
      time: string
    }) =>
      `¡Hola! 👋 Te recordamos que ${a.patient} tiene ${l.cita} en ${a.business}, sede ${a.location}:\n\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Nos confirmas?`,
    reminderStaffFallback: 'el equipo de la clínica',

    /** Mapa e instrucciones previas tras confirmar; null si no hay nada que decir. */
    prepInfo: (a: { prep: string | null; address: string | null; mapUrl: string | null }) => {
      const lines: string[] = []
      if (a.prep) lines.push(`Para tu ${l.cita}:\n${a.prep}`)
      if (a.address) lines.push(`📍 ${a.address}`)
      if (a.mapUrl) lines.push(a.mapUrl)
      return lines.length ? lines.join('\n\n') : null
    },
  }
}

export type ClinicTexts = ReturnType<typeof buildClinicTexts>
```

- [ ] **Step 5: Crea la configuración**

Crea `src/modules/clinica/settings.ts`:

```ts
// ============================================================
// Configuración de la clínica (clinic_settings + clinic_locations).
//
// Los llamadores le pasan el cliente: el bot usa el service role y el
// instalador también.
//
// `loadClinicContext` distingue "falta la configuración" de "no se pudo
// leer": quien la llama decide qué hace en cada caso, y ante un error NO
// puede tratar la conversación como una agenda normal (se saltaría la
// autorización de datos y la IA vería el chat de un paciente).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  DEFAULT_CONSENT_TEXT,
  DEFAULT_URGENCY_ALARM_TEXT,
  DEFAULT_URGENCY_WORDS,
} from './texts'

export interface ClinicLocation {
  id: string
  name: string
  address: string | null
  latitude: number | null
  longitude: number | null
  onCallPhone: string | null
}

export interface ClinicContext {
  consentText: string
  consentVersion: number
  urgencyWords: string[]
  urgencyAlarmText: string
  urgencyServiceId: string | null
  offerDays: number
  /** La sede de la clínica. Con la Agenda de Shift hay una sola. */
  location: ClinicLocation | null
}

/**
 * Resultado de leer la configuración de la clínica.
 *   - ok: lista para usar.
 *   - missing: la cuenta tiene el módulo pero nadie la configuró.
 *   - error: la lectura falló o la fila no es usable. NO equivale a "no hay
 *     clínica": hay que fallar cerrado.
 */
export type ClinicContextResult =
  | { status: 'ok'; clinic: ClinicContext }
  | { status: 'missing' }
  | { status: 'error' }

function mapLocation(row: Record<string, unknown>): ClinicLocation {
  return {
    id: row.id as string,
    name: row.name as string,
    address: (row.address as string | null) ?? null,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    onCallPhone: (row.on_call_phone as string | null) ?? null,
  }
}

export async function loadClinicContext(
  db: SupabaseClient,
  accountId: string,
): Promise<ClinicContextResult> {
  const { data, error } = await db
    .from('clinic_settings')
    .select(
      'consent_text, consent_version, urgency_words, urgency_alarm_text, urgency_service_id, offer_days',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[clinica] no se pudo leer la configuración:', error.message)
    return { status: 'error' }
  }
  if (!data) {
    console.error(`[clinica] la cuenta ${accountId} tiene el módulo sin configurar`)
    return { status: 'missing' }
  }

  // La base lo exige, pero una autorización o unos signos de alarma vacíos
  // nunca se le muestran a un paciente.
  const row = data as Record<string, unknown>
  if (!isFilled(row.consent_text) || !isFilled(row.urgency_alarm_text)) {
    console.error(`[clinica] la configuración de la cuenta ${accountId} no tiene los textos`)
    return { status: 'error' }
  }

  const { data: locations, error: locationError } = await db
    .from('clinic_locations')
    .select('id, name, address, latitude, longitude, on_call_phone')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
  if (locationError) console.error('[clinica] no se pudo leer la sede:', locationError.message)
  const location = ((locations ?? []) as Record<string, unknown>[])[0]

  return {
    status: 'ok',
    clinic: {
      consentText: row.consent_text as string,
      consentVersion: Number(row.consent_version),
      urgencyWords: Array.isArray(row.urgency_words) ? (row.urgency_words as string[]) : [],
      urgencyAlarmText: row.urgency_alarm_text as string,
      urgencyServiceId: (row.urgency_service_id as string | null) ?? null,
      offerDays: Number(row.offer_days) || 30,
      location: location ? mapLocation(location) : null,
    },
  }
}

const isFilled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

/** Instrucciones previas de un servicio; null si no tiene o el catálogo cambió. */
export async function loadServicePrep(
  db: SupabaseClient,
  accountId: string,
  serviceId: string,
): Promise<string | null> {
  const { data } = await db
    .from('booking_services')
    .select('prep_instructions')
    .eq('id', serviceId)
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data as Record<string, unknown> | null)?.prep_instructions as string | null) ?? null
}

/**
 * Deja la configuración mínima de una clínica. Idempotente: crea lo que
 * falta y nunca pisa lo que Shift ya ajustó.
 */
export async function ensureClinicSetup(db: SupabaseClient, accountId: string): Promise<void> {
  const { data: settings, error: settingsError } = await db
    .from('clinic_settings')
    .select('account_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (settingsError) throw settingsError

  if (!settings) {
    const { data: services, error: servicesError } = await db
      .from('booking_services')
      .select('id, name')
      .eq('account_id', accountId)
    if (servicesError) throw servicesError
    const urgency = ((services ?? []) as { id: string; name: string }[]).find(
      (s) => s.name.trim().toLowerCase() === 'urgencia',
    )
    // upsert + ignoreDuplicates (ON CONFLICT DO NOTHING): si otro montaje
    // creó la fila entre la lectura y la escritura, esa gana y no se pisa.
    const { error } = await db.from('clinic_settings').upsert(
      {
        account_id: accountId,
        consent_text: DEFAULT_CONSENT_TEXT,
        consent_version: 1,
        urgency_words: [...DEFAULT_URGENCY_WORDS],
        urgency_alarm_text: DEFAULT_URGENCY_ALARM_TEXT,
        urgency_service_id: urgency?.id ?? null,
        offer_days: 30,
      },
      { onConflict: 'account_id', ignoreDuplicates: true },
    )
    if (error) throw error
  }

  const { data: locations, error: locationsError } = await db
    .from('clinic_locations')
    .select('id')
    .eq('account_id', accountId)
  if (locationsError) throw locationsError
  if (((locations ?? []) as unknown[]).length === 0) {
    const { error } = await db.from('clinic_locations').insert({
      id: crypto.randomUUID(),
      account_id: accountId,
      name: 'Sede principal',
      is_active: true,
    })
    if (error) throw error
  }
}
```

- [ ] **Step 6: Llama al montaje desde el instalador**

En `src/verticals/agenda/install.ts`:

```ts
import { ensureClinicSetup } from '@/modules/clinica/settings'
```

Y justo antes de `return report`:

```ts
  // ----------------------------------------------------------
  // 13. Configuración de la clínica (solo odontología)
  //
  // El módulo `clinica` lo activa Shift en la base; esto deja listas su
  // autorización, sus urgencias y su sede. Idempotente.
  // ----------------------------------------------------------
  if (preset.key === 'odontologia') await ensureClinicSetup(db, accountId)

```

- [ ] **Step 7: Corre las pruebas**

Run: `npx vitest run src/modules/clinica src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/clinica src/verticals/agenda/install.ts src/verticals/agenda/install.test.ts src/verticals/agenda/agent/testing/fake-db.ts
git commit -m "feat(clinica): add clinic settings and bot copy"
```

---

### Task 6: Estado del bot y toques del recordatorio

Esta tarea también corrige el hallazgo de producción: las etiquetas de la plantilla cuentan como toques, **pero solo si el mensaje responde a un recordatorio**. Y fija una regla que no admite atajos: la autorización de datos y el aviso de marketing **solo se aceptan tocando el botón**.

**Files:**
- Modify: `src/verticals/agenda/agent/state.ts`, `src/verticals/agenda/agent/state.test.ts`, `src/verticals/agenda/agent/controller.ts`, `src/verticals/agenda/agent/controller.test.ts`, `src/verticals/agenda/agent/db.ts`, `src/verticals/agenda/agent/reminders.ts`, `src/verticals/agenda/agent/reminders.test.ts`

Las reglas, tal como quedaron tras la revisión:

1. **Una etiqueta no basta.** Cualquier otra plantilla o difusión puede traer un botón "Confirmar" o "Cancelar", y Meta devuelve solo la etiqueta. Leerla sin más confirmaba citas, escribía encima de un humano o respondía "ya no está activo" y consumía el mensaje. `parseReminderTap` marca el toque `viaLabel: true`, y `handleAgendaInbound` lo acepta solo si el mensaje responde a una plantilla `recordatorio_cita` o `recordatorio_cita_clinica` de esa conversación. Sin referencia o con otra plantilla, el mensaje sigue el camino normal (`consumed: false`). Los ids `rem:*` no necesitan la comprobación.
2. **Aceptar solo por toque.** Ningún texto acepta la autorización (`consent_yes`) ni el aviso de marketing (`mkt_yes`): ni "acepto", ni "sí", ni "autorizo". Un texto se lee mal (`squash` borra emojis, símbolos y tildes: "❌ acepto", "acepto 🤔" y "autorizó" parecían un sí) y una autorización tiene que ser explícita. Tampoco acepta un número. Un toque de botón (`replyId`) siempre vale.
3. **Una negación es un rechazo; lo demás, `null`.** En autorización y aviso de marketing, un texto con una negación en cualquier parte es `*_no` (incluso "acepto, no hay problema": es el lado seguro) y cualquier otro texto da `null`: el bot vuelve a mostrar los botones y a la segunda pasa a una persona. "2" sigue siendo el rechazo.
4. **Signos de alarma: ante la duda, va a una persona.** Descartarlos (`alarm_no`) exige el toque o un mensaje completo de una lista cerrada, escrito solo con letras, números y puntuación simple ("ninguno 🤔" no descarta nada; con `?` tampoco). Dan `alarm_yes` el toque, otra lista cerrada, una negación dentro de una frase ("no puedo respirar", "la fiebre no baja", "no sé") y un signo dicho con palabras ("fiebre alta", "estoy sangrando mucho", "se me hinchó la cara"). Lo demás, incluido "tengo mucho dolor" (el dolor no es un signo de alarma), da `null`.

- [ ] **Step 1: Escribe las pruebas que fallan**

En `src/verticals/agenda/agent/state.test.ts`:

1. En el import, cambia `parseReminderId` por `parseReminderTap` y agrega `apptId`, `containsUrgencyWord` y `patId`.
2. Reemplaza las aserciones de las líneas 224 a 235 por:

```ts
    expect(parseReminderTap('rem:confirm')).toEqual({ action: 'confirm', appointmentId: null })
    expect(parseReminderTap('rem:reschedule')).toEqual({ action: 'reschedule', appointmentId: null })
    expect(parseReminderTap('rem:cancel')).toEqual({ action: 'cancel', appointmentId: null })
```

```ts
    expect(parseReminderTap('act:confirm')).toBeNull()
    expect(parseReminderTap('svc:rem:x')).toBeNull()
    expect(parseReminderTap('rem:desconocido')).toBeNull()
    expect(parseReminderTap('rem:')).toBeNull()
    expect(parseReminderTap('')).toBeNull()
    expect(parseReminderTap('constructor')).toBeNull()
```

3. Agrega al final:

```ts
describe('toques del recordatorio', () => {
  it('lleva el id de la cita cuando viaja en el botón', () => {
    expect(remId('confirm', 'ap-1')).toBe('rem:confirm:ap-1')
    expect(parseReminderTap('rem:confirm:ap-1')).toEqual({ action: 'confirm', appointmentId: 'ap-1' })
  })

  it('entiende la etiqueta que Meta devuelve cuando la plantilla no trae payload', () => {
    expect(parseReminderTap('Confirmar')).toEqual({ action: 'confirm', appointmentId: null, viaLabel: true })
    expect(parseReminderTap('Reprogramar')).toEqual({ action: 'reschedule', appointmentId: null, viaLabel: true })
    expect(parseReminderTap('Cancelar')).toEqual({ action: 'cancel', appointmentId: null, viaLabel: true })
  })

  it('marca las etiquetas, que cualquier otra plantilla también puede traer, y los ids no', () => {
    expect(parseReminderTap('Confirmar')?.viaLabel).toBe(true)
    expect(parseReminderTap('rem:confirm')?.viaLabel).toBeUndefined()
    expect(parseReminderTap('rem:cancel:ap-1')?.viaLabel).toBeUndefined()
  })
})

describe('palabras de urgencia', () => {
  it('compara sin tildes y por palabra completa', () => {
    const words = ['dolor', 'se me cayo']
    expect(containsUrgencyWord('Tengo mucho DOLOR', words)).toBe(true)
    expect(containsUrgencyWord('se me cayó una corona', words)).toBe(true)
    expect(containsUrgencyWord('Soy Dolores Pérez', words)).toBe(false)
  })
})

// ------------------------------------------------------------
// Menús de decisión (autorización, marketing, signos de alarma).
//
// La autorización y el aviso de marketing solo se ACEPTAN TOCANDO el botón:
// ningún texto acepta ("acepto", "sí", "autorizo"). Un texto se puede leer
// mal (emojis, tildes, dudas, "autorizó") y una autorización tiene que ser
// explícita. Un texto con negación es un rechazo; cualquier otro, null: el
// bot vuelve a mostrar los botones y a la segunda pasa a una persona.
// ------------------------------------------------------------

const consentOptions: OfferedOption[] = [
  { id: 'act:consent_yes', title: 'Sí, acepto' },
  { id: 'act:consent_no', title: 'No acepto' },
]
const marketingOptions: OfferedOption[] = [
  { id: 'act:mkt_yes', title: 'Sí, avísame' },
  { id: 'act:mkt_no', title: 'No, gracias' },
]
const alarmOptions: OfferedOption[] = [
  { id: 'act:alarm_yes', title: 'Sí, tengo alguno' },
  { id: 'act:alarm_no', title: 'No, ninguno' },
]

describe('autorización escrita', () => {
  const options = consentOptions
  const choice = (text: string) => matchChoice({ text, options })

  it('un no nunca se lee como aceptación', () => {
    expect(choice('no acepto')).toBe('act:consent_no')
    expect(choice('no, no acepto')).toBe('act:consent_no')
    expect(choice('no autorizo')).toBe('act:consent_no')
    expect(choice('no')).toBe('act:consent_no')
  })

  it('aceptar exige tocar el botón: ningún texto acepta', () => {
    expect(choice('sí, acepto')).toBeNull()
    expect(choice('acepto')).toBeNull()
    expect(choice('autorizo')).toBeNull()
    expect(choice('ok')).toBeNull()
  })

  it('el toque del botón sí acepta (y el del rechazo, rechaza)', () => {
    expect(matchChoice({ text: '', replyId: 'act:consent_yes', options })).toBe('act:consent_yes')
    expect(matchChoice({ text: '', replyId: 'act:consent_no', options })).toBe('act:consent_no')
    expect(matchChoice({ text: 'sí, acepto', replyId: 'act:consent_yes', options })).toBe('act:consent_yes')
  })

  it.each([
    'Sí acepto',
    'sí, acepto.',
    ' ACEPTO ',
    'sí autorizo',
    'Autorizo',
    'autorizó',
    '❌ acepto',
    '✅ acepto',
    'acepto 🤔',
    'acepto :(',
    'Acepto 👍',
    'acepto 😡',
    'sí',
    'dale',
    'claro que sí',
    'ok',
  ])('ningún texto acepta: %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it.each([
    'noo autorizo',
    'nop autorizo',
    'para nada autorizo',
    'nunca autorizo',
    'tampoco autorizo',
    'ni autorizo ni nada',
    'no sé si acepto',
    'acepto, no hay problema',
    '¿qué pasa si no acepto?',
    '❌ no acepto',
    'no 🤔',
  ])('lo que trae una negación es rechazo: %j', (text) => {
    expect(choice(text)).toBe('act:consent_no')
  })

  it.each([
    '¿qué autorizo?',
    '¿qué pasa si acepto?',
    '¿si acepto me cobran?',
    'mi mamá autorizó',
    '¿acepto?',
    'acepto?',
    'si a',
    'acep',
    '1',
    '01',
    '3',
    '',
    '😀',
  ])('una duda, una pregunta o un mensaje a medias tampoco acepta: %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it('por número, el rechazo sigue valiendo y la aceptación no', () => {
    expect(choice('2')).toBe('act:consent_no')
    expect(choice('2.')).toBe('act:consent_no')
    expect(choice('1')).toBeNull()
  })
})

describe('aviso de marketing escrito', () => {
  const options = marketingOptions
  const choice = (text: string) => matchChoice({ text, options })

  it.each(['sí', 'Sí.', 'sí, avísame', 'avísame', 'avisame!', '✅ sí', 'avísame 🤔'])(
    'ningún texto acepta: %j',
    (text) => {
      expect(choice(text)).toBeNull()
    },
  )

  it.each(['no', 'no, gracias', 'no avísame', 'noo', 'nunca', 'tampoco', '2', '❌ no'])(
    'un no nunca se lee como aceptación: %j',
    (text) => {
      expect(choice(text)).toBe('act:mkt_no')
    },
  )

  it.each(['¿avísame?', '¿qué es eso?', 'ok', 'dale', 'quizás', 'sí, gracias', '1', '3', ''])(
    'una duda, una pregunta o un mensaje a medias no acepta: %j',
    (text) => {
      expect(choice(text)).toBeNull()
    },
  )

  it('el toque del botón sí acepta', () => {
    expect(matchChoice({ text: '', replyId: 'act:mkt_yes', options })).toBe('act:mkt_yes')
    expect(matchChoice({ text: '', replyId: 'act:mkt_no', options })).toBe('act:mkt_no')
  })
})

describe('signos de alarma escritos', () => {
  const options = alarmOptions
  const choice = (text: string) => matchChoice({ text, options })

  it.each([
    'no',
    'No.',
    'no, ninguno',
    'ninguno',
    'ninguna',
    'no tengo',
    'no tengo ninguno',
    'no tengo ninguna',
    'no tengo nada',
    'nada',
    'Nada.',
    'no ninguna',
    'ninguno de esos',
    'Ninguna de esas',
    'ninguno de los anteriores',
    'no ninguno de esos',
    'no ninguna de esas',
    'no tengo ninguno de esos',
    'no tengo ninguna de esas',
    'no no',
    'no, no tengo',
    'nop',
    'nope',
    'noo',
    'no gracias',
    'no señor',
    'no señora',
    'nada de eso',
    'no, nada de eso',
  ])('solo el mensaje completo de la lista dice que no hay signos: %j', (text) => {
    expect(choice(text)).toBe('act:alarm_no')
  })

  it.each(['sí', 'Sí.', 'si tengo', 'sí, tengo alguno', 'tengo alguno'])(
    'el mensaje completo de la lista dice que sí hay signos: %j',
    (text) => {
      expect(choice(text)).toBe('act:alarm_yes')
    },
  )

  it.each([
    'tengo dificultad para respirar',
    'respiro mal',
    'sí, tengo fiebre',
    'fiebre alta',
    'estoy sangrando mucho',
    'se me hinchó la cara',
    'tengo la encía inflamada',
    'me cuesta tragar',
    'me dieron un golpe fuerte en la cara',
    'siento que me ahogo',
  ])('un signo dicho con palabras va a una persona: %j', (text) => {
    expect(choice(text)).toBe('act:alarm_yes')
  })

  it.each([
    'no puedo respirar',
    'no puedo tragar',
    'no para de sangrar',
    'la fiebre no baja',
    'no sé',
    'no se',
    'no estoy seguro',
    'no tengo ni idea',
    'no siento nada',
    '¿no?',
    '¿no tengo ninguno?',
  ])('una negación dentro de una frase va a una persona: %j', (text) => {
    expect(choice(text)).toBe('act:alarm_yes')
  })

  it.each([
    'tengo mucho dolor',
    'hola',
    '¿cuáles son los signos?',
    'quiero agendar',
    '¿ninguno?',
    'ninguno?',
    '3',
    '',
  ])('lo demás no decide (el dolor, por sí solo, no es un signo de alarma): %j', (text) => {
    expect(choice(text)).toBeNull()
  })

  it.each(['ninguno 🤔', 'no 👍', 'nada :(', 'ninguno ❌', '✅ ninguno', 'no tengo ninguno 😀', 'nada de eso 🙏'])(
    'con emojis o símbolos nunca descarta los signos: %j',
    (text) => {
      expect(choice(text)).not.toBe('act:alarm_no')
    },
  )

  it('"ninguno 🤔" no decide: el bot vuelve a preguntar', () => {
    expect(choice('ninguno 🤔')).toBeNull()
  })

  it('por número, "no hay signos" no vale y "sí hay" sí (lleva a una persona)', () => {
    expect(choice('2')).toBeNull()
    expect(choice('02')).toBeNull()
    expect(choice('1')).toBe('act:alarm_yes')
  })

  it('con una pregunta nunca dice que no hay signos', () => {
    expect(choice('¿ninguno?')).not.toBe('act:alarm_no')
    expect(choice('¿no tengo ninguno?')).not.toBe('act:alarm_no')
    expect(choice('ninguno?')).not.toBe('act:alarm_no')
  })

  it('un toque de botón siempre vale', () => {
    expect(matchChoice({ text: '', replyId: 'act:alarm_no', options })).toBe('act:alarm_no')
    expect(matchChoice({ text: '', replyId: 'act:alarm_yes', options })).toBe('act:alarm_yes')
  })
})

describe('menús de decisión: nunca se acepta por accidente', () => {
  // Frases que no son un toque: no pueden acertar la opción que acepta
  // (consent_yes, mkt_yes) ni la que descarta los signos (alarm_no).
  const stray = [
    'tal vez',
    'no sé qué hacer',
    'lo que sea',
    'sí, pero antes explícame',
    'acepto, ¿y si no?',
    'dame un momento',
    '1 y 2',
    '😀',
    'sí',
    'acepto',
    'autorizo',
    'autorizó',
    '❌ acepto',
    'acepto 🤔',
    'acepto :(',
    'ninguno 🤔',
    '¿ninguno?',
  ]
  it.each([
    ['autorización', consentOptions, 'act:consent_yes'],
    ['marketing', marketingOptions, 'act:mkt_yes'],
    ['signos de alarma', alarmOptions, 'act:alarm_no'],
  ] as const)('%s', (_name, options, acceptingId) => {
    for (const text of stray) {
      expect(matchChoice({ text, options: [...options] }), text).not.toBe(acceptingId)
    }
  })

  it('el resto de los menús sigue emparejando como antes', () => {
    expect(matchChoice({ text: 'sí', options: [{ id: 'act:confirm', title: 'Confirmar' }] })).toBe(
      'act:confirm',
    )
  })
})

describe('ids nuevos', () => {
  it('paciente y cita se leen como opciones', () => {
    expect(parseOptionId(patId('new'))).toEqual({ kind: 'pat', value: 'new' })
    expect(parseOptionId(apptId('ap-1'))).toEqual({ kind: 'appt', value: 'ap-1' })
  })
})

describe('palabras de intención en una clínica', () => {
  it('"gracias por la atención" no abre el flujo de agendar', () => {
    // La clínica llama "atención" a su servicio: sale de las palabras propias.
    const clinicWords = ['cita', 'citas', 'atención', 'atenciones']
    expect(containsIntentWord('muchas gracias por la atención', clinicWords)).toBe(false)
    expect(containsIntentWord('gracias por las atenciones', clinicWords)).toBe(false)
    expect(containsIntentWord('quiero una cita', clinicWords)).toBe(true)
  })
})
```

En `src/verticals/agenda/agent/controller.test.ts`:

1. Reemplaza `seedInbound` y agrega, justo después, `seedTemplateMessage`:

```ts
function seedInbound(
  db: FakeDb,
  input: { text?: string; replyId?: string | null; replyTo?: string | null },
): string {
  msgCounter += 1
  const messageId = `wamid-${msgCounter}`
  db._tables.messages.push({
    id: `msg-${msgCounter}`,
    account_id: ACCOUNT,
    conversation_id: CONVERSATION,
    message_id: messageId,
    content_text: input.text ?? '',
    content_type: input.replyId ? 'interactive' : 'text',
    interactive_reply_id: input.replyId ?? null,
    // Como el webhook: el id interno del mensaje al que responde el cliente.
    reply_to_message_id: input.replyTo ?? null,
  })
  return messageId
}

/**
 * Un saliente de plantilla que el cliente puede citar (el toque de un botón
 * llega como respuesta a él). Devuelve su id interno.
 */
function seedTemplateMessage(
  db: FakeDb,
  templateName: string,
  conversationId: string = CONVERSATION,
): string {
  msgCounter += 1
  const id = `msg-tpl-${msgCounter}`
  db._tables.messages.push({
    id,
    account_id: ACCOUNT,
    conversation_id: conversationId,
    message_id: `wamid-tpl-${msgCounter}`,
    sender_type: 'bot',
    content_type: 'template',
    content_text: 'Texto de la plantilla',
    template_name: templateName,
    interactive_reply_id: null,
    reply_to_message_id: null,
  })
  return id
}
```

2. En el tipo de `input` de `send` y de `sendHuman`, agrega `replyTo?: string | null` (`{ text?: string; replyId?: string | null; replyTo?: string | null }`).

3. Agrega, justo antes de `describe('recordatorio con un humano a cargo del chat (D1)'`:

```ts
describe('etiquetas de botón de plantilla (Confirmar / Reprogramar / Cancelar)', () => {
  function pendingSeed() {
    const seed = baseSeed()
    seed.booking_appointments = [
      appointmentRow({ status: 'pending', confirmed_at: null }),
    ]
    return seed
  }

  it.each(['recordatorio_cita', 'recordatorio_cita_clinica'])(
    'la etiqueta que responde a la plantilla %s confirma la cita',
    async (templateName) => {
      const db = makeFakeDb(pendingSeed())
      const rec = makeRecorder()
      const replyTo = seedTemplateMessage(db, templateName)

      const res = await send(db, rec, { replyId: 'Confirmar', replyTo })

      expect(res.consumed).toBe(true)
      expect(db._tables.booking_appointments[0].status).toBe('confirmed')
      expect(last(rec).bodyText).toContain('Queda confirmado')
      expect(sessionRow(db)).toBeUndefined()
    },
  )

  it('la etiqueta de un hilo con humano también vale si responde al recordatorio', async () => {
    const db = makeFakeDb(pendingSeed())
    const rec = makeRecorder()
    const replyTo = seedTemplateMessage(db, 'recordatorio_cita')

    const res = await sendHuman(db, rec, { replyId: 'Confirmar', replyTo })

    expect(res.consumed).toBe(true)
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
  })

  it.each(['Confirmar', 'Reprogramar', 'Cancelar'])(
    'la etiqueta %s de OTRA plantilla no toca nada y no se consume',
    async (label) => {
      const db = makeFakeDb(pendingSeed())
      const rec = makeRecorder()
      const replyTo = seedTemplateMessage(db, 'promo_noviembre')

      const res = await send(db, rec, { replyId: label, replyTo })

      expect(res.consumed).toBe(false)
      expect(rec.calls).toHaveLength(0)
      expect(db._tables.booking_appointments[0].status).toBe('pending')
      expect(db._tables.booking_events ?? []).toHaveLength(0)
      expect(sessionRow(db)).toBeUndefined()
    },
  )

  it('la etiqueta sin referencia al mensaje al que responde no toca nada', async () => {
    const db = makeFakeDb(pendingSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'Confirmar' })

    expect(res.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_appointments[0].status).toBe('pending')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('la etiqueta cuyo mensaje citado no existe en esta conversación no toca nada', async () => {
    const db = makeFakeDb(pendingSeed())
    const rec = makeRecorder()
    const elsewhere = seedTemplateMessage(db, 'recordatorio_cita', 'cv-otra')

    const unknown = await send(db, rec, { replyId: 'Confirmar', replyTo: 'msg-no-existe' })
    const foreign = await send(db, rec, { replyId: 'Confirmar', replyTo: elsewhere })

    expect(unknown.consumed).toBe(false)
    expect(foreign.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_appointments[0].status).toBe('pending')
  })

  it('en un hilo con humano, la etiqueta de otra plantilla ni se atiende ni se consume', async () => {
    const db = makeFakeDb(pendingSeed())
    const rec = makeRecorder()
    const replyTo = seedTemplateMessage(db, 'promo_noviembre')

    const withReference = await sendHuman(db, rec, { replyId: 'Cancelar', replyTo })
    const withoutReference = await sendHuman(db, rec, { replyId: 'Cancelar' })

    expect(withReference.consumed).toBe(false)
    expect(withoutReference.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.booking_appointments[0].status).toBe('pending')
    expect(sessionRow(db)).toBeUndefined()
  })

  it('con una cita ya cancelada, la etiqueta de otra plantilla no responde "ya no está activo"', async () => {
    const seed = baseSeed()
    seed.booking_appointments = [appointmentRow({ status: 'cancelled' })]
    const db = makeFakeDb(seed)
    const rec = makeRecorder()
    const replyTo = seedTemplateMessage(db, 'promo_noviembre')

    const res = await send(db, rec, { replyId: 'Confirmar', replyTo })

    expect(res.consumed).toBe(false)
    expect(rec.calls).toHaveLength(0)
  })

  it('un id rem:* no necesita citar nada', async () => {
    const db = makeFakeDb(pendingSeed())
    const rec = makeRecorder()

    const res = await send(db, rec, { replyId: 'rem:confirm' })

    expect(res.consumed).toBe(true)
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
  })
})
```

En `src/verticals/agenda/agent/reminders.test.ts`: agrega `isReminderTemplateName` al import de `./reminders` y esta prueba dentro de `describe('builders del recordatorio')`, después de "la plantilla documentada usa el idioma es":

```ts
  it('reconoce solo las plantillas de recordatorio de cita', () => {
    expect(isReminderTemplateName('recordatorio_cita')).toBe(true)
    expect(isReminderTemplateName('recordatorio_cita_clinica')).toBe(true)
    expect(isReminderTemplateName('promo_noviembre')).toBe(false)
    expect(isReminderTemplateName('Recordatorio_Cita')).toBe(false)
    expect(isReminderTemplateName('')).toBe(false)
    expect(isReminderTemplateName(null)).toBe(false)
    expect(isReminderTemplateName(undefined)).toBe(false)
  })
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda/agent`
Expected: FAIL, `parseReminderTap` y `isReminderTemplateName` no existen.

- [ ] **Step 3: Implementa en `state.ts`**

Agrega a `BookingStep`:

```ts
  | 'consent'
  | 'clinic_menu'
  | 'urgency'
  | 'pick_patient'
  | 'new_patient_name'
  | 'pick_appointment'
  | 'marketing_consent'
```

Agrega a `BookingState`, después de `answers?: AnswerMap`:

```ts
  /** Paciente de la cita (módulo clínica). */
  patientId?: string
  /** Página del menú de días, cuando hay más de los que caben en una lista. */
  dayPage?: number
  /** Qué sigue al aceptar la autorización; por defecto, el menú. */
  afterConsent?: 'urgency_book'
  /** Reserva abierta desde el flujo de urgencia: salta al menú de horas. */
  urgent?: boolean
  /** Acción del recordatorio que espera saber sobre cuál cita aplica. */
  reminderAction?: ReminderAction
```

Después de `export const actId = ...`:

```ts
/** Paciente de la lista, o 'new' para registrar a otra persona. */
export const patId = (id: string): string => `pat:${id}`
export const apptId = (id: string): string => `appt:${id}`
```

Reemplaza el bloque de comentario y las funciones de ids del recordatorio, desde `// Ids del recordatorio (Fase 3)` hasta el final de `OPTION_KINDS`, por:

```ts
// Ids del recordatorio (Fase 3)
//
// Los tres botones del recordatorio viajan con id `rem:<acción>`, y con
// `rem:<acción>:<cita>` cuando el negocio tiene varios pacientes por
// número. Una plantilla enviada sin payload devuelve la ETIQUETA del
// botón ("Confirmar"): por eso también se leen las etiquetas. Sin id de
// cita, la cita se resuelve en el controlador.
// ------------------------------------------------------------

export const REMINDER_ACTIONS = ['confirm', 'reschedule', 'cancel'] as const

export type ReminderAction = (typeof REMINDER_ACTIONS)[number]

export const remId = (action: ReminderAction, appointmentId?: string): string =>
  appointmentId ? `rem:${action}:${appointmentId}` : `rem:${action}`

export interface ReminderTap {
  action: ReminderAction
  appointmentId: string | null
  /**
   * El toque llegó como ETIQUETA ("Confirmar"), no como id `rem:*`. Cualquier
   * otra plantilla o difusión puede traer un botón con esa misma etiqueta,
   * así que el controlador solo la acepta si el mensaje responde a un
   * recordatorio.
   */
  viaLabel?: true
}

const REMINDER_LABELS: Readonly<Record<string, ReminderAction>> = {
  Confirmar: 'confirm',
  Reprogramar: 'reschedule',
  Cancelar: 'cancel',
}

/** 'rem:confirm', 'rem:confirm:<id>' o la etiqueta 'Confirmar'; lo demás → null. */
export function parseReminderTap(id: string): ReminderTap | null {
  if (Object.hasOwn(REMINDER_LABELS, id)) {
    return { action: REMINDER_LABELS[id], appointmentId: null, viaLabel: true }
  }
  const [prefix, action, appointmentId] = id.split(':')
  if (prefix !== 'rem') return null
  if (!(REMINDER_ACTIONS as readonly string[]).includes(action)) return null
  return { action: action as ReminderAction, appointmentId: appointmentId || null }
}

export type OptionKind = 'svc' | 'staff' | 'day' | 'slot' | 'act' | 'ans' | 'pat' | 'appt'

const OPTION_KINDS: readonly OptionKind[] = ['svc', 'staff', 'day', 'slot', 'act', 'ans', 'pat', 'appt']
```

Después de `containsHandoffWord`:

```ts
/** ¿El mensaje trae una palabra de urgencia de la clínica? */
export function containsUrgencyWord(text: string, words: readonly string[]): boolean {
  return containsWord(text, words.map(normalizeText))
}
```

En `ACTION_SYNONYMS` **no** van sinónimos de autorización, alarma ni marketing: esos menús los lee `matchDecision`, que no usa sinónimos.

Justo antes de `export interface MatchChoiceArgs`, agrega el bloque de los menús de decisión:

```ts
// ------------------------------------------------------------
// Menús de decisión: autorización de datos, aviso de marketing y signos
// de alarma.
//
// Aquí un malentendido cuesta caro: leer un "no" como "sí" registra una
// autorización que nadie dio, y leer "no puedo respirar" como "ninguno"
// manda a agendar a quien necesita urgencias.
//   - Autorización (consent_*) y aviso de marketing (mkt_*): el SÍ solo llega
//     por TOQUE de botón. Ningún texto acepta, ni "acepto" ni "sí": un texto
//     se lee mal (emojis, tildes, "autorizó", dudas) y una autorización tiene
//     que ser explícita. Un texto con una negación en cualquier parte es un
//     rechazo ("acepto, no hay problema" también); cualquier otro, null: el
//     bot vuelve a mostrar los botones y a la segunda pasa a una persona.
//   - Signos de alarma (alarm_*): descartarlos (alarm_no) exige el toque o un
//     mensaje completo de una lista cerrada y SIN emojis ni símbolos
//     ("ninguno 🤔" no descarta nada). Va a una persona (alarm_yes) un toque,
//     un mensaje de otra lista cerrada, una negación dentro de una frase
//     ("no puedo respirar") o un signo dicho con palabras ("fiebre alta"):
//     ante la duda, no se agenda. Lo demás ("tengo mucho dolor"), null.
// Estos botones no muestran números, así que un número tampoco acepta ni
// descarta nada. Un toque de botón (replyId) no pasa por aquí y siempre vale.
// ------------------------------------------------------------

/** Opciones que aceptan o descartan: no se eligen por número ni por texto suelto. */
const ACCEPTING_IDS: ReadonlySet<string> = new Set(['act:consent_yes', 'act:mkt_yes', 'act:alarm_no'])

/** Mensajes completos que descartan los signos de alarma, ya en forma `squash`. */
const ALARM_NO_WHOLE: readonly string[] = [
  'no',
  'no ninguno',
  'ninguno',
  'ninguna',
  'no ninguna',
  'no tengo',
  'no tengo ninguno',
  'no tengo ninguna',
  'no tengo nada',
  'nada',
  'ninguno de esos',
  'ninguna de esas',
  'ninguno de los anteriores',
  'no ninguno de esos',
  'no ninguna de esas',
  'no tengo ninguno de esos',
  'no tengo ninguna de esas',
  'no no',
  'no no tengo',
  'nop',
  'nope',
  'noo',
  'no gracias',
  'no senor',
  'no senora',
  'nada de eso',
  'no nada de eso',
]

/**
 * El texto ORIGINAL solo trae letras, números, espacios y puntuación simple.
 * `squash` borra emojis y símbolos, así que sin esta comprobación "ninguno 🤔"
 * parecería un "ninguno" limpio.
 */
const PLAIN_TEXT = /^[\p{L}\p{N}\s.,;:!¡]+$/u

/** Un signo de alarma dicho con palabras (texto ya normalizado). */
const ALARM_SIGNS = /\b(si|respir\w*|trag\w*|sangr\w*|hinch\w*|inflam\w*|fiebre|golpe\w*|ahog\w*)\b/

/** Mensajes completos que dicen que sí hay signos de alarma. */
const ALARM_YES_WHOLE: readonly string[] = ['si', 'si tengo', 'si tengo alguno', 'tengo alguno']

/** Negaciones en texto ya normalizado: "noo", "nop", "para nada", "nunca"… */
const NEGATION = /\b(no+|nop|nope|ni|nunca|jamas|tampoco|nada)\b/

/**
 * Lee la respuesta escrita a un menú de decisión. `undefined` = el menú no
 * es de decisión y sigue el emparejamiento normal; `null` = no se entendió.
 */
function matchDecision(
  text: string,
  squashed: string,
  offered: ReadonlySet<string>,
): string | null | undefined {
  for (const [yes, no] of [
    ['act:consent_yes', 'act:consent_no'],
    ['act:mkt_yes', 'act:mkt_no'],
  ] as const) {
    if (!offered.has(yes) && !offered.has(no)) continue
    return offered.has(no) && NEGATION.test(squashed) ? no : null
  }

  if (offered.has('act:alarm_yes') || offered.has('act:alarm_no')) {
    // Con "?" no hay respuesta: "¿ninguno?" es una pregunta (y "?" no pasa PLAIN_TEXT).
    if (offered.has('act:alarm_no') && PLAIN_TEXT.test(text) && ALARM_NO_WHOLE.includes(squashed)) {
      return 'act:alarm_no'
    }
    if (
      offered.has('act:alarm_yes') &&
      (ALARM_YES_WHOLE.includes(squashed) || NEGATION.test(squashed) || ALARM_SIGNS.test(squashed))
    ) {
      return 'act:alarm_yes'
    }
    return null
  }

  return undefined
}
```

En `matchChoice`, la rama del número pasa a no dejar que un número acepte:

```ts
  // Número del menú ('2', '2.', '2)').
  const num = t.match(/^(\d+)[.)]?$/)
  if (num) {
    const idx = Number(num[1]) - 1
    const id = idx >= 0 && idx < options.length ? options[idx].id : null
    // Los botones de decisión no muestran números: un número no puede aceptar
    // (ni descartar los signos de alarma).
    return id && !ACCEPTING_IDS.has(id) ? id : null
  }
```

Y justo después de `const squashed = squash(text)` / `if (!squashed) return null`, antes de "Título exacto…":

```ts
  const offered = new Set(options.map((o) => o.id))

  // Autorización, marketing y signos de alarma: ver `matchDecision`. Su
  // respuesta es final, así que NO caen a la coincidencia suelta por título
  // ("acep" estaría dentro de "sí acepto").
  const decision = matchDecision(text, squashed, offered)
  if (decision !== undefined) return decision
```

(la línea `const offered = ...` que había más abajo, antes de los sinónimos, se elimina).

En `EXTRA_INTENT_STOPLIST`, al final, para que "gracias por la atención" no abra el flujo en una clínica que llama "atención" a su servicio:

```ts
  // Una clínica llama "atención" a su servicio, y "gracias por la atención"
  // no es un pedido de cita.
  'atencion',
  'atenciones',
```

- [ ] **Step 4: Recordatorios y lectura del mensaje**

En `src/verticals/agenda/agent/reminders.ts`, después de `AGENDA_REMINDER_TEMPLATE`:

```ts
/** Plantilla del recordatorio de las clínicas (módulo clínica). */
export const CLINIC_REMINDER_TEMPLATE_NAME = 'recordatorio_cita_clinica'

const REMINDER_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  AGENDA_REMINDER_TEMPLATE.name,
  CLINIC_REMINDER_TEMPLATE_NAME,
])

/** ¿Es el nombre de una plantilla de recordatorio de cita? */
export function isReminderTemplateName(name: string | null | undefined): boolean {
  return typeof name === 'string' && REMINDER_TEMPLATE_NAMES.has(name)
}
```

En `src/verticals/agenda/agent/db.ts`, reemplaza `loadInboundMessage` por (el webhook guarda en `reply_to_message_id` el id **interno** del mensaje citado, no el wamid):

```ts
export interface InboundMessage {
  text: string
  replyId: string | null
  /**
   * `template_name` del mensaje al que responde el cliente (un toque en el
   * botón de una plantilla llega como respuesta a ella). null si no responde
   * a ninguno, si ese mensaje no está en ESTA conversación o si no es una
   * plantilla.
   */
  repliedTemplateName: string | null
}

export async function loadInboundMessage(
  db: SupabaseClient,
  conversationId: string,
  messageId: string,
): Promise<InboundMessage | null> {
  const { data } = await db
    .from('messages')
    .select('content_text, interactive_reply_id, reply_to_message_id')
    .eq('conversation_id', conversationId)
    .eq('message_id', messageId)
    .maybeSingle()
  if (!data) return null
  const row = data as Record<string, unknown>

  // El webhook guarda en `reply_to_message_id` el id INTERNO (messages.id) del
  // mensaje citado, no el wamid.
  const repliedToId = (row.reply_to_message_id as string | null) ?? null
  let repliedTemplateName: string | null = null
  if (repliedToId) {
    const { data: parent } = await db
      .from('messages')
      .select('template_name')
      .eq('id', repliedToId)
      .eq('conversation_id', conversationId)
      .maybeSingle()
    repliedTemplateName =
      ((parent as Record<string, unknown> | null)?.template_name as string | null) ?? null
  }

  return {
    text: (row.content_text as string | null) ?? '',
    replyId: (row.interactive_reply_id as string | null) ?? null,
    repliedTemplateName,
  }
}
```

- [ ] **Step 5: Ajusta el controlador**

En `src/verticals/agenda/agent/controller.ts`:

1. Cambia `parseReminderId` por `parseReminderTap` y `type ReminderAction` por `type ReminderAction, type ReminderTap` en el import de `./state`. Agrega:

```ts
import { isReminderTemplateName } from './reminders'
```

2. En `handleAgendaInbound`:

```ts
  // Una ETIQUETA ("Confirmar") la puede traer el botón de cualquier otra
  // plantilla o difusión: solo es un toque de recordatorio si el mensaje
  // responde a una plantilla de recordatorio. Los ids `rem:*` los pone este
  // módulo, no necesitan esa comprobación. Sin referencia o con otra
  // plantilla, el mensaje sigue el camino normal.
  const parsedTap = replyId ? parseReminderTap(replyId) : null
  const reminderTap =
    parsedTap && (!parsedTap.viaLabel || isReminderTemplateName(inbound?.repliedTemplateName))
      ? parsedTap
      : null
```

3. Usa `reminderTap` donde decía `reminderAction`:

```ts
  if (
    humanOwned &&
    !reminderTap &&
    !isCancelConfirmTap(args.session ?? null, replyId)
  ) {
    return { consumed: false }
  }
```

```ts
  if (reminderTap) {
    await handleReminderTap(dialog, args.session ?? null, reminderTap, humanOwned)
    return { consumed: true }
  }
```

4. Cambia `handleReminderTap` para que reciba `tap: ReminderTap`, y dentro use `const action = tap.action` al inicio. El resto de la función no cambia en esta tarea.

5. En `coerceState`, antes del cierre del objeto:

```ts
    ...(typeof raw.patientId === 'string' ? { patientId: raw.patientId } : {}),
    ...(typeof raw.dayPage === 'number' ? { dayPage: raw.dayPage } : {}),
    ...(raw.afterConsent === 'urgency_book' ? { afterConsent: 'urgency_book' as const } : {}),
    ...(raw.urgent === true ? { urgent: true } : {}),
    ...(typeof raw.reminderAction === 'string'
      ? { reminderAction: raw.reminderAction as ReminderAction }
      : {}),
```

6. En `renderStep`, agrega al final del `switch` (la tarea 7 lo reemplaza):

```ts
    case 'consent':
    case 'clinic_menu':
    case 'urgency':
    case 'pick_patient':
    case 'new_patient_name':
    case 'pick_appointment':
    case 'marketing_consent':
      return { state, closed: true }
```

- [ ] **Step 6: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(agenda): read reminder taps by label and by appointment id"
```

---

### Task 7: Autorización y menú principal

**Files:**
- Create: `src/modules/clinica/consent.ts`, `src/modules/clinica/consent.test.ts`, `src/modules/clinica/ai-gate.ts`, `src/modules/clinica/ai-gate.test.ts`, `src/verticals/agenda/agent/steps/clinic-steps.ts`, `src/verticals/agenda/agent/steps/clinic-steps.test.ts`, `src/verticals/agenda/agent/testing/clinic-harness.ts`, `src/verticals/agenda/agent/clinic-consent.test.ts`, `src/verticals/agenda/agent/clinic-topics.test.ts`, `src/verticals/agenda/agent/index.test.ts`, `src/app/api/ai/draft/route.test.ts`
- Modify: `src/verticals/agenda/agent/controller.ts`, `src/verticals/agenda/agent/index.ts`, `src/verticals/agenda/agent/state.ts`, `src/modules/clinica/texts.ts`, `src/lib/verticals/types.ts`, `src/lib/verticals/dispatch.ts`, `src/lib/ai/auto-reply.ts`, `src/app/api/ai/draft/route.ts`, `messages/{en,es,pt,ko}.json`, y las pruebas `state.test.ts`, `texts.test.ts`, `dispatch.test.ts` y `auto-reply.test.ts`

Reglas que fija esta tarea, todas con prueba. Salen del diseño y de la revisión de la tarea:

**La IA no ve lo que no se autorizó**
1. **El primer mensaje, sea el que sea, recibe la autorización.** En una cuenta con `clinica`, hasta que la persona acepta, el bot consume todo lo que escribe. La excepción son las quejas, pagos y documentos (regla 9), que pasan a una persona sin pedirla.
2. **La IA lo comprueba por su cuenta.** `canUseAi` (`src/modules/clinica/ai-gate.ts`) se pregunta en los dos lugares donde la IA lee un chat: la respuesta automática (`auto-reply.ts`, justo después de `loadAiConfig`) y "Sugerir con IA" (`/api/ai/draft`, que responde 403 con un mensaje claro). No basta con el bot: el despachador deja pasar el mensaje a la IA cuando falla la lectura de módulos (`postgrest-js` devuelve `{ error }` sin lanzar), y una cuenta que solo tiene `clinica` no llega a ningún bot. `canUseAi` falla cerrado: una cuenta o una autorización que no se pueden leer son un no. Una cuenta sin `clinica` solo paga la lectura de la cuenta.
3. **Falla cerrado ante una configuración que falta.** `loadClinicContext` devuelve `ok`, `missing` o `error`. Con el módulo activo y `missing` o `error`, el bot consume el mensaje, deja el hilo con una persona (`performHandoff`, con una nota clara) y no sigue como una agenda normal. Si el texto trae una palabra de `DEFAULT_URGENCY_WORDS` (las de la clínica no se pudieron leer), el aviso al equipo es el de urgencia. Los toques de recordatorio se siguen atendiendo, y un hilo que ya es de una persona no se toca.
4. **Un error inesperado tampoco abre la puerta.** El dispatcher devuelve `consumed: false` si un handler lanza, y entonces la IA vería el mensaje. En `agendaInboundHandler`, solo en cuentas con `clinica`, el error se registra, se avisa con `notifyAlert` (sin números largos: un error de la base puede repetir el teléfono del paciente) y el mensaje se da por consumido. Las demás cuentas siguen lanzando como hoy. El `catch` vive en `failClosed` para que la tarea 13 lo conserve.

**La autorización**
5. **Solo se acepta por toque, y ningún número decide nada.** Ningún texto acepta (`matchChoice`). Un texto con una negación queda como rechazo; cualquier otro vuelve a mostrar los botones y, a la segunda vez, pasa a una persona, con una nota que dice que la autorización quedó sin responder. Escribir `2` no registra un rechazo en un registro de solo agregar: `act:consent_no` y `act:mkt_no` tampoco se eligen por número.
6. **El registro dice lo que la persona vio.** El texto y la versión que se le mostraron viajan en el estado de la sesión (`consentText`, `consentVersion`) y son los que se guardan al responder, aunque la clínica edite su texto entre tanto. `contact_ref` sale del contacto (teléfono, o `wa_user_id`); si no tiene ninguno, `recordConsent` lanza y no se guarda nada.
7. **Los pasos clínicos no olvidan sus fallos al acertar.** Si la base rechaza el registro, el segundo toque en un mismo paso pasa a una persona en vez de repetir "intenta de nuevo" para siempre. Lo que avanza a otro paso nace con 0.
8. **Un doble toque no es un error.** Un `act:consent_*` con el menú ya abierto se ignora en silencio.

**El menú y lo que no es del bot**
9. **Quejas, pagos y documentos van a una persona** (spec §5, etapa 2), solo en clínicas: `CLINIC_HUMAN_WORDS`. Si el texto trae una y no parece una duda, pase con nota clara. Va al nivel del pase a una persona: no espera la autorización y no se aplica mientras se escribe un nombre o una respuesta.
10. **Una duda no es un fallo.** Una duda escrita con el menú abierto cierra la sesión y se suelta a la IA. "Precios y dudas" deja la sesión en `faq_open`, y el siguiente texto, diga lo que diga, cierra la sesión y va a la IA. El dispatcher reclama todo lo que llega con una sesión abierta, así que el resultado lleva `released: true` y el dispatcher lo respeta. Un toque sigue el camino normal.
11. **`looksLikeQuestion` distingue pedir de preguntar.** Quita la puntuación antes de leer la primera palabra; un verbo de pedir (`quiero`, `quisiera`, `necesito`, `me das`, `me da`, `puedo agendar`) gana sobre la forma de pregunta; sin signo de pregunta, nombrar la cita la pide. Los saludos (`buenas`, `buenos días`...) abren el menú solo en clínicas.
12. **El aviso de urgencia no se pierde.** Un pase con aviso propio le llega siempre al dueño, aunque también sea el agente de pase (el trigger solo le dice que le asignaron un chat), y al agente si es otra persona.
13. **Más formas de decir urgencia:** `fracturo`, `doliendo`, `dolio`, `golpee`, `calentura`.
14. **Una cuenta sin `clinica` se comporta exactamente igual que hoy.** No lee la configuración de la clínica, no pide autorización y no cambia ningún paso.

- [ ] **Step 1: Crea las utilidades de prueba**

Crea `src/verticals/agenda/agent/testing/clinic-harness.ts`:

```ts
// ============================================================
// Utilidades de prueba del flujo clínico: cuenta con el módulo, un
// grabador de mensajes y un envío como lo haría el dispatcher.
// ============================================================

import type { ModuleKey, VerticalSession } from '@/lib/verticals/types'

import { handleAgendaInbound, type AgendaSender } from '../controller'
import { asClient, makeFakeDb, type FakeDb, type Row } from './fake-db'

export const ACCOUNT = 'acc-1'
export const CONTACT = 'ct-1'
export const CONVERSATION = 'cv-1'
export const OWNER = 'user-owner'
export const SERVICE_LIMPIEZA = 'svc-limpieza'
export const SERVICE_URGENCIA = 'svc-urgencia'
export const STAFF_ANA = 'st-ana'
export const LOCATION = 'loc-1'

/** Lunes 19 de octubre de 2026, 08:00 en Bogotá (13:00Z). */
export const NOW = new Date('2026-10-19T13:00:00Z')

const weekdayHours = (staffId: string): Row[] =>
  [1, 2, 3, 4, 5].map((weekday) => ({
    account_id: ACCOUNT,
    staff_id: staffId,
    weekday,
    start_time: '09:00:00',
    end_time: '12:00:00',
  }))

export function clinicDb(extra: Record<string, Row[]> = {}): FakeDb {
  return makeFakeDb({
    accounts: [{ id: ACCOUNT, default_currency: 'COP', owner_user_id: OWNER }],
    ai_configs: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Marta Ruiz', phone: '573001112233' }],
    conversations: [
      {
        id: CONVERSATION,
        account_id: ACCOUNT,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
        assigned_agent_id: null,
      },
    ],
    booking_services: [
      {
        id: SERVICE_LIMPIEZA,
        account_id: ACCOUNT,
        name: 'Limpieza',
        description: null,
        duration_minutes: 30,
        price: 0,
        is_active: true,
        position: 0,
        prep_instructions: 'Cepíllate antes de venir.',
      },
      {
        id: SERVICE_URGENCIA,
        account_id: ACCOUNT,
        name: 'Urgencia',
        description: null,
        duration_minutes: 30,
        price: 0,
        is_active: true,
        position: 1,
        prep_instructions: null,
      },
    ],
    booking_staff: [
      { id: STAFF_ANA, account_id: ACCOUNT, name: 'Dra. Ana', bio: null, is_active: true, position: 0 },
    ],
    booking_staff_services: [
      { account_id: ACCOUNT, staff_id: STAFF_ANA, service_id: SERVICE_LIMPIEZA },
      { account_id: ACCOUNT, staff_id: STAFF_ANA, service_id: SERVICE_URGENCIA },
    ],
    booking_working_hours: weekdayHours(STAFF_ANA),
    booking_time_off: [],
    booking_appointments: [],
    booking_sessions: [],
    booking_settings: [
      {
        account_id: ACCOUNT,
        bot_texts: {},
        labels: {},
        choose_staff: true,
        show_price: false,
        show_duration: false,
        reminders_enabled: true,
        allow_reschedule: true,
      },
    ],
    booking_questions: [],
    tags: [],
    contact_tags: [],
    notifications: [],
    booking_events: [],
    messages: [],
    pipelines: [],
    clinic_settings: [
      {
        account_id: ACCOUNT,
        consent_text: 'Texto de autorización',
        consent_version: 2,
        urgency_words: ['urgencia', 'dolor'],
        urgency_alarm_text: 'Signos de alarma',
        urgency_service_id: SERVICE_URGENCIA,
        offer_days: 30,
      },
    ],
    clinic_locations: [
      {
        id: LOCATION,
        account_id: ACCOUNT,
        name: 'Centro',
        address: 'Calle 1 # 2-3',
        latitude: 4.6,
        longitude: -74.08,
        on_call_phone: '3001234567',
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    clinic_patients: [],
    clinic_consents: [],
    ...extra,
  })
}

/** Autorización de datos ya dada por el contacto. */
export const grantedConsent = (): Row => ({
  id: 'cons-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  contact_ref: '573001112233',
  kind: 'datos_sensibles',
  granted: true,
  text_version: 2,
  text_snapshot: 'Texto de autorización',
  source: 'whatsapp',
  created_at: '2026-10-01T00:00:00.000Z',
})

export interface SentCall {
  kind: 'text' | 'buttons' | 'list'
  bodyText: string
  ids: string[]
  titles: string[]
}

export function makeRecorder() {
  const calls: SentCall[] = []
  const sender: AgendaSender = {
    sendText: async ({ text }) => {
      calls.push({ kind: 'text', bodyText: text, ids: [], titles: [] })
    },
    sendButtons: async ({ bodyText, buttons }) => {
      calls.push({
        kind: 'buttons',
        bodyText,
        ids: buttons.map((b) => b.id),
        titles: buttons.map((b) => b.title),
      })
    },
    sendList: async ({ bodyText, sections }) => {
      const rows = sections.flatMap((s) => s.rows)
      calls.push({
        kind: 'list',
        bodyText,
        ids: rows.map((r) => r.id),
        titles: rows.map((r) => r.title),
      })
    },
  }
  return { calls, sender }
}

export type Recorder = ReturnType<typeof makeRecorder>

export function last(rec: Recorder): SentCall {
  const call = rec.calls.at(-1)
  if (!call) throw new Error('el bot no envió nada')
  return call
}

function activeSession(db: FakeDb, now: Date): VerticalSession | null {
  const row = db._tables.booking_sessions.find(
    (r) => r.status === 'active' && String(r.expires_at) > now.toISOString(),
  )
  return row
    ? {
        id: row.id as string,
        state: (row.state ?? {}) as Record<string, unknown>,
        expiresAt: row.expires_at as string,
      }
    : null
}

let counter = 0

export async function send(
  db: FakeDb,
  rec: Recorder,
  input: { text?: string; replyId?: string },
  opts: { now?: Date; modules?: ModuleKey[]; humanOwned?: boolean } = {},
) {
  counter += 1
  const messageId = `wamid-${counter}`
  db._tables.messages.push({
    id: `msg-${counter}`,
    conversation_id: CONVERSATION,
    message_id: messageId,
    content_text: input.text ?? '',
    interactive_reply_id: input.replyId ?? null,
  })
  const now = opts.now ?? NOW
  return handleAgendaInbound({
    db: asClient(db),
    sender: rec.sender,
    now,
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    inboundMessageId: messageId,
    session: activeSession(db, now),
    humanOwned: opts.humanOwned,
    modules: opts.modules ?? ['agenda', 'clinica'],
  })
}
```

- [ ] **Step 2: Escribe las pruebas que fallan**

Crea `src/verticals/agenda/agent/clinic-consent.test.ts`. Los textos salen de `buildClinicTexts`, así que la prueba sigue al copy real sin repetirlo:

```ts
import { describe, expect, it } from 'vitest'

import { buildClinicTexts } from '@/modules/clinica/texts'
import { AGENDA_AGENT_TEXTS } from '../texts'
import { DEFAULT_LABELS } from '../labels'

import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  OWNER,
  SERVICE_LIMPIEZA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'

const texts = buildClinicTexts(DEFAULT_LABELS)

const CONSENT_BUTTONS = ['act:consent_yes', 'act:consent_no']
const MENU_IDS = ['act:book', 'act:mine', 'act:faq', 'act:urgent', 'act:human']

/** Una clínica que llama "atención" a su servicio, como el preset de odontología. */
const clinicLabels = {
  account_id: ACCOUNT,
  bot_texts: {},
  labels: { servicio: 'atención', servicios: 'atenciones' },
  choose_staff: true,
  show_price: false,
  show_duration: false,
  reminders_enabled: true,
  allow_reschedule: true,
}

describe('autorización de datos', () => {
  it('el primer mensaje pide autorización antes que nada', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe('Texto de autorización')
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    expect(last(rec).titles).toEqual([texts.consentAccept, texts.consentDecline])
  })

  it('sin autorización, ni una pregunta le llega a la IA', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('sin autorización, un toque de un menú viejo tampoco llega a la IA', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('aceptar guarda la autorización con su versión y abre el menú', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toMatchObject([
      {
        account_id: ACCOUNT,
        contact_id: CONTACT,
        contact_ref: '573001112233',
        kind: 'datos_sensibles',
        granted: true,
        text_version: 2,
        text_snapshot: 'Texto de autorización',
        source: 'whatsapp',
      },
    ])
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(last(rec).bodyText).toBe(texts.menuBody)
  })

  it('guarda el texto que vio la persona, no el que la clínica puso mientras tanto', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    // La clínica edita el texto después de que el paciente lo recibió y antes de que responda.
    db._tables.clinic_settings[0].consent_text = 'Texto nuevo'
    db._tables.clinic_settings[0].consent_version = 3
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents[0]).toMatchObject({
      text_version: 2,
      text_snapshot: 'Texto de autorización',
    })
  })

  it('si lo vuelve a recibir, guarda el texto nuevo que ve ahora', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._tables.clinic_settings[0].consent_text = 'Texto nuevo'
    db._tables.clinic_settings[0].consent_version = 3
    await send(db, rec, { text: 'acepto' })
    expect(last(rec).bodyText).toBe('Texto nuevo')
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents[0]).toMatchObject({
      text_version: 3,
      text_snapshot: 'Texto nuevo',
    })
  })

  it('sin teléfono, la autorización guarda el identificador de WhatsApp del titular', async () => {
    const db = clinicDb({
      contacts: [
        {
          id: CONTACT,
          account_id: ACCOUNT,
          name: 'Marta Ruiz',
          phone: '',
          wa_user_id: 'US.13491208655302741918',
        },
      ],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents[0].contact_ref).toBe('US.13491208655302741918')
  })

  it('sin teléfono ni identificador no hay a nombre de quién guardar: no se registra nada', async () => {
    const db = clinicDb({
      contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Marta Ruiz', phone: '' }],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(rec.calls.some((c) => c.bodyText === texts.consentError)).toBe(true)
    // Vuelve a ofrecer los botones y no abre el menú ni pausa el hilo.
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('si la base rechaza el registro, no hay autorización y se avisa', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(rec.calls.some((c) => c.bodyText === texts.consentError)).toBe(true)
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  it('no aceptar registra la negativa y deja el hilo con una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_no' })
    expect(db._tables.clinic_consents[0].granted).toBe(false)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentDeclinedNote)
    expect(last(rec).bodyText).toBe(texts.consentDeclined)
    expect(db._tables.booking_sessions.every((s) => s.status !== 'active')).toBe(true)
  })

  it('escribir "acepto" no autoriza nada: vuelve a mostrar los botones', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    const result = await send(db, rec, { text: 'acepto' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).bodyText).toBe('Texto de autorización')
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('escribir "acepto" dos veces seguidas pasa el hilo a una persona, sin autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto' })
    await send(db, rec, { text: 'sí, acepto' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('la nota de ese pase dice que la autorización quedó sin responder, no que pidió una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto' })
    await send(db, rec, { text: 'sí, acepto' })
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentUnansweredNote)
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(AGENDA_AGENT_TEXTS.handoffNote)
  })

  it('un texto raro y luego el toque sí autoriza', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: true }])
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('si la base rechaza el registro dos veces seguidas, pasa a una persona (no repite "intenta de nuevo")', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.consentUnansweredNote)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('un fallo al guardar y luego un texto raro también pasa a una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { text: 'acepto' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('un fallo al guardar que se arregla en el segundo toque deja la autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: true }])
    expect(last(rec).ids).toEqual(MENU_IDS)
  })

  it.each(['act:consent_yes', 'act:consent_no'])(
    'un segundo toque (%s) con el menú ya abierto se ignora en silencio',
    async (replyId) => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:consent_yes' })
      const sent = rec.calls.length
      const result = await send(db, rec, { replyId })
      expect(result).toEqual({ consumed: true })
      // Ni mensaje, ni fallo, ni otro registro, ni pase a una persona.
      expect(rec.calls).toHaveLength(sent)
      expect(db._tables.clinic_consents).toHaveLength(1)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      const open = db._tables.booking_sessions.filter((s) => s.status === 'active')
      expect(open.map((s) => (s.state as { step: string; fails: number }).step)).toEqual(['clinic_menu'])
      expect((open[0].state as { fails: number }).fails).toBe(0)
    },
  )

  it('el toque del menú sigue valiendo después de un doble toque', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { replyId: 'act:consent_yes' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).ids[0]).toMatch(/^svc:/)
  })

  it.each(['1', '2', '2.'])(
    'escribir el número "%s" no registra nada: ni acepta ni rechaza',
    async (typed) => {
      const db = clinicDb()
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { text: typed })
      expect(db._tables.clinic_consents).toHaveLength(0)
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
      expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
    },
  )

  it('escribir que no acepta sí queda como negativa', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'no acepto' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: false }])
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('un "acepto, no hay problema" tampoco autoriza', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { text: 'acepto, no hay problema' })
    expect(db._tables.clinic_consents).toMatchObject([{ granted: false }])
  })

  it('con autorización, un saludo abre el menú sin volver a pedirla', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(last(rec).ids).toEqual(MENU_IDS)
    expect(db._tables.clinic_consents).toHaveLength(1)
  })

  it('si el paciente la rechazó antes y el hilo se reabre, la vuelve a pedir', async () => {
    const db = clinicDb({
      clinic_consents: [{ ...grantedConsent(), granted: false }],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(last(rec).ids).toEqual(CONSENT_BUTTONS)
  })

  describe('con autorización, qué abre el menú y qué va a la IA', () => {
    it.each([
      'quiero una cita',
      'necesito cita para mi hijo',
      'cita',
      'hola',
      'buenas',
      'Buenos días',
      'buenas tardes',
      'Buenas noches',
      '¿me das una cita?',
      '¿puedo agendar una cita para mañana?',
      'Qué pena, necesito una cita',
      'Tienen citas disponibles',
    ])('abre el menú: %j', async (text) => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(MENU_IDS)
    })

    it.each([
      '¿Cuánto vale una cita de valoración?',
      'Buenos días, ¿cuánto vale la limpieza?',
      '¿Tienen citas disponibles?',
    ])('va a la IA: %j', async (text) => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      const result = await send(db, rec, { text })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
    })

    it('usa la palabra que la clínica le da a la cita', async () => {
      const db = clinicDb({
        clinic_consents: [grantedConsent()],
        booking_settings: [{ ...clinicLabels, labels: { cita: 'turno', citas: 'turnos' } }],
      })
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'Tienen turnos disponibles' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(MENU_IDS)
    })

    it('los saludos abren el menú solo en una clínica', async () => {
      const db = clinicDb()
      const rec = makeRecorder()
      const result = await send(db, rec, { text: 'buenas tardes' }, { modules: ['agenda'] })
      expect(result).toEqual({ consumed: false })
      expect(rec.calls).toHaveLength(0)
    })
  })

  it('con autorización, una pregunta pasa a la IA', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una cita de valoración?' })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })

  it('con autorización, "gracias por la atención" no abre el menú', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_settings: [clinicLabels],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Muchas gracias por la atención' })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })

  it('con autorización, "gracias por las atenciones" tampoco abre el menú', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_settings: [clinicLabels],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'gracias por las atenciones' })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })

  describe('dudas con el menú abierto', () => {
    const activeSteps = (db: ReturnType<typeof clinicDb>) =>
      db._tables.booking_sessions
        .filter((s) => s.status === 'active')
        .map((s) => (s.state as { step: string }).step)

    it('una duda escrita con el menú abierto suelta la sesión y se la deja a la IA', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      const before = rec.calls.length
      const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' })
      // `released` le dice al despachador que no la reclame por tener sesión.
      expect(result).toEqual({ consumed: false, released: true })
      expect(rec.calls).toHaveLength(before)
      expect(activeSteps(db)).toEqual([])
      expect(db._tables.booking_sessions[0].status).toBe('completed')
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    })

    it('"qué precio tiene" sin signos también es una duda', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      const result = await send(db, rec, { text: 'qué precio tiene la limpieza' })
      expect(result).toEqual({ consumed: false, released: true })
    })

    it('lo que no parece una duda sigue el camino de siempre: se vuelve a preguntar', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      const result = await send(db, rec, { text: 'mmm' })
      expect(result).toEqual({ consumed: true })
      expect(activeSteps(db)).toEqual(['clinic_menu'])
    })

    it('un toque del menú sigue su camino', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      const result = await send(db, rec, { replyId: 'act:book' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids[0]).toMatch(/^svc:/)
    })

    it('"Precios y dudas" invita a preguntar y deja la sesión esperando la duda', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:faq' })
      expect(last(rec).bodyText).toBe(texts.faqPrompt)
      expect(activeSteps(db)).toEqual(['faq_open'])
    })

    it('el siguiente texto, aunque diga "cita", va a la IA y cierra la sesión', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:faq' })
      const before = rec.calls.length
      const result = await send(db, rec, { text: 'quiero saber cuánto vale la cita de valoración' })
      expect(result).toEqual({ consumed: false, released: true })
      expect(rec.calls).toHaveLength(before)
      expect(activeSteps(db)).toEqual([])
    })

    it('después de la duda, "cita" vuelve a abrir el menú', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:faq' })
      await send(db, rec, { text: 'cuánto vale' })
      const result = await send(db, rec, { text: 'quiero una cita' })
      expect(result).toEqual({ consumed: true })
      expect(last(rec).ids).toEqual(MENU_IDS)
    })

    it('un toque viejo mientras espera la duda sigue el camino normal, no la suelta', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:faq' })
      const result = await send(db, rec, { replyId: 'act:book' })
      expect(result).toEqual({ consumed: true })
      expect(activeSteps(db)).toEqual(['faq_open'])
    })

    it('pedir una persona mientras espera la duda sigue ganando', async () => {
      const db = clinicDb({ clinic_consents: [grantedConsent()] })
      const rec = makeRecorder()
      await send(db, rec, { text: 'Hola' })
      await send(db, rec, { replyId: 'act:faq' })
      const result = await send(db, rec, { text: 'mejor quiero hablar con una persona' })
      expect(result).toEqual({ consumed: true })
      expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    })
  })

  it('"Hablar con una persona" pasa el hilo a un asesor', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:human' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('una cuenta sin el módulo no pide autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).ids[0]).toMatch(/^svc:/)
  })

  it('una cuenta sin el módulo no lee la configuración de la clínica', async () => {
    // Sin el módulo, ni la fila que falta ni un fallo de lectura cambian nada.
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).ids[0]).toMatch(/^svc:/)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })
})

describe('la clínica no está disponible', () => {
  const urgencyNotification = (db: ReturnType<typeof clinicDb>) =>
    db._tables.notifications.find((n) => n.title === texts.urgencyNotificationTitle)

  it('sin configuración, el bot consume el mensaje y lo deja con una persona', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableNote)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
    // Sin configuración tampoco se sabe qué autorización pedir.
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
  })

  it('si la configuración no se pudo leer, igual: consume y pasa a una persona', async () => {
    const db = clinicDb()
    db._failNext('select', 'clinic_settings', { message: 'connection reset' })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una limpieza?' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableNote)
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('una configuración sin textos tampoco se usa', async () => {
    const db = clinicDb({
      clinic_settings: [
        {
          account_id: ACCOUNT,
          consent_text: '   ',
          consent_version: 1,
          urgency_words: [],
          urgency_alarm_text: 'Signos de alarma',
          urgency_service_id: null,
          offer_days: 30,
        },
      ],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(rec.calls.every((c) => c.bodyText !== '   ')).toBe(true)
  })

  it('aunque el paciente ya haya autorizado, no sigue sin saber cómo está configurada la clínica', async () => {
    const db = clinicDb({ clinic_settings: [], clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Atienden hoy?' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('un toque de un menú viejo también queda con una persona', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'act:book' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('avisa al dueño con el aviso normal de un asesor', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(db._tables.notifications).toHaveLength(1)
    expect(db._tables.notifications[0]).toMatchObject({
      user_id: OWNER,
      conversation_id: CONVERSATION,
      title: AGENDA_AGENT_TEXTS.handoffNotificationTitle,
    })
    expect(urgencyNotification(db)).toBeUndefined()
  })

  it('si el mensaje trae una palabra de urgencia, usa el aviso prioritario', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Tengo mucho dolor de muela' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.clinicUnavailableUrgentNote)
    expect(db._tables.notifications).toHaveLength(1)
    expect(urgencyNotification(db)).toMatchObject({
      user_id: OWNER,
      body: texts.urgencyNotificationBody('Marta Ruiz'),
    })
  })

  describe('quién recibe el aviso cuando el dueño también es el agente de pase', () => {
    const AGENT = 'user-agent'
    const withAgent = (agentId: string) =>
      clinicDb({
        clinic_settings: [],
        ai_configs: [{ account_id: ACCOUNT, handoff_agent_id: agentId }],
      })
    const titlesFor = (db: ReturnType<typeof clinicDb>, userId: string) =>
      db._tables.notifications.filter((n) => n.user_id === userId).map((n) => n.title)

    it('el aviso de urgencia le llega al dueño aunque sea quien atiende', async () => {
      const db = withAgent(OWNER)
      await send(db, makeRecorder(), { text: 'Tengo mucho dolor de muela' })
      expect(db._tables.conversations[0].assigned_agent_id).toBe(OWNER)
      expect(titlesFor(db, OWNER)).toEqual([texts.urgencyNotificationTitle])
    })

    it('si el agente es otra persona, los dos reciben el aviso de urgencia', async () => {
      const db = withAgent(AGENT)
      await send(db, makeRecorder(), { text: 'Tengo mucho dolor de muela' })
      expect(titlesFor(db, OWNER)).toEqual([texts.urgencyNotificationTitle])
      expect(titlesFor(db, AGENT)).toEqual([texts.urgencyNotificationTitle])
    })

    it('un pase normal sigue como antes: si el dueño es el agente, lo avisa la asignación', async () => {
      const db = withAgent(OWNER)
      await send(db, makeRecorder(), { text: 'Hola' })
      expect(db._tables.notifications).toHaveLength(0)
    })

    it('un pase normal con otro agente solo avisa al dueño', async () => {
      const db = withAgent(AGENT)
      await send(db, makeRecorder(), { text: 'Hola' })
      expect(titlesFor(db, OWNER)).toEqual([AGENDA_AGENT_TEXTS.handoffNotificationTitle])
      expect(titlesFor(db, AGENT)).toEqual([])
    })
  })

  it('las palabras de urgencia son las de siempre, no las de una configuración que no se pudo leer', async () => {
    const db = clinicDb()
    db._failNext('select', 'clinic_settings', { message: 'timeout' })
    const rec = makeRecorder()
    await send(db, rec, { text: 'me sangran las encías' })
    expect(urgencyNotification(db)).toBeDefined()
  })

  it('una sesión a medias se cierra al pasar a la persona', async () => {
    const db = clinicDb({
      clinic_settings: [],
      booking_sessions: [
        {
          id: 'ses-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'active',
          expires_at: '2026-10-19T13:10:00.000Z',
          state: { step: 'pick_service', mode: 'book', options: [], fails: 0 },
        },
      ],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
  })

  it('los toques de un recordatorio se siguen atendiendo', async () => {
    const db = clinicDb({
      clinic_settings: [],
      booking_appointments: [
        {
          id: 'ap-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          service_id: SERVICE_LIMPIEZA,
          staff_id: STAFF_ANA,
          starts_at: '2026-10-20T15:00:00.000Z',
          ends_at: '2026-10-20T15:30:00.000Z',
          status: 'pending',
          answers: {},
        },
      ],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { replyId: 'rem:confirm' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.booking_appointments[0].status).toBe('confirmed')
    expect(last(rec).bodyText).toContain('Queda confirmado')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('si una persona ya tiene el hilo, no lo toca ni repite el aviso', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola' }, { humanOwned: true })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.notifications).toHaveLength(0)
  })

  it('en una cuenta sin el módulo, una clínica sin configurar no cambia nada', async () => {
    const db = clinicDb({ clinic_settings: [] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(db._tables.notifications).toHaveLength(0)
  })
})
```

Crea `src/verticals/agenda/agent/clinic-topics.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { CLINIC_HUMAN_WORDS, buildClinicTexts } from '@/modules/clinica/texts'

import { DEFAULT_LABELS } from '../labels'
import { AGENDA_AGENT_TEXTS } from '../texts'
import {
  ACCOUNT,
  CONTACT,
  clinicDb,
  grantedConsent,
  makeRecorder,
  send,
  last,
} from './testing/clinic-harness'

const texts = buildClinicTexts(DEFAULT_LABELS)

const session = (state: Record<string, unknown>) => ({
  id: 'ses-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  status: 'active',
  expires_at: '2026-10-19T13:10:00.000Z',
  state: { mode: 'book', options: [], fails: 0, ...state },
})

describe('quejas, pagos y documentos van a una persona', () => {
  it('la lista tiene lo que pide la spec, sin tildes', () => {
    expect([...CLINIC_HUMAN_WORDS]).toEqual([
      'queja',
      'reclamo',
      'pqr',
      'pqrs',
      'factura',
      'pago',
      'pagar',
      'abono',
      'saldo',
      'certificado',
      'incapacidad',
      'historia clinica',
      'radiografia',
      'receta',
      'documento',
      'documentos',
    ])
  })

  it.each([
    'Tengo una queja del servicio',
    'Quiero poner un reclamo',
    'Necesito radicar una PQR',
    'Una pqrs por favor',
    'Necesito mi factura',
    'Quiero hacer el pago',
    'Voy a pagar hoy',
    'Hice un abono ayer',
    'Quiero saber mi saldo',
    'Necesito un certificado',
    'Necesito la incapacidad',
    'Mi historia clínica, por favor',
    'Necesito la radiografía de mi hijo',
    'Necesito una receta',
    'Envíenme el documento',
    'Documentos para el seguro',
    'Hola, quiero pagar mi factura',
  ])('un mensaje que no es una duda pasa a una persona: %j', async (text) => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.conversations[0].ai_handoff_summary).toBe(texts.humanTopicNote)
    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.handoff)
  })

  it('no necesita autorización: nadie con una queja se queda atascado en un aviso legal', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Tengo una queja de mi última cita' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(db._tables.booking_sessions).toHaveLength(0)
    expect(rec.calls.every((c) => !c.ids.includes('act:consent_yes'))).toBe(true)
  })

  it('con una sesión abierta también pasa a una persona y la cierra', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session({ step: 'clinic_menu' })],
    })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Necesito mi factura' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.booking_sessions[0].status).toBe('cancelled')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it.each([
    '¿Cuánto cuesta el certificado?',
    '¿Puedo pagar con tarjeta?',
    'cómo pago',
    'qué documentos piden para el primer día',
    'dónde recojo mi factura',
  ])('una duda va a la IA: %j', async (text) => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text })
    expect(result).toEqual({ consumed: false })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(rec.calls).toHaveLength(0)
  })

  it('un verbo de pedir gana sobre la forma de pregunta', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Me das el certificado?' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('no se aplica mientras escribe el nombre de quien va a asistir', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session({ step: 'new_patient_name' })],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Camila Pago Receta' })
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.humanTopicNote)
  })

  it('no se aplica mientras escribe la respuesta a una pregunta de la clínica', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      booking_sessions: [session({ step: 'ask_question', questionId: 'q-1' })],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Voy a pagar con tarjeta' })
    expect(db._tables.conversations[0].ai_handoff_summary).not.toBe(texts.humanTopicNote)
  })

  it('no confunde una palabra más larga: "pagos" y "pagado" no son "pago"', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'ya está pagado, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('un toque de un botón no es texto y no dispara nada', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'act:book' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('en una cuenta sin clínica no cambia nada', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Necesito mi factura' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: false })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(false)
  })

  it('un hilo que ya es de una persona no se toca', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Necesito mi factura' }, { humanOwned: true })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })
})
```

Crea `src/verticals/agenda/agent/steps/clinic-steps.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { looksLikeQuestion } from './clinic-steps'

describe('looksLikeQuestion', () => {
  it.each([
    'quiero una cita',
    'necesito cita para mi hijo',
    'cita',
    'hola',
    'buenas',
    'buenos días',
    'buenas tardes',
    '¿me das una cita?',
    '¿puedo agendar una cita para mañana?',
    'Qué pena, necesito una cita',
    'Tienen citas disponibles',
  ])('abre el menú: %j', (text) => {
    expect(looksLikeQuestion(text)).toBe(false)
  })

  it.each([
    'qué precio tiene',
    'cómo agendo',
    '¿Cuánto vale una cita de valoración?',
    '¿aceptan tarjeta?',
    '¿dónde quedan?',
  ])('va a la IA: %j', (text) => {
    expect(looksLikeQuestion(text)).toBe(true)
  })

  it.each([
    ['¡Hola!', false],
    ['Hola, buenas tardes.', false],
    ['¿Qué horario tienen', true],
    ['¿cuánto vale la limpieza', true],
    ['  ¿Cómo  llego?  ', true],
    ['Cuánto cuesta la limpieza', true],
    ['dónde están ubicados', true],
    ['Quisiera una cita', false],
    ['me da una cita para el lunes', false],
    ['¿puedo agendar?', false],
  ])('quita la puntuación y los espacios antes de leer la primera palabra: %j', (text, expected) => {
    expect(looksLikeQuestion(text)).toBe(expected)
  })

  it('un verbo de pedir gana sobre el signo de pregunta', () => {
    expect(looksLikeQuestion('¿quiero una cita, se puede?')).toBe(false)
    expect(looksLikeQuestion('¿me das una cita para hoy?')).toBe(false)
  })

  it('una palabra de cita sin signo de pregunta abre el menú, con la palabra que usa la clínica', () => {
    expect(looksLikeQuestion('Tienen turnos disponibles')).toBe(true)
    expect(looksLikeQuestion('Tienen turnos disponibles', ['turno', 'turnos'])).toBe(false)
  })

  it('una palabra de cita con signo de pregunta sigue siendo una duda', () => {
    expect(looksLikeQuestion('¿Tienen citas disponibles?')).toBe(true)
  })
})
```

Crea `src/verticals/agenda/agent/index.test.ts`, que prueba el handler de producción con una base que se cae:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModuleKey, VerticalInboundContext } from '@/lib/verticals/types'

import { ACCOUNT, CONTACT, CONVERSATION, OWNER, clinicDb } from './testing/clinic-harness'
import { asClient } from './testing/fake-db'

const mocks = vi.hoisted(() => ({
  notifyAlert: vi.fn<(text: string) => Promise<void>>(async () => {}),
  sendText: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendButtons: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
  sendList: vi.fn<(args: unknown) => Promise<void>>(async () => {}),
}))

vi.mock('@/lib/ops/alert', () => ({ notifyAlert: mocks.notifyAlert }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: mocks.sendText,
  engineSendInteractiveButtons: mocks.sendButtons,
  engineSendInteractiveList: mocks.sendList,
}))

import { agendaInboundHandler } from './index'

/** Una base que se cae en cuanto el bot la toca. */
const brokenDb = {
  from() {
    throw new Error('base caída')
  },
} as unknown as SupabaseClient

function context(
  db: SupabaseClient,
  modules: readonly ModuleKey[] | undefined,
): VerticalInboundContext {
  return {
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    db,
    session: null,
    modules,
  }
}

describe('agendaInboundHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('en una cuenta con clínica, un error inesperado consume el mensaje y avisa', async () => {
    const result = await agendaInboundHandler(context(brokenDb, ['agenda', 'clinica']))

    // Consumido: la IA no ve el chat de un paciente cuando el bot falló.
    expect(result).toEqual({ consumed: true })
    expect(mocks.notifyAlert).toHaveBeenCalledTimes(1)
    const text = mocks.notifyAlert.mock.calls[0][0]
    expect(text).toContain(ACCOUNT)
    expect(text).toContain(CONVERSATION)
    expect(text).toContain('base caída')
    expect(console.error).toHaveBeenCalled()
  })

  it('en una cuenta sin clínica, el error sigue subiendo como antes', async () => {
    await expect(agendaInboundHandler(context(brokenDb, ['agenda']))).rejects.toThrow('base caída')
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })

  it('si el contexto no trae módulos, tampoco se traga el error', async () => {
    await expect(agendaInboundHandler(context(brokenDb, undefined))).rejects.toThrow('base caída')
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })

  it('el aviso no lleva el teléfono ni el identificador de WhatsApp que traiga el error', async () => {
    // Un error de la base puede repetir la fila que no pudo guardar.
    const leaky = {
      from() {
        throw new Error(
          'duplicate key (573001112233) for +57 300 111 2233, user US.13491208655302741918, wa 3001112233',
        )
      },
    } as unknown as SupabaseClient
    await agendaInboundHandler(context(leaky, ['clinica']))
    const text = mocks.notifyAlert.mock.calls[0][0]
    expect(text).not.toMatch(/\d{4,}/)
    expect(text).not.toContain('300 111')
    expect(text).toContain('duplicate key')
    expect(text).toContain('#')
  })

  it('el aviso corta un error larguísimo', async () => {
    const long = {
      from() {
        throw new Error(`falló ${'x'.repeat(2000)}`)
      },
    } as unknown as SupabaseClient
    await agendaInboundHandler(context(long, ['clinica']))
    expect(mocks.notifyAlert.mock.calls[0][0].length).toBeLessThan(700)
  })

  it('sin fallos, devuelve lo que decide el bot y no avisa nada', async () => {
    // Una cuenta con clínica que aún no autorizó: el bot pide la autorización
    // por el envío real (aquí, el simulado del motor de flujos).
    const result = await agendaInboundHandler(
      context(asClient(clinicDb()), ['agenda', 'clinica']),
    )
    expect(result).toEqual({ consumed: true })
    expect(mocks.sendButtons).toHaveBeenCalledTimes(1)
    expect(mocks.sendButtons.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      bodyText: 'Texto de autorización',
    })
    expect(mocks.notifyAlert).not.toHaveBeenCalled()
  })
})
```

Crea `src/modules/clinica/consent.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb, type FakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { latestConsent, recordConsent } from './consent'

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const CONTACT = 'ct-1'

function consentRow(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    account_id: ACCOUNT,
    contact_id: CONTACT,
    contact_ref: '573001112233',
    kind: 'datos_sensibles',
    granted: true,
    text_version: 1,
    text_snapshot: 'Texto',
    source: 'whatsapp',
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

const recordArgs = {
  accountId: ACCOUNT,
  contactId: CONTACT,
  kind: 'datos_sensibles' as const,
  granted: true,
  textVersion: 3,
  textSnapshot: 'Texto que vio',
  source: 'whatsapp' as const,
  createdAtIso: '2026-10-19T13:00:00.000Z',
}

describe('latestConsent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('sin registros, no hay decisión', async () => {
    const db = makeFakeDb({ clinic_consents: [] })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toBeNull()
  })

  it('vale la más reciente, no la primera', async () => {
    const db = makeFakeDb({
      clinic_consents: [
        consentRow({ granted: true, created_at: '2026-10-01T00:00:00.000Z' }),
        consentRow({ granted: false, created_at: '2026-10-10T00:00:00.000Z' }),
      ],
    })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toEqual({ granted: false })
  })

  it('no mezcla tipos, contactos ni cuentas', async () => {
    const db = makeFakeDb({
      clinic_consents: [
        consentRow({ kind: 'mercadeo' }),
        consentRow({ contact_id: 'ct-2' }),
        consentRow({ account_id: OTHER_ACCOUNT }),
      ],
    })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toBeNull()
  })

  it('si no se pudo leer, no hay decisión (nunca "autorizó")', async () => {
    const db = makeFakeDb({ clinic_consents: [consentRow({ granted: true })] })
    db._failNext('select', 'clinic_consents', { message: 'timeout' })
    expect(
      await latestConsent(asClient(db), { accountId: ACCOUNT, contactId: CONTACT, kind: 'datos_sensibles' }),
    ).toBeNull()
  })
})

describe('recordConsent', () => {
  let db: FakeDb

  beforeEach(() => {
    db = makeFakeDb({
      contacts: [
        { id: CONTACT, account_id: ACCOUNT, name: 'Marta', phone: ' 573001112233 ', wa_user_id: null },
        { id: 'ct-user', account_id: ACCOUNT, name: 'Luis', phone: '', wa_user_id: 'US.123' },
        { id: 'ct-none', account_id: ACCOUNT, name: 'Sin datos', phone: '', wa_user_id: null },
        { id: 'ct-other', account_id: OTHER_ACCOUNT, name: 'Ajena', phone: '573009998877' },
      ],
      clinic_consents: [],
    })
  })

  it('guarda quién autorizó, qué texto vio y desde dónde', async () => {
    await recordConsent(asClient(db), { ...recordArgs, messageId: 'wamid-9' })
    expect(db._tables.clinic_consents).toMatchObject([
      {
        account_id: ACCOUNT,
        contact_id: CONTACT,
        contact_ref: '573001112233',
        kind: 'datos_sensibles',
        granted: true,
        text_version: 3,
        text_snapshot: 'Texto que vio',
        source: 'whatsapp',
        message_id: 'wamid-9',
        created_at: '2026-10-19T13:00:00.000Z',
      },
    ])
  })

  it('sin mensaje de origen, guarda null', async () => {
    await recordConsent(asClient(db), recordArgs)
    expect(db._tables.clinic_consents[0].message_id).toBeNull()
  })

  it('sin teléfono, quién autorizó es su identificador de WhatsApp', async () => {
    await recordConsent(asClient(db), { ...recordArgs, contactId: 'ct-user' })
    expect(db._tables.clinic_consents[0].contact_ref).toBe('US.123')
  })

  it('sin teléfono ni identificador, lanza y no guarda nada', async () => {
    await expect(recordConsent(asClient(db), { ...recordArgs, contactId: 'ct-none' })).rejects.toThrow(
      'teléfono ni identificador',
    )
    expect(db._tables.clinic_consents).toHaveLength(0)
  })

  it('un contacto de otra cuenta no sirve de referencia', async () => {
    await expect(recordConsent(asClient(db), { ...recordArgs, contactId: 'ct-other' })).rejects.toThrow()
    expect(db._tables.clinic_consents).toHaveLength(0)
  })

  it('si no se pudo leer el contacto, lanza y no guarda nada', async () => {
    db._failNext('select', 'contacts', { message: 'timeout' })
    await expect(recordConsent(asClient(db), recordArgs)).rejects.toThrow('No se pudo leer el contacto')
    expect(db._tables.clinic_consents).toHaveLength(0)
  })

  it('si la base rechaza el registro, lanza', async () => {
    db._failNext('insert', 'clinic_consents', { message: 'boom' })
    await expect(recordConsent(asClient(db), recordArgs)).rejects.toThrow(
      'No se pudo guardar la autorización: boom',
    )
    expect(db._tables.clinic_consents).toHaveLength(0)
  })
})
```

Crea `src/modules/clinica/ai-gate.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asClient, makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { canUseAi } from './ai-gate'

const ACCOUNT = 'acc-1'
const CONTACT = 'ct-1'

const consent = (overrides: Row = {}): Row => ({
  id: crypto.randomUUID(),
  account_id: ACCOUNT,
  contact_id: CONTACT,
  contact_ref: '573001112233',
  kind: 'datos_sensibles',
  granted: true,
  text_version: 1,
  text_snapshot: 'Texto',
  source: 'whatsapp',
  created_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

function dbWith(account: Row | null, consents: Row[] = []): FakeDb {
  return makeFakeDb({
    accounts: account ? [{ id: ACCOUNT, ...account }] : [],
    clinic_consents: consents,
  })
}

const can = (db: FakeDb) => canUseAi(asClient(db), { accountId: ACCOUNT, contactId: CONTACT })

describe('canUseAi', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('una cuenta sin el módulo clínica usa la IA sin más', async () => {
    expect(await can(dbWith({ modules: ['agenda'], vertical_key: 'agenda' }))).toBe(true)
    expect(await can(dbWith({ modules: [], vertical_key: 'barberia' }))).toBe(true)
    expect(await can(dbWith({ modules: ['agenda', 'ventas'], vertical_key: 'agenda' }))).toBe(true)
  })

  it('una cuenta sin el módulo no mira las autorizaciones', async () => {
    const db = dbWith({ modules: ['agenda'] })
    db._failNext('select', 'clinic_consents', { message: 'no debería leerse' })
    expect(await can(db)).toBe(true)
  })

  it('con el módulo, sin autorización, no', async () => {
    expect(await can(dbWith({ modules: ['agenda', 'clinica'] }))).toBe(false)
  })

  it('con el módulo y la autorización dada, sí', async () => {
    expect(await can(dbWith({ modules: ['agenda', 'clinica'] }, [consent()]))).toBe(true)
  })

  it('con el módulo y la autorización rechazada, no', async () => {
    expect(await can(dbWith({ modules: ['agenda', 'clinica'] }, [consent({ granted: false })]))).toBe(false)
  })

  it('vale la decisión más reciente', async () => {
    const accepted = consent({ granted: true, created_at: '2026-10-01T00:00:00.000Z' })
    const refused = consent({ granted: false, created_at: '2026-10-10T00:00:00.000Z' })
    expect(await can(dbWith({ modules: ['clinica'] }, [accepted, refused]))).toBe(false)
    expect(await can(dbWith({ modules: ['clinica'] }, [refused, { ...accepted, created_at: '2026-10-20T00:00:00.000Z' }]))).toBe(true)
  })

  it('la autorización de otro contacto o de otro tipo no cuenta', async () => {
    const others = [
      consent({ contact_id: 'ct-2' }),
      consent({ kind: 'mercadeo' }),
      consent({ account_id: 'acc-2' }),
    ]
    expect(await can(dbWith({ modules: ['clinica'] }, others))).toBe(false)
  })

  it('una cuenta con clínica y sin agenda tampoco la usa sin autorización', async () => {
    expect(await can(dbWith({ modules: ['clinica'], vertical_key: null }))).toBe(false)
    expect(await can(dbWith({ modules: [], vertical_key: 'clinica' }))).toBe(false)
  })

  it('si no se pudo leer la cuenta, no (aunque no sea clínica)', async () => {
    const db = dbWith({ modules: ['agenda'] })
    db._failNext('select', 'accounts', { message: 'connection reset' })
    expect(await can(db)).toBe(false)
  })

  it('si no hay fila de la cuenta, no', async () => {
    expect(await can(dbWith(null))).toBe(false)
  })

  it('si no se pudo leer la autorización, no', async () => {
    const db = dbWith({ modules: ['clinica'] }, [consent()])
    db._failNext('select', 'clinic_consents', { message: 'timeout' })
    expect(await can(db)).toBe(false)
  })
})
```

Crea `src/app/api/ai/draft/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  canUseAi: vi.fn(),
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  logAiUsage: vi.fn(),
  conversation: { data: null as unknown, error: null as unknown },
  admin: { name: 'service-role-client' },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/context', () => ({ buildConversationContext: mocks.buildConversationContext }))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: mocks.retrieveKnowledge }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => mocks.admin }))
vi.mock('@/modules/clinica/ai-gate', () => ({ canUseAi: mocks.canUseAi }))

import { POST } from './route'

const scoped = {
  from: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(mocks.conversation),
    }
    return chain
  },
}

function request(body: unknown) {
  return new Request('http://localhost/api/ai/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.conversation = { data: { id: 'conv-1', contact_id: 'ct-1' }, error: null }
  mocks.requireRole.mockResolvedValue({ supabase: scoped, accountId: 'acc-1', userId: 'user-1' })
  mocks.canUseAi.mockResolvedValue(true)
  mocks.loadAiConfig.mockResolvedValue({ provider: 'openai', model: 'm', systemPrompt: null })
  mocks.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hola' }])
  mocks.retrieveKnowledge.mockResolvedValue([])
  mocks.generateReply.mockResolvedValue({ text: 'Borrador', usage: {} })
})

describe('POST /api/ai/draft', () => {
  it('devuelve el borrador cuando la IA puede leer el chat', async () => {
    const response = await POST(request({ conversation_id: 'conv-1' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ draft: 'Borrador' })
    expect(mocks.canUseAi).toHaveBeenCalledWith(mocks.admin, {
      accountId: 'acc-1',
      contactId: 'ct-1',
    })
  })

  it('sin autorización responde 403 y no manda el chat a la IA', async () => {
    mocks.canUseAi.mockResolvedValue(false)
    const response = await POST(request({ conversation_id: 'conv-1' }))
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.code).toBe('consent_required')
    expect(body.error).toEqual(expect.any(String))
    expect(body.error.length).toBeGreaterThan(20)
    expect(mocks.buildConversationContext).not.toHaveBeenCalled()
    expect(mocks.retrieveKnowledge).not.toHaveBeenCalled()
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('con otra conversación que no es de la cuenta, sigue siendo 404 y no consulta nada', async () => {
    mocks.conversation = { data: null, error: null }
    const response = await POST(request({ conversation_id: 'conv-9' }))
    expect(response.status).toBe(404)
    expect(mocks.canUseAi).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Ajusta las pruebas existentes**

Cuatro archivos de pruebas ya existen y cambian. Ninguna prueba de `controller.test.ts` ni de `reminders.test.ts` se toca.

`src/verticals/agenda/agent/state.test.ts`: un número no elige "No acepto" ni "No, gracias".

```diff
--- a/src/verticals/agenda/agent/state.test.ts
+++ b/src/verticals/agenda/agent/state.test.ts
@@ -440,8 +440,8 @@ describe('autorización escrita', () => {
   })
 
-  it('por número, el rechazo sigue valiendo y la aceptación no', () => {
-    expect(choice('2')).toBe('act:consent_no')
-    expect(choice('2.')).toBe('act:consent_no')
-    expect(choice('1')).toBeNull()
+  it('ningún número elige nada: ni acepta ni deja un rechazo en un registro de solo agregar', () => {
+    for (const text of ['1', '1.', '1)', '2', '2.', '2)', '02', '3']) {
+      expect(choice(text)).toBeNull()
+    }
   })
 })
@@ -458,5 +458,5 @@ describe('aviso de marketing escrito', () => {
   )
 
-  it.each(['no', 'no, gracias', 'no avísame', 'noo', 'nunca', 'tampoco', '2', '❌ no'])(
+  it.each(['no', 'no, gracias', 'no avísame', 'noo', 'nunca', 'tampoco', '❌ no'])(
     'un no nunca se lee como aceptación: %j',
     (text) => {
@@ -465,5 +465,5 @@ describe('aviso de marketing escrito', () => {
   )
 
-  it.each(['¿avísame?', '¿qué es eso?', 'ok', 'dale', 'quizás', 'sí, gracias', '1', '3', ''])(
+  it.each(['¿avísame?', '¿qué es eso?', 'ok', 'dale', 'quizás', 'sí, gracias', '1', '2', '2.', '3', ''])(
     'una duda, una pregunta o un mensaje a medias no acepta: %j',
     (text) => {
```

`src/modules/clinica/texts.test.ts`: las palabras de urgencia nuevas.

```diff
--- a/src/modules/clinica/texts.test.ts
+++ b/src/modules/clinica/texts.test.ts
@@ -119,4 +119,9 @@ describe('palabras de urgencia por defecto', () => {
     'me fracturé un diente',
     'me falta el aire',
+    'me fracturo un diente jugando',
+    'me está doliendo muchísimo la muela',
+    'me dolió toda la noche',
+    'me golpeé la boca con la puerta',
+    'tiene calentura desde ayer',
   ])('reconoce una urgencia: %s', (message) => {
     expect(containsUrgencyWord(message, words)).toBe(true)
```

`src/lib/verticals/dispatch.test.ts`: `released`.

```diff
--- a/src/lib/verticals/dispatch.test.ts
+++ b/src/lib/verticals/dispatch.test.ts
@@ -8,5 +8,5 @@ const dbState = vi.hoisted(() => ({
   responses: {} as Record<string, { data: unknown; error: unknown }>,
   throwOn: null as string | null,
-  handlerResult: { consumed: false } as { consumed: boolean },
+  handlerResult: { consumed: false } as { consumed: boolean; released?: boolean },
   handlerThrows: false,
   handlerCalls: [] as Record<string, unknown>[],
@@ -187,4 +187,44 @@ describe('dispatchInboundToVertical', () => {
   })
 
+  it('does not claim the message when the handler releases it, even with an active session', async () => {
+    dbState.responses = {
+      accounts: agendaAccount,
+      conversations: openConversation,
+      booking_sessions: {
+        data: {
+          id: 'sess-1',
+          state: { step: 'clinic_menu' },
+          expires_at: '2099-01-01T00:00:00.000Z',
+        },
+        error: null,
+      },
+    }
+    dbState.handlerResult = { consumed: false, released: true }
+
+    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
+      consumed: false,
+    })
+  })
+
+  it('a handler that declines without releasing still leaves the active session in charge', async () => {
+    dbState.responses = {
+      accounts: agendaAccount,
+      conversations: openConversation,
+      booking_sessions: {
+        data: {
+          id: 'sess-1',
+          state: { step: 'pick_service' },
+          expires_at: '2099-01-01T00:00:00.000Z',
+        },
+        error: null,
+      },
+    }
+    dbState.handlerResult = { consumed: false }
+
+    await expect(dispatchInboundToVertical(baseArgs)).resolves.toEqual({
+      consumed: true,
+    })
+  })
+
   it('routes accounts still on the legacy barberia key to the agenda handler', async () => {
     dbState.responses = {
```

`src/lib/ai/auto-reply.test.ts`: el cliente falso de la base ahora atiende `accounts` y `clinic_consents`, y una cuenta de agenda común es el valor por defecto, así que las pruebas de siempre no cambian.

```diff
--- a/src/lib/ai/auto-reply.test.ts
+++ b/src/lib/ai/auto-reply.test.ts
@@ -17,4 +17,12 @@ const h = vi.hoisted(() => ({
     updatePayload: null as Record<string, unknown> | null,
     rpcCalls: [] as { name: string; args: unknown }[],
+    /** Fila de `accounts` que lee la comprobación de autorización (null = sin fila). */
+    account: null as Record<string, unknown> | null,
+    accountError: null as { message: string } | null,
+    /** Filas de `clinic_consents` del contacto, la más reciente primero. */
+    consents: [] as { granted: boolean }[],
+    consentError: null as { message: string } | null,
+    /** Tablas leídas, en orden. */
+    tablesRead: [] as string[],
   },
 }))
@@ -34,4 +42,29 @@ vi.mock('./admin-client', () => ({
   supabaseAdmin: () => ({
     from: (table: string) => {
+      h.state.tablesRead.push(table)
+      if (table === 'accounts') {
+        // .select().eq().maybeSingle() → módulos de la cuenta
+        const chain = {
+          select: () => chain,
+          eq: () => chain,
+          maybeSingle: () =>
+            Promise.resolve({ data: h.state.account, error: h.state.accountError }),
+        }
+        return chain
+      }
+      if (table === 'clinic_consents') {
+        // .select().eq().eq().eq().order().limit() → decisión más reciente
+        const chain = {
+          select: () => chain,
+          eq: () => chain,
+          order: () => chain,
+          limit: () =>
+            Promise.resolve({
+              data: h.state.consentError ? null : h.state.consents.slice(0, 1),
+              error: h.state.consentError,
+            }),
+        }
+        return chain
+      }
       if (table === 'automations') {
         // .select().eq().eq().in().limit() → active auto-responders
@@ -102,4 +135,10 @@ beforeEach(() => {
   h.state.updatePayload = null
   h.state.rpcCalls = []
+  // Una cuenta de agenda común: sin el módulo clínica, la IA no pide autorización.
+  h.state.account = { modules: ['agenda'], vertical_key: 'agenda' }
+  h.state.accountError = null
+  h.state.consents = []
+  h.state.consentError = null
+  h.state.tablesRead = []
   h.loadAiConfig.mockResolvedValue(aiConfig())
   h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
@@ -205,4 +244,78 @@ describe('dispatchInboundToAiReply — eligibility gates', () => {
 })
 
+describe('dispatchInboundToAiReply — clinic data authorization', () => {
+  const clinic = { modules: ['agenda', 'clinica'], vertical_key: 'agenda' }
+
+  function expectSilent() {
+    expect(h.buildConversationContext).not.toHaveBeenCalled()
+    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
+    expect(h.generateReply).not.toHaveBeenCalled()
+    expect(h.engineSendText).not.toHaveBeenCalled()
+    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
+    expect(h.state.rpcCalls).toHaveLength(0)
+  }
+
+  it('does not send a clinic chat to the AI until the patient authorizes', async () => {
+    h.state.account = clinic
+    await dispatchInboundToAiReply(ARGS)
+    expectSilent()
+  })
+
+  it('does not send it either after the patient said no', async () => {
+    h.state.account = clinic
+    h.state.consents = [{ granted: false }]
+    await dispatchInboundToAiReply(ARGS)
+    expectSilent()
+  })
+
+  it('answers once the patient has authorized', async () => {
+    h.state.account = clinic
+    h.state.consents = [{ granted: true }]
+    await dispatchInboundToAiReply(ARGS)
+    expect(h.generateReply).toHaveBeenCalledTimes(1)
+    expect(h.engineSendText).toHaveBeenCalledTimes(1)
+  })
+
+  it('fails closed when the account cannot be read, for any account', async () => {
+    h.state.accountError = { message: 'connection reset' }
+    await dispatchInboundToAiReply(ARGS)
+    expectSilent()
+  })
+
+  it('fails closed when the authorization cannot be read', async () => {
+    h.state.account = clinic
+    h.state.consents = [{ granted: true }]
+    h.state.consentError = { message: 'timeout' }
+    await dispatchInboundToAiReply(ARGS)
+    expectSilent()
+  })
+
+  it('also covers a clinic account that has no agenda module', async () => {
+    h.state.account = { modules: ['clinica'], vertical_key: null }
+    await dispatchInboundToAiReply(ARGS)
+    expectSilent()
+  })
+
+  it('asks after the AI config and before loading the chat', async () => {
+    h.state.account = clinic
+    await dispatchInboundToAiReply(ARGS)
+    expect(h.loadAiConfig).toHaveBeenCalled()
+    expect(h.state.tablesRead).toContain('clinic_consents')
+    expect(h.buildConversationContext).not.toHaveBeenCalled()
+  })
+
+  it('does not look at consents in an account without the clinic module', async () => {
+    await dispatchInboundToAiReply(ARGS)
+    expect(h.state.tablesRead).not.toContain('clinic_consents')
+    expect(h.engineSendText).toHaveBeenCalledTimes(1)
+  })
+
+  it('does not even look at the account when the AI is off', async () => {
+    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
+    await dispatchInboundToAiReply(ARGS)
+    expect(h.state.tablesRead).not.toContain('accounts')
+  })
+})
+
 describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
   it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
```

- [ ] **Step 4: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda src/modules/clinica src/lib/ai src/lib/verticals src/app/api/ai`
Expected: FAIL. El bot abre el menú de servicios en vez de pedir autorización, la IA se llama sin autorización y el handler deja subir el error.

- [ ] **Step 5: Crea el acceso a autorizaciones y la compuerta de la IA**

Crea `src/modules/clinica/consent.ts`:

```ts
// ============================================================
// Autorizaciones de datos. Registro de solo agregar: la decisión vigente
// es la más reciente de cada tipo, y nada se edita ni se borra (la base lo
// hace cumplir con un trigger). Cada fila guarda quién autorizó (contact_ref)
// y el texto exacto que vio (text_snapshot), porque el contacto puede
// borrarse y el texto de la clínica puede cambiar.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type ConsentKind = 'datos_sensibles' | 'mercadeo'

/** Decisión vigente; null si nunca respondió o no se pudo leer. */
export async function latestConsent(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; kind: ConsentKind },
): Promise<{ granted: boolean } | null> {
  const { data, error } = await db
    .from('clinic_consents')
    .select('granted, created_at')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('kind', args.kind)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) {
    console.error('[clinica] no se pudo leer la autorización:', error.message)
    return null
  }
  const row = ((data ?? []) as { granted: boolean }[])[0]
  return row ? { granted: row.granted } : null
}

/**
 * Teléfono del contacto, o su identificador de WhatsApp si no tiene teléfono
 * (un contacto que solo escribe con nombre de usuario guarda `phone` vacío).
 * Es lo que queda en la autorización si el contacto se borra después, y la
 * base no admite una vacía: sin a nombre de quién guardar, no hay registro.
 */
async function contactRef(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string> {
  const { data, error } = await db
    .from('contacts')
    .select('phone, wa_user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer el contacto: ${error.message}`)
  const row = data as { phone: string | null; wa_user_id: string | null } | null
  const ref = row?.phone?.trim() || row?.wa_user_id?.trim() || ''
  if (!ref) throw new Error('El contacto no tiene teléfono ni identificador de WhatsApp')
  return ref
}

/** Lanza si no se pudo guardar: sin registro no hay autorización. */
export async function recordConsent(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    kind: ConsentKind
    granted: boolean
    textVersion: number
    /** El texto exacto que vio la persona al responder. */
    textSnapshot: string
    source: 'whatsapp' | 'recepcion'
    messageId?: string | null
    createdAtIso: string
  },
): Promise<void> {
  const { error } = await db.from('clinic_consents').insert({
    id: crypto.randomUUID(),
    account_id: args.accountId,
    contact_id: args.contactId,
    contact_ref: await contactRef(db, args.accountId, args.contactId),
    kind: args.kind,
    granted: args.granted,
    text_version: args.textVersion,
    text_snapshot: args.textSnapshot,
    source: args.source,
    message_id: args.messageId ?? null,
    created_at: args.createdAtIso,
  })
  if (error) throw new Error(`No se pudo guardar la autorización: ${error.message}`)
}
```

Crea `src/modules/clinica/ai-gate.ts`:

```ts
// ============================================================
// ¿Se puede mandar este chat a la IA?
//
// En una clínica la conversación puede traer datos de salud. Hasta que la
// persona los autoriza, ningún texto suyo sale hacia el proveedor de IA:
// ni la respuesta automática ni "Sugerir con IA".
//
// Falla cerrado: si no se puede leer la cuenta o la autorización, la
// respuesta es no. Se mira aquí, en el punto donde la IA lee el chat, y no
// solo en el despachador de verticales: el despachador deja pasar el
// mensaje cuando no logra leer los módulos, y entonces el bot ni se entera.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'

import { latestConsent } from './consent'

export async function canUseAi(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<boolean> {
  const { account, error } = await readAccountModules(db, args.accountId)
  if (error) {
    console.error('[clinica] no se pudo leer la cuenta para decidir si usa la IA:', error.message)
    return false
  }
  // Una conversación siempre tiene cuenta: sin fila no hay a quién preguntarle.
  if (!account) return false
  if (!hasModule(account, 'clinica')) return true

  const consent = await latestConsent(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    kind: 'datos_sensibles',
  })
  return consent?.granted === true
}
```

- [ ] **Step 6: Cierra los dos lugares donde la IA lee un chat**

`src/lib/ai/auto-reply.ts`:

```diff
--- a/src/lib/ai/auto-reply.ts
+++ b/src/lib/ai/auto-reply.ts
@@ -14,4 +14,5 @@ import {
 import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
 import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
+import { canUseAi } from '@/modules/clinica/ai-gate'
 
 interface DispatchArgs {
@@ -65,4 +66,9 @@ export async function dispatchInboundToAiReply(
     if (!config || !config.autoReplyEnabled) return
 
+    // Clinic accounts: a patient's chat can carry health data, so it never
+    // reaches the provider until they authorize it. Fails closed (an
+    // unreadable account or authorization is a no).
+    if (!(await canUseAi(db, { accountId, contactId }))) return
+
     // Deterministic, user-configured responders win over the LLM — the
     // caller already excludes messages a Flow consumed. Message-level
```

`src/app/api/ai/draft/route.ts`:

```diff
--- a/src/app/api/ai/draft/route.ts
+++ b/src/app/api/ai/draft/route.ts
@@ -11,4 +11,5 @@ import { logAiUsage } from '@/lib/ai/usage'
 import { supabaseAdmin } from '@/lib/ai/admin-client'
 import { AiError } from '@/lib/ai/types'
+import { canUseAi } from '@/modules/clinica/ai-gate'
 import { getT } from '@/lib/i18n/translate'
 
@@ -51,5 +52,5 @@ export async function POST(request: Request) {
     const { data: conversation, error: convErr } = await supabase
       .from('conversations')
-      .select('id')
+      .select('id, contact_id')
       .eq('id', conversationId)
       .maybeSingle()
@@ -62,4 +63,19 @@ export async function POST(request: Request) {
     }
 
+    // Clinic accounts: nothing from a patient who has not authorized the use
+    // of their data goes to the AI provider, not even to draft for an agent.
+    // The service role reads the authorization: it does not depend on what
+    // the caller's session is allowed to see.
+    const allowed = await canUseAi(supabaseAdmin(), {
+      accountId,
+      contactId: conversation.contact_id as string,
+    })
+    if (!allowed) {
+      return NextResponse.json(
+        { error: t('ai.consentRequired'), code: 'consent_required' },
+        { status: 403 },
+      )
+    }
+
     const config = await loadAiConfig(supabase, accountId).catch((err) => {
       // Decrypt failure — surface distinctly from "not configured".
```

Y la clave `Api.ai.consentRequired` en los cuatro catálogos de `messages/`, después de `noMessages`:

```json
// en.json
"consentRequired": "This person has not authorized the use of their data, so the AI cannot read this chat. Reply to them yourself.",
// es.json
"consentRequired": "Esta persona no ha autorizado el uso de sus datos, así que la IA no puede leer este chat. Respóndele tú.",
// pt.json
"consentRequired": "Esta pessoa não autorizou o uso dos seus dados, então a IA não pode ler esta conversa. Responda você mesmo.",
// ko.json
"consentRequired": "이 사람은 데이터 사용에 동의하지 않아 AI가 이 대화를 읽을 수 없습니다. 직접 답변해 주세요.",
```

- [ ] **Step 7: Textos, estado y resultado del despachador**

`src/modules/clinica/texts.ts`: `CLINIC_HUMAN_WORDS`, `CLINIC_GREETING_WORDS`, las palabras de urgencia nuevas y cuatro notas internas (`humanTopicNote`, `consentUnansweredNote`, `clinicUnavailableNote`, `clinicUnavailableUrgentNote`).

```diff
--- a/src/modules/clinica/texts.ts
+++ b/src/modules/clinica/texts.ts
@@ -28,4 +28,6 @@ export const DEFAULT_URGENCY_WORDS: readonly string[] = [
   'duele',
   'duelen',
+  'doliendo',
+  'dolio',
   'sangrado',
   'sangra',
@@ -45,7 +47,10 @@ export const DEFAULT_URGENCY_WORDS: readonly string[] = [
   'pus',
   'fiebre',
+  'calentura',
   'golpe',
+  'golpee',
   'fractura',
   'fracture',
+  'fracturo',
   'se partio',
   'se me partio',
@@ -60,4 +65,40 @@ export const DEFAULT_URGENCY_WORDS: readonly string[] = [
 ]
 
+/**
+ * Temas que en esta versión atiende una persona (spec §5, etapa 2): quejas,
+ * pagos y documentos. Sin tildes: se comparan contra el texto normalizado. Un
+ * mensaje que trae una y no es una duda pasa a una persona, sin pedir antes la
+ * autorización.
+ */
+export const CLINIC_HUMAN_WORDS: readonly string[] = [
+  'queja',
+  'reclamo',
+  'pqr',
+  'pqrs',
+  'factura',
+  'pago',
+  'pagar',
+  'abono',
+  'saldo',
+  'certificado',
+  'incapacidad',
+  'historia clinica',
+  'radiografia',
+  'receta',
+  'documento',
+  'documentos',
+]
+
+/**
+ * Saludos que abren el menú en una clínica ("buenas tardes" es lo primero que
+ * escribe mucha gente). Solo en clínicas: en las demás agendas no cuentan.
+ */
+export const CLINIC_GREETING_WORDS: readonly string[] = [
+  'buenas',
+  'buenos dias',
+  'buenas tardes',
+  'buenas noches',
+]
+
 /** Nota: una lista admite títulos de hasta 24 caracteres y un botón, 20. */
 export function buildClinicTexts(l: AgendaLabels) {
@@ -68,4 +109,15 @@ export function buildClinicTexts(l: AgendaLabels) {
     consentDeclinedNote: 'Paciente: no aceptó la autorización de datos (bot en pausa).',
     consentError: 'No pude guardar tu respuesta en este momento 😅. Intenta de nuevo, por favor.',
+    /** Pase a una persona porque la autorización no se respondió con los botones, o no se pudo guardar. */
+    consentUnansweredNote:
+      'Paciente: la autorización de datos quedó sin responder (bot en pausa).',
+
+    /** La configuración de la clínica falta o no se pudo leer: el bot no atiende y pasa a una persona. */
+    humanTopicNote:
+      'Paciente: escribió sobre una queja, un pago o un documento, que atiende una persona (bot en pausa).',
+    clinicUnavailableNote:
+      'Paciente: el bot no lo atendió porque la configuración de la clínica no está disponible (bot en pausa). Revisa la configuración de la clínica.',
+    clinicUnavailableUrgentNote:
+      'Paciente: escribió una posible urgencia y la configuración de la clínica no está disponible (bot en pausa). Comunícate con esa persona ya.',
 
     menuBody: '¡Hola! 👋 Soy el asistente de la clínica. ¿En qué te ayudo?',
```

`src/verticals/agenda/agent/state.ts`: el paso `faq_open`, `consentText` y `consentVersion`, `containsAnyWord`, y el conjunto de opciones que ningún número elige.

```diff
--- a/src/verticals/agenda/agent/state.ts
+++ b/src/verticals/agenda/agent/state.ts
@@ -33,4 +33,6 @@ export type BookingStep =
   | 'pick_appointment'
   | 'marketing_consent'
+  /** Esperando la duda del paciente: el siguiente texto es para la IA. */
+  | 'faq_open'
 
 /** 'book' = cita nueva · 'reschedule' = reprogramación de una existente. */
@@ -75,4 +77,11 @@ export interface BookingState {
   /** Página del menú de días, cuando hay más de los que caben en una lista. */
   dayPage?: number
+  /**
+   * Texto y versión de la autorización tal como se le mostraron a la persona.
+   * Se guardan al responder: la clínica puede editar su texto mientras tanto, y
+   * el registro tiene que decir lo que la persona vio, no lo que hay ahora.
+   */
+  consentText?: string
+  consentVersion?: number
   /** Qué sigue al aceptar la autorización; por defecto, el menú. */
   afterConsent?: 'urgency_book'
@@ -298,7 +307,16 @@ export function containsHandoffWord(text: string): boolean {
 }
 
+/**
+ * ¿El mensaje trae alguna de estas palabras o frases, enteras y sin importar
+ * mayúsculas ni tildes? Las palabras que se pasan no necesitan venir
+ * normalizadas.
+ */
+export function containsAnyWord(text: string, words: readonly string[]): boolean {
+  return containsWord(text, words.map(normalizeText))
+}
+
 /** ¿El mensaje trae una palabra de urgencia de la clínica? */
 export function containsUrgencyWord(text: string, words: readonly string[]): boolean {
-  return containsWord(text, words.map(normalizeText))
+  return containsAnyWord(text, words)
 }
 
@@ -352,6 +370,17 @@ const ACTION_SYNONYMS: Record<string, string[]> = {
 // ------------------------------------------------------------
 
-/** Opciones que aceptan o descartan: no se eligen por número ni por texto suelto. */
-const ACCEPTING_IDS: ReadonlySet<string> = new Set(['act:consent_yes', 'act:mkt_yes', 'act:alarm_no'])
+/**
+ * Opciones que deciden algo por la persona: no se eligen por número ni por
+ * texto suelto. Aceptar o descartar los signos de alarma es evidente; el
+ * rechazo también, porque queda en un registro de solo agregar y pausa el bot,
+ * y un "2" suelto no es una decisión.
+ */
+const ACCEPTING_IDS: ReadonlySet<string> = new Set([
+  'act:consent_yes',
+  'act:consent_no',
+  'act:mkt_yes',
+  'act:mkt_no',
+  'act:alarm_no',
+])
 
 /** Mensajes completos que descartan los signos de alarma, ya en forma `squash`. */
@@ -463,6 +492,6 @@ export function matchChoice({
     const idx = Number(num[1]) - 1
     const id = idx >= 0 && idx < options.length ? options[idx].id : null
-    // Los botones de decisión no muestran números: un número no puede aceptar
-    // (ni descartar los signos de alarma).
+    // Los botones de decisión no muestran números: un número no puede aceptar,
+    // rechazar ni descartar los signos de alarma.
     return id && !ACCEPTING_IDS.has(id) ? id : null
   }
```

`src/lib/verticals/types.ts` y `src/lib/verticals/dispatch.ts`: el resultado `released`.

```diff
--- a/src/lib/verticals/types.ts
+++ b/src/lib/verticals/types.ts
@@ -88,4 +88,12 @@ export interface VerticalDispatchResult {
   /** True when the vertical took ownership of this inbound message. */
   consumed: boolean
+  /**
+   * The vertical closed the session this message arrived on and hands the
+   * message to the rest of the pipeline (the AI). Without it, the dispatcher
+   * keeps claiming every message that arrived while a session was open, and
+   * a question typed inside a menu would never reach the AI. Only meaningful
+   * with `consumed: false`.
+   */
+  released?: boolean
 }
 

--- a/src/lib/verticals/dispatch.ts
+++ b/src/lib/verticals/dispatch.ts
@@ -111,4 +111,7 @@ export async function dispatchInboundToVertical(
       })
       if (result.consumed) return { consumed: true }
+      // The handler closed the session on purpose and gives the message
+      // away: the open-session claim below must not take it back.
+      if (result.released) return { consumed: false }
     }
 
```

- [ ] **Step 8: Crea los pasos clínicos**

Crea `src/verticals/agenda/agent/steps/clinic-steps.ts`:

```ts
// ============================================================
// Pasos del bot clínico: autorización, menú, pacientes y urgencias.
//
// Este archivo no toca la sesión: cada paso devuelve un `ClinicOutcome`
// y el controlador lo aplica. Así los pasos no dependen del controlador
// y el estado sigue teniendo un solo dueño.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { recordConsent } from '@/modules/clinica/consent'
import type { ClinicContext } from '@/modules/clinica/settings'
import type { ClinicTexts } from '@/modules/clinica/texts'

import type { ClinicBackend } from '../backend'
import type { AgendaSender } from '../controller'
import {
  actId,
  containsAnyWord,
  newBookingState,
  normalizeText,
  type BookingState,
  type BookingStep,
  type OfferedOption,
  type OptionKind,
  type ReminderAction,
} from '../state'

export interface ClinicStepCtx {
  db: SupabaseClient
  sender: AgendaSender
  backend: ClinicBackend
  clinic: ClinicContext
  texts: ClinicTexts
  accountId: string
  contactId: string
  conversationId: string
  now: Date
  nowIso: string
  inboundMessageId: string | null
  sendOptions(args: {
    bodyText: string
    buttonLabel: string
    options: (OfferedOption & { description?: string })[]
  }): Promise<void>
}

export interface ClinicHandoff {
  kind: 'handoff'
  /** Reemplaza el mensaje de pase a una persona. */
  message?: string
  /** Nota interna del hilo. */
  note?: string
  /** Reemplaza el aviso al equipo. */
  notification?: { title: string; body: (who: string) => string }
}

export type ClinicOutcome =
  /** Sigue en este paso: se muestra y se guarda. */
  | { kind: 'next'; state: BookingState }
  | ClinicHandoff
  /** Termina la conversación con el bot. */
  | { kind: 'done' }
  /** Respuesta inválida: cuenta como fallo. */
  | { kind: 'fail'; message?: string }
  /** Se eligió la cita que esperaba una acción del recordatorio. */
  | { kind: 'reminder'; action: ReminderAction; appointmentId: string }

export interface ClinicRendered {
  state: BookingState
  closed: boolean
}

const CLINIC_STEPS: readonly BookingStep[] = [
  'consent',
  'clinic_menu',
  'urgency',
  'pick_patient',
  'new_patient_name',
  'pick_appointment',
  'marketing_consent',
  'faq_open',
]

export const isClinicStep = (step: BookingStep): boolean => CLINIC_STEPS.includes(step)

const QUESTION_STARTS = [
  'cuanto',
  'cuantos',
  'cuanta',
  'donde',
  'que',
  'como',
  'cual',
  'cuales',
  'tienen',
  'hacen',
  'aceptan',
  'atienden',
  'reciben',
]

/**
 * Quien pide algo no pregunta, aunque lo escriba con signos de pregunta o
 * empiece con "qué" ("Qué pena, necesito una cita"). Sin tildes, como se
 * comparan.
 */
const REQUEST_PHRASES = ['quiero', 'quisiera', 'necesito', 'me das', 'me da', 'puedo agendar']

/**
 * Lo que parece una duda va a la IA aunque nombre una "cita".
 *
 *   1. Un verbo de pedir gana: "¿me das una cita?" abre el menú.
 *   2. Un signo de pregunta es una duda.
 *   3. Sin signo de pregunta, nombrar la cita la pide ("Tienen citas
 *      disponibles"): abre el menú, que tiene "Precios y dudas".
 *   4. Si no, empezar con "cuánto", "dónde", "cómo"... es una duda.
 *
 * `appointmentWords` son las palabras que usa la clínica para sus citas.
 */
export function looksLikeQuestion(
  text: string,
  appointmentWords: readonly string[] = ['cita', 'citas'],
): boolean {
  if (containsAnyWord(text, REQUEST_PHRASES)) return false
  if (text.includes('?') || text.includes('¿')) return true
  if (containsAnyWord(text, appointmentWords)) return false
  const plain = normalizeText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  return QUESTION_STARTS.includes(plain.split(/\s+/)[0] ?? '')
}

export async function renderClinicStep(
  ctx: ClinicStepCtx,
  state: BookingState,
): Promise<ClinicRendered> {
  const { texts } = ctx
  switch (state.step) {
    case 'consent': {
      const options: OfferedOption[] = [
        { id: actId('consent_yes'), title: texts.consentAccept },
        { id: actId('consent_no'), title: texts.consentDecline },
      ]
      await ctx.sendOptions({
        bodyText: ctx.clinic.consentText,
        buttonLabel: texts.menuButton,
        options,
      })
      // Lo que se acaba de mostrar es lo que la respuesta va a registrar.
      return {
        state: {
          ...state,
          options,
          consentText: ctx.clinic.consentText,
          consentVersion: ctx.clinic.consentVersion,
        },
        closed: false,
      }
    }

    case 'clinic_menu': {
      const options: OfferedOption[] = [
        { id: actId('book'), title: texts.menuBook },
        { id: actId('mine'), title: texts.menuMine },
        { id: actId('faq'), title: texts.menuFaq },
        { id: actId('urgent'), title: texts.menuUrgent },
        { id: actId('human'), title: texts.menuHuman },
      ]
      await ctx.sendOptions({
        bodyText: texts.menuBody,
        buttonLabel: texts.menuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'faq_open':
      // El paso existe para que el siguiente texto salga hacia la IA: no hay
      // menú, solo se invita a preguntar.
      await ctx.sender.sendText({ text: texts.faqPrompt })
      return { state: { ...state, options: [] }, closed: false }

    default:
      return { state, closed: true }
  }
}

export async function handleClinicChoice(
  ctx: ClinicStepCtx,
  state: BookingState,
  parsed: { kind: OptionKind; value: string } | null,
): Promise<ClinicOutcome> {
  const { texts } = ctx
  switch (state.step) {
    case 'consent': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      if (parsed.value !== 'consent_yes' && parsed.value !== 'consent_no') return { kind: 'fail' }
      // Sin el texto que se le mostró no hay qué registrar: se vuelve a mostrar.
      if (!state.consentText || !state.consentVersion) return { kind: 'fail' }
      const granted = parsed.value === 'consent_yes'
      try {
        await recordConsent(ctx.db, {
          accountId: ctx.accountId,
          contactId: ctx.contactId,
          kind: 'datos_sensibles',
          granted,
          textVersion: state.consentVersion,
          textSnapshot: state.consentText,
          source: 'whatsapp',
          messageId: ctx.inboundMessageId,
          createdAtIso: ctx.nowIso,
        })
      } catch (err) {
        console.error('[clinica] no se pudo guardar la autorización:', err)
        return { kind: 'fail', message: texts.consentError }
      }
      if (!granted) {
        return {
          kind: 'handoff',
          message: texts.consentDeclined,
          note: texts.consentDeclinedNote,
        }
      }
      return { kind: 'next', state: newBookingState('clinic_menu') }
    }

    case 'clinic_menu': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      switch (parsed.value) {
        case 'book':
          return { kind: 'next', state: newBookingState('pick_service') }
        case 'faq':
          return { kind: 'next', state: newBookingState('faq_open') }
        case 'human':
          return { kind: 'handoff' }
        default:
          return { kind: 'fail' }
      }
    }

    default:
      return { kind: 'fail' }
  }
}
```

La tarea 8 cambia `book` para que pase por `pick_patient`. Las tareas 9 y 11 agregan `urgent` y `mine`.

- [ ] **Step 9: Conecta el controlador**

Aplica este cambio a `src/verticals/agenda/agent/controller.ts`. Lo que hace cada parte:

- `Dialog` lleva `clinic`, `clinicUnavailable`, `clinicTexts`, `inboundMessageId` y `humanOwned`. **No** reduzcas el resultado de `loadClinicContext` con `status === 'ok' ? clinic : null` a secas: eso trata una clínica sin configuración como una agenda normal, se salta la autorización y deja el chat a la IA. `clinicUnavailable` es lo que lo impide.
- El cierre de la clínica no disponible va después de los toques de recordatorio y de la rama del hilo de una persona, y antes del pase por palabra.
- Después del pase por palabra: las quejas, pagos y documentos, y la duda que se suelta a la IA.
- Tras `expireStaleSessions`: la autorización antes que cualquier otra cosa, los saludos como palabras de intención y el menú.
- `advanceSession` ignora el doble toque y no reinicia los fallos en pasos clínicos. `registerFail` pone la nota de la autorización sin responder.
- `performHandoff` acepta las opciones, y avisa siempre cuando trae un aviso propio.

```diff
--- a/src/verticals/agenda/agent/controller.ts
+++ b/src/verticals/agenda/agent/controller.ts
@@ -27,4 +27,13 @@ import type { SupabaseClient } from '@supabase/supabase-js'
 import type { ModuleKey, VerticalDispatchResult, VerticalSession } from '@/lib/verticals/types'
 import { notifyAlert } from '@/lib/ops/alert'
+import { latestConsent } from '@/modules/clinica/consent'
+import { loadClinicContext, type ClinicContext } from '@/modules/clinica/settings'
+import {
+  buildClinicTexts,
+  CLINIC_GREETING_WORDS,
+  CLINIC_HUMAN_WORDS,
+  DEFAULT_URGENCY_WORDS,
+  type ClinicTexts,
+} from '@/modules/clinica/texts'
 
 import type { AgendaAppointmentSummary } from '../texts'
@@ -73,6 +82,8 @@ import {
   ansId,
   ansSkipId,
+  containsAnyWord,
   containsHandoffWord,
   containsIntentWord,
+  containsUrgencyWord,
   dayId,
   isHandoffOnly,
@@ -93,4 +104,13 @@ import {
   type ReminderTap,
 } from './state'
+import {
+  handleClinicChoice,
+  isClinicStep,
+  looksLikeQuestion,
+  renderClinicStep,
+  type ClinicHandoff,
+  type ClinicOutcome,
+  type ClinicStepCtx,
+} from './steps/clinic-steps'
 import { addDaysToKey, zonedDateKey, zonedParts } from './time'
 
@@ -193,7 +213,9 @@ export async function handleAgendaInbound(
   }
 
-  const [settings, account] = await Promise.all([
+  const clinicActive = args.modules?.includes('clinica') === true
+  const [settings, account, clinicResult] = await Promise.all([
     loadBotSettings(args.db, args.accountId),
     loadAccount(args.db, args.accountId),
+    clinicActive ? loadClinicContext(args.db, args.accountId) : Promise.resolve(null),
   ])
   const dialog: Dialog = {
@@ -210,4 +232,11 @@ export async function handleAgendaInbound(
     texts: mergeBotTexts(settings.botTexts, settings.labels),
     backend: args.backend ?? createInternalBackend({ db: args.db, accountId: args.accountId }),
+    clinic: clinicResult?.status === 'ok' ? clinicResult.clinic : null,
+    // Con el módulo activo, una configuración que falta o no se pudo leer NO
+    // equivale a una cuenta sin clínica: ver el cierre de más abajo.
+    clinicUnavailable: clinicResult !== null && clinicResult.status !== 'ok',
+    clinicTexts: buildClinicTexts(settings.labels),
+    inboundMessageId: args.inboundMessageId ?? null,
+    humanOwned,
   }
 
@@ -231,4 +260,15 @@ export async function handleAgendaInbound(
   }
 
+  // Clínica sin configuración usable (falta o no se pudo leer): no se sabe qué
+  // autorización pedir ni qué urgencias vigilar, y seguir como una agenda
+  // normal dejaría la conversación de un paciente a la IA sin su permiso. El
+  // bot consume el mensaje y lo deja con una persona. Los toques de
+  // recordatorio ya se atendieron arriba, y un hilo que ya es de una persona
+  // no llega hasta aquí.
+  if (dialog.clinicUnavailable) {
+    await handoffClinicUnavailable(dialog, args.session?.id ?? null, text)
+    return { consumed: true }
+  }
+
   // 1) Pedir un humano gana sobre cualquier paso del flujo. Excepción: mientras
   //    el cliente escribe la respuesta a una pregunta extra de texto, solo cuenta
@@ -244,4 +284,43 @@ export async function handleAgendaInbound(
   }
 
+  // Clínica: quejas, pagos y documentos los atiende una persona (spec §5,
+  // etapa 2). Va al nivel del pase a una persona, así que no espera la
+  // autorización, pero no se aplica mientras la persona escribe un nombre o la
+  // respuesta a una pregunta, ni a una duda ("¿cuánto cuesta el certificado?"
+  // va a la IA).
+  if (
+    dialog.clinic &&
+    replyId === null &&
+    !writingAnswer &&
+    asking?.step !== 'new_patient_name' &&
+    containsAnyWord(text, CLINIC_HUMAN_WORDS) &&
+    !looksLikeQuestion(text, [dialog.settings.labels.cita, dialog.settings.labels.citas])
+  ) {
+    await performHandoff(dialog, args.session?.id ?? null, {
+      note: dialog.clinicTexts.humanTopicNote,
+    })
+    return { consumed: true }
+  }
+
+  // Clínica: una duda escrita con el menú abierto, o lo que se escribe después de
+  // "Precios y dudas", es para la IA. Se cierra la sesión y se suelta el mensaje
+  // con `released`: con `consumed: false` a secas el despachador lo reclamaría
+  // por haber una sesión abierta cuando llegó.
+  if (args.session && dialog.clinic && replyId === null && asking) {
+    const { labels } = dialog.settings
+    const toAi =
+      asking.step === 'faq_open' ||
+      (asking.step === 'clinic_menu' && looksLikeQuestion(text, [labels.cita, labels.citas]))
+    if (toAi) {
+      await closeSession(args.db, {
+        id: args.session.id,
+        accountId: args.accountId,
+        status: 'completed',
+        updatedAtIso: dialog.nowIso,
+      })
+      return { consumed: false, released: true }
+    }
+  }
+
   // 2) Con sesión activa, el flujo es dueño del mensaje.
   if (args.session) {
@@ -258,4 +337,20 @@ export async function handleAgendaInbound(
   )
 
+  // Clínica: sin autorización no se sigue, y la IA no ve la conversación.
+  // Si la autorización no se pudo leer, se vuelve a pedir.
+  if (dialog.clinic) {
+    const consent = await latestConsent(args.db, {
+      accountId: args.accountId,
+      contactId: args.contactId,
+      kind: 'datos_sensibles',
+    })
+    if (!consent?.granted) {
+      const state = newBookingState('consent')
+      const sessionId = await openSession(dialog, state)
+      await conclude(dialog, sessionId, state)
+      return { consumed: true }
+    }
+  }
+
   // Un tap de un menú viejo no arranca nada (y no se consume).
   if (replyId !== null) return { consumed: false }
@@ -264,8 +359,20 @@ export async function handleAgendaInbound(
   //    tiene una cita próxima).
   const { labels } = dialog.settings
-  if (!containsIntentWord(text, [labels.cita, labels.citas, labels.servicio, labels.servicios])) {
+  const intentWords = [labels.cita, labels.citas, labels.servicio, labels.servicios]
+  // En una clínica los saludos también abren el menú.
+  if (dialog.clinic) intentWords.push(...CLINIC_GREETING_WORDS)
+  if (!containsIntentWord(text, intentWords)) {
     return { consumed: false }
   }
 
+  // Clínica: una duda va a la IA; lo demás abre el menú principal.
+  if (dialog.clinic) {
+    if (looksLikeQuestion(text, [labels.cita, labels.citas])) return { consumed: false }
+    const state = newBookingState('clinic_menu')
+    const sessionId = await openSession(dialog, state)
+    await conclude(dialog, sessionId, state)
+    return { consumed: true }
+  }
+
   const existing = await findNextAppointment(
     args.db,
@@ -443,4 +550,16 @@ interface Dialog {
    */
   texts: AgendaAgentTextsMerged
+  /** Configuración de la clínica; null en cuentas sin el módulo o si no está disponible. */
+  clinic: ClinicContext | null
+  /**
+   * La cuenta tiene el módulo clínica pero su configuración falta o no se pudo
+   * leer. Nunca se atiende como una agenda normal: pasa a una persona.
+   */
+  clinicUnavailable: boolean
+  /** Copy del bot clínico. No depende de la configuración, así que siempre existe. */
+  clinicTexts: ClinicTexts
+  /** Id de Meta del mensaje que se está atendiendo; queda en la autorización. */
+  inboundMessageId: string | null
+  humanOwned: boolean
   /**
    * Preguntas extra, leídas una sola vez por mensaje del cliente y compartidas
@@ -490,4 +609,6 @@ function coerceState(raw: Record<string, unknown>): BookingState {
     ...(typeof raw.patientId === 'string' ? { patientId: raw.patientId } : {}),
     ...(typeof raw.dayPage === 'number' ? { dayPage: raw.dayPage } : {}),
+    ...(typeof raw.consentText === 'string' ? { consentText: raw.consentText } : {}),
+    ...(typeof raw.consentVersion === 'number' ? { consentVersion: raw.consentVersion } : {}),
     ...(raw.afterConsent === 'urgency_book' ? { afterConsent: 'urgency_book' as const } : {}),
     ...(raw.urgent === true ? { urgent: true } : {}),
@@ -508,4 +629,12 @@ async function advanceSession(
 ): Promise<void> {
   const state = coerceState(session.state)
+  // Doble toque: la autorización ya se respondió y el menú está abierto. El
+  // segundo toque no es un error del paciente: se ignora, sin mensaje ni fallo.
+  if (
+    state.step === 'clinic_menu' &&
+    (input.replyId === actId('consent_yes') || input.replyId === actId('consent_no'))
+  ) {
+    return
+  }
   // Las preguntas extra se responden escribiendo (o con la opción tocada): no
   // pasan por el emparejamiento general del menú.
@@ -523,5 +652,14 @@ async function advanceSession(
     return
   }
-  await handleChoice(dialog, session.id, { ...state, fails: 0 }, choice)
+  // Un paso normal olvida los fallos al acertar. Los pasos clínicos no: su
+  // "fallo" también es que la base no guardó la respuesta, y si se reiniciara
+  // el paciente repetiría el toque para siempre sin llegar a una persona. Lo
+  // que avanza a otro paso nace con 0.
+  await handleChoice(
+    dialog,
+    session.id,
+    isClinicStep(state.step) ? state : { ...state, fails: 0 },
+    choice,
+  )
 }
 
@@ -539,5 +677,10 @@ async function registerFail(
   const fails = state.fails + 1
   if (fails >= 2) {
-    await performHandoff(dialog, sessionId)
+    // Una autorización sin responder no es un pedido de hablar con una persona.
+    await performHandoff(
+      dialog,
+      sessionId,
+      state.step === 'consent' ? { note: dialog.clinicTexts.consentUnansweredNote } : {},
+    )
     return
   }
@@ -731,4 +874,19 @@ async function handleChoice(
   const parsed = parseOptionId(choice)
 
+  if (isClinicStep(state.step)) {
+    if (!dialog.clinic) {
+      await closeSession(dialog.db, {
+        id: sessionId,
+        accountId: dialog.accountId,
+        status: 'completed',
+        updatedAtIso: dialog.nowIso,
+      })
+      return
+    }
+    const outcome = await handleClinicChoice(clinicCtx(dialog), state, parsed)
+    await applyClinicOutcome(dialog, sessionId, state, outcome)
+    return
+  }
+
   // Pieza "reprogramar/cancelar" apagada: un menú, una confirmación o
   // una reprogramación abiertos antes de apagarla no son un atajo.
@@ -1540,5 +1698,7 @@ async function renderStep(dialog: Dialog, state: BookingState): Promise<Rendered
     case 'pick_appointment':
     case 'marketing_consent':
-      return { state, closed: true }
+    case 'faq_open':
+      if (!dialog.clinic) return { state, closed: true }
+      return renderClinicStep(clinicCtx(dialog), state)
   }
 }
@@ -1846,9 +2006,10 @@ async function performHandoff(
   dialog: Dialog,
   sessionId: string | null,
+  opts: Omit<ClinicHandoff, 'kind'> = {},
 ): Promise<void> {
   await markConversationHandoff(dialog.db, {
     accountId: dialog.accountId,
     conversationId: dialog.conversationId,
-    note: dialog.texts.handoffNote,
+    note: opts.note ?? dialog.texts.handoffNote,
     agentId: await loadHandoffAgentId(dialog.db, dialog.accountId),
   })
@@ -1864,8 +2025,14 @@ async function performHandoff(
 
   // El trigger de asignación avisa al agente; el dueño recibe su
-  // aviso aquí para que el equipo lo vea aunque no haya agente.
+  // aviso aquí para que el equipo lo vea aunque no haya agente. Un aviso
+  // propio (el de urgencia) no se puede perder: sale siempre, también cuando
+  // el dueño es el agente y el trigger solo le dice que le asignaron un chat,
+  // y le llega además al agente.
   const agentId = await loadHandoffAgentId(dialog.db, dialog.accountId)
   const owner = dialog.account?.ownerUserId ?? null
-  if (owner && owner !== agentId) {
+  const recipients = new Set<string>()
+  if (owner && (owner !== agentId || opts.notification)) recipients.add(owner)
+  if (opts.notification && agentId) recipients.add(agentId)
+  if (recipients.size) {
     const contact = await loadContact(
       dialog.db,
@@ -1874,14 +2041,16 @@ async function performHandoff(
     )
     const who = contact?.name?.trim() || contact?.phone || 'Un cliente'
-    await bestEffort('aviso de handoff al equipo', () =>
-      insertNotification(dialog.db, {
-        accountId: dialog.accountId,
-        userId: owner,
-        conversationId: dialog.conversationId,
-        contactId: dialog.contactId,
-        title: dialog.texts.handoffNotificationTitle,
-        body: dialog.texts.handoffNotificationBody(who),
-      }),
-    )
+    for (const userId of recipients) {
+      await bestEffort('aviso de handoff al equipo', () =>
+        insertNotification(dialog.db, {
+          accountId: dialog.accountId,
+          userId,
+          conversationId: dialog.conversationId,
+          contactId: dialog.contactId,
+          title: opts.notification?.title ?? dialog.texts.handoffNotificationTitle,
+          body: (opts.notification?.body ?? dialog.texts.handoffNotificationBody)(who),
+        }),
+      )
+    }
   }
 
@@ -1895,5 +2064,32 @@ async function performHandoff(
   }
 
-  await dialog.sender.sendText({ text: dialog.texts.handoff })
+  await dialog.sender.sendText({ text: opts.message ?? dialog.texts.handoff })
+}
+
+/**
+ * Clínica sin configuración usable: el hilo queda con una persona. Si el
+ * mensaje parece una urgencia (con las palabras de siempre, porque las de la
+ * clínica no se pudieron leer), el aviso al equipo es el prioritario.
+ */
+async function handoffClinicUnavailable(
+  dialog: Dialog,
+  sessionId: string | null,
+  text: string,
+): Promise<void> {
+  const { clinicTexts: texts } = dialog
+  const urgent = containsUrgencyWord(text, DEFAULT_URGENCY_WORDS)
+  await performHandoff(
+    dialog,
+    sessionId,
+    urgent
+      ? {
+          note: texts.clinicUnavailableUrgentNote,
+          notification: {
+            title: texts.urgencyNotificationTitle,
+            body: texts.urgencyNotificationBody,
+          },
+        }
+      : { note: texts.clinicUnavailableNote },
+  )
 }
 
@@ -2140,2 +2336,53 @@ async function bestEffort(label: string, fn: () => Promise<unknown>) {
   }
 }
+
+// ------------------------------------------------------------
+// Pasos clínicos
+// ------------------------------------------------------------
+
+function clinicCtx(dialog: Dialog): ClinicStepCtx {
+  return {
+    db: dialog.db,
+    sender: dialog.sender,
+    backend: dialog.backend,
+    clinic: dialog.clinic!,
+    texts: dialog.clinicTexts,
+    accountId: dialog.accountId,
+    contactId: dialog.contactId,
+    conversationId: dialog.conversationId,
+    now: dialog.now,
+    nowIso: dialog.nowIso,
+    inboundMessageId: dialog.inboundMessageId,
+    sendOptions: (args) => sendOptions(dialog, args),
+  }
+}
+
+async function applyClinicOutcome(
+  dialog: Dialog,
+  sessionId: string,
+  state: BookingState,
+  outcome: ClinicOutcome,
+): Promise<void> {
+  switch (outcome.kind) {
+    case 'next':
+      await conclude(dialog, sessionId, outcome.state)
+      return
+    case 'handoff':
+      await performHandoff(dialog, sessionId, outcome)
+      return
+    case 'done':
+      await closeSession(dialog.db, {
+        id: sessionId,
+        accountId: dialog.accountId,
+        status: 'completed',
+        updatedAtIso: dialog.nowIso,
+      })
+      return
+    case 'fail':
+      await registerFail(dialog, sessionId, state, outcome.message)
+      return
+    case 'reminder':
+      await registerFail(dialog, sessionId, state)
+      return
+  }
+}
```

La tarea 11 reemplaza el caso `reminder` de `applyClinicOutcome`.

- [ ] **Step 10: Cierra la puerta a la IA ante un error inesperado**

En `src/verticals/agenda/agent/index.ts`, agrega los imports de `notifyAlert` y `VerticalDispatchResult`, y reemplaza `agendaInboundHandler`:

```ts
import { notifyAlert } from '@/lib/ops/alert'
import type {
  VerticalDispatchResult,
  VerticalInboundContext,
  VerticalInboundHandler,
} from '@/lib/verticals/types'
```

```ts
/** Cuánto del error cabe en la alerta: sirve para ubicarlo, no para volcar datos. */
const ALERT_ERROR_MAX = 300

/**
 * El error de la base puede repetir la fila que no pudo guardar, con el
 * teléfono o el identificador de WhatsApp del paciente. La alerta sale a un
 * canal de operaciones: se quitan los números largos, con o sin separadores.
 */
function scrubDigits(text: string): string {
  return text.replace(/\+?\d(?:[\s().-]?\d){5,}/g, '#').replace(/\d{4,}/g, '#')
}

/**
 * Si el controlador lanza, el dispatcher lo registra y devuelve
 * `consumed: false`, y entonces la IA ve el mensaje. Con el módulo clínica
 * eso no puede pasar: sería la conversación de un paciente, quizá sin su
 * autorización. Por eso, solo en esas cuentas, el error se registra, se avisa
 * al equipo técnico y el mensaje se da por consumido. Las demás cuentas
 * siguen igual: el error sube.
 */
async function failClosed(
  ctx: VerticalInboundContext,
  err: unknown,
): Promise<VerticalDispatchResult> {
  if (ctx.modules?.includes('clinica') !== true) throw err
  console.error('[clinica] el bot falló con un mensaje; no se pasa a la IA:', err)
  const reason = err instanceof Error ? err.message : String(err)
  await notifyAlert(
    `Clínica: el bot falló con un mensaje y no se lo pasó a la IA (cuenta ${ctx.accountId}, conversación ${ctx.conversationId}). ` +
      `El paciente puede haberse quedado sin respuesta; hay que revisar el chat. Error: ${scrubDigits(reason).slice(0, ALERT_ERROR_MAX)}`,
  )
  return { consumed: true }
}

/**
 * Punto de entrada del seam: el webhook ya validó la firma, guardó
 * el mensaje entrante y resolvió cuenta/contacto/conversación. Aquí
 * solo se construye el sender y se delega en el controlador. Todo lo que
 * pueda lanzar va dentro del `try` (ver `failClosed`).
 */
export const agendaInboundHandler: VerticalInboundHandler = async (ctx) => {
  try {
    return await handleAgendaInbound({
      db: ctx.db,
      sender: createAgendaSender(ctx),
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      inboundMessageId: ctx.inboundMessageId,
      session: ctx.session,
      humanOwned: ctx.humanOwned ?? false,
      modules: ctx.modules,
    })
  } catch (err) {
    return failClosed(ctx, err)
  }
}
```

El dispatcher sigue con su propio `catch` (devuelve `consumed: false` si lo que falla es la lectura de módulos antes de llamar al handler). Eso ya no deja pasar a la IA el chat de quien no autorizó, porque `canUseAi` lo comprueba donde la IA lo lee (regla 2).

- [ ] **Step 11: Corre las pruebas**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src`
Expected: PASS. Ninguna prueba de `controller.test.ts` ni de `reminders.test.ts` se modifica.

- [ ] **Step 12: Commit**

```bash
git add src messages
git commit -m "feat(clinica): ask for data consent and open the clinic menu"
```

---

### Task 8: Pacientes y familia

**Files:**
- Create: `src/modules/clinica/patients.ts`, `src/modules/clinica/patients.test.ts`, `src/verticals/agenda/agent/clinic-patients.test.ts`
- Modify: `src/verticals/agenda/agent/backend.ts`, `src/verticals/agenda/agent/internal-backend.ts`, `src/verticals/agenda/agent/steps/clinic-steps.ts`, `src/verticals/agenda/agent/controller.ts`, `src/verticals/agenda/agent/db.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/modules/clinica/patients.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { validatePatientName } from './patients'

describe('validatePatientName', () => {
  it('pide nombre y apellido', () => {
    expect(validatePatientName('Juan Pérez')).toEqual({ ok: true, value: 'Juan Pérez' })
    expect(validatePatientName('  Ana   María  Ruiz ')).toEqual({ ok: true, value: 'Ana María Ruiz' })
    expect(validatePatientName('Juan')).toEqual({ ok: false })
  })

  it('rechaza números, control y textos muy largos', () => {
    expect(validatePatientName('Juan 123')).toEqual({ ok: false })
    expect(validatePatientName('Juan​ Pérez')).toEqual({ ok: false })
    expect(validatePatientName('a b'.repeat(60))).toEqual({ ok: false })
  })
})
```

Crea `src/verticals/agenda/agent/clinic-patients.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT,
  CONTACT,
  SERVICE_LIMPIEZA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import { patId, svcId } from './state'

const family = () => [
  { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
  { id: 'pat-2', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil' },
]

describe('pacientes por número', () => {
  it('sin pacientes pide el nombre y lo registra', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).bodyText).toContain('nombre y los apellidos')

    await send(db, rec, { text: 'Tomás Gil Ruiz' })
    expect(db._tables.clinic_patients).toMatchObject([
      { account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil Ruiz' },
    ])
    expect(last(rec).ids).toContain(svcId(SERVICE_LIMPIEZA))
  })

  it('un nombre incompleto se vuelve a pedir, y al segundo fallo pasa a una persona', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { text: 'Juan' })
    expect(rec.calls.at(-2)?.bodyText).toContain('Necesito nombre y apellidos')
    await send(db, rec, { text: 'Juan' })
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('con varios pacientes los ofrece junto a "Otra persona"', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    expect(last(rec).titles).toEqual(['Marta Ruiz', 'Tomás Gil', 'Otra persona'])
  })

  it('la cita queda a nombre del paciente elegido', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { replyId: patId('pat-2') })
    await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
    await send(db, rec, { replyId: last(rec).ids[0] }) // día
    await send(db, rec, { replyId: last(rec).ids[0] }) // hora
    await send(db, rec, { replyId: 'act:confirm' })
    expect(db._tables.booking_appointments).toMatchObject([{ patient_id: 'pat-2' }])
  })

  it('un paciente de otro contacto no se puede elegir', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: family() })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { replyId: patId('ajeno') })
    expect(last(rec).titles).toContain('Otra persona')
  })
})
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/modules/clinica/patients.test.ts src/verticals/agenda/agent/clinic-patients.test.ts`
Expected: FAIL, no existe `./patients`.

- [ ] **Step 3: Crea el acceso a pacientes**

Crea `src/modules/clinica/patients.ts`:

```ts
// ============================================================
// Pacientes de un contacto. Un número de WhatsApp puede tener varios:
// una mamá agenda a sus hijos desde el suyo. La autorización la da el
// contacto; la cita es del paciente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ClinicPatient {
  id: string
  fullName: string
}

export const PATIENT_NAME_MAX = 120

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u
const HAS_DIGIT = /\p{N}/u

/** Nombre y apellidos: dos palabras o más, sin números ni caracteres invisibles. */
export function validatePatientName(raw: string): { ok: true; value: string } | { ok: false } {
  const value = raw.replace(/\s+/gu, ' ').trim()
  if (CONTROL_OR_FORMAT.test(value) || HAS_DIGIT.test(value)) return { ok: false }
  if ([...value].length > PATIENT_NAME_MAX) return { ok: false }
  if (value.split(' ').length < 2) return { ok: false }
  return { ok: true, value }
}

export async function listPatients(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<ClinicPatient[]> {
  const { data, error } = await db
    .from('clinic_patients')
    .select('id, full_name')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .order('full_name')
  if (error) throw new Error(`No se pudieron leer los pacientes: ${error.message}`)
  return ((data ?? []) as { id: string; full_name: string }[]).map((row) => ({
    id: row.id,
    fullName: row.full_name,
  }))
}

export async function insertPatient(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; fullName: string },
): Promise<ClinicPatient> {
  const id = crypto.randomUUID()
  const { error } = await db.from('clinic_patients').insert({
    id,
    account_id: args.accountId,
    contact_id: args.contactId,
    full_name: args.fullName,
  })
  if (error) throw new Error(`No se pudo registrar al paciente: ${error.message}`)
  return { id, fullName: args.fullName }
}
```

- [ ] **Step 4: Agrega pacientes a la interfaz**

En `src/verticals/agenda/agent/backend.ts`:

```ts
import type { ClinicPatient } from '@/modules/clinica/patients'
```

En `BookArgs`, después de `staffId: string`:

```ts
  patientId?: string | null
  locationId?: string | null
```

En `ClinicBackend`, antes de `book`:

```ts
  findPatients(args: { contactId: string }): Promise<ClinicPatient[]>
  createPatient(args: { contactId: string; fullName: string }): Promise<ClinicPatient>
```

En `src/verticals/agenda/agent/internal-backend.ts`:

```ts
import { insertPatient, listPatients } from '@/modules/clinica/patients'
```

```ts
    findPatients: ({ contactId }) => listPatients(db, { accountId, contactId }),

    createPatient: ({ contactId, fullName }) =>
      insertPatient(db, { accountId, contactId, fullName }),
```

En `src/verticals/agenda/agent/db.ts`, en los argumentos de `insertAppointment`, después de `rescheduledFrom?`:

```ts
    patientId?: string | null
    locationId?: string | null
```

Y dentro del `insert`, después de `confirmed_at`. Solo se envían si vienen, para no tocar a los demás negocios:

```ts
    ...(args.patientId ? { patient_id: args.patientId } : {}),
    ...(args.locationId ? { location_id: args.locationId } : {}),
```

- [ ] **Step 5: Agrega los pasos**

En `src/verticals/agenda/agent/steps/clinic-steps.ts`:

```ts
import { validatePatientName } from '@/modules/clinica/patients'
```

Agrega `patId` al import de `../state`, y después de `looksLikeQuestion`:

```ts
/** Con paciente elegido sigue la reserva; una urgencia salta al menú de horas. */
function afterPatient(state: BookingState, patientId: string): BookingState {
  return { ...state, patientId, step: state.urgent ? 'pick_slot' : 'pick_service' }
}

/** Lo que escribe el cliente en el paso del nombre. */
export async function handlePatientName(
  ctx: ClinicStepCtx,
  state: BookingState,
  input: { text: string; replyId: string | null },
): Promise<ClinicOutcome> {
  const name = input.replyId === null ? validatePatientName(input.text) : ({ ok: false } as const)
  if (!name.ok) return { kind: 'fail', message: ctx.texts.patientNameRetry }
  try {
    const patient = await ctx.backend.createPatient({
      contactId: ctx.contactId,
      fullName: name.value,
    })
    return { kind: 'next', state: afterPatient({ ...state, fails: 0 }, patient.id) }
  } catch (err) {
    console.error('[clinica] no se pudo registrar al paciente:', err)
    return { kind: 'fail', message: ctx.texts.patientSaveError }
  }
}
```

En `renderClinicStep`, antes de `default`:

```ts
    case 'pick_patient': {
      const patients = await ctx.backend.findPatients({ contactId: ctx.contactId })
      if (!patients.length) {
        return renderClinicStep(ctx, { ...state, step: 'new_patient_name' })
      }
      const options: OfferedOption[] = [
        ...patients.slice(0, 9).map((p) => ({ id: patId(p.id), title: p.fullName })),
        { id: patId('new'), title: texts.patientOther },
      ]
      await ctx.sendOptions({
        bodyText: texts.patientMenuBody,
        buttonLabel: texts.patientMenuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'new_patient_name': {
      await ctx.sender.sendText({ text: texts.patientNamePrompt })
      return { state: { ...state, options: [] }, closed: false }
    }
```

En `handleClinicChoice`, cambia `case 'book'`:

```ts
        case 'book':
          return { kind: 'next', state: newBookingState('pick_patient') }
```

Y antes de `default`:

```ts
    case 'pick_patient': {
      if (parsed?.kind !== 'pat') return { kind: 'fail' }
      if (parsed.value === 'new') {
        return { kind: 'next', state: { ...state, step: 'new_patient_name' } }
      }
      const patients = await ctx.backend.findPatients({ contactId: ctx.contactId })
      if (!patients.some((p) => p.id === parsed.value)) return { kind: 'fail' }
      return { kind: 'next', state: afterPatient(state, parsed.value) }
    }
```

- [ ] **Step 6: Conecta el controlador**

En `src/verticals/agenda/agent/controller.ts`:

1. Agrega `handlePatientName` al import de `./steps/clinic-steps`.

2. En `advanceSession`, después del bloque de `ask_question`:

```ts
  if (state.step === 'new_patient_name' && dialog.clinic) {
    const outcome = await handlePatientName(clinicCtx(dialog), state, input)
    await applyClinicOutcome(dialog, session.id, state, outcome)
    return
  }
```

3. En `handleAgendaInbound`, cambia `writingAnswer`, para que escribir un nombre no dispare el pase a una persona:

```ts
  const writingAnswer =
    (asking?.step === 'ask_question' && asking.options.length === 0) ||
    asking?.step === 'new_patient_name'
```

4. En `confirmAppointment`, en la llamada a `dialog.backend.book`, después de `staffId: assigned,`:

```ts
    patientId: state.patientId ?? oldAppt?.patientId ?? null,
    locationId: dialog.clinic?.location?.id ?? null,
```

5. Para conservar el paciente al reprogramar, en `src/verticals/agenda/agent/db.ts` agrega una lectura aparte. `APPOINTMENT_COLS` no cambia, porque otros negocios lo leen y la columna puede no existir aún:

```ts
/** Paciente de una cita (módulo clínica). */
export async function loadAppointmentPatientId(
  db: SupabaseClient,
  accountId: string,
  appointmentId: string,
): Promise<string | null> {
  const { data } = await db
    .from('booking_appointments')
    .select('patient_id')
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data as Record<string, unknown> | null)?.patient_id as string | null) ?? null
}
```

Y en `confirmAppointment`, antes de `const appointmentId = crypto.randomUUID()`:

```ts
  const patientId =
    state.patientId ??
    (dialog.clinic && oldAppt
      ? await loadAppointmentPatientId(dialog.db, dialog.accountId, oldAppt.id)
      : null)
```

Y usa ese valor en la llamada:

```ts
    patientId,
```

Agrega `loadAppointmentPatientId` al import de `./db`.

- [ ] **Step 7: Corre las pruebas**

Run: `npx vitest run src/modules/clinica src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/clinica src/verticals/agenda/agent
git commit -m "feat(clinica): book for several patients from one number"
```

---

### Task 9: Urgencias

**Files:**
- Create: `src/verticals/agenda/agent/clinic-urgency.test.ts`
- Modify: `src/verticals/agenda/agent/steps/clinic-steps.ts`, `src/verticals/agenda/agent/controller.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/verticals/agenda/agent/clinic-urgency.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  CONVERSATION,
  OWNER,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'

/** Sábado 24 de octubre: sin horario. */
const SATURDAY = new Date('2026-10-24T13:00:00Z')

describe('urgencias', () => {
  it('va antes de la autorización: nadie con dolor se queda en un aviso legal', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Tengo mucho dolor' })
    expect(last(rec).bodyText).toContain('Signos de alarma')
    expect(last(rec).ids).toEqual(['act:alarm_yes', 'act:alarm_no'])
  })

  it('con signos de alarma manda a urgencias, pausa el bot y avisa con prioridad', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'urgencia' })
    await send(db, rec, { replyId: 'act:alarm_yes' })
    expect(last(rec).bodyText).toContain('ve a urgencias')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(db._tables.notifications).toMatchObject([
      { user_id: OWNER, conversation_id: CONVERSATION, title: '🚨 Posible urgencia' },
    ])
  })

  it('sin signos y sin autorización, la pide y luego ofrece la hora de hoy', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'urgencia' })
    await send(db, rec, { replyId: 'act:alarm_no' })
    expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
    await send(db, rec, { replyId: 'act:consent_yes' })
    expect(last(rec).bodyText).toContain('nombre y los apellidos')
    await send(db, rec, { text: 'Marta Ruiz' })
    expect(last(rec).ids.every((id) => id.startsWith('slot:'))).toBe(true)
  })

  it('sin cupo hoy da el teléfono de turno y pasa a una persona', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'urgencia' }, { now: SATURDAY })
    await send(db, rec, { replyId: 'act:alarm_no' }, { now: SATURDAY })
    expect(last(rec).bodyText).toContain('3001234567')
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
  })

  it('en un hilo de una persona el bot no responde y avisa a quien lo lleva', async () => {
    const db = clinicDb()
    db._tables.conversations[0].assigned_agent_id = 'user-agent'
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'me duele, tengo dolor' }, { humanOwned: true })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
    expect(db._tables.notifications).toMatchObject([
      { user_id: 'user-agent', title: '🚨 Posible urgencia' },
    ])
  })

  it('escribir el nombre "Dolores" no abre la urgencia', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:book' })
    await send(db, rec, { text: 'Dolores Ruiz' })
    expect(db._tables.clinic_patients[0].full_name).toBe('Dolores Ruiz')
  })

  it('una cuenta sin el módulo no conoce las urgencias', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'tengo dolor' }, { modules: ['agenda'] })
    expect(result).toEqual({ consumed: false })
  })
})
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda/agent/clinic-urgency.test.ts`
Expected: FAIL, el bot pide autorización en vez de mostrar los signos.

- [ ] **Step 3: Agrega los pasos**

En `src/verticals/agenda/agent/steps/clinic-steps.ts`:

1. Agrega `zonedDateKey` desde `../time`:

```ts
import { zonedDateKey } from '../time'
```

2. Agrega `latestConsent` al import:

```ts
import { latestConsent, recordConsent } from '@/modules/clinica/consent'
```

3. En `ClinicStepCtx`, agrega:

```ts
  /** Servicio activo por id, con los candidatos que lo atienden. */
  serviceScope(serviceId: string): Promise<{ service: ServiceInfo; staffIds: string[] } | null>
```

Y el import:

```ts
import type { ServiceInfo } from '../db'
```

4. Después de `handlePatientName`:

```ts
function urgencyHandoff(ctx: ClinicStepCtx): ClinicHandoff {
  return {
    kind: 'handoff',
    message: ctx.texts.urgencyOffHours(ctx.clinic.location?.onCallPhone ?? null),
    note: ctx.texts.urgencyOffHoursNote,
    notification: {
      title: ctx.texts.urgencyNotificationTitle,
      body: ctx.texts.urgencyNotificationBody,
    },
  }
}

/**
 * Sin signos de alarma: la primera hora de hoy de la atención de urgencia.
 * Sin cupo hoy (fuera de horario o agenda llena) pasa a una persona.
 */
async function urgencyBooking(ctx: ClinicStepCtx): Promise<ClinicOutcome> {
  const serviceId = ctx.clinic.urgencyServiceId
  const scope = serviceId ? await ctx.serviceScope(serviceId) : null
  if (!scope) return urgencyHandoff(ctx)

  const dateKey = zonedDateKey(ctx.now)
  const slots = await ctx.backend.getDaySlots({ ...scope, dateKey, now: ctx.now })
  if (!slots.length) return urgencyHandoff(ctx)

  return {
    kind: 'next',
    state: newBookingState('pick_patient', {
      serviceId: scope.service.id,
      staffId: 'any',
      dateKey,
      urgent: true,
    }),
  }
}
```

5. En `renderClinicStep`, antes de `default`:

```ts
    case 'urgency': {
      const options: OfferedOption[] = [
        { id: actId('alarm_yes'), title: texts.urgencyYes },
        { id: actId('alarm_no'), title: texts.urgencyNo },
      ]
      await ctx.sendOptions({
        bodyText: texts.urgencyBody(ctx.clinic.urgencyAlarmText),
        buttonLabel: texts.menuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }
```

6. En `handleClinicChoice`, en `case 'consent'`, reemplaza el último `return`:

```ts
      if (state.afterConsent === 'urgency_book') return urgencyBooking(ctx)
      return { kind: 'next', state: newBookingState('clinic_menu') }
```

7. En `clinic_menu`, agrega:

```ts
        case 'urgent':
          return { kind: 'next', state: newBookingState('urgency') }
```

8. Antes de `default` de `handleClinicChoice`:

```ts
    case 'urgency': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      if (parsed.value === 'alarm_yes') {
        return {
          kind: 'handoff',
          message: texts.urgencyGoEr,
          note: texts.urgencyNote,
          notification: {
            title: texts.urgencyNotificationTitle,
            body: texts.urgencyNotificationBody,
          },
        }
      }
      if (parsed.value !== 'alarm_no') return { kind: 'fail' }
      const consent = await latestConsent(ctx.db, {
        accountId: ctx.accountId,
        contactId: ctx.contactId,
        kind: 'datos_sensibles',
      })
      if (!consent?.granted) {
        return { kind: 'next', state: newBookingState('consent', { afterConsent: 'urgency_book' }) }
      }
      return urgencyBooking(ctx)
    }
```

- [ ] **Step 4: Conecta el controlador**

En `src/verticals/agenda/agent/controller.ts`:

1. Agrega `containsUrgencyWord` al import de `./state`.

2. En `clinicCtx`, agrega:

```ts
    serviceScope: (serviceId) =>
      slotScope(dialog, newBookingState('pick_day', { serviceId, staffId: 'any' })),
```

3. Reemplaza la puerta inicial del hilo humano:

```ts
  if (
    humanOwned &&
    !reminderTap &&
    !isCancelConfirmTap(args.session ?? null, replyId)
  ) {
    if (clinicActive && replyId === null) await warnHumanOfUrgency(args, text)
    return { consumed: false }
  }
```

Mueve `const clinicActive = args.modules?.includes('clinica') === true` arriba de esa puerta.

4. Agrega, después de `handleAgendaInbound`:

```ts
/**
 * Palabra de urgencia en un hilo de una persona: el bot no responde para
 * no pisarla, pero le avisa a quien lo lleva (o al dueño).
 */
async function warnHumanOfUrgency(args: HandleAgendaInboundArgs, text: string): Promise<void> {
  await bestEffort('aviso de urgencia a la persona del hilo', async () => {
    const clinic = await loadClinicContext(args.db, args.accountId)
    if (!clinic || !containsUrgencyWord(text, clinic.urgencyWords)) return
    const [settings, account, assignee, contact] = await Promise.all([
      loadBotSettings(args.db, args.accountId),
      loadAccount(args.db, args.accountId),
      loadConversationAssignee(args.db, args.accountId, args.conversationId),
      loadContact(args.db, args.accountId, args.contactId),
    ])
    const userId = assignee ?? account?.ownerUserId ?? null
    if (!userId) return
    const texts = buildClinicTexts(settings.labels)
    const who = contact?.name?.trim() || contact?.phone || 'Un paciente'
    await insertNotification(args.db, {
      accountId: args.accountId,
      userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      title: texts.urgencyNotificationTitle,
      body: texts.urgencyNotificationBody(who),
    })
  })
}
```

5. En `handleAgendaInbound`, antes de `// 1) Pedir un humano gana...`:

```ts
  // Clínica: la urgencia gana sobre todo, incluso sobre la autorización.
  // No aplica mientras responde los signos ni mientras escribe un nombre.
  if (dialog.clinic && replyId === null) {
    const current = args.session ? coerceState(args.session.state) : null
    const busy = current?.step === 'urgency' || current?.step === 'new_patient_name'
    if (!busy && containsUrgencyWord(text, dialog.clinic.urgencyWords)) {
      const state = newBookingState('urgency')
      const sessionId = args.session?.id ?? (await openSession(dialog, state))
      await conclude(dialog, sessionId, state)
      return { consumed: true }
    }
  }
```

- [ ] **Step 5: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(clinica): handle dental emergencies with a fixed flow"
```

---

### Task 10: Citas lejanas

**Files:**
- Create: `src/verticals/agenda/agent/clinic-days.test.ts`
- Modify: `src/verticals/agenda/agent/controller.ts`

- [ ] **Step 1: Escribe la prueba que falla**

Crea `src/verticals/agenda/agent/clinic-days.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT,
  CONTACT,
  SERVICE_LIMPIEZA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import { patId, svcId } from './state'

async function openDayMenu() {
  const db = clinicDb({
    clinic_consents: [grantedConsent()],
    clinic_patients: [{ id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' }],
  })
  const rec = makeRecorder()
  await send(db, rec, { text: 'Hola' })
  await send(db, rec, { replyId: 'act:book' })
  await send(db, rec, { replyId: patId('pat-1') })
  await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
  return { db, rec }
}

describe('citas lejanas', () => {
  it('muestra 9 días y "Ver más días" cuando hay más', async () => {
    const { rec } = await openDayMenu()
    expect(last(rec).ids).toHaveLength(10)
    expect(last(rec).ids.at(-1)).toBe('act:more_days')
    expect(last(rec).titles.at(-1)).toBe('Ver más días')
  })

  it('"Ver más días" pasa a la siguiente página', async () => {
    const { db, rec } = await openDayMenu()
    const first = last(rec).ids
    await send(db, rec, { replyId: 'act:more_days' })
    expect(last(rec).ids[0]).not.toBe(first[0])
    expect(last(rec).ids.filter((id) => first.includes(id) && id.startsWith('day:'))).toEqual([])
  })

  it('llega hasta offer_days y se detiene', async () => {
    const { db, rec } = await openDayMenu()
    db._tables.clinic_settings[0].offer_days = 10
    await send(db, rec, { replyId: 'act:more_days' })
    expect(last(rec).ids).not.toContain('act:more_days')
  })
})
```

- [ ] **Step 2: Córrela y verifica que falla**

Run: `npx vitest run src/verticals/agenda/agent/clinic-days.test.ts`
Expected: FAIL, el menú trae solo los días de la semana.

- [ ] **Step 3: Implementa**

En `src/verticals/agenda/agent/controller.ts`:

1. Después de `MAX_LIST_OPTIONS`:

```ts
/** Días por página: una fila de la lista queda para "Ver más días". */
const DAY_PAGE_SIZE = MAX_LIST_OPTIONS - 1
```

2. En `dayOptions`, cambia `days: OFFER_DAYS,` por:

```ts
    days: dialog.clinic?.offerDays ?? OFFER_DAYS,
```

Y el comentario de la función:

```ts
/** Próximos días (7, o los que fije la clínica) con al menos una hora ofrecible. */
```

3. En `renderStep`, reemplaza el `case 'pick_day'` por:

```ts
    case 'pick_day': {
      const days = await dayOptions(dialog, state)
      if (!days.length) {
        await dialog.sender.sendText({
          text: dialog.texts.noDaysAvailable,
        })
        return { state, closed: true }
      }
      // Si la agenda cambió y la página quedó vacía, se vuelve a la primera.
      const requested = state.dayPage ?? 0
      const page = requested * DAY_PAGE_SIZE < days.length ? requested : 0
      const shown = days.slice(page * DAY_PAGE_SIZE, (page + 1) * DAY_PAGE_SIZE)
      const options: OfferedOption[] = shown.map((day) => ({
        id: dayId(day.key),
        title: day.label,
      }))
      if (days.length > (page + 1) * DAY_PAGE_SIZE && dialog.clinicTexts) {
        options.push({ id: actId('more_days'), title: dialog.clinicTexts.moreDays })
      }
      await sendOptions(dialog, {
        bodyText:
          state.mode === 'reschedule'
            ? dialog.texts.rescheduleStart
            : dialog.texts.dayMenuBody,
        buttonLabel: dialog.texts.dayMenuButton,
        options,
      })
      return { state: { ...state, options, dayPage: page }, closed: false }
    }
```

4. En `handleChoice`, al inicio de `case 'pick_day'`:

```ts
      if (parsed?.kind === 'act' && parsed.value === 'more_days') {
        await conclude(dialog, sessionId, { ...state, dayPage: (state.dayPage ?? 0) + 1 })
        return
      }
```

**Nota:** el estado de la sesión lleva `dayPage: 0` en todas las cuentas. No afecta a las pruebas existentes, porque comparan opciones y no el estado completo. Si alguna compara el estado completo, cambia `{ ...state, options, dayPage: page }` por `{ ...state, options, ...(page ? { dayPage: page } : {}) }`.

- [ ] **Step 4: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(clinica): offer appointments further ahead, page by page"
```

---

### Task 11: Mis citas y varias citas en un número

**Files:**
- Create: `src/verticals/agenda/agent/clinic-appointments.test.ts`
- Modify: `src/verticals/agenda/agent/backend.ts`, `src/verticals/agenda/agent/internal-backend.ts`, `src/verticals/agenda/agent/steps/clinic-steps.ts`, `src/verticals/agenda/agent/controller.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/verticals/agenda/agent/clinic-appointments.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT,
  CONTACT,
  CONVERSATION,
  SERVICE_LIMPIEZA,
  STAFF_ANA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import { apptId, remId } from './state'

const appointment = (id: string, patientId: string, startsAt: string) => ({
  id,
  account_id: ACCOUNT,
  contact_id: CONTACT,
  conversation_id: CONVERSATION,
  service_id: SERVICE_LIMPIEZA,
  staff_id: STAFF_ANA,
  patient_id: patientId,
  starts_at: startsAt,
  ends_at: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
  status: 'pending',
  answers: {},
})

const family = () => [
  { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
  { id: 'pat-2', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil' },
]

const twoAppointments = () =>
  clinicDb({
    clinic_consents: [grantedConsent()],
    clinic_patients: family(),
    booking_appointments: [
      appointment('ap-1', 'pat-1', '2026-10-20T14:00:00.000Z'),
      appointment('ap-2', 'pat-2', '2026-10-20T15:00:00.000Z'),
    ],
  })

describe('varias citas en un número', () => {
  it('Mis citas lista las citas con el nombre de cada paciente', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:mine' })
    expect(last(rec).ids).toEqual([apptId('ap-1'), apptId('ap-2')])
    expect(last(rec).bodyText).toContain('Marta Ruiz')
    expect(last(rec).bodyText).toContain('Tomás Gil')
    expect(last(rec).titles[1]).toContain('Tomás')
  })

  it('con una sola cita va directo a gestionarla', async () => {
    const db = clinicDb({
      clinic_consents: [grantedConsent()],
      clinic_patients: family(),
      booking_appointments: [appointment('ap-1', 'pat-1', '2026-10-20T14:00:00.000Z')],
    })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:mine' })
    expect(last(rec).ids).toContain('act:reschedule')
  })

  it('sin citas lo dice y vuelve al menú', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:mine' })
    expect(rec.calls.at(-2)?.bodyText).toContain('No tienes citas próximas')
    expect(last(rec).ids[0]).toBe('act:book')
  })

  it('un toque con el id confirma esa cita y no la otra', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { replyId: remId('confirm', 'ap-2') })
    const byId = Object.fromEntries(db._tables.booking_appointments.map((a) => [a.id, a.status]))
    expect(byId).toEqual({ 'ap-1': 'pending', 'ap-2': 'confirmed' })
  })

  it('un toque sin id con dos citas cercanas pregunta cuál', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { replyId: 'Confirmar' })
    expect(last(rec).ids).toEqual([apptId('ap-1'), apptId('ap-2')])
    await send(db, rec, { replyId: apptId('ap-2') })
    const byId = Object.fromEntries(db._tables.booking_appointments.map((a) => [a.id, a.status]))
    expect(byId).toEqual({ 'ap-1': 'pending', 'ap-2': 'confirmed' })
  })

  it('un toque con el id de una cita ajena dice que ya no está activa', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { replyId: remId('confirm', 'ap-ajena') })
    expect(last(rec).bodyText).toContain('ya no está activo')
  })

  it('confirmar manda las instrucciones y el mapa de la sede', async () => {
    const db = twoAppointments()
    const rec = makeRecorder()
    await send(db, rec, { replyId: remId('confirm', 'ap-1') })
    expect(last(rec).bodyText).toContain('Cepíllate antes de venir.')
    expect(last(rec).bodyText).toContain('Calle 1 # 2-3')
    expect(last(rec).bodyText).toContain('google.com/maps')
  })
})
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda/agent/clinic-appointments.test.ts`
Expected: FAIL, `act:mine` cuenta como fallo.

- [ ] **Step 3: Agrega `listUpcoming`**

En `src/verticals/agenda/agent/backend.ts`:

```ts
/** Cita activa próxima, con el nombre de su paciente. */
export interface AppointmentSnapshot {
  id: string
  startsAt: Date
  patientName: string | null
}
```

Y en `ClinicBackend`, antes de `book`:

```ts
  /** Citas activas futuras del contacto, en orden. Consulta en vivo. */
  listUpcoming(args: { contactId: string; nowIso: string }): Promise<AppointmentSnapshot[]>
```

En `src/verticals/agenda/agent/internal-backend.ts`:

```ts
    async listUpcoming({ contactId, nowIso }) {
      const { data, error } = await db
        .from('booking_appointments')
        .select('id, starts_at, patient_id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .in('status', ['pending', 'confirmed'])
        .gt('starts_at', nowIso)
        .order('starts_at')
      if (error) throw new Error(`No se pudieron leer las citas: ${error.message}`)
      const rows = (data ?? []) as { id: string; starts_at: string; patient_id: string | null }[]
      const patients = await listPatients(db, { accountId, contactId })
      const names = new Map(patients.map((p) => [p.id, p.fullName]))
      return rows.map((row) => ({
        id: row.id,
        startsAt: new Date(row.starts_at),
        patientName: row.patient_id ? (names.get(row.patient_id) ?? null) : null,
      }))
    },
```

- [ ] **Step 4: Agrega los pasos**

En `src/verticals/agenda/agent/steps/clinic-steps.ts`:

1. Amplía los imports:

```ts
import { formatDayLabel, formatTimeLabel } from '../format'
import { zonedDateKey, zonedParts } from '../time'
```

Y agrega `apptId` al import de `../state`.

2. Después de `urgencyBooking`:

```ts
async function myAppointments(ctx: ClinicStepCtx): Promise<ClinicOutcome> {
  const upcoming = await ctx.backend.listUpcoming({
    contactId: ctx.contactId,
    nowIso: ctx.nowIso,
  })
  if (!upcoming.length) {
    await ctx.sender.sendText({ text: ctx.texts.noUpcoming })
    return { kind: 'next', state: newBookingState('clinic_menu') }
  }
  if (upcoming.length === 1) {
    return {
      kind: 'next',
      state: newBookingState('manage_menu', { appointmentId: upcoming[0].id }),
    }
  }
  return { kind: 'next', state: newBookingState('pick_appointment') }
}
```

3. En `renderClinicStep`, antes de `default`:

```ts
    case 'pick_appointment': {
      const upcoming = await ctx.backend.listUpcoming({
        contactId: ctx.contactId,
        nowIso: ctx.nowIso,
      })
      if (!upcoming.length) {
        await ctx.sender.sendText({ text: texts.noUpcoming })
        return { state, closed: true }
      }
      // Con 3 citas o menos van botones, que no llevan descripción: el nombre
      // del paciente tiene que caber en el título y estar en el cuerpo.
      const rows = upcoming.slice(0, 10).map((appt) => {
        const parts = zonedParts(appt.startsAt)
        const when = `${formatDayLabel(parts.dateKey)}, ${formatTimeLabel(parts)}`
        const firstName = appt.patientName?.split(' ')[0]
        return {
          id: apptId(appt.id),
          title: firstName ? `${formatTimeLabel(parts)} ${firstName}` : when,
          description: when,
          line: appt.patientName ? `• ${appt.patientName}: ${when}` : `• ${when}`,
        }
      })
      await ctx.sendOptions({
        bodyText: `${texts.pickAppointmentBody}\n\n${rows.map((r) => r.line).join('\n')}`,
        buttonLabel: texts.pickAppointmentButton,
        options: rows.map(({ id, title, description }) => ({ id, title, description })),
      })
      const options: OfferedOption[] = rows.map(({ id, title }) => ({ id, title }))
      return { state: { ...state, options }, closed: false }
    }
```

4. En `clinic_menu` de `handleClinicChoice`:

```ts
        case 'mine':
          return myAppointments(ctx)
```

5. Antes de `default` de `handleClinicChoice`:

```ts
    case 'pick_appointment': {
      if (parsed?.kind !== 'appt') return { kind: 'fail' }
      if (state.reminderAction) {
        return { kind: 'reminder', action: state.reminderAction, appointmentId: parsed.value }
      }
      return {
        kind: 'next',
        state: newBookingState('manage_menu', { appointmentId: parsed.value }),
      }
    }
```

- [ ] **Step 5: Rehaz el toque del recordatorio**

En `src/verticals/agenda/agent/controller.ts`:

1. Agrega los imports:

```ts
import { loadServicePrep } from '@/modules/clinica/settings'
```

(únelo con el import existente de `settings`) y, en `./state`, nada nuevo.

2. Después de `SESSION_TTL_MS`:

```ts
/** Citas de un mismo número a menos de esto se consideran ambiguas. */
const TAP_AMBIGUITY_MS = 72 * 60 * 60 * 1000
```

3. Reemplaza `isCancelConfirmTap` por:

```ts
/**
 * ¿Es la respuesta a una pregunta que abrió un recordatorio? Se atiende
 * aunque un humano sea dueño del hilo: el "Sí, cancelar" / "No" de una
 * cancelación, o elegir la cita cuando el toque era ambiguo.
 */
function isSystemTap(session: VerticalSession | null, replyId: string | null): boolean {
  if (!session || !replyId) return false
  if (session.state.step === 'pick_appointment') return replyId.startsWith('appt:')
  if (session.state.step !== 'manage_cancel_confirm') return false
  return replyId === actId('cancel_yes') || replyId === actId('back')
}
```

Y cambia sus dos usos en `handleAgendaInbound`: `!isCancelConfirmTap(...)` pasa a `!isSystemTap(...)`.

4. Reemplaza `handleReminderTap` completo por:

```ts
/**
 * La cita del toque: la que viene en el botón, o la próxima activa. En una
 * clínica, con dos citas cercanas en el mismo número se pregunta cuál y se
 * devuelve 'asked'.
 */
async function resolveTapAppointment(
  dialog: Dialog,
  session: VerticalSession | null,
  tap: ReminderTap,
): Promise<AppointmentInfo | 'asked' | null> {
  const active = async (id: string) => {
    const appt = await loadAppointment(dialog.db, dialog.accountId, dialog.contactId, id)
    if (!appt) return null
    if (appt.status !== 'pending' && appt.status !== 'confirmed') return null
    return appt.startsAt > dialog.now ? appt : null
  }

  if (tap.appointmentId) return active(tap.appointmentId)
  if (!dialog.clinic) {
    return findNextAppointment(dialog.db, dialog.accountId, dialog.contactId, dialog.nowIso)
  }

  const upcoming = await dialog.backend.listUpcoming({
    contactId: dialog.contactId,
    nowIso: dialog.nowIso,
  })
  const limit = dialog.now.getTime() + TAP_AMBIGUITY_MS
  const near = upcoming.filter((a) => a.startsAt.getTime() <= limit)
  if (near.length > 1) {
    const state = newBookingState('pick_appointment', { reminderAction: tap.action })
    const sessionId = session?.id ?? (await openSession(dialog, state))
    await conclude(dialog, sessionId, state)
    return 'asked'
  }
  return upcoming[0] ? active(upcoming[0].id) : null
}

async function handleReminderTap(
  dialog: Dialog,
  session: VerticalSession | null,
  tap: ReminderTap,
  humanOwned = false,
): Promise<void> {
  const appt = await resolveTapAppointment(dialog, session, tap)
  if (appt === 'asked') return
  if (!appt) {
    await dialog.sender.sendText({
      text: dialog.texts.managedAppointmentGone,
    })
    return
  }
  await applyReminderAction(dialog, session?.id ?? null, tap.action, appt, humanOwned)
}

async function applyReminderAction(
  dialog: Dialog,
  sessionId: string | null,
  action: ReminderAction,
  appt: AppointmentInfo,
  humanOwned: boolean,
): Promise<void> {
  if (action === 'confirm') {
    try {
      await dialog.backend.confirm({ id: appt.id, confirmedAtIso: dialog.nowIso })
    } catch (err) {
      console.error('[agenda] confirmar desde el recordatorio falló:', err)
      await dialog.sender.sendText({ text: dialog.texts.confirmError })
      return
    }
    await bestEffort('evento confirmed (recordatorio)', () =>
      insertBookingEvent(dialog.db, {
        accountId: dialog.accountId,
        appointmentId: appt.id,
        event: 'confirmed',
        payload: { via: 'recordatorio' },
      }),
    )

    const service = appt.serviceId
      ? await findService(dialog, appt.serviceId)
      : null
    const staffName = appt.staffId
      ? await loadStaffName(dialog.db, dialog.accountId, appt.staffId)
      : null
    const parts = zonedParts(appt.startsAt)
    await dialog.sender.sendText({
      text: dialog.texts.reminderConfirmed({
        service: service?.name ?? dialog.texts.serviceFallback,
        staff: staffName ?? dialog.texts.staffAnyTitle,
        date: formatLongDate(parts.dateKey),
        time: formatTimeLabel(parts),
      }),
    })
    if (dialog.clinic) await bestEffort('instrucciones previas', () => sendPrepInfo(dialog, appt))
    return
  }

  // Pieza "reprogramar/cancelar" apagada: nada de flujo; lo atiende una
  // persona. Un solo mensaje al cliente (`changesByHuman`).
  if (!dialog.settings.toggles.allowReschedule) {
    await handoffChangeRequest(dialog, appt, action, {
      via: 'recordatorio',
      sessionId,
    })
    return
  }

  // Reprogramar con un humano a cargo: el bot NO abre su flujo encima
  // del agente. Avisa al agente (o al dueño), deja rastro y le dice al
  // cliente que una persona sigue.
  if (action === 'reschedule' && humanOwned) {
    await handoffRescheduleRequest(dialog, appt)
    return
  }

  const state =
    action === 'reschedule'
      ? newBookingState('pick_day', {
          mode: 'reschedule',
          appointmentId: appt.id,
          serviceId: appt.serviceId ?? undefined,
          staffId: rescheduleStaffId(dialog, appt),
        })
      : newBookingState('manage_cancel_confirm', { appointmentId: appt.id })

  await conclude(dialog, sessionId ?? (await openSession(dialog, state)), state)
}

/** Tras confirmar: instrucciones previas del servicio, dirección y mapa. */
async function sendPrepInfo(dialog: Dialog, appt: AppointmentInfo): Promise<void> {
  const location = dialog.clinic?.location ?? null
  const prep = appt.serviceId
    ? await loadServicePrep(dialog.db, dialog.accountId, appt.serviceId)
    : null
  const mapUrl =
    location?.latitude != null && location.longitude != null
      ? `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`
      : null
  const text = dialog.clinicTexts?.prepInfo({ prep, address: location?.address ?? null, mapUrl })
  if (text) await dialog.sender.sendText({ text })
}
```

5. Reemplaza el caso `reminder` de `applyClinicOutcome`:

```ts
    case 'reminder': {
      const appt = await loadAppointment(
        dialog.db,
        dialog.accountId,
        dialog.contactId,
        outcome.appointmentId,
      )
      if (!appt || (appt.status !== 'pending' && appt.status !== 'confirmed')) {
        await dialog.sender.sendText({ text: dialog.texts.managedAppointmentGone })
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
        return
      }
      if (outcome.action === 'confirm') {
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
      }
      await applyReminderAction(
        dialog,
        outcome.action === 'confirm' ? null : sessionId,
        outcome.action,
        appt,
        dialog.humanOwned,
      )
      return
    }
```

- [ ] **Step 6: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS, con los toques de recordatorio de `controller.test.ts` intactos.

- [ ] **Step 7: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(clinica): resolve appointments per patient and send prep info"
```

---

### Task 12: Recordatorio clínico, sin procedimiento

**Files:**
- Create: `src/modules/clinica/reminder-info.ts`, `src/lib/whatsapp/template-quick-reply.test.ts`
- Modify: `src/lib/whatsapp/meta-api.ts`, `src/verticals/agenda/agent/reminders.ts`, `src/verticals/agenda/agent/reminders.test.ts`, `src/verticals/agenda/agent/reminders-send.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/lib/whatsapp/template-quick-reply.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendTemplateMessage } from './meta-api'

afterEach(() => vi.unstubAllGlobals())

describe('sendTemplateMessage con payloads de quick reply', () => {
  it('agrega un componente de botón por cada payload, en orden', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid-1' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await sendTemplateMessage({
      phoneNumberId: '1',
      accessToken: 't',
      to: '573001112233',
      templateName: 'recordatorio_cita_clinica',
      language: 'es',
      params: ['Clínica'],
      quickReplyPayloads: ['rem:confirm:ap-1', 'rem:cancel:ap-1'],
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(init.body).template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Clínica' }] },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'rem:confirm:ap-1' }],
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: 'rem:cancel:ap-1' }],
      },
    ])
  })
})
```

En `src/verticals/agenda/agent/reminders.test.ts`, agrega `CLINIC_REMINDER_TEMPLATE` al import de `./reminders`, y dentro de `describe('builders del recordatorio', ...)`:

```ts
  describe('clínica', () => {
    const clinicDelivery = delivery({
      serviceName: 'Endodoncia',
      staffName: 'Dra. Ana',
      clinic: { patientName: 'Tomás Gil', locationName: 'Centro' },
    })

    it('el mensaje nombra al paciente y la sede, pero no el procedimiento', () => {
      const body = buildReminderBody(clinicDelivery)
      expect(body).toContain('Tomás Gil')
      expect(body).toContain('Centro')
      expect(body).not.toContain('Endodoncia')
    })

    it('la plantilla lleva seis variables y ninguna es el procedimiento', () => {
      const params = buildReminderTemplateParams(clinicDelivery)
      expect(params).toHaveLength(6)
      expect(params.slice(0, 4)).toEqual([
        'Tomás Gil',
        clinicDelivery.businessName,
        'Centro',
        'Dra. Ana',
      ])
      expect(params).not.toContain('Endodoncia')
    })

    it('los botones llevan el id de la cita', () => {
      expect(reminderButtons(true, 'ap-1').map((b) => b.id)).toEqual([
        'rem:confirm:ap-1',
        'rem:reschedule:ap-1',
        'rem:cancel:ap-1',
      ])
    })

    it('la plantilla clínica tiene otro nombre', () => {
      expect(CLINIC_REMINDER_TEMPLATE).toEqual({ name: 'recordatorio_cita_clinica', language: 'es' })
    })
  })
```

Agrega dentro de `describe('runAgendaReminders', ...)`:

```ts
  it('en una cuenta con clínica la entrega lleva paciente y sede', async () => {
    const seed = baseSeed()
    seed.accounts[0].modules = ['agenda', 'clinica']
    seed.booking_appointments[0].patient_id = 'pat-1'
    seed.booking_appointments[0].location_id = 'loc-1'
    seed.clinic_patients = [{ id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Tomás Gil' }]
    seed.clinic_locations = [{ id: 'loc-1', account_id: ACCOUNT, name: 'Centro', is_active: true }]
    const db = makeFakeDb(seed)
    const deliveries: ReminderDelivery[] = []

    await runAgendaReminders({
      db: db as unknown as SupabaseClient,
      now: NOW,
      send: async (d) => {
        deliveries.push(d)
      },
    })

    expect(deliveries[0].appointmentId).toBe(APPT)
    expect(deliveries[0].clinic).toEqual({ patientName: 'Tomás Gil', locationName: 'Centro' })
  })

  it('una cuenta sin clínica no lleva esos datos', async () => {
    const db = makeFakeDb(baseSeed())
    const deliveries: ReminderDelivery[] = []
    await runAgendaReminders({
      db: db as unknown as SupabaseClient,
      now: NOW,
      send: async (d) => {
        deliveries.push(d)
      },
    })
    expect(deliveries[0].clinic).toBeUndefined()
  })
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/lib/whatsapp/template-quick-reply.test.ts src/verticals/agenda/agent/reminders.test.ts`
Expected: FAIL, no hay componentes de botón y `CLINIC_REMINDER_TEMPLATE` no existe.

- [ ] **Step 3: Soporta los payloads**

En `src/lib/whatsapp/meta-api.ts`, en `SendTemplateMessageArgs`, antes de `contextMessageId`:

```ts
  /**
   * Payload de cada quick reply, en el orden de los botones de la
   * plantilla. Meta lo devuelve en `button.payload` al tocar. Solo aplica
   * a la ruta legacy (`params`).
   */
  quickReplyPayloads?: string[]
```

Agrégalo a la desestructuración de `sendTemplateMessage`, y reemplaza la rama `else if (params && params.length > 0)` por:

```ts
  } else if ((params && params.length > 0) || quickReplyPayloads?.length) {
    // Legacy body-only path — no template row available.
    const components: Record<string, unknown>[] = []
    if (params && params.length > 0) {
      components.push({
        type: 'body',
        parameters: params.map((p) => ({ type: 'text', text: String(p) })),
      })
    }
    for (const [index, payload] of (quickReplyPayloads ?? []).entries()) {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload }],
      })
    }
    templatePayload.components = components
  }
```

- [ ] **Step 4: Lee paciente y sede**

Crea `src/modules/clinica/reminder-info.ts`:

```ts
// ============================================================
// Datos del recordatorio de una clínica: a nombre de quién va la cita y
// en qué sede. El procedimiento NO viaja: el teléfono puede ser
// compartido y el texto pasa por Meta.
//
// Va en una consulta aparte para que los demás negocios no lean columnas
// de la migración 055.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ClinicReminderInfo {
  patientName: string
  locationName: string
}

const FALLBACK_PATIENT = 'tu familiar'
const FALLBACK_LOCATION = 'principal'

export async function loadClinicReminderInfo(
  db: SupabaseClient,
  args: { accountId: string; appointmentId: string; contactId: string },
): Promise<ClinicReminderInfo> {
  const { data: appt } = await db
    .from('booking_appointments')
    .select('patient_id, location_id')
    .eq('id', args.appointmentId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  const row = (appt as { patient_id?: string | null; location_id?: string | null } | null) ?? null

  let patientName: string | null = null
  if (row?.patient_id) {
    const { data } = await db
      .from('clinic_patients')
      .select('full_name')
      .eq('id', row.patient_id)
      .eq('account_id', args.accountId)
      .maybeSingle()
    patientName = (data as { full_name?: string } | null)?.full_name ?? null
  }
  if (!patientName) {
    const { data } = await db
      .from('contacts')
      .select('name')
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .maybeSingle()
    patientName = (data as { name?: string | null } | null)?.name?.trim() || null
  }

  let locationName: string | null = null
  if (row?.location_id) {
    const { data } = await db
      .from('clinic_locations')
      .select('name')
      .eq('id', row.location_id)
      .eq('account_id', args.accountId)
      .maybeSingle()
    locationName = (data as { name?: string } | null)?.name ?? null
  }

  return {
    patientName: patientName ?? FALLBACK_PATIENT,
    locationName: locationName ?? FALLBACK_LOCATION,
  }
}
```

- [ ] **Step 5: Ajusta el runner y los builders**

En `src/verticals/agenda/agent/reminders.ts`:

1. Agrega los imports:

```ts
import { loadClinicReminderInfo, type ClinicReminderInfo } from '@/modules/clinica/reminder-info'
import { buildClinicTexts } from '@/modules/clinica/texts'
```

2. Después de `AGENDA_REMINDER_TEMPLATE`:

```ts
/**
 * Plantilla de las clínicas: nombra al paciente y la sede, nunca el
 * procedimiento (docs/clinica-montaje.md).
 */
export const CLINIC_REMINDER_TEMPLATE = {
  name: 'recordatorio_cita_clinica',
  language: 'es',
} as const
```

3. En `ReminderDelivery`, al final:

```ts
  /** Solo cuentas con el módulo clínica. */
  clinic?: ClinicReminderInfo
```

4. Reemplaza `reminderButtons`:

```ts
/**
 * Botones Confirmar / Reprogramar / Cancelar (ids rem:*). Con la pieza de
 * reprogramar apagada solo queda Confirmar. `appointmentId` amarra el
 * botón a una cita cuando el número puede tener varias.
 */
export function reminderButtons(
  allowReschedule = true,
  appointmentId?: string,
): { id: string; title: string }[] {
  const actions: { action: ReminderAction; title: string }[] = [
    { action: 'confirm', title: AGENDA_AGENT_TEXTS.reminderConfirm },
    ...(allowReschedule
      ? [
          { action: 'reschedule' as const, title: AGENDA_AGENT_TEXTS.reminderReschedule },
          { action: 'cancel' as const, title: AGENDA_AGENT_TEXTS.reminderCancel },
        ]
      : []),
  ]
  return actions.map(({ action, title }) => ({ id: remId(action, appointmentId), title }))
}
```

5. Al inicio de `buildReminderBody`:

```ts
  if (d.clinic) {
    const texts = buildClinicTexts(d.labels)
    return texts.reminderBody({
      patient: d.clinic.patientName,
      business: d.businessName,
      location: d.clinic.locationName,
      staff: d.staffName ?? texts.reminderStaffFallback,
      date: d.dateLabel,
      time: d.timeLabel,
    })
  }
```

6. Al inicio de `buildReminderTemplateParams`:

```ts
  if (d.clinic) {
    return [
      d.clinic.patientName,
      d.businessName,
      d.clinic.locationName,
      d.staffName ?? buildClinicTexts(d.labels).reminderStaffFallback,
      d.dateLabel,
      d.timeLabel,
    ]
  }
```

7. En `AccountRow`, agrega los campos que ya llegan de la base:

```ts
interface AccountRow extends AccountModulesSource {
  id: string
  name: string
  owner_user_id: string
}
```

8. En `runAgendaReminders`, antes de `for (const appt of due)`:

```ts
  const clinicAccounts = new Set(
    accounts.filter((a) => hasModule(a, 'clinica')).map((a) => a.id),
  )
```

9. Antes de `const delivery: ReminderDelivery = {`:

```ts
    const clinic = clinicAccounts.has(appt.account_id)
      ? await loadClinicReminderInfo(args.db, {
          accountId: appt.account_id,
          appointmentId: appt.id,
          contactId: appt.contact_id,
        })
      : undefined
```

10. Al final del objeto `delivery`:

```ts
      ...(clinic ? { clinic } : {}),
```

En `src/verticals/agenda/agent/reminders-send.ts`:

1. Agrega `CLINIC_REMINDER_TEMPLATE` al import de `./reminders`, y:

```ts
import { REMINDER_ACTIONS, remId } from './state'
```

2. En el envío de texto:

```ts
        buttons: reminderButtons(
          delivery.allowReschedule,
          delivery.clinic ? delivery.appointmentId : undefined,
        ),
```

3. En `sendReminderTemplate`, antes de `const sendTo`:

```ts
  const template = delivery.clinic ? CLINIC_REMINDER_TEMPLATE : AGENDA_REMINDER_TEMPLATE
  const quickReplyPayloads = delivery.clinic
    ? REMINDER_ACTIONS.map((action) => remId(action, delivery.appointmentId))
    : undefined
```

4. En `sendTo`:

```ts
      templateName: template.name,
      language: template.language,
      params,
      quickReplyPayloads,
```

5. En el `insert` de `messages`:

```ts
    template_name: template.name,
```

- [ ] **Step 6: Corre las pruebas**

Run: `npx vitest run src/lib/whatsapp src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp src/modules/clinica src/verticals/agenda/agent
git commit -m "feat(clinica): send reminders without the procedure name"
```

---

### Task 13: Candado por conversación

**Files:**
- Create: `src/verticals/agenda/agent/bot-lock.ts`, `src/verticals/agenda/agent/bot-lock.test.ts`
- Modify: `src/verticals/agenda/agent/db.ts`, `src/verticals/agenda/agent/index.ts`

- [ ] **Step 1: Escribe la prueba que falla**

Crea `src/verticals/agenda/agent/bot-lock.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { acquireBotLock, withBotLock } from './bot-lock'
import { asClient, makeFakeDb } from './testing/fake-db'

const ACCOUNT = 'acc-1'
const CONVERSATION = 'cv-1'
const NOW = new Date('2026-10-19T13:00:00.000Z')

const seed = (lockedUntil: string | null = null) =>
  makeFakeDb({
    conversations: [{ id: CONVERSATION, account_id: ACCOUNT, bot_lock_until: lockedUntil }],
  })

const args = { accountId: ACCOUNT, conversationId: CONVERSATION }

describe('candado por conversación', () => {
  it('solo gana uno', async () => {
    const db = asClient(seed())
    await expect(acquireBotLock(db, { ...args, now: NOW })).resolves.toBe(true)
    await expect(acquireBotLock(db, { ...args, now: NOW })).resolves.toBe(false)
  })

  it('un candado vencido se puede tomar', async () => {
    const db = asClient(seed('2026-10-19T12:59:00.000Z'))
    await expect(acquireBotLock(db, { ...args, now: NOW })).resolves.toBe(true)
  })

  it('suelta el candado aunque el trabajo falle', async () => {
    const fake = seed()
    await expect(
      withBotLock(asClient(fake), args, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(fake._tables.conversations[0].bot_lock_until).toBeNull()
  })

  it('si no consigue el candado no ejecuta el trabajo y consume el mensaje', async () => {
    const fake = seed('2099-01-01T00:00:00.000Z')
    const work = vi.fn(async () => ({ consumed: false }))
    const result = await withBotLock(asClient(fake), args, work, { waitMs: 0 })
    expect(result).toEqual({ consumed: true })
    expect(work).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Córrela y verifica que falla**

Run: `npx vitest run src/verticals/agenda/agent/bot-lock.test.ts`
Expected: FAIL, no existe `./bot-lock`.

- [ ] **Step 3: Implementa**

Crea `src/verticals/agenda/agent/bot-lock.ts`:

```ts
// ============================================================
// Candado por conversación (docs/agenda-notas.md §3).
//
// Si un cliente manda dos mensajes seguidos, el webhook los procesa en
// paralelo y el segundo puede leer el paso antes de que el primero lo
// guarde. El candado es un UPDATE condicional sobre `conversations`: la
// fila siempre existe, también en el primer mensaje. Vence solo, por si
// un proceso muere con el candado puesto.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { VerticalDispatchResult } from '@/lib/verticals/types'

const LOCK_TTL_MS = 30_000
const DEFAULT_WAIT_MS = 5_000
const POLL_MS = 250

interface LockArgs {
  accountId: string
  conversationId: string
}

export async function acquireBotLock(
  db: SupabaseClient,
  args: LockArgs & { now: Date },
): Promise<boolean> {
  const nowIso = args.now.toISOString()
  const untilIso = new Date(args.now.getTime() + LOCK_TTL_MS).toISOString()
  const claim = () =>
    db
      .from('conversations')
      .update({ bot_lock_until: untilIso })
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)

  const free = await claim().is('bot_lock_until', null).select('id')
  if (((free.data ?? []) as unknown[]).length > 0) return true

  const expired = await claim().lt('bot_lock_until', nowIso).select('id')
  return ((expired.data ?? []) as unknown[]).length > 0
}

async function releaseBotLock(db: SupabaseClient, args: LockArgs): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({ bot_lock_until: null })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
  if (error) console.error('[agenda] no se pudo soltar el candado:', error.message)
}

/**
 * Corre `work` con el candado. Espera hasta `waitMs` a que se libere; si
 * sigue ocupado, registra y consume el mensaje sin responder.
 */
export async function withBotLock(
  db: SupabaseClient,
  args: LockArgs,
  work: () => Promise<VerticalDispatchResult>,
  opts: { waitMs?: number } = {},
): Promise<VerticalDispatchResult> {
  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS)
  let locked = await acquireBotLock(db, { ...args, now: new Date() })
  while (!locked && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    locked = await acquireBotLock(db, { ...args, now: new Date() })
  }
  if (!locked) {
    console.warn(`[agenda] mensaje sin candado en la conversación ${args.conversationId}`)
    return { consumed: true }
  }
  try {
    return await work()
  } finally {
    await releaseBotLock(db, args)
  }
}
```

En `src/verticals/agenda/agent/db.ts`, después de `closeSession`:

```ts
/**
 * Sesión activa y vigente del contacto. Tras esperar el candado hay que
 * volver a leerla: la que trajo el dispatcher pudo quedar vieja.
 */
export async function loadActiveSession(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; nowIso: string },
): Promise<VerticalSession | null> {
  const { data } = await db
    .from('booking_sessions')
    .select('id, state, expires_at')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('status', 'active')
    .gt('expires_at', args.nowIso)
    .maybeSingle()
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    state: (row.state ?? {}) as Record<string, unknown>,
    expiresAt: row.expires_at as string,
  }
}
```

Y el import de tipos arriba:

```ts
import type { VerticalSession } from '@/lib/verticals/types'
```

En `src/verticals/agenda/agent/index.ts`:

```ts
import { withBotLock } from './bot-lock'
import { loadActiveSession } from './db'
```

Reemplaza `agendaInboundHandler`. El candado va **dentro** del `try`: tomarlo, esperarlo o soltarlo también puede lanzar, y si eso queda fuera de `failClosed` (tarea 7) el mensaje de un paciente llega a la IA.

```ts
export const agendaInboundHandler: VerticalInboundHandler = async (ctx) => {
  const run = (session: VerticalInboundContext['session']) =>
    handleAgendaInbound({
      db: ctx.db,
      sender: createAgendaSender(ctx),
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      inboundMessageId: ctx.inboundMessageId,
      session,
      humanOwned: ctx.humanOwned ?? false,
      modules: ctx.modules,
    })

  try {
    if (!ctx.modules?.includes('clinica')) return await run(ctx.session)
    // Clínicas: el candado evita respuestas cruzadas. La sesión se vuelve a
    // leer adentro, porque la del dispatcher pudo cambiar mientras esperaba.
    return await withBotLock(
      ctx.db,
      { accountId: ctx.accountId, conversationId: ctx.conversationId },
      async () =>
        run(
          await loadActiveSession(ctx.db, {
            accountId: ctx.accountId,
            contactId: ctx.contactId,
            nowIso: new Date().toISOString(),
          }),
        ),
    )
  } catch (err) {
    return failClosed(ctx, err)
  }
}
```

- [ ] **Step 4: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda src/lib/verticals && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(clinica): lock the bot per conversation"
```

---

### Task 14: Permiso para avisos de control

**Files:**
- Create: `src/verticals/agenda/agent/clinic-marketing.test.ts`
- Modify: `src/verticals/agenda/agent/steps/clinic-steps.ts`, `src/verticals/agenda/agent/controller.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/verticals/agenda/agent/clinic-marketing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT,
  CONTACT,
  SERVICE_LIMPIEZA,
  clinicDb,
  grantedConsent,
  last,
  makeRecorder,
  send,
} from './testing/clinic-harness'
import { patId, svcId } from './state'

const patient = () => [
  { id: 'pat-1', account_id: ACCOUNT, contact_id: CONTACT, full_name: 'Marta Ruiz' },
]

async function bookOnce(db: ReturnType<typeof clinicDb>, rec: ReturnType<typeof makeRecorder>) {
  await send(db, rec, { text: 'Hola' })
  await send(db, rec, { replyId: 'act:book' })
  await send(db, rec, { replyId: patId('pat-1') })
  await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) })
  await send(db, rec, { replyId: last(rec).ids[0] })
  await send(db, rec, { replyId: last(rec).ids[0] })
  await send(db, rec, { replyId: 'act:confirm' })
}

describe('permiso para avisos de control', () => {
  it('después de agendar pregunta y guarda la respuesta aparte', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()], clinic_patients: patient() })
    const rec = makeRecorder()
    await bookOnce(db, rec)
    expect(last(rec).ids).toEqual(['act:mkt_yes', 'act:mkt_no'])

    await send(db, rec, { replyId: 'act:mkt_yes' })
    expect(db._tables.clinic_consents.at(-1)).toMatchObject({
      kind: 'mercadeo',
      granted: true,
      contact_ref: '573001112233',
      text_snapshot: '¿Quieres que te avisemos cuando te toque tu próximo control o limpieza?',
    })
    expect(last(rec).bodyText).toContain('te avisaremos')
  })

  it('si ya respondió, no vuelve a preguntar', async () => {
    const db = clinicDb({
      clinic_consents: [
        grantedConsent(),
        { ...grantedConsent(), id: 'cons-2', kind: 'mercadeo', granted: false },
      ],
      clinic_patients: patient(),
    })
    const rec = makeRecorder()
    await bookOnce(db, rec)
    expect(last(rec).bodyText).toContain('Quedó agendado')
  })

  it('una cuenta sin el módulo no pregunta', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const agenda = { modules: ['agenda' as const] }
    await send(db, rec, { text: 'Hola' }, agenda)
    await send(db, rec, { replyId: svcId(SERVICE_LIMPIEZA) }, agenda)
    await send(db, rec, { replyId: last(rec).ids[0] }, agenda)
    await send(db, rec, { replyId: last(rec).ids[0] }, agenda)
    await send(db, rec, { replyId: 'act:confirm' }, agenda)
    expect(last(rec).bodyText).toContain('Quedó agendado')
    expect(db._tables.clinic_consents).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda/agent/clinic-marketing.test.ts`
Expected: FAIL, el último mensaje es la confirmación.

- [ ] **Step 3: Agrega el paso**

En `src/verticals/agenda/agent/steps/clinic-steps.ts`:

En `renderClinicStep`, antes de `default`:

```ts
    case 'marketing_consent': {
      const options: OfferedOption[] = [
        { id: actId('mkt_yes'), title: texts.marketingYes },
        { id: actId('mkt_no'), title: texts.marketingNo },
      ]
      await ctx.sendOptions({
        bodyText: texts.marketingBody,
        buttonLabel: texts.menuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }
```

En `handleClinicChoice`, antes de `default`:

```ts
    case 'marketing_consent': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      if (parsed.value !== 'mkt_yes' && parsed.value !== 'mkt_no') return { kind: 'fail' }
      const granted = parsed.value === 'mkt_yes'
      try {
        await recordConsent(ctx.db, {
          accountId: ctx.accountId,
          contactId: ctx.contactId,
          kind: 'mercadeo',
          granted,
          textVersion: ctx.clinic.consentVersion,
          textSnapshot: texts.marketingBody,
          source: 'whatsapp',
          messageId: ctx.inboundMessageId,
          createdAtIso: ctx.nowIso,
        })
      } catch (err) {
        // No se bloquea nada: sin registro simplemente no se le escribirá.
        console.error('[clinica] no se pudo guardar el permiso de control:', err)
      }
      await ctx.sender.sendText({
        text: granted ? texts.marketingThanksYes : texts.marketingThanksNo,
      })
      return { kind: 'done' }
    }
```

En `src/verticals/agenda/agent/controller.ts`, al final de `confirmAppointment`, después de enviar la confirmación:

```ts
  if (!oldAppt && dialog.clinic) {
    await bestEffort('pregunta de avisos de control', () => askMarketingConsent(dialog))
  }
```

Y después de `sendPrepInfo`:

```ts
/** Permiso aparte para escribirle cuando le toque control (Fase 5). */
async function askMarketingConsent(dialog: Dialog): Promise<void> {
  const answered = await latestConsent(dialog.db, {
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    kind: 'mercadeo',
  })
  if (answered) return
  const state = newBookingState('marketing_consent')
  await conclude(dialog, await openSession(dialog, state), state)
}
```

- [ ] **Step 4: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(clinica): ask for permission to send check-up notices"
```

---

### Task 15: Guía de montaje y verificación final

**Files:**
- Create: `docs/clinica-montaje.md`
- Modify: `docs/agenda-recordatorios.md`, `src/verticals/agenda/agent/reminders-send.ts`

- [ ] **Step 1: Crea la guía**

Crea `docs/clinica-montaje.md`:

````markdown
# Montaje de una clínica odontológica

Guía para Shift. Aplica a una clínica con la Agenda de Shift. Diseño:
`docs/superpowers/specs/2026-11-02-odontologia-design.md`.

Antes de la primera clínica real, el abogado revisa la autorización de
datos y el director de la clínica aprueba los signos de alarma.

## 1. Activar los módulos

Solo lo hace Shift, en el SQL Editor:

```sql
update public.accounts
set modules = array(select distinct unnest(array_cat(modules, array['agenda', 'clinica'])))
where id = '<uuid-de-la-cuenta>';
```

## 2. Instalar la plantilla

`/agenda` → tipo de negocio **Clínica odontológica**. Crea el catálogo, un
doctor de ejemplo, la configuración de la clínica y una sede.

## 3. Ajustar la configuración

Doctores, horarios y atenciones se editan en `/agenda/configuracion`. Lo
demás va por SQL en esta fase:

```sql
update public.clinic_settings
set consent_text = '<texto revisado por el abogado>',
    consent_version = consent_version + 1,
    urgency_alarm_text = '<texto aprobado por el director>',
    reception_consent_declared_at = now()
where account_id = '<uuid-de-la-cuenta>';

update public.clinic_locations
set name = '<sede>', address = '<dirección>', latitude = 0, longitude = 0,
    on_call_phone = '<teléfono de turno>'
where account_id = '<uuid-de-la-cuenta>';

update public.booking_services
set prep_instructions = '<qué llevar o cómo prepararse>'
where account_id = '<uuid-de-la-cuenta>' and name = '<atención>';
```

Sube `consent_version` cada vez que cambie el texto.

## 4. Crear la plantilla en Meta

WhatsApp Manager → Plantillas → Crear:

| Campo | Valor |
| --- | --- |
| Nombre | `recordatorio_cita_clinica` |
| Categoría | Utilidad |
| Idioma | Español, `es` |

Cuerpo:

```
¡Hola! 👋 Te recordamos la cita de {{1}} en {{2}}, sede {{3}}:

👤 {{4}}
📅 {{5}}
🕐 {{6}}

¿Nos confirmas?
```

Las variables son: paciente, clínica, sede, doctor, fecha y hora. **No
agregues el procedimiento**: el teléfono puede ser compartido.

Botones de respuesta rápida, en este orden: `Confirmar`, `Reprogramar`,
`Cancelar`.

Antes de la primera clínica, envía una plantilla real y toca un botón.
En `messages.interactive_reply_id` debe quedar `rem:confirm:<id>`. Si queda
`Confirmar`, Meta ignoró el payload: el bot lo resuelve igual y pregunta cuál
cita si hay dos.

## 5. Revisar Meta

- Medio de pago en Billing Hub: sin él, Meta deja de entregar los mensajes
  del bot después de 1.000 al mes por número.
- Agente de IA con los documentos de la clínica, para Precios y dudas.

## 6. Probar

Desde un celular externo, sobre una cuenta de prueba:

1. Escribe `Hola`: pide autorización. Acepta: abre el menú.
2. Agenda para ti y para otra persona desde el mismo número.
3. Escribe `tengo dolor`: muestra los signos de alarma.
4. Prueba `Ver más días`.
5. Dispara el recordatorio: no nombra el procedimiento.
6. Toca Confirmar: llegan las instrucciones y el mapa.

Los datos de prueba se marcan y se limpian al terminar.
````

- [ ] **Step 2: Corrige la documentación vieja**

En `docs/agenda-recordatorios.md`, reemplaza el párrafo que empieza con "Los botones llevan ids **estáticos**" por:

```markdown
Los botones llevan ids `rem:confirm`, `rem:reschedule` y `rem:cancel`. Una
plantilla enviada sin payload devuelve la etiqueta del botón (`Confirmar`),
y el bot también la entiende. Sin id de cita, resuelve la **próxima cita
activa** del contacto. Las clínicas envían `rem:<acción>:<cita>`: ver
`docs/clinica-montaje.md`.
```

En `src/verticals/agenda/agent/reminders-send.ts`, actualiza el comentario de `sendReminderTemplate`:

```ts
/**
 * Fuera de la ventana de 24 h: plantilla aprobada con sus variables y los
 * quick replies Confirmar / Reprogramar / Cancelar. Las clínicas mandan
 * además el id de la cita en el payload; sin él, Meta devuelve la etiqueta
 * y la cita se resuelve en el controlador.
 */
```

- [ ] **Step 3: Verificación completa**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `npx eslint src/modules/clinica src/verticals/agenda src/lib/verticals src/lib/whatsapp/meta-api.ts`
Expected: 0 errores.

Run: `npx vitest run`
Expected: todas pasan. Deben ser más de 2.859.

- [ ] **Step 4: Commit**

```bash
git add docs src/verticals/agenda/agent/reminders-send.ts
git commit -m "docs(clinica): add the clinic setup guide"
```

- [ ] **Step 5: Lo que queda para el usuario**

No hagas esto sin su OK explícito:

1. Aplicar `055_clinica_base.sql` en el SQL Editor, antes de desplegar.
2. Abrir el PR hacia `main`.
3. Probar en una cuenta de prueba, siguiendo `docs/clinica-montaje.md` §6.
4. Armar la demo con una clínica ficticia en esa cuenta. Siempre se presenta como ficticia, y sus datos se marcan y se limpian al terminar.
