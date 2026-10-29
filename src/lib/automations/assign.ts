/**
 * "Rotativo" (round_robin): reparte entre los miembros que atienden
 * (owner, admin, agent; nunca viewer) dándole el chat al que tenga
 * menos conversaciones abiertas asignadas. Con todos en cero va uno
 * por uno en orden fijo, y sin guardar un turno no hay estado que se
 * desincronice si una corrida falla.
 */
export const ASSIGNABLE_ROLES = ['owner', 'admin', 'agent'] as const

export function pickLeastLoadedAgent(
  memberIds: readonly string[],
  openAssignedTo: readonly (string | null)[],
): string | null {
  if (!memberIds.length) return null
  const load = new Map(memberIds.map((id) => [id, 0]))
  for (const id of openAssignedTo) {
    if (id && load.has(id)) load.set(id, load.get(id)! + 1)
  }
  const byLoadThenId = (a: string, b: string) =>
    load.get(a)! - load.get(b)! || (a < b ? -1 : a > b ? 1 : 0)
  return [...memberIds].sort(byLoadThenId)[0]
}
