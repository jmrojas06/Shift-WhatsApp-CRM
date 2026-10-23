import {
  AGENDA_VERTICAL_KEYS,
  type ModuleKey,
  type VerticalManifest,
  type VerticalNavItem,
} from './types'
import { agendaManifest } from '@/verticals/agenda/manifest'
import { ventasManifest } from '@/modules/ventas/manifest'

/**
 * Static manifest registry — the client-safe half of the vertical seam.
 *
 * This file is imported by client components (the sidebar renders the
 * account's vertical nav), so it must stay free of server dependencies:
 * no service-role client, no DB calls. The DB-aware dispatcher lives in
 * `./dispatch.ts`, which only the webhook imports.
 */
const MANIFESTS: Readonly<Record<ModuleKey, VerticalManifest>> = {
  agenda: agendaManifest,
  ventas: ventasManifest,
}

/** Orden estable de los módulos (menú y listados). */
const MODULE_ORDER: readonly ModuleKey[] = ['agenda', 'ventas']

/** Clave canónica para un `vertical_key` (alias incluidos) o null. */
export function normalizeVerticalKey(
  key: string | null | undefined,
): ModuleKey | null {
  if (!key) return null
  if ((AGENDA_VERTICAL_KEYS as readonly string[]).includes(key)) return 'agenda'
  return Object.hasOwn(MANIFESTS, key) ? (key as ModuleKey) : null
}

export function isAgendaVerticalKey(key: string | null | undefined): boolean {
  return normalizeVerticalKey(key) === 'agenda'
}

/**
 * Manifest for a `accounts.vertical_key` value. Unknown, empty, or
 * absent keys resolve to null — the account simply has no vertical.
 * The legacy 'barberia' key resolves to the agenda manifest.
 */
export function getVerticalManifest(
  key: string | null | undefined,
): VerticalManifest | null {
  const normalized = normalizeVerticalKey(key)
  return normalized ? MANIFESTS[normalized] : null
}

export function listVerticals(): VerticalManifest[] {
  return MODULE_ORDER.map((key) => MANIFESTS[key])
}

/**
 * Sidebar entries for the account's installed vertical. Empty when no
 * vertical is installed or the key is unknown — classic accounts render
 * no vertical nav at all.
 */
export function getVerticalNav(
  verticalKey: string | null | undefined,
): VerticalNavItem[] {
  const manifest = getVerticalManifest(verticalKey)
  return manifest?.nav ? [manifest.nav] : []
}

/** Lo que se necesita de una cuenta para saber qué módulos tiene. */
export interface AccountModulesSource {
  /** `accounts.modules` (migración 053). Ausente si la columna no existe aún. */
  modules?: readonly string[] | null
  /** `accounts.vertical_key` (047): respaldo mientras `modules` esté vacío. */
  vertical_key?: string | null
}

/**
 * Módulos activos de una cuenta, en claves canónicas: único lugar que
 * decide cuáles son.
 *
 * Lee `accounts.modules`; si viene vacío o ausente (cuenta sin migrar
 * por 053, o sin módulos), cae a `vertical_key` con su alias. Las
 * claves desconocidas se ignoran, sin duplicados y en orden estable
 * (agenda, ventas).
 */
export function getAccountModules(
  account: AccountModulesSource | null | undefined,
): ModuleKey[] {
  if (!account) return []
  const declared = Array.isArray(account.modules) ? account.modules : []
  const keys = declared.length > 0 ? declared : [account.vertical_key]
  const active = new Set<ModuleKey>()
  for (const key of keys) {
    const normalized = normalizeVerticalKey(key)
    if (normalized) active.add(normalized)
  }
  return MODULE_ORDER.filter((key) => active.has(key))
}

export function hasModule(
  account: AccountModulesSource | null | undefined,
  key: ModuleKey,
): boolean {
  return getAccountModules(account).includes(key)
}

/**
 * Entradas del menú lateral: una por módulo activo que tenga menú. Vacío
 * para cuentas clásicas sin módulos.
 */
export function getModulesNav(
  account: AccountModulesSource | null | undefined,
): VerticalNavItem[] {
  return getAccountModules(account).flatMap((key) => {
    const nav = MANIFESTS[key].nav
    return nav ? [nav] : []
  })
}
