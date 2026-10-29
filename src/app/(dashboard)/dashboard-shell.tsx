"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ViewModeProvider, useViewMode } from "@/hooks/use-view-mode";
import { isRouteHidden } from "@/lib/view-mode";
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
  const pathname = usePathname();
  const t = useTranslations("DashboardShell");
  const { simple, hasModules } = useViewMode();
  // Vista sencilla: las pantallas que configura Shift no existen para el
  // local, ni desde un enlace guardado (ver lib/view-mode).
  const hidden = isRouteHidden(pathname, { simple, hasModules });

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (hidden) router.replace("/dashboard");
  }, [hidden, router]);

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

  if (!user || hidden) return null;

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
  const t = useTranslations("DashboardShell");

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
      {/* Keyboard users skip the ~15 navigation links on every page. */}
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("skipToContent")}
      </a>
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
        <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none overflow-y-auto p-4 pb-[calc(1rem+var(--tabbar-h))] sm:p-6 sm:pb-[calc(1.5rem+var(--tabbar-h))]">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          <BusinessPreviewBanner />
          {children}
        </main>
      </div>
      <MobileTabBar
        onOpenMore={() => setSidebarOpen(true)}
        moreOpen={sidebarOpen}
      />
    </div>
  );
}

/** Aviso para Shift mientras ve la app como la ve el local. */
function BusinessPreviewBanner() {
  const { previewAsBusiness, setPreviewAsBusiness } = useViewMode();
  const t = useTranslations("DashboardShell");
  if (!previewAsBusiness) return null;
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground"
    >
      <span>{t("previewAsBusiness")}</span>
      <button
        type="button"
        onClick={() => setPreviewAsBusiness(false)}
        className="min-h-9 rounded-md px-2 font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {t("previewExit")}
      </button>
    </div>
  );
}

export function DashboardShell({
  children,
  isShiftStaff,
}: {
  children: React.ReactNode;
  isShiftStaff: boolean;
}) {
  return (
    <AuthProvider>
      <ViewModeProvider isShiftStaff={isShiftStaff}>
        <DashboardShellInner>{children}</DashboardShellInner>
      </ViewModeProvider>
    </AuthProvider>
  );
}
