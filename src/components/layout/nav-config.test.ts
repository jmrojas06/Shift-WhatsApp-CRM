import { describe, expect, it } from "vitest";

import { getMobileTabs, getNavGroups, isNavActive } from "./nav-config";

const hrefs = (items: { href: string }[]) => items.map((i) => i.href);

describe("getNavGroups", () => {
  it("puts active modules right after the inbox", () => {
    const [daily] = getNavGroups({ modules: ["ventas", "agenda"] });
    expect(hrefs(daily.items)).toEqual([
      "/dashboard",
      "/inbox",
      "/agenda",
      "/ventas",
      "/contacts",
    ]);
  });

  it("keeps growth tools in their own group", () => {
    const [, growth] = getNavGroups(null);
    expect(hrefs(growth.items)).toEqual([
      "/pipelines",
      "/broadcasts",
      "/automations",
      "/flows",
      "/agents",
    ]);
  });
});

describe("getMobileTabs", () => {
  it("uses the first active module as the third tab", () => {
    expect(hrefs(getMobileTabs({ modules: ["agenda"] }))).toEqual([
      "/dashboard",
      "/inbox",
      "/agenda",
      "/contacts",
    ]);
    expect(hrefs(getMobileTabs({ modules: ["ventas"] }))[2]).toBe("/ventas");
  });

  it("falls back to the pipeline board without modules", () => {
    expect(hrefs(getMobileTabs({ modules: [] }))[2]).toBe("/pipelines");
  });
});

describe("isNavActive", () => {
  it("matches a section and its sub-pages only", () => {
    expect(isNavActive("/agenda", "/agenda/configuracion")).toBe(true);
    expect(isNavActive("/agenda", "/agendas")).toBe(false);
    expect(isNavActive("/dashboard", "/dashboard")).toBe(true);
    expect(isNavActive("/dashboard", "/dashboard/x")).toBe(false);
  });
});
