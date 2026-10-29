"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  ChevronRight,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { useFormatter, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { MediaLightbox } from "./media-lightbox";
import { collectMediaGallery } from "@/lib/media/gallery";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { AiThreadBanner } from "./ai-thread-banner";
import { MobileOrdersButton } from "./mobile-orders-button";
import { ContactSidebar } from "./contact-sidebar";
import { buildReplyPreview } from "./reply-quote";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { toast } from "sonner";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>,
  formatter: ReturnType<typeof useFormatter>,
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t("today");
  if (isYesterday(date)) return t("yesterday");
  // App locale ("12 de octubre de 2026", "October 12, 2026", …).
  return formatter.dateTime(date, { day: "numeric", month: "long", year: "numeric" });
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), "yyyy-MM-dd");
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

/**
 * Conversation status options. `chip` styles the header trigger with the
 * semantic status tokens; `dot` is the matching colour for menu items.
 */
const STATUS_OPTIONS: {
  label: string;
  value: ConversationStatus;
  chip: string;
  dot: string;
}[] = [
  {
    label: "Open",
    value: "open",
    chip: "border-success/30 bg-success/10 text-success",
    dot: "bg-success",
  },
  {
    label: "Pending",
    value: "pending",
    chip: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
  },
  {
    label: "Closed",
    value: "closed",
    chip: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
];

/**
 * WhatsApp-style doodle behind the open chat, kept very faint: the tile
 * (`/public/inbox-doodle.svg`) is painted on a pseudo-element at reduced
 * opacity, under the content (`-z-10` inside an `isolate` root) so the
 * header and composer surfaces cover it. The empty state has no pattern.
 */
const DOODLE_BG_CLASSES =
  "relative isolate bg-background before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-[url('/inbox-doodle.svg')] before:bg-repeat before:opacity-40";

/** Header icon buttons: 36px on desktop, 44px on touch, visible focus. */
const HEADER_ICON_BUTTON =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 pointer-coarse:h-11 pointer-coarse:w-11";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations("Inbox.messageThread");
  const tTimer = useTranslations("Inbox.sessionTimer");
  const tQuote = useTranslations("Inbox.replyQuote");
  const tSidebar = useTranslations("Inbox.sidebar");
  const formatter = useFormatter();

  const { user } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the reader is parked at the end of the thread. Only then do new
  // messages (or images finishing their load, or the keyboard resizing the
  // box) pull the view down; someone reading older messages is left alone.
  const stickToBottomRef = useRef(true);
  const lastMessageIdRef = useRef<string | null>(null);
  // Phones have no side panel: the contact's info opens as a bottom sheet.
  const [contactSheetOpen, setContactSheetOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // Which attachment the media viewer is showing. Lives here rather than in
  // the bubble so the viewer can page through every image/video in the
  // thread (issue #373). Paired with the conversation it belongs to and read
  // back through that check below, so switching threads closes the viewer
  // without an effect racing the messages refetch.
  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "" };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg) return { expired: true, remaining: tTimer("noCustomerMessages") };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: tTimer("expired") };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer("xhRemaining", { hours: Math.floor(hoursLeft) })
        : tTimer("xmRemaining", { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining };
  }, [messages, tTimer]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  const mediaMessageId =
    openMedia && openMedia.conversationId === conversationId
      ? openMedia.messageId
      : null;
  const handleMediaChange = useCallback(
    (messageId: string | null) => {
      setOpenMedia(
        messageId && conversationId ? { conversationId, messageId } : null,
      );
    },
    [conversationId],
  );

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    const supabase = createClient();
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error("Failed to fetch messages:", error);
      } else {
        onMessagesLoadedRef.current(data ?? []);
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .eq("conversation_id", conversationId);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch reactions:", error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith("temp-") &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id,
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "message_reactions",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from("conversations")
      .update({ unread_count: 0 })
      .eq("id", conversationId)
      .then(({ error }) => {
        if (error) console.error("Failed to reset unread_count:", error);
      });
  }, [conversationId, hasUnread]);

  // ---- Scroll: follow the end of the thread, but never fight the reader ----
  //
  // Before, every change to `messages` (including a delivery tick flipping
  // from "sent" to "read") jumped to the bottom, so scrolling up to read
  // history got yanked back. Now the view only follows when the reader is
  // already at (or near) the bottom, when they just sent something, and
  // when a thread is first opened.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);

  // A different thread starts pinned to its last message.
  useEffect(() => {
    stickToBottomRef.current = true;
    lastMessageIdRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    const lastId = last?.id ?? null;
    // The agent just sent something (optimistic bubble): show it even if
    // they had scrolled up.
    if (last && lastId !== lastMessageIdRef.current && last.id.startsWith("temp-")) {
      stickToBottomRef.current = true;
    }
    lastMessageIdRef.current = lastId;
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // Content can grow after the message list rendered (an image or video
  // finishing its load) and the box can shrink (the on-screen keyboard):
  // keep the last message in view in both cases while pinned.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const content = contentRef.current;
    const box = scrollRef.current;
    if (!content || !box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom();
    });
    observer.observe(content);
    observer.observe(box);
    return () => observer.disconnect();
  }, [conversationId, hasMessages, scrollToBottom]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send message:", reason);
          toast.error(t("sendFailed", { reason }));
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : t("networkError");
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || t("documentFallback")
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send media:", reason);
          toast.error(t("sendFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : t("networkError");
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "interactive",
        content_text: payload.body,
        interactive_payload: payload,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "interactive",
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send interactive message:", reason);
          toast.error(t("sendFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send interactive message:", err);
        const reason = err instanceof Error ? err.message : t("networkError");
        toast.error(t("sendFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      await supabase
        .from("conversations")
        .update({ status })
        .eq("id", conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send template:", reason);
          toast.error(t("sendTemplateFailed", { reason }));
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : t("networkError");
        toast.error(t("sendTemplateFailed", { reason }));
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Images + videos in the thread, in order — the set the media viewer
  // pages through with ← / →.
  const mediaGallery = useMemo(() => collectMediaGallery(messages), [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName =
    contact?.name || (contact ? contactHandle(contact) : "") || t("customer");

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? t("you") : contactDisplayName;
    },
    [contactDisplayName, t],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor, tQuote],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }
      if (messageId.startsWith("temp-")) {
        toast.error(t("waitForSending"));
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );
        if (emoji === "") return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch("/api/whatsapp/react", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : t("networkError");
        toast.error(t("reactionFailed", { reason }));
        setReactions(snapshot);
      }
    },
    [conversation, user?.id, t],
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ assigned_agent_id: agentId })
        .eq("id", conversation.id);

      if (error) {
        console.error("Failed to update assignment:", error);
        toast.error(t("assignmentUpdateFailed"));
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange, t],
  );

  // Empty state — calm on purpose: plain background, one short message.
  // (Only visible on lg+; on mobile the list takes the whole screen.)
  if (!conversation || !contact) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-background px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <MessageSquare aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="mt-4 text-[15px] font-semibold text-foreground">
          {t("selectConversation")}
        </h2>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">
          {t("selectConversationHint")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t("assigned"))
    : t("assign");

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn("flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border bg-card px-2 py-2 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only (44px on touch). Hidden on
              lg+ where the conversation list is always visible. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("backToConversations")}
              className={cn(HEADER_ICON_BUTTON, "lg:hidden")}
            >
              <ArrowLeft aria-hidden="true" className="h-5 w-5" />
            </button>
          )}
          {/* Avatar — hidden on phones so the name keeps its room, and also
              between lg and xl, where the list column leaves the thread
              header too narrow for avatar + name + session timer. */}
          <div
            aria-hidden="true"
            className="hidden h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground sm:flex lg:hidden xl:flex"
          >
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="relative min-w-0">
            {/* On phones the name opens the contact's info (there is no side
                panel below lg); `after:` stretches the tap area to ~52px.
                From lg up the panel exists, so it is plain text. */}
            <h2 className="text-sm font-semibold text-foreground lg:hidden">
              <button
                type="button"
                onClick={() => setContactSheetOpen(true)}
                aria-haspopup="dialog"
                aria-label={t("openContactInfo", { name: displayName })}
                className="inline-flex max-w-full items-center gap-0.5 rounded-md text-left outline-none after:absolute after:-inset-y-2 after:inset-x-0 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="min-w-0 truncate">{displayName}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              </button>
            </h2>
            <h2 className="hidden truncate text-sm font-semibold text-foreground lg:block">
              {displayName}
            </h2>
            <p className="truncate text-xs text-muted-foreground lg:hidden xl:block">
              {contactHandle(contact)}
            </p>
            {/* Between lg and xl the timer moves under the name (replacing
                the handle) so the name keeps its room. */}
            <Badge
              variant={sessionInfo.expired ? "destructive" : "success"}
              className="hidden w-fit gap-1 text-[11px] lg:inline-flex xl:hidden"
            >
              <Clock aria-hidden="true" className="h-3 w-3" />
              {sessionInfo.remaining}
            </Badge>
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant={sessionInfo.expired ? "destructive" : "success"}
            className="ml-1 hidden shrink-0 gap-1 text-[11px] sm:ml-2 sm:inline-flex lg:hidden xl:inline-flex"
          >
            <Clock aria-hidden="true" className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {/* Ventas on mobile: the contact panel doesn't exist below lg,
              so orders are created from here (renders nothing without
              the module or for viewers). */}
          <MobileOrdersButton
            contactId={contact.id}
            contactName={displayName}
            conversationId={conversation.id}
          />

          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t("hideContactPanel") : t("showContactPanel")
              }
              title={contactPanelOpen ? t("hideContact") : t("showContact")}
              aria-pressed={contactPanelOpen}
              className={cn(
                HEADER_ICON_BUTTON,
                "hidden lg:inline-flex",
                contactPanelOpen && "text-primary hover:text-primary",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose aria-hidden="true" className="h-4 w-4" />
              ) : (
                <PanelRightOpen aria-hidden="true" className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t("refreshConversation")}
              title={t("refresh")}
              className={HEADER_ICON_BUTTON}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("h-4 w-4", isRefreshing && "animate-spin")}
              />
            </button>
          )}

          {/* Status dropdown — semantic chip. On phones only the coloured
              dot shows (the name stays in the accessible label). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("changeStatus", {
                status: currentStatus
                  ? t(`status${currentStatus.label}`)
                  : t("status"),
              })}
              className={cn(
                "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none transition-colors hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:min-w-11",
                currentStatus?.chip ?? "border-border text-muted-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-2 w-2 rounded-full",
                  currentStatus?.dot ?? "bg-muted-foreground/50",
                )}
              />
              <span className="hidden sm:inline">
                {currentStatus ? t(`status${currentStatus.label}`) : t("status")}
              </span>
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44 border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className="text-sm pointer-coarse:min-h-11"
                >
                  <span
                    aria-hidden="true"
                    className={cn("h-2 w-2 rounded-full", opt.dot)}
                  />
                  <span className="flex-1">{t(`status${opt.label}`)}</span>
                  {opt.value === conversation.status && (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={assignLabel}
              className={cn(
                "inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:min-w-11",
                assignedAgentId ? "text-primary" : "text-muted-foreground"
              )}
            >
              <UserPlus aria-hidden="true" className="h-4 w-4" />
              <span className="hidden max-w-32 truncate sm:inline lg:hidden xl:inline">{assignLabel}</span>
              <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-56 border-border bg-popover"
            >
              {profiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                  {t("noTeammates")}
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        "text-sm pointer-coarse:min-h-11",
                        isSelected ? "text-primary" : "text-popover-foreground"
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? t("me") : ""}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-sm text-muted-foreground pointer-coarse:min-h-11"
                  >
                    {t("unassign")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Messages Area */}
      <div
        ref={scrollRef}
        onScroll={handleMessagesScroll}
        role="log"
        aria-label={t("messagesLabel")}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-4"
      >
        {/* Full-area spinner only while there is nothing to show yet. A
            refetch of a thread that is already on screen (tab regains focus,
            realtime reconnect, manual refresh) swaps in the new rows silently
            instead of blanking the list and losing the scroll position. */}
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center py-12" role="status">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="sr-only">{t("loadingMessages")}</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <p className="text-sm font-medium text-foreground">{t("noMessagesYet")}</p>
            <p className="text-[13px] text-muted-foreground">
              {t("sendTemplateHint")}
            </p>
          </div>
        ) : (
          <div ref={contentRef} className="space-y-4">
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground">
                    {formatDateSeparator(group.date, t, formatter)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          // "Tú" for our own messages (the "me" string is the
                          // " (yo)" suffix for the assignee list, not a label).
                          authorLabel: authorLabelFor(parent),
                          preview: buildReplyPreview(parent, tQuote),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === "agent" &&
                          r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <MessageActions
                        key={msg.id}
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                          onOpenMedia={handleMediaChange}
                        />
                      </MessageActions>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured, or a vertical's bot is paused here. */}
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ("assigned_agent_id" in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionInfo.expired}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      {/* Contact info as a bottom sheet — phones only (lg+ has the panel). */}
      <Sheet open={contactSheetOpen} onOpenChange={setContactSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-xl pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden"
        >
          <SheetHeader className="pr-14">
            <SheetTitle>{tSidebar("contactInfo")}</SheetTitle>
          </SheetHeader>
          <ContactSidebar
            variant="sheet"
            contact={contact}
            conversationId={conversation.id}
          />
        </SheetContent>
      </Sheet>

      {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={handleMediaChange}
        contactLabel={contactDisplayName}
      />
    </div>
  );
}
