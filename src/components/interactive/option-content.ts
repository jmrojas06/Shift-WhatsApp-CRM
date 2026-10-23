import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

/**
 * True when the payload's options (reply buttons, or list sections and
 * rows) hold anything the author typed. Switching between buttons and a
 * list rebuilds the options from scratch, so the builder only asks for
 * confirmation when this returns true. Body, header and footer are kept
 * across a switch and are deliberately not counted here.
 */
export function hasOptionContent(payload: InteractiveMessagePayload): boolean {
  const filled = (s: string | undefined | null) => (s ?? "").trim().length > 0;
  if (payload.kind === "buttons") {
    return payload.buttons.some((b) => filled(b.title));
  }
  return payload.sections.some(
    (s) =>
      filled(s.title) ||
      s.rows.some((r) => filled(r.title) || filled(r.description)),
  );
}
