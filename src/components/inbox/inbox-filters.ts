import type { Conversation, ConversationStatus } from "@/types";

/**
 * The inbox's quick filters, shown as chips above the conversation list.
 * Order is the order the chips render in.
 */
export type InboxFilter = ConversationStatus | "all" | "unread";

export const INBOX_FILTERS: readonly InboxFilter[] = [
  "all",
  "unread",
  "open",
  "pending",
  "closed",
];

/** Whether one conversation passes the selected quick filter. */
export function matchesInboxFilter(
  conversation: Pick<Conversation, "status" | "unread_count">,
  filter: InboxFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "unread") return conversation.unread_count > 0;
  return conversation.status === filter;
}

/** Lower-case, accent-free text: typing "jose" finds "José". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Whether a conversation matches what was typed in the search box: the
 * contact's name, phone (as typed, or digits only so "300 123" finds
 * "+57 300 123 4567"), @username, or the last message. Accents and case
 * don't matter. An empty query matches everything.
 */
export function matchesSearch(
  conversation: {
    last_message_text?: string | null;
    contact?: {
      name?: string | null;
      phone?: string | null;
      wa_username?: string | null;
    } | null;
  },
  query: string,
): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  const contact = conversation.contact;
  const phone = (contact?.phone ?? "").toLowerCase();
  if (
    foldText(contact?.name ?? "").includes(q) ||
    phone.includes(q) ||
    foldText(contact?.wa_username ?? "").includes(q) ||
    foldText(conversation.last_message_text ?? "").includes(q)
  ) {
    return true;
  }
  const digits = q.replace(/\D/g, "");
  return digits.length >= 3 && phone.replace(/\D/g, "").includes(digits);
}

/** How many conversations have at least one unread message. */
export function countUnreadConversations(
  conversations: ReadonlyArray<Pick<Conversation, "unread_count">>,
): number {
  let n = 0;
  for (const c of conversations) if (c.unread_count > 0) n += 1;
  return n;
}
