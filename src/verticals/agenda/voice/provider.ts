// ============================================================
// El proveedor de voz de producción, armado con las variables de entorno.
//
// Lo usan el cron y las rutas que piden llamadas. Si falta alguna variable
// (Telnyx, el secreto de las URL firmadas o la URL pública), no hay proveedor y
// se sabe cuáles faltan: el cron no hace nada y las rutas responden 503.
// ============================================================

import { createTelnyxProvider, readTelnyxConfig, type VoiceProvider } from '@/lib/voice/telnyx'

export type VoiceProviderResult = { ok: true; provider: VoiceProvider } | { ok: false; missing: string[] }

export function voiceProviderFromEnv(env: Record<string, string | undefined> = process.env): VoiceProviderResult {
  const config = readTelnyxConfig(env)
  if (!config.ok) return { ok: false, missing: config.missing }
  return {
    ok: true,
    provider: createTelnyxProvider({
      apiKey: config.config.apiKey,
      accountSid: config.config.accountSid,
      appId: config.config.appId,
    }),
  }
}
