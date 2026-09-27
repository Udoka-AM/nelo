import { defineConfig } from "vite";

// Defaults for the values the Pages workflow passes in. Environment variables
// win. (No .env file: the repository ignores them all, on purpose.)
process.env.VITE_SITE_URL ||= "https://udoka-am.github.io/nelo/";
// Empty: the form says the waitlist opens soon, and sends nothing.
process.env.VITE_WAITLIST_ENDPOINT ??= "";

export default defineConfig({
  // Relative, so the same build works at udoka-am.github.io/nelo/ and at a custom domain.
  base: "./",
  build: {
    target: "es2022",
    // The motion and streaming code is split out and loaded only when the
    // visitor's device and network can use it.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 2048,
  },
});
