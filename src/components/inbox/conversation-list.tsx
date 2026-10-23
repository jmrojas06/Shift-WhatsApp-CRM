"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  INBOX_FILTERS,
  countUnreadConversations,
  matchesInboxFilter,
  type InboxFilter,
} from "./inbox-filters";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

// Semantic status tokens (success / warning / neutral) for the small dot
// on each row. Paired with a visually-hidden label so the colour is never
// the only signal.
const STATUS_DOT: Record<ConversationStatus, string> = {
  open: "bg-success",
  pending: "bg-warning",
  closed: "bg-muted-foreground/50",
};

const STATUS_LABEL_KEY: Record<ConversationStatus, string> = {
  open: "statusOpen",
  pending: "statusPending",
  closed: "statusClosed",
};

const FILTER_LABEL_KEY: Record<InboxFilter, string> = {
  all: "filterAll",
  unread: "filterUnread",
  open: "filterOpen",
  pending: "filterPending",
  closed: "filterClosed",
};

// Shared chip look for the quick filters and the Tags / Company pickers:
// 36px on desktop, 44px on touch screens, visible keyboard focus.
const CHIP_BASE =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none pointer-coarse:h-11 focus-visible:ring-3 focus-visible:ring-ring/50";
const CHIP_IDLE =
  "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground";
const CHIP_ACTIVE = "border-primary/30 bg-primary-soft text-primary";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const tThread = useTranslations("Inbox.messageThread");
  const format = useFormatter();
  // Re-render once a minute so "hace 2 min" keeps moving without a refetch.
  const now = useNow({ updateInterval: 60_000 });

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter !== "all") {
      result = result.filter((c) => matchesInboxFilter(c, filter));
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const unreadTotal = useMemo(
    () => countUnreadConversations(conversations),
    [conversations],
  );

  const hasAnyFilter =
    filter !== "all" || hasContactFilters || search.trim().length > 0;

  const resetAllFilters = useCallback(() => {
    setFilter("all");
    setSearch("");
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar. `min-w-0` keeps a long
    // preview line (nowrap + truncate) from widening the pane past the
    // phone screen.
    <div className="flex h-full w-full min-w-0 flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="min-w-0 space-y-2 border-b border-border py-3">
        <div className="relative px-3">
          <label htmlFor="inbox-search" className="sr-only">
            {t("searchLabel")}
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="inbox-search"
            type="search"
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            className="bg-muted pl-9 text-foreground"
          />
        </div>

        {/* Quick filters as visible chips. Scrolls sideways on narrow
            screens instead of wrapping into several rows. */}
        <div
          role="group"
          aria-label={t("filtersLabel")}
          className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {INBOX_FILTERS.map((value) => {
            const active = filter === value;
            const showCount = value === "unread" && unreadTotal > 0;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(value)}
                className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_IDLE)}
              >
                {t(FILTER_LABEL_KEY[value])}
                {showCount && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                    {unreadTotal}
                  </span>
                )}
              </button>
            );
          })}

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  CHIP_BASE,
                  selectedTagIds.length > 0 ? CHIP_ACTIVE : CHIP_IDLE,
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  CHIP_BASE,
                  "max-w-44",
                  selectedCompany ? CHIP_ACTIVE : CHIP_IDLE,
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              const name = tag?.name ?? t("tags");
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleTag(id)}
                  aria-label={t("removeFilter", { name })}
                  className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-muted px-2.5 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-9"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-28 truncate">{name}</span>
                  <X aria-hidden="true" className="h-3 w-3 shrink-0" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                type="button"
                onClick={() => setSelectedCompany(null)}
                aria-label={t("removeFilter", { name: selectedCompany })}
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-muted px-2.5 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-9"
              >
                <span className="max-w-28 truncate">{selectedCompany}</span>
                <X aria-hidden="true" className="h-3 w-3 shrink-0" />
              </button>
            )}
            <button
              type="button"
              onClick={clearContactFilters}
              className="h-7 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-9"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        {loading ? (
          <ConversationListSkeleton />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {conversations.length === 0 && !hasAnyFilter
                ? t("emptyInbox")
                : t("noConversations")}
            </p>
            {hasAnyFilter && (
              <button
                type="button"
                onClick={resetAllFilters}
                className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-11"
              >
                {t("showAll")}
              </button>
            )}
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col">
            {filtered.map((conv) => (
              <li key={conv.id} className="min-w-0">
                <ConversationItem
                  conversation={conv}
                  isActive={conv.id === activeConversationId}
                  onSelect={handleSelect}
                  t={t}
                  statusLabel={tThread(STATUS_LABEL_KEY[conv.status])}
                  timeLabel={
                    conv.last_message_at
                      ? format.relativeTime(new Date(conv.last_message_at), {
                          now,
                          style: "narrow",
                        })
                      : ""
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/** Placeholder rows while the first fetch is in flight. */
function ConversationListSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  /** Translated status name ("Abierta"), read by screen readers. */
  statusLabel: string;
  /** Relative time of the last message, already in the app locale. */
  timeLabel: string;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  statusLabel,
  timeLabel,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();
  const unread = conversation.unread_count > 0;

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 px-3 py-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
        // Inset shadow instead of a border so the active row's content
        // doesn't shift 2px to the right.
        isActive && "bg-accent shadow-[inset_3px_0_0_var(--primary)] hover:bg-accent",
      )}
    >
      {/* Avatar */}
      <div
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground"
      >
        {contact?.avatar_url ? (
          // External WhatsApp profile URL; next/image would need every
          // host allow-listed. Decorative: the name sits right next to it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={contact.avatar_url}
            alt=""
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-sm text-foreground",
              unread ? "font-semibold" : "font-medium",
            )}
          >
            {displayName}
          </span>
          {timeLabel && (
            <time
              dateTime={conversation.last_message_at}
              className={cn(
                "shrink-0 text-[11px] tabular-nums",
                unread ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              {timeLabel}
            </time>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
          <p
            className={cn(
              "min-w-0 truncate text-[13px]",
              unread ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {unread && (
              <span
                className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
                aria-label={t("unreadMessages", {
                  count: conversation.unread_count,
                })}
              >
                {conversation.unread_count}
              </span>
            )}
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 rounded-full", STATUS_DOT[conversation.status])}
              title={statusLabel}
            />
            <span className="sr-only">{statusLabel}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
