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
 *
 * `flow.ts` extends that to the Privy wiring itself. The SDK calls need a
 * handset; deciding which step the merchant is on, what is accepted, and who a
 * failure is addressed to does not — so that is here, and the hook in the app
 * is a thin shell over it.
 */
export * from "./phone.ts";
export * from "./payout.ts";
export * from "./flow.ts";
