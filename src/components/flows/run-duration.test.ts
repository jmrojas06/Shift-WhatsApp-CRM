import { describe, expect, it } from "vitest";

import { durationParts, formatRunDuration } from "./run-duration";

describe("durationParts", () => {
  it("reads sub-second spans as 0 seconds", () => {
    expect(durationParts(0)).toEqual([{ unit: "second", value: 0 }]);
    expect(durationParts(999)).toEqual([{ unit: "second", value: 0 }]);
  });

  it("keeps the two largest adjacent units", () => {
    expect(durationParts(45_000)).toEqual([{ unit: "second", value: 45 }]);
    expect(durationParts(3 * 60_000 + 12_000)).toEqual([
      { unit: "minute", value: 3 },
      { unit: "second", value: 12 },
    ]);
    expect(durationParts(2 * 3_600_000 + 5 * 60_000 + 30_000)).toEqual([
      { unit: "hour", value: 2 },
      { unit: "minute", value: 5 },
    ]);
    expect(durationParts(86_400_000 + 3 * 3_600_000)).toEqual([
      { unit: "day", value: 1 },
      { unit: "hour", value: 3 },
    ]);
  });

  it("drops a non-adjacent second unit", () => {
    expect(durationParts(3_600_000 + 4_000)).toEqual([{ unit: "hour", value: 1 }]);
  });
});

describe("formatRunDuration", () => {
  const start = "2026-10-20T10:00:00.000Z";

  it("measures from start to end, not from now", () => {
    const out = formatRunDuration(start, "2026-10-20T10:03:12.000Z", "es");
    expect(out).toMatch(/3/);
    expect(out).toMatch(/12/);
    expect(out).toBe(
      `${new Intl.NumberFormat("es", { style: "unit", unit: "minute", unitDisplay: "short" }).format(3)} ${new Intl.NumberFormat("es", { style: "unit", unit: "second", unitDisplay: "short" }).format(12)}`,
    );
  });

  it("returns null for missing, invalid or reversed timestamps", () => {
    expect(formatRunDuration(start, null, "es")).toBeNull();
    expect(formatRunDuration(null, start, "es")).toBeNull();
    expect(formatRunDuration("nope", start, "es")).toBeNull();
    expect(formatRunDuration(start, "2026-10-20T09:59:00.000Z", "es")).toBeNull();
  });
});
