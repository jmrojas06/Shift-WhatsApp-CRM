import {
  AGENDA_VERTICAL_KEYS,
  type VerticalKey,
  type VerticalManifest,
  type VerticalNavItem,
} from './types'
import { agendaManifest } from '@/verticals/agenda/manifest'

/**
 * Static manifest registry — the client-safe half of the vertical seam.
 *
 * This file is imported by client components (the sidebar renders the
 * account's vertical nav), so it must stay free of server dependencies:
 * no service-role client, no DB calls. The DB-aware dispatcher lives in
 * `./dispatch.ts`, which only the webhook imports.
 */
const MANIFESTS: Readonly<Partial<Record<VerticalKey, VerticalManifest>>> = {
  agenda: agendaManifest,
}

/** Clave canónica para un `vertical_key` (alias incluidos) o null. */
export function normalizeVerticalKey(
  key: string | null | undefined,
): VerticalKey | null {
  if (!key) return null
  if ((AGENDA_VERTICAL_KEYS as readonly string[]).includes(key)) return 'agenda'
  return key in MANIFESTS ? (key as VerticalKey) : null
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
  return normalized ? (MANIFESTS[normalized] ?? null) : null
}

export function listVerticals(): VerticalManifest[] {
  return Object.values(MANIFESTS).filter(
    (manifest): manifest is VerticalManifest => Boolean(manifest),
  )
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
