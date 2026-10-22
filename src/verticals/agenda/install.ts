// ============================================================
// Instalador de la plantilla de la agenda (punto de partida barbería).
//
// Deja lista una cuenta recién marcada como `vertical_key =
// 'agenda'` (o la clave anterior 'barberia'): catálogo de servicios, un barbero de ejemplo con su
// horario, etiquetas, campos personalizados, pipeline, respuestas
// rápidas y documentos para el agente de IA.
//
// Contrato de idempotencia — "crear o actualizar" sin pisar al dueño:
//   - Todo se crea si falta y se compara por nombre (case-insensitive)
//     dentro de la cuenta; reinstalar NUNCA duplica ni sobrescribe lo
//     que el dueño ya editó.
//   - El horario semanal solo se siembra si el barbero de ejemplo no
//     tiene ninguna fila de horario.
//   - `ai_configs.system_prompt` solo se escribe si está vacío; si ya
//     hay uno, se devuelve 'already_set' con advertencia.
//   - `accounts.default_currency` solo se ajusta (USD→COP) mientras
//     siga en el default de la migración 021 sin tocar; una moneda ya
//     elegida por el dueño nunca se pisa.
//
// El cliente de base de datos llega por inyección: la ruta server-only
// pasa el service-role (`supabaseAdmin()`); los tests, un fake en
// memoria. Todas las consultas van filtradas por `account_id`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkText } from '@/lib/ai/chunk'
import {
  AGENDA_AI_PROMPT,
  AGENDA_SEED,
  isAgendaPipelineName,
  type AiPromptOutcome,
  type AgendaInstallReport,
  type InstallSectionCounts,
} from './seed'

export interface InstallAgendaArgs {
  db: SupabaseClient
  /** Cuenta que instala — toda fila se amarra a ella. */
  accountId: string
  /** Quien hace clic en "Instalar": `created_by` / `user_id` de auditoría. */
  userId: string
}

type InsertRow = Record<string, unknown>

/**
 * Moneda con la que nace toda cuenta desde la migración 021. No es
 * una preferencia del dueño: es el valor por defecto SIN TOCAR, la
 * única señal fiable de que nadie ha elegido moneda todavía.
 */
const UNTOUCHED_DEFAULT_CURRENCY = 'USD'

/** Moneda que la plantilla fija para una barbería en Colombia. */
const AGENDA_CURRENCY = 'COP'

interface IdNameRow {
  id: string
  name: string
}

interface IdTitleRow {
  id: string
  title: string
}

const counts = (): InstallSectionCounts => ({ created: 0, skipped: 0 })

/** Lista las filas de una tabla para UNA cuenta. Nunca toca otra. */
async function selectRows<T>(
  db: SupabaseClient,
  table: string,
  cols: string,
  accountId: string,
): Promise<T[]> {
  const { data, error } = await db
    .from(table)
    .select(cols)
    .eq('account_id', accountId)
  if (error) throw error
  return (data ?? []) as T[]
}

async function insertRows(
  db: SupabaseClient,
  table: string,
  rows: InsertRow[],
): Promise<void> {
  if (rows.length === 0) return
  const { error } = await db.from(table).insert(rows)
  if (error) throw error
}

export async function installAgendaTemplate(
  args: InstallAgendaArgs,
): Promise<AgendaInstallReport> {
  const { db, accountId, userId } = args

  const report: AgendaInstallReport = {
    currency: 'kept',
    services: counts(),
    staff: counts(),
    staffServices: counts(),
    workingHours: counts(),
    tags: counts(),
    customFields: counts(),
    pipeline: { created: false, stagesCreated: 0 },
    quickReplies: counts(),
    knowledge: counts(),
    aiPrompt: 'no_config' as AiPromptOutcome,
    warnings: [],
  }

  // ----------------------------------------------------------
  // 0. Moneda por defecto (regla de la plantilla)
  //
  // Una barbería colombiana cobra en COP, pero la cuenta nace en el
  // default de la migración 021 ('USD') sin que el dueño lo haya
  // elegido. La instalación la ajusta SOLO mientras la columna siga
  // en ese default intacto; si ya hay una moneda elegida (COP
  // incluido) no se toca nada. Idempotente por construcción: tras
  // la primera instalación el valor ya no es el default.
  // ----------------------------------------------------------
  const { data: accountRow, error: accountError } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle()
  if (accountError) throw accountError

  const currentCurrency =
    (accountRow as { default_currency?: string | null } | null)
      ?.default_currency ?? UNTOUCHED_DEFAULT_CURRENCY
  if (currentCurrency === UNTOUCHED_DEFAULT_CURRENCY) {
    const { error } = await db
      .from('accounts')
      .update({ default_currency: AGENDA_CURRENCY })
      .eq('id', accountId)
    if (error) throw error
    report.currency = 'set_cop'
  }

  // ----------------------------------------------------------
  // 1. Servicios del catálogo
  // ----------------------------------------------------------
  const existingServices = new Map<string, string>()
  for (const row of await selectRows<IdNameRow>(
    db,
    'booking_services',
    'id, name',
    accountId,
  )) {
    existingServices.set(row.name.toLowerCase(), row.id)
  }

  const serviceIdByName = new Map<string, string>()
  const newServices: InsertRow[] = []
  for (const seed of AGENDA_SEED.services) {
    const existingId = existingServices.get(seed.name.toLowerCase())
    if (existingId) {
      serviceIdByName.set(seed.name, existingId)
      report.services.skipped += 1
      continue
    }
    const id = crypto.randomUUID()
    serviceIdByName.set(seed.name, id)
    newServices.push({
      id,
      account_id: accountId,
      created_by: userId,
      name: seed.name,
      description: seed.description,
      duration_minutes: seed.durationMinutes,
      price: seed.price,
      position: seed.position,
      is_active: true,
    })
    report.services.created += 1
  }
  await insertRows(db, 'booking_services', newServices)

  // ----------------------------------------------------------
  // 2. Barbero de ejemplo
  // ----------------------------------------------------------
  const existingStaff = new Map<string, string>()
  for (const row of await selectRows<IdNameRow>(
    db,
    'booking_staff',
    'id, name',
    accountId,
  )) {
    existingStaff.set(row.name.toLowerCase(), row.id)
  }

  const staffIdByName = new Map<string, string>()
  const newStaff: InsertRow[] = []
  for (const seed of AGENDA_SEED.staff) {
    const existingId = existingStaff.get(seed.name.toLowerCase())
    if (existingId) {
      staffIdByName.set(seed.name, existingId)
      report.staff.skipped += 1
      continue
    }
    const id = crypto.randomUUID()
    staffIdByName.set(seed.name, id)
    newStaff.push({
      id,
      account_id: accountId,
      created_by: userId,
      name: seed.name,
      bio: seed.bio,
      position: seed.position,
      is_active: true,
    })
    report.staff.created += 1
  }
  await insertRows(db, 'booking_staff', newStaff)

  const exampleStaffId =
    staffIdByName.get(AGENDA_SEED.staff[0].name) ??
    existingStaff.get(AGENDA_SEED.staff[0].name.toLowerCase()) ??
    null

  // ----------------------------------------------------------
  // 3. Relación barbero ↔ servicios (todos los del catálogo seed)
  // ----------------------------------------------------------
  const existingPairs = new Set<string>()
  for (const row of await selectRows<{ staff_id: string; service_id: string }>(
    db,
    'booking_staff_services',
    'staff_id, service_id',
    accountId,
  )) {
    existingPairs.add(`${row.staff_id}:${row.service_id}`)
  }

  const newPairs: InsertRow[] = []
  if (exampleStaffId) {
    for (const seed of AGENDA_SEED.services) {
      const serviceId = serviceIdByName.get(seed.name)
      if (!serviceId) continue
      if (existingPairs.has(`${exampleStaffId}:${serviceId}`)) {
        report.staffServices.skipped += 1
        continue
      }
      newPairs.push({
        account_id: accountId,
        staff_id: exampleStaffId,
        service_id: serviceId,
      })
      report.staffServices.created += 1
    }
  }
  await insertRows(db, 'booking_staff_services', newPairs)

  // ----------------------------------------------------------
  // 4. Horario semanal (solo si el barbero no tiene NINGUNA fila)
  // ----------------------------------------------------------
  const hourRows = await selectRows<{ id: string; staff_id: string }>(
    db,
    'booking_working_hours',
    'id, staff_id',
    accountId,
  )
  const exampleStaffHours = hourRows.filter(
    (row) => row.staff_id === exampleStaffId,
  )
  if (exampleStaffHours.length > 0) {
    report.workingHours.skipped = AGENDA_SEED.weeklySchedule.length
  } else if (exampleStaffId) {
    await insertRows(
      db,
      'booking_working_hours',
      AGENDA_SEED.weeklySchedule.map((hour) => ({
        account_id: accountId,
        staff_id: exampleStaffId,
        weekday: hour.weekday,
        start_time: hour.startTime,
        end_time: hour.endTime,
      })),
    )
    report.workingHours.created = AGENDA_SEED.weeklySchedule.length
  }

  // ----------------------------------------------------------
  // 5. Etiquetas de conversación
  // ----------------------------------------------------------
  const existingTags = new Set(
    (
      await selectRows<IdNameRow>(db, 'tags', 'id, name', accountId)
    ).map((row) => row.name.toLowerCase()),
  )
  const newTags: InsertRow[] = []
  for (const seed of AGENDA_SEED.tags) {
    if (existingTags.has(seed.name.toLowerCase())) {
      report.tags.skipped += 1
      continue
    }
    newTags.push({
      account_id: accountId,
      user_id: userId,
      name: seed.name,
      color: seed.color,
    })
    report.tags.created += 1
  }
  await insertRows(db, 'tags', newTags)

  // ----------------------------------------------------------
  // 6. Campos personalizados de contacto
  // ----------------------------------------------------------
  const existingFields = new Set(
    (
      await selectRows<{ id: string; field_name: string }>(
        db,
        'custom_fields',
        'id, field_name',
        accountId,
      )
    ).map((row) => row.field_name.toLowerCase()),
  )
  const newFields: InsertRow[] = []
  for (const name of AGENDA_SEED.customFields) {
    if (existingFields.has(name.toLowerCase())) {
      report.customFields.skipped += 1
      continue
    }
    newFields.push({
      account_id: accountId,
      user_id: userId,
      field_name: name,
      field_type: 'text',
    })
    report.customFields.created += 1
  }
  await insertRows(db, 'custom_fields', newFields)

  // ----------------------------------------------------------
  // 7. Pipeline de la agenda ("Agenda" o el anterior "Barbería") con sus etapas
  // ----------------------------------------------------------
  const pipelineRows = await selectRows<IdNameRow>(
    db,
    'pipelines',
    'id, name',
    accountId,
  )
  const existingPipeline = pipelineRows.find((row) =>
    isAgendaPipelineName(row.name),
  )
  if (existingPipeline) {
    // Ya existe: sus etapas son del dueño, no las tocamos.
    report.pipeline = { created: false, stagesCreated: 0 }
  } else {
    const pipelineId = crypto.randomUUID()
    await insertRows(db, 'pipelines', [
      {
        id: pipelineId,
        account_id: accountId,
        user_id: userId,
        name: AGENDA_SEED.pipeline.name,
      },
    ])
    const stageRows = AGENDA_SEED.pipeline.stages.map((stage, index) => ({
      id: crypto.randomUUID(),
      pipeline_id: pipelineId,
      name: stage.name,
      position: index,
      color: stage.color,
    }))
    await insertRows(db, 'pipeline_stages', stageRows)
    report.pipeline = { created: true, stagesCreated: stageRows.length }
  }

  // ----------------------------------------------------------
  // 8. Respuestas rápidas
  // ----------------------------------------------------------
  const existingQuickReplies = new Set(
    (
      await selectRows<IdTitleRow>(db, 'quick_replies', 'id, title', accountId)
    ).map((row) => row.title.toLowerCase()),
  )
  const newQuickReplies: InsertRow[] = []
  for (const seed of AGENDA_SEED.quickReplies) {
    if (existingQuickReplies.has(seed.title.toLowerCase())) {
      report.quickReplies.skipped += 1
      continue
    }
    newQuickReplies.push({
      account_id: accountId,
      user_id: userId,
      title: seed.title,
      kind: 'text',
      content_text: seed.content,
    })
    report.quickReplies.created += 1
  }
  await insertRows(db, 'quick_replies', newQuickReplies)

  // ----------------------------------------------------------
  // 9. Documentos de la base de conocimiento
  //
  // Se trocean con el chunker puro y se insertan SIN embeddings: la
  // búsqueda léxica ya funciona; al re-guardar el documento desde la
  // UI, `ingestDocument` regenera los fragmentos y genera los
  // embeddings semánticos. Así instalar no depende de la API del
  // proveedor de IA (ni de que exista una clave configurada).
  // ----------------------------------------------------------
  const existingDocs = new Set(
    (
      await selectRows<IdTitleRow>(
        db,
        'ai_knowledge_documents',
        'id, title',
        accountId,
      )
    ).map((row) => row.title.toLowerCase()),
  )
  for (const doc of AGENDA_SEED.knowledgeDocs) {
    if (existingDocs.has(doc.title.toLowerCase())) {
      report.knowledge.skipped += 1
      continue
    }
    const docId = crypto.randomUUID()
    await insertRows(db, 'ai_knowledge_documents', [
      {
        id: docId,
        account_id: accountId,
        created_by: userId,
        title: doc.title,
        content: doc.content,
      },
    ])
    report.knowledge.created += 1
    try {
      const chunks = chunkText(doc.content)
      await insertRows(
        db,
        'ai_knowledge_chunks',
        chunks.map((content, index) => ({
          document_id: docId,
          account_id: accountId,
          chunk_index: index,
          content,
          embedding: null,
        })),
      )
    } catch (err) {
      console.error(
        `[agenda install] no se pudo indexar "${doc.title}":`,
        err,
      )
      report.warnings.push(
        `No se pudieron indexar los fragmentos de "${doc.title}"; edítalo y guárdalo de nuevo para reintentar.`,
      )
    }
  }

  // ----------------------------------------------------------
  // 10. Prompt del agente de IA — solo si está vacío
  // ----------------------------------------------------------
  const { data: aiRow, error: aiError } = await db
    .from('ai_configs')
    .select('id, system_prompt')
    .eq('account_id', accountId)
    .maybeSingle()
  if (aiError) throw aiError

  if (!aiRow) {
    report.aiPrompt = 'no_config'
    report.warnings.push(
      'El agente de IA todavía no está configurado. Cuando lo configures, copia el prompt sugerido para que hable como tu barbería.',
    )
  } else if (String(aiRow.system_prompt ?? '').trim() === '') {
    const { error } = await db
      .from('ai_configs')
      .update({ system_prompt: AGENDA_AI_PROMPT })
      .eq('account_id', accountId)
    if (error) throw error
    report.aiPrompt = 'written'
  } else {
    report.aiPrompt = 'already_set'
    report.warnings.push(
      'El prompt del agente de IA ya estaba configurado; no se modificó.',
    )
  }

  return report
}
