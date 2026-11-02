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
-- Aplicar ANTES de desplegar el código. Es ADITIVA y NO destructiva: solo
-- crea tablas, columnas y políticas. Idempotente: se puede correr de nuevo.
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
  consent_text text NOT NULL CHECK (char_length(consent_text) BETWEEN 1 AND 900),
  consent_version integer NOT NULL DEFAULT 1 CHECK (consent_version >= 1),
  -- La clínica declara que obtiene el permiso en recepción (ver spec §6.6).
  reception_consent_declared_at timestamptz,
  urgency_words text[] NOT NULL DEFAULT '{}',
  urgency_alarm_text text NOT NULL CHECK (char_length(urgency_alarm_text) BETWEEN 1 AND 900),
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
  external_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  address text CHECK (address IS NULL OR char_length(address) <= 200),
  latitude numeric(9,6),
  longitude numeric(9,6),
  notice_phone text CHECK (notice_phone IS NULL OR char_length(notice_phone) <= 30),
  on_call_phone text CHECK (on_call_phone IS NULL OR char_length(on_call_phone) <= 30),
  google_review_url text CHECK (google_review_url IS NULL OR char_length(google_review_url) <= 500),
  chair_count integer CHECK (chair_count IS NULL OR chair_count > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_locations_account
  ON clinic_locations (account_id);

-- ------------------------------------------------------------
-- 3) clinic_patients
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  external_source text,
  external_id text,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  intake_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_patients_contact
  ON clinic_patients (account_id, contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_patients_external
  ON clinic_patients (account_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4) clinic_consents — solo para agregar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('datos_sensibles', 'mercadeo')),
  granted boolean NOT NULL,
  text_version integer NOT NULL CHECK (text_version >= 1),
  source text NOT NULL CHECK (source IN ('whatsapp', 'recepcion')),
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_consents_lookup
  ON clinic_consents (account_id, contact_id, kind, created_at DESC);

-- ------------------------------------------------------------
-- 5) y 6) Columnas de citas y servicios
-- ------------------------------------------------------------
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS patient_id uuid REFERENCES clinic_patients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES clinic_locations(id) ON DELETE SET NULL;

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
-- RLS
-- ------------------------------------------------------------
ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinic_settings_select ON clinic_settings;
CREATE POLICY clinic_settings_select ON clinic_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_settings_insert ON clinic_settings;
CREATE POLICY clinic_settings_insert ON clinic_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_settings_update ON clinic_settings;
CREATE POLICY clinic_settings_update ON clinic_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
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

DROP POLICY IF EXISTS clinic_patients_select ON clinic_patients;
CREATE POLICY clinic_patients_select ON clinic_patients
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_patients_insert ON clinic_patients;
CREATE POLICY clinic_patients_insert ON clinic_patients
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS clinic_patients_update ON clinic_patients;
CREATE POLICY clinic_patients_update ON clinic_patients
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
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
- Create: `src/modules/clinica/texts.ts`, `src/modules/clinica/settings.ts`, `src/modules/clinica/settings.test.ts`
- Modify: `src/verticals/agenda/install.ts`, `src/verticals/agenda/install.test.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

Crea `src/modules/clinica/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { asClient, makeFakeDb } from '@/verticals/agenda/agent/testing/fake-db'

import { ensureClinicSetup, loadClinicContext } from './settings'

const ACCOUNT = 'acc-1'

describe('configuración de la clínica', () => {
  it('sin fila de configuración devuelve null', async () => {
    const db = makeFakeDb({ clinic_settings: [], clinic_locations: [] })
    await expect(loadClinicContext(asClient(db), ACCOUNT)).resolves.toBeNull()
  })

  it('lee la configuración y la primera sede activa de la cuenta', async () => {
    const db = makeFakeDb({
      clinic_settings: [
        {
          account_id: ACCOUNT,
          consent_text: 'Autorizo',
          consent_version: 3,
          urgency_words: ['dolor'],
          urgency_alarm_text: 'Signos',
          urgency_service_id: 'svc-u',
          offer_days: 45,
        },
      ],
      clinic_locations: [
        { id: 'otra', account_id: 'acc-2', name: 'Ajena', is_active: true },
        { id: 'inactiva', account_id: ACCOUNT, name: 'Vieja', is_active: false },
        { id: 'loc-1', account_id: ACCOUNT, name: 'Centro', address: 'Calle 1', is_active: true },
      ],
    })
    const clinic = await loadClinicContext(asClient(db), ACCOUNT)
    expect(clinic).toMatchObject({
      consentText: 'Autorizo',
      consentVersion: 3,
      urgencyWords: ['dolor'],
      urgencyServiceId: 'svc-u',
      offerDays: 45,
      location: { id: 'loc-1', name: 'Centro', address: 'Calle 1' },
    })
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

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/modules/clinica/settings.test.ts src/verticals/agenda/install.test.ts`
Expected: FAIL, no existe `./settings`.

- [ ] **Step 3: Crea los textos**

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
  'Algunos pueden ser datos de salud, que son sensibles. No estás obligado a autorizarlos y te atendemos igual si no aceptas.',
  'Los usamos solo para gestionar tus citas y recordatorios.',
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
  'sangrado',
  'sangra',
  'sangrando',
  'hinchazon',
  'hinchado',
  'hinchada',
  'absceso',
  'pus',
  'fiebre',
  'golpe',
  'fractura',
  'se partio',
  'se me cayo',
]

/** Nota: una lista admite títulos de hasta 24 caracteres y un botón, 20. */
export function buildClinicTexts(l: AgendaLabels) {
  return {
    consentAccept: 'Sí, acepto',
    consentDecline: 'No acepto',
    consentDeclined:
      'Entendido, no guardaremos tus datos de salud. Una persona de la clínica te atiende por este chat. 🙌',
    consentDeclinedNote: 'El paciente no aceptó la autorización de datos (bot en pausa).',
    consentError: 'No pude guardar tu respuesta en este momento 😅. Intenta de nuevo, por favor.',

    menuBody: '¡Hola! 👋 Soy el asistente de la clínica. ¿En qué te ayudo?',
    menuButton: 'Ver opciones',
    menuBook: `Agendar ${l.cita}`,
    menuMine: `Mis ${l.citas}`,
    menuFaq: 'Precios y dudas',
    menuUrgent: 'Tengo una urgencia',
    menuHuman: 'Hablar con una persona',
    faqPrompt: 'Cuéntame tu duda y te respondo. 🙌',

    noUpcoming: `No tienes ${l.citas} próximas. ¿Quieres agendar?`,
    pickAppointmentBody: `¿Sobre cuál ${l.cita}?`,
    pickAppointmentButton: `Ver ${l.citas}`,

    patientMenuBody: `¿Para quién es la ${l.cita}?`,
    patientMenuButton: 'Ver personas',
    patientOther: 'Otra persona',
    patientNamePrompt: `Escríbeme el nombre y los apellidos de quien va a la ${l.cita}.`,
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
    urgencyNote: 'El paciente reportó signos de alarma (bot en pausa).',
    urgencyOffHoursNote: 'Urgencia sin cupo en la agenda de hoy (bot en pausa).',
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
      `¡Hola! 👋 Te recordamos la ${l.cita} de ${a.patient} en ${a.business}, sede ${a.location}:\n\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Nos confirmas?`,
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

- [ ] **Step 4: Crea la configuración**

Crea `src/modules/clinica/settings.ts`:

```ts
// ============================================================
// Configuración de la clínica (clinic_settings + clinic_locations).
//
// Los llamadores le pasan el cliente: el bot usa el service role y el
// instalador también. Sin fila de configuración, el bot sigue como una
// agenda normal y deja el error en el log: un montaje incompleto nunca
// puede tumbar la conversación.
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
): Promise<ClinicContext | null> {
  const { data, error } = await db
    .from('clinic_settings')
    .select(
      'consent_text, consent_version, urgency_words, urgency_alarm_text, urgency_service_id, offer_days',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) console.error('[clinica] no se pudo leer la configuración:', error.message)
  if (!data) {
    console.error(`[clinica] la cuenta ${accountId} tiene el módulo sin configurar`)
    return null
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

  const row = data as Record<string, unknown>
  return {
    consentText: row.consent_text as string,
    consentVersion: Number(row.consent_version),
    urgencyWords: Array.isArray(row.urgency_words) ? (row.urgency_words as string[]) : [],
    urgencyAlarmText: row.urgency_alarm_text as string,
    urgencyServiceId: (row.urgency_service_id as string | null) ?? null,
    offerDays: Number(row.offer_days) || 30,
    location: location ? mapLocation(location) : null,
  }
}

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
    const { error } = await db.from('clinic_settings').insert({
      account_id: accountId,
      consent_text: DEFAULT_CONSENT_TEXT,
      consent_version: 1,
      urgency_words: [...DEFAULT_URGENCY_WORDS],
      urgency_alarm_text: DEFAULT_URGENCY_ALARM_TEXT,
      urgency_service_id: urgency?.id ?? null,
      offer_days: 30,
    })
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

- [ ] **Step 5: Llama al montaje desde el instalador**

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

- [ ] **Step 6: Corre las pruebas**

Run: `npx vitest run src/modules/clinica src/verticals/agenda/install.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/clinica src/verticals/agenda/install.ts src/verticals/agenda/install.test.ts
git commit -m "feat(clinica): add clinic settings and bot copy"
```

---

### Task 6: Estado del bot y toques del recordatorio

Esta tarea también corrige el hallazgo de producción: las etiquetas de la plantilla cuentan como toques.

**Files:**
- Modify: `src/verticals/agenda/agent/state.ts`, `src/verticals/agenda/agent/state.test.ts`, `src/verticals/agenda/agent/controller.ts`

- [ ] **Step 1: Escribe las pruebas que fallan**

En `src/verticals/agenda/agent/state.test.ts`:

1. En el import, cambia `parseReminderId` por `parseReminderTap` y agrega `containsUrgencyWord`, `matchChoice`, `apptId` y `patId` si no están.
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
    expect(parseReminderTap('Confirmar')).toEqual({ action: 'confirm', appointmentId: null })
    expect(parseReminderTap('Reprogramar')).toEqual({ action: 'reschedule', appointmentId: null })
    expect(parseReminderTap('Cancelar')).toEqual({ action: 'cancel', appointmentId: null })
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

describe('autorización escrita', () => {
  const options = [
    { id: 'act:consent_yes', title: 'Sí, acepto' },
    { id: 'act:consent_no', title: 'No acepto' },
  ]
  const choice = (text: string) => matchChoice({ text, options })

  it('un no nunca se lee como aceptación', () => {
    expect(choice('no acepto')).toBe('act:consent_no')
    expect(choice('no, no acepto')).toBe('act:consent_no')
    expect(choice('no autorizo')).toBe('act:consent_no')
    expect(choice('no')).toBe('act:consent_no')
  })

  it('aceptar exige decirlo', () => {
    expect(choice('sí, acepto')).toBe('act:consent_yes')
    expect(choice('acepto')).toBe('act:consent_yes')
    expect(choice('ok')).toBeNull()
  })
})

describe('ids nuevos', () => {
  it('paciente y cita se leen como opciones', () => {
    expect(parseOptionId(patId('new'))).toEqual({ kind: 'pat', value: 'new' })
    expect(parseOptionId(apptId('ap-1'))).toEqual({ kind: 'appt', value: 'ap-1' })
  })
})
```

- [ ] **Step 2: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda/agent/state.test.ts`
Expected: FAIL, `parseReminderTap` no existe.

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

Reemplaza el bloque de comentario y las funciones de ids del recordatorio, desde `// Ids del recordatorio (Fase 3)` hasta el final de `parseReminderId`, por:

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
}

const REMINDER_LABELS: Readonly<Record<string, ReminderAction>> = {
  Confirmar: 'confirm',
  Reprogramar: 'reschedule',
  Cancelar: 'cancel',
}

/** 'rem:confirm', 'rem:confirm:<id>' o la etiqueta 'Confirmar'; lo demás → null. */
export function parseReminderTap(id: string): ReminderTap | null {
  if (Object.hasOwn(REMINDER_LABELS, id)) {
    return { action: REMINDER_LABELS[id], appointmentId: null }
  }
  const [prefix, action, appointmentId] = id.split(':')
  if (prefix !== 'rem') return null
  if (!(REMINDER_ACTIONS as readonly string[]).includes(action)) return null
  return { action: action as ReminderAction, appointmentId: appointmentId || null }
}
```

Cambia los tipos de opción:

```ts
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

En `ACTION_SYNONYMS`, antes de `'staff:any'`. Las de autorización no incluyen un "sí" suelto, a propósito:

```ts
  'act:consent_yes': ['si acepto', 'si autorizo', 'autorizo'],
  'act:consent_no': ['no', 'no autorizo'],
  'act:alarm_yes': ['si', 'tengo'],
  'act:alarm_no': ['no', 'ninguno', 'ninguna'],
  'act:mkt_yes': ['si', 'avisame'],
  'act:mkt_no': ['no'],
```

`'no autorizo'` contiene `'autorizo'`, así que un no tiene que ganar antes de revisar sinónimos. En `matchChoice`, justo después de `const offered = new Set(options.map((o) => o.id))`:

```ts
  // Un no explícito nunca se lee como aceptación.
  if (offered.has('act:consent_no') && /\bno\b/.test(squashed)) return 'act:consent_no'
```

- [ ] **Step 4: Ajusta el controlador**

En `src/verticals/agenda/agent/controller.ts`:

1. Cambia `parseReminderId` por `parseReminderTap` y `type ReminderAction` por `type ReminderAction, type ReminderTap` en el import de `./state`.

2. En `handleAgendaInbound`:

```ts
  const reminderTap = replyId ? parseReminderTap(replyId) : null
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

- [ ] **Step 5: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(agenda): read reminder taps by label and by appointment id"
```

---

### Task 7: Autorización y menú principal

**Files:**
- Create: `src/modules/clinica/consent.ts`, `src/verticals/agenda/agent/steps/clinic-steps.ts`, `src/verticals/agenda/agent/testing/clinic-harness.ts`, `src/verticals/agenda/agent/clinic-consent.test.ts`
- Modify: `src/verticals/agenda/agent/controller.ts`

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
  kind: 'datos_sensibles',
  granted: true,
  text_version: 2,
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

Crea `src/verticals/agenda/agent/clinic-consent.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { ACCOUNT, CONTACT, clinicDb, grantedConsent, last, makeRecorder, send } from './testing/clinic-harness'

describe('autorización de datos', () => {
  it('el primer mensaje pide autorización antes que nada', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    const result = await send(db, rec, { text: 'Hola, quiero una cita' })
    expect(result).toEqual({ consumed: true })
    expect(last(rec).bodyText).toBe('Texto de autorización')
    expect(last(rec).ids).toEqual(['act:consent_yes', 'act:consent_no'])
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
        kind: 'datos_sensibles',
        granted: true,
        text_version: 2,
        source: 'whatsapp',
      },
    ])
    expect(last(rec).ids).toEqual([
      'act:book',
      'act:mine',
      'act:faq',
      'act:urgent',
      'act:human',
    ])
  })

  it('no aceptar registra la negativa y deja el hilo con una persona', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:consent_no' })
    expect(db._tables.clinic_consents[0].granted).toBe(false)
    expect(db._tables.conversations[0].ai_autoreply_disabled).toBe(true)
    expect(last(rec).bodyText).toContain('no guardaremos tus datos')
  })

  it('con autorización, un saludo abre el menú sin volver a pedirla', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    expect(last(rec).ids[0]).toBe('act:book')
  })

  it('con autorización, una pregunta pasa a la IA', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    const result = await send(db, rec, { text: '¿Cuánto vale una cita de valoración?' })
    expect(result).toEqual({ consumed: false })
    expect(rec.calls).toHaveLength(0)
  })

  it('"Precios y dudas" invita a preguntar y suelta la sesión', async () => {
    const db = clinicDb({ clinic_consents: [grantedConsent()] })
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' })
    await send(db, rec, { replyId: 'act:faq' })
    expect(last(rec).bodyText).toContain('Cuéntame tu duda')
    expect(db._tables.booking_sessions.every((s) => s.status !== 'active')).toBe(true)
  })

  it('una cuenta sin el módulo no pide autorización', async () => {
    const db = clinicDb()
    const rec = makeRecorder()
    await send(db, rec, { text: 'Hola' }, { modules: ['agenda'] })
    expect(db._tables.clinic_consents).toHaveLength(0)
    expect(last(rec).ids[0]).toMatch(/^svc:/)
  })
})
```

- [ ] **Step 3: Córrelas y verifica que fallan**

Run: `npx vitest run src/verticals/agenda/agent/clinic-consent.test.ts`
Expected: FAIL, el bot abre el menú de servicios en vez de pedir autorización.

- [ ] **Step 4: Crea el acceso a autorizaciones**

Crea `src/modules/clinica/consent.ts`:

```ts
// ============================================================
// Autorizaciones de datos. Registro de solo agregar: la decisión vigente
// es la más reciente de cada tipo, y nada se edita ni se borra.
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

/** Lanza si no se pudo guardar: sin registro no hay autorización. */
export async function recordConsent(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    kind: ConsentKind
    granted: boolean
    textVersion: number
    source: 'whatsapp' | 'recepcion'
    messageId?: string | null
    createdAtIso: string
  },
): Promise<void> {
  const { error } = await db.from('clinic_consents').insert({
    id: crypto.randomUUID(),
    account_id: args.accountId,
    contact_id: args.contactId,
    kind: args.kind,
    granted: args.granted,
    text_version: args.textVersion,
    source: args.source,
    message_id: args.messageId ?? null,
    created_at: args.createdAtIso,
  })
  if (error) throw new Error(`No se pudo guardar la autorización: ${error.message}`)
}
```

- [ ] **Step 5: Crea los pasos clínicos**

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

/** Lo que parece una duda va a la IA aunque nombre una "cita". */
export function looksLikeQuestion(text: string): boolean {
  if (text.includes('?')) return true
  const first = normalizeText(text).split(' ')[0] ?? ''
  return QUESTION_STARTS.includes(first)
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
      return { state: { ...state, options }, closed: false }
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
      const granted = parsed.value === 'consent_yes'
      try {
        await recordConsent(ctx.db, {
          accountId: ctx.accountId,
          contactId: ctx.contactId,
          kind: 'datos_sensibles',
          granted,
          textVersion: ctx.clinic.consentVersion,
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
          await ctx.sender.sendText({ text: texts.faqPrompt })
          return { kind: 'done' }
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

- [ ] **Step 6: Conecta el controlador**

En `src/verticals/agenda/agent/controller.ts`:

1. Agrega los imports:

```ts
import { latestConsent } from '@/modules/clinica/consent'
import { loadClinicContext, type ClinicContext } from '@/modules/clinica/settings'
import { buildClinicTexts, type ClinicTexts } from '@/modules/clinica/texts'
```

```ts
import {
  handleClinicChoice,
  isClinicStep,
  looksLikeQuestion,
  renderClinicStep,
  type ClinicHandoff,
  type ClinicOutcome,
  type ClinicStepCtx,
} from './steps/clinic-steps'
```

2. En `Dialog` agrega:

```ts
  /** Configuración de la clínica; null en cuentas sin el módulo. */
  clinic: ClinicContext | null
  clinicTexts: ClinicTexts | null
  inboundMessageId: string | null
  humanOwned: boolean
```

3. En `handleAgendaInbound`, reemplaza la lectura y el armado del `dialog`:

```ts
  const clinicActive = args.modules?.includes('clinica') === true
  const [settings, account, clinic] = await Promise.all([
    loadBotSettings(args.db, args.accountId),
    loadAccount(args.db, args.accountId),
    clinicActive ? loadClinicContext(args.db, args.accountId) : Promise.resolve(null),
  ])
  const dialog: Dialog = {
    db: args.db,
    sender: args.sender,
    now,
    nowIso: now.toISOString(),
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    account,
    settings,
    texts: mergeBotTexts(settings.botTexts, settings.labels),
    backend: args.backend ?? createInternalBackend({ db: args.db, accountId: args.accountId }),
    clinic,
    clinicTexts: clinic ? buildClinicTexts(settings.labels) : null,
    inboundMessageId: args.inboundMessageId ?? null,
    humanOwned,
  }
```

4. Reemplaza el bloque desde `// Un tap de un menú viejo no arranca nada` hasta el final de `handleAgendaInbound` por:

```ts
  // Clínica: sin autorización no se sigue, y la IA no ve la conversación.
  if (dialog.clinic) {
    const consent = await latestConsent(args.db, {
      accountId: args.accountId,
      contactId: args.contactId,
      kind: 'datos_sensibles',
    })
    if (!consent?.granted) {
      const state = newBookingState('consent')
      const sessionId = await openSession(dialog, state)
      await conclude(dialog, sessionId, state)
      return { consumed: true }
    }
  }

  // Un tap de un menú viejo no arranca nada (y no se consume).
  if (replyId !== null) return { consumed: false }

  // 4) ¿Quiere agendar? Se abre el diálogo (o la gestión si ya
  //    tiene una cita próxima).
  const { labels } = dialog.settings
  if (!containsIntentWord(text, [labels.cita, labels.citas, labels.servicio, labels.servicios])) {
    return { consumed: false }
  }

  // Clínica: una duda va a la IA; lo demás abre el menú principal.
  if (dialog.clinic) {
    if (looksLikeQuestion(text)) return { consumed: false }
    const state = newBookingState('clinic_menu')
    const sessionId = await openSession(dialog, state)
    await conclude(dialog, sessionId, state)
    return { consumed: true }
  }

  const existing = await findNextAppointment(
    args.db,
    args.accountId,
    args.contactId,
    dialog.nowIso,
  )
  const state = existing
    ? newBookingState('manage_menu', { appointmentId: existing.id })
    : newBookingState('pick_service')

  const sessionId = await openSession(dialog, state)
  await conclude(dialog, sessionId, state)
  return { consumed: true }
}
```

5. Agrega, después de `bestEffort` al final del archivo:

```ts
// ------------------------------------------------------------
// Pasos clínicos
// ------------------------------------------------------------

function clinicCtx(dialog: Dialog): ClinicStepCtx {
  return {
    db: dialog.db,
    sender: dialog.sender,
    backend: dialog.backend,
    clinic: dialog.clinic!,
    texts: dialog.clinicTexts!,
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    conversationId: dialog.conversationId,
    now: dialog.now,
    nowIso: dialog.nowIso,
    inboundMessageId: dialog.inboundMessageId,
    sendOptions: (args) => sendOptions(dialog, args),
  }
}

async function applyClinicOutcome(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  outcome: ClinicOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'next':
      await conclude(dialog, sessionId, outcome.state)
      return
    case 'handoff':
      await performHandoff(dialog, sessionId, outcome)
      return
    case 'done':
      await closeSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        status: 'completed',
        updatedAtIso: dialog.nowIso,
      })
      return
    case 'fail':
      await registerFail(dialog, sessionId, state, outcome.message)
      return
    case 'reminder':
      await registerFail(dialog, sessionId, state)
      return
  }
}
```

La tarea 11 reemplaza el caso `reminder`.

6. En `handleChoice`, justo después de `const parsed = parseOptionId(choice)`:

```ts
  if (isClinicStep(state.step)) {
    if (!dialog.clinic) {
      await closeSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        status: 'completed',
        updatedAtIso: dialog.nowIso,
      })
      return
    }
    const outcome = await handleClinicChoice(clinicCtx(dialog), state, parsed)
    await applyClinicOutcome(dialog, sessionId, state, outcome)
    return
  }
```

7. En `renderStep`, reemplaza el `return { state, closed: true }` de los pasos clínicos por:

```ts
      if (!dialog.clinic) return { state, closed: true }
      return renderClinicStep(clinicCtx(dialog), state)
```

8. Cambia `performHandoff` para aceptar las opciones. La firma y las líneas que cambian:

```ts
async function performHandoff(
  dialog: Dialog,
  sessionId: string | null,
  opts: Omit<ClinicHandoff, 'kind'> = {},
): Promise<void> {
  await markConversationHandoff(dialog.db, {
    accountId: dialog.accountId,
    conversationId: dialog.conversationId,
    note: opts.note ?? dialog.texts.handoffNote,
    agentId: await loadHandoffAgentId(dialog.db, dialog.accountId),
  })
```

```ts
        title: opts.notification?.title ?? dialog.texts.handoffNotificationTitle,
        body: (opts.notification?.body ?? dialog.texts.handoffNotificationBody)(who),
```

```ts
  await dialog.sender.sendText({ text: opts.message ?? dialog.texts.handoff })
```

- [ ] **Step 7: Corre las pruebas**

Run: `npx vitest run src/verticals/agenda && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/clinica/consent.ts src/verticals/agenda/agent
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

Reemplaza `agendaInboundHandler`:

```ts
export const agendaInboundHandler: VerticalInboundHandler = (ctx) => {
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

  // Clínicas: el candado evita respuestas cruzadas. La sesión se vuelve a
  // leer adentro, porque la del dispatcher pudo cambiar mientras esperaba.
  if (!ctx.modules?.includes('clinica')) return run(ctx.session)
  return withBotLock(
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
    expect(db._tables.clinic_consents.at(-1)).toMatchObject({ kind: 'mercadeo', granted: true })
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
