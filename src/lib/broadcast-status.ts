/**
 * Shared status badge config for broadcasts + recipients.
 *
 * Previously `statusConfig` was defined inline in both
 * /broadcasts/page.tsx and /broadcasts/[id]/page.tsx with slight
 * drift risk. One source of truth now.
 *
 * Badge shape: soft status tokens (bg-<token>/10 + text-<token> +
 * border-<token>/20), so the tints follow the light/dark theme and the
 * text stays AA in both modes. Neutral statuses use the muted surface
 * and text-muted-foreground.
 */

import type { BroadcastStatus, RecipientStatus } from "@/types";

export interface StatusDisplay {
  label: string;
  classes: string;
  /**
   * Set true for statuses that should pulse in the UI to convey
   * "live / in-flight" — currently only `sending`.
   */
  pulse?: boolean;
}

const NEUTRAL = "bg-muted text-muted-foreground border-border";
const INFO = "bg-info/10 text-info border-info/20";
const WARNING = "bg-warning/10 text-warning border-warning/20";
const SUCCESS = "bg-success/10 text-success border-success/20";
const ACCENT = "bg-primary/10 text-primary border-primary/20";
const DANGER = "bg-destructive/10 text-destructive border-destructive/20";

export const broadcastStatusConfig: Record<BroadcastStatus, StatusDisplay> = {
  draft: { label: "draft", classes: NEUTRAL },
  scheduled: { label: "scheduled", classes: INFO },
  sending: { label: "sending", classes: WARNING, pulse: true },
  sent: { label: "sent", classes: SUCCESS },
  failed: { label: "failed", classes: DANGER },
};

export const recipientStatusConfig: Record<RecipientStatus, StatusDisplay> = {
  pending: { label: "pending", classes: NEUTRAL },
  sent: { label: "sent", classes: INFO },
  delivered: { label: "delivered", classes: SUCCESS },
  read: { label: "read", classes: SUCCESS },
  replied: { label: "replied", classes: ACCENT },
  failed: { label: "failed", classes: DANGER },
};

/**
 * Tolerant lookup — callers often have a generic string status
 * coming from Supabase. Falls back to the "draft" / "pending"
 * entry so the UI never crashes on an unknown value.
 */
export function getBroadcastStatus(status: string): StatusDisplay {
  return (
    broadcastStatusConfig[status as BroadcastStatus] ??
    broadcastStatusConfig.draft
  );
}

export function getRecipientStatus(status: string): StatusDisplay {
  return (
    recipientStatusConfig[status as RecipientStatus] ??
    recipientStatusConfig.pending
  );
}
