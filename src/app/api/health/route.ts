import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// ============================================================
// GET /api/health — healthcheck público para monitores externos
// (UptimeRobot, cron-job.org, …) y para el healthcheck de Docker
// Compose.
//
// Devuelve SOLO estado genérico: `{ ok, checks: { env, db }, time }`.
// Nunca expone valores de entorno, URLs ni mensajes de error — un
// deployment mal configurado recibe "fail", no una pista.
//
//   env : las variables REQUIRED de .env.local.example existen.
//   db  : un round-trip barato a Supabase con service-role (SELECT
//         head), con timeout duro de 4 s.
//
// 200 si todo está ok; 503 si algo falla. Sin auth: es un endpoint
// de infraestructura.
// ============================================================

export const dynamic = 'force-dynamic'

/** Deben existir para que la app funcione (ver .env.local.example). */
const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_KEY',
  'META_APP_SECRET',
] as const

/** Duro a propósito: un monitor no debe quedarse colgado. */
const DB_PING_TIMEOUT_MS = 4_000

async function pingDatabase(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DB_PING_TIMEOUT_MS)
  try {
    const { error } = await createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .abortSignal(controller.signal)
    return !error
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  const envOk = REQUIRED_ENV_VARS.every((name) => Boolean(process.env[name]))
  const dbOk = envOk && (await pingDatabase())
  const ok = envOk && dbOk

  return NextResponse.json(
    {
      ok,
      checks: { env: envOk ? 'ok' : 'fail', db: dbOk ? 'ok' : 'fail' },
      time: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  )
}
