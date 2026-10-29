"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Loader2, UsersRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardContent } from "@/components/ui/card";
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
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");
  const tErrors = useTranslations("AuthErrors");
  // Set by /auth/callback when an emailed link (confirmation, password
  // reset) could not be turned into a session — see src/lib/auth/callback.ts.
  const linkError = searchParams.get("error");
  const linkErrorMessage =
    linkError === "link_expired"
      ? t("linkExpired")
      : linkError === "link_invalid"
        ? t("linkInvalid")
        : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(tErrors(authErrorKey(error)));
      setLoading(false);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    window.location.href = destination;
  };

  return (
    <AuthShell>
      <AuthCard>
        <AuthCardHeader
          icon={inviteToken ? UsersRound : undefined}
          title={inviteToken ? t("titleAccept") : t("titleWelcome")}
          description={inviteToken ? t("descAccept") : t("descWelcome")}
        />
        <CardContent className="px-6">
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {linkErrorMessage && !error && (
              <AuthAlert tone="warning">{linkErrorMessage}</AuthAlert>
            )}
            {error && <AuthAlert>{error}</AuthAlert>}

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
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="password">{t("passwordLabel")}</Label>
                <Link href="/forgot-password" className={`${authLinkClass} text-sm`}>
                  {t("forgotPassword")}
                </Link>
              </div>
              <PasswordInput
                id="password"
                autoComplete="current-password"
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" size="lg" disabled={loading} className="mt-2 w-full">
              {loading ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden />
                  {t("signingIn")}
                </>
              ) : (
                t("signIn")
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("noAccount")}{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className={authLinkClass}
            >
              {t("createAccount")}
            </Link>
          </p>
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
