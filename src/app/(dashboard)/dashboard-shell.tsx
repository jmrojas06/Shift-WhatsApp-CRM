"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { MobileTabBar } from "@/components/layout/mobile-tab-bar";
import {
  ShellChromeProvider,
  useShellChrome,
} from "@/components/layout/shell-chrome";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { BrowserNotificationsListener } from "@/components/notifications/browser-notifications-listener";
import { cn } from "@/lib/utils";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const t = useTranslations("DashboardShell");

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div
        role="status"
        className="flex h-dvh items-center justify-center bg-background"
      >
        <div className="flex flex-col items-center gap-3">
          <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <ShellChromeProvider>
      <ShellFrame>{children}</ShellFrame>
    </ShellChromeProvider>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }) {
  // Drawer state — only used on mobile (opened from the tab bar's
  // "Más"). On lg+ the sidebar is always visible and this is ignored.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const { tabBarHidden } = useShellChrome();

  return (
    <div
      className={cn(
        // --tabbar-h is the mobile bottom bar's height (0 when it is not
        // shown). Full-height pages such as the inbox subtract it.
        "flex h-dvh overflow-hidden bg-background",
        tabBarHidden
          ? "[--tabbar-h:0px]"
          : "[--tabbar-h:calc(4rem+env(safe-area-inset-bottom))] lg:[--tabbar-h:0px]",
      )}
    >
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
      <BrowserNotificationsListener />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        {/* Bottom padding clears the fixed mobile tab bar. */}
        <main className="flex-1 overflow-y-auto p-4 pb-[calc(1rem+var(--tabbar-h))] sm:p-6 sm:pb-[calc(1.5rem+var(--tabbar-h))]">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {children}
        </main>
      </div>
      <MobileTabBar onOpenMore={() => setSidebarOpen(true)} />
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
