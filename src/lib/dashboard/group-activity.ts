import type { ActivityItem } from './types'

export interface GroupedActivity {
  item: ActivityItem
  /** How many consecutive identical events this row stands for (≥ 1). */
  count: number
}

/**
 * Collapses back-to-back identical events ("Nuevo mensaje de Laura M."
 * four times in a row) into one row with a count, so a single chatty
 * customer doesn't push everything else off the feed. Only adjacent
 * items merge; the newest one represents the group.
 */
export function groupActivity(items: readonly ActivityItem[]): GroupedActivity[] {
  const groups: GroupedActivity[] = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.item.kind === item.kind &&
      last.item.text === item.text &&
      last.item.href === item.href
    ) {
      last.count += 1
    } else {
      groups.push({ item, count: 1 })
    }
  }
  return groups
}
