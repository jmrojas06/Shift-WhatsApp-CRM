/**
 * Maps a Supabase Auth error onto a message key under `AuthErrors` in
 * the catalogues. Supabase returns English, technical messages
 * ("Invalid login credentials"); the auth screens show a translated
 * sentence that says what to do instead. Pure, so it is unit-tested.
 *
 * Prefers the stable `code` (auth-js ErrorCode); falls back to the HTTP
 * status and finally to well-known English messages from older servers.
 */
export type AuthErrorKey =
  | "invalidCredentials"
  | "emailNotConfirmed"
  | "userExists"
  | "weakPassword"
  | "samePassword"
  | "invalidEmail"
  | "rateLimited"
  | "signupDisabled"
  | "sessionExpired"
  | "network"
  | "generic";

export interface AuthErrorLike {
  code?: string | null;
  status?: number | null;
  message?: string | null;
  name?: string | null;
}

const BY_CODE: Record<string, AuthErrorKey> = {
  invalid_credentials: "invalidCredentials",
  email_not_confirmed: "emailNotConfirmed",
  user_already_exists: "userExists",
  email_exists: "userExists",
  weak_password: "weakPassword",
  same_password: "samePassword",
  email_address_invalid: "invalidEmail",
  over_request_rate_limit: "rateLimited",
  over_email_send_rate_limit: "rateLimited",
  signup_disabled: "signupDisabled",
  email_provider_disabled: "signupDisabled",
  session_not_found: "sessionExpired",
  session_expired: "sessionExpired",
  refresh_token_not_found: "sessionExpired",
  request_timeout: "network",
};

export function authErrorKey(
  error: AuthErrorLike | null | undefined,
): AuthErrorKey {
  if (!error) return "generic";

  const byCode = error.code ? BY_CODE[error.code] : undefined;
  if (byCode) return byCode;

  if (error.status === 429) return "rateLimited";
  if (error.name === "AuthRetryableFetchError") return "network";

  const message = (error.message ?? "").toLowerCase();
  if (message.includes("invalid login credentials")) return "invalidCredentials";
  if (message.includes("email not confirmed")) return "emailNotConfirmed";
  if (message.includes("already registered")) return "userExists";
  if (message.includes("rate limit")) return "rateLimited";
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "network";
  }
  return "generic";
}
