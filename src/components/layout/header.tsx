"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

import { CreateMenu } from "./create-menu";
import { useShellChrome } from "./shell-chrome";
import { WorkspaceBadge } from "./workspace-badge";

const pageTitles: Record<string, string> = {
  "/dashboard": "dashboard",
  "/inbox": "inbox",
  "/notifications": "notifications",
  "/contacts": "contacts",
  "/pipelines": "pipelines",
  "/broadcasts": "broadcasts",
  "/automations": "automations",
  "/flows": "flows",
  "/agents": "aiAgents",
  "/agenda": "agenda",
  "/ventas": "ventas",
  "/settings": "settings",
};

function getPageTitleKey(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "dashboard";
}

/**
 * Top bar. Phones see who they are working for (the business) since the
 * section already shows in the bottom tab bar; desktops see the section
 * name. Both get "Crear" and the notifications bell. Navigation, the
 * user menu and the light/dark toggle live in the sidebar / drawer.
 */
export function Header() {
  const t = useTranslations("Header");
  const pathname = usePathname();
  const { unreadNotifications } = useShellChrome();
  const { account, profile } = useAuth();
  const workspaceName = account?.name || profile?.full_name || "";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2 pl-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href="/dashboard"
          className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:hidden"
        >
          <WorkspaceBadge name={workspaceName} />
          <span className="truncate text-sm font-semibold text-foreground">
            {workspaceName}
          </span>
        </Link>
        <p className="hidden truncate text-sm font-semibold text-foreground lg:block">
          {t(getPageTitleKey(pathname))}
        </p>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <CreateMenu />
        <Link
          href="/notifications"
          aria-current={pathname.startsWith("/notifications") ? "page" : undefined}
          aria-label={
            unreadNotifications > 0
              ? t("notificationsWithCount", { count: unreadNotifications })
              : t("notifications")
          }
          className={cn(
            "relative inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:size-9",
            pathname.startsWith("/notifications") && "bg-muted text-foreground",
          )}
        >
          <Bell className="size-5 lg:size-[18px]" />
          {unreadNotifications > 0 && (
            <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground lg:top-0.5 lg:right-0.5">
              {unreadNotifications > 9 ? "9+" : unreadNotifications}
            </span>
          )}
        </Link>
      </div>
    </header>
  );
}
