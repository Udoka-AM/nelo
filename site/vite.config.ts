import { defineConfig } from "vite";

// Defaults for the values the Pages workflow passes in. Environment variables
// win. (No .env file: the repository ignores them all, on purpose.)
process.env.VITE_SITE_URL ||= "https://udoka-am.github.io/nelo/";
// The waitlist's Supabase project. The URL is not a secret. The publishable key
// is public by design too (it ships in the page), but the repository keeps no
// keys at all, so it comes from the SUPABASE_PUBLISHABLE_KEY repository
// variable. Without it the form says the waitlist opens soon and sends nothing.
process.env.VITE_SUPABASE_URL ||= "https://psunppoztgazqxjyztxv.supabase.co";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= "";

export default defineConfig({
  // Relative, so the same build works at udoka-am.github.io/nelo/ and at a custom domain.
  base: "./",
  build: {
    target: "es2022",
    // Two pages: the business landing page, and nelo Pay for customers.
    rollupOptions: {
      input: { main: "index.html", pay: "pay/index.html" },
    },
    // The motion and streaming code is split out and loaded only when the
    // visitor's device and network can use it.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 2048,
  },
});
