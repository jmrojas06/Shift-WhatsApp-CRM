import type { VerticalKey, VerticalManifest, VerticalNavItem } from './types'
import { barberiaManifest } from '@/verticals/barberia/manifest'

/**
 * Static manifest registry — the client-safe half of the vertical seam.
 *
 * This file is imported by client components (the sidebar renders the
 * account's vertical nav), so it must stay free of server dependencies:
 * no service-role client, no DB calls. The DB-aware dispatcher lives in
 * `./dispatch.ts`, which only the webhook imports.
 */
const MANIFESTS: Readonly<Partial<Record<VerticalKey, VerticalManifest>>> = {
  barberia: barberiaManifest,
}

/**
 * Manifest for a `accounts.vertical_key` value. Unknown, empty, or
 * absent keys resolve to null — the account simply has no vertical.
 */
export function getVerticalManifest(
  key: string | null | undefined,
): VerticalManifest | null {
  if (!key) return null
  return MANIFESTS[key as VerticalKey] ?? null
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
