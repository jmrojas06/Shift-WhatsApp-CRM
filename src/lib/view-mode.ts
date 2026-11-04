/**
 * Vista sencilla: el local ve solo lo que usa a diario (bandeja, agenda
 * o ventas, contactos). Lo técnico —IA, flujos, automatizaciones,
 * difusiones, plantillas, WhatsApp, API— lo configura el equipo de
 * Shift, que entra a cada cuenta como miembro y ve todo.
 *
 * Es simplificación, no seguridad: los permisos siguen en los roles y en
 * RLS. Quién es de Shift lo dice SHIFT_STAFF_EMAILS (solo servidor).
 */

/** Pantallas que solo ve Shift. */
export const SHIFT_ONLY_ROUTES = ['/broadcasts', '/automations', '/flows', '/agents'] as const

/** Secciones de Configuración que solo ve Shift. */
export const SHIFT_ONLY_SETTINGS = ['whatsapp', 'templates', 'fields', 'deals', 'api'] as const

/**
 * El Embudo se oculta al local cuando la cuenta tiene un módulo (agenda o
 * ventas): ese módulo ya lo llena solo y verlo dos veces es trabajo extra.
 * Sin módulo (p. ej. una inmobiliaria) el Embudo es su herramienta.
 */
export const PIPELINES_ROUTE = '/pipelines'

export interface ViewContext {
  simple: boolean
  hasModules: boolean
}

function matches(route: string, pathname: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`)
}

/** ¿Esta pantalla se le esconde al local? */
export function isRouteHidden(pathname: string, ctx: ViewContext): boolean {
  if (!ctx.simple) return false
  if (SHIFT_ONLY_ROUTES.some((route) => matches(route, pathname))) return true
  return ctx.hasModules && matches(PIPELINES_ROUTE, pathname)
}

/** ¿Esta sección de Configuración se le esconde al local? */
export function isSettingsSectionHidden(section: string, simple: boolean): boolean {
  return simple && (SHIFT_ONLY_SETTINGS as readonly string[]).includes(section)
}

/** ¿El correo es del equipo de Shift? Lista separada por comas, sin distinguir mayúsculas. */
export function isShiftStaffEmail(
  email: string | null | undefined,
  list: string | undefined = process.env.SHIFT_STAFF_EMAILS,
): boolean {
  if (!email || !list) return false
  const wanted = email.trim().toLowerCase()
  return list
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .some((e) => e && e === wanted)
}
