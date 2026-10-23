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

/** How many conversations have at least one unread message. */
export function countUnreadConversations(
  conversations: ReadonlyArray<Pick<Conversation, "unread_count">>,
): number {
  let n = 0;
  for (const c of conversations) if (c.unread_count > 0) n += 1;
  return n;
}
