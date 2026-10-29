import { describe, expect, it } from "vitest";

import {
  INBOX_FILTERS,
  countUnreadConversations,
  matchesInboxFilter,
  matchesSearch,
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

describe("matchesSearch", () => {
  const conv = {
    last_message_text: "¿Cuánto vale el corte?",
    contact: {
      name: "José Peña",
      phone: "+57 300 123 4567",
      wa_username: "jose_barber",
    },
  };

  it("an empty query matches everything", () => {
    expect(matchesSearch(conv, "")).toBe(true);
    expect(matchesSearch(conv, "   ")).toBe(true);
  });

  it("ignores accents and case in names and messages", () => {
    expect(matchesSearch(conv, "jose")).toBe(true);
    expect(matchesSearch(conv, "PEÑA")).toBe(true);
    expect(matchesSearch(conv, "pena")).toBe(true);
    expect(matchesSearch(conv, "cuanto vale")).toBe(true);
  });

  it("finds a phone by its digits however it is written", () => {
    expect(matchesSearch(conv, "+57 300")).toBe(true);
    expect(matchesSearch(conv, "3001234567")).toBe(true);
    expect(matchesSearch(conv, "300-123")).toBe(true);
  });

  it("does not use the digits-only match for runs shorter than 3", () => {
    // "12" is inside the digits "5712" but not inside "+57 1 2" as typed.
    expect(matchesSearch({ contact: { phone: "+57 1 2" } }, "12")).toBe(false);
    expect(matchesSearch({ contact: { phone: "+57 1 2" } }, "712")).toBe(true);
  });

  it("finds a WhatsApp username", () => {
    expect(matchesSearch(conv, "jose_bar")).toBe(true);
  });

  it("misses when nothing matches and tolerates empty contacts", () => {
    expect(matchesSearch(conv, "zapatos")).toBe(false);
    expect(matchesSearch({}, "x")).toBe(false);
    expect(matchesSearch({ contact: null, last_message_text: null }, "x")).toBe(
      false,
    );
  });
});
