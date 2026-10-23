import type { ReactNode } from "react";
import { AlertTriangle, MessageSquare, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardDescription, CardHeader } from "@/components/ui/card";

/**
 * Shared chrome for the signed-out screens (login, signup, forgot /
 * reset password, invite redemption): the "Shift CRM" brand above a
 * centred card, on the page background with a very soft accent glow at
 * the top so the screen never reads as a flat void. Everything is
 * token-driven, so it follows the light/dark mode and the accent theme.
 */

/** Product name. A proper noun, identical in every locale. */
export const PRODUCT_NAME = "Shift CRM";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_70%_45%_at_50%_0%,var(--primary-soft),transparent_70%)]"
      />
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        <AuthBrand />
        {children}
      </div>
    </div>
  );
}

/** Monogram (the product's chat glyph on the accent) + wordmark. */
export function AuthBrand() {
  return (
    <div className="flex items-center justify-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <MessageSquare className="size-5" strokeWidth={2} aria-hidden />
      </span>
      <span className="font-heading text-lg font-semibold tracking-tight text-foreground">
        {PRODUCT_NAME}
      </span>
    </div>
  );
}

/** The card every auth state renders into. */
export function AuthCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <Card className={cn("w-full py-6", className)}>{children}</Card>;
}

type IconTone = "primary" | "success" | "warning" | "destructive";

const ICON_TONE: Record<IconTone, string> = {
  primary: "bg-primary-soft text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/**
 * Centred card header: optional state icon, the page's H1 and a short
 * description. `CardHeader` is a grid, so the icon is centred with
 * `justify-items-center` (plain `items-center` only centred it
 * vertically, which left it hugging the left edge under a centred title).
 */
export function AuthCardHeader({
  icon: Icon,
  tone = "primary",
  title,
  description,
}: {
  icon?: LucideIcon;
  tone?: IconTone;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <CardHeader className="justify-items-center gap-1.5 px-6 text-center">
      {Icon ? (
        <span
          className={cn(
            "mb-2 flex size-12 items-center justify-center rounded-xl",
            ICON_TONE[tone],
          )}
        >
          <Icon className="size-6" aria-hidden />
        </span>
      ) : null}
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {description ? (
        <CardDescription className="max-w-[40ch] text-sm leading-relaxed">
          {description}
        </CardDescription>
      ) : null}
    </CardHeader>
  );
}

/**
 * Form-level message. Errors are announced (`role="alert"`); the copy
 * itself always says what to do next.
 */
export function AuthAlert({
  tone = "error",
  children,
}: {
  tone?: "error" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm leading-relaxed",
        tone === "error"
          ? "border-destructive/25 bg-destructive/10 text-destructive"
          : "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * Text link used inside auth cards ("¿Olvidaste tu contraseña?",
 * "Crear cuenta"): accent text (AA on the card in both modes), a
 * visible focus ring and a 44px hit area on touch screens.
 */
export const authLinkClass =
  "inline-flex items-center rounded-md font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11";
