// ============================================================
// Instalador de la plantilla de la agenda según un punto de partida
// (barbería, salón, salud, taller, clases o en blanco).
//
// Deja lista una cuenta recién marcada como `vertical_key =
// 'agenda'` (o la clave anterior 'barberia'): catálogo de servicios, un
// profesional de ejemplo con su horario, etiquetas, campos
// personalizados, pipeline, respuestas rápidas, documentos para el
// agente de IA, y las palabras, piezas, bienvenida y preguntas extra
// del punto de partida.
//
// Contrato de idempotencia — "crear o actualizar" sin pisar al dueño:
//   - Todo se crea si falta y se compara por nombre (case-insensitive)
//     dentro de la cuenta; reinstalar NUNCA duplica ni sobrescribe lo
//     que el dueño ya editó.
//   - El horario semanal solo se siembra si el profesional de ejemplo
//     no tiene ninguna fila de horario.
//   - `ai_configs.system_prompt` solo se escribe si está vacío; si ya
//     hay uno, se devuelve 'already_set' con advertencia.
//   - Reaplicar el MISMO punto de partida a una cuenta que ya tiene
//     catálogo o equipo no siembra servicios, equipo, relaciones,
//     horario ni preguntas (el dueño pudo renombrar o borrar los de
//     ejemplo); solo rellena etiquetas, pipeline, respuestas rápidas y
//     documentos que falten.
//   - Las preguntas extra del punto de partida se agregan solo si no
//     existe ya una con la misma etiqueta (activa o no).
//   - Palabras y piezas de presentación (labels y choose_staff,
//     show_price, show_duration) se fijan solo cuando el punto de partida
//     cambia; recordatorios y reprogramación nunca se tocan. La
//     bienvenida solo se fija si el dueño no escribió una propia (una
//     que es la de algún punto de partida cuenta como no escrita).
//   - Nunca se borra nada.
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
import { AGENDA_PRESETS, getPreset, isPresetKey, type PresetKey } from './presets'
import { MAX_QUESTIONS } from './questions'
import {
  isAgendaPipelineName,
  type AiPromptOutcome,
  type AgendaInstallReport,
  type InstallSectionCounts,
} from './seed'
import { buildAgentTexts } from './texts'
import { togglesToRow } from './toggles'

export interface InstallAgendaArgs {
  db: SupabaseClient
  /** Cuenta que instala — toda fila se amarra a ella. */
  accountId: string
  /** Quien hace clic en "Instalar": `created_by` / `user_id` de auditoría. */
  userId: string
  /** Punto de partida; por defecto el de la cuenta (si es válido) o 'barberia'. */
  presetKey?: PresetKey
}

/** Punto de partida cuando la cuenta no tiene uno válido ni se pide uno. */
const DEFAULT_PRESET_KEY: PresetKey = 'barberia'

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

  // Punto de partida actual de la cuenta: es el valor por defecto y decide
  // si esto es una reaplicación. Si la lectura falla, se aborta antes de
  // escribir nada.
  const { data: settingsRow, error: settingsReadError } = await db
    .from('booking_settings')
    .select('preset_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (settingsReadError) throw settingsReadError
  const currentPresetKey = (settingsRow as { preset_key?: string | null } | null)?.preset_key ?? null

  const preset = getPreset(
    args.presetKey ?? (isPresetKey(currentPresetKey) ? currentPresetKey : DEFAULT_PRESET_KEY),
  )
  const template = preset.seed

  const report: AgendaInstallReport = {
    presetKey: preset.key,
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
    questions: counts(),
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
  const existingStaff = new Map<string, string>()
  for (const row of await selectRows<IdNameRow>(
    db,
    'booking_staff',
    'id, name',
    accountId,
  )) {
    existingStaff.set(row.name.toLowerCase(), row.id)
  }

  // Volver a aplicar EL MISMO punto de partida a una cuenta que ya tiene
  // catálogo o equipo no vuelve a sembrar servicios, equipo, relaciones,
  // horario ni preguntas: el dueño pudo renombrar o borrar los de ejemplo y
  // se recrearían. (Una cuenta con el punto de partida marcado pero sin nada
  // —p. ej. barbería migrada que nunca instaló— sí se siembra.)
  const reapply = currentPresetKey === preset.key && (existingServices.size > 0 || existingStaff.size > 0)

  const serviceIdByName = new Map<string, string>()
  const newServices: InsertRow[] = []
  for (const seed of reapply ? [] : template.services) {
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
  if (reapply) report.services.skipped = template.services.length
  await insertRows(db, 'booking_services', newServices)

  // ----------------------------------------------------------
  // 2. Barbero de ejemplo
  // ----------------------------------------------------------
  const staffIdByName = new Map<string, string>()
  const newStaff: InsertRow[] = []
  for (const seed of reapply ? [] : template.staff) {
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
  if (reapply) report.staff.skipped = template.staff.length
  await insertRows(db, 'booking_staff', newStaff)

  // "En blanco" no trae profesional de ejemplo: sin él no hay relaciones ni horario.
  const exampleSeedStaff = template.staff[0]
  const exampleStaffId = exampleSeedStaff && !reapply
    ? (staffIdByName.get(exampleSeedStaff.name) ??
      existingStaff.get(exampleSeedStaff.name.toLowerCase()) ??
      null)
    : null

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
  if (reapply) {
    report.staffServices.skipped = template.staff.length > 0 ? template.services.length : 0
  } else if (exampleStaffId) {
    for (const seed of template.services) {
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
  if (reapply || exampleStaffHours.length > 0) {
    report.workingHours.skipped = template.weeklySchedule.length
  } else if (exampleStaffId) {
    await insertRows(
      db,
      'booking_working_hours',
      template.weeklySchedule.map((hour) => ({
        account_id: accountId,
        staff_id: exampleStaffId,
        weekday: hour.weekday,
        start_time: hour.startTime,
        end_time: hour.endTime,
      })),
    )
    report.workingHours.created = template.weeklySchedule.length
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
  for (const seed of template.tags) {
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
  for (const name of template.customFields) {
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
  const stageRowsFor = (pipelineId: string): InsertRow[] =>
    template.pipeline.stages.map((stage, index) => ({
      id: crypto.randomUUID(),
      pipeline_id: pipelineId,
      name: stage.name,
      position: index,
      color: stage.color,
    }))
  if (existingPipeline) {
    // Ya existe: sus etapas son del dueño, no las tocamos. Solo si quedó
    // sin ninguna (una instalación anterior se cortó entre el pipeline y sus
    // etapas) se siembran, porque el bot necesita "Cita agendada".
    const { data: stages, error: stagesError } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('pipeline_id', existingPipeline.id)
    if (stagesError) throw stagesError
    if (((stages ?? []) as { id: string }[]).length === 0) {
      const stageRows = stageRowsFor(existingPipeline.id)
      await insertRows(db, 'pipeline_stages', stageRows)
      report.pipeline = { created: false, stagesCreated: stageRows.length }
    } else {
      report.pipeline = { created: false, stagesCreated: 0 }
    }
  } else {
    const pipelineId = crypto.randomUUID()
    await insertRows(db, 'pipelines', [
      {
        id: pipelineId,
        account_id: accountId,
        user_id: userId,
        name: template.pipeline.name,
      },
    ])
    const stageRows = stageRowsFor(pipelineId)
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
  for (const seed of template.quickReplies) {
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
  for (const doc of template.knowledgeDocs) {
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
      'El agente de IA todavía no está configurado. Cuando lo configures, copia el prompt sugerido para que hable como tu negocio.',
    )
  } else if (String(aiRow.system_prompt ?? '').trim() === '') {
    const { error } = await db
      .from('ai_configs')
      .update({ system_prompt: preset.aiPrompt })
      .eq('account_id', accountId)
    if (error) throw error
    report.aiPrompt = 'written'
  } else {
    report.aiPrompt = 'already_set'
    report.warnings.push(
      'El prompt del agente de IA ya estaba configurado; no se modificó.',
    )
  }

  // ----------------------------------------------------------
  // 11. Preguntas extra del bot
  //
  // Se agrega cada pregunta del punto de partida que la cuenta no tenga
  // ya (misma etiqueta sin importar mayúsculas, activa o no), sin pasar
  // del tope de preguntas activas. Reaplicar el mismo punto de partida
  // no vuelve a sembrarlas: el dueño pudo quitar o renombrar las suyas.
  // ----------------------------------------------------------
  if (reapply) {
    report.questions.skipped = preset.questions.length
  } else if (preset.questions.length > 0) {
    const { data: questionRows, error: questionsError } = await db
      .from('booking_questions')
      .select('label, is_active, position')
      .eq('account_id', accountId)
    if (questionsError) throw questionsError
    const existingQuestions = (questionRows ?? []) as {
      label: string
      is_active: boolean | null
      position: number | null
    }[]
    const knownLabels = new Set(existingQuestions.map((q) => String(q.label).trim().toLowerCase()))
    let activeCount = existingQuestions.filter((q) => q.is_active !== false).length
    let nextPosition = existingQuestions.reduce((max, q) => Math.max(max, (q.position ?? -1) + 1), 0)

    const newQuestions: InsertRow[] = []
    for (const q of preset.questions) {
      if (knownLabels.has(q.label.trim().toLowerCase()) || activeCount >= MAX_QUESTIONS) {
        report.questions.skipped += 1
        continue
      }
      newQuestions.push({
        account_id: accountId,
        label: q.label,
        kind: q.kind,
        required: q.required,
        options: q.options,
        position: nextPosition,
        is_active: true,
      })
      knownLabels.add(q.label.trim().toLowerCase())
      activeCount += 1
      nextPosition += 1
    }
    await insertRows(db, 'booking_questions', newQuestions)
    report.questions.created = newQuestions.length
  }

  // ----------------------------------------------------------
  // 12. Punto de partida: palabras, piezas y bienvenida
  //
  // Palabras y piezas solo se fijan cuando el punto de partida cambia
  // (la cuenta no tenía uno, o era otro): así reinstalar el mismo no
  // pisa lo que el dueño ajustó después. De las piezas solo se escriben
  // las de presentación (elegir profesional, precio, duración): los
  // recordatorios y la reprogramación son decisión del dueño.
  //
  // La bienvenida solo se fija si el dueño no escribió una propia; una
  // que es la de algún punto de partida (la dejó un asistente anterior)
  // no cuenta como propia. Si la del punto de partida es la que el bot ya
  // usa por defecto, no se guarda como override (y se quita la anterior).
  //
  // Los textos se vuelven a leer justo antes de escribir, para no perder
  // una bienvenida que el dueño guardó mientras corría la instalación.
  // ----------------------------------------------------------
  const { data: freshRow, error: freshError } = await db
    .from('booking_settings')
    .select('bot_texts')
    .eq('account_id', accountId)
    .maybeSingle()
  if (freshError) throw freshError
  const botTexts: Record<string, unknown> = {
    ...((freshRow as { bot_texts?: Record<string, unknown> | null } | null)?.bot_texts ?? {}),
  }
  const currentWelcome = typeof botTexts.welcome === 'string' ? botTexts.welcome.trim() : ''
  const presetWelcomes = new Set(Object.values(AGENDA_PRESETS).map((p) => p.welcome))
  const ownerWroteWelcome = currentWelcome !== '' && !presetWelcomes.has(currentWelcome)
  if (!ownerWroteWelcome) {
    if (preset.welcome === buildAgentTexts(preset.labels).serviceMenuBody) delete botTexts.welcome
    else botTexts.welcome = preset.welcome
  }

  const settingsPatch: Record<string, unknown> = {
    account_id: accountId,
    preset_key: preset.key,
    bot_texts: botTexts,
  }
  if (currentPresetKey !== preset.key) {
    settingsPatch.labels = preset.labels
    const { choose_staff, show_price, show_duration } = togglesToRow(preset.toggles)
    Object.assign(settingsPatch, { choose_staff, show_price, show_duration })
  }
  const { error: settingsError } = await db
    .from('booking_settings')
    .upsert(settingsPatch, { onConflict: 'account_id' })
  if (settingsError) throw settingsError

  return report
}
