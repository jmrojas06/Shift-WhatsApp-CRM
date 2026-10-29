import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  formatCurrency,
  formatCurrencyShort,
  numberLocale,
} from "./currency";

/**
 * The formatter follows NEXT_PUBLIC_APP_LOCALE (fixed at build time),
 * never the machine's default locale. Each test pins the locale with
 * `vi.stubEnv`, so the assertions hold on any CI box or Windows PC.
 * Intl separates symbol and number with a non-breaking space; `plain`
 * turns it into a normal space so the expectations stay readable.
 */
const plain = (value: string) => value.replace(/[  ]/g, " ");
const fmt = (value: number, currency?: string) =>
  plain(formatCurrency(value, currency));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "en");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("numberLocale", () => {
  it("maps each app locale to a concrete number-format locale", () => {
    const cases: Array<[string, string]> = [
      ["en", "en-US"],
      ["es", "es-CO"],
      ["pt", "pt-BR"],
      ["ko", "ko-KR"],
    ];
    for (const [app, expected] of cases) {
      vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", app);
      expect(numberLocale()).toBe(expected);
    }
  });

  it("falls back to English when the locale is unset or unknown", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "");
    expect(numberLocale()).toBe("en-US");
    vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "xx");
    expect(numberLocale()).toBe("en-US");
  });
});

describe("formatCurrency", () => {
  it("formats whole amounts with no minor units", () => {
    expect(fmt(1234, "USD")).toBe("$1,234");
    expect(fmt(1234.56, "USD")).toBe("$1,235");
  });

  it("uses the app locale for grouping and symbol placement", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "es");
    expect(fmt(150000, "COP")).toBe("$ 150.000");
    // Plain "es" would print "1234 US$"; es-CO groups from 4 digits.
    expect(fmt(1234, "USD")).toBe("US$ 1.234");

    vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "pt");
    expect(fmt(1234, "BRL")).toBe("R$ 1.234");

    vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "ko");
    expect(fmt(1234, "KRW")).toBe("₩1,234");
  });

  it("does not depend on the machine's default locale", () => {
    const original = Intl.NumberFormat;
    // Break any `Intl.NumberFormat(undefined, …)` call: it would pick up
    // this "machine" locale instead of the app locale.
    const spy = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
      locale?: string | string[],
      options?: object,
    ) {
      return new original(locale ?? "de-DE", options);
    } as unknown as typeof Intl.NumberFormat);
    try {
      expect(fmt(1234, "USD")).toBe("$1,234");
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults to USD when no currency is given", () => {
    expect(formatCurrency(10)).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("treats an empty-string currency as the default", () => {
    expect(formatCurrency(10, "")).toBe(formatCurrency(10, DEFAULT_CURRENCY));
  });

  it("coerces non-finite values to 0", () => {
    expect(fmt(Number.NaN, "USD")).toBe("$0");
  });

  it("renders a well-formed but unknown ISO code without throwing", () => {
    // Intl is lenient here — it uses the code as the symbol.
    const out = fmt(1234, "ZZZ");
    expect(out).toContain("ZZZ");
    expect(out).toContain("1,234");
  });

  it("never throws on a structurally invalid code (no DB CHECK on deals.currency)", () => {
    for (const bad of ["United States", "US", "USDD", "12", "u$d"]) {
      expect(() => formatCurrency(1234, bad)).not.toThrow();
      expect(fmt(1234, bad)).toContain("1,234");
    }
    vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", "es");
    expect(fmt(1234, "United States")).toBe("United States 1.234");
  });

  it("formats every offered currency without throwing", () => {
    for (const app of ["en", "es", "pt", "ko"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_LOCALE", app);
      for (const c of CURRENCIES) {
        expect(() => formatCurrency(1000, c.code)).not.toThrow();
      }
    }
  });
});

describe("formatCurrencyShort", () => {
  it("abbreviates millions and thousands with the currency symbol", () => {
    expect(formatCurrencyShort(2_500_000, "USD")).toBe("$2.5M");
    expect(formatCurrencyShort(3_400, "USD")).toBe("$3.4k");
    expect(formatCurrencyShort(900, "USD")).toBe("$900");
  });

  it("uses the matching symbol for non-USD currencies", () => {
    expect(formatCurrencyShort(1_000, "EUR")).toBe("€1.0k");
    expect(formatCurrencyShort(1_000, "INR")).toBe("₹1.0k");
  });

  it("falls back to the code prefix for unknown currencies (no throw)", () => {
    expect(formatCurrencyShort(1_000, "ZZZ")).toBe("ZZZ 1.0k");
  });
});
