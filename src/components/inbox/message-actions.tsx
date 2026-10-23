"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CornerUpLeft, Copy, MoreHorizontal, SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Long-press timing for touch. iOS Safari never fires `contextmenu` on a
// long-press, so we time the press ourselves. A finger that drifts more than
// LONG_PRESS_SLOP px is scrolling, not pressing.
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  children: ReactNode;
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  children,
}: MessageActionsProps) {
  const t = useTranslations("Inbox.actions");

  // Touch devices have no hover. The toolbar is pinned open (`touchOpen`) by
  // a long-press on the bubble, by the visible "more" button shown on coarse
  // pointers, or by a right-click without a text selection. It closes when
  // the user taps elsewhere, presses Escape or picks an action.
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  // Set when a long-press opened the toolbar, so the click (and Android's
  // `contextmenu`) that follow the release don't also hit the bubble.
  const longPressFired = useRef(false);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  };

  useEffect(() => cancelPress, []);

  // While pinned open, a tap outside the row or Escape closes the toolbar.
  // The emoji picker is portaled outside the row and manages its own
  // dismissal, so we leave it alone while it is open.
  useEffect(() => {
    if (!touchOpen || pickerOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setTouchOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTouchOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [touchOpen, pickerOpen]);

  const handlePointerDown = (e: React.PointerEvent) => {
    // Mouse users have hover and right-click; only time touch/pen presses.
    if (e.pointerType === "mouse") return;
    longPressFired.current = false;
    cancelPress();
    pressStart.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      longPressFired.current = true;
      setTouchOpen(true);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = pressStart.current;
    if (!start) return;
    if (
      Math.abs(e.clientX - start.x) > LONG_PRESS_SLOP ||
      Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP
    ) {
      cancelPress();
    }
  };

  const handleClickCapture = (e: React.MouseEvent) => {
    if (longPressFired.current) {
      longPressFired.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    // Android fires `contextmenu` on long-press: our toolbar is already
    // open, so suppress the native menu.
    if (longPressFired.current || pressTimer.current) {
      e.preventDefault();
      cancelPress();
      setTouchOpen(true);
      return;
    }
    // Desktop right-click on selected text keeps the browser's native menu
    // (copy a fragment, search, etc.). Otherwise open our toolbar.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      return;
    }
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error(t("nothingToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  // Visible on coarse pointers only: a discoverable alternative to the
  // long-press for people who don't know the gesture.
  const moreButton = (
    <button
      type="button"
      onClick={() => setTouchOpen((open) => !open)}
      aria-expanded={touchOpen}
      aria-label={t("more")}
      className="hidden size-11 shrink-0 items-center justify-center self-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:flex"
    >
      <MoreHorizontal className="size-4" aria-hidden="true" />
    </button>
  );

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  return (
    <div
      ref={rowRef}
      className={cn(
        "flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={(e) => {
        // Moving focus between the bubble's own controls keeps it open.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setTouchOpen(false);
        }
      }}
    >
      {isAgent && moreButton}
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div
        className="group/actions relative min-w-0 max-w-[75%] pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onClickCapture={handleClickCapture}
      >
        {children}
      <div
        data-touch-open={touchOpen || pickerOpen ? "true" : undefined}
        className={cn(
          "absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity pointer-coarse:-top-9 pointer-coarse:h-11",
          "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
          "data-[touch-open=true]:opacity-100",
          // While hidden it must not catch taps meant for the bubble above.
          "pointer-events-none group-hover/actions:pointer-events-auto group-focus-within/actions:pointer-events-auto data-[touch-open=true]:pointer-events-auto",
          isAgent ? "right-3" : "left-3",
        )}
      >
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-10 pointer-coarse:w-10"
            aria-label={t("react")}
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </PopoverTrigger>
          <PopoverContent
            className="flex w-auto flex-row gap-1 p-1.5"
            sideOffset={6}
          >
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => handlePickEmoji(e)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none outline-none transition-transform hover:scale-125 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:w-11"
                aria-label={t("reactWith", { emoji: e })}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={handleReply}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-10 pointer-coarse:w-10"
          aria-label={t("reply")}
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-10 pointer-coarse:w-10"
          aria-label={t("copyText")}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>
      {!isAgent && moreButton}
    </div>
  );
}
