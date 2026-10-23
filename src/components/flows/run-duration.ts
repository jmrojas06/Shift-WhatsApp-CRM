/**
 * How long a flow run lasted, from `started_at` to `ended_at`, as a
 * short localized string ("3 min 12 s", "2 h 5 min"). Only the two
 * largest non-zero units are shown; a run is rarely worth reading to
 * the second once it spans hours.
 */

export type DurationUnit = "day" | "hour" | "minute" | "second";

export interface DurationPart {
  unit: DurationUnit;
  value: number;
}

const UNIT_MS: Array<[DurationUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** Splits a millisecond span into its two largest non-zero units.
 *  Anything under a second reads as 0 seconds. */
export function durationParts(ms: number): DurationPart[] {
  let rest = Math.max(0, Math.floor(ms / 1000) * 1000);
  const parts: DurationPart[] = [];
  for (const [unit, size] of UNIT_MS) {
    const value = Math.floor(rest / size);
    rest -= value * size;
    if (value > 0 || parts.length > 0) parts.push({ unit, value });
  }
  const nonZero = parts.filter((p) => p.value > 0).slice(0, 2);
  // Keep the units adjacent: "1 h 0 min" collapses to "1 h", not "1 h 4 s".
  if (nonZero.length === 2) {
    const first = UNIT_MS.findIndex(([u]) => u === nonZero[0].unit);
    const second = UNIT_MS.findIndex(([u]) => u === nonZero[1].unit);
    if (second !== first + 1) return [nonZero[0]];
  }
  return nonZero.length > 0 ? nonZero : [{ unit: "second", value: 0 }];
}

/** Localized duration between two ISO timestamps, or null when either
 *  is missing/invalid or the end comes before the start. */
export function formatRunDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  locale: string,
): string | null {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return durationParts(end - start)
    .map(({ unit, value }) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
      }).format(value),
    )
    .join(" ");
}
