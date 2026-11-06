// ============================================================
// Constructor de TeXML (el XML de instrucciones de una llamada).
//
// TeXML es compatible con TwiML: `Say`, `Gather`, `Dial`, `Redirect`,
// `Pause` y `Hangup` sirven para Telnyx y para Twilio. Aquí solo se arma
// el texto; nada toca la red.
//
// Reglas:
//   - Todo texto y todo valor de atributo pasa por `escapeXml`. Las URL de
//     los webhooks llevan `&` (varios parámetros) y los nombres del negocio
//     pueden traer comillas: sin escapar, la llamada se cae.
//   - `Gather` no lleva `method` (Telnyx no lo tiene); `Dial` y `Redirect`
//     van con `method="POST"`.
//   - Cada nodo es un objeto `{ kind, xml }` y no un texto suelto, para que
//     el tipado no deje meter XML sin escapar dentro de otro nodo.
// ============================================================

/** Un fragmento de TeXML ya escapado. */
export interface TexmlNode<K extends string = string> {
  readonly kind: K
  readonly xml: string
}

export type SayNode = TexmlNode<'say'>
export type PauseNode = TexmlNode<'pause'>
export type GatherNode = TexmlNode<'gather'>
export type DialNode = TexmlNode<'dial'>
export type RedirectNode = TexmlNode<'redirect'>
export type HangupNode = TexmlNode<'hangup'>

/**
 * Caracteres que XML 1.0 no admite: controles (menos tab, salto de línea y
 * retorno), los dos no-caracteres FFFE/FFFF y sustitutos sueltos. Un solo
 * carácter de estos hace que el proveedor rechace todo el documento.
 */
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Escapa `& < > " '` y quita los caracteres que XML no admite. */
export function escapeXml(text: string): string {
  return String(text)
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Número entero no negativo para un atributo; lo que no sea número queda en 0. */
function wholeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/**
 * Idioma de una voz. Las de Azure lo traen en el nombre
 * (`Azure.es-CO-SalomeNeural`); las de Polly que usamos son de español de
 * México. Sin idioma, Telnyx puede leer el texto con acento inglés.
 */
function languageOfVoice(voice: string): string {
  return /\bes-[A-Z]{2}\b/.exec(voice)?.[0] ?? 'es-MX'
}

/** `<Say>`: el robot dice el texto con la voz dada. */
export function say(text: string, voice: string): SayNode {
  return {
    kind: 'say',
    xml: `<Say voice="${escapeXml(voice)}" language="${languageOfVoice(voice)}">${escapeXml(text)}</Say>`,
  }
}

/** `<Pause>`: silencio de `seconds` (mínimo 1 s). */
export function pause(seconds: number): PauseNode {
  return { kind: 'pause', xml: `<Pause length="${Math.max(1, wholeNumber(seconds))}"/>` }
}

/** `<Hangup>`: cuelga. */
export function hangup(): HangupNode {
  return { kind: 'hangup', xml: '<Hangup/>' }
}

/** `<Redirect>`: sigue el flujo en otra URL. */
export function redirect(url: string): RedirectNode {
  return { kind: 'redirect', xml: `<Redirect method="POST">${escapeXml(url)}</Redirect>` }
}

export interface GatherAttrs {
  /** URL que recibe la tecla marcada (`Digits`). */
  action: string
  numDigits: number
  /** Segundos de espera para la tecla. */
  timeout: number
}

/** `<Gather>`: dice los hijos y espera teclas. Sin `method`. */
export function gather(attrs: GatherAttrs, children: ReadonlyArray<SayNode | PauseNode>): GatherNode {
  const open =
    `<Gather action="${escapeXml(attrs.action)}"` +
    ` numDigits="${wholeNumber(attrs.numDigits)}"` +
    ` timeout="${wholeNumber(attrs.timeout)}">`
  return { kind: 'gather', xml: `${open}${children.map((child) => child.xml).join('')}</Gather>` }
}

export interface DialAttrs {
  /** URL que recibe el resultado (`DialCallStatus`). */
  action: string
  /** Segundos que suena antes de rendirse. */
  timeout: number
  /** Duración máxima de la llamada pasada, en segundos. */
  timeLimit: number
  /** Número que verá quien conteste (E.164). */
  callerId: string
}

/** `<Dial>`: pasa la llamada a uno o varios números a la vez. */
export function dial(attrs: DialAttrs, numbers: readonly string[]): DialNode {
  const open =
    `<Dial action="${escapeXml(attrs.action)}" method="POST"` +
    ` timeout="${wholeNumber(attrs.timeout)}"` +
    ` timeLimit="${wholeNumber(attrs.timeLimit)}"` +
    ` callerId="${escapeXml(attrs.callerId)}">`
  const inner = numbers.map((number) => `<Number>${escapeXml(number)}</Number>`).join('')
  return { kind: 'dial', xml: `${open}${inner}</Dial>` }
}

/** El documento completo que se devuelve al proveedor (`Content-Type: text/xml`). */
export function response(children: readonly TexmlNode[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${children.map((child) => child.xml).join('')}</Response>`
}
