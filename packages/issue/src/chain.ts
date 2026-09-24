/**
 * The payer's own vault, as the issuer needs it. The limit is computed exactly
 * as a merchant's till computes it (`@nelo/accept`'s `limitFor`), so the
 * payer's phone never offers a voucher the merchant's till would refuse as
 * over the limit.
 */
import { limitFor, type RiskParams } from "@nelo/accept";
import { toEnrolment, type VaultAccount } from "@nelo/enrol";
import type { ChainView } from "./issuer.ts";

export function chainViewOf(vault: string, account: VaultAccount, risk: RiskParams, syncedAt: number): ChainView {
  return {
    balance: account.balance,
    seqBase: account.seqBase,
    seqBitmap: account.seqBitmap,
    unlockAt: account.unlockAt,
    status: account.status,
    limit: limitFor(toEnrolment(vault, account, syncedAt), risk),
    syncedAt,
  };
}
