import type { Contact } from "@/types";

/**
 * `expected_close_date` is a plain calendar date ("2026-10-22"). Parsed
 * with `new Date()` it becomes midnight UTC, which shows as the previous
 * day in America/Bogota. Returns the instant plus the time zone to format
 * it in so the day printed is the day stored.
 */
export function calendarDateForFormat(value: string): {
  date: Date;
  timeZone?: string;
} {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: new Date(`${value}T00:00:00Z`), timeZone: "UTC" };
  }
  return { date: new Date(value) };
}

/** What a contact is called in pickers: its name, else its phone. */
export function contactOptionLabel(contact: Pick<Contact, "name" | "phone">): string {
  return contact.name || contact.phone;
}

/**
 * Filters the deal form's contact picker by name, phone or email
 * (case- and accent-insensitive; phone matched on digits). The currently
 * selected contact is always kept so the select never loses its value.
 */
export function filterContactOptions<
  T extends Pick<Contact, "id" | "name" | "phone" | "email">,
>(contacts: T[], query: string, selectedId: string): T[] {
  const q = normalize(query.trim());
  if (!q) return contacts;
  const qDigits = q.replace(/\D/g, "");
  return contacts.filter((c) => {
    if (c.id === selectedId) return true;
    if (normalize(c.name ?? "").includes(q)) return true;
    if (normalize(c.email ?? "").includes(q)) return true;
    if (qDigits && (c.phone ?? "").replace(/\D/g, "").includes(qDigits)) return true;
    return false;
  });
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
