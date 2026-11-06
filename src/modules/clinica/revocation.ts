// ============================================================
// ¿El mensaje revoca la autorización de datos?
//
// Quien toca "No acepto" revoca con el botón, pero muchos lo escriben: "ya no
// autorizo el uso de mis datos", "revoco mi autorización", "quiero que borren
// mis datos". Sin leerlo, esos mensajes llegaban a la IA y no quedaba nada
// registrado.
//
// Es un detector puro y de dos reglas, a propósito estrecho: una revocación
// pausa el bot y pasa el chat a una persona, y "no acepto esa hora" o "borré el
// mensaje" no lo son.
//   1. El mensaje COMPLETO es "no acepto", "ya no acepto", "no autorizo" o "ya
//      no autorizo".
//   2. Una frase que combina un verbo de retirar o no dar el permiso (revoc*,
//      retir*, quit*, borr*, elimin*, suprim*, "no autorizo", "no quiero que
//      usen", "no usen"...) con lo que se retira: "autorización", "autorizo" o
//      "mis datos".
// Si lo que pide es borrar los datos (un verbo de borrar con "mis datos"), se
// avisa: la clínica tiene que atenderlo a mano, el bot no borra nada.
// ============================================================

import { normalizeText } from '@/verticals/agenda/agent/state'

export interface ConsentRevocation {
  /** Pidió que borren sus datos: hay que atenderlo a mano. */
  deleteData: boolean
}

/** Sin tildes, mayúsculas, signos ni espacios de más. */
function plain(text: string): string {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mensajes completos que revocan (en forma `plain`). */
const WHOLE_MESSAGES: readonly string[] = ['no acepto', 'ya no acepto', 'no autorizo', 'ya no autorizo']

/** Verbos de retirar el permiso o los datos. */
const WITHDRAW_VERB = /(?<![a-z0-9])(revoc|retir|quit|borr|elimin|suprim)[a-z]*/
/** Verbos de borrar: pedir que desaparezcan los datos. */
const DELETE_VERB = /(?<![a-z0-9])(borr|elimin|suprim|quit|retir)[a-z]*/
/** "No autorizo", "no quiero que usen", "no usen"... */
const DENY_PHRASE =
  /(?<![a-z0-9])(no autorizo|no quiero que (usen|utilicen|guarden)|no (usen|utilicen|guarden))(?![a-z0-9])/

const MY_DATA = /(?<![a-z0-9])mis datos(?![a-z0-9])/
const AUTHORIZATION = /(?<![a-z0-9])autorizacion(?![a-z0-9])/
const AUTHORIZE = /(?<![a-z0-9])autorizo(?![a-z0-9])/

export function consentRevocation(text: string): ConsentRevocation | null {
  const message = plain(text)
  if (!message) return null
  if (WHOLE_MESSAGES.includes(message)) return { deleteData: false }

  const data = MY_DATA.test(message)
  // "autorizo" suelto es el sustantivo; el de "no autorizo" ya es el verbo.
  const noun = AUTHORIZATION.test(message) || data || AUTHORIZE.test(message.replace(/no autorizo/g, ' '))
  const denies = DENY_PHRASE.test(message)
  const withdraws = WITHDRAW_VERB.test(message)

  // "no autorizo ese cobro": el verbo es el mismo "no autorizo", así que pide algo más
  // que la propia palabra: la autorización o los datos.
  const revokes = withdraws ? noun : denies && (AUTHORIZATION.test(message) || data)
  if (!revokes) return null

  return { deleteData: data && DELETE_VERB.test(message) }
}

export function isConsentRevocation(text: string): boolean {
  return consentRevocation(text) !== null
}
