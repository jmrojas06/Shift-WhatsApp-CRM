import { describe, expect, it } from "vitest";

import {
  INBOX_FILTERS,
  countUnreadConversations,
  matchesInboxFilter,
} from "./inbox-filters";

const open = { status: "open" as const, unread_count: 0 };
const pendingUnread = { status: "pending" as const, unread_count: 3 };
const closed = { status: "closed" as const, unread_count: 0 };

describe("INBOX_FILTERS", () => {
  it("lists the chips in display order", () => {
    expect(INBOX_FILTERS).toEqual(["all", "unread", "open", "pending", "closed"]);
  });
});

describe("matchesInboxFilter", () => {
  it("'all' lets every conversation through", () => {
    for (const c of [open, pendingUnread, closed]) {
      expect(matchesInboxFilter(c, "all")).toBe(true);
    }
  });

  it("'unread' keeps only conversations with unread messages", () => {
    expect(matchesInboxFilter(pendingUnread, "unread")).toBe(true);
    expect(matchesInboxFilter(open, "unread")).toBe(false);
  });

  it("a status filter matches that status only", () => {
    expect(matchesInboxFilter(open, "open")).toBe(true);
    expect(matchesInboxFilter(pendingUnread, "open")).toBe(false);
    expect(matchesInboxFilter(pendingUnread, "pending")).toBe(true);
    expect(matchesInboxFilter(closed, "closed")).toBe(true);
  });
});

describe("countUnreadConversations", () => {
  it("counts conversations, not messages", () => {
    expect(
      countUnreadConversations([open, pendingUnread, { unread_count: 1 }]),
    ).toBe(2);
  });

  it("is 0 for an empty inbox", () => {
    expect(countUnreadConversations([])).toBe(0);
  });
});
