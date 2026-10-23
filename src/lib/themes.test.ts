import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  THEME_IDS,
  THEMES,
  isModePreference,
  resolveMode,
} from "./themes";

describe("resolveMode", () => {
  it("follows the system when the preference is system", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });

  it("keeps an explicit choice regardless of the system", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });
});

describe("isModePreference", () => {
  it("accepts system, light and dark only", () => {
    expect(isModePreference("system")).toBe(true);
    expect(isModePreference("light")).toBe(true);
    expect(isModePreference("dark")).toBe(true);
    expect(isModePreference("auto")).toBe(false);
    expect(isModePreference(null)).toBe(false);
  });
});

describe("defaults", () => {
  it("defaults to the system mode and the shift accent", () => {
    expect(DEFAULT_MODE_PREFERENCE).toBe("system");
    expect(DEFAULT_THEME).toBe("shift");
    expect(THEME_IDS[0]).toBe("shift");
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
  });
});
