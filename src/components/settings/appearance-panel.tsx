"use client";

import { useRef } from "react";
import { Check, Monitor, Moon, Palette, SunMoon, Sun } from "lucide-react";

import { useTheme } from "@/hooks/use-theme";
import {
  MODE_PREFERENCES,
  THEMES,
  type ModePreference,
  type ThemeId,
} from "@/lib/themes";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Appearance panel — mode preference (system / light / dark) +
 * accent-color picker.
 *
 * Two independent controls. Either applies + persists immediately. No
 * save button: each change is a single attribute swap on <html>,
 * there's nothing to roll back.
 *
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays both choices before first paint on subsequent
 * loads.
 */
const MODE_ICONS: Record<ModePreference, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export function AppearancePanel() {
  const { theme, setTheme, modePreference, setModePreference } = useTheme();
  const t = useTranslations("Settings.appearance");
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A radio group is one Tab stop, moved with the arrow keys (the active
  // option is the stop). Without this, keyboard users tabbed through all
  // three options and arrows did nothing.
  const onModeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const count = MODE_PREFERENCES.length;
    const current = MODE_PREFERENCES.indexOf(modePreference);
    let next = current;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % count;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else return;
    e.preventDefault();
    setModePreference(MODE_PREFERENCES[next]);
    modeRefs.current[next]?.focus();
  };

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />

      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SunMoon className="size-4 text-muted-foreground" />
          {t("mode")}
        </h3>

        <div
          role="radiogroup"
          aria-label={t("colorMode")}
          onKeyDown={onModeKeyDown}
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          {MODE_PREFERENCES.map((m, i) => (
            <ModeCard
              key={m}
              buttonRef={(el) => {
                modeRefs.current[i] = el;
              }}
              mode={m}
              isActive={m === modePreference}
              onPick={() => setModePreference(m)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Palette className="size-4 text-muted-foreground" />
          {t("accentColor")}
        </h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((tObj) => (
            <ThemeCard
              key={tObj.id}
              id={tObj.id}
              swatch={tObj.swatch}
              isActive={tObj.id === theme}
              onPick={() => setTheme(tObj.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ModeCard({
  mode,
  isActive,
  onPick,
  buttonRef,
}: {
  mode: ModePreference;
  isActive: boolean;
  onPick: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const t = useTranslations("Settings.appearance");
  const Icon = MODE_ICONS[mode];
  const name = t(`modes.${mode}`);
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      tabIndex={isActive ? 0 : -1}
      onClick={onPick}
      aria-checked={isActive}
      aria-label={t("useMode", { mode: name })}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-xl border bg-card p-4 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:bg-muted/60",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">
          {name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {t(`modeHints.${mode}`)}
        </span>
      </span>
      {isActive && (
        <Check aria-hidden className="h-4 w-4 shrink-0 text-primary" />
      )}
    </button>
  );
}

function ThemeCard({
  id,
  swatch,
  isActive,
  onPick,
}: {
  id: ThemeId;
  swatch: string;
  isActive: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("Settings.appearance");
  const name = t(`themes.${id}.name`);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={isActive}
      aria-label={t("useTheme", { name })}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-full"
          style={{
            background: swatch,
            boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.15)",
          }}
        />
        {isActive && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            <Check className="h-3 w-3" />
            {t("active")}
          </span>
        )}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{name}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t(`themes.${id}.tagline`)}
        </div>
      </div>
      <span className="sr-only">{t("themeId", { id })}</span>
    </button>
  );
}
