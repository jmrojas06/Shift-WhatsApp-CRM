import { describe, expect, it } from "vitest";
import {
  calendarDateForFormat,
  contactMatchesQuery,
  contactOptionLabel,
  filterContactOptions,
} from "./deal-utils";

const contacts = [
  { id: "1", name: "José Gómez", phone: "+57 300 123 4567", email: "jose@correo.com" },
  { id: "2", name: "Ana Ruiz", phone: "+573109998877", email: undefined },
  { id: "3", name: undefined, phone: "+34 600 111 222", email: undefined },
];

describe("filterContactOptions", () => {
  it("returns everything for an empty query", () => {
    expect(filterContactOptions(contacts, "  ", "")).toHaveLength(3);
  });

  it("matches names ignoring case and accents", () => {
    expect(filterContactOptions(contacts, "jose", "").map((c) => c.id)).toEqual(["1"]);
    expect(filterContactOptions(contacts, "GÓM", "").map((c) => c.id)).toEqual(["1"]);
  });

  it("matches phones by digits regardless of spacing", () => {
    expect(filterContactOptions(contacts, "300 1234", "").map((c) => c.id)).toEqual(["1"]);
    expect(filterContactOptions(contacts, "600111", "").map((c) => c.id)).toEqual(["3"]);
  });

  it("matches emails", () => {
    expect(filterContactOptions(contacts, "correo.com", "").map((c) => c.id)).toEqual(["1"]);
  });

  it("always keeps the selected contact", () => {
    expect(filterContactOptions(contacts, "ana", "3").map((c) => c.id)).toEqual(["2", "3"]);
  });
});

describe("contactMatchesQuery", () => {
  it("matches everyone for an empty query", () => {
    expect(contactMatchesQuery(contacts[0], "")).toBe(true);
    expect(contactMatchesQuery(contacts[2], "   ")).toBe(true);
  });

  it("matches name, email and phone digits", () => {
    expect(contactMatchesQuery(contacts[0], "GOMEZ")).toBe(true);
    expect(contactMatchesQuery(contacts[0], "correo.com")).toBe(true);
    expect(contactMatchesQuery(contacts[0], "300 123")).toBe(true);
    expect(contactMatchesQuery(contacts[1], "gómez")).toBe(false);
  });

  it("matches the WhatsApp username with or without the @", () => {
    const bsuid = { name: undefined, phone: "", wa_username: "juanito.cuts" };
    expect(contactMatchesQuery(bsuid, "juanito")).toBe(true);
    expect(contactMatchesQuery(bsuid, "@juanito")).toBe(true);
    expect(contactMatchesQuery(bsuid, "pedro")).toBe(false);
  });

  it("a lone @ does not match a contact without email or username", () => {
    expect(contactMatchesQuery(contacts[1], "@")).toBe(false);
  });
});

describe("contactOptionLabel", () => {
  it("prefers the name and falls back to the phone", () => {
    expect(contactOptionLabel(contacts[0])).toBe("José Gómez");
    expect(contactOptionLabel(contacts[2])).toBe("+34 600 111 222");
  });

  it("falls back to the @username for a contact without phone", () => {
    expect(
      contactOptionLabel({ name: undefined, phone: "", wa_username: "juanito.cuts" }),
    ).toBe("@juanito.cuts");
  });
});

describe("calendarDateForFormat", () => {
  it("pins date-only values to UTC so the stored day is shown", () => {
    const { date, timeZone } = calendarDateForFormat("2026-10-22");
    expect(timeZone).toBe("UTC");
    expect(date.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  it("leaves full timestamps alone", () => {
    const { date, timeZone } = calendarDateForFormat("2026-10-22T15:30:00Z");
    expect(timeZone).toBeUndefined();
    expect(date.toISOString()).toBe("2026-10-22T15:30:00.000Z");
  });
});
