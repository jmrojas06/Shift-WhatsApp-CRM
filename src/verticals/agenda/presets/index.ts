// Puntos de partida (tipo de negocio). La Task 11 completa este archivo.
export const PRESET_KEYS = ['barberia', 'salon', 'salud', 'taller', 'clases', 'blanco'] as const
export type PresetKey = (typeof PRESET_KEYS)[number]
export const isPresetKey = (value: unknown): value is PresetKey =>
  typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value)
