import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // `new URL(...).pathname` yields `/C:/...` on Windows and breaks
    // module resolution — fileURLToPath returns a real platform path.
    alias: {
      "@app-messages": fileURLToPath(
        new URL("./messages/en.json", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      // Pin the time zone: CI (Linux) already runs in UTC, and
      // dashboard/date-utils parses date-only strings as UTC — running
      // every machine on UTC removes the Windows/Bogotá off-by-one.
      TZ: "UTC",
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});
