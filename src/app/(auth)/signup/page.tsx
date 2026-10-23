"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckCircle, Loader2, UsersRound } from "lucide-react";
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
  authLinkClass,
} from "@/components/auth/auth-shell";
import { authErrorKey } from "@/components/auth/auth-error";
import { PasswordInput } from "@/components/auth/password-input";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // sends the verified user to /join/<token> so they land on the
  // redeem step instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("SignupPage");
  const tErrors = useTranslations("AuthErrors");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const loginHref = inviteToken
    ? `/login?invite=${encodeURIComponent(inviteToken)}`
    : "/login";

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }

    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    setLoading(true);

    // Always name our own origin as the place the confirmation link
    // returns to. Previously this was left unset unless an invite was
    // involved, so Supabase fell back to its Site URL — which on a
    // freshly-created or self-hosted project is `http://localhost:3000`
    // (issue #595) — and even when the Site URL was right the link
    // landed on `/` with an unexchanged `?code=`, so the user had to
    // sign in again after verifying. /auth/callback exchanges the link
    // for a session and forwards to `next` (issue #592). Supabase still
    // has to allow this origin under Authentication → URL Configuration
    // → Redirect URLs; see docs/auth-emails.md.
    const next = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        emailRedirectTo,
      },
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
              href={loginHref}
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
        <AuthCardHeader
          icon={inviteToken ? UsersRound : undefined}
          title={inviteToken ? t("titleJoin") : t("title")}
          description={inviteToken ? t("descJoin") : t("desc")}
        />
        <CardContent className="px-6">
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && <AuthAlert>{error}</AuthAlert>}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName">{t("fullNameLabel")}</Label>
              <Input
                id="fullName"
                type="text"
                autoComplete="name"
                placeholder={t("fullNamePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t("emailLabel")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t("passwordLabel")}</Label>
              <PasswordInput
                id="password"
                autoComplete="new-password"
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword">{t("confirmPasswordLabel")}</Label>
              <PasswordInput
                id="confirmPassword"
                autoComplete="new-password"
                placeholder={t("confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" size="lg" disabled={loading} className="mt-2 w-full">
              {loading ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {t("creating")}
                </>
              ) : (
                t("submit")
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("haveAccount")}{" "}
            <Link href={loginHref} className={authLinkClass}>
              {t("signIn")}
            </Link>
          </p>
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
