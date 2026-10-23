"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, CheckCircle, Loader2 } from "lucide-react";
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

export default function ForgotPasswordPage() {
  const t = useTranslations("ForgotPasswordPage");
  const tErrors = useTranslations("AuthErrors");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // The emailed link returns to /auth/callback, which exchanges it
    // for a recovery session and forwards to /reset-password (issue
    // #592). Supabase must allow this origin under Authentication →
    // URL Configuration → Redirect URLs, or it silently falls back to
    // its Site URL; see docs/auth-emails.md.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
    });

    if (error) {
      setError(tErrors(authErrorKey(error)));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <AuthShell>
        <AuthCard>
          <AuthCardHeader
            icon={CheckCircle}
            tone="success"
            title={t("checkEmailTitle")}
            description={t.rich("checkEmailDesc", {
              email,
              strong: (chunks) => (
                <span className="font-medium text-foreground">{chunks}</span>
              ),
            })}
          />
          <CardContent className="px-6">
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

  return (
    <AuthShell>
      <AuthCard>
        <AuthCardHeader title={t("title")} description={t("desc")} />
        <CardContent className="px-6">
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            {error && <AuthAlert>{error}</AuthAlert>}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t("emailLabel")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <Button type="submit" size="lg" disabled={loading} className="mt-2 w-full">
              {loading ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {t("sending")}
                </>
              ) : (
                t("sendLink")
              )}
            </Button>
          </form>

          <Link
            href="/login"
            className={cn(
              buttonVariants({ variant: "ghost", size: "lg" }),
              "mt-4 w-full text-muted-foreground",
            )}
          >
            <ArrowLeft aria-hidden />
            {t("backToSignIn")}
          </Link>
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
