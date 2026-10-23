import { describe, expect, it } from "vitest";
import { templateCategoryKey } from "./template-picker";

describe("templateCategoryKey", () => {
  it("maps Meta's upper-case categories to the label keys", () => {
    expect(templateCategoryKey("MARKETING")).toBe("Marketing");
    expect(templateCategoryKey("UTILITY")).toBe("Utility");
    expect(templateCategoryKey("AUTHENTICATION")).toBe("Authentication");
  });

  it("keeps already capitalized categories as they are", () => {
    expect(templateCategoryKey("Marketing")).toBe("Marketing");
  });

  it("handles lower case and stray spaces", () => {
    expect(templateCategoryKey(" utility ")).toBe("Utility");
  });

  it("returns an empty string for an empty category", () => {
    expect(templateCategoryKey("")).toBe("");
  });
});
