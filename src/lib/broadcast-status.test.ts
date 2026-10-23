import { describe, expect, it } from "vitest";
import {
  broadcastStatusConfig,
  getBroadcastStatus,
  getRecipientStatus,
  recipientStatusConfig,
} from "./broadcast-status";

describe("getBroadcastStatus", () => {
  it("returns the matching config for known statuses", () => {
    expect(getBroadcastStatus("sending")).toBe(broadcastStatusConfig.sending);
    expect(getBroadcastStatus("sent")).toBe(broadcastStatusConfig.sent);
    expect(getBroadcastStatus("failed")).toBe(broadcastStatusConfig.failed);
  });

  it("flags `sending` as a live/pulsing state", () => {
    expect(getBroadcastStatus("sending").pulse).toBe(true);
    expect(getBroadcastStatus("sent").pulse).toBeFalsy();
  });

  it("falls back to draft on an unknown status string", () => {
    expect(getBroadcastStatus("not-a-real-status")).toBe(
      broadcastStatusConfig.draft,
    );
    expect(getBroadcastStatus("")).toBe(broadcastStatusConfig.draft);
  });

  it("each variant has the dark-theme class triple", () => {
    // Theme tokens only (bg-info/10, bg-muted, border-border…): no
    // fixed Tailwind palette shades, so the tints follow light/dark.
    for (const v of [
      ...Object.values(broadcastStatusConfig),
      ...Object.values(recipientStatusConfig),
    ]) {
      expect(v.classes).toMatch(/(^|\s)bg-[a-z-]+(\/\d+)?(\s|$)/);
      expect(v.classes).toMatch(/(^|\s)text-[a-z-]+(\s|$)/);
      expect(v.classes).toMatch(/(^|\s)border-[a-z-]+(\/\d+)?(\s|$)/);
      expect(v.classes).not.toMatch(/-\d{2,3}(\/|\s|$)/);
    }
  });
});

describe("getRecipientStatus", () => {
  it("returns the matching config for known statuses", () => {
    expect(getRecipientStatus("delivered")).toBe(
      recipientStatusConfig.delivered,
    );
    expect(getRecipientStatus("read")).toBe(recipientStatusConfig.read);
  });

  it("falls back to pending on an unknown status string", () => {
    expect(getRecipientStatus("???")).toBe(recipientStatusConfig.pending);
  });
});
