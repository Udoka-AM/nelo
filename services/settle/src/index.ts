/**
 * nelo settle — the double-entry ledger and the payout leg.
 *
 * What is real: the ledger, the money splits, the payout lifecycle and the
 * reconciliation against the chain. All of it is pure and tested off-device.
 *
 * What is not: the partner. Nobody has answered yet, so the only implementation
 * is `DeclaredStubPartner`, which moves no money and labels every quote and
 * result `"stub"` so that nothing downstream — a log, a ledger memo, a
 * screenshot in the video — can imply otherwise. Swapping it for a real one is
 * a constructor change.
 *
 * See docs/DELIVERABLES.md, week 2 step 8.
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
export * from "./paj/session.ts";
export * from "./server.ts";

import { CHART } from "./accounts.ts";
import { Ledger } from "./ledger.ts";

/** A ledger with the standard chart of accounts. */
export const openLedger = (): Ledger => new Ledger(CHART);
