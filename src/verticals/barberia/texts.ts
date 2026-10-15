// ============================================================
// Textos de la superficie de barbería — español colombiano.
//
// Por decisión de producto, el vertical NO entra a los catálogos
// i18n del CRM (messages/*.json): su superficie es solo es-CO y su
// copy vive aquí, junto al manifest y las semillas.
// ============================================================

export const BARBERIA_TEXTS = {
  title: 'Barbería',
  subtitle: 'Tu plantilla de barbería: servicios, barberos y horarios.',
  loading: 'Cargando…',
  notEnabledTitle: 'Módulo no habilitado',
  notEnabledBody:
    'El módulo de barbería no está activo para esta cuenta. Pídele a tu asesor de Shift Digital que lo active.',
  loadError:
    'No se pudo cargar la información. Recarga la página e inténtalo de nuevo.',

  statusTitle: 'Estado de la plantilla',
  statusInstalled: 'Instalada',
  statusNotInstalled: 'Sin instalar',
  statusInstalledBody:
    'La plantilla está instalada. Reinstalar es seguro: no duplica ni sobrescribe lo que ya editaste.',
  statusNotInstalledBody:
    'Instala la plantilla para crear servicios de ejemplo, un barbero con horario, etiquetas, pipeline, respuestas rápidas y documentos para tu agente de IA.',
  installButton: 'Instalar plantilla de barbería',
  reinstallButton: 'Reinstalar plantilla',
  installing: 'Instalando…',
  gateReason: 'instalar la plantilla',
  installFailed: 'No se pudo completar la instalación. Inténtalo de nuevo.',

  reportTitle: 'Resultado de la instalación',
  createdLabel: 'creados',
  skippedLabel: 'ya existían',
  pipelineCreated: (stages: number) =>
    `Pipeline "Barbería" creado con ${stages} etapas`,
  pipelineSkipped: 'El pipeline "Barbería" ya existía',
  aiPromptWritten: 'Prompt creado (estaba vacío)',
  aiPromptAlreadySet: 'Prompt ya configurado; no se modificó',
  aiPromptNoConfig: 'Aún sin configurar',
  promptSuggestionTitle: 'Prompt sugerido para tu agente de IA',
  promptSuggestionHint:
    'Cópialo en Agentes de IA cuando conectes tu proveedor; no sobrescribimos nada.',

  servicesTitle: 'Servicios',
  servicesEmpty: 'Aún no hay servicios. Instala la plantilla o créalos a tu medida.',
  staffTitle: 'Barberos',
  staffEmpty: 'Aún no hay barberos en el equipo.',
  inactiveLabel: 'Inactivo',
  servicesCount: (n: number) => (n === 1 ? '1 servicio' : `${n} servicios`),
  staffCount: (n: number) => (n === 1 ? '1 barbero' : `${n} barberos`),
  minutes: (n: number) => `${n} min`,

  sections: {
    services: 'Servicios',
    staff: 'Barberos',
    staffServices: 'Barbero–servicios',
    workingHours: 'Bloques de horario',
    tags: 'Etiquetas',
    customFields: 'Campos personalizados',
    quickReplies: 'Respuestas rápidas',
    knowledge: 'Documentos de conocimiento',
    aiAgent: 'Agente de IA',
    pipeline: 'Pipeline',
  },
} as const
