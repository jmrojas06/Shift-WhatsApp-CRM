import { describe, expect, it } from "vitest";

import { workspaceInitials } from "./workspace-badge";

describe("workspaceInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(workspaceInitials("Barbería Élite")).toBe("BÉ");
    expect(workspaceInitials("  Joyería  la Perla ")).toBe("JL");
  });

  it("uses two letters for a single word and nothing for an empty name", () => {
    expect(workspaceInitials("Rojas")).toBe("RO");
    expect(workspaceInitials("")).toBe("");
  });
});
