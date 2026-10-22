# Fase 1 — Agenda armable: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development (recomendado)
> o superpowers:executing-plans para ejecutar este plan tarea por tarea. Los pasos usan casillas
> (`- [ ]`) para el seguimiento.

**Objetivo:** convertir el vertical "Barbería" en una **Agenda** que sirva a cualquier negocio de
citas: punto de partida por tipo de negocio, palabras editables, 5 piezas que se prenden o se apagan
y preguntas extra en el bot.

**Arquitectura:** se renombra `barberia` → `agenda` (carpetas, rutas, identificadores) con un alias
de compatibilidad para cuentas con `vertical_key = 'barberia'`. La configuración nueva vive en
`booking_settings` (columnas) y en la tabla nueva `booking_questions` (migración 051). El copy del bot
pasa de constante a función de las palabras del negocio (`buildAgentTexts(labels)`), y el controlador
lee una sola estructura `BotSettings` por mensaje. Los puntos de partida son objetos en código que el
instalador aplica.

**Tecnología:** Next.js 16 (App Router; leer `node_modules/next/dist/docs/` antes de tocar
config/rutas, ver AGENTS.md), TypeScript, Supabase/Postgres (RLS), Vitest, WhatsApp Cloud API.

**Documento de diseño:** `docs/superpowers/specs/2026-10-22-agenda-calendario-design.md` (§4).

**Reglas del repo que aplican a todo el plan**
- Commits pequeños en la rama `feat/agenda-armable`. **Nunca push ni PR sin OK explícito del
  usuario.** Nunca force-push. Nunca `supabase db push`.
- `.env.local` apunta a **producción**: no correr el bot ni el cron en local contra datos reales.
  Las migraciones se aplican a mano (SQL Editor) solo con OK del usuario.
- Copy en español colombiano, tuteo. Nada de "barbero" escrito a mano fuera del punto de partida
  Barbería.

---

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `src/verticals/agenda/**` (antes `barberia`) | Todo el vertical, renombrado |
| `src/verticals/agenda/labels.ts` (nuevo) | Palabras del negocio: tipos, defaults, saneo |
| `src/verticals/agenda/toggles.ts` (nuevo) | Las 5 piezas: tipos, defaults, columnas |
| `src/verticals/agenda/questions.ts` (nuevo) | Preguntas extra: validación de definición y de respuesta |
| `src/verticals/agenda/presets/*.ts` (nuevo) | Puntos de partida (Barbería, Salón, Salud, Taller, Clases, En blanco) |
| `src/verticals/agenda/texts.ts` | `buildAgentTexts(labels)` reemplaza la constante del bot |
| `src/verticals/agenda/bot-texts.ts` | `mergeBotTexts(overrides, labels)` |
| `src/verticals/agenda/config.ts` | `validateConfigPatch` acepta palabras, piezas y punto de partida |
| `src/verticals/agenda/config-repo.ts` | `saveSettings` + CRUD de preguntas |
| `src/verticals/agenda/install.ts` | `installAgendaTemplate({ presetKey })` |
| `src/verticals/agenda/agent/db.ts` | `loadBotSettings`, `insertAppointment` con respuestas |
| `src/verticals/agenda/agent/state.ts` | Paso `ask_question`, ids `ans:`, intención con palabras propias |
| `src/verticals/agenda/agent/controller.ts` | Aplica piezas, palabras y preguntas |
| `src/verticals/agenda/agent/reminders.ts` | Respeta `reminders_enabled` y las palabras |
| `src/lib/verticals/{types,registry,dispatch}.ts` | Clave `agenda` + alias `barberia` |
| `src/app/api/verticals/agenda/**` | Rutas renombradas + `questions` |
| `src/app/(dashboard)/agenda/**` | Panel renombrado + 3 pestañas nuevas + asistente |
| `supabase/migrations/051_agenda_armable.sql` (nuevo) | Columnas, tabla de preguntas, migración de cuentas |
| `supabase/ci/verify-schema.sql` | Verifica 051 |
| `next.config.ts`, `src/middleware.ts`, `vercel.json`, `messages/*.json` | Ruta `/agenda`, redirección, cron, menú |

---

### Task 0: Preparación

**Archivos:** ninguno.

- [ ] **Paso 1: Confirmar la precondición.** `chore/full-app-audit` debe estar mergeada en `main` y la
  migración 050 aplicada (decisión del usuario). Si no, **parar** y avisar.
- [ ] **Paso 2: Rama nueva desde `main` actualizado**

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/agenda-armable
```

- [ ] **Paso 3: Línea base verde**

Run: `npm run typecheck && npm test`
Expected: 0 errores de tipos; todos los tests PASS. Anotar el número de tests.

---

### Task 1: Renombrar `barberia` → `agenda`

**Archivos:**
- Mover: `src/verticals/barberia` → `src/verticals/agenda`; `src/app/(dashboard)/barberia` →
  `src/app/(dashboard)/agenda`; `src/app/api/verticals/barberia` → `src/app/api/verticals/agenda`
- Modificar: `src/lib/verticals/types.ts`, `registry.ts`, `dispatch.ts`, `src/verticals/agenda/manifest.ts`,
  `src/verticals/agenda/agent/db.ts` (pipeline), `src/verticals/agenda/agent/reminders.ts` (cuentas),
  `next.config.ts`, `src/middleware.ts`, `vercel.json`, `messages/{es,en,pt,ko}.json`
- Test: `src/lib/verticals/registry.test.ts`

- [ ] **Paso 1: Mover carpetas con historial**

```bash
git mv src/verticals/barberia src/verticals/agenda
git mv "src/app/(dashboard)/barberia" "src/app/(dashboard)/agenda"
git mv src/app/api/verticals/barberia src/app/api/verticals/agenda
```

- [ ] **Paso 2: Renombrar rutas de import e identificadores** (solo identificadores: "Barbería" con
  tilde, el texto visible, no se toca aquí)

```bash
grep -rlE "verticals/barberia|BARBERIA_|Barberia|barberia[A-Z]" src | xargs perl -pi -e '
  s#verticals/barberia#verticals/agenda#g;
  s/\bBARBERIA_/AGENDA_/g;
  s/Barberia(?=[A-Z_]|\b)/Agenda/g;
  s/\bbarberia(?=[A-Z])/agenda/g;
'
```

- [ ] **Paso 3: Literales de ruta y de clave**

```bash
grep -rl "'/barberia" src | xargs perl -pi -e "s#'/barberia#'/agenda#g"
grep -rl "/api/verticals/barberia" src | xargs perl -pi -e "s#/api/verticals/barberia#/api/verticals/agenda#g"
grep -rln "'barberia'" src
```

En cada archivo que liste el último comando, reemplazar a mano según el caso:
- comparación con la clave de la cuenta (`vertical_key === 'barberia'`, `!== 'barberia'`) →
  `isAgendaVerticalKey(...)` (paso 5);
- `.eq('vertical_key', 'barberia')` → `.in('vertical_key', [...AGENDA_VERTICAL_KEYS])`;
- datos de test (`vertical_key: 'barberia'`) → `'agenda'`;
- `labelKey: 'barberia'` → `'agenda'`.

- [ ] **Paso 4: Escribir el test del alias** en `src/lib/verticals/registry.test.ts` (agregar al final)

```ts
import { getVerticalManifest, isAgendaVerticalKey, normalizeVerticalKey } from './registry'

describe('alias de la agenda', () => {
  it('la clave vieja barberia resuelve a la agenda', () => {
    expect(normalizeVerticalKey('barberia')).toBe('agenda')
    expect(getVerticalManifest('barberia')?.key).toBe('agenda')
    expect(isAgendaVerticalKey('barberia')).toBe(true)
    expect(isAgendaVerticalKey('agenda')).toBe(true)
  })

  it('claves desconocidas o vacías no son agenda', () => {
    expect(normalizeVerticalKey('tienda')).toBeNull()
    expect(isAgendaVerticalKey(null)).toBe(false)
    expect(isAgendaVerticalKey('')).toBe(false)
  })
})
```

Run: `npx vitest run src/lib/verticals/registry.test.ts`
Expected: FAIL (`normalizeVerticalKey` no existe).

- [ ] **Paso 5: Implementar clave + alias**

`src/lib/verticals/types.ts` — reemplazar la línea del tipo:

```ts
export type VerticalKey = 'agenda'

/**
 * Valores de `accounts.vertical_key` que cuentan como la agenda. 'barberia'
 * es la clave anterior a la migración 051: se acepta mientras el código
 * nuevo convive con cuentas aún sin migrar.
 */
export const AGENDA_VERTICAL_KEYS = ['agenda', 'barberia'] as const
```

`src/lib/verticals/registry.ts` — reemplazar el mapa y `getVerticalManifest`:

```ts
import { AGENDA_VERTICAL_KEYS, type VerticalKey, type VerticalManifest, type VerticalNavItem } from './types'
import { agendaManifest } from '@/verticals/agenda/manifest'

const MANIFESTS: Readonly<Partial<Record<VerticalKey, VerticalManifest>>> = {
  agenda: agendaManifest,
}

/** Clave canónica para un `vertical_key` (alias incluidos) o null. */
export function normalizeVerticalKey(key: string | null | undefined): VerticalKey | null {
  if (!key) return null
  if ((AGENDA_VERTICAL_KEYS as readonly string[]).includes(key)) return 'agenda'
  return key in MANIFESTS ? (key as VerticalKey) : null
}

export function isAgendaVerticalKey(key: string | null | undefined): boolean {
  return normalizeVerticalKey(key) === 'agenda'
}

export function getVerticalManifest(
  key: string | null | undefined,
): VerticalManifest | null {
  const normalized = normalizeVerticalKey(key)
  return normalized ? (MANIFESTS[normalized] ?? null) : null
}
```

`src/lib/verticals/dispatch.ts` — el despachador ya resuelve la cuenta con
`getVerticalManifest(vertical_key)` (que ahora acepta el alias) y luego busca
`VERTICAL_HANDLERS[manifest.key]`, así que solo cambia la clave del mapa:

```ts
const VERTICAL_HANDLERS: Partial<Record<VerticalKey, VerticalInboundHandler>> =
  { agenda: agendaInboundHandler }
```

y el comentario "Phase 2 plugs the barbería booking controller in here" → "the agenda booking
controller".

`src/verticals/agenda/manifest.ts`:

```ts
import { CalendarDays } from 'lucide-react'
import type { VerticalManifest } from '@/lib/verticals/types'

/**
 * Agenda — citas por WhatsApp para cualquier negocio (barbería, salón,
 * consultorio, taller, clases…). Cada cuenta elige su punto de partida y
 * sus palabras en /agenda/configuracion.
 */
export const agendaManifest: VerticalManifest = {
  key: 'agenda',
  name: 'Agenda',
  description: 'Citas por WhatsApp, servicios, equipo y recordatorios para tu negocio.',
  nav: {
    href: '/agenda',
    labelKey: 'agenda',
    icon: CalendarDays,
  },
}
```

- [ ] **Paso 6: Pipeline con nombre viejo o nuevo** — en `src/verticals/agenda/agent/db.ts`, en
  `upsertAgendaDeal`, cambiar la búsqueda del pipeline:

```ts
/** "Agenda" desde 051; "Barbería" en cuentas instaladas antes. */
const AGENDA_PIPELINE_NAMES = ['agenda', 'barbería']

const pipeline = ((pipelines ?? []) as Record<string, unknown>[]).find((row) =>
  AGENDA_PIPELINE_NAMES.includes(String(row.name).trim().toLowerCase()),
)
```

- [ ] **Paso 7: Ruta, redirección, cron y menú**

Leer primero la guía de redirecciones de la versión instalada:
`ls node_modules/next/dist/docs/` y abrir la de `redirects`. Luego, en `next.config.ts`, junto a
`async headers()`:

```ts
  async redirects() {
    return [
      { source: "/barberia", destination: "/agenda", permanent: true },
      { source: "/barberia/:path*", destination: "/agenda/:path*", permanent: true },
    ];
  },
```

`src/middleware.ts`: en `protectedPaths` reemplazar `'/barberia'` por `'/agenda'` y dejar también
`'/barberia'` (la redirección ocurre después del middleware).

`vercel.json`: `"path": "/api/verticals/agenda/reminders/run"`.

`messages/*.json`, en `Sidebar`: reemplazar la clave `"barberia"` por `"agenda"` con
es `"Agenda"`, en `"Schedule"`, pt `"Agenda"`, ko `"예약"`.

- [ ] **Paso 8: Verificar**

```bash
npm run typecheck
npm test
grep -rn "barberia" src | grep -v "AGENDA_VERTICAL_KEYS\|'barberia'\|/barberia\|barbería"
```

Expected: tipos OK, mismos tests que en la línea base + 2 nuevos, PASS. El `grep` final no muestra
identificadores (solo comentarios, que se actualizan a "agenda" a mano).

- [ ] **Paso 9: Commit**

```bash
git add -A
git commit -m "refactor(agenda): rename barberia vertical to agenda with legacy key alias"
```

---

### Task 2: Migración 051

**Archivos:**
- Crear: `supabase/migrations/051_agenda_armable.sql`
- Modificar: `supabase/ci/verify-schema.sql`

- [ ] **Paso 1: Escribir la migración**

```sql
-- ============================================================
-- 051_agenda_armable.sql — la agenda sirve a cualquier negocio
-- ============================================================
--
--   1. accounts.vertical_key 'barberia' → 'agenda' (el código acepta
--      ambas mientras convive; ver AGENDA_VERTICAL_KEYS).
--   2. booking_settings: punto de partida, palabras y las 5 piezas.
--      Las cuentas que ya eran barbería conservan su vocabulario.
--   3. booking_questions: preguntas extra del bot (RLS 050: miembros
--      leen, owner/admin escriben).
--   4. booking_appointments.answers: respuestas a esas preguntas.
--
-- Idempotente. Orden de despliegue: PRIMERO el código (acepta las dos
-- claves), DESPUÉS esta migración.
-- ============================================================

-- 1) Clave del vertical ------------------------------------------------
UPDATE accounts SET vertical_key = 'agenda' WHERE vertical_key = 'barberia';

-- 2) Configuración -------------------------------------------------------
ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS preset_key text,
  ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS choose_staff boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_price boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_duration boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_reschedule boolean NOT NULL DEFAULT true;

ALTER TABLE booking_settings DROP CONSTRAINT IF EXISTS booking_settings_labels_object_check;
ALTER TABLE booking_settings
  ADD CONSTRAINT booking_settings_labels_object_check CHECK (jsonb_typeof(labels) = 'object');

ALTER TABLE booking_settings DROP CONSTRAINT IF EXISTS booking_settings_preset_key_check;
ALTER TABLE booking_settings
  ADD CONSTRAINT booking_settings_preset_key_check
  CHECK (preset_key IS NULL OR preset_key ~ '^[a-z0-9_-]{1,40}$');

-- Cuentas de barbería existentes: mismo vocabulario de siempre.
INSERT INTO booking_settings (account_id)
SELECT id FROM accounts WHERE vertical_key = 'agenda'
ON CONFLICT (account_id) DO NOTHING;

UPDATE booking_settings bs
SET preset_key = 'barberia',
    labels = '{"profesional":"barbero","profesionales":"barberos"}'::jsonb
FROM accounts a
WHERE a.id = bs.account_id
  AND a.vertical_key = 'agenda'
  AND bs.preset_key IS NULL;

-- 3) Preguntas extra ----------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('texto', 'direccion', 'numero', 'opcion')),
  required boolean NOT NULL DEFAULT true,
  options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_questions_account_position
  ON booking_questions (account_id, position);

ALTER TABLE booking_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_questions_select ON booking_questions;
CREATE POLICY booking_questions_select ON booking_questions
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_questions_insert ON booking_questions;
CREATE POLICY booking_questions_insert ON booking_questions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_questions_update ON booking_questions;
CREATE POLICY booking_questions_update ON booking_questions
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_questions_delete ON booking_questions;
CREATE POLICY booking_questions_delete ON booking_questions
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON booking_questions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_questions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4) Respuestas en la cita ---------------------------------------------
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE booking_appointments DROP CONSTRAINT IF EXISTS booking_appointments_answers_object_check;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_answers_object_check CHECK (jsonb_typeof(answers) = 'object');
```

- [ ] **Paso 2: Verificación de esquema** — agregar al final del bloque `DO` de
  `supabase/ci/verify-schema.sql` (mismo estilo que los chequeos de 047/048):

```sql
  -- 051: agenda armable.
  IF to_regclass('public.booking_questions') IS NULL THEN
    RAISE EXCEPTION 'booking_questions is missing — migration 051 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'booking_settings'
      AND column_name = 'choose_staff'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'booking_appointments'
      AND column_name = 'answers'
  ) THEN
    RAISE EXCEPTION 'booking_settings/booking_appointments columns are missing — migration 051 did not apply';
  END IF;
```

- [ ] **Paso 3: Revisión en seco.** Leer la migración contra 047/048/050: nombres de función
  (`is_account_member`, `update_updated_at_column`) iguales; nada destructivo. **No se aplica en este
  plan**: se aplica con OK del usuario después del despliegue del código (Task 13).

- [ ] **Paso 4: Commit**

```bash
git add supabase/migrations/051_agenda_armable.sql supabase/ci/verify-schema.sql
git commit -m "feat(db): agenda settings, extra questions and appointment answers (051)"
```

---

### Task 3: Palabras del negocio (`labels.ts`)

**Archivos:**
- Crear: `src/verticals/agenda/labels.ts`
- Test: `src/verticals/agenda/labels.test.ts`

- [ ] **Paso 1: Test**

```ts
import { describe, expect, it } from 'vitest'

import { capitalize, DEFAULT_LABELS, LABEL_MAX, resolveLabels, sanitizeLabels } from './labels'

describe('sanitizeLabels', () => {
  it('acepta claves conocidas, recorta y descarta vacías', () => {
    const res = sanitizeLabels({ profesional: '  doctor ', citas: '', otra: 'x' })
    expect(res).toEqual({ ok: true, value: { profesional: 'doctor' } })
  })

  it('null o ausente es objeto vacío', () => {
    expect(sanitizeLabels(null)).toEqual({ ok: true, value: {} })
    expect(sanitizeLabels(undefined)).toEqual({ ok: true, value: {} })
  })

  it('rechaza no-objetos, no-texto y textos largos', () => {
    expect(sanitizeLabels([]).ok).toBe(false)
    expect(sanitizeLabels({ cita: 3 }).ok).toBe(false)
    expect(sanitizeLabels({ cita: 'x'.repeat(LABEL_MAX + 1) }).ok).toBe(false)
  })
})

describe('resolveLabels', () => {
  it('completa con los valores por defecto', () => {
    expect(resolveLabels({ profesional: 'técnico' })).toEqual({
      ...DEFAULT_LABELS,
      profesional: 'técnico',
    })
    expect(resolveLabels(null)).toEqual(DEFAULT_LABELS)
  })
})

describe('capitalize', () => {
  it('pone mayúscula inicial', () => {
    expect(capitalize('turno')).toBe('Turno')
    expect(capitalize('')).toBe('')
  })
})
```

Run: `npx vitest run src/verticals/agenda/labels.test.ts` → Expected: FAIL (módulo no existe).

- [ ] **Paso 2: Implementación**

```ts
// ============================================================
// Palabras de la agenda — cómo llama cada negocio a sus cosas
// ("barbero", "doctor", "técnico"; "cita", "turno", "sesión").
// Puro. Se guardan en booking_settings.labels (051); lo que falte
// toma DEFAULT_LABELS.
// ============================================================

import type { Valid } from './config'

export interface AgendaLabels {
  profesional: string
  profesionales: string
  servicio: string
  servicios: string
  cita: string
  citas: string
}

export type AgendaLabelKey = keyof AgendaLabels

export const LABEL_KEYS: readonly AgendaLabelKey[] = [
  'profesional',
  'profesionales',
  'servicio',
  'servicios',
  'cita',
  'citas',
]

export const DEFAULT_LABELS: AgendaLabels = {
  profesional: 'profesional',
  profesionales: 'profesionales',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
}

/** Tope por palabra: entra en un botón de WhatsApp junto a "Ver ". */
export const LABEL_MAX = 24

const isLabelKey = (key: string): key is AgendaLabelKey =>
  (LABEL_KEYS as readonly string[]).includes(key)

export function sanitizeLabels(input: unknown): Valid<Partial<AgendaLabels>> {
  if (input === null || input === undefined) return { ok: true, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Las palabras deben ser un objeto de clave a texto.' }
  }
  const out: Partial<AgendaLabels> = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isLabelKey(key)) continue
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${key}" debe ser texto.` }
    }
    const text = raw.trim()
    if (!text) continue
    if (text.length > LABEL_MAX) {
      return { ok: false, message: `"${key}" no puede pasar de ${LABEL_MAX} caracteres.` }
    }
    out[key] = text
  }
  return { ok: true, value: out }
}

export function resolveLabels(
  partial: Partial<AgendaLabels> | null | undefined,
): AgendaLabels {
  return { ...DEFAULT_LABELS, ...(partial ?? {}) }
}

export function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word
}
```

- [ ] **Paso 3:** Run: `npx vitest run src/verticals/agenda/labels.test.ts` → Expected: PASS.
- [ ] **Paso 4: Commit**

```bash
git add src/verticals/agenda/labels.ts src/verticals/agenda/labels.test.ts
git commit -m "feat(agenda): editable business vocabulary"
```

---

### Task 4: Las 5 piezas (`toggles.ts`)

**Archivos:**
- Crear: `src/verticals/agenda/toggles.ts`
- Test: `src/verticals/agenda/toggles.test.ts`

- [ ] **Paso 1: Test**

```ts
import { describe, expect, it } from 'vitest'

import { DEFAULT_TOGGLES, togglesFromRow, togglesToRow } from './toggles'

describe('togglesFromRow', () => {
  it('fila ausente o columnas nulas = todo prendido', () => {
    expect(togglesFromRow(null)).toEqual(DEFAULT_TOGGLES)
    expect(togglesFromRow({ choose_staff: null })).toEqual(DEFAULT_TOGGLES)
  })

  it('solo false apaga una pieza', () => {
    expect(
      togglesFromRow({ choose_staff: false, show_price: true, reminders_enabled: false }),
    ).toEqual({ ...DEFAULT_TOGGLES, chooseStaff: false, remindersEnabled: false })
  })
})

describe('togglesToRow', () => {
  it('escribe solo las piezas presentes, en snake_case', () => {
    expect(togglesToRow({ showPrice: false, allowReschedule: true })).toEqual({
      show_price: false,
      allow_reschedule: true,
    })
  })
})
```

Run: `npx vitest run src/verticals/agenda/toggles.test.ts` → Expected: FAIL.

- [ ] **Paso 2: Implementación**

```ts
// ============================================================
// Piezas de la agenda que cada negocio prende o apaga (051).
// Puro. Una columna ausente o NULL cuenta como prendida: así una
// cuenta sin fila en booking_settings se comporta como hoy.
// ============================================================

export interface AgendaToggles {
  /** Preguntar "¿con quién?". Apagado: se asigna a quien esté libre. */
  chooseStaff: boolean
  /** Mostrar el precio en el menú, el resumen y la confirmación. */
  showPrice: boolean
  /** Mostrar la duración en el menú de servicios. */
  showDuration: boolean
  /** Enviar recordatorios automáticos. */
  remindersEnabled: boolean
  /** El cliente puede reprogramar o cancelar desde el bot. */
  allowReschedule: boolean
}

export type AgendaToggleKey = keyof AgendaToggles

export const DEFAULT_TOGGLES: AgendaToggles = {
  chooseStaff: true,
  showPrice: true,
  showDuration: true,
  remindersEnabled: true,
  allowReschedule: true,
}

export const TOGGLE_COLUMNS: Record<AgendaToggleKey, string> = {
  chooseStaff: 'choose_staff',
  showPrice: 'show_price',
  showDuration: 'show_duration',
  remindersEnabled: 'reminders_enabled',
  allowReschedule: 'allow_reschedule',
}

export const TOGGLE_KEYS = Object.keys(TOGGLE_COLUMNS) as AgendaToggleKey[]

export function togglesFromRow(row: Record<string, unknown> | null | undefined): AgendaToggles {
  const out = { ...DEFAULT_TOGGLES }
  for (const key of TOGGLE_KEYS) {
    if (row?.[TOGGLE_COLUMNS[key]] === false) out[key] = false
  }
  return out
}

export function togglesToRow(patch: Partial<AgendaToggles>): Record<string, boolean> {
  const row: Record<string, boolean> = {}
  for (const key of TOGGLE_KEYS) {
    const value = patch[key]
    if (typeof value === 'boolean') row[TOGGLE_COLUMNS[key]] = value
  }
  return row
}
```

- [ ] **Paso 3:** Run el test → Expected: PASS.
- [ ] **Paso 4: Commit**

```bash
git add src/verticals/agenda/toggles.ts src/verticals/agenda/toggles.test.ts
git commit -m "feat(agenda): on/off pieces model"
```

---

### Task 5: Copy del bot según las palabras del negocio

**Archivos:**
- Modificar: `src/verticals/agenda/texts.ts` (bloque `AGENDA_AGENT_TEXTS` y el tipo del resumen),
  `src/verticals/agenda/bot-texts.ts`
- Test: `src/verticals/agenda/texts.test.ts` (nuevo), `src/verticals/agenda/bot-texts.test.ts`

- [ ] **Paso 1: Test**

`src/verticals/agenda/texts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { resolveLabels } from './labels'
import { AGENDA_AGENT_TEXTS, buildAgentTexts } from './texts'

const summary = {
  service: 'Limpieza dental',
  staff: 'Dra. Ruiz',
  date: 'martes 20 de octubre de 2026',
  time: '3:00 p. m.',
  price: '$80.000',
  answers: [{ label: 'Motivo', value: 'Control' }],
}

describe('buildAgentTexts', () => {
  it('usa las palabras del negocio', () => {
    const t = buildAgentTexts(resolveLabels({ profesional: 'doctor', profesionales: 'doctores', cita: 'consulta' }))
    expect(t.staffMenuBody).toBe('¿Con qué doctor quieres tu consulta?')
    expect(t.staffMenuButton).toBe('Ver doctores')
    expect(t.summaryBody(summary)).toContain('Así queda tu consulta')
  })

  it('el resumen muestra precio y respuestas; sin precio no hay línea de precio', () => {
    const t = buildAgentTexts(resolveLabels(null))
    expect(t.summaryBody(summary)).toContain('💵 $80.000')
    expect(t.summaryBody(summary)).toContain('📝 Motivo: Control')
    expect(t.summaryBody({ ...summary, price: null })).not.toContain('💵')
  })

  it('los botones nunca pasan de 20 caracteres', () => {
    const t = buildAgentTexts(resolveLabels({ profesionales: 'especialistas en estética' }))
    expect(t.staffMenuButton.length).toBeLessThanOrEqual(20)
  })

  it('AGENDA_AGENT_TEXTS es el copy con palabras por defecto', () => {
    expect(AGENDA_AGENT_TEXTS.staffMenuBody).toBe('¿Con qué profesional quieres tu cita?')
  })
})
```

Agregar a `src/verticals/agenda/bot-texts.test.ts`:

```ts
import { resolveLabels } from './labels'

it('mergeBotTexts aplica overrides sobre el copy de las palabras del negocio', () => {
  const merged = mergeBotTexts({ welcome: 'Hola desde el taller' }, resolveLabels({ profesional: 'técnico' }))
  expect(merged.serviceMenuBody).toBe('Hola desde el taller')
  expect(merged.staffMenuBody).toContain('técnico')
})
```

Run: `npx vitest run src/verticals/agenda/texts.test.ts src/verticals/agenda/bot-texts.test.ts`
Expected: FAIL.

- [ ] **Paso 2: Implementación en `texts.ts`.** Agregar `answers` opcional y precio anulable al tipo
  del resumen:

```ts
export interface AgendaAppointmentSummary {
  service: string
  /** Vacío cuando el negocio no pregunta "¿con quién?" y aún no hay asignado. */
  staff: string
  /** 'martes 20 de octubre de 2026' (formatLongDate). */
  date: string
  /** '3:00 p. m.' (formatTimeLabel). */
  time: string
  /** '$25.000', o null si el negocio esconde precios. */
  price: string | null
  /** Respuestas a las preguntas extra, en orden. */
  answers?: { label: string; value: string }[]
}
```

Reemplazar **todo** el bloque `export const AGENDA_AGENT_TEXTS = { … } as const` por:

```ts
import { DEFAULT_LABELS, type AgendaLabels } from './labels'

/** Meta corta los títulos de botón y el botón de lista a 20 caracteres. */
const BUTTON_MAX = 20
const btn = (text: string) => (text.length <= BUTTON_MAX ? text : `${text.slice(0, BUTTON_MAX - 1)}…`)

function summaryLines(a: AgendaAppointmentSummary, opts: { price?: boolean } = {}): string {
  const lines = [`📌 ${a.service}`]
  if (a.staff) lines.push(`👤 ${a.staff}`)
  lines.push(`📅 ${a.date}`, `🕐 ${a.time}`)
  if (opts.price !== false && a.price) lines.push(`💵 ${a.price}`)
  for (const answer of a.answers ?? []) lines.push(`📝 ${answer.label}: ${answer.value}`)
  return lines.join('\n')
}

/**
 * Todo el copy del bot para las palabras de un negocio. El controlador
 * nunca redacta texto en línea: lo toma de aquí (o de los overrides
 * editables, ver bot-texts.ts). Frases neutras en género para que
 * sirvan con "cita", "turno", "sesión" o "reserva".
 */
export function buildAgentTexts(l: AgendaLabels) {
  return {
    serviceMenuBody: `¡Hola! 👋 Soy el asistente virtual. ¿Qué ${l.servicio} quieres agendar?`,
    serviceMenuButton: btn(`Ver ${l.servicios}`),
    optionsTruncated: 'Te muestro las primeras opciones.',

    staffMenuBody: `¿Con qué ${l.profesional} quieres tu ${l.cita}?`,
    staffMenuButton: btn(`Ver ${l.profesionales}`),
    staffAnyTitle: 'Cualquiera',
    staffAnyDescription: 'Te asignamos a quien esté disponible',

    dayMenuBody: '¿Qué día te queda bien?',
    dayMenuButton: 'Ver días',
    dayToday: 'Hoy',
    dayTomorrow: 'Mañana',

    slotMenuBody: (day: string) => `Horarios disponibles para ${day}:`,
    slotMenuButton: 'Ver horarios',

    answerMenuButton: 'Ver opciones',
    answerInvalidNumber: 'Escríbeme solo números, por favor.',
    answerTooLong: 'Esa respuesta es muy larga. Escríbela más corta, por favor.',
    answerRequired: 'Necesito esa respuesta para agendar. Escríbela, por favor.',

    summaryBody: (a: AgendaAppointmentSummary) =>
      `Así queda tu ${l.cita}:\n\n${summaryLines(a)}\n\n¿Confirmamos?`,
    summaryConfirm: 'Confirmar ✅',
    summaryReschedule: 'Reprogramar',
    summaryCancel: 'Cancelar',
    confirmed: (a: AgendaAppointmentSummary) =>
      `¡Listo! Quedó agendado:\n\n${summaryLines(a, { price: false })}\n\nTe esperamos 🙌. Si necesitas cambiar algo, escríbeme "${l.cita}".`,

    retry: 'No entendí 😅. Por favor elige una de las opciones.',
    slotTaken: 'Uy, ese horario se ocupó mientras elegías 😅. Te muestro otras opciones:',
    dayTaken: 'Ese día se llenó mientras elegías 😅. Mira los días disponibles:',
    noDaysAvailable:
      'Por ahora no tengo horarios disponibles. Escríbeme "asesor" y un humano te ayuda a cuadrar.',
    noServices: `Aún no tengo ${l.servicios} para agendar. Escríbeme "asesor" y te ayudamos.`,
    noStaffForService: `Por ahora no hay ${l.profesionales} disponibles para eso. Elige otra opción, por favor:`,
    confirmError: `Uy, no pude completar ese cambio en tu ${l.cita} en este momento 😅. Intenta de nuevo o escríbeme "asesor".`,

    manageMenuBody: (a: { service: string; date: string; time: string }) =>
      `Vi que ya tienes algo agendado:\n\n📌 ${a.service}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Qué quieres hacer?`,
    manageNew: btn(`Nueva ${l.cita}`),
    manageReschedule: 'Reprogramar',
    manageCancel: btn(`Cancelar ${l.cita}`),
    rescheduleStart: 'Listo, elige el nuevo día:',
    cancelConfirmBody: (a: { date: string; time: string }) =>
      `¿Seguro que quieres cancelar tu ${l.cita} del ${a.date} a las ${a.time}?`,
    cancelYes: 'Sí, cancelar',
    cancelNo: 'No, volver',
    cancelDone: `Listo, quedó cancelado. Cuando quieras agendar de nuevo, escríbeme "${l.cita}". 🙌`,
    cancelDeclined: 'Perfecto, lo dejo como está. ¡Te esperamos! 🙌',
    rescheduleDone: (a: AgendaAppointmentSummary) =>
      `¡Listo! Quedó reprogramado.\n\n${summaryLines(a, { price: false })}\n\n¡Te esperamos! 🙌`,
    managedAppointmentGone: `Veo que eso ya no está activo. Escríbeme "${l.cita}" para agendar de nuevo.`,
    draftCancelled: `Listo, no agendé nada. Cuando quieras, escríbeme "${l.cita}". 🙌`,
    serviceFallback: `tu ${l.servicio}`,
    /** Pieza "reprogramar/cancelar" apagada: lo atiende una persona. */
    changesByHuman:
      'Para cambiar o cancelar, te ayuda un asesor por este chat. Ya le avisé; mientras tanto todo sigue igual. 🙌',

    reminderBody: (a: { business: string; service: string; staff: string; date: string; time: string }) =>
      `¡Hola! 👋 Te recordamos tu ${l.cita} en ${a.business}:\n\n📌 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Nos confirmas?`,
    reminderConfirm: 'Confirmar',
    reminderReschedule: 'Reprogramar',
    reminderCancel: 'Cancelar',
    reminderConfirmed: (a: { service: string; staff: string; date: string; time: string }) =>
      `¡Listo! Queda confirmado:\n\n📌 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¡Te esperamos! 🙌`,

    handoff:
      'Entiendo. Dejo tu conversación con un asesor humano para que te ayude. En breve te contactan. 🙌',
    handoffNote: 'El cliente pidió hablar con una persona desde el flujo de la agenda (bot en pausa).',
    rescheduleHandedToHuman:
      'Listo, le avisé a un asesor para que te ayude a reprogramar. Te escribe por este chat; mientras tanto todo sigue igual. 🙌',
    rescheduleRequestNotificationTitle: 'Cliente quiere reprogramar (Agenda)',
    rescheduleRequestNotificationBody: (a: { who: string; date: string; time: string }) =>
      `${a.who} tocó "Reprogramar" en el recordatorio de su ${l.cita} del ${a.date} a las ${a.time}. Respóndele por este chat.`,
    rescheduleBroken:
      'Uy, tu cambio quedó en revisión y no alcancé a dejarlo como estaba 😅. Ya avisé al equipo para que lo arreglen por este chat; no necesitas hacer nada más. 🙏',
    rescheduleBrokenNotificationTitle: 'Reprogramación a medias (Agenda)',
    rescheduleBrokenNotificationBody: (a: { who: string }) =>
      `${a.who} intentó reprogramar y lo nuevo no se pudo deshacer: puede haber dos ${l.citas} activas. Revísalo en la agenda y respóndele por este chat.`,
    rescheduleBrokenNote:
      'La reprogramación desde el bot quedó a medias (nueva sin deshacer): revisar duplicados. Bot en pausa en este hilo.',
    handoffNotificationTitle: 'Cliente pide un asesor (Agenda)',
    handoffNotificationBody: (name: string) =>
      `${name} pidió hablar con una persona desde el flujo de ${l.citas}.`,
  }
}

export type AgendaAgentTexts = ReturnType<typeof buildAgentTexts>

/** Copy con las palabras por defecto (tests y lugares sin cuenta). */
export const AGENDA_AGENT_TEXTS: AgendaAgentTexts = buildAgentTexts(DEFAULT_LABELS)
```

Nota: si el `import` de `labels.ts` crea un ciclo con `config.ts`, el `import type { Valid }` de
`labels.ts` se resuelve en tiempo de compilación (no hay ciclo en ejecución).

- [ ] **Paso 3: `bot-texts.ts`.** Cambiar el tipo y el merge:

```ts
import { DEFAULT_LABELS, type AgendaLabels } from './labels'
import { AGENDA_TEXTS, buildAgentTexts, type AgendaAgentTexts, type EditableBotTextKey } from './texts'

/** Mantener el nombre usado por el controlador. */
export type AgendaAgentTextsMerged = AgendaAgentTexts

export function botTextDefault(key: EditableBotTextKey, labels: AgendaLabels = DEFAULT_LABELS): string {
  return buildAgentTexts(labels)[BASE_FIELD[key]]
}

export function mergeBotTexts(
  overrides: BotTextOverrides,
  labels: AgendaLabels = DEFAULT_LABELS,
): AgendaAgentTextsMerged {
  const base = buildAgentTexts(labels)
  return {
    ...base,
    serviceMenuBody: overrides.welcome ?? base.serviceMenuBody,
    retry: overrides.retry ?? base.retry,
    noServices: overrides.noServices ?? base.noServices,
    noDaysAvailable: overrides.noDaysAvailable ?? base.noDaysAvailable,
    handoff: overrides.handoff ?? base.handoff,
  }
}
```

Borrar el tipo `AgendaAgentTexts = typeof AGENDA_AGENT_TEXTS` y el `Omit<…>` viejo de este archivo.

- [ ] **Paso 4: Ajustar expectativas de emojis en los tests existentes**

```bash
grep -rln "💈\|✂️" src/verticals/agenda src/app/api/verticals/agenda | xargs perl -pi -e 's/💈/📌/g; s/✂️/🙌/g'
```

- [ ] **Paso 5:** Run: `npx vitest run src/verticals/agenda` → Expected: los tests nuevos PASS. Los del
  controlador que esperan "barbero" en textos fallarán hasta la Task 6 (se arreglan allí).
- [ ] **Paso 6: Commit**

```bash
git add src/verticals/agenda/texts.ts src/verticals/agenda/texts.test.ts src/verticals/agenda/bot-texts.ts src/verticals/agenda/bot-texts.test.ts
git commit -m "feat(agenda): bot copy built from the business vocabulary"
```

---

### Task 6: El bot lee palabras y piezas (`loadBotSettings`)

**Archivos:**
- Modificar: `src/verticals/agenda/agent/db.ts`, `src/verticals/agenda/agent/controller.ts`,
  `src/verticals/agenda/agent/state.ts`
- Test: `src/verticals/agenda/agent/controller.test.ts`

- [ ] **Paso 1: `baseSeed` del test con vocabulario de barbería** (para que los tests existentes
  sigan esperando "barbero"). En `controller.test.ts`, dentro de `baseSeed()`, agregar:

```ts
    booking_settings: [
      {
        account_id: ACCOUNT,
        bot_texts: {},
        labels: { profesional: 'barbero', profesionales: 'barberos' },
        choose_staff: true,
        show_price: true,
        show_duration: true,
        reminders_enabled: true,
        allow_reschedule: true,
      },
    ],
    booking_questions: [],
```

Y un helper para cambiar la configuración en un test:

```ts
function setSettings(db: FakeDb, patch: Row) {
  Object.assign(db._tables.booking_settings[0], patch)
}
```

- [ ] **Paso 2: Tests nuevos** (al final de `controller.test.ts`)

```ts
describe('palabras y piezas del negocio', () => {
  it('usa las palabras configuradas en el menú de profesionales', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { profesional: 'estilista', profesionales: 'estilistas' } })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    expect(last(rec).bodyText).toBe('¿Con qué estilista quieres tu cita?')
  })

  it('choose_staff apagado: no pregunta con quién y asigna a cualquiera', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { choose_staff: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })
    await send(db, rec, { replyId: svcId(SERVICE_CORTE) })

    const state = sessionRow(db)?.state as Record<string, unknown>
    expect(state.staffId).toBe('any')
    expect(state.step).toBe('pick_day')
    expect(last(rec).bodyText).toContain('día')
  })

  it('show_price y show_duration apagados: el menú no muestra descripción', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { show_price: false, show_duration: false })
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    const call = last(rec)
    const rows = call.kind === 'list' ? call.sections?.flatMap((s) => s.rows) ?? [] : []
    for (const row of rows) expect(row.description).toBeUndefined()
  })

  it('show_price apagado: el resumen no muestra precio', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { show_price: false })
    const rec = makeRecorder()

    await walkToDay(db, rec)
    await send(db, rec, { replyId: optionIds(last(rec))[0] })
    await send(db, rec, { replyId: optionIds(last(rec))[0] })

    expect(last(rec).bodyText).not.toContain('💵')
  })

  it('una palabra propia ("turno") abre el flujo', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { labels: { cita: 'sesión', citas: 'sesiones' } })
    const rec = makeRecorder()

    const res = await send(db, rec, { text: 'quiero una sesión' })

    expect(res.consumed).toBe(true)
  })
})
```

Run: `npx vitest run src/verticals/agenda/agent/controller.test.ts` → Expected: los 5 nuevos FAIL.

- [ ] **Paso 3: `db.ts` — reemplazar `loadBotTexts` por `loadBotSettings`**

```ts
import { resolveLabels, sanitizeLabels, type AgendaLabels } from '../labels'
import { togglesFromRow, type AgendaToggles } from '../toggles'

export interface BotSettings {
  botTexts: BotTextOverrides
  labels: AgendaLabels
  toggles: AgendaToggles
}

/** Todo lo que el bot necesita de booking_settings, en una lectura. */
export async function loadBotSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<BotSettings> {
  const { data } = await db
    .from('booking_settings')
    .select('bot_texts, labels, choose_staff, show_price, show_duration, reminders_enabled, allow_reschedule')
    .eq('account_id', accountId)
    .maybeSingle()
  const row = (data as Record<string, unknown> | null) ?? null
  const texts = sanitizeBotTexts(row?.bot_texts ?? {})
  const labels = sanitizeLabels(row?.labels ?? {})
  return {
    botTexts: texts.ok ? texts.value : {},
    labels: resolveLabels(labels.ok ? labels.value : {}),
    toggles: togglesFromRow(row),
  }
}
```

Borrar `loadBotTexts` (y su import en el controlador).

- [ ] **Paso 4: `state.ts` — intención con las palabras del negocio.** Cambiar la firma:

```ts
/** ¿El cliente quiere agendar? Acepta además las palabras propias del negocio. */
export function containsIntentWord(text: string, extraWords: readonly string[] = []): boolean {
  const extra = extraWords.map((w) => normalizeText(w)).filter(Boolean)
  return containsWord(text, [...INTENT_WORDS, ...extra])
}
```

- [ ] **Paso 5: `controller.ts`.**

5a. En `interface Dialog` agregar `settings: BotSettings` y en `handleAgendaInbound`:

```ts
  const settings = await loadBotSettings(args.db, args.accountId)
  const dialog: Dialog = {
    db: args.db,
    sender: args.sender,
    now,
    nowIso: now.toISOString(),
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    account: await loadAccount(args.db, args.accountId),
    settings,
    texts: mergeBotTexts(settings.botTexts, settings.labels),
  }
```

5b. Todo el copy sale del diálogo:

```bash
perl -pi -e 's/\bAGENDA_AGENT_TEXTS\./dialog.texts./g' src/verticals/agenda/agent/controller.ts
npm run typecheck
```

Donde el typecheck diga que `dialog` no existe en ese ámbito, pasar `dialog` como parámetro a esa
función (todas las funciones del controlador ya reciben `dialog` salvo helpers puros).

5c. Intención: en el paso 4 de la entrada,

```ts
  const { labels } = dialog.settings
  if (!containsIntentWord(text, [labels.cita, labels.citas, labels.servicio, labels.servicios])) {
    return { consumed: false }
  }
```

5d. `choose_staff` apagado, en `handleChoice` → `case 'pick_service'`, reemplazar el bloque
`if (staff.length === 1) { … }` y el `conclude` final por:

```ts
      if (staff.length === 1 || !dialog.settings.toggles.chooseStaff) {
        await conclude(dialog, sessionId, {
          ...state,
          serviceId: service.id,
          // Con la pieza apagada se asigna al confirmar (resolveCandidates
          // con 'any' prueba a todos los elegibles; el EXCLUDE manda).
          staffId: staff.length === 1 ? staff[0].id : 'any',
          step: 'pick_day',
        })
        return
      }
      await conclude(dialog, sessionId, {
        ...state,
        serviceId: service.id,
        staffId: undefined,
        step: 'pick_staff',
      })
      return
```

5e. Descripción del servicio según las piezas:

```ts
function serviceDescription(dialog: Dialog, service: ServiceInfo): string | undefined {
  const { showPrice, showDuration } = dialog.settings.toggles
  const parts: string[] = []
  if (showDuration) parts.push(`${service.durationMinutes} min`)
  if (showPrice) parts.push(formatPrice(service.price, dialog.account?.defaultCurrency ?? 'COP'))
  return parts.length ? parts.join(' • ') : undefined
}
```

5f. Precio del resumen según la pieza, en `buildSummary`:

```ts
    price: dialog.settings.toggles.showPrice
      ? formatPrice(service.price, dialog.account?.defaultCurrency ?? 'COP')
      : null,
```

y el nombre del profesional vacío cuando la pieza está apagada y aún no hay asignado, en
`buildSummaryForState`:

```ts
  const staffName =
    state.staffId && state.staffId !== 'any'
      ? ((await loadStaffName(dialog.db, dialog.accountId, state.staffId)) ?? dialog.texts.staffAnyTitle)
      : dialog.settings.toggles.chooseStaff
        ? dialog.texts.staffAnyTitle
        : ''
```

- [ ] **Paso 6:** Run: `npx vitest run src/verticals/agenda` → Expected: todo PASS (los viejos con
  vocabulario de barbería por el seed; los nuevos por la implementación).
- [ ] **Paso 7: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(agenda): bot reads vocabulary and on/off pieces per account"
```

---

### Task 7: Reprogramar/cancelar apagado y recordatorios apagados

**Archivos:**
- Modificar: `src/verticals/agenda/agent/controller.ts` (menú de gestión y taps del recordatorio),
  `src/verticals/agenda/agent/reminders.ts`
- Test: `controller.test.ts`, `reminders.test.ts`

- [ ] **Paso 1: Tests**

En `controller.test.ts`:

```ts
describe('pieza reprogramar/cancelar apagada', () => {
  it('el menú de gestión solo ofrece una nueva cita', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { allow_reschedule: false })
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()

    await send(db, rec, { text: 'hola' })

    expect(optionIds(last(rec))).toEqual(['act:new'])
  })

  it('el tap "Reprogramar" del recordatorio pasa a un humano', async () => {
    const db = makeFakeDb(baseSeed())
    setSettings(db, { allow_reschedule: false })
    db._tables.booking_appointments.push(appointmentRow())
    const rec = makeRecorder()

    await send(db, rec, { replyId: 'rem:reschedule' })

    expect(last(rec).bodyText).toBe(AGENDA_AGENT_TEXTS.changesByHuman)
    expect(db._tables.booking_appointments[0].status).not.toBe('cancelled')
  })
})
```

(Antes de escribir el test, abrir el `case 'manage_menu'` de `renderStep` para confirmar el id real
de "Nueva cita"; si no es `act:new`, usar el que use el código.)

En `reminders.test.ts`, siguiendo el seed del archivo, un caso donde la cuenta tenga
`reminders_enabled: false` en `booking_settings` y una cita que vence: `runAgendaReminders` no envía
nada para esa cuenta (`summary.sent === 0` y el sender grabador sin llamadas).

Run: los 3 tests → Expected: FAIL.

- [ ] **Paso 2: Menú de gestión.** En `renderStep` → `case 'manage_menu'`, construir las opciones así:

```ts
      const options: OfferedOption[] = [
        { id: actId('new'), title: dialog.texts.manageNew },
        ...(dialog.settings.toggles.allowReschedule
          ? [
              { id: actId('reschedule'), title: dialog.texts.manageReschedule },
              { id: actId('cancel'), title: dialog.texts.manageCancel },
            ]
          : []),
      ]
```

(Respetar el id real de "nueva" que ya usa el código.)

- [ ] **Paso 3: Taps del recordatorio.** Al inicio de `handleReminderTap`, antes de procesar
  `reschedule` o `cancel`:

```ts
  if (action !== 'confirm' && !dialog.settings.toggles.allowReschedule) {
    await handoffRescheduleRequest(dialog, appointment)
    await dialog.sender.sendText({ text: dialog.texts.changesByHuman })
    return
  }
```

(`handoffRescheduleRequest` ya existe: avisa al equipo y pausa el bot. Si su firma pide otros
argumentos, pasar los mismos que usa el camino D1 de ese archivo, y no enviar dos mensajes al
cliente: si ya envía `rescheduleHandedToHuman`, omitir el `sendText` de arriba y ajustar el test a
ese texto.)

- [ ] **Paso 4: Recordatorios.** En `runAgendaReminders` (`reminders.ts`), leer también las piezas y
  las palabras, y excluir cuentas apagadas:

```ts
  const { data: settingsRows, error: settingsError } = await args.db
    .from('booking_settings')
    .select('account_id, reminders_2h_enabled, reminders_enabled, labels')
    .in('account_id', [...accountsById.keys()])
  // …mismo manejo de error…
  const twoHourByAccount = new Map<string, boolean>()
  const labelsByAccount = new Map<string, AgendaLabels>()
  const disabledAccounts = new Set<string>()
  for (const row of (settingsRows ?? []) as Record<string, unknown>[]) {
    const id = row.account_id as string
    twoHourByAccount.set(id, row.reminders_2h_enabled === true)
    if (row.reminders_enabled === false) disabledAccounts.add(id)
    const labels = sanitizeLabels(row.labels ?? {})
    labelsByAccount.set(id, resolveLabels(labels.ok ? labels.value : {}))
  }
  const activeAccountIds = [...accountsById.keys()].filter((id) => !disabledAccounts.has(id))
  if (!activeAccountIds.length) return summary
```

Usar `activeAccountIds` en lugar de `[...accountsById.keys()]` al llamar `loadPendingAppointments`, y
filtrar `twoHourAccountIds` con el mismo set. Agregar `labels: AgendaLabels` a `ReminderDelivery`
(se llena con `labelsByAccount.get(appt.account_id) ?? DEFAULT_LABELS`) y en `buildReminderBody`:

```ts
export function buildReminderBody(d: ReminderDelivery): string {
  return buildAgentTexts(d.labels).reminderBody({
    business: d.businessName,
    service: reminderServiceLabel(d.serviceName),
    staff: reminderStaffLabel(d.staffName),
    date: d.dateLabel,
    time: d.timeLabel,
  })
}
```

(Mantener los nombres reales de las dos funciones de etiqueta de las líneas 123-130.) Actualizar los
fixtures de `reminders.test.ts` y `reminders-send.test.ts` que construyen `ReminderDelivery` a mano
agregando `labels: DEFAULT_LABELS`.

- [ ] **Paso 5:** Run: `npx vitest run src/verticals/agenda` → Expected: PASS.
- [ ] **Paso 6: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(agenda): honor reschedule and reminders pieces"
```

---

### Task 8: Guardar palabras, piezas y punto de partida (API de configuración)

**Archivos:**
- Modificar: `src/verticals/agenda/config.ts` (`ConfigPatch`, `validateConfigPatch`),
  `src/verticals/agenda/config-repo.ts` (`SettingsRecord`, `saveSettings`),
  `src/app/api/verticals/agenda/config/route.ts`, `src/verticals/agenda/agent/testing/fake-db.ts`
- Test: `config.test.ts`, `config-repo.test.ts`, `src/app/api/verticals/agenda/config/route.test.ts`

- [ ] **Paso 1: Tests**

`config.test.ts`:

```ts
describe('validateConfigPatch — agenda armable', () => {
  it('acepta palabras, piezas y punto de partida', () => {
    const res = validateConfigPatch({
      labels: { profesional: 'doctor' },
      toggles: { choose_staff: false, show_price: true },
      preset_key: 'salud',
    })
    expect(res).toEqual({
      ok: true,
      value: {
        labels: { profesional: 'doctor' },
        toggles: { chooseStaff: false, showPrice: true },
        presetKey: 'salud',
      },
    })
  })

  it('rechaza piezas que no son sí/no y puntos de partida desconocidos', () => {
    expect(validateConfigPatch({ toggles: { choose_staff: 'no' } }).ok).toBe(false)
    expect(validateConfigPatch({ preset_key: 'tienda' }).ok).toBe(false)
  })
})
```

`config-repo.test.ts`:

```ts
it('saveSettings guarda palabras y piezas sin pisar lo demás', async () => {
  const db = makeFakeDb({
    booking_settings: [{ account_id: 'acc-1', address: 'Calle 1', bot_texts: {}, reminders_2h_enabled: true }],
  })
  const saved = await saveSettings(db as never, 'acc-1', {
    labels: { profesional: 'técnico' },
    toggles: { chooseStaff: false },
  })
  expect(saved.address).toBe('Calle 1')
  expect(saved.labels.profesional).toBe('técnico')
  expect(saved.toggles.chooseStaff).toBe(false)
  expect(saved.toggles.showPrice).toBe(true)
})
```

Run → Expected: FAIL.

- [ ] **Paso 2: `config.ts`**

```ts
import { sanitizeLabels, type AgendaLabels } from './labels'
import { TOGGLE_COLUMNS, TOGGLE_KEYS, type AgendaToggles } from './toggles'
import { isPresetKey, type PresetKey } from './presets'

export interface ConfigPatch {
  address?: string | null
  currency?: string
  reminders2hEnabled?: boolean
  botTexts?: BotTextOverrides
  labels?: Partial<AgendaLabels>
  toggles?: Partial<AgendaToggles>
  presetKey?: PresetKey
}
```

Dentro de `validateConfigPatch`, antes de `if (!any)`:

```ts
  if (has(record, 'labels')) {
    const labels = sanitizeLabels(record.labels)
    if (!labels.ok) return labels
    out.labels = labels.value
    any = true
  }

  if (has(record, 'toggles')) {
    const raw = asRecord(record.toggles)
    if (!raw) return { ok: false, message: 'Las piezas no son válidas.' }
    const toggles: Partial<AgendaToggles> = {}
    for (const key of TOGGLE_KEYS) {
      const column = TOGGLE_COLUMNS[key]
      if (!has(raw, column)) continue
      if (typeof raw[column] !== 'boolean') {
        return { ok: false, message: 'Cada pieza debe ser sí o no.' }
      }
      toggles[key] = raw[column] as boolean
    }
    out.toggles = toggles
    any = true
  }

  if (has(record, 'preset_key')) {
    if (!isPresetKey(record.preset_key)) {
      return { ok: false, message: 'Ese tipo de negocio no existe.' }
    }
    out.presetKey = record.preset_key
    any = true
  }
```

(`isPresetKey` llega en la Task 11; hasta entonces crear `src/verticals/agenda/presets/index.ts` con
lo mínimo para que compile:

```ts
export const PRESET_KEYS = ['barberia', 'salon', 'salud', 'taller', 'clases', 'blanco'] as const
export type PresetKey = (typeof PRESET_KEYS)[number]
export const isPresetKey = (value: unknown): value is PresetKey =>
  typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value)
```

La Task 11 completa este archivo.)

- [ ] **Paso 3: `config-repo.ts`**

```ts
import { resolveLabels, sanitizeLabels, type AgendaLabels } from './labels'
import { togglesFromRow, togglesToRow, type AgendaToggles } from './toggles'

export interface SettingsRecord {
  address: string | null
  reminders2hEnabled: boolean
  botTexts: BotTextOverrides
  labels: AgendaLabels
  toggles: AgendaToggles
  presetKey: string | null
}

const SETTINGS_COLS =
  'account_id, address, reminders_2h_enabled, bot_texts, labels, preset_key, choose_staff, show_price, show_duration, reminders_enabled, allow_reschedule'

export async function saveSettings(
  db: SupabaseClient,
  accountId: string,
  patch: {
    address?: string | null
    reminders2hEnabled?: boolean
    botTexts?: BotTextOverrides
    labels?: Partial<AgendaLabels>
    toggles?: Partial<AgendaToggles>
    presetKey?: string
  },
): Promise<SettingsRecord> {
  const row: Record<string, unknown> = { account_id: accountId }
  if (patch.address !== undefined) row.address = patch.address
  if (patch.reminders2hEnabled !== undefined) row.reminders_2h_enabled = patch.reminders2hEnabled
  if (patch.botTexts !== undefined) row.bot_texts = patch.botTexts
  if (patch.labels !== undefined) row.labels = patch.labels
  if (patch.presetKey !== undefined) row.preset_key = patch.presetKey
  if (patch.toggles !== undefined) Object.assign(row, togglesToRow(patch.toggles))

  const { data } = await db
    .from('booking_settings')
    .upsert(row, { onConflict: 'account_id' })
    .select(SETTINGS_COLS)
    .maybeSingle()
  if (!data) throw new Error('No se pudo guardar la configuración.')

  const settings = data as Record<string, unknown>
  const texts = sanitizeBotTexts(settings.bot_texts)
  const labels = sanitizeLabels(settings.labels)
  return {
    address: (settings.address as string | null) ?? null,
    reminders2hEnabled: Boolean(settings.reminders_2h_enabled),
    botTexts: texts.ok ? texts.value : {},
    labels: resolveLabels(labels.ok ? labels.value : {}),
    toggles: togglesFromRow(settings),
    presetKey: (settings.preset_key as string | null) ?? null,
  }
}
```

Nota: `labels` se guarda **completo** (reemplaza el objeto). La UI siempre manda las 6 palabras.

- [ ] **Paso 4: fake-db.** En `TABLE_DEFAULTS.booking_settings` agregar:

```ts
    labels: {},
    preset_key: null,
    choose_staff: true,
    show_price: true,
    show_duration: true,
    reminders_enabled: true,
    allow_reschedule: true,
```

y una entrada `booking_questions: { required: true, options: [], position: 0, is_active: true }`.

- [ ] **Paso 5: Ruta.** En `config/route.ts`, ampliar la condición y la llamada:

```ts
    if (
      patch.address !== undefined ||
      patch.reminders2hEnabled !== undefined ||
      patch.botTexts !== undefined ||
      patch.labels !== undefined ||
      patch.toggles !== undefined ||
      patch.presetKey !== undefined
    ) {
      settings = await saveSettings(ctx.supabase, ctx.accountId, {
        address: patch.address,
        reminders2hEnabled: patch.reminders2hEnabled,
        botTexts: patch.botTexts,
        labels: patch.labels,
        toggles: patch.toggles,
        presetKey: patch.presetKey,
      })
    }
```

En `route.test.ts` agregar un caso: PATCH `{ toggles: { choose_staff: false } }` como owner → 200 y la
fila con `choose_staff: false`; como agent → 403.

- [ ] **Paso 6:** Run: `npx vitest run src/verticals/agenda src/app/api/verticals/agenda/config` →
  Expected: PASS.
- [ ] **Paso 7: Commit**

```bash
git add src/verticals/agenda src/app/api/verticals/agenda/config
git commit -m "feat(agenda): save vocabulary, pieces and business type"
```

---

### Task 9: Preguntas extra — modelo, repositorio y API

**Archivos:**
- Crear: `src/verticals/agenda/questions.ts`, `src/verticals/agenda/questions.test.ts`,
  `src/app/api/verticals/agenda/questions/route.ts`, `…/questions/[id]/route.ts`,
  `…/questions/route.test.ts`
- Modificar: `src/verticals/agenda/config-repo.ts`

- [ ] **Paso 1: Tests de validación** (`questions.test.ts`)

```ts
import { describe, expect, it } from 'vitest'

import { MAX_QUESTIONS, validateAnswer, validateQuestionCreate } from './questions'

describe('validateQuestionCreate', () => {
  it('acepta una pregunta de texto', () => {
    expect(validateQuestionCreate({ label: 'Placa del carro', kind: 'texto' })).toEqual({
      ok: true,
      value: { label: 'Placa del carro', kind: 'texto', required: true, options: [] },
    })
  })

  it('opción exige entre 2 y 10 opciones cortas', () => {
    expect(validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['Norte'] }).ok).toBe(false)
    expect(
      validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['Norte', 'Sur'] }).ok,
    ).toBe(true)
    expect(
      validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['x'.repeat(25), 'Sur'] }).ok,
    ).toBe(false)
  })

  it('rechaza tipos desconocidos y etiquetas vacías', () => {
    expect(validateQuestionCreate({ label: 'X', kind: 'foto' }).ok).toBe(false)
    expect(validateQuestionCreate({ label: '  ', kind: 'texto' }).ok).toBe(false)
  })

  it('MAX_QUESTIONS es 5', () => {
    expect(MAX_QUESTIONS).toBe(5)
  })
})

describe('validateAnswer', () => {
  const numero = { id: 'q1', label: 'Personas', kind: 'numero' as const, required: true, options: [] }
  const texto = { id: 'q2', label: 'Motivo', kind: 'texto' as const, required: false, options: [] }

  it('número: solo dígitos', () => {
    expect(validateAnswer(numero, ' 4 ')).toEqual({ ok: true, value: '4' })
    expect(validateAnswer(numero, 'cuatro')).toEqual({ ok: false, reason: 'number' })
  })

  it('texto opcional vacío se acepta; obligatorio no', () => {
    expect(validateAnswer(texto, '')).toEqual({ ok: true, value: '' })
    expect(validateAnswer({ ...texto, required: true }, '')).toEqual({ ok: false, reason: 'required' })
  })

  it('respuestas largas se rechazan', () => {
    expect(validateAnswer(texto, 'x'.repeat(201))).toEqual({ ok: false, reason: 'too_long' })
  })
})
```

Run → Expected: FAIL.

- [ ] **Paso 2: `questions.ts`**

```ts
// ============================================================
// Preguntas extra del bot (051) — puras.
// El bot las hace después de elegir la hora y antes del resumen.
// ============================================================

import type { Valid } from './config'

export const QUESTION_KINDS = ['texto', 'direccion', 'numero', 'opcion'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export const MAX_QUESTIONS = 5
export const QUESTION_LABEL_MAX = 80
/** Título de fila de lista de WhatsApp. */
export const OPTION_MAX = 24
export const MAX_OPTIONS = 10
export const ANSWER_MAX = 200

export interface QuestionInput {
  label: string
  kind: QuestionKind
  required: boolean
  options: string[]
}

export interface AgendaQuestion extends QuestionInput {
  id: string
}

const isKind = (value: unknown): value is QuestionKind =>
  typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value)

export function validateQuestionCreate(input: unknown): Valid<QuestionInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'La pregunta no es válida.' }
  }
  const record = input as Record<string, unknown>
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (!label) return { ok: false, message: 'Escribe la pregunta.' }
  if (label.length > QUESTION_LABEL_MAX) {
    return { ok: false, message: `La pregunta no puede pasar de ${QUESTION_LABEL_MAX} caracteres.` }
  }
  if (!isKind(record.kind)) return { ok: false, message: 'Ese tipo de pregunta no existe.' }
  if (record.required !== undefined && typeof record.required !== 'boolean') {
    return { ok: false, message: '"Obligatoria" debe ser sí o no.' }
  }

  let options: string[] = []
  if (record.kind === 'opcion') {
    if (!Array.isArray(record.options)) {
      return { ok: false, message: 'Agrega las opciones de respuesta.' }
    }
    options = record.options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean)
    if (options.length < 2 || options.length > MAX_OPTIONS) {
      return { ok: false, message: `Pon entre 2 y ${MAX_OPTIONS} opciones.` }
    }
    if (options.some((o) => o.length > OPTION_MAX)) {
      return { ok: false, message: `Cada opción puede tener hasta ${OPTION_MAX} caracteres.` }
    }
  }

  return {
    ok: true,
    value: { label, kind: record.kind, required: record.required !== false, options },
  }
}

export type AnswerCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'required' | 'number' | 'too_long' }

/** Valida una respuesta escrita (las de opción llegan por id de lista). */
export function validateAnswer(question: AgendaQuestion, raw: string): AnswerCheck {
  const value = raw.trim()
  if (!value) return question.required ? { ok: false, reason: 'required' } : { ok: true, value: '' }
  if (value.length > ANSWER_MAX) return { ok: false, reason: 'too_long' }
  if (question.kind === 'numero' && !/^\d+$/.test(value)) return { ok: false, reason: 'number' }
  return { ok: true, value }
}
```

- [ ] **Paso 3: Repositorio** (agregar a `config-repo.ts`)

```ts
import { MAX_QUESTIONS, type AgendaQuestion, type QuestionInput } from './questions'

const QUESTION_COLS = 'id, label, kind, required, options, position'

function mapQuestion(row: Record<string, unknown>): AgendaQuestion {
  return {
    id: row.id as string,
    label: row.label as string,
    kind: row.kind as AgendaQuestion['kind'],
    required: row.required !== false,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
  }
}

export async function listQuestions(db: SupabaseClient, accountId: string): Promise<AgendaQuestion[]> {
  const { data, error } = await db
    .from('booking_questions')
    .select(QUESTION_COLS)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position')
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(mapQuestion)
}

export async function createQuestion(
  db: SupabaseClient,
  accountId: string,
  input: QuestionInput,
): Promise<AgendaQuestion> {
  const current = await listQuestions(db, accountId)
  if (current.length >= MAX_QUESTIONS) {
    throw new ConfigError('invalid_order', `Máximo ${MAX_QUESTIONS} preguntas extra.`)
  }
  const { data } = await db
    .from('booking_questions')
    .insert({
      account_id: accountId,
      label: input.label,
      kind: input.kind,
      required: input.required,
      options: input.options,
      position: current.length,
    })
    .select(QUESTION_COLS)
    .maybeSingle()
  if (!data) throw new Error('No se pudo crear la pregunta.')
  return mapQuestion(data as Record<string, unknown>)
}

export async function updateQuestion(
  db: SupabaseClient,
  accountId: string,
  id: string,
  input: QuestionInput,
): Promise<AgendaQuestion> {
  const { data } = await db
    .from('booking_questions')
    .update({ label: input.label, kind: input.kind, required: input.required, options: input.options })
    .eq('account_id', accountId)
    .eq('id', id)
    .select(QUESTION_COLS)
    .maybeSingle()
  if (!data) throw new ConfigError('not_found', 'Esa pregunta ya no existe.')
  return mapQuestion(data as Record<string, unknown>)
}

/** Se desactiva (no se borra): las citas guardan respuestas por id. */
export async function deleteQuestion(db: SupabaseClient, accountId: string, id: string): Promise<void> {
  const { data } = await db
    .from('booking_questions')
    .update({ is_active: false })
    .eq('account_id', accountId)
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (!data) throw new ConfigError('not_found', 'Esa pregunta ya no existe.')
}
```

- [ ] **Paso 4: Rutas**

`src/app/api/verticals/agenda/questions/route.ts`:

```ts
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createQuestion } from '@/verticals/agenda/config-repo'
import { validateQuestionCreate } from '@/verticals/agenda/questions'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// POST /api/verticals/agenda/questions — crea una pregunta extra (owner/admin).
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const parsed = validateQuestionCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)
    const question = await createQuestion(ctx.supabase, ctx.accountId, parsed.value)
    return NextResponse.json({ question })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
```

`src/app/api/verticals/agenda/questions/[id]/route.ts` — antes de escribirlo, abrir
`services/[id]/route.ts` y copiar **exactamente** cómo recibe `params` en esta versión de Next
(promesa o no):

```ts
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { deleteQuestion, updateQuestion } from '@/verticals/agenda/config-repo'
import { validateQuestionCreate } from '@/verticals/agenda/questions'

import { badRequest, configErrorResponse, readJsonBody } from '../../_lib/http'

type Params = { params: Promise<{ id: string }> }

// PATCH reemplaza la definición; DELETE la desactiva (owner/admin).
export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const parsed = validateQuestionCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)
    const question = await updateQuestion(ctx.supabase, ctx.accountId, id, parsed.value)
    return NextResponse.json({ question })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    await deleteQuestion(ctx.supabase, ctx.accountId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
```

`questions/route.test.ts` — mismo arnés que `services/route.test.ts` (los `vi.hoisted` /
`vi.mock` de `next/server` y `@/lib/auth/account` copiados tal cual), con estos casos:

```ts
describe('POST /api/verticals/agenda/questions', () => {
  it('crea la pregunta al final y en la cuenta de la sesión', async () => {
    const db = boot()
    const res = (await POST(jsonRequest({ label: 'Placa', kind: 'texto' }))) as unknown as TestResponse
    expect(res.status).toBe(200)
    expect(res.body.question).toMatchObject({ label: 'Placa', kind: 'texto', required: true })
    expect(db._tables.booking_questions.at(-1)?.account_id).toBe(TEST_ACCOUNT)
  })

  it('agent y viewer reciben 403', async () => {
    boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      const res = (await POST(jsonRequest({ label: 'Placa', kind: 'texto' }))) as unknown as TestResponse
      expect(res.status).toBe(403)
    }
  })

  it('no deja pasar de 5 preguntas', async () => {
    const db = boot()
    for (let i = 0; i < 5; i++) {
      db._tables.booking_questions.push({
        id: `q${i}`, account_id: TEST_ACCOUNT, label: `P${i}`, kind: 'texto',
        required: true, options: [], position: i, is_active: true,
      })
    }
    const res = (await POST(jsonRequest({ label: 'Otra', kind: 'texto' }))) as unknown as TestResponse
    expect(res.status).toBe(409)
  })
})
```

con `baseSeed()` devolviendo `{ booking_questions: [] }`.

- [ ] **Paso 5:** Run: `npx vitest run src/verticals/agenda/questions.test.ts src/app/api/verticals/agenda/questions`
  → Expected: PASS.
- [ ] **Paso 6: Commit**

```bash
git add src/verticals/agenda/questions.ts src/verticals/agenda/questions.test.ts src/verticals/agenda/config-repo.ts src/app/api/verticals/agenda/questions
git commit -m "feat(agenda): extra questions model, repository and API"
```

---

### Task 10: El bot hace las preguntas extra

**Archivos:**
- Modificar: `src/verticals/agenda/agent/state.ts`, `db.ts`, `controller.ts`
- Test: `controller.test.ts`

- [ ] **Paso 1: Tests**

```ts
describe('preguntas extra', () => {
  function withQuestions(db: FakeDb) {
    db._tables.booking_questions.push(
      { id: 'q-motivo', account_id: ACCOUNT, label: '¿Motivo de la visita?', kind: 'texto', required: true, options: [], position: 0, is_active: true },
      { id: 'q-sede', account_id: ACCOUNT, label: '¿En qué sede?', kind: 'opcion', required: true, options: ['Norte', 'Sur'], position: 1, is_active: true },
    )
  }

  async function walkToFirstQuestion(db: FakeDb, rec: Recorder) {
    await walkToDay(db, rec)
    await send(db, rec, { replyId: optionIds(last(rec))[0] }) // día
    await send(db, rec, { replyId: optionIds(last(rec))[0] }) // hora
  }

  it('después de la hora pregunta en orden y luego muestra el resumen con las respuestas', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToFirstQuestion(db, rec)
    expect(last(rec).bodyText).toBe('¿Motivo de la visita?')

    await send(db, rec, { text: 'Control' })
    expect(last(rec).bodyText).toBe('¿En qué sede?')
    expect(optionTitles(last(rec))).toEqual(['Norte', 'Sur'])

    await send(db, rec, { replyId: optionIds(last(rec))[1] })
    expect(last(rec).bodyText).toContain('📝 ¿Motivo de la visita?: Control')
    expect(last(rec).bodyText).toContain('📝 ¿En qué sede?: Sur')
  })

  it('al confirmar, la cita guarda las respuestas por id de pregunta', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToFirstQuestion(db, rec)
    await send(db, rec, { text: 'Control' })
    await send(db, rec, { replyId: optionIds(last(rec))[0] })
    await send(db, rec, { replyId: 'act:confirm' })

    expect(db._tables.booking_appointments.at(-1)?.answers).toEqual({
      'q-motivo': 'Control',
      'q-sede': 'Norte',
    })
  })

  it('una respuesta obligatoria vacía repite la pregunta con aviso', async () => {
    const db = makeFakeDb(baseSeed())
    withQuestions(db)
    const rec = makeRecorder()

    await walkToFirstQuestion(db, rec)
    await send(db, rec, { text: '   ' })

    expect(messagesWith(rec, AGENDA_AGENT_TEXTS.answerRequired)).toHaveLength(1)
    expect(last(rec).bodyText).toBe('¿Motivo de la visita?')
  })
})
```

Run → Expected: FAIL.

- [ ] **Paso 2: `state.ts`**

```ts
export type BookingStep =
  | 'pick_service'
  | 'pick_staff'
  | 'pick_day'
  | 'pick_slot'
  | 'ask_question'
  | 'summary'
  | 'manage_menu'
  | 'manage_cancel_confirm'
```

En `BookingState` agregar:

```ts
  /** Índice de la pregunta extra en curso (orden de position). */
  questionIndex?: number
  /** Respuestas por id de pregunta. */
  answers?: Record<string, string>
```

Ids de respuesta de opción:

```ts
export const ansId = (index: number): string => `ans:${index}`
export type OptionKind = 'svc' | 'staff' | 'day' | 'slot' | 'act' | 'ans'
const OPTION_KINDS: readonly OptionKind[] = ['svc', 'staff', 'day', 'slot', 'act', 'ans']
```

- [ ] **Paso 3: `db.ts`.** Exportar `listActiveQuestions(db, accountId)` (misma consulta que
  `listQuestions` del repo, devolviendo `AgendaQuestion[]`; importar `AgendaQuestion` de
  `../questions`) y agregar `answers?: Record<string, string>` a los args de `insertAppointment`:

```ts
    ...(args.answers && Object.keys(args.answers).length ? { answers: args.answers } : {}),
```

- [ ] **Paso 4: `controller.ts`.**

4a. En `case 'pick_slot'` de `handleChoice`, al pasar al resumen, ir primero a las preguntas si hay:

```ts
      const questions = await listActiveQuestions(dialog.db, dialog.accountId)
      await conclude(dialog, sessionId, {
        ...state,
        dateKey,
        slotStartsAt: startsAtIso,
        ...(questions.length
          ? { step: 'ask_question' as const, questionIndex: 0, answers: {} }
          : { step: 'summary' as const }),
      })
      return
```

4b. Las preguntas de texto se responden escribiendo, así que no pasan por `matchChoice`. En
`advanceSession`, antes de resolver la opción, si `state.step === 'ask_question'` llamar a
`handleAnswer(dialog, sessionId, state, { text, replyId })` y retornar:

```ts
async function handleAnswer(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  input: { text: string; replyId: string | null },
): Promise<void> {
  const questions = await listActiveQuestions(dialog.db, dialog.accountId)
  const index = state.questionIndex ?? 0
  const question = questions[index]
  if (!question) {
    await conclude(dialog, sessionId, { ...state, step: 'summary' })
    return
  }

  let value: string | null = null
  if (question.kind === 'opcion') {
    const choice = matchChoice({ text: input.text, replyId: input.replyId, options: state.options })
    const parsed = choice ? parseOptionId(choice) : null
    if (parsed?.kind === 'ans') value = question.options[Number(parsed.value)] ?? null
    if (value === null) {
      await registerFail(dialog, sessionId, state)
      return
    }
  } else {
    const check = validateAnswer(question, input.text)
    if (!check.ok) {
      const warning =
        check.reason === 'number'
          ? dialog.texts.answerInvalidNumber
          : check.reason === 'too_long'
            ? dialog.texts.answerTooLong
            : dialog.texts.answerRequired
      await dialog.sender.sendText({ text: warning })
      await conclude(dialog, sessionId, state)
      return
    }
    value = check.value
  }

  const answers = { ...(state.answers ?? {}), [question.id]: value }
  const next = index + 1
  await conclude(dialog, sessionId, {
    ...state,
    answers,
    ...(next < questions.length
      ? { questionIndex: next, step: 'ask_question' as const }
      : { questionIndex: undefined, step: 'summary' as const }),
  })
}
```

(Si `registerFail` tiene otra firma, usar la misma llamada que `advanceSession` hace cuando
`matchChoice` devuelve null.)

4c. En `renderStep` agregar el caso:

```ts
    case 'ask_question': {
      const questions = await listActiveQuestions(dialog.db, dialog.accountId)
      const question = questions[state.questionIndex ?? 0]
      if (!question) return renderStep(dialog, { ...state, step: 'summary' })
      if (question.kind === 'opcion') {
        const options: OfferedOption[] = question.options.map((title, i) => ({ id: ansId(i), title }))
        await sendOptions(dialog, {
          bodyText: question.label,
          buttonLabel: dialog.texts.answerMenuButton,
          options,
        })
        return { state: { ...state, options }, closed: false }
      }
      await dialog.sender.sendText({ text: question.label })
      return { state: { ...state, options: [] }, closed: false }
    }
```

4d. Resumen con respuestas: en `buildSummaryForState`, después de construir el resumen base:

```ts
  const questions = await listActiveQuestions(dialog.db, dialog.accountId)
  const answers = questions
    .filter((q) => state.answers?.[q.id])
    .map((q) => ({ label: q.label, value: state.answers![q.id] }))
  return { ...buildSummary(dialog, service, staffName, new Date(state.slotStartsAt)), answers }
```

4e. Al confirmar, en `confirmAppointment`, pasar `answers: state.answers` a `insertAppointment`.

4f. Desde el resumen, "Reprogramar" (cambiar hora) borra `answers` y `questionIndex` al volver a
`pick_day` para no arrastrar respuestas viejas:

```ts
        await conclude(dialog, sessionId, {
          ...state,
          slotStartsAt: undefined,
          answers: undefined,
          questionIndex: undefined,
          step: 'pick_day',
        })
```

- [ ] **Paso 5:** Run: `npx vitest run src/verticals/agenda` → Expected: PASS.
- [ ] **Paso 6: Commit**

```bash
git add src/verticals/agenda/agent
git commit -m "feat(agenda): bot asks extra questions and stores answers"
```

---

### Task 11: Puntos de partida (presets) e instalador

**Archivos:**
- Crear: `src/verticals/agenda/presets/{index,barberia,salon,salud,taller,clases,blanco}.ts`,
  `src/verticals/agenda/presets/presets.test.ts`
- Modificar: `src/verticals/agenda/seed.ts` (tipos genéricos), `src/verticals/agenda/install.ts`,
  `src/app/api/verticals/agenda/setup/route.ts`
- Test: `install.test.ts`, `setup/route.test.ts`

- [ ] **Paso 1: Tipos genéricos del seed.** En `seed.ts`, después del rename de la Task 1 los tipos se
  llaman `AgendaSeed`, `AgendaSeedService`, etc. Cambiar el nombre del pipeline del seed a
  `'Agenda'` y mover `AGENDA_SEED` (los datos de barbería) a `presets/barberia.ts` como
  `BARBERIA_PRESET.seed`. `seed.ts` queda solo con tipos y `AgendaInstallReport`.

- [ ] **Paso 2: `presets/index.ts`** (reemplaza el mínimo de la Task 8)

```ts
// ============================================================
// Puntos de partida de la agenda. Aplicar uno SOLO LLENA: agrega lo
// que falte (servicios, equipo, horario, preguntas) y fija palabras,
// piezas y bienvenida. Después todo se edita en Configuración.
// ============================================================

import type { AgendaLabels } from '../labels'
import type { AgendaToggles } from '../toggles'
import type { QuestionInput } from '../questions'
import type { AgendaSeed } from '../seed'

import { BARBERIA_PRESET } from './barberia'
import { BLANCO_PRESET } from './blanco'
import { CLASES_PRESET } from './clases'
import { SALON_PRESET } from './salon'
import { SALUD_PRESET } from './salud'
import { TALLER_PRESET } from './taller'

export const PRESET_KEYS = ['barberia', 'salon', 'salud', 'taller', 'clases', 'blanco'] as const
export type PresetKey = (typeof PRESET_KEYS)[number]

export interface AgendaPreset {
  key: PresetKey
  /** Nombre en la tarjeta del asistente. */
  name: string
  /** Una línea: para quién es. */
  description: string
  labels: AgendaLabels
  toggles: AgendaToggles
  /** Override de la bienvenida (bot_texts.welcome). */
  welcome: string
  seed: AgendaSeed
  questions: QuestionInput[]
}

export const AGENDA_PRESETS: Record<PresetKey, AgendaPreset> = {
  barberia: BARBERIA_PRESET,
  salon: SALON_PRESET,
  salud: SALUD_PRESET,
  taller: TALLER_PRESET,
  clases: CLASES_PRESET,
  blanco: BLANCO_PRESET,
}

export const isPresetKey = (value: unknown): value is PresetKey =>
  typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value)

export const getPreset = (key: PresetKey): AgendaPreset => AGENDA_PRESETS[key]
```

- [ ] **Paso 3: Un archivo por punto de partida.** Ejemplo completo (`presets/salud.ts`); los demás
  siguen la misma forma con los datos de la tabla de abajo. Precios siempre de ejemplo y editables.

```ts
import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaPreset } from './index'
import { BASE_TAGS, BASE_PIPELINE, weekdays } from './shared'

export const SALUD_PRESET: AgendaPreset = {
  key: 'salud',
  name: 'Consultorio / salud',
  description: 'Odontología, fisioterapia, psicología, estética, medicina general.',
  labels: {
    profesional: 'especialista',
    profesionales: 'especialistas',
    servicio: 'consulta',
    servicios: 'consultas',
    cita: 'cita',
    citas: 'citas',
  },
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente del consultorio. ¿Qué consulta quieres agendar?',
  seed: {
    services: [
      { name: 'Consulta general', description: 'Valoración inicial.', durationMinutes: 30, price: 80000, position: 0 },
      { name: 'Control', description: 'Seguimiento de tratamiento.', durationMinutes: 20, price: 50000, position: 1 },
      { name: 'Procedimiento', description: 'Según valoración previa.', durationMinutes: 60, price: 150000, position: 2 },
    ],
    staff: [{ name: 'Especialista 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5], [['08:00', '12:00'], ['14:00', '18:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [{ label: '¿Cuál es el motivo de la consulta?', kind: 'texto', required: false, options: [] }],
}
```

`presets/shared.ts`:

```ts
import type { AgendaSeedHour, AgendaSeedTag } from '../seed'

/**
 * Las mismas etiquetas del seed de barbería: el controlador las busca
 * por nombre (no cambiar los nombres).
 */
export const BASE_TAGS: AgendaSeedTag[] = [
  { name: 'cita-pendiente', color: '#f59e0b' },
  { name: 'cita-confirmada', color: '#10b981' },
  { name: 'cita-reprogramada', color: '#6366f1' },
  { name: 'cita-cancelada', color: '#ef4444' },
  { name: 'quiere-humano', color: '#8b5cf6' },
  { name: 'atendido', color: '#3b82f6' },
]

/** Mismas etapas que barbería: el bot mueve el negocio a "Cita agendada". */
export const BASE_PIPELINE = {
  name: 'Agenda',
  stages: [
    { name: 'Nuevo', color: '#3b82f6' },
    { name: 'Cita agendada', color: '#f59e0b' },
    { name: 'Atendida', color: '#10b981' },
    { name: 'No asistió', color: '#ef4444' },
    { name: 'Perdido', color: '#6b7280' },
  ],
}

/** Horario semanal: mismos bloques para cada día ('HH:MM' → 'HH:MM:00'). */
export function weekdays(days: number[], blocks: [string, string][]): AgendaSeedHour[] {
  return days.flatMap((weekday) =>
    blocks.map(([start, end]) => ({ weekday, startTime: `${start}:00`, endTime: `${end}:00` })),
  )
}
```

El seed de barbería conserva además sus `customFields`, `quickReplies` y `knowledgeDocs` actuales;
los demás puntos de partida los dejan vacíos (el dueño los arma después).

| Punto de partida | Palabras (profesional / servicio / cita) | Servicios de ejemplo | Horario | Piezas distintas a las por defecto | Pregunta extra |
| --- | --- | --- | --- | --- | --- |
| barberia | barbero / servicio / cita | los 3 actuales | el actual | — | — |
| salon | estilista / servicio / cita | Corte y peinado 60', Manicure 45', Pedicure 60' | Lun–Sáb 9–19 | — | — |
| salud | especialista / consulta / cita | (arriba) | Lun–Vie 8–12 y 14–18 | — | Motivo (opcional) |
| taller | técnico / servicio / cita | Diagnóstico 60', Mantenimiento 120', Lavado 45' | Lun–Sáb 8–17 | `chooseStaff: false` | Placa del vehículo (texto, obligatoria) |
| clases | profesor / clase / sesión | Clase individual 60', Clase de prueba 30' | Lun–Sáb 7–20 | — | — |
| blanco | profesional / servicio / cita | ninguno | ninguno | — | — |

`BARBERIA_PRESET`: `labels` barbero/barberos/servicio/servicios/cita/citas; `welcome` = la bienvenida
de barbería actual (`'¡Hola! 👋 Soy el asistente de la barbería. ¿Qué servicio quieres agendar?'`);
`seed` = los datos que hoy tiene `AGENDA_SEED` (con `pipeline.name: 'Agenda'`).

- [ ] **Paso 4: Test de los puntos de partida** (`presets.test.ts`)

```ts
import { describe, expect, it } from 'vitest'

import { sanitizeLabels } from '../labels'
import { validateQuestionCreate } from '../questions'
import { AGENDA_PRESETS, PRESET_KEYS } from './index'

describe('puntos de partida', () => {
  it.each(PRESET_KEYS)('%s es válido de punta a punta', (key) => {
    const preset = AGENDA_PRESETS[key]
    expect(preset.key).toBe(key)
    expect(sanitizeLabels(preset.labels)).toEqual({ ok: true, value: preset.labels })
    for (const q of preset.questions) expect(validateQuestionCreate(q).ok).toBe(true)
    expect(preset.welcome.length).toBeLessThanOrEqual(320)
    for (const s of preset.seed.services) {
      expect(s.durationMinutes).toBeGreaterThan(0)
      expect(s.durationMinutes).toBeLessThanOrEqual(480)
    }
  })

  it('todos llevan las etiquetas que usa el bot', () => {
    for (const key of PRESET_KEYS.filter((k) => k !== 'blanco')) {
      const names = AGENDA_PRESETS[key].seed.tags.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['cita-confirmada', 'cita-cancelada', 'quiere-humano']))
    }
  })
})
```

- [ ] **Paso 5: Instalador.** En `install.ts`:

```ts
export interface InstallAgendaArgs {
  db: SupabaseClient
  accountId: string
  userId: string
  /** Punto de partida; por defecto el de la cuenta o 'barberia'. */
  presetKey?: PresetKey
}
```

Al inicio de `installAgendaTemplate`, resolver el preset y usar `preset.seed` donde hoy se usa
`AGENDA_SEED`:

```ts
  const preset = getPreset(args.presetKey ?? 'barberia')
  const seed = preset.seed
```

Al final (antes de devolver el reporte), fijar configuración y preguntas:

```ts
  // Palabras, piezas, punto de partida y bienvenida del preset. La
  // bienvenida solo se fija si el dueño no escribió una propia.
  const { data: current } = await db
    .from('booking_settings')
    .select('bot_texts')
    .eq('account_id', accountId)
    .maybeSingle()
  const botTexts = ((current as { bot_texts?: Record<string, string> } | null)?.bot_texts ?? {})
  const { error: settingsError } = await db.from('booking_settings').upsert(
    {
      account_id: accountId,
      preset_key: preset.key,
      labels: preset.labels,
      ...togglesToRow(preset.toggles),
      bot_texts: botTexts.welcome ? botTexts : { ...botTexts, welcome: preset.welcome },
    },
    { onConflict: 'account_id' },
  )
  if (settingsError) throw settingsError

  // Preguntas del preset solo si la cuenta no tiene ninguna activa.
  const existingQuestions = await selectRows<{ id: string }>(db, 'booking_questions', 'id', accountId)
  if (!existingQuestions.length && preset.questions.length) {
    await insertRows(
      db,
      'booking_questions',
      preset.questions.map((q, position) => ({
        account_id: accountId,
        label: q.label,
        kind: q.kind,
        required: q.required,
        options: q.options,
        position,
      })),
    )
  }
```

El pipeline se omite si ya existe uno llamado "Agenda" **o** "Barbería" (misma lista de la Task 1,
paso 6).

Tests en `install.test.ts` (con el fake de ese archivo):
- `installAgendaTemplate({ …, presetKey: 'salud' })` crea los 3 servicios de salud, fija
  `labels.profesional = 'especialista'`, `preset_key = 'salud'` y una pregunta.
- Volver a instalar con otro preset no borra servicios existentes ni duplica preguntas.
- Si `bot_texts.welcome` ya existe, no se pisa.

- [ ] **Paso 6: Ruta de instalación.** En `setup/route.ts`: aceptar cuerpo opcional
  `{ preset_key }`, validar con `isPresetKey` (400 si no es válido), comprobar la cuenta con
  `isAgendaVerticalKey(account?.vertical_key)` y llamar
  `installAgendaTemplate({ db: supabaseAdmin(), accountId: ctx.accountId, userId: ctx.userId, presetKey })`.
  Cambiar `POST()` a `POST(request: Request)` y leer el cuerpo con `readJsonBody` (tolerar cuerpo
  vacío = `'barberia'` para no romper el botón actual). Agregar caso a `setup/route.test.ts`:
  `preset_key: 'tienda'` → 400.

- [ ] **Paso 7:** Run: `npx vitest run src/verticals/agenda src/app/api/verticals/agenda/setup` →
  Expected: PASS.
- [ ] **Paso 8: Commit**

```bash
git add src/verticals/agenda src/app/api/verticals/agenda/setup
git commit -m "feat(agenda): business-type starting points and installer"
```

---

### Task 12: Panel — 3 pestañas nuevas, palabras en la UI y asistente

**Archivos:**
- Crear: `src/app/(dashboard)/agenda/configuracion/_components/business-type-section.tsx`,
  `pieces-section.tsx`, `questions-section.tsx`, `src/app/(dashboard)/agenda/_components/setup-wizard.tsx`
- Modificar: `…/configuracion/page.tsx`, `…/_components/{types,api}.ts`, `src/app/(dashboard)/agenda/page.tsx`,
  `src/verticals/agenda/texts.ts` (`AGENDA_TEXTS`: copy de las pestañas nuevas; quitar "barbero(s)"
  fijo)

- [ ] **Paso 1: Leer** `src/app/(dashboard)/agenda/configuracion/_components/bot-section.tsx` completo
  para copiar el patrón de guardado (`saving`, `error`, `saved`, `reload`).

- [ ] **Paso 2: Tipos y API del cliente.** En `types.ts`:

```ts
import type { AgendaLabels } from '@/verticals/agenda/labels'
import type { AgendaToggles } from '@/verticals/agenda/toggles'
import type { AgendaQuestion } from '@/verticals/agenda/questions'

export interface SettingsRow {
  address: string | null
  reminders_2h_enabled: boolean
  bot_texts: Record<string, string>
  labels: AgendaLabels
  toggles: AgendaToggles
  preset_key: string | null
}

export type QuestionRow = AgendaQuestion
```

`EMPTY_SETTINGS` con `labels: DEFAULT_LABELS, toggles: DEFAULT_TOGGLES, preset_key: null`.

En `api.ts`: ampliar `ConfigPatchBody` con `labels?: AgendaLabels`,
`toggles?: Record<string, boolean>` y `preset_key?: string`, y agregar:

```ts
  createQuestion: (body: { label: string; kind: string; required: boolean; options: string[] }) =>
    request<{ question: AgendaQuestion }>('/api/verticals/agenda/questions', 'POST', body),
  updateQuestion: (id: string, body: { label: string; kind: string; required: boolean; options: string[] }) =>
    request<{ question: AgendaQuestion }>(`/api/verticals/agenda/questions/${id}`, 'PATCH', body),
  deleteQuestion: (id: string) =>
    request<{ ok: true }>(`/api/verticals/agenda/questions/${id}`, 'DELETE'),
  installPreset: (presetKey: string) =>
    request<{ report: unknown }>('/api/verticals/agenda/setup', 'POST', { preset_key: presetKey }),
```

- [ ] **Paso 3: Carga en `page.tsx`.** Ampliar el `select` de `booking_settings` a
  `'address, reminders_2h_enabled, bot_texts, labels, preset_key, choose_staff, show_price, show_duration, reminders_enabled, allow_reschedule'`,
  agregar la consulta `booking_questions` (`id, label, kind, required, options, position`,
  `is_active = true`, orden por `position`) al `Promise.all`, y armar el estado con
  `resolveLabels(sanitizeLabels(raw.labels).value)` y `togglesFromRow(raw)`. Agregar 3 pestañas:
  `type` ("Tipo de negocio"), `pieces` ("Piezas"), `questions` ("Preguntas"). Reemplazar el chequeo
  `account?.vertical_key === 'agenda'` por `isAgendaVerticalKey(account?.vertical_key)`.

- [ ] **Paso 4: `business-type-section.tsx`**

```tsx
'use client'

// ============================================================
// Pestaña "Tipo de negocio": punto de partida + palabras.
// Cambiar de punto de partida pide confirmación: agrega lo que falte
// y cambia palabras, piezas y bienvenida; no borra citas ni servicios.
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LABEL_KEYS, LABEL_MAX, type AgendaLabels } from '@/verticals/agenda/labels'
import { AGENDA_PRESETS, PRESET_KEYS, type PresetKey } from '@/verticals/agenda/presets'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { SettingsRow } from './types'

interface Props {
  settings: SettingsRow
  canEdit: boolean
  reload: () => Promise<void>
}

export function BusinessTypeSection({ settings, canEdit, reload }: Props) {
  const [labels, setLabels] = useState<AgendaLabels>(settings.labels)
  const [pending, setPending] = useState<PresetKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function applyPreset(key: PresetKey) {
    setBusy(true)
    setError(null)
    const res = await agendaConfigApi.installPreset(key)
    setBusy(false)
    setPending(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    await reload()
    setLabels(AGENDA_PRESETS[key].labels)
  }

  async function saveLabels() {
    setBusy(true)
    setError(null)
    setSaved(false)
    const res = await agendaConfigApi.patchConfig({ labels })
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setSaved(true)
    await reload()
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{T.config.type.title}</CardTitle>
          <CardDescription>{T.config.type.hint}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PRESET_KEYS.map((key) => {
            const preset = AGENDA_PRESETS[key]
            const active = settings.preset_key === key
            return (
              <button
                key={key}
                type="button"
                disabled={!canEdit || busy}
                onClick={() => setPending(key)}
                className={`rounded-lg border p-4 text-left transition-colors hover:border-primary disabled:opacity-50 ${active ? 'border-primary bg-primary/5' : 'border-border'}`}
              >
                <p className="font-medium text-foreground">{preset.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{preset.description}</p>
                {active && <p className="mt-2 text-xs font-medium text-primary">{T.config.type.current}</p>}
              </button>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{T.config.type.wordsTitle}</CardTitle>
          <CardDescription>{T.config.type.wordsHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {LABEL_KEYS.map((key) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={`label-${key}`}>{T.config.type.words[key]}</Label>
                <Input
                  id={`label-${key}`}
                  value={labels[key]}
                  maxLength={LABEL_MAX}
                  disabled={!canEdit || busy}
                  onChange={(e) => setLabels({ ...labels, [key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {saved && !error && (
            <Alert>
              <AlertDescription>{T.config.saved}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end">
            <Button onClick={() => void saveLabels()} disabled={!canEdit || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {T.config.type.saveWords}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending ? T.config.type.confirmTitle(AGENDA_PRESETS[pending].name) : ''}</DialogTitle>
            <DialogDescription>{T.config.type.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
              {T.config.type.cancel}
            </Button>
            <Button onClick={() => pending && void applyPreset(pending)} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {T.config.type.apply}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

(Antes de usar `Dialog`, abrir `src/components/ui/dialog.tsx` y ajustar los nombres de los
subcomponentes si difieren; `agendaConfigApi` es el `barberiaConfigApi` renombrado en la Task 1.)

- [ ] **Paso 5: `pieces-section.tsx`**

```tsx
'use client'

// ============================================================
// Pestaña "Piezas": lo que el negocio usa o no. Cada interruptor
// se guarda al tocarlo (PATCH /api/verticals/agenda/config).
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { TOGGLE_COLUMNS, TOGGLE_KEYS, type AgendaToggleKey, type AgendaToggles } from '@/verticals/agenda/toggles'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { SettingsRow } from './types'

interface Props {
  settings: SettingsRow
  canEdit: boolean
  reload: () => Promise<void>
}

export function PiecesSection({ settings, canEdit, reload }: Props) {
  const [toggles, setToggles] = useState<AgendaToggles>(settings.toggles)
  const [saving, setSaving] = useState<AgendaToggleKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle(key: AgendaToggleKey, next: boolean) {
    setSaving(key)
    setError(null)
    setToggles({ ...toggles, [key]: next })
    const res = await agendaConfigApi.patchConfig({ toggles: { [TOGGLE_COLUMNS[key]]: next } })
    setSaving(null)
    if (!res.ok) {
      setToggles(toggles)
      setError(res.error)
      return
    }
    await reload()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.config.pieces.title}</CardTitle>
        <CardDescription>{T.config.pieces.hint}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {TOGGLE_KEYS.map((key) => (
          <div key={key} className="flex items-start justify-between gap-4 py-4">
            <div>
              <p className="font-medium text-foreground">{T.config.pieces.items[key].title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{T.config.pieces.items[key].hint}</p>
            </div>
            <div className="flex items-center gap-2">
              {saving === key && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              <Switch
                checked={toggles[key]}
                onCheckedChange={(next) => void toggle(key, next)}
                disabled={!canEdit || saving !== null}
              />
            </div>
          </div>
        ))}
        {error && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Paso 6: `questions-section.tsx`**

```tsx
'use client'

// ============================================================
// Pestaña "Preguntas": lo que el bot pregunta antes del resumen
// (dirección, placa, motivo…). Máximo MAX_QUESTIONS. Borrar
// desactiva (las citas guardan respuestas por id).
// ============================================================

import { useState } from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  MAX_QUESTIONS,
  QUESTION_KINDS,
  QUESTION_LABEL_MAX,
  validateQuestionCreate,
  type QuestionKind,
} from '@/verticals/agenda/questions'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { QuestionRow } from './types'

interface Props {
  questions: QuestionRow[]
  canEdit: boolean
  reload: () => Promise<void>
}

interface Draft {
  id: string | null
  label: string
  kind: QuestionKind
  required: boolean
  optionsText: string
}

const EMPTY_DRAFT: Draft = { id: null, label: '', kind: 'texto', required: true, optionsText: '' }

export function QuestionsSection({ questions, canEdit, reload }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function edit(q: QuestionRow) {
    setError(null)
    setDraft({ id: q.id, label: q.label, kind: q.kind, required: q.required, optionsText: q.options.join('\n') })
  }

  async function save() {
    const body = {
      label: draft.label,
      kind: draft.kind,
      required: draft.required,
      options: draft.kind === 'opcion' ? draft.optionsText.split('\n') : [],
    }
    const check = validateQuestionCreate(body)
    if (!check.ok) {
      setError(check.message)
      return
    }
    setBusy(true)
    setError(null)
    const res = draft.id
      ? await agendaConfigApi.updateQuestion(draft.id, check.value)
      : await agendaConfigApi.createQuestion(check.value)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setDraft(EMPTY_DRAFT)
    await reload()
  }

  async function remove(id: string) {
    setBusy(true)
    setError(null)
    const res = await agendaConfigApi.deleteQuestion(id)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (draft.id === id) setDraft(EMPTY_DRAFT)
    await reload()
  }

  const canAdd = draft.id !== null || questions.length < MAX_QUESTIONS

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{T.config.questions.title}</CardTitle>
          <CardDescription>{T.config.questions.hint}</CardDescription>
        </CardHeader>
        <CardContent>
          {questions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{T.config.questions.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {questions.map((q) => (
                <li key={q.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{q.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {T.config.questions.kinds[q.kind]} ·{' '}
                      {q.required ? T.config.questions.required : T.config.questions.optional}
                      {q.kind === 'opcion' && ` · ${q.options.join(', ')}`}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" aria-label={T.config.questions.edit} disabled={!canEdit || busy} onClick={() => edit(q)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={T.config.questions.remove} disabled={!canEdit || busy} onClick={() => void remove(q.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canAdd && (
        <Card>
          <CardHeader>
            <CardTitle>{draft.id ? T.config.questions.editTitle : T.config.questions.addTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="question-label">{T.config.questions.label}</Label>
              <Input
                id="question-label"
                value={draft.label}
                maxLength={QUESTION_LABEL_MAX}
                placeholder={T.config.questions.labelPlaceholder}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="question-kind">{T.config.questions.kind}</Label>
                <Select
                  value={draft.kind}
                  onValueChange={(value) => value && setDraft({ ...draft, kind: value as QuestionKind })}
                  disabled={!canEdit || busy}
                >
                  <SelectTrigger id="question-kind" className="w-full">
                    <SelectValue>{(value: string | null) => (value ? T.config.questions.kinds[value as QuestionKind] : '')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {QUESTION_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {T.config.questions.kinds[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3">
                <Label htmlFor="question-required">{T.config.questions.required}</Label>
                <Switch
                  id="question-required"
                  checked={draft.required}
                  onCheckedChange={(next) => setDraft({ ...draft, required: next })}
                  disabled={!canEdit || busy}
                />
              </div>
            </div>
            {draft.kind === 'opcion' && (
              <div className="space-y-2">
                <Label htmlFor="question-options">{T.config.questions.options}</Label>
                <Textarea
                  id="question-options"
                  rows={4}
                  value={draft.optionsText}
                  placeholder={T.config.questions.optionsPlaceholder}
                  disabled={!canEdit || busy}
                  onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}
                />
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              {draft.id && (
                <Button variant="outline" onClick={() => setDraft(EMPTY_DRAFT)} disabled={busy}>
                  {T.config.questions.cancel}
                </Button>
              )}
              <Button onClick={() => void save()} disabled={!canEdit || busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {T.config.questions.save}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

Copy para `AGENDA_TEXTS.config.questions`:

```ts
    questions: {
      title: 'Preguntas extra',
      hint: `El bot las hace después de elegir la hora y antes de confirmar. Máximo ${MAX_QUESTIONS}.`,
      empty: 'Sin preguntas extra: el bot pasa directo al resumen.',
      addTitle: 'Agregar pregunta',
      editTitle: 'Editar pregunta',
      label: 'Pregunta',
      labelPlaceholder: 'Ej.: ¿Cuál es la placa de tu carro?',
      kind: 'Tipo de respuesta',
      kinds: { texto: 'Texto libre', direccion: 'Dirección', numero: 'Número', opcion: 'Opciones' },
      required: 'Obligatoria',
      optional: 'Opcional',
      options: 'Opciones (una por línea)',
      optionsPlaceholder: 'Norte\nSur',
      save: 'Guardar pregunta',
      cancel: 'Cancelar',
      edit: 'Editar',
      remove: 'Quitar',
    },
```

(`MAX_QUESTIONS` se importa de `./questions` en `texts.ts`.)

- [ ] **Paso 6b: Respuestas en la agenda del día.** En `src/app/(dashboard)/agenda/page.tsx`:
  agregar `answers` al `select` de `booking_appointments` (línea ~215:
  `'id, starts_at, status, service_id, staff_id, contact_id, answers'`), cargar las preguntas
  activas de la cuenta junto con servicios y equipo, y agregar a `AgendaAppointment`
  `answers: { label: string; value: string }[]`, llenado así:

```ts
            answers: questions
              .filter((q) => typeof (row.answers as Record<string, string> | null)?.[q.id] === 'string')
              .map((q) => ({ label: q.label, value: (row.answers as Record<string, string>)[q.id] })),
```

  y en la tarjeta de la cita, debajo de la línea de profesional y cliente:

```tsx
                      {appointment.answers.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {appointment.answers.map((a) => `${a.label}: ${a.value}`).join(' · ')}
                        </p>
                      )}
```

- [ ] **Paso 7: Copy.** En `AGENDA_TEXTS.config` agregar `tabs.type`, `tabs.pieces`, `tabs.questions`
  y los bloques `type`, `pieces`, `questions` usados arriba:

```ts
    type: {
      title: 'Tipo de negocio',
      hint: 'Elige un punto de partida. Agrega servicios y horarios de ejemplo y ajusta las palabras; no borra nada de lo tuyo.',
      current: 'Actual',
      wordsTitle: 'Palabras de tu negocio',
      wordsHint: 'Así se nombran las cosas en el bot y en el panel.',
      words: {
        profesional: 'Quien atiende (singular)',
        profesionales: 'Quien atiende (plural)',
        servicio: 'Lo que se agenda (singular)',
        servicios: 'Lo que se agenda (plural)',
        cita: 'La reserva (singular)',
        citas: 'La reserva (plural)',
      },
      saveWords: 'Guardar palabras',
      confirmTitle: (name: string) => `¿Usar "${name}" como punto de partida?`,
      confirmBody:
        'Se agregan los servicios, el horario y las preguntas de ejemplo que falten, y se cambian las palabras, las piezas y la bienvenida. Tus citas, servicios y equipo actuales se quedan.',
      cancel: 'Cancelar',
      apply: 'Sí, usarlo',
    },
    pieces: {
      title: 'Piezas',
      hint: 'Prende solo lo que tu negocio usa. El bot salta los pasos apagados.',
      items: {
        chooseStaff: { title: 'Elegir quién atiende', hint: 'Apagado: el bot no pregunta "¿con quién?" y asigna a quien esté libre.' },
        showPrice: { title: 'Mostrar precios', hint: 'En el menú, el resumen y la confirmación.' },
        showDuration: { title: 'Mostrar duración', hint: 'En el menú de servicios.' },
        remindersEnabled: { title: 'Recordatorios', hint: 'Mensaje automático antes de la cita (24 h y, si la activas, 2 h).' },
        allowReschedule: { title: 'Reprogramar y cancelar', hint: 'Apagado: los cambios los atiende una persona por el chat.' },
      },
    },
```

Y reemplazar en `AGENDA_TEXTS` todos los "barbero/barberos/Barberos" fijos por textos neutros
("Equipo", "Quien atiende", "Sin asignar"). Donde la UI muestre la palabra del negocio (pestaña
"Equipo", título de la lista), usar `capitalize(settings.labels.profesionales)`.

```bash
grep -n "arber" src/verticals/agenda/texts.ts
```

Expected después del cambio: solo apariciones dentro de presets o comentarios.

- [ ] **Paso 8: Asistente en `/agenda`.** Cuando la plantilla no está instalada (la página ya tiene
  ese estado: `statusNotInstalled`), en lugar del botón único mostrar `SetupWizard`: tarjetas de
  `AGENDA_PRESETS` (mismo diseño que la sección de tipo de negocio) y al elegir una llamar
  `agendaConfigApi.installPreset(key)` y recargar; después mostrar el reporte de instalación
  existente y un botón "Ir a Configuración".

- [ ] **Paso 9: Ver en el navegador.** Arrancar `next dev` **con la cuenta smoke** (recordatorio:
  la base es producción; no crear citas reales). Revisar `/agenda/configuracion` (las 3 pestañas
  nuevas), `/barberia` → redirige a `/agenda`, y el asistente. Captura en escritorio y en celular.

- [ ] **Paso 10:** Run: `npm run typecheck && npm run lint && npm test` → Expected: sin errores.
- [ ] **Paso 11: Commit**

```bash
git add src/app/(dashboard)/agenda src/verticals/agenda/texts.ts
git commit -m "feat(agenda): business type, pieces and questions tabs plus setup wizard"
```

---

### Task 13: Documentación y cierre

**Archivos:**
- Mover/editar: `docs/barberia-configuracion.md` → `docs/agenda-configuracion.md`,
  `docs/barberia-recordatorios.md` → `docs/agenda-recordatorios.md`
- Modificar: `docs/onboarding-cliente.md` (si menciona barbería)

- [ ] **Paso 1:** `git mv` de los dos documentos y actualizar rutas (`/agenda`, `/api/verticals/agenda`).
- [ ] **Paso 2: Plantilla de Meta.** En `docs/agenda-recordatorios.md`, documentar el cuerpo genérico
  propuesto para `recordatorio_cita` (mismas 5 variables y mismos botones):

```
¡Hola! 👋 Te recordamos tu cita en {{1}}:

📌 {{2}}
👤 {{3}}
📅 {{4}}
🕐 {{5}}

¿Nos confirmas?
```

  y marcar como **paso manual del usuario**: editar la plantilla en WhatsApp Manager (Meta la vuelve
  a revisar). Hasta que se apruebe, las cuentas que no son barbería verán el 💈 de la versión vieja
  solo cuando el recordatorio salga por plantilla.
- [ ] **Paso 3: Verificación completa**

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: todo verde. (No correr `build` a la vez que `next dev`: ver project-env-gotchas.)

- [ ] **Paso 4: Commit**

```bash
git add docs
git commit -m "docs(agenda): rename vertical docs and generic reminder template"
```

- [ ] **Paso 5: Entrega al usuario (no push).** Resumir los commits, recordar el orden de despliegue
  (**primero el código** —acepta `barberia` y `agenda`—, **después** aplicar 051 en el SQL Editor
  dentro de una transacción, después correr `supabase/ci/verify-schema.sql`) y pedir OK para el push
  y el PR.

---

## Autorrevisión (contra el documento de diseño §4)

| Requisito del diseño | Tarea |
| --- | --- |
| 4.1 Barbería → Agenda, migración de cuentas, redirección | 1, 2 |
| 4.2 Puntos de partida (6) que solo llenan; confirmación al cambiar | 11, 12 |
| 4.3 Palabras editables usadas por bot y panel | 3, 5, 6, 12 |
| 4.4 Piezas: elegir profesional, precio, duración, recordatorios, reprogramar | 4, 6, 7, 8, 12 |
| 4.4 "Aprobar cada cita" | **Fase 2** (va con la aprobación por WhatsApp; no entra aquí) |
| 4.5 Preguntas extra (texto, dirección, número, opción) y respuestas en la cita y en el panel | 2, 9, 10, 12 (paso 6b) |
| 4.6 Configurar en 1 minuto (asistente) | 12 |
| Pruebas y RLS de tablas nuevas | 2, 8, 9, 10, 11 |

Siguientes planes (se escriben al terminar esta fase): Fase 2 (calendario interno, aprobación del
dueño por WhatsApp con la pieza "Aprobar cada cita", enlace .ics y "Agregar a mi calendario") y
Fase 3 (mockups y motion design).
