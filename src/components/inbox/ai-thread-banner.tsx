"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { hasModule } from "@/lib/verticals/registry";

export type AiBannerMode = "hidden" | "paused" | "active";

/**
 * Which banner (if any) a thread shows. Pure so it can be tested
 * without a DOM.
 *
 * A paused thread needs a way back even when the account never turned
 * on AI auto-reply: the vertical's booking bot (barbería) pauses the
 * thread on handoff with the same `ai_autoreply_disabled` flag and
 * stands down until someone resumes it.
 */
export function resolveAiBannerMode(args: {
  /** null while the account's AI status is still loading. */
  autoReplyOn: boolean | null;
  hasVertical: boolean;
  paused: boolean;
  assignedAgentId?: string | null;
}): AiBannerMode {
  if (args.paused && (args.autoReplyOn || args.hasVertical)) return "paused";
  // No auto-reply (or still loading) → nothing to show.
  if (!args.autoReplyOn) return "hidden";
  // Active, but a human already owns it → the bot won't fire; no banner.
  if (args.assignedAgentId) return "hidden";
  return "active";
}

/**
 * Copy for the paused banner. "Bot" wording only when the account truly
 * has no AI auto-reply (`false`): while the status is loading (`null`)
 * the neutral AI wording is the safe default, so an AI-enabled account
 * never flashes bot-only copy.
 */
export function resolvePausedCopy(args: { autoReplyOn: boolean | null }): {
  titleKey: "pausedTitle" | "botPausedTitle";
  buttonKey: "resume" | "resumeBot";
} {
  return args.autoReplyOn === false
    ? { titleKey: "botPausedTitle", buttonKey: "resumeBot" }
    : { titleKey: "pausedTitle", buttonKey: "resume" };
}

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------
interface AiAccountStatus {
  autoReplyOn: boolean;
}
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { autoReplyOn: false }; // don't cache a transient failure
    const j = await res.json();
    const status = {
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false }; // don't cache
  }
}

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — note the bot left on handoff. */
  handoffSummary?: string | null;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation:
 *   - bot active here → "AI is replying automatically" + [Take over]
 *   - bot paused here → the handoff note (if any) + [Resume AI]
 * Renders nothing when the account has no auto-reply configured, or when
 * the bot is active but a human already owns the thread (nothing to do).
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  assignedAgentId,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const { accountId, account } = useAuth();
  // "Tiene bot de módulo": hoy solo la agenda atiende por WhatsApp
  // (Ventas es solo panel), así que ese es el módulo que cuenta.
  const hasVertical = hasModule(account, "agenda");
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setAutoReplyOn(s.autoReplyOn));
    return () => {
      alive = false;
    };
  }, [accountId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify({ paused, assign_to_me: paused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        setPaused(paused);
        onChange?.({
          ai_autoreply_disabled: paused,
          // Take over assigns to the acting agent; resume releases only
          // the caller's own assignment. The realtime UPDATE reconciles
          // the exact value either way.
          ...(paused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(
          paused
            ? t("tookOver")
            : autoReplyOn === false
              ? t("botResumed")
              : t("resumed"),
        );
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [autoReplyOn, conversationId, currentUserId, onChange, t],
  );

  const mode = resolveAiBannerMode({
    autoReplyOn,
    hasVertical,
    paused,
    assignedAgentId,
  });
  if (mode === "hidden") return null;

  // Paused here (a human took over, or the model / booking bot handed
  // off). Without AI auto-reply only the vertical's bot is paused, so
  // the copy names the bot instead of the AI.
  if (mode === "paused") {
    const copy = resolvePausedCopy({ autoReplyOn });
    return (
      <Banner tone="muted">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t(copy.titleKey)}</p>
          {handoffSummary && (
            <p className="truncate text-muted-foreground" title={handoffSummary}>
              {handoffSummary}
            </p>
          )}
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t(copy.buttonKey)}
        </BannerButton>
      </Banner>
    );
  }

  // Active on this thread.
  return (
    <Banner tone="primary">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-foreground">
          {t("activeText")}
        </span>
      </div>
      <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
        {t("takeOver")}
      </BannerButton>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        // Sits above the composer, so the line is on top (border-t).
        "flex items-center gap-3 border-t px-3 py-2 text-xs sm:px-4",
        tone === "primary"
          ? "border-primary/20 bg-primary-soft"
          : "border-border bg-muted",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 pointer-coarse:h-11"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {children}
    </button>
  );
}
