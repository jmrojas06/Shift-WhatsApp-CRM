"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_MODE,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  STORAGE_KEY,
  isMode,
  isModePreference,
  isThemeId,
  resolveMode,
  type Mode,
  type ModePreference,
  type ThemeId,
} from "@/lib/themes";

/**
 * ThemeProvider — wraps the whole app, owns the two theming axes:
 *   • `theme` — the accent color (`data-theme` on <html>)
 *   • `mode`  — light / dark (`data-mode` on <html>)
 * The two are independent, so any accent renders in either mode.
 *
 * The mode is driven by a *preference* (`system` / `light` / `dark`).
 * `system` follows `prefers-color-scheme` and keeps following it while
 * the tab is open; an explicit choice pins the mode.
 *
 * The boot script in `src/app/layout.tsx` has already applied both
 * `data-theme` and `data-mode` before React hydrates, so by the time
 * this Provider mounts the page is already painted correctly. We just
 * read what's there and keep it in sync going forward.
 *
 * Persistence is localStorage only (device-scoped). A future
 * follow-up could mirror to `profiles.preferences` for cross-device
 * sync, but a per-device choice is also defensible — your phone may
 * deserve a different theme than your laptop.
 */

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
  /** The resolved mode currently painted. */
  mode: Mode;
  /** What the user picked; `system` follows the OS. */
  modePreference: ModePreference;
  setModePreference: (next: ModePreference) => void;
  /** Pins an explicit mode (same as `setModePreference(next)`). */
  setMode: (next: Mode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return DEFAULT_MODE === "dark";
  }
}

function readInitialTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  // Whatever the boot script applied is the truth. Fall back to
  // localStorage / default if for some reason the attribute is missing
  // (e.g. someone bypassed the boot script in a custom layout).
  const fromAttr = document.documentElement.dataset.theme;
  if (isThemeId(fromAttr)) return fromAttr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_THEME;
}

function readInitialPreference(): ModePreference {
  if (typeof window === "undefined") return DEFAULT_MODE_PREFERENCE;
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (isModePreference(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_MODE_PREFERENCE;
}

function readInitialMode(): Mode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const fromAttr = document.documentElement.dataset.mode;
  if (isMode(fromAttr)) return fromAttr;
  return resolveMode(readInitialPreference(), systemPrefersDark());
}

function applyMode(next: Mode) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.mode = next;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readInitialTheme);
  const [modePreference, setPreferenceState] =
    useState<ModePreference>(readInitialPreference);
  const [mode, setModeState] = useState<Mode>(readInitialMode);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same private-browsing edge case as above; the in-memory state
      // still updates so the current tab works for the session.
    }
  }, []);

  const setModePreference = useCallback((next: ModePreference) => {
    const resolved = resolveMode(next, systemPrefersDark());
    setPreferenceState(next);
    setModeState(resolved);
    applyMode(resolved);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Same private-browsing edge case as above.
    }
  }, []);

  const setMode = useCallback(
    (next: Mode) => setModePreference(next),
    [setModePreference],
  );

  const toggleMode = useCallback(() => {
    setModePreference(mode === "dark" ? "light" : "dark");
  }, [mode, setModePreference]);

  // While following the system, repaint when the OS flips (e.g. the
  // phone's automatic dark mode at sunset).
  useEffect(() => {
    if (modePreference !== "system") return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => {
      const resolved: Mode = e.matches ? "dark" : "light";
      setModeState(resolved);
      applyMode(resolved);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [modePreference]);

  // Sync from other tabs — change theme or mode in tab A, tab B
  // catches up without a refresh.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        if (isThemeId(e.newValue) && e.newValue !== theme) {
          setThemeState(e.newValue);
          document.documentElement.dataset.theme = e.newValue;
        }
        return;
      }
      if (e.key === MODE_STORAGE_KEY) {
        if (isModePreference(e.newValue) && e.newValue !== modePreference) {
          const resolved = resolveMode(e.newValue, systemPrefersDark());
          setPreferenceState(e.newValue);
          setModeState(resolved);
          applyMode(resolved);
        }
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [theme, modePreference]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        mode,
        modePreference,
        setModePreference,
        setMode,
        toggleMode,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider — return
    // no-op setters so callers don't crash. The boot script still
    // applied the right CSS attributes, so visually the page is fine.
    return {
      theme: DEFAULT_THEME,
      setTheme: () => {},
      mode: DEFAULT_MODE,
      modePreference: DEFAULT_MODE_PREFERENCE,
      setModePreference: () => {},
      setMode: () => {},
      toggleMode: () => {},
    };
  }
  return ctx;
}
