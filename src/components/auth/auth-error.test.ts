import { describe, expect, it } from "vitest";

import { authErrorKey } from "./auth-error";

describe("authErrorKey", () => {
  it("returns generic for a missing error", () => {
    expect(authErrorKey(null)).toBe("generic");
    expect(authErrorKey(undefined)).toBe("generic");
  });

  it("maps stable auth-js codes", () => {
    expect(authErrorKey({ code: "invalid_credentials" })).toBe("invalidCredentials");
    expect(authErrorKey({ code: "email_not_confirmed" })).toBe("emailNotConfirmed");
    expect(authErrorKey({ code: "user_already_exists" })).toBe("userExists");
    expect(authErrorKey({ code: "email_exists" })).toBe("userExists");
    expect(authErrorKey({ code: "weak_password" })).toBe("weakPassword");
    expect(authErrorKey({ code: "same_password" })).toBe("samePassword");
    expect(authErrorKey({ code: "email_address_invalid" })).toBe("invalidEmail");
    expect(authErrorKey({ code: "over_email_send_rate_limit" })).toBe("rateLimited");
    expect(authErrorKey({ code: "signup_disabled" })).toBe("signupDisabled");
    expect(authErrorKey({ code: "session_not_found" })).toBe("sessionExpired");
  });

  it("prefers the code over the message", () => {
    expect(
      authErrorKey({ code: "weak_password", message: "Invalid login credentials" }),
    ).toBe("weakPassword");
  });

  it("falls back to the HTTP status for rate limits", () => {
    expect(authErrorKey({ status: 429, message: "Too many" })).toBe("rateLimited");
  });

  it("recognises network failures", () => {
    expect(authErrorKey({ name: "AuthRetryableFetchError" })).toBe("network");
    expect(authErrorKey({ message: "Failed to fetch" })).toBe("network");
  });

  it("falls back to well-known English messages", () => {
    expect(authErrorKey({ message: "Invalid login credentials" })).toBe(
      "invalidCredentials",
    );
    expect(authErrorKey({ message: "Email not confirmed" })).toBe("emailNotConfirmed");
    expect(authErrorKey({ message: "User already registered" })).toBe("userExists");
  });

  it("returns generic for anything unknown", () => {
    expect(authErrorKey({ code: "something_new", message: "Boom" })).toBe("generic");
  });
});
