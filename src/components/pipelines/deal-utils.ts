import type { Contact } from "@/types";
import { contactHandle } from "@/lib/whatsapp/wa-identity";

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

type PickableContact = Pick<Contact, "name" | "phone"> &
  Partial<Pick<Contact, "email" | "wa_username" | "wa_user_id">>;

/**
 * What a contact is called in pickers: its name, else its phone, else its
 * WhatsApp @username (a contact Meta only identified by BSUID has no phone),
 * so an option is never a blank row.
 */
export function contactOptionLabel(contact: PickableContact): string {
  return contact.name || contactHandle(contact);
}

/**
 * Does the contact match what was typed in the picker? Looks at name,
 * email and WhatsApp username (case- and accent-insensitive) and at the
 * phone by digits, so "300 1234" finds "+57 300 123 4567". An empty query
 * matches everyone.
 */
export function contactMatchesQuery(
  contact: PickableContact,
  query: string,
): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  if (normalize(contact.name ?? "").includes(q)) return true;
  if (normalize(contact.email ?? "").includes(q)) return true;
  const qUser = q.replace(/^@/, "");
  if (qUser && normalize(contact.wa_username ?? "").includes(qUser)) return true;
  const qDigits = q.replace(/\D/g, "");
  return !!qDigits && (contact.phone ?? "").replace(/\D/g, "").includes(qDigits);
}

/**
 * Filters a contact list with {@link contactMatchesQuery}. The currently
 * selected contact is always kept so a select never loses its value.
 */
export function filterContactOptions<
  T extends Pick<Contact, "id" | "name" | "phone" | "email">,
>(contacts: T[], query: string, selectedId: string): T[] {
  if (!query.trim()) return contacts;
  return contacts.filter((c) => c.id === selectedId || contactMatchesQuery(c, query));
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
