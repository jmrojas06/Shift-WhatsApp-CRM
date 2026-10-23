import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Inter, Space_Grotesk } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/hooks/use-theme";
import { ThemedToaster } from "@/components/themed-toaster";
import {
  DEFAULT_MODE,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  MODE_PREFERENCES,
  MODE_STORAGE_KEY,
  STORAGE_KEY,
  THEME_IDS,
} from "@/lib/themes";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

// Shift's display face — page titles and KPI figures only.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-heading-face",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Metadata");
  return {
    ...metadata,
    description: t("description"),
  };
}

const metadata: Metadata = {
  title: {
    default: "Shift CRM",
    template: "%s · Shift CRM",
  },
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [{ url: "/icon" }],
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  // Mirrors --background of each mode in globals.css.
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#131316" },
    { media: "(prefers-color-scheme: light)", color: "#F3F4F6" },
  ],
  colorScheme: "dark light",
};

// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODE_PREFERENCES constants so adding
// one doesn't silently break the boot path. A missing or `system`
// mode preference resolves from `prefers-color-scheme`, the same rule
// as `resolveMode` in lib/themes.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  function systemMode() {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (_e) {
      return ${JSON.stringify(DEFAULT_MODE)};
    }
  }
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var PREFERENCES = ${JSON.stringify(MODE_PREFERENCES)};
    var savedPref = localStorage.getItem(MODE_KEY);
    var pref = PREFERENCES.indexOf(savedPref) !== -1 ? savedPref : ${JSON.stringify(DEFAULT_MODE_PREFERENCE)};
    d.dataset.mode = pref === "system" ? systemMode() : pref;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
    d.dataset.mode = systemMode();
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className={`${inter.variable} ${spaceGrotesk.variable} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            {children}
            <ThemedToaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
