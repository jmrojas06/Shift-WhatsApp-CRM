// ============================================================
// Alertas operativas (Fase 5).
//
// POST `{ text }` a ALERT_WEBHOOK_URL — compatible con webhooks de
// Slack (y relays equivalentes). Pensado para que el runner de
// recordatorios avise cuando algo falla.
//
// Contrato: NUNCA lanza. Sin webhook configurado es un no-op; si la
// entrega falla se registra en consola y la vida sigue — una alerta
// jamás debe tumbar al runner.
// ============================================================

/** Duro: la alerta no debe retrasar la respuesta del runner. */
const ALERT_TIMEOUT_MS = 5_000

export async function notifyAlert(text: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL
  if (!url) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
    if (!response.ok) {
      // La URL del webhook es un secreto: solo se loguea el status.
      console.error(`[ops alert] webhook respondió ${response.status}`)
    }
  } catch (error) {
    // Sin URL ni causa completa en el log — `message` alcanza.
    console.error(
      '[ops alert] no se pudo entregar la alerta:',
      error instanceof Error ? error.message : 'error desconocido',
    )
  } finally {
    clearTimeout(timer)
  }
}
