/**
 * nelo settle — the double-entry ledger and the payout leg.
 *
 * The ledger, the money splits, the payout lifecycle and the reconciliation
 * against the chain are pure and tested off-device. The payout partner is
 * paj.cash on its v2 API (./paj): production only, in mainnet USDC, so a
 * cash-out moves real money. `DeclaredStubPartner` remains for tests and
 * demos without a key, and labels everything it does `"stub"`.
 */
export * from "./accounts.ts";
export * from "./ledger.ts";
export * from "./money.ts";
export * from "./partner.ts";
export * from "./settlement.ts";
export * from "./cashout.ts";
export * from "./paj/client.ts";
export * from "./paj/decimal.ts";
export * from "./paj/partner.ts";
export * from "./paj/webhook.ts";
export * from "./server.ts";

import { CHART } from "./accounts.ts";
import { Ledger } from "./ledger.ts";

/** A ledger with the standard chart of accounts. */
export const openLedger = (): Ledger => new Ledger(CHART);
