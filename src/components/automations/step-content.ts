/**
 * Decides whether deleting an automation step should ask first. A step
 * that still matches the blank config it was created with (and has no
 * nested steps) can go without a prompt; anything the author typed or
 * any branch with steps in it gets a confirmation.
 */

interface StepLike {
  step_config: Record<string, unknown>
  branches?: { yes: unknown[]; no: unknown[] }
}

/** Stable comparison that ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

export function stepNeedsDeleteConfirm(
  step: StepLike,
  blank: Record<string, unknown>,
): boolean {
  const branchCount =
    (step.branches?.yes.length ?? 0) + (step.branches?.no.length ?? 0)
  if (branchCount > 0) return true
  return canonical(step.step_config) !== canonical(blank)
}
