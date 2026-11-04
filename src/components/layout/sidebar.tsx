"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Eye, LogOut, Settings, User, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import type { AccountRole } from "@/lib/auth/roles";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";

import { getNavGroups, isNavActive, SETTINGS_ITEM, type NavItem } from "./nav-config";
import { useViewMode } from "@/hooks/use-view-mode";
import { useShellChrome } from "./shell-chrome";
import { WorkspaceBadge } from "./workspace-badge";

const ROLE_LABEL_KEY: Record<AccountRole, string> = {
  owner: "roleOwner",
  admin: "roleAdmin",
  agent: "roleAgent",
  viewer: "roleViewer",
};

const DESKTOP_QUERY = "(min-width: 1024px)";

/** True at Tailwind's `lg` breakpoint and up (false during SSR). */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(DESKTOP_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

interface SidebarProps {
  /** Controlled on mobile by the tab bar's "Más" button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const { simple, hasModules, isShiftStaff, previewAsBusiness, setPreviewAsBusiness } =
    useViewMode();
  const { unreadConversations } = useShellChrome();
  const workspaceName = account?.name || profile?.full_name || "";
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const asideRef = useRef<HTMLElement>(null);

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  // Focus moves into the drawer on open and back to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose?.();
        return;
      }
      // Keep Tab inside the drawer while it is a modal (below lg) so focus
      // never lands on the page hidden behind the backdrop.
      if (e.key !== "Tab" || window.matchMedia(DESKTOP_QUERY).matches) return;
      const aside = asideRef.current;
      if (!aside) return;
      const focusable = Array.from(
        aside.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!aside.contains(active)) return; // a menu popup owns focus right now
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, onClose]);

  // Below lg the closed drawer is off-screen: make it inert so its links
  // leave the tab order and the accessibility tree.
  const isDesktop = useIsDesktop();
  const inert = !open && !isDesktop;

  const renderItem = (item: NavItem) => {
    const active = isNavActive(item.href, pathname);
    const showUnread = item.href === "/inbox" && unreadConversations > 0;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            // ≥44px rows in the touch drawer, a denser 36px on desktop.
            "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset lg:min-h-9",
            active
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <item.icon
            className={cn("size-[18px] shrink-0", active && "text-primary")}
            strokeWidth={1.75}
          />
          <span className="flex-1 truncate">{t(item.labelKey)}</span>
          {item.beta && (
            <span className="rounded-full border border-border px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground">
              {t("beta")}
            </span>
          )}
          {showUnread && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
              <span aria-hidden>{unreadConversations > 99 ? "99+" : unreadConversations}</span>
              <span className="sr-only">
                {t("unreadConversations", { count: unreadConversations })}
              </span>
            </span>
          )}
        </Link>
      </li>
    );
  };

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t("closeMenu")}
        tabIndex={open ? 0 : -1}
        // Closed: out of the accessibility tree too, not just the tab order.
        inert={!open}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        id="app-sidebar"
        ref={asideRef}
        inert={inert}
        // Below lg an open drawer behaves as a modal dialog.
        role={open && !isDesktop ? "dialog" : undefined}
        aria-modal={open && !isDesktop ? true : undefined}
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-50 flex h-full w-72 max-w-[85vw] flex-col border-r border-border bg-background",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          "lg:static lg:z-0 lg:w-62 lg:translate-x-0 lg:transition-none",
        )}
        aria-label={t("primaryNav")}
      >
        {/* Workspace — the business the user is working in, with the
            product name underneath. Close button only in the drawer. */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4 lg:h-16">
          <Link
            href="/dashboard"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <WorkspaceBadge name={workspaceName} />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold text-foreground" title={workspaceName}>
                {workspaceName}
              </span>
              <span className="text-xs text-muted-foreground">{t("title")}</span>
            </span>
          </Link>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("closeMenu")}
            className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
          {getNavGroups(account, { simple, hasModules }).map((group) => (
            <div key={group.labelKey} className="mt-3 first:mt-1">
              <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {t(group.labelKey)}
              </p>
              <ul className="flex flex-col gap-0.5">{group.items.map(renderItem)}</ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-border p-3">
          <ul className="mb-2 flex flex-col gap-0.5">{renderItem(SETTINGS_ITEM)}</ul>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none data-popup-open:bg-muted/60">
                <Avatar className="size-8 shrink-0">
                  {profile?.avatar_url ? (
                    <AvatarImage
                      src={profile.avatar_url}
                      alt={profile.full_name ?? t("defaultAvatar")}
                    />
                  ) : null}
                  <AvatarFallback className="bg-muted text-sm font-medium text-foreground">
                    {profile?.full_name?.charAt(0)?.toUpperCase() ??
                      profile?.email?.charAt(0)?.toUpperCase() ??
                      ""}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile?.full_name ?? profile?.email ?? ""}
                  </p>
                  {accountRole ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {t(ROLE_LABEL_KEY[accountRole])}
                    </p>
                  ) : null}
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="top"
                sideOffset={6}
                className="min-w-56 bg-popover text-popover-foreground ring-border"
              >
                <div className="px-2 py-1.5">
                  <p className="truncate text-xs text-muted-foreground">
                    {profile?.email ?? ""}
                  </p>
                </div>
                <DropdownMenuSeparator className="bg-border" />
                <DropdownMenuItem
                  render={
                    <Link
                      href="/settings?tab=profile"
                      onClick={onClose}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    />
                  }
                >
                  <User className="size-4" />
                  {t("menuProfile")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  render={
                    <Link
                      href="/settings"
                      onClick={onClose}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    />
                  }
                >
                  <Settings className="size-4" />
                  {t("menuSettings")}
                </DropdownMenuItem>
                {isShiftStaff ? (
                  <DropdownMenuItem
                    onClick={() => setPreviewAsBusiness(!previewAsBusiness)}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  >
                    <Eye className="size-4" />
                    {previewAsBusiness ? t("menuFullView") : t("menuPreviewAsBusiness")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator className="bg-border" />
                <DropdownMenuItem
                  onClick={signOut}
                  className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                >
                  <LogOut className="size-4" />
                  {t("menuSignOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ModeToggle className="size-11 shrink-0 lg:size-9" />
          </div>
        </div>
      </aside>
    </>
  );
}
