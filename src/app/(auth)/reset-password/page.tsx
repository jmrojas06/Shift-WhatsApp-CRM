"use client";

// ============================================================
// /reset-password — the form the password-reset email leads to.
//
// The emailed link lands on /auth/callback, which exchanges it for a
// session and 303s here. So on arrival the visitor either has a
// recovery session (show the form) or doesn't (the link was spent,
// expired, or opened in a browser without the PKCE verifier cookie —
// say so, with a way to request a new one). Bouncing to /login with
// no explanation was the locked-out experience issue #592 describes.
//
// Not gated by the middleware on purpose: the "expired" state must be
// reachable signed-out, and a signed-in visitor must not be redirected
// away from the very page they need.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CheckCircle, KeyRound, Loader2, MailX } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AuthAlert,
  AuthCard,
  AuthCardHeader,
  AuthShell,
} from "@/components/auth/auth-shell";
import { authErrorKey } from "@/components/auth/auth-error";

type Status = "checking" | "ready" | "expired" | "done";

export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const tErrors = useTranslations("AuthErrors");
  const supabase = createClient();

  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The callback wrote the session cookies server-side; the browser
    // client reads them here. No user → the link didn't yield a session.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!cancelled) setStatus(user ? "ready" : "expired");
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }
    // Same floor as /signup.
    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);

    if (error) {
      setError(tErrors(authErrorKey(error)));
      return;
    }
    setStatus("done");
  };

  if (status === "checking") {
    return (
      <AuthShell>
        <AuthCard>
          <CardContent
            role="status"
            className="flex flex-col items-center gap-3 px-6 py-8 text-sm text-muted-foreground"
          >
            <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
            {t("checking")}
          </CardContent>
        </AuthCard>
      </AuthShell>
    );
  }

  if (status === "expired") {
    return (
      <AuthShell>
        <AuthCard>
          <AuthCardHeader
            icon={MailX}
            tone="warning"
            title={t("expiredTitle")}
            description={t("expiredDesc")}
          />
          <CardContent className="flex flex-col gap-2 px-6">
            <Link
              href="/forgot-password"
              className={cn(buttonVariants({ size: "lg" }), "w-full")}
            >
              {t("requestNewLink")}
            </Link>
            <Link
              href="/login"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }), "w-full")}
            >
              {t("backToSignIn")}
            </Link>
          </CardContent>
        </AuthCard>
      </AuthShell>
    );
  }

  if (status === "done") {
    return (
      <AuthShell>
        <AuthCard>
          <AuthCardHeader
            icon={CheckCircle}
            tone="success"
            title={t("successTitle")}
            description={t("successDesc")}
          />
          <CardContent className="px-6">
            <Button
              size="lg"
              className="w-full"
              onClick={() => {
                // Full-page navigation, like /login: the middleware
                // gating /dashboard must see the session cookies on a
                // fresh top-level request, which a soft router.push
                // can race (issue #365).
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload so the auth cookies reach the middleware
                window.location.href = "/dashboard";
              }}
            >
              {t("continueToDashboard")}
            </Button>
          </CardContent>
        </AuthCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthCard>
        <AuthCardHeader icon={KeyRound} title={t("title")} description={t("desc")} />
        <CardContent className="px-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && <AuthAlert>{error}</AuthAlert>}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t("passwordLabel")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword">{t("confirmPasswordLabel")}</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder={t("confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" size="lg" disabled={saving} className="mt-2 w-full">
              {saving ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {t("saving")}
                </>
              ) : (
                t("submit")
              )}
            </Button>
          </form>
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
