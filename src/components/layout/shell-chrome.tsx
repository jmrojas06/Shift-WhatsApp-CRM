"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";

/**
 * Shared state for the app chrome (sidebar, header, mobile tab bar).
 *
 * The unread counters live here so the shell subscribes once: before,
 * every consumer of `useTotalUnread` opened its own realtime channel.
 * Pages can also hide the mobile tab bar while they need the full
 * height of the screen (an open chat with its composer).
 */
interface ShellChromeValue {
  unreadConversations: number;
  unreadNotifications: number;
  tabBarHidden: boolean;
  setTabBarHidden: (hidden: boolean) => void;
}

const ShellChromeContext = createContext<ShellChromeValue>({
  unreadConversations: 0,
  unreadNotifications: 0,
  tabBarHidden: false,
  setTabBarHidden: () => {},
});

export function ShellChromeProvider({ children }: { children: ReactNode }) {
  const unreadConversations = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();
  const [tabBarHidden, setTabBarHidden] = useState(false);

  const value = useMemo(
    () => ({
      unreadConversations,
      unreadNotifications,
      tabBarHidden,
      setTabBarHidden,
    }),
    [unreadConversations, unreadNotifications, tabBarHidden],
  );

  return (
    <ShellChromeContext.Provider value={value}>
      {children}
    </ShellChromeContext.Provider>
  );
}

export function useShellChrome(): ShellChromeValue {
  return useContext(ShellChromeContext);
}

/** Hides the mobile tab bar while `hidden` is true; restores it on unmount. */
export function useHideMobileTabBar(hidden: boolean) {
  const { setTabBarHidden } = useShellChrome();
  useEffect(() => {
    setTabBarHidden(hidden);
    return () => setTabBarHidden(false);
  }, [hidden, setTabBarHidden]);
}
