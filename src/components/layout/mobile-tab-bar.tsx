"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

import { getMobileTabs, isNavActive } from "./nav-config";
import { useShellChrome } from "./shell-chrome";

/**
 * Bottom navigation for phones: the four places a small business owner
 * goes all day, plus "Más" for the full menu (the drawer). Hidden from
 * lg+ where the sidebar is always visible, and while a page asks for the
 * full height (an open chat).
 */
export function MobileTabBar({ onOpenMore }: { onOpenMore: () => void }) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { account } = useAuth();
  const { unreadConversations, tabBarHidden } = useShellChrome();

  if (tabBarHidden) return null;

  return (
    <nav
      aria-label={t("primaryNav")}
      className="fixed inset-x-0 bottom-0 z-30 grid h-(--tabbar-h) grid-cols-5 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:hidden"
    >
      {getMobileTabs(account).map((item) => {
        const active = isNavActive(item.href, pathname);
        const showBadge = item.href === "/inbox" && unreadConversations > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="relative">
              <item.icon className="size-[22px]" strokeWidth={1.75} />
              {showBadge && (
                <span
                  aria-label={t("unreadConversations", { count: unreadConversations })}
                  className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
                >
                  {unreadConversations > 9 ? "9+" : unreadConversations}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-1">
              {t(item.mobileLabelKey ?? item.labelKey)}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        className="flex min-h-11 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Menu className="size-[22px]" strokeWidth={1.75} />
        {t("more")}
      </button>
    </nav>
  );
}
