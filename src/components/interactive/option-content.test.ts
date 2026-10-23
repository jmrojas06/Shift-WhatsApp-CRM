import { describe, expect, it } from "vitest";

import { hasOptionContent } from "./option-content";

describe("hasOptionContent", () => {
  it("is false for blank reply buttons", () => {
    expect(
      hasOptionContent({ kind: "buttons", body: "Hola", buttons: [{ id: "btn_1", title: "  " }] }),
    ).toBe(false);
  });

  it("is true when a button has a title", () => {
    expect(
      hasOptionContent({
        kind: "buttons",
        body: "",
        buttons: [
          { id: "btn_1", title: "" },
          { id: "btn_2", title: "Sí" },
        ],
      }),
    ).toBe(true);
  });

  it("is false for a blank list even with a default menu label", () => {
    expect(
      hasOptionContent({
        kind: "list",
        body: "Texto",
        button_label: "Menú",
        sections: [{ title: "", rows: [{ id: "row_1", title: "" }] }],
      }),
    ).toBe(false);
  });

  it("counts section titles, row titles and row descriptions", () => {
    const base = { kind: "list" as const, body: "", button_label: "Menú" };
    expect(
      hasOptionContent({ ...base, sections: [{ title: "Servicios", rows: [{ id: "row_1", title: "" }] }] }),
    ).toBe(true);
    expect(
      hasOptionContent({ ...base, sections: [{ title: "", rows: [{ id: "row_1", title: "Corte" }] }] }),
    ).toBe(true);
    expect(
      hasOptionContent({
        ...base,
        sections: [{ title: "", rows: [{ id: "row_1", title: "", description: "30 min" }] }],
      }),
    ).toBe(true);
  });
});
