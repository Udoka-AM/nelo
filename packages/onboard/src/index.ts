/**
 * nelo onboard — the checkable half of merchant onboarding.
 *
 * Week 2 step 2 is "phone number + payout account, and the merchant never sees
 * a key". The key part needs Privy, a dev build and a handset. The rest — what
 * a merchant types, and whether it can be paid — is arithmetic and string
 * handling, so it lives here where it can be tested without any of those.
 *
 * Same reasoning as `@nelo/ledger` and `@nelo/reserve`: pull the part that can
 * be checked out of the part that cannot.
 */
export * from "./phone.ts";
export * from "./payout.ts";
